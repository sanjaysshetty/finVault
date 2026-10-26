"""
Unit tests for robinhood_mcp.py.

No live Robinhood credentials exist yet (the finVault-specific OAuth grant
is a separate, not-yet-completed setup step — see robinhood_mcp.py's
_default_token_provider docstring). These tests verify finVault's own
logic in three tiers instead of a live round-trip:
  1. _parse_result's pure parsing logic, directly.
  2. Each named method delegates to call_tool with the correct tool name
     and argument shape (catches "wrong tool name"/"wrong arg key" bugs
     without touching the transport at all).
  3. The full async round-trip through _call_tool_async, with the MCP
     transport (streamable_http_client/ClientSession) and httpx2 client
     mocked at their import sites — verifies the Authorization header is
     built correctly and that is_error responses raise, without a live
     server.

Run with: python3 -m unittest finvault_agent_core.tests.test_robinhood_mcp -v
(from backend/layers/finvault-agent-core/)
"""

import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from finvault_agent_core.robinhood_mcp import RobinhoodMcpClient, RobinhoodMcpError, _parse_result


def _text_block(text):
    return SimpleNamespace(type="text", text=text)


def _result(content=None, structured_content=None, is_error=False):
    return SimpleNamespace(content=content or [], structured_content=structured_content, is_error=is_error)


class TestParseResult(unittest.TestCase):
    def test_prefers_structured_content(self):
        result = _result(content=[_text_block("ignored")], structured_content={"cash": 500})
        self.assertEqual(_parse_result(result), {"cash": 500})

    def test_falls_back_to_json_parsing_text(self):
        result = _result(content=[_text_block('{"cash": 500}')])
        self.assertEqual(_parse_result(result), {"cash": 500})

    def test_falls_back_to_raw_text_when_not_json(self):
        result = _result(content=[_text_block("no positions found")])
        self.assertEqual(_parse_result(result), "no positions found")

    def test_joins_multiple_text_blocks(self):
        result = _result(content=[_text_block("line1"), _text_block("line2")])
        self.assertEqual(_parse_result(result), "line1\nline2")

    def test_ignores_non_text_blocks(self):
        image_block = SimpleNamespace(type="image", data="base64...")
        result = _result(content=[image_block, _text_block('{"ok": true}')])
        self.assertEqual(_parse_result(result), {"ok": True})


class TestNamedMethodsDelegateCorrectly(unittest.TestCase):
    def setUp(self):
        self.client = RobinhoodMcpClient(token_provider=lambda: "fake-token")
        self.client.call_tool = MagicMock(return_value={"ok": True})

    def test_get_accounts(self):
        self.client.get_accounts()
        self.client.call_tool.assert_called_once_with("get_accounts")

    def test_get_portfolio_without_account_number(self):
        self.client.get_portfolio()
        self.client.call_tool.assert_called_once_with("get_portfolio", {})

    def test_get_portfolio_with_account_number(self):
        self.client.get_portfolio(account_number="ACC123")
        self.client.call_tool.assert_called_once_with("get_portfolio", {"account_number": "ACC123"})

    def test_get_equity_positions(self):
        self.client.get_equity_positions(account_number="ACC123")
        self.client.call_tool.assert_called_once_with("get_equity_positions", {"account_number": "ACC123"})

    def test_get_option_positions(self):
        self.client.get_option_positions()
        self.client.call_tool.assert_called_once_with("get_option_positions", {})

    def test_get_crypto_positions(self):
        self.client.get_crypto_positions()
        self.client.call_tool.assert_called_once_with("get_crypto_positions", {})

    def test_get_realized_pnl(self):
        self.client.get_realized_pnl(account_number="ACC123")
        self.client.call_tool.assert_called_once_with("get_realized_pnl", {"account_number": "ACC123"})


class _FakeAsyncCM:
    """Minimal async context manager wrapper for mocking `async with X() as y`."""

    def __init__(self, value):
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, *exc_info):
        return False


class TestCallToolAsyncRoundTrip(unittest.TestCase):
    def _mock_transport(self, call_tool_result, mock_httpx_client_cls, mock_streamable_http, mock_client_session_cls):
        fake_http_client = MagicMock()
        mock_httpx_client_cls.return_value = _FakeAsyncCM(fake_http_client)

        mock_streamable_http.return_value = _FakeAsyncCM(("read_stream", "write_stream"))

        fake_session = MagicMock()
        fake_session.initialize = AsyncMock(return_value=None)
        fake_session.call_tool = AsyncMock(return_value=call_tool_result)
        mock_client_session_cls.return_value = _FakeAsyncCM(fake_session)

        return fake_http_client, fake_session

    @patch("finvault_agent_core.robinhood_mcp.ClientSession")
    @patch("finvault_agent_core.robinhood_mcp.streamable_http_client")
    @patch("finvault_agent_core.robinhood_mcp.httpx2.AsyncClient")
    def test_successful_call_returns_parsed_result(self, mock_httpx_client_cls, mock_streamable_http, mock_client_session_cls):
        result = _result(structured_content={"buying_power": 1000.0})
        self._mock_transport(result, mock_httpx_client_cls, mock_streamable_http, mock_client_session_cls)

        client = RobinhoodMcpClient(token_provider=lambda: "my-token")
        value = client.call_tool("get_portfolio", {})

        self.assertEqual(value, {"buying_power": 1000.0})
        # Authorization header built from the injected token provider.
        call_kwargs = mock_httpx_client_cls.call_args.kwargs
        self.assertEqual(call_kwargs["headers"]["Authorization"], "Bearer my-token")

    @patch("finvault_agent_core.robinhood_mcp.ClientSession")
    @patch("finvault_agent_core.robinhood_mcp.streamable_http_client")
    @patch("finvault_agent_core.robinhood_mcp.httpx2.AsyncClient")
    def test_is_error_raises_robinhood_mcp_error(self, mock_httpx_client_cls, mock_streamable_http, mock_client_session_cls):
        result = _result(content=[_text_block("insufficient permissions")], is_error=True)
        self._mock_transport(result, mock_httpx_client_cls, mock_streamable_http, mock_client_session_cls)

        client = RobinhoodMcpClient(token_provider=lambda: "my-token")
        with self.assertRaises(RobinhoodMcpError):
            client.call_tool("get_accounts")

    @patch("finvault_agent_core.robinhood_mcp.ClientSession")
    @patch("finvault_agent_core.robinhood_mcp.streamable_http_client")
    @patch("finvault_agent_core.robinhood_mcp.httpx2.AsyncClient")
    def test_session_initialized_before_call_tool(self, mock_httpx_client_cls, mock_streamable_http, mock_client_session_cls):
        result = _result(structured_content={})
        _, fake_session = self._mock_transport(result, mock_httpx_client_cls, mock_streamable_http, mock_client_session_cls)

        client = RobinhoodMcpClient(token_provider=lambda: "tok")
        client.call_tool("get_accounts")

        fake_session.initialize.assert_awaited_once()
        fake_session.call_tool.assert_awaited_once_with("get_accounts", {})


if __name__ == "__main__":
    unittest.main()
