"""UI static server and telemetry websocket hub.

Implementation note:
- We use aiohttp for HTTP + websocket. The `websockets` library changed its
  server APIs significantly in recent versions (v12+ / v15+ / v16), which makes
  the older `process_request` approach brittle.
- aiohttp is already a dependency of nanobot, so this keeps the UI server stable.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections import deque
from http import HTTPStatus
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web
from loguru import logger

from nanobot.agent.loop import AgentLoop
from nanobot.bus.events import InboundMessage
from nanobot.bus.queue import MessageBus
from nanobot.config.loader import load_config
from nanobot.providers.litellm_provider import LiteLLMProvider
from nanobot.telemetry import TelemetryEmitter, TelemetryNode


class TelemetryHub:
    """Broadcasts telemetry events to all connected websocket clients.

    Keeps a small ring-buffer so newly connected UI clients immediately see the
    recent history.
    """

    def __init__(self, buffer_size: int = 200) -> None:
        self._clients: set[web.WebSocketResponse] = set()
        self._lock = asyncio.Lock()
        self._buffer: deque[str] = deque(maxlen=buffer_size)

    async def register(self, ws: web.WebSocketResponse) -> None:
        async with self._lock:
            self._clients.add(ws)
            history = list(self._buffer)

        # Send history outside the lock.
        for item in history:
            await self._safe_send(ws, item)

    async def unregister(self, ws: web.WebSocketResponse) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, message: str, sender: web.WebSocketResponse | None = None) -> None:
        async with self._lock:
            self._buffer.append(message)
            targets = [ws for ws in self._clients if ws is not sender]

        if not targets:
            return

        await asyncio.gather(
            *[self._safe_send(ws, message) for ws in targets],
            return_exceptions=True,
        )

    async def _safe_send(self, ws: web.WebSocketResponse, message: str) -> None:
        try:
            await ws.send_str(message)
        except Exception:
            await self.unregister(ws)


def _resolve_ui_dist() -> Path:
    root = Path(__file__).resolve().parents[2]
    return root / "ui" / "dist"


def _is_telemetry_event(message: str) -> bool:
    try:
        payload = json.loads(message)
    except Exception:
        return False
    return isinstance(payload, dict) and "eventId" in payload and "type" in payload


async def _ws_telemetry_handler(request: web.Request) -> web.WebSocketResponse:
    hub: TelemetryHub = request.app["hub"]

    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)

    await hub.register(ws)
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                if _is_telemetry_event(msg.data):
                    await hub.broadcast(msg.data, sender=ws)
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        await hub.unregister(ws)

    return ws


async def _index_handler(request: web.Request) -> web.FileResponse:
    dist: Path = request.app["dist"]
    return web.FileResponse(dist / "index.html")


async def _file_or_index_handler(request: web.Request) -> web.StreamResponse:
    """Serve a file from dist if it exists; otherwise serve index.html (SPA)."""
    dist: Path = request.app["dist"]
    tail = request.match_info.get("tail", "")
    candidate = (dist / tail.lstrip("/")).resolve()

    # Prevent path traversal.
    try:
        candidate.relative_to(dist)
    except Exception:
        return web.Response(status=HTTPStatus.NOT_FOUND, text="Not Found")

    if candidate.exists() and candidate.is_file():
        return web.FileResponse(candidate)

    return web.FileResponse(dist / "index.html")


async def _api_history_handler(request: web.Request) -> web.Response:
    """Return recent UI chat history from the persisted session."""
    agent: AgentLoop = request.app["agent"]
    session_key = request.query.get("sessionKey") or "ui:main"
    session = agent.sessions.get_or_create(session_key)

    items = []
    for m in session.messages[-200:]:
        role = m.get("role")
        content = m.get("content")
        ts = m.get("timestamp") or m.get("ts") or m.get("time")
        if role not in ("user", "assistant"):
            continue
        if not content:
            continue
        # Skip internal/system-tagged user lines if they exist.
        if isinstance(content, str) and content.startswith("[System:"):
            continue
        items.append({"role": role, "content": content, "ts": ts})

    return web.json_response({"ok": True, "messages": items})


async def _api_chat_handler(request: web.Request) -> web.Response:
    """Send a message to the agent and return the response.

    Supports:
    - JSON: {"text": "...", "imageDataUrl": "data:image/..."}
    - multipart/form-data: fields `text` and optional file `image`

    Note: image handling is best-effort; we pass the image as a data-url inside
    the prompt so multimodal providers can use it if supported.
    """
    agent: AgentLoop = request.app["agent"]

    text = ""
    image_data_url: str | None = None
    session_key = "ui:main"

    client_message_id: str | None = None

    if request.content_type.startswith("application/json"):
        payload = await request.json()
        text = str(payload.get("text", "") or "")
        image_data_url = payload.get("imageDataUrl")
        session_key = str(payload.get("sessionKey") or session_key)
        client_message_id = payload.get("clientMessageId")
    elif request.content_type.startswith("multipart/"):
        form = await request.post()
        text = str(form.get("text", "") or "")
        session_key = str(form.get("sessionKey", session_key) or session_key)
        client_message_id = str(form.get("clientMessageId", "") or "") or None
        image = form.get("image")
        if image is not None and hasattr(image, "file"):
            raw = image.file.read()
            import base64

            mime = getattr(image, "content_type", None) or "application/octet-stream"
            b64 = base64.b64encode(raw).decode("ascii")
            image_data_url = f"data:{mime};base64,{b64}"

    text = text.strip()
    if not text and not image_data_url:
        return web.json_response({"ok": False, "error": "empty message"}, status=400)

    # IMPORTANT: Don't embed base64 image payloads into `content`.
    # That would get persisted into session history and can explode context.
    content = text
    media = [image_data_url] if image_data_url else []

    # session_key format is always "channel:chat_id" for nanobot.
    # For the UI, we treat chat_id as the session id.
    if ":" in session_key:
        channel, chat_id = session_key.split(":", 1)
    else:
        channel, chat_id = "ui", session_key

    msg = InboundMessage(
        channel=channel,
        sender_id="user",
        chat_id=chat_id,
        content=content,
        media=media,
        metadata={"clientMessageId": client_message_id} if client_message_id else {},
    )

    out = await agent._process_message(msg)  # noqa: SLF001 (UI is in-process)
    response = out.content if out else ""

    return web.json_response({"ok": True, "response": response})


async def _api_sessions_handler(request: web.Request) -> web.Response:
    """List available UI sessions."""
    agent: AgentLoop = request.app["agent"]
    sessions = agent.sessions.list_sessions()

    # Keep only UI sessions and normalize key format.
    ui_sessions = [s for s in sessions if str(s.get("key", "")).startswith("ui:")]
    return web.json_response({"ok": True, "sessions": ui_sessions})


async def _api_new_session_handler(request: web.Request) -> web.Response:
    """Create a new UI session key.

    Uses a timestamp-based name so humans can recognize sessions easily.
    """
    agent: AgentLoop = request.app["agent"]

    import uuid
    from datetime import datetime

    # Local time (same as server timezone). Example: ui:20260206-095512-a1b2
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    suffix = uuid.uuid4().hex[:4]
    session_key = f"ui:{ts}-{suffix}"

    session = agent.sessions.get_or_create(session_key)
    # Persist immediately so it appears in /api/sessions.
    agent.sessions.save(session)

    return web.json_response({"ok": True, "sessionKey": session_key})


def _read_telemetry_jsonl(path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    try:
        if not path.exists():
            return []
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except Exception:
                    continue
    except Exception:
        return []
    return events


async def _api_telemetry_bundle_handler(request: web.Request) -> web.Response:
    """Return telemetry events for a UI session, including spawned subagents."""
    telemetry_dir: Path = request.app["telemetry_dir"]
    session_key = request.query.get("sessionKey") or "ui:main"

    # Main session events.
    main_path = telemetry_dir / (TelemetryEmitter._sanitize_session_key(session_key) + ".jsonl")
    main_events = _read_telemetry_jsonl(main_path)

    # Find spawned subagents and include their telemetry.
    subagent_ids: set[str] = set()
    for ev in main_events:
        if ev.get("type") == "subagent.spawned":
            node = ev.get("node") or {}
            node_id = node.get("nodeId")
            if node_id:
                subagent_ids.add(str(node_id))

    bundled = list(main_events)
    for sid in sorted(subagent_ids):
        sk = f"subagent:{sid}"
        p = telemetry_dir / (TelemetryEmitter._sanitize_session_key(sk) + ".jsonl")
        bundled.extend(_read_telemetry_jsonl(p))

    # Sort by timestamp so UI can replay deterministically.
    def _ts(e: dict[str, Any]) -> str:
        return str(e.get("ts") or "")

    bundled.sort(key=_ts)
    return web.json_response({"ok": True, "events": bundled})


async def _api_layout_get_handler(request: web.Request) -> web.Response:
    """Get saved layout for a session (nodeId -> position)."""
    from nanobot.config.loader import get_data_dir

    session_key = request.query.get("sessionKey") or "ui:main"
    layout_dir = get_data_dir() / "ui_layout"
    layout_path = layout_dir / (TelemetryEmitter._sanitize_session_key(session_key) + ".json")

    if not layout_path.exists():
        return web.json_response({"ok": True, "layout": {}})

    try:
        layout = json.loads(layout_path.read_text(encoding="utf-8"))
        if not isinstance(layout, dict):
            layout = {}
    except Exception:
        layout = {}

    return web.json_response({"ok": True, "layout": layout})


async def _api_layout_set_handler(request: web.Request) -> web.Response:
    """Persist layout for a session."""
    from nanobot.config.loader import get_data_dir

    payload = await request.json()
    session_key = str(payload.get("sessionKey") or "ui:main")
    layout = payload.get("layout")
    if not isinstance(layout, dict):
        return web.json_response({"ok": False, "error": "invalid layout"}, status=400)

    layout_dir = get_data_dir() / "ui_layout"
    layout_dir.mkdir(parents=True, exist_ok=True)
    layout_path = layout_dir / (TelemetryEmitter._sanitize_session_key(session_key) + ".json")
    layout_path.write_text(json.dumps(layout, ensure_ascii=False, indent=2), encoding="utf-8")

    return web.json_response({"ok": True})


async def _api_clear_all_handler(request: web.Request) -> web.Response:
    """Clear ALL UI history (sessions + telemetry + layouts).

    This is destructive and intended for local development.
    """
    from nanobot.config.loader import get_data_dir

    agent: AgentLoop = request.app["agent"]

    # 1) Delete UI sessions (ui:*)
    deleted_sessions = 0
    try:
        for row in agent.sessions.list_sessions():
            key = str(row.get("key") or "")
            if key.startswith("ui:"):
                if agent.sessions.delete(key):
                    deleted_sessions += 1
    except Exception:
        pass

    # 2) Delete telemetry files
    telemetry_dir: Path = request.app.get("telemetry_dir")
    deleted_telemetry_files = 0
    if telemetry_dir and telemetry_dir.exists():
        try:
            for p in telemetry_dir.glob("*.jsonl"):
                p.unlink(missing_ok=True)
                deleted_telemetry_files += 1
        except Exception:
            pass

    # 3) Delete layout files
    layout_dir = get_data_dir() / "ui_layout"
    deleted_layout_files = 0
    if layout_dir.exists():
        try:
            for p in layout_dir.glob("*.json"):
                p.unlink(missing_ok=True)
                deleted_layout_files += 1
        except Exception:
            pass

    return web.json_response(
        {
            "ok": True,
            "deleted": {
                "sessions": deleted_sessions,
                "telemetry_files": deleted_telemetry_files,
                "layout_files": deleted_layout_files,
            },
        }
    )


def run_ui_server(host: str = "127.0.0.1", port: int = 18791) -> None:
    """Run static UI server with a websocket telemetry hub."""

    dist = _resolve_ui_dist()
    if not dist.exists():
        raise FileNotFoundError(
            f"UI assets not found at {dist}. Run: cd ui && npm install && npm run build"
        )

    logger.info(f"Starting UI server at http://{host}:{port} (serving {dist})")

    app = web.Application()
    hub = TelemetryHub(buffer_size=200)
    app["hub"] = hub
    app["dist"] = dist

    # Create an in-process agent loop so the UI can chat directly.
    config = load_config()
    bus = MessageBus()
    provider = LiteLLMProvider(
        api_key=config.get_api_key(),
        api_base=config.get_api_base(),
        default_model=config.agents.defaults.model,
    )

    # Persist telemetry so node graphs can be reconstructed across refresh/restart.
    from nanobot.config.loader import get_data_dir

    telemetry_dir = get_data_dir() / "telemetry"
    telemetry = TelemetryEmitter(persist_dir=telemetry_dir, ws_url=None)
    app["telemetry_dir"] = telemetry_dir

    async def forward_to_hub(payload: dict[str, Any]) -> None:
        await hub.broadcast(json.dumps(payload, ensure_ascii=False))

    telemetry.subscribe(forward_to_hub)

    agent = AgentLoop(
        bus=bus,
        provider=provider,
        workspace=config.workspace_path,
        model=config.agents.defaults.model,
        max_iterations=config.agents.defaults.max_tool_iterations,
        max_tokens=config.agents.defaults.max_tokens,
        temperature=config.agents.defaults.temperature,
        brave_api_key=config.tools.web.search.api_key or None,
        exec_config=config.tools.exec,
        telemetry=telemetry,
    )
    app["agent"] = agent

    # IMPORTANT: Start the agent bus consumer loop so system messages emitted by
    # subagents (completion announcements) are processed and can surface back
    # into the UI session as assistant replies.
    async def _start_agent_loop(app: web.Application) -> None:
        app["agent_task"] = asyncio.create_task(agent.run())

    async def _stop_agent_loop(app: web.Application) -> None:
        task: asyncio.Task | None = app.get("agent_task")
        if task:
            agent.stop()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    app.on_startup.append(_start_agent_loop)
    app.on_cleanup.append(_stop_agent_loop)

    # Telemetry websocket.
    app.router.add_get("/ws/telemetry", _ws_telemetry_handler)

    # Chat + persistence APIs.
    app.router.add_get("/api/sessions", _api_sessions_handler)
    app.router.add_post("/api/new_session", _api_new_session_handler)

    app.router.add_get("/api/history", _api_history_handler)
    app.router.add_post("/api/chat", _api_chat_handler)

    app.router.add_get("/api/telemetry_bundle", _api_telemetry_bundle_handler)
    app.router.add_get("/api/layout", _api_layout_get_handler)
    app.router.add_post("/api/layout", _api_layout_set_handler)
    app.router.add_post("/api/clear_all", _api_clear_all_handler)

    # Static assets (Vite build outputs to dist/assets).
    assets_dir = dist / "assets"
    if assets_dir.exists():
        app.router.add_static("/assets/", assets_dir, show_index=False)

    # SPA + root files.
    app.router.add_get("/", _index_handler)
    app.router.add_get("/{tail:.*}", _file_or_index_handler)

    web.run_app(app, host=host, port=port, print=None)
