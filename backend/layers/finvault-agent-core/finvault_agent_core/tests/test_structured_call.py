"""
Unit tests for structured_call.py. The Anthropic client is fully mocked.

Run with: python3 -m unittest finvault_agent_core.tests.test_structured_call -v
(from backend/layers/finvault-agent-core/)
"""

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock

from finvault_agent_core.structured_call import structured_call


def _tool_use_block(name, tool_input):
    return SimpleNamespace(type="tool_use", name=name, input=tool_input)


def _text_block(text):
    return SimpleNamespace(type="text", text=text)


class TestStructuredCall(unittest.TestCase):
    def test_returns_tool_input_on_success(self):
        client = MagicMock()
        client.messages.create.return_value = SimpleNamespace(
            content=[_tool_use_block("record_result", {"category": "Groceries"})],
            usage=SimpleNamespace(input_tokens=10, output_tokens=5),
        )

        result = structured_call(
            system_prompt="sys", user_message="classify this",
            output_schema={"type": "object", "properties": {"category": {"type": "string"}}},
            client=client,
        )

        self.assertEqual(result, {"category": "Groceries"})

    def test_forces_tool_choice_and_strict_mode(self):
        client = MagicMock()
        client.messages.create.return_value = SimpleNamespace(
            content=[_tool_use_block("record_result", {})],
            usage=SimpleNamespace(input_tokens=1, output_tokens=1),
        )

        structured_call(
            system_prompt="sys", user_message="hi",
            output_schema={"type": "object"},
            tool_name="record_result",
            client=client,
        )

        call_kwargs = client.messages.create.call_args.kwargs
        self.assertEqual(call_kwargs["tool_choice"], {"type": "tool", "name": "record_result"})
        self.assertTrue(call_kwargs["tools"][0]["strict"])
        self.assertEqual(call_kwargs["tools"][0]["name"], "record_result")

    def test_uses_custom_tool_name(self):
        client = MagicMock()
        client.messages.create.return_value = SimpleNamespace(
            content=[_tool_use_block("categorize_items", {"ok": True})],
            usage=SimpleNamespace(input_tokens=1, output_tokens=1),
        )

        result = structured_call(
            system_prompt="sys", user_message="hi", output_schema={"type": "object"},
            tool_name="categorize_items", client=client,
        )
        self.assertEqual(result, {"ok": True})

    def test_raises_if_forced_tool_missing_from_response(self):
        # Shouldn't happen with tool_choice forced, but must not silently
        # return None/garbage if it ever does.
        client = MagicMock()
        client.messages.create.return_value = SimpleNamespace(
            content=[_text_block("I refuse to use the tool")],
            usage=SimpleNamespace(input_tokens=1, output_tokens=1),
        )

        with self.assertRaises(RuntimeError):
            structured_call(system_prompt="sys", user_message="hi", output_schema={"type": "object"}, client=client)

    def test_passes_model_override(self):
        client = MagicMock()
        client.messages.create.return_value = SimpleNamespace(
            content=[_tool_use_block("record_result", {})],
            usage=SimpleNamespace(input_tokens=1, output_tokens=1),
        )
        structured_call(
            system_prompt="sys", user_message="hi", output_schema={"type": "object"},
            model="claude-haiku-4-5", client=client,
        )
        self.assertEqual(client.messages.create.call_args.kwargs["model"], "claude-haiku-4-5")


if __name__ == "__main__":
    unittest.main()
