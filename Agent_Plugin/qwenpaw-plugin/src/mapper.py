# -*- coding: utf-8 -*-
"""Map QwenPaw lifecycle events to ESP32 ``agent <state>`` commands.

The mapping table is the single source of truth — adjust which light
state each QwenPaw event triggers here. ``dispatch`` is async-safe:
sync ``httpx`` calls are dispatched to a worker thread so the asyncio
event loop (which drives ``AgentRunner.query_handler``) is never blocked.
"""

from __future__ import annotations

import asyncio
import functools
import logging
from typing import Any

from .client import RingLightClient

logger = logging.getLogger("agentaura")

# ---------------------------------------------------------------- mapping
#
# Keys are the event names emitted by ``runner.py`` / ``approval.py``.
# Values are the ESP32 ``agent`` states defined in the firmware (see
# ``doc/API.md`` §9):
#   running / busy / waiting / error / idle / init / offline / upgrade
#
# ``None`` means "do not send anything" — used for events we observe but
# intentionally do not surface on the light.
EVENT_TO_AGENT_STATE: dict[str, str | None] = {
    # QwenPaw lifecycle
    "qwenpaw.startup": "init",
    "qwenpaw.shutdown": "offline",
    # Query pipeline (from runner)
    "query.received": "running",
    "query.running": "busy",
    "query.first_token": "busy",
    "tool.detected": "busy",
    "tool.result": "busy",
    "query.done": "idle",
    "query.cancelled": "idle",
    "query.error": "error",
    # Approval flow (from approval)
    "approval.pending": "waiting",
    "approval.approved": "busy",
    "approval.denied": "error",
    "approval.timed_out": "error",
    "approval.bulk_cancel": "idle",
}

EVENT_TO_MESSAGE: dict[str, tuple[str, str, int]] = {
    "qwenpaw.startup": ("QwenPaw 已启动", "state", 20),
    "query.received": ("收到新的 QwenPaw 请求", "activity", 20),
    "query.running": ("QwenPaw 正在思考", "activity", 20),
    "tool.detected": ("QwenPaw 正在调用工具", "activity", 30),
    "tool.result": ("工具执行完成", "success", 40),
    "query.done": ("QwenPaw 任务已完成", "success", 50),
    "query.cancelled": ("QwenPaw 任务已取消", "warning", 50),
    "query.error": ("QwenPaw 执行出错", "error", 80),
    "approval.pending": ("QwenPaw 等待操作授权", "warning", 70),
    "approval.approved": ("操作已获授权", "success", 50),
    "approval.denied": ("操作授权被拒绝", "error", 80),
    "approval.timed_out": ("操作授权已超时", "warning", 70),
}


def _event_message(event: str, payload: dict[str, Any]) -> tuple[str, str, int] | None:
    message = EVENT_TO_MESSAGE.get(event)
    if message is None:
        return None
    text, kind, priority = message
    detail = payload.get("text")
    if event in {"tool.detected", "tool.result", "query.error"} and isinstance(detail, str):
        detail = detail.strip()
        if detail:
            text = detail[:160]
    return text, kind, priority


def dispatch_sync(event: str, **payload: Any) -> None:
    """Sync entry point — sends the mapped state to the device.

    Safe to call from worker threads; never raises.
    """
    state = EVENT_TO_AGENT_STATE.get(event)
    if state is None:
        logger.debug("agentaura: event %s has no mapping (skip)", event)
        return
    try:
        client = RingLightClient()
        client.set_agent_state(state)
        message = _event_message(event, payload)
        if message:
            text, kind, priority = message
            client.send_message(text, kind, priority)
    except Exception:
        logger.debug("agentaura: dispatch_sync %s failed", event, exc_info=True)


def schedule_emit(event: str, **payload: Any) -> None:
    """Async-safe dispatcher used from inside the asyncio event loop.

    Falls back to a sync call when no loop is running (e.g. startup hook
    invoked from a plain thread). Mirrors qwenpaw-pet's
    ``schedule_emit_pet_event``.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        dispatch_sync(event, **payload)
        return

    async def _run() -> None:
        await asyncio.to_thread(
            functools.partial(dispatch_sync, event, **payload),
        )

    task = asyncio.create_task(_run())

    def _done(t: asyncio.Task) -> None:
        try:
            t.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.debug("agentaura: schedule_emit task failed", exc_info=True)

    task.add_done_callback(_done)
