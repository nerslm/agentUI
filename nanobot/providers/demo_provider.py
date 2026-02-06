"""Deterministic provider for UI demo flows."""

from __future__ import annotations

import uuid
from typing import Any

from nanobot.providers.base import LLMProvider, LLMResponse, ToolCallRequest


class DemoProvider(LLMProvider):
    """LLM provider that emits a predictable tool-call sequence."""

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        model: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.7,
    ) -> LLMResponse:
        # If this is a subagent, return a concise completion without tools.
        for message in messages:
            if message.get("role") == "system" and "Subagent" in str(message.get("content")):
                return LLMResponse(
                    content="Subagent completed a quick scan and found everything in order.",
                    tool_calls=[],
                )

        if any(message.get("role") == "tool" for message in messages):
            return LLMResponse(
                content="Demo completed: listed files and spawned a background task.",
                tool_calls=[],
            )

        tool_calls = [
            ToolCallRequest(
                id=str(uuid.uuid4()),
                name="list_dir",
                arguments={"path": "."},
            ),
            ToolCallRequest(
                id=str(uuid.uuid4()),
                name="spawn",
                arguments={
                    "task": "Summarize the top-level files and suggest one cleanup improvement.",
                    "label": "workspace scan",
                },
            ),
        ]

        return LLMResponse(
            content="Running demo tools...",
            tool_calls=tool_calls,
        )

    def get_default_model(self) -> str:
        return "demo"
