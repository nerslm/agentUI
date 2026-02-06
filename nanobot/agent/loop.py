"""Agent loop: the core processing engine."""

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

from loguru import logger

from nanobot.bus.events import InboundMessage, OutboundMessage
from nanobot.bus.queue import MessageBus
from nanobot.providers.base import LLMProvider
from nanobot.agent.context import ContextBuilder
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.agent.tools.filesystem import ReadFileTool, WriteFileTool, EditFileTool, ListDirTool
from nanobot.agent.tools.shell import ExecTool
from nanobot.agent.tools.web import WebSearchTool, WebFetchTool
from nanobot.agent.tools.message import MessageTool
from nanobot.agent.tools.spawn import SpawnTool
from nanobot.agent.tools.cron import CronTool
from nanobot.agent.subagent import SubagentManager
from nanobot.session.manager import SessionManager
from nanobot.telemetry import TelemetryEmitter, TelemetryNode


class AgentLoop:
    """
    The agent loop is the core processing engine.
    
    It:
    1. Receives messages from the bus
    2. Builds context with history, memory, skills
    3. Calls the LLM
    4. Executes tool calls
    5. Sends responses back
    """
    
    def __init__(
        self,
        bus: MessageBus,
        provider: LLMProvider,
        workspace: Path,
        model: str | None = None,
        max_iterations: int = 20,
        max_tokens: int = 8192,
        temperature: float = 0.7,
        brave_api_key: str | None = None,
        exec_config: "ExecToolConfig | None" = None,
        cron_service: "CronService | None" = None,
        telemetry: TelemetryEmitter | None = None,
    ):
        from nanobot.config.schema import ExecToolConfig
        from nanobot.cron.service import CronService
        self.bus = bus
        self.provider = provider
        self.workspace = workspace
        self.model = model or provider.get_default_model()
        self.max_iterations = max_iterations
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.brave_api_key = brave_api_key
        self.exec_config = exec_config or ExecToolConfig()
        self.cron_service = cron_service
        self.telemetry = telemetry
        
        self.context = ContextBuilder(workspace)
        self.sessions = SessionManager(workspace)
        self.tools = ToolRegistry()
        self.subagents = SubagentManager(
            provider=provider,
            workspace=workspace,
            bus=bus,
            model=self.model,
            brave_api_key=brave_api_key,
            exec_config=self.exec_config,
            max_tokens=max_tokens,
            temperature=temperature,
            telemetry=self.telemetry,
        )
        
        self._running = False
        self._register_default_tools()
    
    def _register_default_tools(self) -> None:
        """Register the default set of tools."""
        # File tools
        self.tools.register(ReadFileTool())
        self.tools.register(WriteFileTool())
        self.tools.register(EditFileTool())
        self.tools.register(ListDirTool())
        
        # Shell tool
        self.tools.register(ExecTool(
            working_dir=str(self.workspace),
            timeout=self.exec_config.timeout,
            restrict_to_workspace=self.exec_config.restrict_to_workspace,
        ))
        
        # Web tools
        self.tools.register(WebSearchTool(api_key=self.brave_api_key))
        self.tools.register(WebFetchTool())
        
        # Message tool
        message_tool = MessageTool(send_callback=self.bus.publish_outbound)
        self.tools.register(message_tool)
        
        # Spawn tool (for subagents)
        spawn_tool = SpawnTool(manager=self.subagents)
        self.tools.register(spawn_tool)
        
        # Cron tool (for scheduling)
        if self.cron_service:
            self.tools.register(CronTool(self.cron_service))
    
    async def run(self) -> None:
        """Run the agent loop, processing messages from the bus."""
        self._running = True
        logger.info("Agent loop started")
        
        while self._running:
            try:
                # Wait for next message
                msg = await asyncio.wait_for(
                    self.bus.consume_inbound(),
                    timeout=1.0
                )
                
                # Process it
                try:
                    response = await self._process_message(msg)
                    if response:
                        await self.bus.publish_outbound(response)
                except Exception as e:
                    logger.error(f"Error processing message: {e}")
                    # Send error response
                    await self.bus.publish_outbound(OutboundMessage(
                        channel=msg.channel,
                        chat_id=msg.chat_id,
                        content=f"Sorry, I encountered an error: {str(e)}"
                    ))
            except asyncio.TimeoutError:
                continue
    
    def stop(self) -> None:
        """Stop the agent loop."""
        self._running = False
        logger.info("Agent loop stopping")

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

    @staticmethod
    def _new_node_id(prefix: str) -> str:
        return f"{prefix}:{uuid.uuid4().hex[:8]}"
    
    async def _process_message(self, msg: InboundMessage) -> OutboundMessage | None:
        """
        Process a single inbound message.
        
        Args:
            msg: The inbound message to process.
        
        Returns:
            The response message, or None if no response needed.
        """
        # Handle system messages (subagent announces)
        # The chat_id contains the original "channel:chat_id" to route back to
        if msg.channel == "system":
            return await self._process_system_message(msg)
        
        logger.info(f"Processing message from {msg.channel}:{msg.sender_id}")
        message_node_id = self._new_node_id("msg")
        await self._emit(
            event_type="message.received",
            session_key=msg.session_key,
            node_id=message_node_id,
            node_type="message",
            parent_id=None,
            data={
                "channel": msg.channel,
                "chat_id": msg.chat_id,
                "sender_id": msg.sender_id,
                "content": msg.content,
                "metadata": msg.metadata or {},
            },
        )
        
        # Get or create session
        session = self.sessions.get_or_create(msg.session_key)
        
        # Update tool contexts
        message_tool = self.tools.get("message")
        if isinstance(message_tool, MessageTool):
            message_tool.set_context(msg.channel, msg.chat_id)
        
        spawn_tool = self.tools.get("spawn")
        if isinstance(spawn_tool, SpawnTool):
            spawn_tool.set_context(msg.channel, msg.chat_id)
        
        cron_tool = self.tools.get("cron")
        if isinstance(cron_tool, CronTool):
            cron_tool.set_context(msg.channel, msg.chat_id)
        
        # Build initial messages (use get_history for LLM-formatted messages)
        messages = self.context.build_messages(
            history=session.get_history(),
            current_message=msg.content,
            media=msg.media if msg.media else None,
            channel=msg.channel,
            chat_id=msg.chat_id,
        )
        
        # Agent loop
        iteration = 0
        final_content = None

        # For UI/workflow visualization: chain causality.
        # The first LLM request is caused by the incoming message; subsequent LLM
        # requests are caused by the last tool result (if any).
        parent_for_llm = message_node_id
        
        while iteration < self.max_iterations:
            iteration += 1
            
            # Call LLM
            llm_node_id = self._new_node_id("llm")
            await self._emit(
                event_type="llm.request.started",
                session_key=msg.session_key,
                node_id=llm_node_id,
                node_type="llm",
                parent_id=parent_for_llm,
                data={
                    "model": self.model,
                    "messages_count": len(messages),
                    "iteration": iteration,
                },
            )
            try:
                response = await self.provider.chat(
                    messages=messages,
                    tools=self.tools.get_definitions(),
                    model=self.model,
                    max_tokens=self.max_tokens,
                    temperature=self.temperature,
                )
            except Exception as e:
                await self._emit(
                    event_type="error.raised",
                    session_key=msg.session_key,
                    node_id=llm_node_id,
                    node_type="llm",
                    parent_id=parent_for_llm,
                    data={
                        "error": str(e),
                        "stage": "llm.request",
                    },
                )
                raise
            await self._emit(
                event_type="llm.request.finished",
                session_key=msg.session_key,
                node_id=llm_node_id,
                node_type="llm",
                parent_id=parent_for_llm,
                data={
                    "finish_reason": response.finish_reason,
                    "has_tool_calls": response.has_tool_calls,
                    "tool_call_count": len(response.tool_calls),
                    "usage": response.usage,
                },
            )
            
            # Handle tool calls
            if response.has_tool_calls:
                # Add assistant message with tool calls
                tool_call_dicts = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": json.dumps(tc.arguments)  # Must be JSON string
                        }
                    }
                    for tc in response.tool_calls
                ]
                messages = self.context.add_assistant_message(
                    messages, response.content, tool_call_dicts
                )
                
                # Execute tools
                for tool_call in response.tool_calls:
                    args_str = json.dumps(tool_call.arguments)
                    logger.debug(f"Executing tool: {tool_call.name} with arguments: {args_str}")
                    tool_node_id = f"tool:{tool_call.id}"
                    await self._emit(
                        event_type="tool.call.started",
                        session_key=msg.session_key,
                        node_id=tool_node_id,
                        node_type="tool",
                        parent_id=llm_node_id,
                        data={
                            "tool_name": tool_call.name,
                            "arguments": tool_call.arguments,
                        },
                    )
                    if tool_call.name == "spawn":
                        self.subagents.set_spawn_context(tool_node_id)
                    try:
                        result = await self.tools.execute(tool_call.name, tool_call.arguments)
                        await self._emit(
                            event_type="tool.call.finished",
                            session_key=msg.session_key,
                            node_id=tool_node_id,
                            node_type="tool",
                            parent_id=llm_node_id,
                            data={
                                "tool_name": tool_call.name,
                                "status": "ok",
                                "result": result,
                            },
                        )
                    except Exception as e:
                        await self._emit(
                            event_type="tool.call.finished",
                            session_key=msg.session_key,
                            node_id=tool_node_id,
                            node_type="tool",
                            parent_id=llm_node_id,
                            data={
                                "tool_name": tool_call.name,
                                "status": "error",
                                "error": str(e),
                            },
                        )
                        await self._emit(
                            event_type="error.raised",
                            session_key=msg.session_key,
                            node_id=tool_node_id,
                            node_type="tool",
                            parent_id=llm_node_id,
                            data={
                                "error": str(e),
                                "stage": "tool.call",
                            },
                        )
                        raise
                    messages = self.context.add_tool_result(
                        messages, tool_call.id, tool_call.name, result
                    )

                    # Next LLM request causality: link to the tool itself.
                    parent_for_llm = tool_node_id
            else:
                # No tool calls, we're done
                final_content = response.content
                break
        
        if final_content is None:
            final_content = "I've completed processing but have no response to give."
        
        # Save to session
        session.add_message("user", msg.content)
        session.add_message("assistant", final_content)
        self.sessions.save(session)

        # Emit assistant final answer as a message event for UI graph reconstruction.
        answer_node_id = self._new_node_id("asst")
        await self._emit(
            event_type="message.sent",
            session_key=msg.session_key,
            node_id=answer_node_id,
            node_type="message",
            parent_id=message_node_id,
            data={
                "role": "assistant",
                "content": final_content,
                "final": True,
            },
        )
        
        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content=final_content
        )
    
    async def _process_system_message(self, msg: InboundMessage) -> OutboundMessage | None:
        """
        Process a system message (e.g., subagent announce).
        
        The chat_id field contains "original_channel:original_chat_id" to route
        the response back to the correct destination.
        """
        logger.info(f"Processing system message from {msg.sender_id}")
        message_node_id = self._new_node_id("msg")
        await self._emit(
            event_type="message.received",
            session_key=msg.session_key,
            node_id=message_node_id,
            node_type="message",
            parent_id=None,
            data={
                "channel": msg.channel,
                "chat_id": msg.chat_id,
                "sender_id": msg.sender_id,
                "content": msg.content,
                "system": True,
            },
        )
        
        # Parse origin from chat_id (format: "channel:chat_id")
        if ":" in msg.chat_id:
            parts = msg.chat_id.split(":", 1)
            origin_channel = parts[0]
            origin_chat_id = parts[1]
        else:
            # Fallback
            origin_channel = "cli"
            origin_chat_id = msg.chat_id
        
        # Use the origin session for context
        session_key = f"{origin_channel}:{origin_chat_id}"
        session = self.sessions.get_or_create(session_key)
        
        # Update tool contexts
        message_tool = self.tools.get("message")
        if isinstance(message_tool, MessageTool):
            message_tool.set_context(origin_channel, origin_chat_id)
        
        spawn_tool = self.tools.get("spawn")
        if isinstance(spawn_tool, SpawnTool):
            spawn_tool.set_context(origin_channel, origin_chat_id)
        
        cron_tool = self.tools.get("cron")
        if isinstance(cron_tool, CronTool):
            cron_tool.set_context(origin_channel, origin_chat_id)
        
        # Build messages with the announce content
        messages = self.context.build_messages(
            history=session.get_history(),
            current_message=msg.content,
            channel=origin_channel,
            chat_id=origin_chat_id,
        )
        
        # Agent loop (limited for announce handling)
        iteration = 0
        final_content = None

        parent_for_llm = message_node_id
        
        while iteration < self.max_iterations:
            iteration += 1

            llm_node_id = self._new_node_id("llm")
            await self._emit(
                event_type="llm.request.started",
                session_key=session_key,
                node_id=llm_node_id,
                node_type="llm",
                parent_id=parent_for_llm,
                data={
                    "model": self.model,
                    "messages_count": len(messages),
                    "iteration": iteration,
                    "system": True,
                },
            )
            try:
                response = await self.provider.chat(
                    messages=messages,
                    tools=self.tools.get_definitions(),
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
                    parent_id=parent_for_llm,
                    data={
                        "error": str(e),
                        "stage": "llm.request",
                        "system": True,
                    },
                )
                raise
            await self._emit(
                event_type="llm.request.finished",
                session_key=session_key,
                node_id=llm_node_id,
                node_type="llm",
                parent_id=parent_for_llm,
                data={
                    "finish_reason": response.finish_reason,
                    "has_tool_calls": response.has_tool_calls,
                    "tool_call_count": len(response.tool_calls),
                    "usage": response.usage,
                    "system": True,
                },
            )
            
            if response.has_tool_calls:

                tool_call_dicts = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": json.dumps(tc.arguments)
                        }
                    }
                    for tc in response.tool_calls
                ]
                messages = self.context.add_assistant_message(
                    messages, response.content, tool_call_dicts
                )
                
                for tool_call in response.tool_calls:
                    args_str = json.dumps(tool_call.arguments)
                    logger.debug(f"Executing tool: {tool_call.name} with arguments: {args_str}")
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
                            "system": True,
                        },
                    )
                    if tool_call.name == "spawn":
                        self.subagents.set_spawn_context(tool_node_id)
                    try:
                        result = await self.tools.execute(tool_call.name, tool_call.arguments)
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
                                "system": True,
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
                                "system": True,
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
                                "system": True,
                            },
                        )
                        raise
                    messages = self.context.add_tool_result(
                        messages, tool_call.id, tool_call.name, result
                    )

                    parent_for_llm = tool_node_id
            else:
                final_content = response.content
                break
        
        if final_content is None:
            final_content = "Background task completed."
        
        # Save to session (mark as system message in history)
        session.add_message("user", f"[System: {msg.sender_id}] {msg.content}")
        session.add_message("assistant", final_content)
        self.sessions.save(session)
        
        # Emit assistant final answer as a message event for UI graph reconstruction.
        answer_node_id = self._new_node_id("asst")
        await self._emit(
            event_type="message.sent",
            session_key=session_key,
            node_id=answer_node_id,
            node_type="message",
            parent_id=message_node_id,
            data={
                "role": "assistant",
                "content": final_content,
                "final": True,
                "system": True,
            },
        )
        
        return OutboundMessage(
            channel=origin_channel,
            chat_id=origin_chat_id,
            content=final_content
        )
    
    async def process_direct(
        self,
        content: str,
        session_key: str = "cli:direct",
        channel: str = "cli",
        chat_id: str = "direct",
    ) -> str:
        """
        Process a message directly (for CLI or cron usage).
        
        Args:
            content: The message content.
            session_key: Session identifier.
            channel: Source channel (for context).
            chat_id: Source chat ID (for context).
        
        Returns:
            The agent's response.
        """
        msg = InboundMessage(
            channel=channel,
            sender_id="user",
            chat_id=chat_id,
            content=content
        )
        
        response = await self._process_message(msg)
        return response.content if response else ""
