"""
Opportunity Engine Lambda — Handler.

Pipeline:
  1. Fetch S&P 500 + 400 ticker universe, fundamentals, hard filter, score
     (prefilter.py — relocated/generalized from wheel-scan/tools.py).
  2. Build Tower 1 context once for the account (finvault_agent_core.tower1
     — shared with Deep Dive, which needs the identical snapshot) — reused
     by every candidate's Tower 2 run.
  3. Split the shortlist: only the top DEEP_DIVE_TOP_N candidates get a full
     Tower 2 AgentLoop pass (concurrent, ThreadPoolExecutor); the rest are
     recorded as screened-only, zero Anthropic spend.
  4. Persist each candidate's write_ranked_recommendation call (deep-dived)
     or fundamentals-only note (screened-only) into AgentRecommendationsTable.

Cost guardrails (added after the 2026-10-26 incident where a single scan
exhausted the entire Anthropic account credit balance):
  - Weekly idempotency: claims "this account's scan for this ISO week"
    before doing ANY work, via try_claim_job -- a second trigger within
    the same week is a no-op, not a second full-cost scan.
  - Scan-level dollar budget (SCAN_BUDGET_USD) is the true hard ceiling.
    Each deep-dived candidate's allowance is computed dynamically
    (remaining_budget / remaining_candidate_count) immediately before it
    starts, not a fixed per-candidate figure -- the running sum can never
    exceed the scan budget by construction. See budget_allocator.py.
  - Only DEEP_DIVE_TOP_N (not all 20-25 shortlisted) candidates ever reach
    Tower 2 at all.

Triggers:
  - EventBridge weekly schedule -- removed entirely from template.yaml
    after the incident; not reinstated until this guardrail set is
    verified live (see finVault's cost-guardrails plan).
  - Async Lambda invoke from OpportunityEngineReadFunction's
    POST /research/opportunities/trigger (which itself pre-checks for an
    already-completed scan this week before invoking at all).
"""

import concurrent.futures
import datetime
import logging
import os
import threading

import boto3
from finvault_agent_core import get_secret, summarize_tower1_context, try_claim_job
from finvault_agent_core.agent_loop import AgentLoop
from finvault_agent_core.robinhood_mcp import RobinhoodMcpClient

import prefilter
from budget_allocator import ScanBudget, adjust_reservation, allocate_next_candidate_budget, record_actual_spend
from finvault_agent_core import build_tower1_context
from finvault_agent_core import recommendations_repo
from tools import WEB_SEARCH_TOOL, build_robinhood_mcp_server_config, build_tower2_tools

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

FIN_ASSETS_TABLE = os.environ.get("FIN_ASSETS_TABLE", "")
FIN_ACCOUNTS_TABLE = os.environ.get("FIN_ACCOUNTS_TABLE", "")
AGENT_RECOMMENDATIONS_TABLE = os.environ.get("AGENT_RECOMMENDATIONS_TABLE", "")
ADVISOR_CACHE_TABLE = os.environ.get("ADVISOR_CACHE_TABLE", "")
OPPORTUNITY_ENGINE_ACCOUNT_ID = os.environ.get("OPPORTUNITY_ENGINE_ACCOUNT_ID", "")

# Candidates that pass the deterministic prefilter, ranked by score.
SHORTLIST_SIZE = 25
# Of those, only the top N get the full, expensive Tower 2 pass. The rest
# are recorded screened-only, at zero Anthropic cost.
DEEP_DIVE_TOP_N = int(os.environ.get("OPPORTUNITY_ENGINE_DEEP_DIVE_TOP_N", "5"))
TOWER2_MAX_WORKERS = 8
TOWER2_MAX_ITERATIONS = 10
TOWER2_DEADLINE_SECONDS = 180.0

# Cost guardrails (the 2026-10-26 incident's fix). SCAN_BUDGET_USD is the
# true hard ceiling for the whole scan; PER_CANDIDATE_CEILING_USD is a
# starting allowance that shrinks dynamically as the scan proceeds (see
# budget_allocator.py) -- it never lets the sum exceed SCAN_BUDGET_USD.
SCAN_BUDGET_USD = float(os.environ.get("OPPORTUNITY_ENGINE_SCAN_BUDGET_USD", "0.20"))
PER_CANDIDATE_CEILING_USD = float(os.environ.get("OPPORTUNITY_ENGINE_PER_CANDIDATE_CEILING_USD", "0.10"))
# Below this, don't bother starting another candidate -- not enough
# budget left for a run to produce anything useful.
MIN_VIABLE_CANDIDATE_BUDGET_USD = float(os.environ.get("OPPORTUNITY_ENGINE_MIN_VIABLE_CANDIDATE_BUDGET_USD", "0.02"))
# How long the "already scanned this week" claim lives -- long enough to
# span the week, short enough that a permanently-stuck claim (e.g. from a
# crashed run) doesn't block every future week too.
SCAN_WEEK_CLAIM_TTL_SECONDS = 8 * 24 * 3600

_ddb = boto3.resource("dynamodb")
_assets_table = _ddb.Table(FIN_ASSETS_TABLE) if FIN_ASSETS_TABLE else None
_accounts_table = _ddb.Table(FIN_ACCOUNTS_TABLE) if FIN_ACCOUNTS_TABLE else None
_recommendations_table = _ddb.Table(AGENT_RECOMMENDATIONS_TABLE) if AGENT_RECOMMENDATIONS_TABLE else None
_cache_table = _ddb.Table(ADVISOR_CACHE_TABLE) if ADVISOR_CACHE_TABLE else None

with open(os.path.join(os.path.dirname(__file__), "prompts", "tower2_ranking.md")) as f:
    TOWER2_SYSTEM_PROMPT = f.read()


def _scan_week_key(now=None):
    """ISO year-week key, e.g. "2026-W44". Must match the Node trigger
    route's hand-rolled equivalent exactly (see opportunity-engine-read's
    isoWeekKey) -- both implement the same ISO 8601 week-numbering rule,
    including the year-boundary edge case where late December can belong
    to week 1 of the following ISO year."""
    now = now or datetime.datetime.utcnow()
    iso_year, iso_week, _ = now.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


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


def run_tower2_for_candidate(candidate, tower1_context, mcp_servers, cost_cap_usd):
    """Runs one candidate's Tower 2 AgentLoop under a dynamically-allocated
    dollar cap and returns (captured_recommendation_or_None, actual_cost_usd).

    captured_recommendation is None if the model never successfully called
    write_ranked_recommendation (e.g. it hit the cost/iteration/deadline
    ceiling first, or genuinely found nothing worth recommending and just
    ended the turn) -- the caller still records actual_cost_usd either way,
    since the spend happened regardless of whether a recommendation came
    out of it.
    """
    state = {"last_scenario_result": None, "captured_recommendation": None}
    tools = build_tower2_tools(state)

    loop = AgentLoop(
        system_prompt=TOWER2_SYSTEM_PROMPT,
        tools=tools,
        server_tools=[WEB_SEARCH_TOOL],
        mcp_servers=mcp_servers,
        max_iterations=TOWER2_MAX_ITERATIONS,
        deadline_seconds=TOWER2_DEADLINE_SECONDS,
        max_cost_usd=cost_cap_usd,
    )

    user_message = (
        f"Candidate fundamentals (already passed hard filters):\n"
        f"{prefilter.summarize_fundamentals(candidate)}\n\n"
        f"Tower 1 — investor's portfolio and risk context:\n"
        f"{summarize_tower1_context(tower1_context)}\n\n"
        f"Research this candidate and write your ranked recommendation."
    )

    try:
        result = loop.run([{"role": "user", "content": user_message}], request_id=f"oe-{candidate['ticker']}")
    except Exception as e:
        logger.error(f"Tower 2 run failed for {candidate['ticker']}: {e}")
        return None, 0.0

    if result.status != "done":
        logger.warning(f"Tower 2 run for {candidate['ticker']} ended with status={result.status}, not done (cost so far: ${result.total_cost_usd:.4f})")

    return state.get("captured_recommendation"), result.total_cost_usd


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


def persist_screened_only(account_id, candidate, note):
    return recommendations_repo.put_screened_recommendation(
        _recommendations_table,
        account_id,
        ticker=candidate["ticker"],
        fundamental_score=candidate.get("_fund_score"),
        fundamentals_summary=prefilter.summarize_fundamentals(candidate),
        note=note,
    )


def run_tower2_pass(deep_dive_candidates, tower1_context, mcp_servers, scan_budget, account_id):
    """Budget-gated, bounded-concurrency Tower 2 pass. Checks remaining
    scan budget immediately before EVERY candidate kickoff, not once up
    front for the whole batch -- replacing the original "submit all N
    futures at once" pattern that let 25 concurrent runs each burn up to
    the harness's full default ceiling.

    Returns (recorded_count, skipped_count, never_started_candidates) --
    never_started is the list of candidates that never got a chance to
    begin because the scan budget ran dry; the caller records those as
    screened-only, same as candidates that were never in the top N.
    """
    lock = threading.Lock()
    pending = list(deep_dive_candidates)
    in_flight = {}
    recorded = 0
    skipped = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=TOWER2_MAX_WORKERS) as executor:
        def try_submit_next():
            with lock:
                if not pending:
                    return False
                remaining_count = len(pending)  # includes the one about to start
                cap = allocate_next_candidate_budget(scan_budget, remaining_count, PER_CANDIDATE_CEILING_USD)
                if cap < MIN_VIABLE_CANDIDATE_BUDGET_USD:
                    return False  # budget effectively exhausted -- leave `pending` for screened-only
                candidate = pending.pop(0)
                # Reserve the full allocation immediately, not just once the
                # real cost is known -- the executor submits up to
                # TOWER2_MAX_WORKERS candidates upfront, before any of them
                # complete, so allocate_next_candidate_budget's math would
                # see a stale (too-large) remaining balance for every
                # candidate in that initial burst without this. True-up
                # happens via adjust_reservation once the real cost is in.
                record_actual_spend(scan_budget, cap)
            future = executor.submit(run_tower2_for_candidate, candidate, tower1_context, mcp_servers, cap)
            in_flight[future] = (candidate, cap)
            return True

        for _ in range(TOWER2_MAX_WORKERS):
            if not try_submit_next():
                break

        while in_flight:
            done, _ = concurrent.futures.wait(list(in_flight.keys()), return_when=concurrent.futures.FIRST_COMPLETED)
            for future in done:
                candidate, reserved_cap = in_flight.pop(future)
                try:
                    captured, actual_cost = future.result()
                except Exception as e:
                    logger.error(f"Tower 2 execution error for {candidate['ticker']}: {e}")
                    captured, actual_cost = None, 0.0

                with lock:
                    adjust_reservation(scan_budget, reserved_cap, actual_cost)

                if captured:
                    try:
                        recommendation_id = persist_recommendation(account_id, candidate, tower1_context, captured)
                        logger.info(f"Recorded recommendation {recommendation_id} for {candidate['ticker']} (cost ${actual_cost:.4f})")
                        recorded += 1
                    except Exception as e:
                        logger.error(f"Failed to persist recommendation for {candidate['ticker']}: {e}")
                        skipped += 1
                else:
                    persist_screened_only(
                        account_id, candidate,
                        note="Deep-dive run did not complete with a recommendation "
                             "(hit its cost/iteration/time ceiling, or found nothing worth recommending).",
                    )
                    skipped += 1

                try_submit_next()

    return recorded, skipped, pending  # `pending` = never-started, budget-starved candidates


def handler(event, context=None):
    started_at = datetime.datetime.utcnow().isoformat() + "Z"
    account_id = ((event or {}).get("accountId", "") or OPPORTUNITY_ENGINE_ACCOUNT_ID).strip()
    if not account_id:
        logger.error("No accountId in event and OPPORTUNITY_ENGINE_ACCOUNT_ID not configured")
        return {"statusCode": 500, "body": "OPPORTUNITY_ENGINE_ACCOUNT_ID not configured"}

    week_key = _scan_week_key()
    scan_claim_key = f"oe-scan-week#{account_id}#{week_key}"

    # Defense in depth behind the Node route's own pre-check -- that
    # check-then-invoke isn't itself atomic against two genuinely
    # concurrent triggers, so this is the authoritative, race-safe gate.
    if not try_claim_job(_cache_table, scan_claim_key, ttl_seconds=SCAN_WEEK_CLAIM_TTL_SECONDS):
        logger.warning(f"Week {week_key} already claimed for account={account_id} — not re-scanning")
        return {"statusCode": 200, "body": {"status": "already_scanned", "weekKey": week_key}}

    logger.info(f"Opportunity Engine scan started for account={account_id}, week={week_key} at {started_at}")
    recommendations_repo.put_scan_run(_recommendations_table, account_id, week_key, status="IN_PROGRESS", startedAt=started_at)

    # 1. Deterministic prefilter — identical to wheel-scan's existing universe/
    # fundamentals/hard-filter/scoring pass, strategy-agnostic. Pure Python,
    # zero Anthropic cost regardless of universe size.
    tickers = prefilter.get_full_universe()
    if not tickers:
        logger.error("Failed to fetch ticker universe")
        recommendations_repo.put_scan_run(_recommendations_table, account_id, week_key, status="FAILED", startedAt=started_at, error="Failed to fetch ticker universe")
        return {"statusCode": 500, "body": "Failed to fetch ticker universe"}

    all_stocks = prefilter.batch_fetch_fundamentals(tickers, max_workers=30)
    logger.info(f"Fetched fundamentals for {len(all_stocks)} tickers")

    filtered = prefilter.apply_hard_filters(all_stocks)
    logger.info(f"After hard filter: {len(filtered)} stocks qualify")

    for s in filtered:
        s["_fund_score"] = prefilter.score_stock_fundamentals(s)
    filtered.sort(key=lambda x: x["_fund_score"], reverse=True)
    shortlist = filtered[:SHORTLIST_SIZE]
    logger.info(f"Shortlisted top {len(shortlist)} candidates")

    if not shortlist:
        logger.warning("No candidates passed the hard filter — nothing to run Tower 2 on")
        recommendations_repo.put_scan_run(
            _recommendations_table, account_id, week_key, status="COMPLETE", startedAt=started_at,
            completedAt=datetime.datetime.utcnow().isoformat() + "Z",
            universeSize=len(tickers), shortlistSize=0, deepDivedCount=0, screenedOnlyCount=0,
            recordedCount=0, skippedCount=0, totalActualCostUsd=0.0,
        )
        return {"statusCode": 200, "body": "No candidates passed the hard filter"}

    deep_dive_candidates = shortlist[:DEEP_DIVE_TOP_N]
    screened_only_candidates = shortlist[DEEP_DIVE_TOP_N:]
    logger.info(f"Deep-diving top {len(deep_dive_candidates)}; {len(screened_only_candidates)} screened-only")

    # 2. Tower 1 — built once, shared across every deep-dived candidate's Tower 2 run.
    access_token = _robinhood_access_token()
    robinhood_client = RobinhoodMcpClient(token_provider=lambda: access_token) if access_token else None
    tower1_context = build_tower1_context(robinhood_client, _assets_table, _accounts_table, account_id)
    mcp_servers = build_robinhood_mcp_server_config(access_token) if access_token else None
    if mcp_servers is None:
        logger.warning("Running Tower 2 without Robinhood MCP (no access token yet) — web_search + fundamentals only")

    # 3. Tower 2 — budget-gated, concurrent, only for the top DEEP_DIVE_TOP_N.
    scan_budget = ScanBudget(total_budget_usd=SCAN_BUDGET_USD)
    recorded, skipped, never_started = run_tower2_pass(deep_dive_candidates, tower1_context, mcp_servers, scan_budget, account_id)

    # 4. Everything else (below the top N, plus anything the budget ran
    # out before starting) gets a lightweight, zero-cost record.
    for candidate in screened_only_candidates:
        persist_screened_only(account_id, candidate, note="Did not rank in the top candidates selected for deep-dive analysis.")
    for candidate in never_started:
        persist_screened_only(account_id, candidate, note="Scan budget was exhausted before this candidate's deep-dive could start.")

    completed_at = datetime.datetime.utcnow().isoformat() + "Z"
    recommendations_repo.put_scan_run(
        _recommendations_table, account_id, week_key, status="COMPLETE", startedAt=started_at, completedAt=completed_at,
        universeSize=len(tickers), shortlistSize=len(shortlist),
        deepDivedCount=len(deep_dive_candidates) - len(never_started),
        screenedOnlyCount=len(screened_only_candidates) + len(never_started),
        recordedCount=recorded, skippedCount=skipped,
        totalActualCostUsd=round(scan_budget.spent_usd, 4),
    )

    logger.info(f"Opportunity Engine scan complete. recorded={recorded} skipped={skipped} cost=${scan_budget.spent_usd:.4f}")
    return {
        "statusCode": 200,
        "body": {
            "weekKey": week_key,
            "universe_size": len(tickers),
            "shortlist_size": len(shortlist),
            "deep_dived": len(deep_dive_candidates) - len(never_started),
            "screened_only": len(screened_only_candidates) + len(never_started),
            "recorded": recorded,
            "skipped": skipped,
            "total_actual_cost_usd": round(scan_budget.spent_usd, 4),
        },
    }
