"""
Wheel Scan Lambda — Handler
Runs the complete Wheel Strategy scan pipeline:
  1. Fetch S&P 500 + 400 tickers
  2. Parallel-fetch fundamentals via yfinance
  3. Apply hard filters
  4. Fetch options chains for qualifying stocks
  5. Score stocks algorithmically
  6. Call Claude (claude-sonnet-4-6) for macro overlay + trade thesis writing
  7. Write JSON report to S3 (AnalyticsBucket / WheelReports/)

Triggers:
  - EventBridge daily schedule (6:30am ET, weekdays)
  - HTTP POST /wheel/scan/trigger (async via WheelScanReadFunction)
"""

import json
import logging
import os
import datetime
import boto3
import anthropic

from tools import (
    get_full_universe,
    batch_fetch_fundamentals,
    apply_hard_filters,
    batch_fetch_options,
    score_stock_fundamentals,
)

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

ANALYTICS_BUCKET = os.environ.get("ANALYTICS_BUCKET", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MODEL = "claude-sonnet-4-6"
WHEEL_PREFIX = "WheelReports/"

s3 = boto3.client("s3")


# ── Claude tool definitions ────────────────────────────────────

CLAUDE_TOOLS = [
    {
        "name": "apply_macro_scores",
        "description": (
            "Apply macro/geopolitical adjustment scores to each stock. "
            "Score adjustment range: +10 (strong tailwind) to -20 (severe headwind). "
            "Consider: Fed rate stance, tariff exposure, sector cyclicality, "
            "geopolitical risk, and current macro cycle phase."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "assessments": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "ticker":          {"type": "string"},
                            "macro_adj":       {"type": "integer", "minimum": -20, "maximum": 10},
                            "macro_summary":   {"type": "string", "description": "1-2 sentence macro risk/tailwind summary"},
                            "risk_flags":      {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["ticker", "macro_adj", "macro_summary"],
                    }
                }
            },
            "required": ["assessments"]
        }
    },
    {
        "name": "write_trade_theses",
        "description": (
            "Write trade theses and assign final PROCEED/WATCH/SKIP recommendation for each stock. "
            "PROCEED = adjusted score >= 75, strong fundamentals, liquid options, clear thesis. "
            "WATCH = adjusted score 55-74 or good fundamentals but elevated risk. "
            "SKIP = adjusted score < 55 or fundamental/macro concerns."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "theses": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "ticker":         {"type": "string"},
                            "recommendation": {"type": "string", "enum": ["PROCEED", "WATCH", "SKIP"]},
                            "thesis":         {"type": "string", "description": "2-3 sentence trade thesis"},
                            "risk_flags":     {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["ticker", "recommendation", "thesis"],
                    }
                }
            },
            "required": ["theses"]
        }
    },
]


# ── Claude agentic loop ────────────────────────────────────────

def run_claude_analysis(stocks_with_options, fund_scores):
    """
    Call Claude with stock data to get:
    - Macro adjustment scores per stock
    - Trade theses and PROCEED/WATCH/SKIP recommendations
    Returns dict keyed by ticker with macro + thesis data.
    """
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    # Build compact summary for Claude context (avoid huge payloads)
    stock_summaries = []
    for s in stocks_with_options:
        t = s["ticker"]
        opt = s.get("best_option", {})
        stock_summaries.append({
            "ticker":       t,
            "name":         s["name"],
            "sector":       s["sector"],
            "price":        s["price"],
            "market_cap_b": s["market_cap_b"],
            "rev_growth":   s["rev_growth"],
            "gross_margin": s["gross_margin"],
            "op_margin":    s["op_margin"],
            "de_ratio":     s["de_ratio"],
            "roe":          s["roe"],
            "eps_growth":   s["eps_growth"],
            "fcf_b":        round(s["fcf"] / 1e9, 2),
            "fund_score":   fund_scores.get(t, 0),
            "option": {
                "expiry":    opt.get("expiry", ""),
                "dte":       opt.get("dte", 0),
                "strike":    opt.get("strike", 0),
                "pct_otm":   opt.get("pct_otm", 0),
                "mid":       opt.get("mid", 0),
                "iv":        opt.get("iv", 0),
                "delta":     opt.get("delta", 0),
                "ann_yield": opt.get("ann_yield", 0),
                "breakeven": opt.get("breakeven", 0),
                "oi":        opt.get("open_interest", 0),
            } if opt else None,
        })

    today = datetime.date.today().isoformat()
    prompt = f"""You are a Wheel Strategy research analyst. Today is {today}.

I have pre-screened {len(stock_summaries)} stocks that passed fundamental hard filters.
Your job is to:
1. Apply macro/geopolitical adjustment scores to each stock (tool: apply_macro_scores)
2. Write trade theses and assign PROCEED/WATCH/SKIP recommendations (tool: write_trade_theses)

Current macro context to consider:
- Fed policy: rates elevated, data-dependent, pivot expectations for late 2026
- Tariff regime: broad tariffs in effect since April 2025; domestic-focused companies favored
- Inflation: cooling but sticky services inflation
- Growth cycle: moderate expansion, consumer spending resilient
- Leading sectors: Financials (rate sensitivity improving), Healthcare (defensive), Tech (AI tailwind), Industrials (reshoring)
- Key risks: trade war escalation, recession risk if consumer cracks, geopolitical tensions

Stock data:
{json.dumps(stock_summaries, indent=2)}

Use the tools provided. First call apply_macro_scores for all stocks, then call write_trade_theses for all stocks."""

    messages = [{"role": "user", "content": prompt}]
    macro_data = {}
    thesis_data = {}

    for _ in range(10):  # max iterations
        response = client.messages.create(
            model=MODEL,
            max_tokens=8192,
            tools=CLAUDE_TOOLS,
            messages=messages,
        )

        # Collect tool uses
        tool_calls = [b for b in response.content if b.type == "tool_use"]

        if not tool_calls:
            break

        tool_results = []
        for tc in tool_calls:
            result_content = ""
            if tc.name == "apply_macro_scores":
                for a in tc.input.get("assessments", []):
                    macro_data[a["ticker"]] = {
                        "macro_adj":     a["macro_adj"],
                        "macro_summary": a["macro_summary"],
                        "risk_flags":    a.get("risk_flags", []),
                    }
                result_content = f"Applied macro scores for {len(tc.input.get('assessments', []))} stocks."

            elif tc.name == "write_trade_theses":
                for t in tc.input.get("theses", []):
                    thesis_data[t["ticker"]] = {
                        "recommendation": t["recommendation"],
                        "thesis":         t["thesis"],
                        "risk_flags":     t.get("risk_flags", []),
                    }
                result_content = f"Wrote theses for {len(tc.input.get('theses', []))} stocks."

            tool_results.append({
                "type":        "tool_result",
                "tool_use_id": tc.id,
                "content":     result_content,
            })

        messages.append({"role": "assistant", "content": response.content})
        messages.append({"role": "user",      "content": tool_results})

        if response.stop_reason == "end_turn":
            break

    return macro_data, thesis_data


# ── Report builder ─────────────────────────────────────────────

def build_report(stocks_with_options, fund_scores, macro_data, thesis_data, scan_id, started_at):
    """Assemble the final JSON report."""
    stocks_out = []
    for s in stocks_with_options:
        t = s["ticker"]
        adj_score = fund_scores.get(t, 0) + macro_data.get(t, {}).get("macro_adj", 0)
        rec = thesis_data.get(t, {}).get("recommendation", "WATCH")
        stocks_out.append({
            "ticker":         t,
            "name":           s["name"],
            "sector":         s["sector"],
            "price":          s["price"],
            "market_cap_b":   s["market_cap_b"],
            "rev_growth":     s["rev_growth"],
            "gross_margin":   s["gross_margin"],
            "op_margin":      s["op_margin"],
            "de_ratio":       s["de_ratio"],
            "roe":            s["roe"],
            "eps_growth":     s["eps_growth"],
            "fcf_b":          round(s["fcf"] / 1e9, 2),
            "fund_score":     fund_scores.get(t, 0),
            "macro_adj":      macro_data.get(t, {}).get("macro_adj", 0),
            "macro_summary":  macro_data.get(t, {}).get("macro_summary", ""),
            "adj_score":      adj_score,
            "recommendation": rec,
            "thesis":         thesis_data.get(t, {}).get("thesis", ""),
            "risk_flags":     thesis_data.get(t, {}).get("risk_flags", []) +
                              macro_data.get(t, {}).get("risk_flags", []),
            "option":         s.get("best_option"),
        })

    stocks_out.sort(key=lambda x: x["adj_score"], reverse=True)

    proceed = [s for s in stocks_out if s["recommendation"] == "PROCEED"]
    watch   = [s for s in stocks_out if s["recommendation"] == "WATCH"]
    skip    = [s for s in stocks_out if s["recommendation"] == "SKIP"]

    completed_at = datetime.datetime.utcnow().isoformat() + "Z"
    duration_s   = int((datetime.datetime.utcnow() - datetime.datetime.fromisoformat(started_at.rstrip("Z"))).total_seconds())

    return {
        "scan_id":      scan_id,
        "scan_date":    scan_id,
        "started_at":   started_at,
        "completed_at": completed_at,
        "duration_s":   duration_s,
        "universe_size": len(stocks_with_options),
        "proceed_count": len(proceed),
        "watch_count":   len(watch),
        "skip_count":    len(skip),
        "macro_context": {
            "fed_policy":     "Rates elevated, data-dependent. Late-2026 pivot expected.",
            "tariff_regime":  "Broad tariffs in effect since April 2025. Domestic-focused companies favored.",
            "inflation":      "Cooling but sticky. Services inflation remains above target.",
            "leading_sectors": ["Financials", "Healthcare", "Technology", "Industrials"],
        },
        "stocks": stocks_out,
    }


# ── S3 write helpers ───────────────────────────────────────────

def write_to_s3(key, data):
    s3.put_object(
        Bucket=ANALYTICS_BUCKET,
        Key=key,
        Body=json.dumps(data, indent=2),
        ContentType="application/json",
    )
    logger.info(f"Wrote s3://{ANALYTICS_BUCKET}/{key}")


def update_index(scan_id, report):
    """Update WheelReports/index.json with the new scan entry."""
    index_key = WHEEL_PREFIX + "index.json"
    try:
        obj = s3.get_object(Bucket=ANALYTICS_BUCKET, Key=index_key)
        index = json.loads(obj["Body"].read())
    except s3.exceptions.NoSuchKey:
        index = {"scans": []}
    except Exception:
        index = {"scans": []}

    # Prepend new entry
    entry = {
        "scan_id":       scan_id,
        "scan_date":     report["scan_date"],
        "completed_at":  report["completed_at"],
        "universe_size": report["universe_size"],
        "proceed_count": report["proceed_count"],
        "watch_count":   report["watch_count"],
        "skip_count":    report["skip_count"],
        "duration_s":    report["duration_s"],
    }
    scans = [s for s in index["scans"] if s["scan_id"] != scan_id]  # remove if re-run
    scans.insert(0, entry)
    index["scans"] = scans[:90]  # keep last 90 days

    write_to_s3(index_key, index)


# ── Lambda handler ─────────────────────────────────────────────

def handler(event, context):
    started_at = datetime.datetime.utcnow().isoformat() + "Z"
    scan_id    = datetime.date.today().isoformat()

    logger.info(f"Wheel scan started. scan_id={scan_id}")

    # 1. Universe
    tickers = get_full_universe()
    if not tickers:
        logger.error("Failed to fetch ticker universe")
        return {"statusCode": 500, "body": "Failed to fetch ticker universe"}

    logger.info(f"Fetching fundamentals for {len(tickers)} tickers...")

    # 2. Parallel fundamentals (with generous concurrency; yfinance is IO-bound)
    all_stocks = batch_fetch_fundamentals(tickers, max_workers=30)
    logger.info(f"Fetched fundamentals for {len(all_stocks)} tickers")

    # 3. Hard filter
    filtered = apply_hard_filters(all_stocks)
    logger.info(f"After hard filter: {len(filtered)} stocks qualify")

    # 4. Score and sort; take top 100 for options screening
    for s in filtered:
        s["_fund_score"] = score_stock_fundamentals(s)
    filtered.sort(key=lambda x: x["_fund_score"], reverse=True)
    top_candidates = filtered[:100]

    # 5. Fetch options chains in parallel
    logger.info(f"Fetching options for top {len(top_candidates)} candidates...")
    stocks_with_options = batch_fetch_options(top_candidates, max_workers=15)
    logger.info(f"Options data found for {len(stocks_with_options)} stocks")

    if not stocks_with_options:
        logger.warning("No stocks with valid options setups found")
        stocks_with_options = top_candidates[:30]  # fallback: include top fundamentals without options

    # Build fund_scores map
    fund_scores = {s["ticker"]: s["_fund_score"] for s in (stocks_with_options + top_candidates)}

    # 6. Claude analysis (macro + thesis) — pass top 50 with options to keep context manageable
    analysis_set = stocks_with_options[:50]
    logger.info(f"Running Claude analysis on {len(analysis_set)} stocks...")
    macro_data, thesis_data = run_claude_analysis(analysis_set, fund_scores)

    # 7. Build and write report
    report = build_report(analysis_set, fund_scores, macro_data, thesis_data, scan_id, started_at)

    daily_key  = WHEEL_PREFIX + f"{scan_id}.json"
    latest_key = WHEEL_PREFIX + "latest.json"

    write_to_s3(daily_key,  report)
    write_to_s3(latest_key, report)
    update_index(scan_id, report)

    logger.info(
        f"Scan complete. PROCEED={report['proceed_count']} "
        f"WATCH={report['watch_count']} SKIP={report['skip_count']}"
    )

    return {
        "statusCode": 200,
        "body": json.dumps({
            "scan_id":       scan_id,
            "proceed_count": report["proceed_count"],
            "watch_count":   report["watch_count"],
            "skip_count":    report["skip_count"],
        })
    }
