"""
Deep Dive — Tower 2 tool registry.

simulate_scenario, web_search, and the Robinhood allowlist are shared
with Opportunity Engine (finvault_agent_core.tower2_shared). This module
adds Deep Dive's own final-action tools:

  - save_scenario_run — persists a scenario under the active
    recommendation. Standalone chats (no pre-seeded recommendationId)
    create one on the first save; pre-seeded chats already have one.
  - approve_scenario — the HITL gate (requires_confirmation: true). Makes
    ZERO calls to any order-placement tool — v1 ends at staging a paper
    trade. Wires to paper-trade-api's existing-but-unused scanId/source
    fields via a direct backend-to-backend Lambda invoke (no JWT exists
    on that path, so paper-trade-api trusts the accountId this invoke
    passes directly — see the new "deep-dive-approval" branch added to
    its handler).
"""

import datetime
import json
import logging

import boto3
from finvault_agent_core.agent_loop import ToolSpec
from finvault_agent_core.recommendations_repo import put_recommendation, put_scenario_run, update_status
from finvault_agent_core.tower2_shared import LEG_SCHEMA, build_simulate_scenario_tool

logger = logging.getLogger(__name__)

_lambda = boto3.client("lambda")

# AgentRecommendations strategyType -> paper-trade-api's single-leg
# strategy codes. A VERTICAL_SPREAD has two legs and needs two staged
# orders (paper-trade-api's schema is single-leg per order today) --
# a known minor gap per the plan, not a blocker.
_LEG_TO_PAPER_TRADE_STRATEGY = {
    ("STOCK", "LONG"): "BUY_STOCK",
    ("STOCK", "SHORT"): "SELL_STOCK",
    ("PUT", "LONG"): "BUY_PUT",
    ("PUT", "SHORT"): "SELL_PUT",
    ("CALL", "LONG"): "BUY_CALL",
    ("CALL", "SHORT"): "SELL_CALL",
}


def _stage_leg_via_paper_trade_api(paper_trade_api_function, account_id, ticker, leg, recommendation_id):
    """One backend-to-backend invoke per leg. Returns the invoke's parsed
    body; raises if the invoke itself fails (network/IAM) or if
    paper-trade-api rejected the order (validation failure) -- either way
    the caller must know approval didn't actually result in a staged
    order, not silently proceed as if it did."""
    strategy = _LEG_TO_PAPER_TRADE_STRATEGY.get((leg["type"], leg["side"]))
    if strategy is None:
        raise ValueError(f"No paper-trade-api strategy mapping for leg type={leg['type']} side={leg['side']}")

    body = {
        "ticker": ticker,
        "strategy": strategy,
        "quantity": leg["qty"],
        "orderType": "MKT",
        "source": "deep_dive_approval",
        "scanId": recommendation_id,
    }
    if leg["type"] in ("CALL", "PUT"):
        body["strike"] = leg["strike"]
        body["expiry"] = leg.get("expiry")

    payload = {"source": "deep-dive-approval", "accountId": account_id, "body": body}
    resp = _lambda.invoke(
        FunctionName=paper_trade_api_function,
        InvocationType="RequestResponse",
        Payload=json.dumps(payload).encode("utf-8"),
    )
    result = json.loads(resp["Payload"].read())
    if not result.get("ok"):
        raise RuntimeError(f"paper-trade-api rejected the staged order: {result.get('body')}")
    return result["body"]


def build_deep_dive_tools(state, recommendations_table, account_id, paper_trade_api_function, ticker_hint=None):
    """`state` keys used across these tools and build_simulate_scenario_tool:
    last_scenario_result, active_recommendation_id (set on first
    save_scenario_run if no recommendationId was pre-seeded), approved
    (set by approve_scenario, read back by the caller after the loop)."""

    def _save_scenario_run_fn(**kwargs):
        last = state.get("last_scenario_result")
        if last is None:
            raise ValueError("save_scenario_run called before simulate_scenario — call simulate_scenario first.")

        rec_id = state.get("active_recommendation_id")
        if rec_id is None:
            rec_id = put_recommendation(
                recommendations_table, account_id,
                ticker=kwargs.get("ticker") or ticker_hint or "UNKNOWN",
                strategy_type=kwargs.get("strategy_type", "OTHER"),
                strategy_detail=kwargs.get("legs", []),
                tower1_context=state.get("tower1_context", {}),
                tower2_research={"narrative_summary": kwargs.get("narrative_summary", "")},
                rationale=kwargs.get("narrative_summary", ""),
                rank_score=0,  # standalone Deep Dive scenarios aren't ranked against a universe
                probability_of_profit=last.get("probability_of_profit"),
                source="standalone_deep_dive",
            )
            state["active_recommendation_id"] = rec_id

        scenario_id = put_scenario_run(
            recommendations_table, account_id, rec_id,
            scenario_input=kwargs,
            scenario_output=last,
            narrative_summary=kwargs.get("narrative_summary"),
        )
        return {"recommendationId": rec_id, "scenarioId": scenario_id}

    def _approve_scenario_fn(**kwargs):
        rec_id = state.get("active_recommendation_id")
        if rec_id is None:
            raise ValueError("approve_scenario called with no active recommendation — call save_scenario_run first.")
        last = state.get("last_scenario_result")

        approved_at = datetime.datetime.utcnow().isoformat() + "Z"
        approval_snapshot = {
            "ticker": kwargs["ticker"],
            "strategyType": kwargs["strategy_type"],
            "legs": kwargs["legs"],
            "entryAssumptions": kwargs.get("entry_assumptions", {}),
            "scenarioOutput": last,
            "approvedAt": approved_at,
        }

        staged_orders = []
        staging_error = None
        if paper_trade_api_function:
            try:
                for leg in kwargs["legs"]:
                    staged_orders.append(
                        _stage_leg_via_paper_trade_api(paper_trade_api_function, account_id, kwargs["ticker"], leg, rec_id)
                    )
            except Exception as e:
                # The approval itself (status=APPROVED) is still recorded --
                # that's the user's decision, already made. Staging is a
                # best-effort side effect; surface the failure distinctly
                # rather than silently losing it or blocking the approval.
                logger.error(f"Failed to stage paper trade for recommendation {rec_id}: {e}")
                staging_error = str(e)

        approval_snapshot["stagedOrders"] = staged_orders
        if staging_error:
            approval_snapshot["stagingError"] = staging_error

        update_status(recommendations_table, account_id, rec_id, "APPROVED", extra_fields={"approvalSnapshot": approval_snapshot})
        state["approved"] = {"recommendationId": rec_id, "approvalSnapshot": approval_snapshot}
        return {
            "approved": True,
            "recommendationId": rec_id,
            "stagedOrderCount": len(staged_orders),
            "stagingError": staging_error,
        }

    return [
        build_simulate_scenario_tool(state),
        ToolSpec(
            name="save_scenario_run",
            description=(
                "Save the most recent simulate_scenario result under this conversation's "
                "recommendation, with a short narrative summary. Call this whenever you've "
                "run a scenario worth keeping — the user can come back to it later."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "ticker": {"type": "string"},
                    "strategy_type": {
                        "type": "string",
                        "enum": ["LONG_EQUITY", "SHORT_EQUITY", "COVERED_CALL", "CASH_SECURED_PUT", "VERTICAL_SPREAD", "OTHER"],
                    },
                    "legs": {"type": "array", "items": LEG_SCHEMA},
                    "narrative_summary": {"type": "string"},
                },
                "required": ["ticker", "strategy_type", "legs", "narrative_summary"],
            },
            fn=_save_scenario_run_fn,
            category="reasoning_aid",
            requires_confirmation=False,
        ),
        ToolSpec(
            name="approve_scenario",
            description=(
                "Approve the active recommendation's most recent scenario, staging it as a "
                "paper trade. Requires explicit user confirmation before being called — never "
                "call this without the user having clicked an explicit Approve action. This "
                "does NOT place any real order; it only stages a simulated paper trade."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "ticker": {"type": "string"},
                    "strategy_type": {
                        "type": "string",
                        "enum": ["LONG_EQUITY", "SHORT_EQUITY", "COVERED_CALL", "CASH_SECURED_PUT", "VERTICAL_SPREAD", "OTHER"],
                    },
                    "legs": {"type": "array", "items": LEG_SCHEMA},
                    "entry_assumptions": {"type": "object", "description": "price/iv/snapshot time assumed at approval"},
                },
                "required": ["ticker", "strategy_type", "legs"],
            },
            fn=_approve_scenario_fn,
            category="reasoning_aid",
            requires_confirmation=True,
        ),
    ]
