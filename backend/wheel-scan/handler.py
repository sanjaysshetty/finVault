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

ANALYTICS_BUCKET      = os.environ.get("ANALYTICS_BUCKET", "")
ANTHROPIC_API_KEY     = os.environ.get("ANTHROPIC_API_KEY", "")
WHEEL_SCAN_ACCOUNT_ID = os.environ.get("WHEEL_SCAN_ACCOUNT_ID", "")  # userId/accountId for scheduled runs
MODEL        = "claude-sonnet-4-6"
WHEEL_PREFIX = "WheelReports/"

s3 = boto3.client("s3")


# ── Claude tool definitions ────────────────────────────────────

# Server-side web search tool (Anthropic-hosted, no client execution needed)
WEB_SEARCH_TOOL = {"type": "web_search_20250305", "name": "web_search"}

# Tool to record synthesized macro context
MACRO_SYNTHESIZE_TOOL = {
    "name": "synthesize_macro_context",
    "description": (
        "Record the synthesized current macro context for the Wheel Strategy scan. "
        "Call this after researching current conditions via web search."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "fed_policy":      {"type": "string", "description": "Current Fed rate stance and forward guidance"},
            "tariff_regime":   {"type": "string", "description": "Active tariff/trade environment and impacted sectors"},
            "inflation":       {"type": "string", "description": "Latest CPI/PCE readings and trend"},
            "growth_cycle":    {"type": "string", "description": "GDP, employment, consumer spending — current phase"},
            "leading_sectors": {
                "type": "array", "items": {"type": "string"},
                "description": "Sectors with tailwinds for covered-call / CSP premium selling"
            },
            "key_risks": {
                "type": "array", "items": {"type": "string"},
                "description": "Top macro risks that could spike volatility"
            },
            "summary_bullets": {
                "type": "array", "items": {"type": "string"},
                "description": "5-7 terse bullet points covering the full macro picture for stock scoring"
            },
        },
        "required": ["fed_policy", "tariff_regime", "inflation", "growth_cycle",
                     "leading_sectors", "key_risks", "summary_bullets"]
    }
}

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


# ── Macro context synthesis ────────────────────────────────────

def get_dynamic_macro_context():
    """
    Pre-pass Claude call: web-search current macro conditions and return a structured
    context dict that is both injected into the stock-scoring prompt and stored in the
    report JSON (so the UI always shows the context that actually drove this scan).
    Returns None on failure; caller falls back gracefully.
    """
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    today = datetime.date.today().isoformat()

    prompt = (
        f"Today is {today}. You are preparing macro context for a Wheel Options Strategy screener "
        f"that sells covered calls and cash-secured puts on large-cap US equities.\n\n"
        "Use web search to get current data on:\n"
        "1. Federal Reserve: current federal funds rate, most recent FOMC decision, next meeting, rate path expectations\n"
        "2. Inflation: latest CPI and PCE readings, trend direction\n"
        "3. Economic growth: recent GDP print, unemployment rate, consumer sentiment\n"
        "4. Trade/tariff policy: major active tariffs, recently affected sectors\n"
        "5. Sector outlook: tailwinds and headwinds for premium selling strategies\n"
        "6. Key macro risks that could spike implied volatility\n\n"
        "Search for the latest data, then call synthesize_macro_context with a structured synthesis."
    )

    messages = [{"role": "user", "content": prompt}]

    for _ in range(10):
        response = client.messages.create(
            model=MODEL,
            max_tokens=2048,
            tools=[WEB_SEARCH_TOOL, MACRO_SYNTHESIZE_TOOL],
            messages=messages,
        )

        # Check if Claude called our synthesis tool
        for block in response.content:
            if getattr(block, "type", "") == "tool_use" and block.name == "synthesize_macro_context":
                logger.info("Dynamic macro context synthesized via web search")
                return block.input

        if response.stop_reason == "end_turn":
            break

        # Add assistant turn (includes web_search_tool_use + web_search_tool_result blocks — server-side)
        messages.append({"role": "assistant", "content": response.content})

        # Return tool_result only for our custom tool (web_search is handled server-side)
        tool_results = []
        for block in response.content:
            if getattr(block, "type", "") == "tool_use" and block.name == "synthesize_macro_context":
                tool_results.append({
                    "type":        "tool_result",
                    "tool_use_id": block.id,
                    "content":     "Context recorded.",
                })

        if tool_results:
            messages.append({"role": "user", "content": tool_results})

    logger.warning("Macro context synthesis failed — stock scoring will proceed without live macro context")
    return None


# ── Claude agentic loop ────────────────────────────────────────

def run_claude_analysis(stocks_with_options, fund_scores, macro_context=None):
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

    # Build the macro context block from dynamic synthesis (or fallback note)
    if macro_context and macro_context.get("summary_bullets"):
        macro_lines = "\n".join(f"- {b}" for b in macro_context["summary_bullets"])
    else:
        macro_lines = (
            "- Macro context unavailable for this run; apply general market knowledge.\n"
            "- Treat uncertainty as a moderate headwind; prefer defensive sectors."
        )

    prompt = f"""You are a Wheel Strategy research analyst. Today is {today}.

I have pre-screened {len(stock_summaries)} stocks that passed fundamental hard filters.
Your job is to:
1. Apply macro/geopolitical adjustment scores to each stock (tool: apply_macro_scores)
2. Write trade theses and assign PROCEED/WATCH/SKIP recommendations (tool: write_trade_theses)

Current macro context (researched as of {today}):
{macro_lines}

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

def build_report(stocks_with_options, fund_scores, macro_data, thesis_data, scan_id, started_at, macro_context=None):
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
            "fed_policy":      (macro_context or {}).get("fed_policy", ""),
            "tariff_regime":   (macro_context or {}).get("tariff_regime", ""),
            "inflation":       (macro_context or {}).get("inflation", ""),
            "growth_cycle":    (macro_context or {}).get("growth_cycle", ""),
            "leading_sectors": (macro_context or {}).get("leading_sectors", []),
            "key_risks":       (macro_context or {}).get("key_risks", []),
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


def update_index(scan_id, report, prefix):
    """Update {prefix}index.json with the new scan entry."""
    index_key = prefix + "index.json"
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

    # Resolve account: manual API trigger passes accountId in event payload;
    # scheduled EventBridge runs fall back to WHEEL_SCAN_ACCOUNT_ID env var.
    account_id = ((event or {}).get("accountId", "") or WHEEL_SCAN_ACCOUNT_ID).strip()
    if not account_id:
        logger.error("No accountId in event and WHEEL_SCAN_ACCOUNT_ID not configured — cannot determine output path")
        return {"statusCode": 500, "body": "WHEEL_SCAN_ACCOUNT_ID not configured"}
    prefix = WHEEL_PREFIX + account_id + "/"

    logger.info(f"Wheel scan started. scan_id={scan_id} prefix={prefix}")

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

    # 6a. Synthesize live macro context via Claude + web search
    logger.info("Synthesizing macro context via web search...")
    macro_context = get_dynamic_macro_context()

    # 6b. Claude analysis (macro + thesis) — pass top 50 with options to keep context manageable
    analysis_set = stocks_with_options[:50]
    logger.info(f"Running Claude analysis on {len(analysis_set)} stocks...")
    macro_data, thesis_data = run_claude_analysis(analysis_set, fund_scores, macro_context)

    # 7. Build and write report
    report = build_report(analysis_set, fund_scores, macro_data, thesis_data, scan_id, started_at, macro_context)

    daily_key  = prefix + f"{scan_id}.json"
    latest_key = prefix + "latest.json"

    write_to_s3(daily_key,  report)
    write_to_s3(latest_key, report)
    update_index(scan_id, report, prefix)

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
