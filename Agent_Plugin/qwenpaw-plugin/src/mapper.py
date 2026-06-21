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


def dispatch_sync(event: str, **payload: Any) -> None:
    """Sync entry point — sends the mapped state to the device.

    Safe to call from worker threads; never raises.
    """
    state = EVENT_TO_AGENT_STATE.get(event)
    if state is None:
        logger.debug("agentaura: event %s has no mapping (skip)", event)
        return
    try:
        RingLightClient().set_agent_state(state)
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
