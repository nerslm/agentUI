"""Telemetry event emitter and optional persistence."""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from loguru import logger

try:
    import websockets
except Exception:  # pragma: no cover - optional in some envs
    websockets = None


Subscriber = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass
class TelemetryNode:
    node_id: str
    node_type: str
    parent_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "nodeId": self.node_id,
            "nodeType": self.node_type,
            "parentId": self.parent_id,
        }


class TelemetryEmitter:
    """Emit structured telemetry events to subscribers, JSONL, and WS relay."""

    def __init__(
        self,
        persist_dir: Path | None = None,
        ws_url: str | None = None,
    ) -> None:
        self._subscribers: list[Subscriber] = []
        self._persist_dir = persist_dir
        self._ws_url = ws_url
        self._ws_lock = asyncio.Lock()

        if self._persist_dir:
            self._persist_dir.mkdir(parents=True, exist_ok=True)

    def subscribe(self, subscriber: Subscriber) -> None:
        """Register an async subscriber for emitted events."""
        self._subscribers.append(subscriber)

    async def emit(
        self,
        event_type: str,
        session_key: str,
        node: TelemetryNode,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Emit a telemetry event and return the event dict."""
        payload = {
            "eventId": str(uuid.uuid4()),
            "ts": datetime.now(timezone.utc).isoformat(),
            "type": event_type,
            "sessionKey": session_key,
            "node": node.to_dict(),
            "data": data or {},
        }

        if self._persist_dir:
            self._append_jsonl(session_key, payload)

        if self._subscribers:
            await self._notify_subscribers(payload)

        if self._ws_url:
            await self._send_ws(payload)

        return payload

    async def _notify_subscribers(self, payload: dict[str, Any]) -> None:
        tasks = [subscriber(payload) for subscriber in self._subscribers]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def _append_jsonl(self, session_key: str, payload: dict[str, Any]) -> None:
        filename = self._sanitize_session_key(session_key) + ".jsonl"
        path = self._persist_dir / filename
        try:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
        except Exception as exc:
            logger.debug(f"Telemetry JSONL write failed: {exc}")

    async def _send_ws(self, payload: dict[str, Any]) -> None:
        if websockets is None:
            return
        # Avoid concurrent connection storms
        async with self._ws_lock:
            try:
                async with websockets.connect(self._ws_url) as socket:
                    await socket.send(json.dumps(payload))
            except Exception as exc:
                logger.debug(f"Telemetry WS send failed: {exc}")

    @staticmethod
    def _sanitize_session_key(session_key: str) -> str:
        safe = re.sub(r"[^a-zA-Z0-9._-]+", "_", session_key)
        return safe.strip("_") or "session"
