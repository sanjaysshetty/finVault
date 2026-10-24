"""
Wheel Scan — Data Fetching Tools
Fetches fundamentals and options data via yfinance in parallel.
"""

import concurrent.futures
import datetime
import logging
import math

logger = logging.getLogger(__name__)

# ── Hard filter thresholds (per CLAUDE.md) ───────────────────
HARD_FILTERS = {
    "min_rev_growth_pct":   5.0,
    "min_gross_margin_pct": 30.0,
    "min_fcf":              0,          # must be positive
    "max_debt_equity":      2.0,
    "min_market_cap_b":     2.0,        # $2B minimum
}

# ── Wheel strategy options parameters ────────────────────────
OPT_DTE_MIN = 21
OPT_DTE_MAX = 45
DELTA_MIN   = 0.20
DELTA_MAX   = 0.45
MIN_OI      = 50
MAX_SPREAD_PCT = 10.0


# ── Ticker universe ───────────────────────────────────────────

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
        # Clean up tickers (Wikipedia uses dots, yfinance uses dashes)
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
        # Try different table index
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
    combined = list(dict.fromkeys(sp500 + sp400))  # deduplicate preserving order
    logger.info(f"Universe: {len(sp500)} S&P500 + {len(sp400)} S&P400 = {len(combined)} unique")
    return combined


# ── Single-stock fundamentals fetch ──────────────────────────

def fetch_stock_fundamentals(ticker):
    """Fetch key fundamentals for a single ticker via yfinance. Returns dict or None."""
    import yfinance as yf
    try:
        info = yf.Ticker(ticker).info
        if not info or info.get("regularMarketPrice") is None:
            return None

        # Market cap check
        market_cap = info.get("marketCap") or 0
        if market_cap < HARD_FILTERS["min_market_cap_b"] * 1e9:
            return None

        # Revenue growth
        rev_growth = (info.get("revenueGrowth") or 0) * 100  # yfinance returns as decimal

        # Gross margin
        gross_margin = (info.get("grossMargins") or 0) * 100

        # Free cash flow
        fcf = info.get("freeCashflow") or 0

        # Debt / Equity
        de_ratio = info.get("debtToEquity") or 0
        if de_ratio < 0:
            de_ratio = abs(de_ratio)
        # yfinance reports D/E as percentage in some versions; normalize
        if de_ratio > 20:
            de_ratio = de_ratio / 100

        # Operating margin, ROE, EPS growth
        op_margin   = (info.get("operatingMargins") or 0) * 100
        roe         = (info.get("returnOnEquity") or 0) * 100
        eps_growth  = (info.get("earningsGrowth") or 0) * 100
        pe_ratio    = info.get("forwardPE") or info.get("trailingPE") or 0

        current_price = info.get("regularMarketPrice") or info.get("currentPrice") or 0
        sector        = info.get("sector") or "Unknown"
        industry      = info.get("industry") or "Unknown"
        name          = info.get("longName") or ticker

        return {
            "ticker":        ticker,
            "name":          name,
            "sector":        sector,
            "industry":      industry,
            "price":         round(float(current_price), 2),
            "market_cap_b":  round(market_cap / 1e9, 1),
            "rev_growth":    round(rev_growth, 1),
            "gross_margin":  round(gross_margin, 1),
            "op_margin":     round(op_margin, 1),
            "fcf":           int(fcf),
            "de_ratio":      round(de_ratio, 2),
            "roe":           round(roe, 1),
            "eps_growth":    round(eps_growth, 1),
            "pe_ratio":      round(float(pe_ratio), 1) if pe_ratio else None,
        }
    except Exception as e:
        logger.debug(f"Failed to fetch {ticker}: {e}")
        return None


# ── Parallel fundamentals batch ───────────────────────────────

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


# ── Hard filter ───────────────────────────────────────────────

def apply_hard_filters(stocks):
    """Apply CLAUDE.md hard filters. Returns list of stocks that pass all criteria."""
    passed = []
    for s in stocks:
        if s["rev_growth"]   < HARD_FILTERS["min_rev_growth_pct"]:   continue
        if s["gross_margin"] < HARD_FILTERS["min_gross_margin_pct"]: continue
        if s["fcf"]          <= HARD_FILTERS["min_fcf"]:             continue
        if s["de_ratio"]     > HARD_FILTERS["max_debt_equity"]:      continue
        passed.append(s)
    return passed


# ── Options chain fetch ────────────────────────────────────────

def fetch_options_for_stock(stock_data):
    """
    Fetch best CSP setup for a stock using yfinance options chain.
    Returns stock_data dict enriched with 'best_option' key, or None on failure.
    """
    import yfinance as yf

    ticker  = stock_data["ticker"]
    price   = stock_data["price"]
    today   = datetime.date.today()

    try:
        tk = yf.Ticker(ticker)
        expirations = tk.options  # tuple of "YYYY-MM-DD" strings
        if not expirations:
            return None

        # Find expiration within DTE window
        target_exp = None
        for exp_str in expirations:
            exp_date = datetime.date.fromisoformat(exp_str)
            dte = (exp_date - today).days
            if OPT_DTE_MIN <= dte <= OPT_DTE_MAX:
                target_exp = exp_str
                break

        if not target_exp:
            return None

        chain  = tk.option_chain(target_exp)
        puts   = chain.puts
        dte    = (datetime.date.fromisoformat(target_exp) - today).days

        # Filter puts: 5-20% OTM
        best = None
        best_yield = 0

        for _, row in puts.iterrows():
            strike = float(row.get("strike", 0))
            if strike <= 0 or price <= 0:
                continue

            pct_otm = (price - strike) / price * 100
            if pct_otm < 4 or pct_otm > 20:
                continue

            bid  = float(row.get("bid", 0) or 0)
            ask  = float(row.get("ask", 0) or 0)
            if bid <= 0 or ask <= 0:
                continue

            mid  = (bid + ask) / 2
            oi   = int(row.get("openInterest", 0) or 0)
            vol  = int(row.get("volume", 0) or 0)
            iv   = float(row.get("impliedVolatility", 0) or 0)

            spread_pct = (ask - bid) / mid * 100 if mid > 0 else 999
            if spread_pct > MAX_SPREAD_PCT:
                continue
            if oi < MIN_OI:
                continue

            # Estimate delta from IV (Black-Scholes approximation)
            delta_approx = _approx_delta(price, strike, iv, dte)

            ann_yield = (mid / strike) * (365 / dte) * 100 if dte > 0 and strike > 0 else 0
            breakeven = round(strike - mid, 2)

            if ann_yield > best_yield:
                best_yield = ann_yield
                best = {
                    "expiry":     target_exp,
                    "dte":        dte,
                    "strike":     strike,
                    "pct_otm":    round(pct_otm, 1),
                    "bid":        round(bid, 2),
                    "ask":        round(ask, 2),
                    "mid":        round(mid, 2),
                    "iv":         round(iv * 100, 1),
                    "delta":      round(abs(delta_approx), 3),
                    "open_interest": oi,
                    "volume":     vol,
                    "ann_yield":  round(ann_yield, 1),
                    "breakeven":  breakeven,
                    "spread_pct": round(spread_pct, 1),
                }

        if not best:
            return None

        return {**stock_data, "best_option": best}

    except Exception as e:
        logger.debug(f"Options fetch failed for {ticker}: {e}")
        return None


def _approx_delta(price, strike, iv, dte):
    """Approximate put delta using simplified Black-Scholes."""
    if iv <= 0 or dte <= 0 or price <= 0 or strike <= 0:
        return -0.30  # fallback
    try:
        t = dte / 365.0
        d1 = (math.log(price / strike) + 0.5 * iv * iv * t) / (iv * math.sqrt(t))
        # Normal CDF approximation
        def ncdf(x):
            return 0.5 * (1 + math.erf(x / math.sqrt(2)))
        delta = ncdf(d1) - 1  # put delta is negative
        return delta
    except Exception:
        return -0.30


def batch_fetch_options(stocks_with_fundamentals, max_workers=10):
    """Fetch options data for all qualifying stocks in parallel."""
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(fetch_options_for_stock, s): s["ticker"] for s in stocks_with_fundamentals}
        for future in concurrent.futures.as_completed(futures):
            data = future.result()
            if data and data.get("best_option"):
                results.append(data)
    return results


# ── Algorithmic scoring ────────────────────────────────────────

def score_stock_fundamentals(stock):
    """
    Score a stock 0-100 based on fundamental factors.
    Weights per CLAUDE.md:
      - Revenue growth      20%
      - Gross margin        20%
      - FCF quality         15%
      - Debt/Equity         15%
      - ROE                 15%
      - EPS growth          15%
    """
    score = 0

    # Revenue growth (20 pts): 5%=8, 10%=12, 15%=16, 20%+=20
    rg = stock["rev_growth"]
    if rg >= 20:     score += 20
    elif rg >= 15:   score += 16
    elif rg >= 10:   score += 12
    elif rg >= 5:    score += 8
    else:            score += 0

    # Gross margin (20 pts): 30%=8, 40%=12, 50%=16, 60%+=20
    gm = stock["gross_margin"]
    if gm >= 60:     score += 20
    elif gm >= 50:   score += 16
    elif gm >= 40:   score += 12
    elif gm >= 30:   score += 8
    else:            score += 0

    # FCF quality (15 pts): large positive FCF
    fcf_b = stock["fcf"] / 1e9  # billions
    if fcf_b >= 5:       score += 15
    elif fcf_b >= 2:     score += 12
    elif fcf_b >= 0.5:   score += 9
    elif fcf_b > 0:      score += 5
    else:                score += 0

    # Debt/Equity (15 pts): lower is better
    de = stock["de_ratio"]
    if de <= 0.3:    score += 15
    elif de <= 0.7:  score += 12
    elif de <= 1.0:  score += 9
    elif de <= 1.5:  score += 6
    elif de <= 2.0:  score += 3
    else:            score += 0

    # ROE (15 pts)
    roe = stock["roe"]
    if roe >= 30:    score += 15
    elif roe >= 20:  score += 12
    elif roe >= 15:  score += 9
    elif roe >= 10:  score += 6
    else:            score += 3

    # EPS growth (15 pts)
    eg = stock.get("eps_growth", 0) or 0
    if eg >= 20:     score += 15
    elif eg >= 15:   score += 12
    elif eg >= 10:   score += 9
    elif eg >= 5:    score += 6
    else:            score += 3

    return min(score, 100)
