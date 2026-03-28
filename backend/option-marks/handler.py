"""
OptionMarks Lambda
Accepts a list of open option positions and returns the current mid price
(bid+ask / 2) for each contract using yfinance.

POST /assets/options/marks
Body: {
  "positions": [
    { "key": "AAPL_150_2026-04-17_call", "ticker": "AAPL", "strike": 150, "expiry": "2026-04-17", "optionType": "call" },
    ...
  ]
}
Response: { "marks": { "AAPL_150_2026-04-17_call": 2.45, ... } }
"""

import json
import logging

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


def get_option_mid(ticker, strike, expiry, option_type):
    """
    Fetch current mid price for a specific option contract via yfinance.
    Returns float or None if not available.
    """
    import yfinance as yf

    try:
        tk = yf.Ticker(ticker)
        chain = tk.option_chain(expiry)
        options = chain.calls if option_type.lower() == "call" else chain.puts

        if options.empty:
            return None

        strike_f = float(strike)
        exact = options[options["strike"] == strike_f]
        if exact.empty:
            # Nearest strike fallback
            exact = options.iloc[(options["strike"] - strike_f).abs().argsort()[:1]]
        if exact.empty:
            return None

        row = exact.iloc[0]
        bid = float(row.get("bid", 0) or 0)
        ask = float(row.get("ask", 0) or 0)

        if bid <= 0 and ask <= 0:
            last = float(row.get("lastPrice", 0) or 0)
            return last if last > 0 else None
        if bid <= 0:
            return round(ask, 2)
        if ask <= 0:
            return round(bid, 2)
        return round((bid + ask) / 2, 2)

    except Exception as e:
        logger.warning(f"Mark fetch failed for {ticker} {strike} {expiry}: {e}")
        return None


def cors_headers():
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Account-Id",
    }


def handler(event, context):
    method = (event.get("requestContext", {}).get("http", {}).get("method") or "POST").upper()
    if method == "OPTIONS":
        return {"statusCode": 204, "headers": cors_headers(), "body": ""}

    try:
        body = json.loads(event.get("body") or "{}")
        positions = body.get("positions", [])

        marks = {}
        for pos in positions:
            key = pos.get("key")
            ticker = pos.get("ticker", "").upper().strip()
            strike = pos.get("strike")
            expiry = pos.get("expiry", "").strip()
            option_type = pos.get("optionType", "call").strip()

            if not key or not ticker or strike is None or not expiry:
                continue
            if option_type.lower() not in ("call", "put"):
                continue

            mid = get_option_mid(ticker, strike, expiry, option_type)
            if mid is not None:
                marks[key] = mid
                logger.info(f"Mark {key} = {mid}")
            else:
                logger.info(f"No mark for {key}")

        return {
            "statusCode": 200,
            "headers": cors_headers(),
            "body": json.dumps({"marks": marks}),
        }

    except Exception as e:
        logger.error(f"OptionMarks error: {e}")
        return {
            "statusCode": 500,
            "headers": cors_headers(),
            "body": json.dumps({"error": "Internal server error"}),
        }
