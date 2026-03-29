"""
AssetHub Lambda — async job pattern
POST /assets/hub/analyze        → create job, invoke worker async, return {jobId}
GET  /assets/hub/result/{jobId} → poll job status / result
Direct Lambda invocation        → worker mode: run analysis, store result
"""

import json, logging, os, base64, datetime, uuid
from concurrent.futures import ThreadPoolExecutor
import boto3
import anthropic
from boto3.dynamodb.conditions import Key

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

ANTHROPIC_API_KEY  = os.environ.get("ANTHROPIC_API_KEY", "")
FIN_ASSETS_TABLE   = os.environ.get("FIN_ASSETS_TABLE", "")
REPORTS_BUCKET     = os.environ.get("REPORTS_BUCKET", "")
REPORTS_PREFIX     = os.environ.get("REPORTS_PREFIX", "AssetHubReports/")
MODEL              = "claude-sonnet-4-6"
SELF_FUNCTION_NAME = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "")  # auto-set by Lambda
CACHE_MAX_AGE_DAYS = 7

_ddb    = boto3.resource("dynamodb")
_s3     = boto3.client("s3")
_lambda = boto3.client("lambda")
_table  = _ddb.Table(FIN_ASSETS_TABLE) if FIN_ASSETS_TABLE else None

INVESTOR_PROFILE = {
    "horizon":       "3 months to 3 years",
    "target_return": "20–30% annual",
    "risk_appetite": "medium",
}

HUB_JOB_PREFIX = "HUB_JOB#"


# ── JWT decode (API GW already validated signature) ────────────

def get_user_id(event):
    try:
        auth = ((event.get("headers") or {}).get("authorization") or
                (event.get("headers") or {}).get("Authorization") or "")
        if not auth.startswith("Bearer "):
            return None
        payload = auth.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.b64decode(payload))
        return claims.get("sub")
    except Exception as e:
        logger.warning(f"JWT decode failed: {e}")
        return None


# ── DynamoDB job helpers ───────────────────────────────────────

def create_job(user_id, ticker, asset_type):
    job_id = str(uuid.uuid4())
    ttl = int((datetime.datetime.utcnow() + datetime.timedelta(hours=24)).timestamp())
    _table.put_item(Item={
        "userId":    user_id,
        "assetId":   f"{HUB_JOB_PREFIX}{job_id}",
        "jobId":     job_id,
        "status":    "pending",
        "ticker":    ticker,
        "assetType": asset_type,
        "createdAt": datetime.datetime.utcnow().isoformat() + "Z",
        "ttl":       ttl,
    })
    return job_id


def get_job(user_id, job_id):
    resp = _table.get_item(Key={
        "userId":  user_id,
        "assetId": f"{HUB_JOB_PREFIX}{job_id}",
    })
    return resp.get("Item")


def update_job(user_id, job_id, status, result=None, error_msg=None):
    update_expr = "SET #s = :s"
    names  = {"#s": "status"}
    values = {":s": status}
    if result is not None:
        update_expr += ", #r = :r"
        names["#r"]  = "result"
        values[":r"] = json.dumps(result)   # store as JSON string — avoids boto3 Decimal round-trip
    if error_msg is not None:
        update_expr += ", #e = :e"
        names["#e"]  = "errorMsg"
        values[":e"] = error_msg
    _table.update_item(
        Key={"userId": user_id, "assetId": f"{HUB_JOB_PREFIX}{job_id}"},
        UpdateExpression=update_expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


# ── S3 report cache ───────────────────────────────────────────

def _report_key(user_id, ticker):
    return f"{REPORTS_PREFIX}{user_id}/{ticker.upper()}.json"


def get_cached_report(user_id, ticker):
    """Return cached result dict if a fresh report (< 7 days) exists in S3, else None."""
    if not REPORTS_BUCKET:
        return None
    try:
        obj = _s3.get_object(Bucket=REPORTS_BUCKET, Key=_report_key(user_id, ticker))
        data = json.loads(obj["Body"].read())
        ts_str = data.get("generated_at") or data.get("analyzed_at", "")
        generated_at = datetime.datetime.fromisoformat(ts_str.rstrip("Z"))
        age = datetime.datetime.utcnow() - generated_at
        if age.days < CACHE_MAX_AGE_DAYS:
            logger.info(f"Cache hit: {ticker} age={age.days}d")
            return data
        logger.info(f"Cache stale: {ticker} age={age.days}d")
        return None
    except _s3.exceptions.NoSuchKey:
        return None
    except Exception as e:
        # Includes InvalidObjectState when object is in Glacier — treat as cache miss
        logger.info(f"Cache miss for {ticker}: {e}")
        return None


def store_report(user_id, ticker, result):
    """Write result to S3. Lifecycle rule archives it to Glacier after 7 days."""
    if not REPORTS_BUCKET:
        return
    try:
        _s3.put_object(
            Bucket=REPORTS_BUCKET,
            Key=_report_key(user_id, ticker),
            Body=json.dumps(result),
            ContentType="application/json",
        )
        logger.info(f"Report cached: {ticker}")
    except Exception as e:
        logger.warning(f"Failed to cache report for {ticker}: {e}")


# ── Portfolio fetch ────────────────────────────────────────────

def fetch_portfolio(user_id):
    if not _table or not user_id:
        return {}
    try:
        resp  = _table.query(
            IndexName="GSI1",
            KeyConditionExpression=Key("gsi1pk").eq(user_id),
            Limit=400,
        )
        items = resp.get("Items", [])

        portfolio = {k: [] for k in ("stocks", "options", "crypto", "bullion", "futures", "fixed_income")}

        for it in items:
            atype = it.get("assetType", "")
            if atype == "STOCK_TX":
                portfolio["stocks"].append({
                    "ticker":   it.get("ticker", ""),
                    "qty":      float(it.get("qty") or 0),
                    "avg_cost": float(it.get("avgCost") or it.get("price") or 0),
                })
            elif atype == "OPTIONS_TX":
                portfolio["options"].append({
                    "ticker":  it.get("ticker", ""),
                    "type":    it.get("type", ""),
                    "event":   it.get("event", ""),
                    "strike":  float(it.get("strikes") or 0),
                    "expiry":  it.get("expiry", ""),
                    "qty":     float(it.get("qty") or 0),
                    "is_open": not bool(it.get("closeDate")),
                })
            elif atype == "CRYPTO_TX":
                portfolio["crypto"].append({
                    "ticker":   it.get("ticker", ""),
                    "qty":      float(it.get("qty") or 0),
                    "avg_cost": float(it.get("price") or it.get("avgCost") or 0),
                })
            elif atype == "BULLION_TX":
                portfolio["bullion"].append({
                    "metal": it.get("metal") or it.get("ticker", ""),
                    "oz":    float(it.get("oz") or it.get("qty") or 0),
                })
            elif atype == "FUTURES_TX":
                portfolio["futures"].append({
                    "ticker": it.get("ticker", ""),
                    "qty":    float(it.get("qty") or 0),
                })
            elif atype in ("FIXED_INCOME", "FIXEDINCOME"):
                portfolio["fixed_income"].append({
                    "name":  it.get("name") or it.get("ticker", ""),
                    "value": float(it.get("faceValue") or it.get("value") or it.get("amount") or 0),
                })

        # Compute cost-basis total across stocks, crypto, and FI (best estimate without live prices)
        total_invested = 0
        for s in portfolio["stocks"]:
            total_invested += s["qty"] * s["avg_cost"]
        for c in portfolio["crypto"]:
            total_invested += c["qty"] * c["avg_cost"]
        for fi in portfolio["fixed_income"]:
            total_invested += fi["value"]
        portfolio["total_invested"] = round(total_invested, 2)

        return portfolio
    except Exception as e:
        logger.warning(f"Portfolio fetch failed: {e}")
        return {}


# ── yfinance market data fetch ─────────────────────────────────

def fetch_market_data(ticker, asset_type):
    import yfinance as yf
    from concurrent.futures import ThreadPoolExecutor as _TPool, as_completed as _ac

    result = {"ticker": ticker.upper()}
    try:
        tk = yf.Ticker(ticker)

        # Fetch info, 1y history, and max history in parallel
        with _TPool(max_workers=3) as pool:
            fut_info     = pool.submit(lambda: tk.info or {})
            fut_hist     = pool.submit(lambda: tk.history(period="1y"))
            fut_hist_max = pool.submit(lambda: tk.history(period="max", interval="1mo"))
            try:
                info = fut_info.result(timeout=15)
            except Exception:
                info = {}
            try:
                hist = fut_hist.result(timeout=15)
            except Exception:
                hist = None
            try:
                hist_max = fut_hist_max.result(timeout=15)
            except Exception:
                hist_max = None

        price      = float(info.get("currentPrice") or info.get("regularMarketPrice") or 0)
        prev_close = float(info.get("previousClose") or 0)

        result.update({
            "name":            info.get("longName") or info.get("shortName", ticker),
            "price":           price,
            "prev_close":      prev_close,
            "day_change_pct":  round((price - prev_close) / prev_close * 100, 2) if prev_close else 0,
            "sector":          info.get("sector", ""),
            "industry":        info.get("industry", ""),
            "market_cap_b":    round((info.get("marketCap") or 0) / 1e9, 2),
            "52w_high":        float(info.get("fiftyTwoWeekHigh") or 0),
            "52w_low":         float(info.get("fiftyTwoWeekLow")  or 0),
            "beta":            info.get("beta"),
            "pe_trailing":     info.get("trailingPE"),
            "pe_forward":      info.get("forwardPE"),
            "peg":             info.get("pegRatio"),
            "ps":              info.get("priceToSalesTrailing12Months"),
            "pb":              info.get("priceToBook"),
            "ev_ebitda":       info.get("enterpriseToEbitda"),
            "div_yield":       info.get("dividendYield") or 0,
            "short_float":     info.get("shortPercentOfFloat"),
            "rev_growth":      info.get("revenueGrowth"),
            "earnings_growth": info.get("earningsGrowth"),
            "gross_margin":    info.get("grossMargins"),
            "op_margin":       info.get("operatingMargins"),
            "profit_margin":   info.get("profitMargins"),
            "roe":             info.get("returnOnEquity"),
            "de_ratio":        info.get("debtToEquity"),
            "current_ratio":   info.get("currentRatio"),
            "fcf_b":           round((info.get("freeCashflow") or 0) / 1e9, 2),
            "target_low":      info.get("targetLowPrice"),
            "target_mean":     info.get("targetMeanPrice"),
            "target_high":     info.get("targetHighPrice"),
            "analyst_rating":  info.get("recommendationKey"),
            "num_analysts":    info.get("numberOfAnalystOpinions") or 0,
            "description":     (info.get("longBusinessSummary") or "")[:500],
        })

        # All-time high from monthly history
        if hist_max is not None and not hist_max.empty:
            result["all_time_high"] = round(float(hist_max["High"].max()), 2)

        # 1-year price history + 200-day MA
        if hist is not None and not hist.empty:
            first = float(hist["Close"].iloc[0])
            last  = float(hist["Close"].iloc[-1])
            result["1y_return_pct"] = round((last - first) / first * 100, 1) if first else 0
            if len(hist) >= 200:
                result["ma200"]       = round(float(hist["Close"].tail(200).mean()), 2)
                result["above_ma200"] = price > result["ma200"]

        # Options chain — 5 expiries fetched in parallel, 8 contracts each side
        if asset_type in ("stock", "options"):
            try:
                now      = datetime.datetime.utcnow()
                all_exp  = tk.options or []
                valid_exp = [
                    e for e in all_exp
                    if 7 <= (datetime.datetime.strptime(e, "%Y-%m-%d") - now).days <= 120
                ][:5]

                def _fetch_chain(exp):
                    return exp, tk.option_chain(exp)

                chain_map = {}
                if valid_exp:
                    with _TPool(max_workers=5) as pool:
                        futs = {pool.submit(_fetch_chain, e): e for e in valid_exp}
                        for fut in _ac(futs, timeout=20):
                            try:
                                exp, chain = fut.result()
                                chain_map[exp] = chain
                            except Exception:
                                pass

                options_out = []
                for exp, chain in chain_map.items():
                    dte = max(1, (datetime.datetime.strptime(exp, "%Y-%m-%d") - now).days)

                    def _collect(rows, opt_type):
                        out = []
                        for _, row in rows.iterrows():
                            bid = float(row.get("bid") or 0)
                            ask = float(row.get("ask") or 0)
                            mid = (bid + ask) / 2
                            if mid <= 0:
                                continue
                            strike  = float(row["strike"])
                            pct_rel = round((price - strike) / price * 100, 1) if opt_type == "put" \
                                      else round((strike - price) / price * 100, 1)
                            ann     = round(mid / max(strike, 0.01) * (365 / dte) * 100, 1)
                            out.append({
                                "type": opt_type, "expiry": exp, "dte": dte,
                                "strike": strike, "pct_rel": pct_rel,
                                "mid": round(mid, 2),
                                "iv": round(float(row.get("impliedVolatility") or 0) * 100, 1),
                                "delta": round(abs(float(row.get("delta") or 0)), 3),
                                "ann_yield_pct": ann,
                                "oi": int(row.get("openInterest") or 0),
                                "itm": bool(row.get("inTheMoney", False)),
                            })
                        return out

                    # Wide put range: 30% ITM → 5% OTM
                    puts = chain.puts
                    if not puts.empty and price > 0:
                        p = puts[(puts["strike"] >= price * 0.70) & (puts["strike"] <= price * 1.05)]
                        options_out.extend(_collect(p.sort_values("openInterest", ascending=False).head(8), "put"))

                    # Wide call range: ATM → 30% OTM
                    calls = chain.calls
                    if not calls.empty and price > 0:
                        c = calls[(calls["strike"] >= price * 0.95) & (calls["strike"] <= price * 1.30)]
                        options_out.extend(_collect(c.sort_values("openInterest", ascending=False).head(8), "call"))

                result["options_chain"] = options_out[:40]
            except Exception as e:
                logger.warning(f"Options chain fetch failed for {ticker}: {e}")
                result["options_chain"] = []

        return result

    except Exception as e:
        logger.error(f"Market data fetch failed for {ticker}: {e}")
        result["error"] = str(e)
        return result


# ── Claude analysis tool schema ────────────────────────────────

ANALYSIS_TOOL = {
    "name": "provide_asset_analysis",
    "description": "Provide a complete structured analysis and personalized recommendation for the asset.",
    "input_schema": {
        "type": "object",
        "properties": {
            "recommendation": {
                "type": "string", "enum": ["BUY", "WATCH", "AVOID"],
                "description": "Primary investment recommendation"
            },
            "confidence": {
                "type": "string", "enum": ["HIGH", "MEDIUM", "LOW"]
            },
            "summary": {
                "type": "string",
                "description": "3-4 sentence executive summary personalised to this investor"
            },
            "price_targets": {
                "type": "object",
                "description": "AI-modeled price targets informed by analyst consensus, growth trajectory, and valuation. Each includes probability of being reached within that timeframe.",
                "properties": {
                    "3_month":             {"type": "number"},
                    "3_month_probability": {"type": "string", "enum": ["HIGH", "MEDIUM", "LOW"], "description": "Probability of reaching 3M target within 3 months"},
                    "1_year":              {"type": "number"},
                    "1_year_probability":  {"type": "string", "enum": ["HIGH", "MEDIUM", "LOW"], "description": "Probability of reaching 1Y target within 1 year"},
                    "3_year":              {"type": "number"},
                    "3_year_probability":  {"type": "string", "enum": ["HIGH", "MEDIUM", "LOW"], "description": "Probability of reaching 3Y target within 3 years"},
                    "analyst_mean":        {"type": "number", "description": "Analyst consensus mean target — pass through from market data if available"}
                },
                "required": ["3_month", "3_month_probability", "1_year", "1_year_probability", "3_year", "3_year_probability"]
            },
            "return_potential": {
                "type": "object",
                "properties": {
                    "base_case_annual_pct": {"type": "number"},
                    "bull_case_annual_pct": {"type": "number"},
                    "bear_case_annual_pct": {"type": "number"}
                },
                "required": ["base_case_annual_pct", "bull_case_annual_pct", "bear_case_annual_pct"]
            },
            "industry_pe": {
                "type": "number",
                "description": "Current average P/E ratio for the stock's industry/sector peer group. Use your knowledge of current market valuations for this specific industry."
            },
            "fundamental_score": {
                "type": "integer", "minimum": 0, "maximum": 100,
                "description": "Overall fundamental quality 0-100"
            },
            "fundamental_highlights": {
                "type": "array", "items": {"type": "string"},
                "description": "3-5 key fundamental strengths"
            },
            "fundamental_concerns": {
                "type": "array", "items": {"type": "string"},
                "description": "2-4 fundamental concerns or weaknesses"
            },
            "macro_tailwinds": {
                "type": "array", "items": {"type": "string"},
                "description": "2-3 macro/sector tailwinds"
            },
            "macro_headwinds": {
                "type": "array", "items": {"type": "string"},
                "description": "2-3 macro/sector headwinds"
            },
            "technical_note": {
                "type": "string",
                "description": "Brief technical analysis: trend, support/resistance, momentum"
            },
            "portfolio_fit": {
                "type": "object",
                "properties": {
                    "concentration_note":       {"type": "string"},
                    "suggested_allocation_pct": {"type": "number"},
                    "entry_strategy":           {"type": "string"},
                    "options_capital_required": {
                        "type": "number",
                        "description": "Estimated dollars needed to achieve equivalent upside exposure via options (ATM calls or LEAPS) instead of buying stock outright. Compute as: allocation_dollars * options_leverage_factor, where leverage_factor is typically 0.15-0.25 for ATM calls. Use actual IV and option prices from the chain to be specific."
                    }
                },
                "required": ["concentration_note", "suggested_allocation_pct", "entry_strategy", "options_capital_required"]
            },
            "options_ownership_slider": {
                "type": "integer", "minimum": 0, "maximum": 100,
                "description": "Score derived by weighing 8 factors (see prompt). 0=strongly recommend outright ownership, 50=balanced own+overlay, 100=pure options play. Each factor pushes toward 0 or 100; average and round to nearest 5."
            },
            "options_ownership_rationale": {
                "type": "string",
                "description": "One concise sentence explaining the primary drivers behind the slider value. Name the 2-3 most decisive factors. E.g. 'Low IV makes options cheap, high conviction BUY supports ownership, but high stock price favors options for capital efficiency.'"
            },
            "options_strategies": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "purpose":           {"type": "string", "enum": ["OWNERSHIP", "INCOME", "OPTIONS_PLAY"], "description": "OWNERSHIP=buy shares outright or LEAPS to own the asset long-term; INCOME=premium harvesting on existing or new position (CC, CSP); OPTIONS_PLAY=speculative directional trade without owning shares"},
                        "strategy":          {"type": "string", "description": "e.g. Outright Purchase, Long Call LEAPS, Cash Secured Put, Covered Call, Bull Put Spread, Bear Call Spread, Protective Put, Iron Condor, Straddle, etc."},
                        "rationale":         {"type": "string"},
                        "goal_alignment":    {"type": "string", "description": "Explicitly how this contributes to the 20-30% annual return target"},
                        "suggested_strike":  {"type": "number"},
                        "suggested_expiry":  {"type": "string"},
                        "estimated_premium": {"type": "number"},
                        "ann_yield_pct":     {"type": "number"},
                        "max_risk":          {"type": "string", "description": "Max loss scenario in plain English"}
                    },
                    "required": ["purpose", "strategy", "rationale", "goal_alignment", "suggested_strike", "suggested_expiry", "max_risk"]
                },
                "description": "2-4 strategies covering the full spectrum: outright ownership if appropriate, income overlay strategies, and/or pure options plays. Investor is open to buying shares outright and layering options for income. Use actual strikes from the options chain."
            },
            "portfolio_diversification": {
                "type": "object",
                "properties": {
                    "score_before": {
                        "type": "integer", "minimum": 0, "maximum": 100,
                        "description": "Estimated diversification score of the portfolio AS IT STANDS NOW, before adding this asset. Assess the existing holdings across asset classes, sectors, and geographies."
                    },
                    "score": {
                        "type": "integer", "minimum": 0, "maximum": 100,
                        "description": "Diversification score AFTER adding this asset: 0=highly concentrated, 100=well diversified"
                    },
                    "overexposed": {
                        "type": "array", "items": {"type": "string"},
                        "description": "Asset classes, sectors, or geographies where investor is already overexposed"
                    },
                    "correlation_note": {
                        "type": "string",
                        "description": "How this asset correlates with existing holdings (stocks, crypto, bullion, FI)"
                    },
                    "recommendation": {
                        "type": "string",
                        "description": "Specific diversification guidance — does adding this help or hurt balance?"
                    }
                },
                "required": ["score_before", "score", "overexposed", "correlation_note", "recommendation"]
            },
            "geopolitical_risks": {
                "type": "array", "items": {"type": "string"},
                "description": "2-3 specific geopolitical risks relevant to this asset or sector"
            },
            "key_risks": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "risk":  {"type": "string", "description": "Description of the risk"},
                        "score": {"type": "integer", "minimum": 1, "maximum": 10, "description": "Severity: 1=negligible, 5=moderate, 10=critical/near-term"}
                    },
                    "required": ["risk", "score"]
                },
                "description": "3-5 key risks to the thesis, each with a severity score 1-10"
            },
            "sector_comparison": {
                "type": "object",
                "description": "Only populate if investor already holds one or more stocks in the same sector as this asset. Omit entirely if no same-sector holdings.",
                "properties": {
                    "competing_holdings": {
                        "type": "array", "items": {"type": "string"},
                        "description": "Tickers already in portfolio from the same sector"
                    },
                    "assessment": {
                        "type": "string",
                        "description": "Detailed comparison: does adding this alongside existing holdings make sense, or should they consider switching? Include specific reasoning about each holding."
                    },
                    "verdict": {
                        "type": "string", "enum": ["ADD", "SWITCH", "HOLD_EXISTING", "COMPLEMENT"],
                        "description": "ADD=buy this in addition to existing; SWITCH=replace existing with this; HOLD_EXISTING=stick with what they have; COMPLEMENT=adds meaningful differentiation despite same sector"
                    }
                },
                "required": ["competing_holdings", "assessment", "verdict"]
            },
            "catalysts": {
                "type": "array", "items": {"type": "string"},
                "description": "2-3 upcoming catalysts"
            },
            "action_plan": {
                "type": "string",
                "description": "Specific, actionable next steps for this investor"
            }
        },
        "required": [
            "recommendation", "confidence", "summary",
            "price_targets", "return_potential", "industry_pe", "fundamental_score",
            "fundamental_highlights", "fundamental_concerns",
            "macro_tailwinds", "macro_headwinds", "technical_note",
            "portfolio_fit", "portfolio_diversification", "geopolitical_risks",
            "options_ownership_slider", "options_ownership_rationale", "options_strategies",
            "key_risks", "catalysts", "action_plan"
        ]
    }
}


def run_claude_analysis(market_data, portfolio, asset_type):
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    today  = datetime.date.today().isoformat()
    ticker = market_data["ticker"]

    port_lines = []
    if portfolio.get("stocks"):
        stock_summary = ", ".join(
            f"{s['ticker']}({s['qty']:.0f}@${s['avg_cost']:.0f})"
            for s in portfolio["stocks"] if s["ticker"]
        )
        port_lines.append(f"Stocks ({len(portfolio['stocks'])} positions): {stock_summary[:300]}")
    if portfolio.get("options"):
        open_opts = [o for o in portfolio["options"] if o.get("is_open")]
        if open_opts:
            port_lines.append("Open options: " + "; ".join(
                f"{o['ticker']} {o['type']} {o['event']} {o['strike']} {o['expiry']}"
                for o in open_opts[:10]
            ))
    if portfolio.get("crypto"):
        crypto_summary = ", ".join(
            f"{c['ticker']}({c['qty']:.4f}@${c['avg_cost']:.0f})"
            for c in portfolio["crypto"][:5] if c["ticker"]
        )
        port_lines.append(f"Crypto ({len(portfolio['crypto'])} positions): {crypto_summary}")
    if portfolio.get("bullion"):
        bullion_summary = ", ".join(
            f"{b['metal']}({b['oz']:.1f}oz)"
            for b in portfolio["bullion"][:5] if b["metal"]
        )
        port_lines.append(f"Bullion: {bullion_summary}")
    if portfolio.get("futures"):
        port_lines.append("Futures: " + ", ".join(
            f"{f['ticker']}({f['qty']:.0f})" for f in portfolio["futures"][:5] if f["ticker"]
        ))
    if portfolio.get("fixed_income"):
        fi_total = sum(f["value"] for f in portfolio["fixed_income"])
        port_lines.append(f"Fixed income ({len(portfolio['fixed_income'])} positions, ~${fi_total:,.0f} total)")

    already_holds     = any(s.get("ticker","").upper() == ticker for s in portfolio.get("stocks",[]))
    has_options_on_it = any(o.get("ticker","").upper() == ticker for o in portfolio.get("options",[]))

    def pct(v):
        return f"{v*100:.1f}%" if v is not None else "N/A"

    prompt = f"""You are a personal investment advisor. Today is {today}.

## Investor Profile
- Horizon: {INVESTOR_PROFILE['horizon']}
- Target annual return: {INVESTOR_PROFILE['target_return']}
- Risk appetite: {INVESTOR_PROFILE['risk_appetite']}

## Current Portfolio
{chr(10).join(port_lines) if port_lines else "No portfolio data available."}
Already holds {ticker}: {"YES" if already_holds else "NO"}
Has open options on {ticker}: {"YES" if has_options_on_it else "NO"}
Total estimated invested capital (cost basis): ~${portfolio.get("total_invested", 0):,.0f}

## Asset: {ticker} — {market_data.get("name","")}
Type: {asset_type} | Sector: {market_data.get("sector","")} / {market_data.get("industry","")}

### Price & Momentum
Current: ${market_data.get("price",0):.2f} ({market_data.get("day_change_pct",0):+.2f}% today)
52w High: ${market_data.get("52w_high",0):.2f} | 52w Low: ${market_data.get("52w_low",0):.2f}
1-year return: {market_data.get("1y_return_pct","N/A")}%
Beta: {market_data.get("beta","N/A")} | Above 200-day MA: {market_data.get("above_ma200","N/A")}
200-day MA: {market_data.get("ma200","N/A")}

### Valuation
Trailing P/E: {market_data.get("pe_trailing","N/A")} | Forward P/E: {market_data.get("pe_forward","N/A")}
PEG: {market_data.get("peg","N/A")} | P/S: {market_data.get("ps","N/A")} | EV/EBITDA: {market_data.get("ev_ebitda","N/A")}

### Fundamentals
Revenue growth: {pct(market_data.get("rev_growth"))} | Earnings growth: {pct(market_data.get("earnings_growth"))}
Gross margin: {pct(market_data.get("gross_margin"))} | Op margin: {pct(market_data.get("op_margin"))}
ROE: {pct(market_data.get("roe"))} | D/E: {market_data.get("de_ratio","N/A")} | FCF: ${market_data.get("fcf_b",0):.2f}B

### Analyst Consensus
Rating: {market_data.get("analyst_rating","N/A")} ({market_data.get("num_analysts",0)} analysts)
Targets — Low: ${market_data.get("target_low","N/A")} | Mean: ${market_data.get("target_mean","N/A")} | High: ${market_data.get("target_high","N/A")}

### Available Options Contracts
{json.dumps(market_data.get("options_chain",[]), indent=2)}

### Business Description
{market_data.get("description","")}

## Current Macro & Geopolitical Context
- Fed: rates elevated, data-dependent, late-2026 pivot expected
- Broad tariffs since April 2025; domestic-focused companies favored over export-heavy ones
- Inflation cooling but sticky; resilient consumer spending
- Leading sectors: Financials, Healthcare, Technology, Industrials
- Geopolitical: US-China tech/trade tensions ongoing; Taiwan Strait risk relevant to semis/tech
- Geopolitical: Middle East instability affecting energy prices and supply chains
- Geopolitical: Russia-Ukraine war — European energy costs, defense spending elevated
- Geopolitical: De-globalization trend driving reshoring, benefiting US industrials and materials
- USD strength pressuring multinationals with large overseas revenue

## Your Analysis Must Be Personalized
- **Goal alignment**: For every recommendation and options strategy, explicitly state whether/how it contributes to the investor's 20–30% annual return target given their 3-month to 3-year horizon.
- **Portfolio context**: Reference the investor's existing positions when relevant. The investor holds stocks, options, crypto, bullion, futures, and fixed income — consider the FULL portfolio, not just equities.
- **Diversification**: Assess whether adding this asset increases or reduces portfolio diversification. Flag overexposure to any sector, asset class, or geographic region given what the investor already holds. Bullion and fixed income provide stability — consider how this asset correlates with those. Crypto adds high-risk high-reward exposure — flag if equities + crypto concentration is too high.
- **Risk calibration**: Medium risk appetite — favor defined-risk strategies over uncapped downside.
- **Geopolitical risks**: Include relevant geopolitical factors in macro headwinds/tailwinds and the geopolitical_risks field.
- **Price target probabilities**: For each price target (3M, 1Y, 3Y) provide a probability of hitting that target within the timeframe (HIGH/MEDIUM/LOW). Factor in: current broad market trend (risk-on vs risk-off, sector rotation, overall bull/bear conditions), stock-specific momentum (MA200 position, recent price action), implied volatility, analyst sentiment and consensus targets, and how far the target is from current price. A HIGH probability means all or most factors align; LOW means meaningful headwinds or a large gap to target.
- **Ownership vs Options — use this 8-factor framework to set options_ownership_slider**. Score each factor then average:
  1. IV level: High IV (>40%) = options expensive → push toward 0 (own stock). Low IV (<20%) = options cheap → push toward 100.
  2. Conviction: BUY + HIGH confidence → 0 (own it). WATCH → 50. AVOID → 100 (speculate only if at all).
  3. Stock price: >$300/share → capital efficiency favors options → push toward 100. <$100/share → ownership practical → push toward 0.
  4. Already holding: Yes + recommendation to add → 0 (buy more shares). Yes with income overlay → 50.
  5. Options chain liquidity: Tight bid-ask spreads + deep open interest → push toward 100. Wide spreads / thin OI → push toward 0.
  6. Dividend yield: Pays meaningful dividend (>1.5%) → must own stock → push hard toward 0. No dividend → neutral.
  7. Time horizon fit: Short-term catalyst (3M) → options leverage → push toward 100. Long-term conviction (3Y) → ownership compounds → push toward 0.
  8. Beta/volatility: High beta (>1.5) + uncertain direction → options limit downside → push toward 100. Stable stock (beta <0.8) → own it → push toward 0.
  Average the factor scores, round to nearest 5. Set options_ownership_rationale to the 2-3 most decisive factors in one sentence.
- **Position sizing in dollars**: The investor's total portfolio (cost basis) is ~${portfolio.get("total_invested", 0):,.0f}. Use suggested_allocation_pct to compute the implied dollar amount (allocation_pct/100 × total). Set options_capital_required to the estimated dollars needed to achieve equivalent upside exposure via options instead — use actual option prices from the chain (typically ATM call or LEAPS). This directly answers "how much to invest" and "stock vs options capital needed."
- **Diversification before/after**: Set score_before to your estimate of the portfolio's current diversification score WITHOUT this asset. Set score to what it becomes AFTER adding it. The difference tells the investor whether buying improves or worsens their balance.
- **Risk scoring**: Score each risk 1–10 (1=minor/unlikely, 5=moderate, 10=critical/imminent). Consider probability AND magnitude.
- **Sector comparison**: Look at the investor's stock holdings. If any are in the same sector as {ticker}, populate sector_comparison — should they add this alongside those holdings, switch to this, or complement? Omit entirely if no same-sector holdings.
- **Options strategies**: Choose the best strategy for the situation — CSP, CC, bull put spread, long call LEAPS, protective put, iron condor, straddle, outright purchase, or any other. Do NOT default to just CSP/CC. Use actual strikes and expiries from the options chain data above.
- **Summary**: Directly address whether this asset fits the investor's goals, diversification needs, and why.

Provide the full analysis using the provide_asset_analysis tool."""

    response = client.messages.create(
        model=MODEL,
        max_tokens=4096,
        tools=[ANALYSIS_TOOL],
        tool_choice={"type": "tool", "name": "provide_asset_analysis"},
        messages=[{"role": "user", "content": prompt}],
    )

    for block in response.content:
        if block.type == "tool_use" and block.name == "provide_asset_analysis":
            return block.input

    return {"error": "No analysis returned"}


# ── CORS ───────────────────────────────────────────────────────

def cors_headers():
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Account-Id",
    }


# ── HTTP handlers ──────────────────────────────────────────────

def handle_analyze(event):
    """POST /assets/hub/analyze — check S3 cache, or create async job."""
    user_id = get_user_id(event)
    if not user_id:
        return {"statusCode": 401, "headers": cors_headers(), "body": json.dumps({"error": "Unauthorized"})}

    try:
        body          = json.loads(event.get("body") or "{}")
        ticker        = str(body.get("ticker", "")).upper().strip()
        asset_type    = str(body.get("assetType", "stock")).lower().strip()
        force_refresh = bool(body.get("forceRefresh", False))

        if not ticker:
            return {"statusCode": 400, "headers": cors_headers(), "body": json.dumps({"error": "ticker is required"})}
        if asset_type not in ("stock", "options"):
            return {"statusCode": 400, "headers": cors_headers(), "body": json.dumps({"error": "assetType must be stock or options"})}

        # ── Cache check (skip if forceRefresh) ──────────────────
        if not force_refresh:
            cached = get_cached_report(user_id, ticker)
            if cached:
                # Create a job already marked done — frontend polling works unchanged
                job_id = create_job(user_id, ticker, asset_type)
                update_job(user_id, job_id, "done", result=cached)
                logger.info(f"Serving cached report: jobId={job_id} ticker={ticker}")
                return {
                    "statusCode": 202,
                    "headers": cors_headers(),
                    "body": json.dumps({"jobId": job_id, "cached": True,
                                        "cachedAt": cached.get("generated_at", "")}),
                }

        # ── No cache (or force refresh) — start async job ───────
        job_id = create_job(user_id, ticker, asset_type)
        logger.info(f"AssetHub job created: jobId={job_id} user={user_id} ticker={ticker} force={force_refresh}")

        _lambda.invoke(
            FunctionName=SELF_FUNCTION_NAME,
            InvocationType="Event",
            Payload=json.dumps({
                "jobId":     job_id,
                "userId":    user_id,
                "ticker":    ticker,
                "assetType": asset_type,
            }),
        )

        return {
            "statusCode": 202,
            "headers": cors_headers(),
            "body": json.dumps({"jobId": job_id, "cached": False}),
        }

    except Exception as e:
        logger.error(f"handle_analyze error: {e}", exc_info=True)
        return {"statusCode": 500, "headers": cors_headers(), "body": json.dumps({"error": "Failed to start analysis."})}


def handle_result(event, job_id):
    """GET /assets/hub/result/{jobId} — return job status/result."""
    user_id = get_user_id(event)
    if not user_id:
        return {"statusCode": 401, "headers": cors_headers(), "body": json.dumps({"error": "Unauthorized"})}

    if not job_id:
        return {"statusCode": 400, "headers": cors_headers(), "body": json.dumps({"error": "jobId required"})}

    try:
        job = get_job(user_id, job_id)
        if not job:
            return {"statusCode": 404, "headers": cors_headers(), "body": json.dumps({"error": "Job not found"})}

        status = job.get("status", "pending")

        if status == "done":
            result = json.loads(job.get("result", "{}"))
            return {
                "statusCode": 200,
                "headers": cors_headers(),
                "body": json.dumps({"status": "done", "result": result}),
            }
        if status == "error":
            return {
                "statusCode": 200,
                "headers": cors_headers(),
                "body": json.dumps({"status": "error", "error": job.get("errorMsg", "Analysis failed")}),
            }
        # pending
        return {
            "statusCode": 200,
            "headers": cors_headers(),
            "body": json.dumps({"status": "pending"}),
        }

    except Exception as e:
        logger.error(f"handle_result error: {e}", exc_info=True)
        return {"statusCode": 500, "headers": cors_headers(), "body": json.dumps({"error": "Failed to fetch result."})}


# ── List cached reports ────────────────────────────────────────

def handle_list_reports(event):
    """GET /assets/hub/reports — list S3 cached reports < 7 days old for the user."""
    user_id = get_user_id(event)
    if not user_id:
        return {"statusCode": 401, "headers": cors_headers(), "body": json.dumps({"error": "Unauthorized"})}

    if not REPORTS_BUCKET:
        return {"statusCode": 200, "headers": cors_headers(), "body": json.dumps({"reports": []})}

    try:
        prefix = f"{REPORTS_PREFIX}{user_id}/"
        resp   = _s3.list_objects_v2(Bucket=REPORTS_BUCKET, Prefix=prefix)

        now     = datetime.datetime.utcnow()
        reports = []

        for obj in resp.get("Contents", []):
            if obj.get("StorageClass") in ("GLACIER", "DEEP_ARCHIVE", "GLACIER_IR"):
                continue

            key      = obj["Key"]
            ticker   = key[len(prefix):].replace(".json", "").upper()
            modified = obj["LastModified"].replace(tzinfo=None)
            age_days = (now - modified).days

            if age_days < CACHE_MAX_AGE_DAYS:
                reports.append({
                    "ticker":       ticker,
                    "generated_at": modified.isoformat() + "Z",
                    "age_days":     age_days,
                    "size_kb":      round(obj["Size"] / 1024, 1),
                })

        reports.sort(key=lambda r: r["generated_at"], reverse=True)
        return {
            "statusCode": 200,
            "headers": cors_headers(),
            "body": json.dumps({"reports": reports}),
        }

    except Exception as e:
        logger.error(f"handle_list_reports error: {e}", exc_info=True)
        return {"statusCode": 500, "headers": cors_headers(), "body": json.dumps({"error": "Failed to list reports."})}


# ── Worker (direct Lambda invocation — no API GW timeout) ──────

def run_worker(payload):
    job_id     = payload["jobId"]
    user_id    = payload["userId"]
    ticker     = payload["ticker"]
    asset_type = payload["assetType"]

    logger.info(f"AssetHub worker start: jobId={job_id} ticker={ticker}")
    try:
        with ThreadPoolExecutor(max_workers=2) as ex:
            fut_market    = ex.submit(fetch_market_data, ticker, asset_type)
            fut_portfolio = ex.submit(fetch_portfolio, user_id)
            market_data   = fut_market.result()
            portfolio     = fut_portfolio.result()

        if not market_data.get("price"):
            update_job(user_id, job_id, "error",
                       error_msg=f"Could not fetch market data for '{ticker}'. Check the ticker symbol.")
            return

        analysis = run_claude_analysis(market_data, portfolio, asset_type)

        now_iso = datetime.datetime.utcnow().isoformat() + "Z"
        portfolio_invested = portfolio.get("total_invested", 0)
        alloc_pct = (analysis.get("portfolio_fit") or {}).get("suggested_allocation_pct") or 0
        allocation_dollars = round(portfolio_invested * alloc_pct / 100) if portfolio_invested and alloc_pct else 0

        result = {
            "ticker":         market_data["ticker"],
            "name":           market_data.get("name", ""),
            "price":          market_data.get("price", 0),
            "day_change_pct": market_data.get("day_change_pct", 0),
            "sector":         market_data.get("sector", ""),
            "market_cap_b":   market_data.get("market_cap_b", 0),
            "week52_high":    market_data.get("52w_high", 0),
            "week52_low":     market_data.get("52w_low", 0),
            "all_time_high":  market_data.get("all_time_high", 0),
            "analyst_target_mean":    market_data.get("target_mean") or 0,
            "pe_trailing":            market_data.get("pe_trailing"),
            "pe_forward":             market_data.get("pe_forward"),
            "portfolio_total_invested": portfolio_invested,
            "allocation_dollars":       allocation_dollars,
            "asset_type":     asset_type,
            "analyzed_at":    now_iso,
            "generated_at":   now_iso,   # used by S3 cache age check
            "analysis":       analysis,
        }
        update_job(user_id, job_id, "done", result=result)
        store_report(user_id, ticker, result)   # cache to S3 for 7 days
        logger.info(f"AssetHub worker done: jobId={job_id}")

    except Exception as e:
        logger.error(f"AssetHub worker error: jobId={job_id} {e}", exc_info=True)
        update_job(user_id, job_id, "error", error_msg="Analysis failed. Please try again.")


# ── Main handler ───────────────────────────────────────────────

def handler(event, context):
    # Worker mode: direct Lambda invocation (no requestContext from API GW)
    if "jobId" in event and "requestContext" not in event:
        run_worker(event)
        return

    # HTTP API mode
    method   = (event.get("requestContext", {}).get("http", {}).get("method") or "GET").upper()
    raw_path = event.get("rawPath", "")

    if method == "OPTIONS":
        return {"statusCode": 204, "headers": cors_headers(), "body": ""}

    if method == "POST" and raw_path.endswith("/analyze"):
        return handle_analyze(event)

    if method == "GET" and raw_path.endswith("/reports"):
        return handle_list_reports(event)

    if method == "GET" and "/result/" in raw_path:
        job_id = raw_path.split("/result/")[-1].strip("/")
        return handle_result(event, job_id)

    return {"statusCode": 404, "headers": cors_headers(), "body": json.dumps({"error": "Not found"})}
