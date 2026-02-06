"""Subagent manager for background task execution."""

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

from loguru import logger

from nanobot.bus.events import InboundMessage
from nanobot.bus.queue import MessageBus
from nanobot.providers.base import LLMProvider
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.agent.tools.filesystem import ReadFileTool, WriteFileTool, ListDirTool
from nanobot.agent.tools.shell import ExecTool
from nanobot.agent.tools.web import WebSearchTool, WebFetchTool
from nanobot.telemetry import TelemetryEmitter, TelemetryNode


class SubagentManager:
    """
    Manages background subagent execution.
    
    Subagents are lightweight agent instances that run in the background
    to handle specific tasks. They share the same LLM provider but have
    isolated context and a focused system prompt.
    """
    
    def __init__(
        self,
        provider: LLMProvider,
        workspace: Path,
        bus: MessageBus,
        model: str | None = None,
        brave_api_key: str | None = None,
        exec_config: "ExecToolConfig | None" = None,
        max_tokens: int = 8192,
        temperature: float = 0.7,
        telemetry: TelemetryEmitter | None = None,
    ):
        from nanobot.config.schema import ExecToolConfig
        self.provider = provider
        self.workspace = workspace
        self.bus = bus
        self.model = model or provider.get_default_model()
        self.brave_api_key = brave_api_key
        self.exec_config = exec_config or ExecToolConfig()
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.telemetry = telemetry
        self._running_tasks: dict[str, asyncio.Task[None]] = {}
        self._spawn_parent_id: str | None = None

    def set_spawn_context(self, parent_node_id: str | None) -> None:
        """Attach telemetry parent for the next spawn call."""
        self._spawn_parent_id = parent_node_id

    async def _emit(
        self,
        event_type: str,
        session_key: str,
        node_id: str,
        node_type: str,
        parent_id: str | None,
        data: dict[str, Any] | None = None,
    ) -> None:
        if not self.telemetry:
            return
        await self.telemetry.emit(
            event_type=event_type,
            session_key=session_key,
            node=TelemetryNode(node_id=node_id, node_type=node_type, parent_id=parent_id),
            data=data or {},
        )
    
    async def spawn(
        self,
        task: str,
        label: str | None = None,
        origin_channel: str = "cli",
        origin_chat_id: str = "direct",
    ) -> str:
        """
        Spawn a subagent to execute a task in the background.
        
        Args:
            task: The task description for the subagent.
            label: Optional human-readable label for the task.
            origin_channel: The channel to announce results to.
            origin_chat_id: The chat ID to announce results to.
        
        Returns:
            Status message indicating the subagent was started.
        """
        task_id = str(uuid.uuid4())[:8]
        display_label = label or task[:30] + ("..." if len(task) > 30 else "")

        origin_session = f"{origin_channel}:{origin_chat_id}"
        await self._emit(
            event_type="subagent.spawned",
            session_key=origin_session,
            node_id=task_id,
            node_type="subagent",
            parent_id=self._spawn_parent_id,
            data={
                "task": task,
                "label": display_label,
                "origin": {
                    "channel": origin_channel,
                    "chat_id": origin_chat_id,
                },
            },
        )
        self._spawn_parent_id = None
        
        origin = {
            "channel": origin_channel,
            "chat_id": origin_chat_id,
        }
        
        # Create background task
        bg_task = asyncio.create_task(
            self._run_subagent(task_id, task, display_label, origin)
        )
        self._running_tasks[task_id] = bg_task
        
        # Cleanup when done
        bg_task.add_done_callback(lambda _: self._running_tasks.pop(task_id, None))
        
        logger.info(f"Spawned subagent [{task_id}]: {display_label}")
        return f"Subagent [{display_label}] started (id: {task_id}). I'll notify you when it completes."
    
    async def _run_subagent(
        self,
        task_id: str,
        task: str,
        label: str,
        origin: dict[str, str],
    ) -> None:
        """Execute the subagent task and announce the result."""
        logger.info(f"Subagent [{task_id}] starting task: {label}")
        session_key = f"subagent:{task_id}"

        # Emit initial task as a user message for UI transcript rendering.
        msg_node_id = f"msg:{uuid.uuid4().hex[:8]}"
        await self._emit(
            event_type="subagent.message.created",
            session_key=session_key,
            node_id=msg_node_id,
            node_type="message",
            parent_id=task_id,
            data={
                "role": "user",
                "content": task,
                "subagent": True,
            },
        )
        
        try:
            # Build subagent tools (no message tool, no spawn tool)
            tools = ToolRegistry()
            tools.register(ReadFileTool())
            tools.register(WriteFileTool())
            tools.register(ListDirTool())
            tools.register(ExecTool(
                working_dir=str(self.workspace),
                timeout=self.exec_config.timeout,
                restrict_to_workspace=self.exec_config.restrict_to_workspace,
            ))
            tools.register(WebSearchTool(api_key=self.brave_api_key))
            tools.register(WebFetchTool())
            
            # Build messages with subagent-specific prompt
            system_prompt = self._build_subagent_prompt(task)
            messages: list[dict[str, Any]] = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": task},
            ]
            
            # Run agent loop (limited iterations)
            max_iterations = 15
            iteration = 0
            final_result: str | None = None
            
            while iteration < max_iterations:
                iteration += 1

                llm_node_id = f"llm:{uuid.uuid4().hex[:8]}"
                await self._emit(
                    event_type="llm.request.started",
                    session_key=session_key,
                    node_id=llm_node_id,
                    node_type="llm",
                    parent_id=task_id,
                    data={
                        "model": self.model,
                        "messages_count": len(messages),
                        "iteration": iteration,
                        "subagent": True,
                    },
                )
                try:
                    response = await self.provider.chat(
                        messages=messages,
                        tools=tools.get_definitions(),
                        model=self.model,
                        max_tokens=self.max_tokens,
                        temperature=self.temperature,
                    )
                except Exception as e:
                    await self._emit(
                        event_type="error.raised",
                        session_key=session_key,
                        node_id=llm_node_id,
                        node_type="llm",
                        parent_id=task_id,
                        data={
                            "error": str(e),
                            "stage": "llm.request",
                            "subagent": True,
                        },
                    )
                    raise
                await self._emit(
                    event_type="llm.request.finished",
                    session_key=session_key,
                    node_id=llm_node_id,
                    node_type="llm",
                    parent_id=task_id,
                    data={
                        "finish_reason": response.finish_reason,
                        "has_tool_calls": response.has_tool_calls,
                        "tool_call_count": len(response.tool_calls),
                        "usage": response.usage,
                        "subagent": True,
                    },
                )

                # Emit assistant message content for UI transcript rendering.
                # Note: this is intentionally the natural-language portion only.
                asst_msg_node_id = f"msg:{uuid.uuid4().hex[:8]}"
                await self._emit(
                    event_type="subagent.message.created",
                    session_key=session_key,
                    node_id=asst_msg_node_id,
                    node_type="message",
                    parent_id=task_id,
                    data={
                        "role": "assistant",
                        "content": response.content or "",
                        "iteration": iteration,
                        "subagent": True,
                    },
                )
                
                if response.has_tool_calls:
                    # Add assistant message with tool calls
                    tool_call_dicts = [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": json.dumps(tc.arguments),
                            },
                        }
                        for tc in response.tool_calls
                    ]
                    messages.append({
                        "role": "assistant",
                        "content": response.content or "",
                        "tool_calls": tool_call_dicts,
                    })
                    
                    # Execute tools
                    for tool_call in response.tool_calls:
                        args_str = json.dumps(tool_call.arguments)
                        logger.debug(f"Subagent [{task_id}] executing: {tool_call.name} with arguments: {args_str}")
                        tool_node_id = f"tool:{tool_call.id}"
                        await self._emit(
                            event_type="tool.call.started",
                            session_key=session_key,
                            node_id=tool_node_id,
                            node_type="tool",
                            parent_id=llm_node_id,
                            data={
                                "tool_name": tool_call.name,
                                "arguments": tool_call.arguments,
                                "subagent": True,
                            },
                        )
                        try:
                            result = await tools.execute(tool_call.name, tool_call.arguments)
                            await self._emit(
                                event_type="tool.call.finished",
                                session_key=session_key,
                                node_id=tool_node_id,
                                node_type="tool",
                                parent_id=llm_node_id,
                                data={
                                    "tool_name": tool_call.name,
                                    "status": "ok",
                                    "result": result,
                                    "subagent": True,
                                },
                            )
                        except Exception as e:
                            await self._emit(
                                event_type="tool.call.finished",
                                session_key=session_key,
                                node_id=tool_node_id,
                                node_type="tool",
                                parent_id=llm_node_id,
                                data={
                                    "tool_name": tool_call.name,
                                    "status": "error",
                                    "error": str(e),
                                    "subagent": True,
                                },
                            )
                            await self._emit(
                                event_type="error.raised",
                                session_key=session_key,
                                node_id=tool_node_id,
                                node_type="tool",
                                parent_id=llm_node_id,
                                data={
                                    "error": str(e),
                                    "stage": "tool.call",
                                    "subagent": True,
                                },
                            )
                            raise
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "name": tool_call.name,
                            "content": result,
                        })
                else:
                    final_result = response.content
                    break
            
            if final_result is None:
                final_result = "Task completed but no final response was generated."
            
            logger.info(f"Subagent [{task_id}] completed successfully")
            await self._emit(
                event_type="subagent.completed",
                session_key=session_key,
                node_id=task_id,
                node_type="subagent",
                parent_id=None,
                data={
                    "status": "ok",
                    "result": final_result,
                },
            )
            await self._announce_result(task_id, label, task, final_result, origin, "ok")
            
        except Exception as e:
            error_msg = f"Error: {str(e)}"
            logger.error(f"Subagent [{task_id}] failed: {e}")
            await self._emit(
                event_type="subagent.completed",
                session_key=session_key,
                node_id=task_id,
                node_type="subagent",
                parent_id=None,
                data={
                    "status": "error",
                    "result": error_msg,
                },
            )
            await self._emit(
                event_type="error.raised",
                session_key=session_key,
                node_id=task_id,
                node_type="subagent",
                parent_id=None,
                data={
                    "error": str(e),
                    "stage": "subagent.run",
                },
            )
            await self._announce_result(task_id, label, task, error_msg, origin, "error")
    
    async def _announce_result(
        self,
        task_id: str,
        label: str,
        task: str,
        result: str,
        origin: dict[str, str],
        status: str,
    ) -> None:
        """Announce the subagent result to the main agent via the message bus."""
        status_text = "completed successfully" if status == "ok" else "failed"
        
        announce_content = f"""[Subagent '{label}' {status_text}]

Task: {task}

Result:
{result}

Summarize this naturally for the user. Keep it brief (1-2 sentences). Do not mention technical details like "subagent" or task IDs."""
        
        # Inject as system message to trigger main agent
        msg = InboundMessage(
            channel="system",
            sender_id="subagent",
            chat_id=f"{origin['channel']}:{origin['chat_id']}",
            content=announce_content,
        )
        
        await self.bus.publish_inbound(msg)
        logger.debug(f"Subagent [{task_id}] announced result to {origin['channel']}:{origin['chat_id']}")
    
    def _build_subagent_prompt(self, task: str) -> str:
        """Build a focused system prompt for the subagent."""
        return f"""# Subagent

You are a subagent spawned by the main agent to complete a specific task.

## Your Task
{task}

## Rules
1. Stay focused - complete only the assigned task, nothing else
2. Your final response will be reported back to the main agent
3. Do not initiate conversations or take on side tasks
4. Be concise but informative in your findings

## What You Can Do
- Read and write files in the workspace
- Execute shell commands
- Search the web and fetch web pages
- Complete the task thoroughly

## What You Cannot Do
- Send messages directly to users (no message tool available)
- Spawn other subagents
- Access the main agent's conversation history

## Workspace
Your workspace is at: {self.workspace}

When you have completed the task, provide a clear summary of your findings or actions."""
    
    def get_running_count(self) -> int:
        """Return the number of currently running subagents."""
        return len(self._running_tasks)
