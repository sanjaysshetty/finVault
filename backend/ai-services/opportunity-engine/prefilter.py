"""
Opportunity Engine — deterministic prefilter.

Relocated from wheel-scan/tools.py and made strategy-agnostic: the ticker
universe fetch, fundamentals fetch, hard filter, and fundamental scoring
are identical to wheel-scan's existing logic (unchanged behavior, same
thresholds) since none of that was ever CSP-specific — only the
options-chain fetching (fetch_options_for_stock/batch_fetch_options/
_approx_delta) was wheel-strategy-specific, and that's deliberately
dropped here. Real Robinhood greeks/IV replace it on-demand per
shortlisted candidate in Tower 2, via the native MCP connector
(get_option_chains/get_option_quotes) — not fetched in bulk here.
"""

import concurrent.futures
import logging

logger = logging.getLogger(__name__)

# Hard filter thresholds — same as wheel-scan's (CLAUDE.md-derived), kept
# identical since they're fundamentals-based, not options-strategy-specific.
HARD_FILTERS = {
    "min_rev_growth_pct": 5.0,
    "min_gross_margin_pct": 30.0,
    "min_fcf": 0,  # must be positive
    "max_debt_equity": 2.0,
    "min_market_cap_b": 2.0,  # $2B minimum
}


def fetch_sp500_tickers():
    """Fetch S&P 500 tickers from Wikipedia."""
    import requests
    from io import StringIO
    try:
        import pandas as pd
        url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
        resp = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        tables = pd.read_html(StringIO(resp.text))
        tickers = tables[0]["Symbol"].tolist()
        return [t.replace(".", "-") for t in tickers]
    except Exception as e:
        logger.warning(f"Failed to fetch S&P 500 list: {e}")
        return []


def fetch_sp400_tickers():
    """Fetch S&P 400 MidCap tickers from Wikipedia."""
    import requests
    from io import StringIO
    try:
        import pandas as pd
        url = "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies"
        resp = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        tables = pd.read_html(StringIO(resp.text))
        for table in tables:
            if "Ticker" in table.columns or "Symbol" in table.columns:
                col = "Ticker" if "Ticker" in table.columns else "Symbol"
                tickers = table[col].tolist()
                return [t.replace(".", "-") for t in tickers]
        return []
    except Exception as e:
        logger.warning(f"Failed to fetch S&P 400 list: {e}")
        return []


def get_full_universe():
    """Return combined S&P 500 + 400 ticker list, deduplicated."""
    sp500 = fetch_sp500_tickers()
    sp400 = fetch_sp400_tickers()
    combined = list(dict.fromkeys(sp500 + sp400))
    logger.info(f"Universe: {len(sp500)} S&P500 + {len(sp400)} S&P400 = {len(combined)} unique")
    return combined


def fetch_stock_fundamentals(ticker):
    """Fetch key fundamentals for a single ticker via yfinance. Returns dict or None."""
    import yfinance as yf
    try:
        info = yf.Ticker(ticker).info
        if not info or info.get("regularMarketPrice") is None:
            return None

        market_cap = info.get("marketCap") or 0
        if market_cap < HARD_FILTERS["min_market_cap_b"] * 1e9:
            return None

        rev_growth = (info.get("revenueGrowth") or 0) * 100
        gross_margin = (info.get("grossMargins") or 0) * 100
        fcf = info.get("freeCashflow") or 0

        de_ratio = info.get("debtToEquity") or 0
        if de_ratio < 0:
            de_ratio = abs(de_ratio)
        if de_ratio > 20:
            de_ratio = de_ratio / 100

        op_margin = (info.get("operatingMargins") or 0) * 100
        roe = (info.get("returnOnEquity") or 0) * 100
        eps_growth = (info.get("earningsGrowth") or 0) * 100
        pe_ratio = info.get("forwardPE") or info.get("trailingPE") or 0

        current_price = info.get("regularMarketPrice") or info.get("currentPrice") or 0
        sector = info.get("sector") or "Unknown"
        industry = info.get("industry") or "Unknown"
        name = info.get("longName") or ticker

        return {
            "ticker": ticker,
            "name": name,
            "sector": sector,
            "industry": industry,
            "price": round(float(current_price), 2),
            "market_cap_b": round(market_cap / 1e9, 1),
            "rev_growth": round(rev_growth, 1),
            "gross_margin": round(gross_margin, 1),
            "op_margin": round(op_margin, 1),
            "fcf": int(fcf),
            "de_ratio": round(de_ratio, 2),
            "roe": round(roe, 1),
            "eps_growth": round(eps_growth, 1),
            "pe_ratio": round(float(pe_ratio), 1) if pe_ratio else None,
        }
    except Exception as e:
        logger.debug(f"Failed to fetch {ticker}: {e}")
        return None


def batch_fetch_fundamentals(tickers, max_workers=20):
    """Fetch fundamentals for all tickers in parallel. Returns list of valid results."""
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_map = {executor.submit(fetch_stock_fundamentals, t): t for t in tickers}
        for future in concurrent.futures.as_completed(future_map):
            data = future.result()
            if data:
                results.append(data)
    return results


def apply_hard_filters(stocks):
    """Apply the hard filters. Returns list of stocks that pass all criteria."""
    passed = []
    for s in stocks:
        if s["rev_growth"] < HARD_FILTERS["min_rev_growth_pct"]:
            continue
        if s["gross_margin"] < HARD_FILTERS["min_gross_margin_pct"]:
            continue
        if s["fcf"] <= HARD_FILTERS["min_fcf"]:
            continue
        if s["de_ratio"] > HARD_FILTERS["max_debt_equity"]:
            continue
        passed.append(s)
    return passed


def score_stock_fundamentals(stock):
    """
    Score a stock 0-100 based on fundamental factors — strategy-agnostic
    (works identically whether the eventual candidate becomes a long
    equity idea, a short, or an options structure). Weights:
      Revenue growth 20%, Gross margin 20%, FCF quality 15%,
      Debt/Equity 15%, ROE 15%, EPS growth 15%.
    """
    score = 0

    rg = stock["rev_growth"]
    if rg >= 20: score += 20
    elif rg >= 15: score += 16
    elif rg >= 10: score += 12
    elif rg >= 5: score += 8

    gm = stock["gross_margin"]
    if gm >= 60: score += 20
    elif gm >= 50: score += 16
    elif gm >= 40: score += 12
    elif gm >= 30: score += 8

    fcf_b = stock["fcf"] / 1e9
    if fcf_b >= 5: score += 15
    elif fcf_b >= 2: score += 12
    elif fcf_b >= 0.5: score += 9
    elif fcf_b > 0: score += 5

    de = stock["de_ratio"]
    if de <= 0.3: score += 15
    elif de <= 0.7: score += 12
    elif de <= 1.0: score += 9
    elif de <= 1.5: score += 6
    elif de <= 2.0: score += 3

    roe = stock["roe"]
    if roe >= 30: score += 15
    elif roe >= 20: score += 12
    elif roe >= 15: score += 9
    elif roe >= 10: score += 6
    else: score += 3

    eg = stock.get("eps_growth", 0) or 0
    if eg >= 20: score += 15
    elif eg >= 15: score += 12
    elif eg >= 10: score += 9
    elif eg >= 5: score += 6
    else: score += 3

    return min(score, 100)
