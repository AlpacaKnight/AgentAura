# -*- coding: utf-8 -*-
"""Capture the QwenPaw query lifecycle and emit ring-light events.

Supported runtime: **QwenPaw >= 2.3.0**. Every request flows through
``qwenpaw.app.workspace.workspace.Workspace.stream_query`` (its docstring
literally calls itself the *drop-in replacement for the old*
``Runner.stream_query()``). The stream yields the schema objects from
``qwenpaw.schemas``: ``AgentResponse`` / ``Message`` envelopes plus bare
``TextContent`` / ``DataContent`` blocks.

Tool activity is carried by ``DataContent`` blocks: a tool call exposes a
``FunctionCall`` payload (``call_id`` / ``name`` / ``arguments``), a tool
result a ``FunctionCallOutput`` payload (… / ``output``). Text blocks map
to "the agent started replying".

Adapted from ``qwenpaw-pet/patch_runner.py`` — same event-classification
intent, emit target swapped to the ESP32 ring light via
``mapper.schedule_emit``.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Iterator

from .mapper import schedule_emit

logger = logging.getLogger("agentaura")

# Patched targets, as ``(owner, attribute, original)`` triples so that a
# restore() puts back exactly what was replaced.
_ORIGINALS: list[tuple[Any, str, Any]] = []
_PATCHED = False

# Keys of the ``FunctionCall`` payload carried by a 2.x ``DataContent``
# block. A tool *result* instead carries ``output``.
_CALL_KEYS = ("call_id", "name", "arguments")

# Content block types emitted directly on the stream.
_CONTENT_BLOCK_TYPES = frozenset(
    {"text", "data", "image", "audio", "video", "file", "refusal"},
)


# --------------------------------------------------------------- accessors


def _get(obj: Any, key: str, default: Any = None) -> Any:
    """Read *key* from a dict or from an attribute-based schema object."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _block_type(block: Any) -> str:
    value = _get(block, "type")
    # Both the schema enums (ContentType) and plain strings appear here.
    value = getattr(value, "value", value)
    return str(value or "").strip().lower()


def _payload_dict(block: Any) -> dict[str, Any]:
    """Return the ``FunctionCall``/``FunctionCallOutput`` dict of a block."""
    data = _get(block, "data")
    if isinstance(data, dict):
        return data
    # Some builds hand over a pydantic model instead of a dumped dict.
    dump = getattr(data, "model_dump", None)
    if callable(dump):
        try:
            dumped = dump()
        except Exception:  # pragma: no cover - defensive
            return {}
        return dumped if isinstance(dumped, dict) else {}
    return {}


def _request_meta(owner: Any, request: Any) -> dict[str, Any]:
    """Build the identity payload attached to every emitted event."""
    return {
        "agent_id": _get(owner, "agent_id", None) or "default",
        "agent_name": _get(owner, "agent_name", None) or "QwenPaw",
        "session_id": _get(request, "session_id", "") or "",
        "user_id": _get(request, "user_id", "") or "",
        "channel": _get(request, "channel", "") or "",
    }


# ------------------------------------------------------------ classification


def _iter_blocks(item: Any) -> Iterator[Any]:
    """Yield the content blocks carried by one streamed item.

    Handles a bare content block, a ``Message`` (``.content``) and an
    ``AgentResponse`` (``.output`` holding messages).
    """
    if item is None:
        return

    if _block_type(item) in _CONTENT_BLOCK_TYPES:
        yield item
        return

    content = _get(item, "content")
    if isinstance(content, (list, tuple)):
        yield from content
    elif content is not None and not isinstance(content, str):
        yield content

    output = _get(item, "output")
    if isinstance(output, (list, tuple)):
        for entry in output:
            yield from _iter_blocks(entry)


def _is_tool_guard_approval(item: Any) -> bool:
    """True for the approval prompt message QwenPaw streams into chat."""
    metadata = _get(item, "metadata")
    return (
        isinstance(metadata, dict)
        and metadata.get("message_type") == "tool_guard_approval"
    )


def _classify_block(block: Any) -> tuple[str | None, str | None]:
    """Map one content block to ``(event_name, text)``.

    ``(None, None)`` means "nothing worth showing on the light".
    """
    block_type = _block_type(block)

    # Tool call / tool result: DataContent carrying a FunctionCall or
    # FunctionCallOutput payload.
    if block_type == "data":
        payload = _payload_dict(block)
        if not payload:
            return None, None
        if "output" in payload:
            return "tool.result", "Tool result"
        if any(key in payload for key in _CALL_KEYS):
            name = payload.get("name") or _get(block, "name") or "tool"
            return "tool.detected", f"Using {str(name)[:40]}"
        return None, None

    # Text: the assistant started replying.
    if block_type == "text":
        text = str(_get(block, "text") or "").strip()
        if text:
            return "query.first_token", "Replying"
        return None, None

    return None, None


def classify_item(item: Any) -> tuple[str | None, str | None]:
    """Return ``(event_name, text)`` for one streamed item.

    The first classifiable block wins; a tool call is preferred over
    plain text so that a message carrying both is reported as tool usage.
    """
    if _is_tool_guard_approval(item):
        return None, None

    fallback: tuple[str | None, str | None] = (None, None)
    for block in _iter_blocks(item):
        event, text = _classify_block(block)
        if event is None:
            continue
        if event == "tool.detected":
            return event, text
        if fallback[0] is None:
            fallback = (event, text)
    return fallback


# ------------------------------------------------------------------- patching


def _wrap_stream(original: Any) -> Any:
    """Wrap an async query stream so each stage drives the ring light."""

    async def patched(self, request=None, *args, **kwargs):
        meta = _request_meta(self, request)
        last_event: str | None = None

        schedule_emit("query.received", text="New message", **meta)
        schedule_emit("query.running", text="Thinking", **meta)

        try:
            async for item in original(self, request, *args, **kwargs):
                event, text = classify_item(item)
                if event and event != last_event:
                    schedule_emit(event, text=text, **meta)
                    last_event = event
                yield item

            schedule_emit("query.done", text="Done", **meta)

        except asyncio.CancelledError:
            schedule_emit("query.cancelled", text="Interrupted", **meta)
            raise
        except Exception as exc:
            schedule_emit("query.error", text=type(exc).__name__, **meta)
            raise

    return patched


def _patch_target(owner: Any, attribute: str) -> bool:
    """Replace ``owner.attribute`` with a wrapped version, once."""
    original = getattr(owner, attribute, None)
    if original is None or getattr(original, "_agentaura_wrapped", False):
        return False
    wrapped = _wrap_stream(original)
    wrapped._agentaura_wrapped = True  # type: ignore[attr-defined]
    setattr(owner, attribute, wrapped)
    _ORIGINALS.append((owner, attribute, original))
    return True


def patch_query_stream() -> None:
    """Patch ``Workspace.stream_query`` of the running QwenPaw (>= 2.3.0).

    Raises:
        RuntimeError: when the entry point is missing — the plugin logs
            this and keeps its HTTP routes usable.
    """
    global _PATCHED

    if _PATCHED:
        return

    from qwenpaw.app.workspace.workspace import Workspace

    if not _patch_target(Workspace, "stream_query"):
        raise RuntimeError(
            "Workspace.stream_query not patchable "
            "(missing or already wrapped); lifecycle events unavailable",
        )

    _PATCHED = True
    logger.info("AgentAura patched Workspace.stream_query")


def restore_query_stream() -> None:
    """Undo every patch applied by :func:`patch_query_stream`."""
    global _PATCHED

    while _ORIGINALS:
        owner, attribute, original = _ORIGINALS.pop()
        try:
            setattr(owner, attribute, original)
        except Exception:  # pragma: no cover - defensive
            logger.debug(
                "AgentAura: failed to restore %s",
                attribute,
                exc_info=True,
            )
    _PATCHED = False
    logger.info("AgentAura restored query stream patches")
