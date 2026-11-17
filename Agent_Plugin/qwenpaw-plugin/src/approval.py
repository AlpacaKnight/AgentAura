# -*- coding: utf-8 -*-
"""Patch ``ApprovalService`` so pending approvals drive the ring light.

Targets **QwenPaw >= 2.3.0**: the three hook points used here
(``create_pending`` / ``resolve_request`` / ``cancel_all_pending_by_root_session``)
are stable, but ``resolve_request`` carries ``scope`` plus a keyword-only
``actor``. The wrappers below forward ``*args`` / ``**kwargs`` verbatim so
approval resolution keeps working even when QwenPaw adds parameters.

Adapted from ``qwenpaw-pet/patch_approval.py`` — same hook points, emit
target swapped to the ESP32 ring light.
"""

from __future__ import annotations

import logging
from typing import Any

from .mapper import schedule_emit

logger = logging.getLogger("agentaura")

_PATCHED = False
_ORIG_CREATE_PENDING: Any = None
_ORIG_RESOLVE_REQUEST: Any = None
_ORIG_CANCEL_ALL: Any = None


def patch_approval_service() -> None:
    global _PATCHED, _ORIG_CREATE_PENDING
    global _ORIG_RESOLVE_REQUEST, _ORIG_CANCEL_ALL

    if _PATCHED:
        return

    from qwenpaw.app.approvals.service import ApprovalService
    from qwenpaw.security.tool_guard.approval import ApprovalDecision

    _ORIG_CREATE_PENDING = ApprovalService.create_pending
    _ORIG_RESOLVE_REQUEST = ApprovalService.resolve_request
    _ORIG_CANCEL_ALL = ApprovalService.cancel_all_pending_by_root_session

    def _decision_event(decision: Any) -> str:
        """Map an ``ApprovalDecision`` to an event name.

        Anything that is neither approved nor denied (``timeout`` today,
        possibly more values later) is reported as a timeout.
        """
        if decision == ApprovalDecision.APPROVED:
            return "approval.approved"
        if decision == ApprovalDecision.DENIED:
            return "approval.denied"
        return "approval.timed_out"

    async def create_pending_wrapped(self, *args: Any, **kwargs: Any):
        pending = await _ORIG_CREATE_PENDING(self, *args, **kwargs)
        try:
            schedule_emit(
                "approval.pending",
                tool_name=getattr(pending, "tool_name", None),
                session_id=getattr(pending, "session_id", ""),
                agent_id=getattr(pending, "agent_id", ""),
                channel=getattr(pending, "channel", ""),
            )
        except Exception:
            logger.debug(
                "AgentAura: schedule approval.pending failed",
                exc_info=True,
            )
        return pending

    async def resolve_request_wrapped(self, *args: Any, **kwargs: Any):
        # ``args`` / ``kwargs`` are forwarded untouched: QwenPaw passes
        # ``scope=`` and the keyword-only ``actor=`` here.
        resolved = await _ORIG_RESOLVE_REQUEST(self, *args, **kwargs)
        if resolved is None:
            return None
        decision = kwargs.get("decision")
        if decision is None:
            decision = args[1] if len(args) > 1 else None
        try:
            schedule_emit(
                _decision_event(decision),
                session_id=getattr(resolved, "session_id", ""),
                agent_id=getattr(resolved, "agent_id", ""),
            )
        except Exception:
            logger.debug(
                "AgentAura: schedule approval.resolved failed",
                exc_info=True,
            )
        return resolved

    async def cancel_all_wrapped(self, root_session_id: str) -> int:
        n = await _ORIG_CANCEL_ALL(self, root_session_id)
        if n > 0:
            try:
                schedule_emit(
                    "approval.bulk_cancel",
                    session_id=root_session_id,
                )
            except Exception:
                logger.debug(
                    "AgentAura: schedule approval.bulk_cancel failed",
                    exc_info=True,
                )
        return n

    ApprovalService.create_pending = create_pending_wrapped
    ApprovalService.resolve_request = resolve_request_wrapped
    ApprovalService.cancel_all_pending_by_root_session = cancel_all_wrapped
    _PATCHED = True
    logger.info("AgentAura patched ApprovalService")


def restore_approval_service() -> None:
    global _PATCHED

    if not _PATCHED:
        return

    from qwenpaw.app.approvals.service import ApprovalService

    if _ORIG_CREATE_PENDING is not None:
        ApprovalService.create_pending = _ORIG_CREATE_PENDING
    if _ORIG_RESOLVE_REQUEST is not None:
        ApprovalService.resolve_request = _ORIG_RESOLVE_REQUEST
    if _ORIG_CANCEL_ALL is not None:
        ApprovalService.cancel_all_pending_by_root_session = _ORIG_CANCEL_ALL
    _PATCHED = False
    logger.info("AgentAura restored ApprovalService")
