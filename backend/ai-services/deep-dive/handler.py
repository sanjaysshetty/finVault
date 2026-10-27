"""
Deep Dive Worker — the actual AgentLoop work.

Invoked asynchronously by DeepDiveApi (Node, crud/deep-dive-api/) — the
lightweight sync front door mirrors Advisor's/Opportunity Engine's
existing split (resolveContext/JWT handling, cache check, async invoke,
202+poll). That stays in Node, reusing finvault-shared's already-proven
resolveContext and advisorCacheRepo directly, rather than duplicating a
third Python copy of JWT resolution (asset-hub already has its own
hand-rolled one) just to move the API-facing layer's language — the part
of "port to Python" that actually matters here is this worker's AgentLoop
logic, not which language parses the JWT.

Idempotency guard (the fix this port makes, per the plan): claims the job
via try_claim_job before calling Claude; DeepDiveWorkerFunction's
EventInvokeConfig sets MaximumRetryAttempts: 0 in template.yaml. Together
these close the gap Advisor's existing Node worker has today (no
guard at all) — harmless at single-shot-call volume, a real double-
billing risk once a worker does multi-step tool calling, which this one
does.
"""

import logging
import os
import time

import boto3
from finvault_agent_core import (
    build_tower1_context,
    get_secret,
    read_cache,
    summarize_tower1_context,
    try_claim_job,
    write_cache,
)
from finvault_agent_core.agent_loop import AgentLoop
from finvault_agent_core.recommendations_repo import get_recommendation_with_history
from finvault_agent_core.robinhood_mcp import RobinhoodMcpClient
from finvault_agent_core.tower2_shared import WEB_SEARCH_TOOL, build_robinhood_mcp_server_config

from tools import build_deep_dive_tools

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

FIN_ASSETS_TABLE = os.environ.get("FIN_ASSETS_TABLE", "")
FIN_ACCOUNTS_TABLE = os.environ.get("FIN_ACCOUNTS_TABLE", "")
AGENT_RECOMMENDATIONS_TABLE = os.environ.get("AGENT_RECOMMENDATIONS_TABLE", "")
ADVISOR_CACHE_TABLE = os.environ.get("ADVISOR_CACHE_TABLE", "")
PAPER_TRADE_API_FUNCTION = os.environ.get("PAPER_TRADE_API_FUNCTION", "")

TOWER1_CACHE_TTL_SECONDS = 300  # ~5 min, matches AdvisorApi's framework-cache pattern
MAX_ITERATIONS = 10
DEADLINE_SECONDS = 240.0
# Cost guardrail (added after the 2026-10-26 Opportunity Engine incident):
# per-turn, not cumulative across a conversation -- confirmed design,
# since worker_handler already constructs a fresh AgentLoop per chat
# message, "per turn" and "per AgentLoop instance" are the same thing,
# so no cross-turn running total needs to be persisted.
DEEP_DIVE_PER_TURN_COST_CAP_USD = float(os.environ.get("DEEP_DIVE_PER_TURN_COST_CAP_USD", "0.10"))
DEEP_DIVE_MAX_WEB_SEARCHES_PER_TURN = int(os.environ.get("DEEP_DIVE_MAX_WEB_SEARCHES_PER_TURN", "3"))

_ddb = boto3.resource("dynamodb")
_assets_table = _ddb.Table(FIN_ASSETS_TABLE) if FIN_ASSETS_TABLE else None
_accounts_table = _ddb.Table(FIN_ACCOUNTS_TABLE) if FIN_ACCOUNTS_TABLE else None
_recommendations_table = _ddb.Table(AGENT_RECOMMENDATIONS_TABLE) if AGENT_RECOMMENDATIONS_TABLE else None
_cache_table = _ddb.Table(ADVISOR_CACHE_TABLE) if ADVISOR_CACHE_TABLE else None

with open(os.path.join(os.path.dirname(__file__), "prompts", "deep_dive_chat.md")) as f:
    SYSTEM_PROMPT = f.read()

# Per-container Tower 1 cache, keyed by account_id — avoids re-fetching
# Robinhood/manual-holdings/investor-profile data on every turn of a
# multi-turn conversation within the same warm Lambda container.
_tower1_cache = {}


def _robinhood_access_token():
    try:
        return get_secret("/finvault/robinhood/mcp-access-token")
    except Exception as e:
        logger.warning(f"Robinhood access token unavailable: {e}")
        return None


def _get_tower1_context(account_id):
    cached = _tower1_cache.get(account_id)
    if cached and (time.time() - cached[1]) < TOWER1_CACHE_TTL_SECONDS:
        return cached[0]

    access_token = _robinhood_access_token()
    robinhood_client = RobinhoodMcpClient(token_provider=lambda: access_token) if access_token else None
    context = build_tower1_context(robinhood_client, _assets_table, _accounts_table, account_id)
    _tower1_cache[account_id] = (context, time.time())
    return context


def _build_context_preamble(tower1_context, preseeded_header):
    parts = [f"Tower 1 — investor's portfolio and risk context:\n{summarize_tower1_context(tower1_context)}"]
    if preseeded_header:
        parts.append(
            "This conversation continues an existing recommendation:\n"
            f"Ticker: {preseeded_header.get('ticker')}\n"
            f"Strategy: {preseeded_header.get('strategyType')}\n"
            f"Rationale: {preseeded_header.get('rationale')}\n"
            f"Status: {preseeded_header.get('status')}"
        )
    return "\n\n".join(parts)


def worker_handler(payload, context=None):
    cache_key = payload["cacheKey"]
    account_id = payload["accountId"]
    message = payload["message"]
    history = payload.get("history") or []
    recommendation_id = payload.get("recommendationId")

    logger.info(f"Deep Dive worker start: cacheKey={cache_key} account={account_id} preseeded={bool(recommendation_id)}")

    if not try_claim_job(_cache_table, cache_key):
        logger.warning(f"Job {cache_key} already claimed by another invocation — skipping duplicate run")
        return

    try:
        tower1_context = _get_tower1_context(account_id)

        preseeded_header = None
        if recommendation_id:
            preseeded_header, _ = get_recommendation_with_history(_recommendations_table, account_id, recommendation_id)

        access_token = _robinhood_access_token()
        mcp_servers = build_robinhood_mcp_server_config(access_token) if access_token else None
        if mcp_servers is None:
            logger.warning("Running Deep Dive without Robinhood MCP (no access token yet) — web_search + fundamentals only")

        state = {
            "last_scenario_result": None,
            "active_recommendation_id": recommendation_id,
            "tower1_context": tower1_context,
            "approved": None,
        }
        tools = build_deep_dive_tools(
            state, _recommendations_table, account_id, PAPER_TRADE_API_FUNCTION,
            ticker_hint=(preseeded_header or {}).get("ticker"),
        )

        # Local override, not a mutation of the shared WEB_SEARCH_TOOL
        # constant -- Opportunity Engine may want a different cap.
        per_turn_web_search_tool = {**WEB_SEARCH_TOOL, "max_uses": DEEP_DIVE_MAX_WEB_SEARCHES_PER_TURN}

        loop = AgentLoop(
            system_prompt=SYSTEM_PROMPT,
            tools=tools,
            server_tools=[per_turn_web_search_tool],
            mcp_servers=mcp_servers,
            max_iterations=MAX_ITERATIONS,
            deadline_seconds=DEADLINE_SECONDS,
            max_cost_usd=DEEP_DIVE_PER_TURN_COST_CAP_USD,
        )

        if not history:
            first_turn_content = f"{_build_context_preamble(tower1_context, preseeded_header)}\n\n{message}"
        else:
            first_turn_content = message
        messages = list(history) + [{"role": "user", "content": first_turn_content}]

        result = loop.run(messages, request_id=cache_key)

        reply = result.final_text or ""
        if result.status == "cost_exceeded" and not reply:
            reply = (
                "I had to stop early to stay within this message's cost guardrail. "
                "Ask a more specific follow-up and I'll continue from here."
            )

        write_cache(_cache_table, cache_key, {
            "status": "DONE",
            "reply": reply,
            "recommendationId": state.get("active_recommendation_id"),
            "approved": state.get("approved"),
            "loopStatus": result.status,
        })
        logger.info(f"Deep Dive worker done: cacheKey={cache_key} loopStatus={result.status} cost=${result.total_cost_usd:.4f}")

    except Exception as e:
        logger.error(f"Deep Dive worker failed: cacheKey={cache_key} {e}", exc_info=True)
        write_cache(_cache_table, cache_key, {"workerError": True, "errorMessage": str(e), "status": "ERROR"})
