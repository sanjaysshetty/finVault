"""
Model-aware USD cost estimation for every Claude API call AgentLoop makes,
plus Anthropic's separately-billed server-side tools (web_search).

Built after an incident where a single Opportunity Engine scan burned
through the entire Anthropic account credit balance: AgentLoop's only
budget guard was a raw token count with no dollar awareness at all. This
module is what lets AgentLoop's max_cost_usd guard (see agent_loop.py)
actually mean something in dollars.

All rates below verified directly against
https://platform.claude.com/docs/en/about-claude/pricing on 2026-10-27
(not assumed from training data or carried over from an earlier,
now-superseded intro-pricing figure) -- in particular: Sonnet 5's launch
pricing of $2/$10 per Mtok was originally introductory through
2026-08-31 with a scheduled increase to $3/$15 on 2026-09-01; that
increase was cancelled and $2/$10 is now the permanent standard price.
Re-verify against that page before trusting these numbers if pricing
could plausibly have changed since.

web_search's $10/1,000-searches rate and the exact usage field names
(cache_creation_input_tokens, cache_read_input_tokens,
usage.server_tool_use.web_search_requests) are likewise verified
directly against
https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
on 2026-10-27, not assumed.
"""

from typing import Optional

# USD per 1,000,000 tokens. Keyed by the EXACT model id strings in
# client_factory.MODELS, not a family name -- treating different models'
# tokens as equivalent cost is exactly the gap this file closes.
#
# cache_write uses the 5-minute cache TTL rate (not the pricier 1-hour
# rate) since that's this codebase's standard ephemeral-cache convention
# elsewhere (advisor-api's existing cache_control: ephemeral pattern).
# AgentLoop does not currently set cache_control on any request, so
# cache_creation_input_tokens/cache_read_input_tokens are expected to be
# 0 for every call today -- these rates are tracked now so cost
# accounting stays correct the moment caching is ever turned on, with no
# further pricing.py change needed.
PRICING_USD_PER_MTOK = {
    "claude-sonnet-5": {
        "input": 2.00,
        "output": 10.00,
        "cache_write": 2.50,
        "cache_read": 0.20,
    },
    "claude-haiku-4-5": {
        "input": 1.00,
        "output": 5.00,
        "cache_write": 1.25,
        "cache_read": 0.10,
    },
}

# USD per server-side web_search call -- $10 per 1,000 searches, billed
# per Anthropic in addition to token usage, regardless of result count.
# A search that errors is not billed, but we have no way to distinguish
# that from here; estimate_cost_from_response just reports what the
# response's own usage.server_tool_use.web_search_requests says, which
# already reflects Anthropic's own billing decision.
WEB_SEARCH_USD_PER_CALL = 0.010


class UnknownModelPricingError(Exception):
    """Raised instead of silently costing an unpriced model at $0 -- a
    model added later without a pricing entry here must fail loudly, not
    bypass every cost guardrail that depends on this module."""


def get_pricing(model: str) -> dict:
    try:
        return PRICING_USD_PER_MTOK[model]
    except KeyError:
        raise UnknownModelPricingError(
            f"No USD pricing entry for model={model!r}. Add it to "
            f"PRICING_USD_PER_MTOK before any max_cost_usd guard can run "
            f"against this model."
        )


def estimate_cost_usd(
    model: str,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
    server_tool_use_web_search_requests: int = 0,
) -> float:
    """Pure function: USD cost implied by one API response's usage. No
    API calls, no side effects -- AgentLoop's per-iteration accounting
    and this module's own tests both call this directly."""
    rates = get_pricing(model)
    cost = (
        input_tokens * rates["input"]
        + output_tokens * rates["output"]
        + cache_creation_input_tokens * rates["cache_write"]
        + cache_read_input_tokens * rates["cache_read"]
    ) / 1_000_000
    cost += server_tool_use_web_search_requests * WEB_SEARCH_USD_PER_CALL
    return cost


def estimate_cost_from_response(model: str, response) -> float:
    """Defensively pulls every usage field off a live Messages API
    response. Field names (including the nested
    usage.server_tool_use.web_search_requests path) verified directly
    against Anthropic's documented example response shape, not assumed."""
    usage = getattr(response, "usage", None)
    if usage is None:
        return 0.0
    server_tool_use = getattr(usage, "server_tool_use", None)
    web_search_requests = getattr(server_tool_use, "web_search_requests", 0) or 0
    return estimate_cost_usd(
        model,
        input_tokens=getattr(usage, "input_tokens", 0) or 0,
        output_tokens=getattr(usage, "output_tokens", 0) or 0,
        cache_creation_input_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
        cache_read_input_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
        server_tool_use_web_search_requests=web_search_requests,
    )
