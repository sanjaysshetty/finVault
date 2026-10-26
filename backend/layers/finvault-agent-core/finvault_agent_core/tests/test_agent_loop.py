"""
Unit tests for agent_loop.py. The Anthropic client is fully mocked — these
tests verify AgentLoop's own orchestration logic (stop_reason branching,
tool execution/error isolation, iteration/deadline/budget guards), not the
Anthropic API itself.

Run with: python3 -m unittest finvault_agent_core.tests.test_agent_loop -v
(from backend/layers/finvault-agent-core/)
"""

import copy
import time
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock

from finvault_agent_core.agent_loop import AgentLoop, ToolSpec


def _usage(input_tokens=100, output_tokens=50):
    return SimpleNamespace(input_tokens=input_tokens, output_tokens=output_tokens)


def _text_block(text):
    return SimpleNamespace(type="text", text=text)


def _tool_use_block(name, tool_input, block_id="tu_1"):
    return SimpleNamespace(type="tool_use", name=name, input=tool_input, id=block_id)


def _response(stop_reason, content, usage=None):
    return SimpleNamespace(stop_reason=stop_reason, content=content, usage=usage or _usage())


def _recording_side_effect(responses):
    """AgentLoop mutates its working `messages` list in place across
    iterations, so MagicMock's call_args_list ends up holding the SAME
    object reference for every call, not a snapshot. This records a deep
    copy of the messages argument at the moment each call actually
    happens, so later calls' mutations can't retroactively corrupt what
    an earlier call was invoked with."""
    seen = []
    responses_iter = iter(responses)

    def _effect(**kwargs):
        seen.append(copy.deepcopy(kwargs["messages"]))
        return next(responses_iter)

    return _effect, seen


def _make_tool(name="get_quote", fn=None, **kwargs):
    return ToolSpec(
        name=name,
        description="test tool",
        input_schema={"type": "object", "properties": {}},
        fn=fn or (lambda **kw: {"price": 100}),
        **kwargs,
    )


class TestEndTurn(unittest.TestCase):
    def test_single_call_end_turn(self):
        client = MagicMock()
        client.messages.create.return_value = _response("end_turn", [_text_block("hello")])
        loop = AgentLoop(system_prompt="sys", tools=[_make_tool()], client=client, model="claude-sonnet-5")

        result = loop.run([{"role": "user", "content": "hi"}])

        self.assertEqual(result.status, "done")
        self.assertEqual(result.iterations, 1)
        self.assertEqual(result.final_text, "hello")
        client.messages.create.assert_called_once()
        client.beta.messages.create.assert_not_called()


class TestToolUse(unittest.TestCase):
    def test_tool_use_then_end_turn(self):
        client = MagicMock()
        effect, seen = _recording_side_effect([
            _response("tool_use", [_tool_use_block("get_quote", {"symbol": "AAPL"})]),
            _response("end_turn", [_text_block("AAPL is $100")]),
        ])
        client.messages.create.side_effect = effect
        tool_fn = MagicMock(return_value={"price": 100})
        loop = AgentLoop(system_prompt="sys", tools=[_make_tool(fn=tool_fn)], client=client)

        result = loop.run([{"role": "user", "content": "what's AAPL at?"}])

        self.assertEqual(result.status, "done")
        self.assertEqual(result.iterations, 2)
        tool_fn.assert_called_once_with(symbol="AAPL")
        # tool_result should be appended as a user turn before the 2nd call
        tool_result_turn = seen[1][-1]
        self.assertEqual(tool_result_turn["role"], "user")
        self.assertEqual(tool_result_turn["content"][0]["type"], "tool_result")
        self.assertNotIn("is_error", tool_result_turn["content"][0])

    def test_unregistered_tool_is_error_not_silent(self):
        client = MagicMock()
        effect, seen = _recording_side_effect([
            _response("tool_use", [_tool_use_block("nonexistent_tool", {})]),
            _response("end_turn", [_text_block("done")]),
        ])
        client.messages.create.side_effect = effect
        loop = AgentLoop(system_prompt="sys", tools=[_make_tool()], client=client)

        result = loop.run([{"role": "user", "content": "hi"}])

        tool_result = seen[1][-1]["content"][0]
        self.assertTrue(tool_result["is_error"])
        self.assertIn("Unknown tool", tool_result["content"])
        self.assertEqual(result.status, "done")  # loop still completes, error is isolated to the tool_result

    def test_tool_exception_is_error_not_silent(self):
        def raising_fn(**kw):
            raise ValueError("boom")

        client = MagicMock()
        effect, seen = _recording_side_effect([
            _response("tool_use", [_tool_use_block("get_quote", {})]),
            _response("end_turn", [_text_block("done")]),
        ])
        client.messages.create.side_effect = effect
        loop = AgentLoop(system_prompt="sys", tools=[_make_tool(fn=raising_fn)], client=client)

        loop.run([{"role": "user", "content": "hi"}])

        tool_result = seen[1][-1]["content"][0]
        self.assertTrue(tool_result["is_error"])
        self.assertIn("ValueError: boom", tool_result["content"])

    def test_parallel_tool_use_both_executed(self):
        client = MagicMock()
        effect, seen = _recording_side_effect([
            _response("tool_use", [
                _tool_use_block("get_quote", {"symbol": "AAPL"}, block_id="tu_1"),
                _tool_use_block("get_quote", {"symbol": "MSFT"}, block_id="tu_2"),
            ]),
            _response("end_turn", [_text_block("done")]),
        ])
        client.messages.create.side_effect = effect
        tool_fn = MagicMock(return_value={"price": 100})
        loop = AgentLoop(system_prompt="sys", tools=[_make_tool(fn=tool_fn)], client=client)

        loop.run([{"role": "user", "content": "compare AAPL and MSFT"}])

        self.assertEqual(tool_fn.call_count, 2)
        results = seen[1][-1]["content"]
        self.assertEqual(len(results), 2)
        self.assertEqual({r["tool_use_id"] for r in results}, {"tu_1", "tu_2"})


class TestPauseTurn(unittest.TestCase):
    def test_pause_turn_resends_without_extra_user_turn(self):
        client = MagicMock()
        effect, seen = _recording_side_effect([
            _response("pause_turn", [_text_block("searching...")]),
            _response("end_turn", [_text_block("found it")]),
        ])
        client.messages.create.side_effect = effect
        loop = AgentLoop(system_prompt="sys", tools=[_make_tool()], client=client)

        result = loop.run([{"role": "user", "content": "search for X"}])

        self.assertEqual(result.status, "done")
        # The 2nd call must have been sent with the pause_turn assistant
        # content as the last message — NOT a synthetic "Continue" user turn.
        second_call_messages = seen[1]
        self.assertEqual(second_call_messages[-1]["role"], "assistant")
        self.assertEqual(len(second_call_messages), 2)  # original user turn + pause_turn assistant turn, nothing injected


class TestTerminalStopReasons(unittest.TestCase):
    def test_refusal_surfaced_distinctly(self):
        client = MagicMock()
        client.messages.create.return_value = _response("refusal", [])
        loop = AgentLoop(system_prompt="sys", tools=[_make_tool()], client=client)
        result = loop.run([{"role": "user", "content": "hi"}])
        self.assertEqual(result.status, "refusal")

    def test_max_tokens_surfaced_distinctly(self):
        client = MagicMock()
        client.messages.create.return_value = _response("max_tokens", [_text_block("cut off")])
        loop = AgentLoop(system_prompt="sys", tools=[_make_tool()], client=client)
        result = loop.run([{"role": "user", "content": "hi"}])
        self.assertEqual(result.status, "max_tokens")

    def test_model_context_window_exceeded_surfaced_distinctly(self):
        client = MagicMock()
        client.messages.create.return_value = _response("model_context_window_exceeded", [])
        loop = AgentLoop(system_prompt="sys", tools=[_make_tool()], client=client)
        result = loop.run([{"role": "user", "content": "hi"}])
        self.assertEqual(result.status, "model_context_window_exceeded")

    def test_unknown_stop_reason_not_treated_as_success(self):
        client = MagicMock()
        client.messages.create.return_value = _response("some_future_value_we_dont_know", [])
        loop = AgentLoop(system_prompt="sys", tools=[_make_tool()], client=client)
        result = loop.run([{"role": "user", "content": "hi"}])
        self.assertEqual(result.status, "unknown_stop_reason")


class TestGuards(unittest.TestCase):
    def test_max_iterations_exceeded(self):
        client = MagicMock()
        # Always returns tool_use -> loop never naturally terminates.
        client.messages.create.return_value = _response("tool_use", [_tool_use_block("get_quote", {})])
        loop = AgentLoop(system_prompt="sys", tools=[_make_tool()], client=client, max_iterations=3)

        result = loop.run([{"role": "user", "content": "hi"}])

        self.assertEqual(result.status, "max_iterations_exceeded")
        self.assertEqual(result.iterations, 3)
        self.assertEqual(client.messages.create.call_count, 3)

    def test_deadline_exceeded(self):
        client = MagicMock()

        def slow_create(**kwargs):
            time.sleep(0.05)
            return _response("tool_use", [_tool_use_block("get_quote", {})])

        client.messages.create.side_effect = slow_create
        loop = AgentLoop(
            system_prompt="sys", tools=[_make_tool()], client=client,
            max_iterations=1000, deadline_seconds=0.12,
        )

        result = loop.run([{"role": "user", "content": "hi"}])

        self.assertEqual(result.status, "deadline_exceeded")
        self.assertLess(result.iterations, 1000)

    def test_budget_exceeded(self):
        client = MagicMock()
        client.messages.create.return_value = _response(
            "tool_use", [_tool_use_block("get_quote", {})], usage=_usage(input_tokens=1000, output_tokens=1000)
        )
        loop = AgentLoop(
            system_prompt="sys", tools=[_make_tool()], client=client,
            max_iterations=1000, max_total_tokens=2500,
        )

        result = loop.run([{"role": "user", "content": "hi"}])

        self.assertEqual(result.status, "budget_exceeded")
        # 2 iterations x 2000 tokens = 4000 >= 2500 budget -> stops before a 3rd call
        self.assertEqual(result.iterations, 2)
        self.assertEqual(client.messages.create.call_count, 2)


class TestMcpServers(unittest.TestCase):
    def test_mcp_servers_routes_through_beta_with_connector_flag(self):
        client = MagicMock()
        client.beta.messages.create.return_value = _response("end_turn", [_text_block("ok")])
        mcp_config = [{"type": "url", "url": "https://agent.robinhood.com/mcp/trading", "name": "robinhood",
                       "authorization_token": "tok", "tool_configuration": {"enabled": True, "allowed_tools": ["get_equity_quotes"]}}]
        loop = AgentLoop(system_prompt="sys", tools=[_make_tool()], client=client, mcp_servers=mcp_config)

        result = loop.run([{"role": "user", "content": "hi"}])

        self.assertEqual(result.status, "done")
        client.beta.messages.create.assert_called_once()
        client.messages.create.assert_not_called()
        call_kwargs = client.beta.messages.create.call_args.kwargs
        self.assertEqual(call_kwargs["mcp_servers"], mcp_config)
        self.assertIn("mcp-client-2026-09-15", call_kwargs["betas"])


class TestServerTools(unittest.TestCase):
    def test_server_tool_included_in_tools_array_without_fn(self):
        client = MagicMock()
        client.messages.create.return_value = _response("end_turn", [_text_block("ok")])
        web_search_tool = {"type": "web_search_20260209", "name": "web_search"}
        loop = AgentLoop(
            system_prompt="sys", tools=[_make_tool()], client=client,
            server_tools=[web_search_tool],
        )

        loop.run([{"role": "user", "content": "hi"}])

        sent_tools = client.messages.create.call_args.kwargs["tools"]
        self.assertIn(web_search_tool, sent_tools)
        # the local client-executed tool is still present alongside it
        self.assertTrue(any(t.get("name") == "get_quote" for t in sent_tools))

    def test_server_tool_result_blocks_not_sent_to_execute_tool(self):
        # A server_tool_use/web_search_tool_result block pair (type != "tool_use")
        # must not be mistaken for a client tool call needing execution.
        client = MagicMock()
        server_block = SimpleNamespace(type="server_tool_use", name="web_search", input={}, id="st_1")
        client.messages.create.side_effect = [
            _response("tool_use", [server_block, _tool_use_block("get_quote", {}, block_id="tu_1")]),
            _response("end_turn", [_text_block("done")]),
        ]
        tool_fn = MagicMock(return_value={"price": 100})
        loop = AgentLoop(
            system_prompt="sys", tools=[_make_tool(fn=tool_fn)], client=client,
            server_tools=[{"type": "web_search_20260209", "name": "web_search"}],
        )

        loop.run([{"role": "user", "content": "hi"}])

        # only the real client tool_use block gets executed
        tool_fn.assert_called_once()


if __name__ == "__main__":
    unittest.main()
