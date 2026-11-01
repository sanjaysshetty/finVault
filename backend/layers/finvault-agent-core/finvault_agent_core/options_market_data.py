"""
Real option chain data (strike, bid/ask mid price, implied volatility) via
yfinance -- the deterministic ground-truth source that scenario_math's
underlying_price/iv inputs must trace to, same "never invent, never guess"
principle already applied to the probability math itself (scenario_math.py)
and RobinhoodMcpClient's own error-not-fallback design.

Robinhood's MCP connector was the originally-planned source for this (see
tower2_shared.py's TOWER2_ROBINHOOD_ALLOWED_TOOLS), but there is no
supported mechanism for a headless backend Lambda to obtain a Robinhood
MCP access token -- confirmed directly against Robinhood's own support
documentation: their onboarding flow is scoped to interactive AI chat
clients (Claude Desktop, ChatGPT, Cursor), not server-to-server
integration. yfinance fills this gap instead, exactly as it already does
for OptionMarksFunction's paper-trading mark lookups and for this scan's
own prefilter stage's stock fundamentals.

Container-image packaging (not zip) for every function that imports this
module -- yfinance now requires curl_cffi as a hard dependency (an older
yfinance without it gets immediately rate-limited by Yahoo, confirmed
live), and that stack doesn't fit in Lambda's 250MB zip limit alongside
this layer's own anthropic/mcp dependencies (confirmed directly: 287MB
combined, 2026-10-31 size investigation). Container images lift that to
10GB, so this lives back in the shared layer's source tree and gets
baked directly into each consuming function's own image at build time
(Lambda Layers aren't usable with container images at all) rather than
living in a separate standalone Lambda invoked over the network.
"""

import datetime


class OptionMarketDataError(RuntimeError):
    """Raised on any fetch/parse/liquidity failure -- no silent fallback
    to a fabricated, stale, or unreliable price/IV number."""


# Contracts with combined volume+openInterest below this are excluded --
# yfinance's implied-vol solver is unreliable for illiquid, far-from-the-
# money strikes. Verified directly against a live chain: deep-ITM
# contracts with single-digit volume showed impliedVolatility > 100% on a
# liquid large-cap name, while near-the-money strikes with real volume
# showed a sane ~30-38%.
MIN_LIQUIDITY = 10

# Only strikes within this fraction of the current underlying price are
# considered -- covered calls/cash-secured puts/verticals are built near
# the money; a strike 3x out is never a live candidate, and its IV is the
# least reliable part of the chain anyway.
MAX_MONEYNESS_PCT = 0.20


def _default_ticker_factory(symbol):
    import yfinance as yf

    return yf.Ticker(symbol)


def get_option_chain_data(ticker, expiry, option_type, strike_hint=None, max_results=8, ticker_factory=None):
    """
    Fetch real option chain data for one ticker/expiry/option_type via
    yfinance, filtered to liquid, near-the-money strikes.

    Returns:
        {
            "underlying_price": float,
            "expiry": "YYYY-MM-DD",
            "contracts": [
                {"strike": float, "bid": float, "ask": float, "mid": float,
                 "impliedVolatility": float, "volume": int, "openInterest": int},
                ...
            ],
        }
    sorted by distance from `strike_hint` (if given) or the current
    underlying price, nearest first, capped at `max_results`.

    Raises OptionMarketDataError if the ticker/expiry has no chain data,
    or nothing survives the moneyness/liquidity filter -- a caller (or
    the AgentLoop tool wrapper) must handle this explicitly, there is no
    silent empty-result fallback.
    """
    factory = ticker_factory or _default_ticker_factory
    try:
        tk = factory(ticker)
        underlying_price = float(tk.fast_info["lastPrice"])
        chain = tk.option_chain(expiry)
    except OptionMarketDataError:
        raise
    except Exception as e:
        raise OptionMarketDataError(f"Failed to fetch option chain for {ticker} {expiry}: {e}") from e

    table = chain.calls if option_type.lower() == "call" else chain.puts
    if table is None or table.empty:
        raise OptionMarketDataError(f"No {option_type} chain data for {ticker} {expiry}")

    center = strike_hint if strike_hint is not None else underlying_price
    contracts = []
    for _, row in table.iterrows():
        strike = float(row["strike"])
        if abs(strike - underlying_price) / underlying_price > MAX_MONEYNESS_PCT:
            continue
        volume = int(row.get("volume") or 0)
        open_interest = int(row.get("openInterest") or 0)
        if volume + open_interest < MIN_LIQUIDITY:
            continue
        bid = float(row.get("bid") or 0)
        ask = float(row.get("ask") or 0)
        mid = round((bid + ask) / 2, 2) if (bid > 0 and ask > 0) else round(float(row.get("lastPrice") or 0), 2)
        contracts.append({
            "strike": strike,
            "bid": round(bid, 2),
            "ask": round(ask, 2),
            "mid": mid,
            "impliedVolatility": round(float(row.get("impliedVolatility") or 0), 4),
            "volume": volume,
            "openInterest": open_interest,
        })

    if not contracts:
        raise OptionMarketDataError(
            f"No liquid near-the-money {option_type} contracts for {ticker} {expiry} "
            f"(underlying price ${underlying_price:.2f})"
        )

    contracts.sort(key=lambda c: abs(c["strike"] - center))
    return {
        "underlying_price": round(underlying_price, 2),
        "expiry": expiry,
        "contracts": contracts[:max_results],
    }


def days_to_expiry(expiry_str, as_of=None):
    """Calendar days between `as_of` (default: today, UTC) and expiry_str
    (YYYY-MM-DD) -- feeds scenario_math.simulate_scenario's
    days_to_expiry param."""
    as_of = as_of or datetime.date.today()
    expiry_date = datetime.date.fromisoformat(expiry_str)
    return float((expiry_date - as_of).days)
