"""
Opportunity Engine Lambda — Handler.

Pipeline:
  1. Fetch S&P 500 + 400 ticker universe, fundamentals, hard filter, score
     (prefilter.py — relocated/generalized from wheel-scan/tools.py).
  2. Build Tower 1 context once for the account (finvault_agent_core.tower1
     — shared with Deep Dive, which needs the identical snapshot) — reused
     by every candidate's Tower 2 run.
  3. For the top-N shortlisted candidates, run a Tower 2 AgentLoop
     concurrently (ThreadPoolExecutor — each run is I/O-bound, waiting on
     Claude/MCP calls, and 20-25 sequential runs would risk Lambda's
     900s hard timeout; concurrency keeps total wall-clock well under it).
  4. Persist each candidate's write_ranked_recommendation call into
     AgentRecommendationsTable.

Triggers:
  - EventBridge weekly schedule (disabled by default — same posture as
    wheel-scan's own schedule, which is also DISABLED, until verified)
  - Async Lambda invoke from OpportunityEngineReadFunction's
    POST /research/opportunities/trigger
"""

import concurrent.futures
import datetime
import logging
import os

import boto3
from finvault_agent_core import get_secret
from finvault_agent_core.agent_loop import AgentLoop
from finvault_agent_core.robinhood_mcp import RobinhoodMcpClient

import prefilter
from finvault_agent_core import build_tower1_context
from finvault_agent_core import recommendations_repo
from tools import WEB_SEARCH_TOOL, build_robinhood_mcp_server_config, build_tower2_tools

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

FIN_ASSETS_TABLE = os.environ.get("FIN_ASSETS_TABLE", "")
FIN_ACCOUNTS_TABLE = os.environ.get("FIN_ACCOUNTS_TABLE", "")
AGENT_RECOMMENDATIONS_TABLE = os.environ.get("AGENT_RECOMMENDATIONS_TABLE", "")
OPPORTUNITY_ENGINE_ACCOUNT_ID = os.environ.get("OPPORTUNITY_ENGINE_ACCOUNT_ID", "")

# Top-N candidates that get the full agentic Tower 2 pass. Each candidate
# can trigger several MCP round-trips (option chains, fundamentals,
# earnings) -- wheel-scan's existing ~100-candidate pass would blow both
# cost and the per-run iteration cap if ported as-is; the plan's own
# cost-control note (§6.2) narrows this to the shortlist stage only.
SHORTLIST_SIZE = 25
TOWER2_MAX_WORKERS = 8
TOWER2_MAX_ITERATIONS = 10
TOWER2_DEADLINE_SECONDS = 180.0

_ddb = boto3.resource("dynamodb")
_assets_table = _ddb.Table(FIN_ASSETS_TABLE) if FIN_ASSETS_TABLE else None
_accounts_table = _ddb.Table(FIN_ACCOUNTS_TABLE) if FIN_ACCOUNTS_TABLE else None
_recommendations_table = _ddb.Table(AGENT_RECOMMENDATIONS_TABLE) if AGENT_RECOMMENDATIONS_TABLE else None

with open(os.path.join(os.path.dirname(__file__), "prompts", "tower2_ranking.md")) as f:
    TOWER2_SYSTEM_PROMPT = f.read()


def _robinhood_access_token():
    """Returns None (not an exception) if the token isn't available yet --
    callers degrade to running Tower 2 without the MCP connector rather
    than failing the whole batch, since finVault's own Robinhood OAuth
    grant hasn't been set up yet (separate, not-yet-completed step)."""
    try:
        return get_secret("/finvault/robinhood/mcp-access-token")
    except Exception as e:
        logger.warning(f"Robinhood access token unavailable: {e}")
        return None


def run_tower2_for_candidate(candidate, tower1_context, mcp_servers):
    """Runs one candidate's Tower 2 AgentLoop and returns the captured
    recommendation dict, or None if the model never successfully called
    write_ranked_recommendation (e.g. it ran out of iterations, or
    genuinely found nothing worth recommending and just ended the turn)."""
    state = {"last_scenario_result": None, "captured_recommendation": None}
    tools = build_tower2_tools(state)

    loop = AgentLoop(
        system_prompt=TOWER2_SYSTEM_PROMPT,
        tools=tools,
        server_tools=[WEB_SEARCH_TOOL],
        mcp_servers=mcp_servers,
        max_iterations=TOWER2_MAX_ITERATIONS,
        deadline_seconds=TOWER2_DEADLINE_SECONDS,
    )

    user_message = (
        f"Candidate: {candidate['ticker']} ({candidate['name']}), sector: {candidate['sector']}.\n\n"
        f"Fundamental prescreen data (already passed hard filters):\n"
        f"- Price: ${candidate['price']}\n"
        f"- Market cap: ${candidate['market_cap_b']}B\n"
        f"- Revenue growth: {candidate['rev_growth']}%\n"
        f"- Gross margin: {candidate['gross_margin']}%\n"
        f"- Debt/Equity: {candidate['de_ratio']}\n"
        f"- ROE: {candidate['roe']}%\n"
        f"- EPS growth: {candidate['eps_growth']}%\n"
        f"- Fundamental score (0-100): {candidate['_fund_score']}\n\n"
        f"Tower 1 — investor's portfolio and risk context:\n"
        f"{tower1_context}\n\n"
        f"Research this candidate and write your ranked recommendation."
    )

    try:
        result = loop.run([{"role": "user", "content": user_message}], request_id=f"oe-{candidate['ticker']}")
    except Exception as e:
        logger.error(f"Tower 2 run failed for {candidate['ticker']}: {e}")
        return None

    if result.status != "done":
        logger.warning(f"Tower 2 run for {candidate['ticker']} ended with status={result.status}, not done")

    return state.get("captured_recommendation")


def persist_recommendation(account_id, candidate, tower1_context, captured):
    return recommendations_repo.put_recommendation(
        _recommendations_table,
        account_id,
        ticker=candidate["ticker"],
        strategy_type=captured["strategy_type"],
        strategy_detail=captured["legs"],
        tower1_context=tower1_context,
        tower2_research={
            "portfolio_fit_rationale": captured["portfolio_fit_rationale"],
            "market_rationale": captured["market_rationale"],
            "scenario_output": captured["scenario_output"],
        },
        rationale=f"{captured['portfolio_fit_rationale']} {captured['market_rationale']}",
        rank_score=captured["rank_score"],
        probability_of_profit=captured["probability_of_profit"],
    )


def handler(event, context):
    started_at = datetime.datetime.utcnow().isoformat() + "Z"
    account_id = ((event or {}).get("accountId", "") or OPPORTUNITY_ENGINE_ACCOUNT_ID).strip()
    if not account_id:
        logger.error("No accountId in event and OPPORTUNITY_ENGINE_ACCOUNT_ID not configured")
        return {"statusCode": 500, "body": "OPPORTUNITY_ENGINE_ACCOUNT_ID not configured"}

    logger.info(f"Opportunity Engine scan started for account={account_id} at {started_at}")

    # 1. Deterministic prefilter — identical to wheel-scan's existing universe/
    # fundamentals/hard-filter/scoring pass, strategy-agnostic.
    tickers = prefilter.get_full_universe()
    if not tickers:
        logger.error("Failed to fetch ticker universe")
        return {"statusCode": 500, "body": "Failed to fetch ticker universe"}

    all_stocks = prefilter.batch_fetch_fundamentals(tickers, max_workers=30)
    logger.info(f"Fetched fundamentals for {len(all_stocks)} tickers")

    filtered = prefilter.apply_hard_filters(all_stocks)
    logger.info(f"After hard filter: {len(filtered)} stocks qualify")

    for s in filtered:
        s["_fund_score"] = prefilter.score_stock_fundamentals(s)
    filtered.sort(key=lambda x: x["_fund_score"], reverse=True)
    shortlist = filtered[:SHORTLIST_SIZE]
    logger.info(f"Shortlisted top {len(shortlist)} candidates for Tower 2")

    if not shortlist:
        logger.warning("No candidates passed the hard filter — nothing to run Tower 2 on")
        return {"statusCode": 200, "body": "No candidates passed the hard filter"}

    # 2. Tower 1 — built once, shared across every candidate's Tower 2 run.
    access_token = _robinhood_access_token()
    robinhood_client = RobinhoodMcpClient(token_provider=lambda: access_token) if access_token else None
    tower1_context = build_tower1_context(robinhood_client, _assets_table, _accounts_table, account_id)
    mcp_servers = build_robinhood_mcp_server_config(access_token) if access_token else None
    if mcp_servers is None:
        logger.warning("Running Tower 2 without Robinhood MCP (no access token yet) — web_search + fundamentals only")

    # 3. Tower 2 — concurrent, one AgentLoop run per shortlisted candidate.
    recorded = 0
    skipped = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=TOWER2_MAX_WORKERS) as executor:
        futures = {
            executor.submit(run_tower2_for_candidate, candidate, tower1_context, mcp_servers): candidate
            for candidate in shortlist
        }
        for future in concurrent.futures.as_completed(futures):
            candidate = futures[future]
            try:
                captured = future.result()
            except Exception as e:
                logger.error(f"Tower 2 execution error for {candidate['ticker']}: {e}")
                skipped += 1
                continue
            if not captured:
                skipped += 1
                continue
            try:
                recommendation_id = persist_recommendation(account_id, candidate, tower1_context, captured)
                logger.info(f"Recorded recommendation {recommendation_id} for {candidate['ticker']}")
                recorded += 1
            except Exception as e:
                logger.error(f"Failed to persist recommendation for {candidate['ticker']}: {e}")
                skipped += 1

    logger.info(f"Opportunity Engine scan complete. recorded={recorded} skipped={skipped}")
    return {
        "statusCode": 200,
        "body": {
            "universe_size": len(tickers),
            "shortlist_size": len(shortlist),
            "recorded": recorded,
            "skipped": skipped,
        },
    }
