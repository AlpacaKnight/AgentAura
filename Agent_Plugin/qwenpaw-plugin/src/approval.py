# -*- coding: utf-8 -*-
"""Patch ``ApprovalService`` so pending approvals drive the ring light.

Adapted from ``qwenpaw-pet/patch_approval.py`` — same hook points
(``create_pending`` / ``resolve_request`` / ``cancel_all_pending``),
emit target swapped to the ESP32 ring light.
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

    async def create_pending_wrapped(self, **kwargs: Any):
        pending = await _ORIG_CREATE_PENDING(self, **kwargs)
        try:
            schedule_emit(
                "approval.pending",
                tool_name=pending.tool_name,
                session_id=pending.session_id,
                agent_id=pending.agent_id,
                channel=pending.channel,
            )
        except Exception:
            logger.debug(
                "AgentAura: schedule approval.pending failed",
                exc_info=True,
            )
        return pending

    async def resolve_request_wrapped(self, request_id: str, decision: Any):
        resolved = await _ORIG_RESOLVE_REQUEST(self, request_id, decision)
        if resolved is None:
            return None
        try:
            if decision == ApprovalDecision.APPROVED:
                schedule_emit(
                    "approval.approved",
                    session_id=resolved.session_id,
                    agent_id=resolved.agent_id,
                )
            elif decision == ApprovalDecision.DENIED:
                schedule_emit(
                    "approval.denied",
                    session_id=resolved.session_id,
                    agent_id=resolved.agent_id,
                )
            else:
                schedule_emit(
                    "approval.timed_out",
                    session_id=resolved.session_id,
                    agent_id=resolved.agent_id,
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

    ApprovalService.create_pending = _ORIG_CREATE_PENDING
    ApprovalService.resolve_request = _ORIG_RESOLVE_REQUEST
    ApprovalService.cancel_all_pending_by_root_session = _ORIG_CANCEL_ALL
    _PATCHED = False
    logger.info("AgentAura restored ApprovalService")
