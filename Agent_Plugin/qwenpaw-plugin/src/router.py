# -*- coding: utf-8 -*-
"""Plugin HTTP routes mounted under ``/api/agentaura``.

Provides:
  GET  /status        — plugin + device status (incl. active transport)
  GET  /devices       — UDP device discovery scan
  GET  /serial-ports  — enumerate available serial ports
  POST /connection-config — set transport + connection parameters
  POST /config        — legacy alias for /connection-config
  POST /test          — manually send an ``agent <state>`` for debugging
  POST /agent         — alias of /test (switch agent state)
  POST /command       — send an arbitrary text command
  GET  /state         — proxy to the device's state query
  POST /test-event    — simulate a QwenPaw lifecycle event
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, field_validator

from .discovery import discover_devices
from .mapper import EVENT_TO_AGENT_STATE, dispatch_sync
from .client import VALID_TRANSPORTS, RingLightClient

# agent states the firmware actually implements (per doc/API.md §9)
_VALID_AGENT_STATES = {
    "running",
    "busy",
    "waiting",
    "error",
    "idle",
    "init",
    "offline",
    "upgrade",
}


class ConfigRequest(BaseModel):
    """Full connection configuration.

    All fields are optional — only the fields actually present in the
    request body are applied. The frontend sends the complete form each
    time so the backend always has a consistent snapshot.
    """

    model_config = ConfigDict(extra="forbid")

    transport: str | None = None
    host: str | None = None
    port: int | None = None
    serial_port: str | None = None
    baud: int | None = None
    debounce_ms: int | None = None
    auto_discover: bool | None = None

    @field_validator("transport")
    @classmethod
    def _valid_transport(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip().lower()
        if v not in VALID_TRANSPORTS:
            raise ValueError(
                f"transport must be one of {list(VALID_TRANSPORTS)}",
            )
        return v

    @field_validator("port")
    @classmethod
    def _port_range(cls, v: int | None) -> int | None:
        if v is None:
            return v
        if not (1 <= v <= 65535):
            raise ValueError("port must be in 1..65535")
        return v

    @field_validator("baud")
    @classmethod
    def _baud_range(cls, v: int | None) -> int | None:
        if v is None:
            return v
        if not (1200 <= v <= 4_000_000):
            raise ValueError("baud must be in 1200..4000000")
        return v

    @field_validator("debounce_ms")
    @classmethod
    def _debounce_range(cls, v: int | None) -> int | None:
        if v is None:
            return v
        if not (0 <= v <= 60_000):
            raise ValueError("debounce_ms must be in 0..60000")
        return v


class AgentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: str

    @field_validator("state")
    @classmethod
    def _valid_state(cls, v: str) -> str:
        v = (v or "").strip().lower()
        if v not in _VALID_AGENT_STATES:
            raise ValueError(
                f"state must be one of {sorted(_VALID_AGENT_STATES)}",
            )
        return v


class CommandRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command: str


class TestEmitRequest(BaseModel):
    """Drive the full event->state pipeline from the UI."""
    model_config = ConfigDict(extra="forbid")
    event: str

    @field_validator("event")
    @classmethod
    def _known_event(cls, v: str) -> str:
        v = (v or "").strip()
        if v not in EVENT_TO_AGENT_STATE:
            raise ValueError(
                f"unknown event {v!r}; known: {sorted(EVENT_TO_AGENT_STATE)}",
            )
        return v


def _list_serial_ports() -> list[dict[str, Any]]:
    """Enumerate available serial ports via ``pyserial``.

    Returns ``[]`` when pyserial is not installed — the frontend shows a
    hint to install it in that case.
    """
    try:
        from serial.tools import list_ports  # type: ignore
    except ImportError:
        return []
    out: list[dict[str, Any]] = []
    try:
        for info in list_ports.comports():
            out.append(
                {
                    "device": info.device,
                    "description": info.description or "",
                    "manufacturer": info.manufacturer or "",
                    "vid": (
                        f"0x{info.vid:04X}" if info.vid is not None else None
                    ),
                    "pid": (
                        f"0x{info.pid:04X}" if info.pid is not None else None
                    ),
                },
            )
    except Exception:
        # Defensive: never let a port-enumeration failure break the route.
        return []
    return out


def build_router() -> APIRouter:
    router = APIRouter()

    @router.get("/status")
    def status() -> dict[str, Any]:
        client = RingLightClient()
        return {
            "ok": True,
            "plugin": "agentaura",
            "client": client.status_summary(),
        }

    @router.get("/devices")
    def devices() -> dict[str, Any]:
        found = discover_devices()
        return {"ok": True, "devices": found}

    @router.get("/serial-ports")
    def serial_ports() -> dict[str, Any]:
        return {"ok": True, "ports": _list_serial_ports()}

    @router.post("/config", include_in_schema=False)
    @router.post("/connection-config")
    def config(payload: ConfigRequest) -> dict[str, Any]:
        client = RingLightClient()
        client.configure(
            transport=payload.transport,
            host=payload.host,
            port=payload.port,
            serial_port=payload.serial_port,
            baud=payload.baud,
            debounce_ms=payload.debounce_ms,
        )
        return {
            "ok": True,
            "transport": client.transport_name,
            "host": client.host,
            "port": client.port,
            "serial_port": client.serial_port,
            "baud": client.baud,
            "debounce_ms": client.debounce_ms,
            "auto_discover": payload.auto_discover,
            "configured": client.is_configured,
        }

    @router.post("/agent")
    def agent(payload: AgentRequest) -> dict[str, Any]:
        ok = RingLightClient().set_agent_state(payload.state)
        if not ok:
            raise HTTPException(
                status_code=503,
                detail="device unreachable; check connection config or /devices",
            )
        return {"ok": True, "state": payload.state}

    @router.post("/test")
    def test(payload: AgentRequest) -> dict[str, Any]:
        # alias of /agent — kept for parity with qwenpaw-pet's /emit-test
        return agent(payload)

    @router.post("/test-event")
    def test_event(payload: TestEmitRequest) -> dict[str, Any]:
        dispatch_sync(payload.event)
        mapped = EVENT_TO_AGENT_STATE.get(payload.event)
        return {"ok": True, "event": payload.event, "mapped_state": mapped}

    @router.post("/command")
    def command(payload: CommandRequest) -> dict[str, Any]:
        cmd = (payload.command or "").strip()
        if not cmd:
            raise HTTPException(status_code=400, detail="command is required")
        ok = RingLightClient().send_command(cmd)
        if not ok:
            raise HTTPException(
                status_code=503,
                detail="device unreachable; check connection config or /devices",
            )
        return {"ok": True, "command": cmd}

    @router.get("/state")
    def device_state() -> dict[str, Any]:
        state = RingLightClient().health()
        if state is None:
            raise HTTPException(
                status_code=503,
                detail="device unreachable; check connection config or /devices",
            )
        return {"ok": True, "device": state}

    return router
