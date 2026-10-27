"""
AnthropicClientFactory — one authenticated, cached Anthropic client per cold
start, and one place to pick which model a capability uses.

Not the agent loop, not business logic — just "hand me a working client
without boilerplate." See agent_loop.py / structured_call.py for the actual
harness pieces that use this.
"""

import logging
import time

import anthropic
from anthropic import OverloadedError, RateLimitError

from .secrets import get_secret

logger = logging.getLogger(__name__)

# claude-sonnet-5: current default-tier model (confirmed against the
# installed anthropic SDK's live model catalog expectations at build time).
# claude-haiku-4-5: high-volume, low-complexity tasks (categorization) —
# no reason to pay default-tier price for those.
MODELS = {
    "DEFAULT": "claude-sonnet-5",
    "CATEGORIZATION": "claude-haiku-4-5",
}

# Current MCP connector beta flag. Anthropic has shipped three successive
# versions of this (mcp-client-2025-04-04, -2025-11-20, -2026-09-15) —
# always use the most recent; verified against the installed SDK's
# AnthropicBetaParam literal at the time this was written, not memorized.
MCP_CONNECTOR_BETA = "mcp-client-2026-09-15"

_client = None


def get_anthropic_client():
    """Returns a lazily-constructed, module-scoped singleton client.

    Built once per Lambda cold start, reused on warm invocations — same
    pattern as get_secret()'s own caching. The SDK's own `max_retries`
    handles 408/409/429/5xx automatically; claude_create_with_retry() in
    this package adds the application-level retry wheel_scan already needs
    on top of this, it does not replace it.
    """
    global _client
    if _client is None:
        api_key = get_secret("/finvault/anthropic/api-key")
        _client = anthropic.Anthropic(api_key=api_key, max_retries=2)
    return _client


# Matches wheel-scan's existing claude_create() wrapper (handler.py) exactly
# for RateLimitError — generalized here so every capability gets it, not
# just wheel_scan — plus OverloadedError (529), which the original didn't
# catch.
RATE_LIMIT_WINDOW_SECS = 65  # wait this long after a 429 to let the 1-min window reset
RATE_LIMIT_MAX_RETRIES = 4  # 4 retries x 65s = ~4 min max wait per call


def claude_create_with_retry(client, use_beta=False, **kwargs):
    """Wrapper around client.messages.create (or client.beta.messages.create
    when use_beta=True, needed for mcp_servers/betas params) that retries on
    429 rate-limit and 529 overloaded errors.

    This is the application-level retry wheel_scan already needs for its
    deliberate inter-stage sleep pattern on an unattended weekly batch job —
    it extends, not replaces, the SDK's own built-in retry (max_retries on
    the client handles 408/409/5xx transparently already).

    Cost accounting note: a rejected 429/529 attempt produces no response
    object and is not billed by Anthropic, so AgentLoop's cost tracking
    (pricing.estimate_cost_from_response) only ever runs against the one
    attempt that actually succeeded here -- no separate handling needed
    for retries.
    """
    create_fn = client.beta.messages.create if use_beta else client.messages.create
    for attempt in range(RATE_LIMIT_MAX_RETRIES + 1):
        try:
            return create_fn(**kwargs)
        except (RateLimitError, OverloadedError) as e:
            if attempt == RATE_LIMIT_MAX_RETRIES:
                raise
            wait = RATE_LIMIT_WINDOW_SECS * (attempt + 1)
            logger.warning(
                "%s hit (attempt %d), waiting %ds before retry...",
                type(e).__name__, attempt + 1, wait,
            )
            time.sleep(wait)
