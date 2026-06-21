# -*- coding: utf-8 -*-
"""Patch ``AgentRunner.query_handler`` to emit ringlight events.

Adapted from ``qwenpaw-pet/patch_runner.py`` — same event-classification
logic, but the emit target is the ESP32 ring light via
``mapper.schedule_emit`` instead of the desktop pet HTTP bridge.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .mapper import schedule_emit

logger = logging.getLogger("agentaura")

_ORIGINAL_QUERY_HANDLER = None
_PATCHED = False


def _request_meta(runner: Any, request: Any) -> dict[str, Any]:
    return {
        "agent_id": getattr(runner, "agent_id", "default"),
        "agent_name": getattr(runner, "agent_name", "QwenPaw"),
        "session_id": getattr(request, "session_id", "") if request else "",
        "user_id": getattr(request, "user_id", "") if request else "",
        "channel": getattr(request, "channel", "") if request else "",
    }


def _block_get(block: Any, key: str, default: Any = None) -> Any:
    if isinstance(block, dict):
        return block.get(key, default)
    return getattr(block, key, default)


def _iter_blocks(msg: Any):
    content = getattr(msg, "content", None)
    if content is None and isinstance(msg, dict):
        content = msg.get("content")
    if isinstance(content, list):
        yield from content
    elif isinstance(content, dict):
        yield content
    elif isinstance(content, str) and content.strip():
        yield {"type": "text", "text": content}


def _is_tool_guard_approval_msg(msg: Any) -> bool:
    metadata = getattr(msg, "metadata", None)
    if isinstance(msg, dict):
        metadata = msg.get("metadata", metadata)
    return (
        isinstance(metadata, dict)
        and metadata.get("message_type") == "tool_guard_approval"
    )


def _classify_msg(msg: Any) -> tuple[str | None, str | None]:
    """Return ``(event_name, text)`` for a streamed message chunk."""
    if _is_tool_guard_approval_msg(msg):
        return None, None
    for block in _iter_blocks(msg):
        block_type = _block_get(block, "type")
        if block_type == "tool_use":
            name = _block_get(block, "name") or "tool"
            return "tool.detected", f"Using {str(name)[:40]}"
        if block_type == "tool_result":
            return "tool.result", "Tool result"
        if block_type == "text":
            text = str(_block_get(block, "text") or "").strip()
            if text:
                return "query.first_token", "Replying"
    return None, None


def _split_result(result: Any) -> tuple[Any, bool | None]:
    if isinstance(result, tuple) and len(result) >= 2:
        return result[0], result[1]
    if isinstance(result, list) and len(result) >= 2:
        return result[0], result[1]
    return result, None


def patch_agent_runner() -> None:
    """Wrap ``AgentRunner.query_handler`` to observe the reply stream."""
    global _ORIGINAL_QUERY_HANDLER, _PATCHED

    if _PATCHED:
        return

    from qwenpaw.app.runner.runner import AgentRunner

    _ORIGINAL_QUERY_HANDLER = AgentRunner.query_handler

    async def patched_query_handler(self, msgs, request=None, **kwargs):
        meta = _request_meta(self, request)
        saw_first_output = False
        last_event = None

        schedule_emit("query.received", text="New message", **meta)
        schedule_emit("query.running", text="Thinking", **meta)

        try:
            async for result in _ORIGINAL_QUERY_HANDLER(
                self,
                msgs,
                request,
                **kwargs,
            ):
                msg, is_last = _split_result(result)
                event, text = _classify_msg(msg)

                if event and event != last_event:
                    schedule_emit(event, text=text, **meta)
                    last_event = event

                if not saw_first_output:
                    saw_first_output = True
                    if event is None:
                        schedule_emit(
                            "query.first_token",
                            text="Replying",
                            **meta,
                        )
                        last_event = "query.first_token"

                yield result

                if is_last:
                    last_event = None

            schedule_emit("query.done", text="Done", **meta)

        except asyncio.CancelledError:
            schedule_emit(
                "query.cancelled",
                text="Interrupted",
                **meta,
            )
            raise
        except Exception as exc:
            schedule_emit(
                "query.error",
                text=type(exc).__name__,
                **meta,
            )
            raise

    AgentRunner.query_handler = patched_query_handler
    _PATCHED = True
    logger.info("RingLight patched AgentRunner.query_handler")


def restore_agent_runner() -> None:
    global _PATCHED

    if not _PATCHED or _ORIGINAL_QUERY_HANDLER is None:
        return

    from qwenpaw.app.runner.runner import AgentRunner

    AgentRunner.query_handler = _ORIGINAL_QUERY_HANDLER
    _PATCHED = False
    logger.info("RingLight restored AgentRunner.query_handler")
