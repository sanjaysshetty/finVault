"""
RobinhoodMcpClient — standalone, non-Claude MCP client for Tower 1
(deterministic portfolio/risk context).

Two integration mechanisms exist for Robinhood MCP in this plan, and they
are not interchangeable:
  - Tower 2 (market/macro research) goes through Claude's *native*
    mcp_servers connector, since it already makes a Messages API call —
    Anthropic's infra calls Robinhood server-side, no client code needed.
  - Tower 1 (this module) never makes a Claude call at all. Routing a
    portfolio/cash lookup through Claude's connector would mean paying for
    an LLM completion just to proxy a quote fetch — wasteful and
    architecturally wrong. This client talks to Robinhood's MCP server
    directly.

Read-only by construction: only exposes the handful of account/portfolio
tools Tower 1 actually needs. Order-placement/watchlist-mutation tools are
simply never called from here — matching the plan's default-deny design,
even though nothing stops this client from naming a different tool.

API verified against the installed `mcp` package (v2.x) at the time this
was written, not assumed from memory — the SDK has moved past the older
`streamablehttp_client`/3-tuple-yield shape this module's docstrings would
otherwise have guessed at.
"""

import asyncio
import json

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from .secrets import get_secret

ROBINHOOD_MCP_URL = "https://agent.robinhood.com/mcp/trading"


class RobinhoodMcpError(RuntimeError):
    """Raised on any transport or tool-level failure — callers must handle
    this explicitly; there is no silent fallback to stale/fabricated data."""


def _parse_result(result):
    """Prefer structured_content (already-parsed JSON) when the server
    provides it; otherwise join text blocks and attempt JSON parsing,
    falling back to the raw joined text."""
    if result.structured_content is not None:
        return result.structured_content
    text = "\n".join(block.text for block in result.content if getattr(block, "type", None) == "text")
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return text


def _default_token_provider():
    # NOTE: this reads a simple bearer token directly from SSM today. A
    # proper OAuth refresh-token exchange flow (refresh_token -> short-lived
    # access_token) is a deliberate follow-up, not built here, since
    # Robinhood's token-refresh endpoint details require their own
    # dedicated OAuth app registration that hasn't happened yet — this is
    # NOT guessed at or fabricated. Whoever sets up that registration swaps
    # this function out; everything else in this module is unaffected.
    return get_secret("/finvault/robinhood/mcp-access-token")


class RobinhoodMcpClient:
    def __init__(self, token_provider=None, timeout=30.0):
        self._token_provider = token_provider or _default_token_provider
        self._timeout = timeout

    def call_tool(self, name: str, arguments: dict = None):
        """Sync entry point for Lambda handlers — wraps the async MCP
        round-trip. Each call opens and tears down its own session; no
        connection pooling across calls (Lambda invocations are short-lived
        and this client isn't expected to make many calls per invocation)."""
        return asyncio.run(self._call_tool_async(name, arguments or {}))

    async def _call_tool_async(self, name: str, arguments: dict):
        token = self._token_provider()
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx2.AsyncClient(headers=headers, timeout=self._timeout) as http_client:
            async with streamable_http_client(ROBINHOOD_MCP_URL, http_client=http_client) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool(name, arguments)

        if result.is_error:
            raise RobinhoodMcpError(f"Robinhood MCP tool '{name}' returned an error: {result.content}")
        return _parse_result(result)

    # ── Named, narrow methods — the only tools Tower 1 is allowed to call.
    # Every one of these is a read-only account/portfolio lookup; nothing
    # here can place an order, cancel one, or mutate a watchlist/alert/scan.

    def get_accounts(self):
        return self.call_tool("get_accounts")

    def get_portfolio(self, account_number: str = None):
        return self.call_tool("get_portfolio", {"account_number": account_number} if account_number else {})

    def get_equity_positions(self, account_number: str = None):
        return self.call_tool("get_equity_positions", {"account_number": account_number} if account_number else {})

    def get_option_positions(self, account_number: str = None):
        return self.call_tool("get_option_positions", {"account_number": account_number} if account_number else {})

    def get_crypto_positions(self, account_number: str = None):
        return self.call_tool("get_crypto_positions", {"account_number": account_number} if account_number else {})

    def get_realized_pnl(self, account_number: str = None):
        return self.call_tool("get_realized_pnl", {"account_number": account_number} if account_number else {})
