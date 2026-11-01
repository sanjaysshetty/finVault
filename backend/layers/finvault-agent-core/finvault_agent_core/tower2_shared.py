"""
Shared Tower 2 building blocks — used by both Opportunity Engine and Deep
Dive, since both run an AgentLoop doing market/macro research against the
identical Robinhood allowlist and the identical simulate_scenario tool.
Each surface adds its own final-action tool on top (write_ranked_
recommendation for Opportunity Engine; save_scenario_run/approve_scenario
for Deep Dive) — those stay in each surface's own tools.py since they're
not shared.

Tool type versions (web_search) and the MCP connector beta flag are
verified against the installed anthropic SDK at the time this was
written, not assumed from an earlier plan draft — both have moved since:
web_search_20250305 -> ... -> web_search_20260318 (current); the
mcp-client beta flag is mcp-client-2026-09-15 (see client_factory.py).
"""

from .agent_loop import ToolSpec
from .options_market_data import get_option_chain_data
from .scenario_math import Leg, LegSide, LegType, simulate_scenario

WEB_SEARCH_TOOL = {"type": "web_search_20260318", "name": "web_search"}

ROBINHOOD_MCP_URL = "https://agent.robinhood.com/mcp/trading"

# Read-only, per-capability allowlist for Tower 2 — market/macro research
# only. No order-placement, watchlist, alert, or scan-mutation tool is
# ever included here, matching the plan's default-deny design (§6.3): the
# *ability* to call a mutating tool simply doesn't exist in this list,
# not just discouraged.
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


LEG_SCHEMA = {
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


def legs_from_input(raw_legs):
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


def build_simulate_scenario_tool(state):
    """The one tool every Tower 2 agent calls for a probability/payoff
    number. `state` is a plain dict the caller owns — `_simulate_scenario_fn`
    stashes its result into `state["last_scenario_result"]` via closure, so
    a surface's own final-action tool (write_ranked_recommendation,
    save_scenario_run) can ground its own output against it without
    AgentLoop itself needing any awareness of this domain-specific
    tracking mechanism."""

    def _simulate_scenario_fn(**kwargs):
        legs = legs_from_input(kwargs["legs"])
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

    return ToolSpec(
        name="simulate_scenario",
        description=(
            "Simulate a payoff/probability scenario for a position. Call this "
            "with scenario_type='expiry_distribution' to get a grounded "
            "probability_of_profit before stating one — you must never state a "
            "probability that didn't come from this tool."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "legs": {"type": "array", "items": LEG_SCHEMA},
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
    )


def build_get_option_chain_tool():
    """Real option chain data (strike, bid/ask mid price, implied
    volatility) via yfinance — the ground-truth source for
    simulate_scenario's underlying_price/iv inputs when considering an
    options structure. Robinhood's market-data tools are listed in this
    module's allowlist for when a Robinhood MCP access token exists, but
    there is currently no supported way to obtain one for a headless
    backend Lambda (confirmed against Robinhood's own onboarding docs —
    scoped to interactive AI chat clients, not server-to-server use) —
    this tool is the actual, working source today, same "never invent,
    never guess" principle simulate_scenario already applies to the
    probability math itself.

    Calls yfinance in-process. The calling function must be packaged as
    a container image (PackageType: Image), not a zip -- yfinance now
    requires curl_cffi as a hard dependency (to avoid Yahoo's rate
    limiting, confirmed live), and that stack doesn't fit Lambda's 250MB
    zip limit alongside this layer's own anthropic/mcp dependencies
    (confirmed directly: 287MB combined, 2026-10-31 size investigation).
    Container images lift that to 10GB.

    Raises on fetch failure — AgentLoop's own tool-error handling turns
    that into a visible is_error result, never a silent fabricated
    number."""

    def _get_option_chain_fn(**kwargs):
        return get_option_chain_data(
            ticker=kwargs["ticker"],
            expiry=kwargs["expiry"],
            option_type=kwargs["option_type"],
            strike_hint=kwargs.get("strike_hint"),
        )

    return ToolSpec(
        name="get_option_chain",
        description=(
            "Fetch real option chain data for a ticker/expiry/option_type — "
            "underlying price plus a liquid, near-the-money window of strikes "
            "with bid/ask, mid price, and implied volatility. Call this before "
            "simulate_scenario whenever you're considering an options structure "
            "(covered call, cash-secured put, vertical spread) — you must never "
            "invent, estimate, or recall a strike's price or implied volatility "
            "yourself. Not needed for a straight long/short equity position."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "ticker": {"type": "string"},
                "expiry": {"type": "string", "description": "Option expiration date, YYYY-MM-DD"},
                "option_type": {"type": "string", "enum": ["call", "put"]},
                "strike_hint": {
                    "type": "number",
                    "description": "Optional — center the returned strikes near this value instead of the current underlying price",
                },
            },
            "required": ["ticker", "expiry", "option_type"],
        },
        fn=_get_option_chain_fn,
        category="data_fetch",
        requires_confirmation=False,
    )
