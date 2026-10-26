"""
StructuredCall — single-shot structured-output helper for non-looping
services (categorization now; receipt/tax extractors in a later phase).

Uses forced tool_choice + strict:true (GA, not beta) rather than
output_config.format / client.messages.parse()'s output_format
convenience. Verified by reading the installed SDK's own source: parse()
only populates response.parsed_output when output_format is passed as an
actual Python type (dataclass/TypedDict/pydantic model) that it runs
through pydantic's TypeAdapter — passing only a raw JSON-schema dict via
output_config leaves output_format unset internally, so parsed_output
would always be None. Every schema already in this codebase (AgentLoop's
ToolSpec, MCP server configs) is a plain dict, and forced tool_choice is
the exact mechanism already proven elsewhere here to handle enum
constraints correctly (every Tower-2 tool's input_schema already relies
on this) — so this stays consistent with that rather than introducing a
second, type-based schema style for one new consumer.
"""

import logging

from .client_factory import MODELS, claude_create_with_retry, get_anthropic_client

logger = logging.getLogger(__name__)


def structured_call(
    system_prompt,
    user_message,
    output_schema,
    tool_name="record_result",
    tool_description="Record the structured result.",
    model=None,
    client=None,
    max_tokens=1024,
):
    """
    Single-shot structured output via forced tool_choice + strict:true.

    Returns the validated dict matching output_schema (the model's
    tool_use input — already schema-conformant by construction, since
    tool_choice is forced and strict mode is on). Raises RuntimeError if
    the forced tool somehow doesn't appear in the response — defensively
    checked rather than assumed, even though tool_choice being forced
    should make this unreachable in practice.
    """
    client = client or get_anthropic_client()
    tool = {
        "name": tool_name,
        "description": tool_description,
        "input_schema": output_schema,
        "strict": True,
    }
    response = claude_create_with_retry(
        client,
        model=model or MODELS["DEFAULT"],
        max_tokens=max_tokens,
        system=system_prompt,
        messages=[{"role": "user", "content": user_message}],
        tools=[tool],
        tool_choice={"type": "tool", "name": tool_name},
    )
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == tool_name:
            return block.input
    raise RuntimeError(f"Expected a forced '{tool_name}' tool_use block but none was found in the response")
