"""
AgentLoop — the manual multi-turn tool-use loop shared by every genuinely
agentic capability (Opportunity Engine's Tower 2, Deep Dive).

Generalizes the loop already running correctly in
backend/ai-services/wheel-scan/handler.py (its web_search `pause_turn`
handling is correct, per Anthropic's documented behavior, and is the
reference this implementation follows) — hardened with explicit
stop_reason handling, per-tool error isolation, a wall-clock deadline
guard alongside the iteration cap, a token-budget guard, and structured
per-step logging.

No LangGraph: tool selection happens inside the Anthropic API call itself,
identical either way — this loop just owns the orchestration, with no
framework dependency, since every run completes inside one Lambda
invocation (no cross-process pause/resume, no multi-agent routing).
"""

import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from .client_factory import MCP_CONNECTOR_BETA, MODELS, claude_create_with_retry, get_anthropic_client

logger = logging.getLogger(__name__)

# Terminal stop_reason values that end a run without further tool calls.
# `model_context_window_exceeded` and `refusal` are current Anthropic
# Messages API stop_reason values (verified against the installed SDK's
# Message type at the time this was written) — both must be surfaced
# distinctly, never silently treated as a normal completion.
_TERMINAL_STOP_REASONS = {"end_turn", "max_tokens", "refusal", "model_context_window_exceeded"}


@dataclass(frozen=True)
class ToolSpec:
    """One entry in an AgentLoop's tool registry.

    category is pure logging/golden-set-routing metadata (distinguishing
    deterministic_compute tools like simulate_scenario from data_fetch and
    reasoning_aid tools) — not a behavioral gate.

    requires_confirmation marks a tool as needing an explicit human
    confirmation step before the *caller* commits its effect (e.g.
    approve_scenario) — AgentLoop itself does not enforce this; it is
    reserved metadata for the calling Lambda to check, so a future
    execution-capable tool doesn't need a registry-shape retrofit.
    """

    name: str
    description: str
    input_schema: dict
    fn: Callable[..., Any]
    requires_confirmation: bool = False
    category: str = "data_fetch"  # "data_fetch" | "deterministic_compute" | "reasoning_aid"

    def to_anthropic_schema(self) -> dict:
        return {"name": self.name, "description": self.description, "input_schema": self.input_schema}


@dataclass
class AgentResult:
    status: str  # "done" | "max_iterations_exceeded" | "deadline_exceeded" | "budget_exceeded"
    #              | "refusal" | "max_tokens" | "model_context_window_exceeded" | "unknown_stop_reason"
    messages: list
    iterations: int
    final_response: Optional[Any] = None
    total_input_tokens: int = 0
    total_output_tokens: int = 0

    @property
    def final_text(self) -> Optional[str]:
        """Convenience accessor for the final assistant turn's text, if any."""
        if not self.final_response:
            return None
        texts = [b.text for b in self.final_response.content if getattr(b, "type", None) == "text"]
        return "\n".join(texts) if texts else None


class AgentLoop:
    def __init__(
        self,
        system_prompt: str,
        tools: list,
        model: Optional[str] = None,
        client=None,
        max_iterations: int = 10,
        deadline_seconds: float = 240.0,
        max_total_tokens: Optional[int] = 200_000,
        max_tokens: int = 4096,
        mcp_servers: Optional[list] = None,
    ):
        self.system_prompt = system_prompt
        self.tools = {t.name: t for t in tools}
        self.model = model or MODELS["DEFAULT"]
        self.client = client or get_anthropic_client()
        self.max_iterations = max_iterations
        self.deadline_seconds = deadline_seconds
        self.max_total_tokens = max_total_tokens
        self.max_tokens = max_tokens
        self.mcp_servers = mcp_servers
        self._system_prompt_hash = hashlib.sha256(system_prompt.encode("utf-8")).hexdigest()[:12]

    def run(self, messages: list, request_id: Optional[str] = None) -> AgentResult:
        messages = list(messages)
        deadline = time.monotonic() + self.deadline_seconds
        tool_schemas = [t.to_anthropic_schema() for t in self.tools.values()]
        total_input_tokens = 0
        total_output_tokens = 0

        for iteration in range(1, self.max_iterations + 1):
            if time.monotonic() > deadline:
                return AgentResult("deadline_exceeded", messages, iteration - 1, None, total_input_tokens, total_output_tokens)
            if self.max_total_tokens is not None and (total_input_tokens + total_output_tokens) >= self.max_total_tokens:
                return AgentResult("budget_exceeded", messages, iteration - 1, None, total_input_tokens, total_output_tokens)

            kwargs = dict(
                model=self.model,
                max_tokens=self.max_tokens,
                system=self.system_prompt,
                messages=messages,
                tools=tool_schemas,
            )
            use_beta = bool(self.mcp_servers)
            if self.mcp_servers:
                kwargs["mcp_servers"] = self.mcp_servers
                kwargs["betas"] = [MCP_CONNECTOR_BETA]

            response = claude_create_with_retry(self.client, use_beta=use_beta, **kwargs)

            if response.usage:
                total_input_tokens += response.usage.input_tokens or 0
                total_output_tokens += response.usage.output_tokens or 0

            self._log_step(request_id, iteration, messages, response)

            stop_reason = response.stop_reason

            if stop_reason == "end_turn":
                messages.append({"role": "assistant", "content": response.content})
                return AgentResult("done", messages, iteration, response, total_input_tokens, total_output_tokens)

            if stop_reason == "pause_turn":
                # Server-side tool (e.g. web_search) paused mid-turn — resend
                # as-is, no extra "Continue" user turn. This is the exact
                # behavior wheel_scan's existing loop already gets right.
                messages.append({"role": "assistant", "content": response.content})
                continue

            if stop_reason == "tool_use":
                messages.append({"role": "assistant", "content": response.content})
                tool_results = [
                    self._execute_tool(block) for block in response.content if getattr(block, "type", None) == "tool_use"
                ]
                messages.append({"role": "user", "content": tool_results})
                continue

            if stop_reason in _TERMINAL_STOP_REASONS:
                return AgentResult(stop_reason, messages, iteration, response, total_input_tokens, total_output_tokens)

            # Unrecognized/None stop_reason — stop and surface distinctly,
            # never treat an unexpected value as success.
            return AgentResult("unknown_stop_reason", messages, iteration, response, total_input_tokens, total_output_tokens)

        return AgentResult("max_iterations_exceeded", messages, self.max_iterations, None, total_input_tokens, total_output_tokens)

    def _execute_tool(self, block) -> dict:
        tool = self.tools.get(block.name)
        if tool is None:
            return {
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": f"Unknown tool: {block.name}",
                "is_error": True,
            }
        try:
            result = tool.fn(**(block.input or {}))
            content = result if isinstance(result, str) else json.dumps(result, default=str)
            return {"type": "tool_result", "tool_use_id": block.id, "content": content}
        except Exception as e:  # noqa: BLE001 — any tool exception becomes an is_error result, never a silent no-op
            return {
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": f"{type(e).__name__}: {e}",
                "is_error": True,
            }

    def _log_step(self, request_id, iteration, messages, response):
        logger.info(json.dumps({
            "request_id": request_id,
            "iteration": iteration,
            "system_prompt_hash": self._system_prompt_hash,
            "model": self.model,
            "messages_sent": messages,
            "tool_names_offered": list(self.tools.keys()),
            "stop_reason": response.stop_reason,
            "usage": {
                "input_tokens": response.usage.input_tokens if response.usage else None,
                "output_tokens": response.usage.output_tokens if response.usage else None,
            },
        }, default=str))
