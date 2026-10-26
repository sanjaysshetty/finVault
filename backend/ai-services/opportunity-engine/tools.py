"""
Opportunity Engine — Tower 2 tool definitions.

Builds the per-candidate tool registry for Tower 2's AgentLoop: the
deterministic simulate_scenario tool (grounds every probability claim),
the write_ranked_recommendation tool (the forced final call, with hard
enforcement that probability_of_profit can only ever be the value
simulate_scenario actually computed — never trusted from the model's own
input), the web_search server tool, and the Robinhood MCP native-connector
server config scoped to a strict per-capability allowlist.

Tool type versions (web_search) and the MCP connector beta flag are
verified against the installed anthropic SDK at the time this was
written, not the original plan draft's values — both have moved since:
web_search_20250305 -> ... -> web_search_20260318 (current); the
mcp-client beta flag is mcp-client-2026-09-15 (see client_factory.py).
"""

from finvault_agent_core.scenario_math import Leg, LegSide, LegType, simulate_scenario
from finvault_agent_core.agent_loop import ToolSpec

WEB_SEARCH_TOOL = {"type": "web_search_20260318", "name": "web_search"}

ROBINHOOD_MCP_URL = "https://agent.robinhood.com/mcp/trading"

# Read-only, per-capability allowlist for Opportunity Engine's Tower 2 —
# market/macro research only. No order-placement, watchlist, alert, or
# scan-mutation tool is ever included here, matching the plan's
# default-deny design (§6.3): the *ability* to call a mutating tool simply
# doesn't exist in this list, not just discouraged.
TOWER2_ROBINHOOD_ALLOWED_TOOLS = [
    "get_equity_quotes",
    "get_equity_historicals",
    "get_equity_fundamentals",
    "get_option_chains",
    "get_option_quotes",
    "get_earnings_calendar",
    "get_earnings_results",
    "get_equity_analyst_ratings",
    "get_politician_trades",
    "search",
    "get_sec_filing",
    "get_sec_filing_index",
    "get_sec_filing_facts",
    "get_sec_filing_facts_catalog",
]


def build_robinhood_mcp_server_config(access_token):
    """One entry for AgentLoop's `mcp_servers` param — Claude's native
    connector calls Robinhood server-side; no client code in this process."""
    return [{
        "type": "url",
        "url": ROBINHOOD_MCP_URL,
        "name": "robinhood",
        "authorization_token": access_token,
        "tool_configuration": {"enabled": True, "allowed_tools": TOWER2_ROBINHOOD_ALLOWED_TOOLS},
    }]


_LEG_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": ["STOCK", "CALL", "PUT"]},
        "side": {"type": "string", "enum": ["LONG", "SHORT"]},
        "qty": {"type": "number"},
        "entry_price": {"type": "number"},
        "strike": {"type": "number", "description": "Required for CALL/PUT, omit for STOCK"},
    },
    "required": ["type", "side", "qty", "entry_price"],
}


def _legs_from_input(raw_legs):
    return [
        Leg(
            type=LegType(leg["type"]),
            side=LegSide(leg["side"]),
            qty=leg["qty"],
            entry_price=leg["entry_price"],
            strike=leg.get("strike"),
        )
        for leg in raw_legs
    ]


def build_tower2_tools(state):
    """Returns the list of ToolSpec entries for one candidate's AgentLoop
    run. `state` is a plain dict the caller owns — mutated here via
    closures so the orchestrating handler can read back
    `state["captured_recommendation"]` after the loop finishes, without
    AgentLoop itself needing any awareness of this domain-specific
    capture mechanism."""

    def _simulate_scenario_fn(**kwargs):
        legs = _legs_from_input(kwargs["legs"])
        result = simulate_scenario(
            legs,
            underlying_price=kwargs["underlying_price"],
            iv=kwargs["iv"],
            days_to_expiry=kwargs["days_to_expiry"],
            scenario_type=kwargs.get("scenario_type", "expiry_distribution"),
            price_move_pct=kwargs.get("price_move_pct"),
            iv_crush_factor=kwargs.get("iv_crush_factor"),
        )
        state["last_scenario_result"] = result
        return result

    def _write_recommendation_fn(**kwargs):
        last = state.get("last_scenario_result")
        if last is None:
            raise ValueError(
                "write_ranked_recommendation called before simulate_scenario — "
                "call simulate_scenario first so probability_of_profit is grounded."
            )
        grounded_probability = last.get("probability_of_profit")
        if grounded_probability is None:
            raise ValueError(
                "No probability_of_profit available to ground this recommendation — "
                "the last simulate_scenario call must use scenario_type='expiry_distribution', "
                "not 'price_move' or 'iv_crush' (those don't produce a probability)."
            )
        # Hard enforcement: the persisted probability is ALWAYS the value
        # simulate_scenario actually computed, never the model's own
        # submitted number, regardless of what it wrote in probability_of_profit.
        captured = dict(kwargs)
        captured["probability_of_profit"] = grounded_probability
        captured["scenario_output"] = last
        state["captured_recommendation"] = captured
        return {"recorded": True, "probability_of_profit": grounded_probability}

    return [
        ToolSpec(
            name="simulate_scenario",
            description=(
                "Simulate a payoff/probability scenario for a candidate position. "
                "Call this with scenario_type='expiry_distribution' to get a grounded "
                "probability_of_profit before writing your final recommendation — you "
                "must never state a probability that didn't come from this tool."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "legs": {"type": "array", "items": _LEG_SCHEMA},
                    "underlying_price": {"type": "number"},
                    "iv": {"type": "number", "description": "Implied volatility as a decimal, e.g. 0.30 for 30%"},
                    "days_to_expiry": {"type": "number"},
                    "scenario_type": {"type": "string", "enum": ["price_move", "expiry_distribution", "iv_crush"]},
                    "price_move_pct": {"type": "number"},
                    "iv_crush_factor": {"type": "number"},
                },
                "required": ["legs", "underlying_price", "iv", "days_to_expiry", "scenario_type"],
            },
            fn=_simulate_scenario_fn,
            category="deterministic_compute",
            requires_confirmation=False,
        ),
        ToolSpec(
            name="write_ranked_recommendation",
            description=(
                "Record the final ranked recommendation for this candidate. Call exactly "
                "once, as the last step, after calling simulate_scenario."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "strategy_type": {
                        "type": "string",
                        "enum": ["LONG_EQUITY", "SHORT_EQUITY", "COVERED_CALL", "CASH_SECURED_PUT", "VERTICAL_SPREAD", "OTHER"],
                    },
                    "legs": {"type": "array", "items": _LEG_SCHEMA},
                    "portfolio_fit_rationale": {
                        "type": "string",
                        "description": "Must reference Tower 1 facts: concentration, margin headroom, risk tolerance/goals.",
                    },
                    "market_rationale": {
                        "type": "string",
                        "description": "Must reference Tower 2 findings: fundamentals, macro context, relevant events.",
                    },
                    "probability_of_profit": {
                        "type": "number",
                        "description": "State your most recent simulate_scenario probability_of_profit here (it will be verified, not trusted blindly).",
                    },
                    "rank_score": {"type": "integer", "minimum": 0, "maximum": 100},
                },
                "required": [
                    "strategy_type", "legs", "portfolio_fit_rationale",
                    "market_rationale", "probability_of_profit", "rank_score",
                ],
            },
            fn=_write_recommendation_fn,
            category="reasoning_aid",
            requires_confirmation=False,
        ),
    ]
