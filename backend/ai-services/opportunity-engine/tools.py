"""
Opportunity Engine — Tower 2 tool registry.

simulate_scenario, the web_search tool, and the Robinhood MCP allowlist
are shared with Deep Dive (finvault_agent_core.tower2_shared) — this
module only adds the one tool specific to Opportunity Engine:
write_ranked_recommendation, the forced final call per candidate, with
hard enforcement that probability_of_profit can only ever be the value
simulate_scenario actually computed, never trusted from the model's own
input.
"""

from finvault_agent_core.agent_loop import ToolSpec
from finvault_agent_core.tower2_shared import (
    LEG_SCHEMA,
    ROBINHOOD_MCP_URL,
    TOWER2_ROBINHOOD_ALLOWED_TOOLS,
    WEB_SEARCH_TOOL,
    build_get_option_chain_tool,
    build_robinhood_mcp_server_config,
    build_simulate_scenario_tool,
)

__all__ = [
    "WEB_SEARCH_TOOL",
    "ROBINHOOD_MCP_URL",
    "TOWER2_ROBINHOOD_ALLOWED_TOOLS",
    "build_robinhood_mcp_server_config",
    "build_tower2_tools",
]


def _write_recommendation_fn(state, **kwargs):
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


def build_tower2_tools(state):
    """Returns the list of ToolSpec entries for one candidate's AgentLoop
    run. `state` is a plain dict the caller owns — mutated here via
    closures so the orchestrating handler can read back
    `state["captured_recommendation"]` after the loop finishes, without
    AgentLoop itself needing any awareness of this domain-specific
    capture mechanism."""
    return [
        build_simulate_scenario_tool(state),
        build_get_option_chain_tool(),
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
                    "legs": {"type": "array", "items": LEG_SCHEMA},
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
            fn=lambda **kwargs: _write_recommendation_fn(state, **kwargs),
            category="reasoning_aid",
            requires_confirmation=False,
        ),
    ]
