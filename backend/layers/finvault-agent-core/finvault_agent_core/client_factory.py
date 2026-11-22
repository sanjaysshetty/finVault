"""
AnthropicClientFactory — one authenticated, cached Anthropic client per cold
start, and one place to pick which model a capability uses.

Not business logic — just "hand me a working client without boilerplate."
See structured_call.py for the harness piece that uses this.
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

_client = None


def get_anthropic_client():
    """Returns a lazily-constructed, module-scoped singleton client.

    Built once per Lambda cold start, reused on warm invocations — same
    pattern as get_secret()'s own caching. The SDK's own `max_retries`
    handles 408/409/429/5xx automatically; claude_create_with_retry() in
    this package adds an application-level retry on top of this, it does
    not replace it.
    """
    global _client
    if _client is None:
        api_key = get_secret("/finvault/anthropic/api-key")
        _client = anthropic.Anthropic(api_key=api_key, max_retries=2)
    return _client


RATE_LIMIT_WINDOW_SECS = 65  # wait this long after a 429 to let the 1-min window reset
RATE_LIMIT_MAX_RETRIES = 4  # 4 retries x 65s = ~4 min max wait per call


def claude_create_with_retry(client, **kwargs):
    """Wrapper around client.messages.create that retries on 429
    rate-limit and 529 overloaded errors.

    Cost note: a rejected 429/529 attempt produces no response object and
    is not billed by Anthropic -- no separate handling needed for retries.
    """
    for attempt in range(RATE_LIMIT_MAX_RETRIES + 1):
        try:
            return client.messages.create(**kwargs)
        except (RateLimitError, OverloadedError) as e:
            if attempt == RATE_LIMIT_MAX_RETRIES:
                raise
            wait = RATE_LIMIT_WINDOW_SECS * (attempt + 1)
            logger.warning(
                "%s hit (attempt %d), waiting %ds before retry...",
                type(e).__name__, attempt + 1, wait,
            )
            time.sleep(wait)
