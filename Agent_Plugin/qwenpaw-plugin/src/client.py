# -*- coding: utf-8 -*-
"""Fire-and-forget transport client for the ESP32 Ring Light device.

Supports three connection modes per the firmware's API contract
(see ``doc/API.md``):

  * ``http`` — REST API (``POST /api/cmd``), default. Best for WiFi.
  * ``udp``  — text commands to UDP port 8888. Lowest latency, no
               connection setup, but no delivery guarantee.
  * ``serial`` — USB CDC (115200 baud). Best for direct-attached
                 development; requires ``pyserial``.

All three transports share the same ``agent <state>`` / ``rgb ...`` text
command format, so the choice only affects the wire protocol. A single
``RingLightClient`` singleton delegates to the active transport and
swaps it atomically when the UI changes the connection mode.

Mirrors the reachability-probe pattern from qwenpaw-pet's ``emitter.py``:
once a request fails, the client goes into a short "unreachable" cooldown
so the QwenPaw main loop is never stalled by repeated timeouts against
an offline device.
"""

from __future__ import annotations

import logging
import os
import socket
import threading
import time
import json
from typing import Any

import httpx

logger = logging.getLogger("agentaura")

# Cooldown after a failed probe / request before we try the device again.
_UNREACHABLE_COOLDOWN_SEC = 3.0
_PETDESKTOP_HEARTBEAT_SEC = 10.0
_PLUGIN_VERSION = "0.3.0"

# Lock around mutating the cached config (UI + discovery may both write).
_CONFIG_LOCK = threading.RLock()

VALID_TRANSPORTS = ("http", "udp", "serial")


# ============================================================== transports
class _Transport:
    """Base class — subclasses implement the wire protocol."""

    name = "base"

    def send_command(self, command: str) -> bool:  # pragma: no cover - abstract
        raise NotImplementedError

    def health(self) -> dict[str, Any] | None:  # pragma: no cover - abstract
        raise NotImplementedError

    def describe(self) -> dict[str, Any]:  # pragma: no cover - abstract
        raise NotImplementedError


class _HttpTransport(_Transport):
    """REST API transport (``POST /api/cmd`` / ``GET /api/state``)."""

    name = "http"

    def __init__(self, host: str, port: int = 80, auth_token: str = "") -> None:
        self._host = host
        self._port = port
        self._auth_token = auth_token

    def _base_url(self) -> str:
        return f"http://{self._host}:{self._port}"

    def _auth_headers(self) -> dict[str, str]:
        """Return ``Authorization: Bearer <token>`` when token is set."""
        if self._auth_token:
            return {"Authorization": f"Bearer {self._auth_token}"}
        return {}

    def send_command(self, command: str) -> bool:
        try:
            resp = httpx.post(
                f"{self._base_url()}/api/cmd",
                content=command,
                headers={"Content-Type": "text/plain", **self._auth_headers()},
                trust_env=False,
                timeout=0.35,
            )
            if resp.status_code >= 400:
                logger.warning(
                    "AgentAura[http] cmd %r -> HTTP %s: %s",
                    command,
                    resp.status_code,
                    (resp.text or "")[:120],
                )
                return False
            body = (resp.text or "").strip()
            if body.startswith("OK"):
                return True
            logger.warning(
                "AgentAura[http] cmd %r -> non-OK body: %s",
                command,
                body[:120],
            )
            return False
        except Exception as exc:
            logger.debug("AgentAura[http] cmd %r failed: %s", command, exc)
            return False

    def request_json(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        instance_id: str = "",
    ) -> tuple[int, dict[str, Any] | None]:
        """Call a PetDesktop JSON endpoint without raising."""
        headers = {
            "Content-Type": "application/json",
            "x-agentaura-client": "qwenpaw",
            "x-agentaura-display-name": "QwenPaw",
            **self._auth_headers(),
        }
        if instance_id:
            headers["x-agentaura-instance"] = instance_id
        try:
            resp = httpx.request(
                method,
                f"{self._base_url()}{path}",
                content=json.dumps(payload, ensure_ascii=False) if payload is not None else None,
                headers=headers,
                trust_env=False,
                timeout=1.0,
            )
            try:
                body = resp.json()
            except Exception:
                body = None
            return resp.status_code, body if isinstance(body, dict) else None
        except Exception as exc:
            logger.debug("AgentAura[http] %s %s failed: %s", method, path, exc)
            return 0, None

    def health(self) -> dict[str, Any] | None:
        try:
            resp = httpx.get(
                f"{self._base_url()}/api/state",
                headers=self._auth_headers(),
                trust_env=False,
                timeout=1.0,
            )
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict):
                return data
        except Exception as exc:
            logger.debug("AgentAura[http] health probe failed: %s", exc)
        return None

    def describe(self) -> dict[str, Any]:
        return {"transport": "http", "host": self._host, "port": self._port}


class _UdpTransport(_Transport):
    """UDP text-command transport (port 8888).

    The firmware replies to every datagram, so we treat a successful
    ``recvfrom`` within the timeout as the health signal. There is no
    separate ``/api/state`` endpoint over UDP.
    """

    name = "udp"

    def __init__(self, host: str, port: int = 8888) -> None:
        self._host = host
        self._port = port

    def _exchange(self, command: str, *, timeout: float) -> bytes | None:
        """Send ``command`` and return the reply payload, or ``None``."""
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(timeout)
            try:
                s.sendto((command + "\n").encode("utf-8"), (self._host, self._port))
                data, _ = s.recvfrom(2048)
                return data
            except OSError as exc:
                logger.debug("RingLight[udp] %r failed: %s", command, exc)
                return None

    def send_command(self, command: str) -> bool:
        data = self._exchange(command, timeout=0.35)
        if data is None:
            return False
        body = data.decode("utf-8", errors="replace").strip()
        if body.startswith("OK"):
            return True
        logger.warning("RingLight[udp] cmd %r -> non-OK body: %s", command, body[:120])
        return False

    def health(self) -> dict[str, Any] | None:
        # ``state`` is a valid firmware command that returns the full JSON
        # status — perfect as a UDP health probe.
        data = self._exchange("state", timeout=1.0)
        if data is None:
            return None
        import json

        try:
            parsed = json.loads(data.decode("utf-8", errors="replace"))
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, UnicodeDecodeError):
            # Some firmware builds reply with a plain-text ack; treat any
            # non-empty reply as "reachable" and surface the raw text.
            text = data.decode("utf-8", errors="replace").strip()
            return {"reachable": True, "raw": text}
        return None

    def describe(self) -> dict[str, Any]:
        return {"transport": "udp", "host": self._host, "port": self._port}


class _SerialTransport(_Transport):
    """USB CDC serial transport (115200 baud, LF line ending).

    Requires ``pyserial`` — a soft import so the plugin still loads on
    hosts that don't have it installed (the transport just reports
    unreachable until the user installs it and reconfigures).
    """

    name = "serial"
    _BAUD = 115200

    def __init__(self, port: str, baud: int = _BAUD) -> None:
        self._port = port
        self._baud = baud
        self._conn: Any = None
        self._conn_lock = threading.Lock()

    def _ensure_open(self) -> Any | None:
        """Lazily open the serial port, reusing an existing connection."""
        with self._conn_lock:
            if self._conn is not None:
                try:
                    # Drain any stale bytes so the next readline() is clean.
                    if self._conn.in_waiting:
                        self._conn.read(self._conn.in_waiting)
                    return self._conn
                except Exception:
                    self._close_locked()
            try:
                import serial  # type: ignore
            except ImportError:
                logger.warning(
                    "RingLight[serial]: pyserial not installed; "
                    'run `pip install pyserial` to use the serial transport',
                )
                return None
            try:
                self._conn = serial.Serial(
                    self._port,
                    self._baud,
                    timeout=0.35,
                    write_timeout=0.35,
                )
                return self._conn
            except Exception as exc:
                logger.debug("RingLight[serial] open %s failed: %s", self._port, exc)
                self._conn = None
                return None

    def _close_locked(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None

    def close(self) -> None:
        with self._conn_lock:
            self._close_locked()

    def send_command(self, command: str) -> bool:
        conn = self._ensure_open()
        if conn is None:
            return False
        try:
            conn.write((command + "\n").encode("utf-8"))
            # Read one line back — the firmware always replies with
            # ``OK ...`` / ``ERR ...``.
            line = conn.readline()
            body = line.decode("utf-8", errors="replace").strip()
            if body.startswith("OK"):
                return True
            logger.warning(
                "RingLight[serial] cmd %r -> non-OK body: %s",
                command,
                body[:120],
            )
            return False
        except Exception as exc:
            logger.debug("RingLight[serial] cmd %r failed: %s", command, exc)
            with self._conn_lock:
                self._close_locked()
            return False

    def health(self) -> dict[str, Any] | None:
        conn = self._ensure_open()
        if conn is None:
            return None
        try:
            conn.write(b"state\n")
            # ``state`` returns a multi-line JSON blob; read until we get
            # a closing brace. Cap at 4KB / 1s so a misbehaving firmware
            # can't stall us forever.
            buf = bytearray()
            deadline = time.monotonic() + 1.0
            while time.monotonic() < deadline and len(buf) < 4096:
                chunk = conn.read(256)
                if not chunk:
                    break
                buf.extend(chunk)
                if b"}" in buf:
                    break
            import json

            text = buf.decode("utf-8", errors="replace").strip()
            try:
                parsed = json.loads(text)
                if isinstance(parsed, dict):
                    return parsed
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass
            # Any reply at all means the port is alive.
            return {"reachable": True, "raw": text[:200]} if text else None
        except Exception as exc:
            logger.debug("RingLight[serial] health failed: %s", exc)
            with self._conn_lock:
                self._close_locked()
            return None

    def describe(self) -> dict[str, Any]:
        return {
            "transport": "serial",
            "port": self._port,
            "baud": self._baud,
        }


# ============================================================== client
def _build_transport(
    transport: str,
    *,
    host: str,
    port: int | None,
    serial_port: str,
    baud: int | None,
    auth_token: str = "",
) -> _Transport | None:
    """Factory: construct the transport for the active mode."""
    transport = (transport or "").strip().lower()
    if transport == "http":
        if not host:
            return None
        return _HttpTransport(host, port or 80, auth_token=auth_token)
    if transport == "udp":
        if not host:
            return None
        return _UdpTransport(host, port or 8888)
    if transport == "serial":
        if not serial_port:
            return None
        return _SerialTransport(serial_port, baud or _SerialTransport._BAUD)
    return None


class RingLightClient:
    """Singleton bridge to one ESP32 Ring Light device.

    Delegates to a swappable ``_Transport`` so the UI can switch between
    HTTP / UDP / USB serial at runtime without restarting QwenPaw. Safe
    to call from both sync and async code paths — callers inside an
    asyncio loop should dispatch via ``asyncio.to_thread`` (see
    ``schedule_emit`` in ``mapper.py``).
    """

    _instance: "RingLightClient | None" = None
    _instance_lock = threading.Lock()

    def __new__(cls) -> "RingLightClient":
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._init_state()
        return cls._instance

    def _init_state(self) -> None:
        self._transport_name: str = "http"
        self._host: str = ""
        self._port: int | None = None
        self._serial_port: str = ""
        self._baud: int | None = None
        self._auth_token: str = ""
        self._transport: _Transport | None = None
        self._unreachable_until: float = 0.0
        self._last_state: str = ""
        self._last_state_ts: float = 0.0
        self._debounce_ms: int = 500
        host_id = "".join(
            ch if ch.isalnum() or ch in "-_" else "-"
            for ch in socket.gethostname().lower()
        ).strip("-") or "host"
        self._instance_id = f"qwenpaw-{host_id}-{os.getpid()}"
        self._http_target: str = "unknown"
        self._session_generation = 0
        self._session_lock = threading.RLock()
        self._heartbeat_stop: threading.Event | None = None
        self._heartbeat_thread: threading.Thread | None = None

    # ------------------------------------------------------------------ config

    def configure(
        self,
        *,
        transport: str | None = None,
        host: str | None = None,
        port: int | None = None,
        serial_port: str | None = None,
        baud: int | None = None,
        debounce_ms: int | None = None,
        auth_token: str | None = None,
    ) -> None:
        """Update connection parameters and (re)build the active transport.

        Any field left as ``None`` is preserved; pass an empty string to
        clear ``host`` / ``serial_port`` / ``auth_token``.
        """
        with _CONFIG_LOCK:
            changed = False
            if transport is not None and transport.strip().lower() in VALID_TRANSPORTS:
                new_t = transport.strip().lower()
                if new_t != self._transport_name:
                    self._transport_name = new_t
                    changed = True
            if host is not None and host.strip() != self._host:
                self._host = host.strip()
                changed = True
            if port is not None and port != self._port:
                self._port = int(port)
                changed = True
            if serial_port is not None and serial_port.strip() != self._serial_port:
                self._serial_port = serial_port.strip()
                changed = True
            if baud is not None and baud != self._baud:
                self._baud = int(baud)
                changed = True
            if debounce_ms is not None and debounce_ms != self._debounce_ms:
                self._debounce_ms = max(0, int(debounce_ms))
            if auth_token is not None and auth_token != self._auth_token:
                self._auth_token = auth_token
                changed = True

            if changed:
                self.disconnect_agent()
                # Close the old serial connection (if any) before swapping.
                old = self._transport
                if isinstance(old, _SerialTransport):
                    old.close()
                self._transport = _build_transport(
                    self._transport_name,
                    host=self._host,
                    port=self._port,
                    serial_port=self._serial_port,
                    baud=self._baud,
                    auth_token=self._auth_token,
                )
                # New target: clear prior unreachable flag + debounce cache.
                self._unreachable_until = 0.0
                self._last_state = ""
                self._http_target = "unknown"
                logger.info(
                    "RingLight client reconfigured: %s -> %s",
                    self._transport_name,
                    self._transport.describe() if self._transport else "(unset)",
                )

    @property
    def transport_name(self) -> str:
        return self._transport_name

    @property
    def host(self) -> str:
        return self._host

    @property
    def port(self) -> int | None:
        return self._port

    @property
    def serial_port(self) -> str:
        return self._serial_port

    @property
    def baud(self) -> int | None:
        return self._baud

    @property
    def auth_token(self) -> str:
        return self._auth_token

    @property
    def debounce_ms(self) -> int:
        return self._debounce_ms

    @property
    def is_configured(self) -> bool:
        return self._transport is not None

    # ------------------------------------------------------------------ health

    def _is_reachable(self) -> bool:
        if self._transport is None:
            return False
        if time.monotonic() < self._unreachable_until:
            return False
        return True

    def _mark_unreachable(self) -> None:
        self._unreachable_until = time.monotonic() + _UNREACHABLE_COOLDOWN_SEC

    def _mark_reachable(self) -> None:
        self._unreachable_until = 0.0

    def health(self) -> dict[str, Any] | None:
        """Probe the device and cache reachability.

        Returns the parsed state JSON on success, ``None`` when the device
        is offline / unconfigured.
        """
        if self._transport is None:
            return None
        state = self._transport.health()
        if state is not None:
            self._mark_reachable()
        else:
            self._mark_unreachable()
        return state

    def status_summary(self) -> dict[str, Any]:
        """Plugin-side status for the HTTP ``/status`` route."""
        if self._transport is None:
            return {
                "configured": False,
                "transport": self._transport_name,
                "has_auth_token": bool(self._auth_token),
                "reachable": False,
            }
        state = self.health()
        return {
            "configured": True,
            "transport": self._transport_name,
            "has_auth_token": bool(self._auth_token),
            **self._transport.describe(),
            "reachable": state is not None,
            "device_state": state,
        }

    # ------------------------------------------------------------------ commands

    def send_command(self, command: str) -> bool:
        """Send an arbitrary text command via the active transport.

        Returns ``True`` only when the device acknowledged with ``OK``.
        Never raises — callers in the QwenPaw main path must not be
        disrupted by a missing piece of hardware.
        """
        if not self._is_reachable():
            return False
        ok = self._transport.send_command(command)  # type: ignore[union-attr]
        if ok:
            self._mark_reachable()
        else:
            self._mark_unreachable()
        return ok

    def set_agent_state(self, state: str) -> bool:
        """Send ``agent <state>`` with debounce.

        Repeated identical states within ``debounce_ms`` are skipped to
        avoid restarting the light effect (e.g. ``busy -> busy`` would
        otherwise relaunch the ``flow`` animation each tool call).
        """
        if not state:
            return False
        now = time.monotonic()
        if (
            state == self._last_state
            and (now - self._last_state_ts) * 1000 < self._debounce_ms
            and not (
                isinstance(self._transport, _HttpTransport)
                and self._http_target == "unknown"
            )
        ):
            return True  # treat as success; the device is already in this state
        if isinstance(self._transport, _HttpTransport):
            ok = self._send_http_agent_state(state)
        else:
            ok = self.send_command(f"agent {state}")
        if ok:
            self._last_state = state
            self._last_state_ts = now
        return ok

    def send_message(
        self,
        text: str,
        kind: str = "activity",
        priority: int | None = None,
        ttl_ms: int = 5000,
    ) -> bool:
        """Send a desktop-pet bubble; firmware targets ignore it."""
        clean_text = (text or "").strip()
        transport = self._transport
        if not clean_text or not isinstance(transport, _HttpTransport):
            return False
        with self._session_lock:
            generation = self._session_generation
        if self._http_target == "unknown":
            self._register_petdesktop(
                self._last_state or "running",
                generation,
            )
        if self._http_target != "petdesktop":
            return False
        status, _ = transport.request_json(
            "POST",
            f"/api/v1/agents/{self._instance_id}/message",
            {
                "text": clean_text[:500],
                "kind": kind,
                "priority": priority,
                "ttlMs": max(500, int(ttl_ms)),
            },
            instance_id=self._instance_id,
        )
        with self._session_lock:
            if generation != self._session_generation:
                return False
        if status == 404 and self._register_petdesktop(
            self._last_state or "running",
            generation,
        ):
            status, _ = transport.request_json(
                "POST",
                f"/api/v1/agents/{self._instance_id}/message",
                {
                    "text": clean_text[:500],
                    "kind": kind,
                    "priority": priority,
                    "ttlMs": max(500, int(ttl_ms)),
                },
                instance_id=self._instance_id,
            )
        with self._session_lock:
            return (
                generation == self._session_generation
                and 200 <= status < 300
            )

    def disconnect_agent(self) -> None:
        """Stop heartbeat and remove this process from PetDesktop."""
        with self._session_lock:
            self._session_generation += 1
            transport = self._transport
            should_delete = (
                self._http_target == "petdesktop"
                and isinstance(transport, _HttpTransport)
            )
            self._http_target = "unknown"
        self._stop_heartbeat()
        if should_delete and isinstance(transport, _HttpTransport):
            transport.request_json(
                "DELETE",
                f"/api/v1/agents/{self._instance_id}",
                instance_id=self._instance_id,
            )

    def _send_http_agent_state(self, state: str) -> bool:
        transport = self._transport
        if not isinstance(transport, _HttpTransport):
            return False
        with self._session_lock:
            generation = self._session_generation
        if self._http_target == "unknown":
            self._register_petdesktop(state, generation)
        with self._session_lock:
            if generation != self._session_generation:
                return False
        if self._http_target == "petdesktop":
            status, _ = transport.request_json(
                "POST",
                f"/api/v1/agents/{self._instance_id}/state",
                {"state": state},
                instance_id=self._instance_id,
            )
            with self._session_lock:
                if generation != self._session_generation:
                    return False
            if status == 404 and self._register_petdesktop(state, generation):
                status, _ = transport.request_json(
                    "POST",
                    f"/api/v1/agents/{self._instance_id}/state",
                    {"state": state},
                    instance_id=self._instance_id,
                )
            with self._session_lock:
                return (
                    generation == self._session_generation
                    and 200 <= status < 300
                )
        return self.send_command(f"agent {state}")

    def _register_petdesktop(
        self,
        state: str,
        expected_generation: int | None = None,
    ) -> bool:
        transport = self._transport
        if not isinstance(transport, _HttpTransport):
            return False
        with self._session_lock:
            generation = (
                self._session_generation
                if expected_generation is None
                else expected_generation
            )
            if generation != self._session_generation:
                return False
        status, body = transport.request_json(
            "POST",
            "/api/v1/agents/register",
            {
                "clientId": "qwenpaw",
                "instanceId": self._instance_id,
                "displayName": "QwenPaw",
                "version": _PLUGIN_VERSION,
                "state": state,
            },
            instance_id=self._instance_id,
        )
        with self._session_lock:
            if generation != self._session_generation or transport is not self._transport:
                return False
            if not 200 <= status < 300:
                self._http_target = (
                    "firmware" if status in (404, 405) else "unknown"
                )
                return False
            self._http_target = "petdesktop"
        interval_ms = int((body or {}).get("heartbeatIntervalMs") or 10_000)
        self._start_heartbeat(
            max(3.0, min(30.0, interval_ms / 1000)),
            generation,
        )
        return True

    def _start_heartbeat(
        self,
        interval_sec: float = _PETDESKTOP_HEARTBEAT_SEC,
        generation: int | None = None,
    ) -> None:
        with self._session_lock:
            active_generation = (
                self._session_generation if generation is None else generation
            )
            if active_generation != self._session_generation:
                return
            if self._heartbeat_thread and self._heartbeat_thread.is_alive():
                return
            stop_event = threading.Event()

            def run() -> None:
                while not stop_event.wait(interval_sec):
                    with self._session_lock:
                        if active_generation != self._session_generation:
                            return
                    transport = self._transport
                    if self._http_target != "petdesktop" or not isinstance(transport, _HttpTransport):
                        return
                    status, _ = transport.request_json(
                        "POST",
                        f"/api/v1/agents/{self._instance_id}/heartbeat",
                        instance_id=self._instance_id,
                    )
                    if not 200 <= status < 300:
                        with self._session_lock:
                            if (
                                stop_event.is_set()
                                or active_generation != self._session_generation
                            ):
                                return
                            self._http_target = "unknown"
                        if not self._register_petdesktop(
                            self._last_state or "idle",
                            active_generation,
                        ):
                            return

            thread = threading.Thread(
                target=run,
                name="agentaura-qwenpaw-heartbeat",
                daemon=True,
            )
            self._heartbeat_stop = stop_event
            self._heartbeat_thread = thread
            thread.start()

    def _stop_heartbeat(self) -> None:
        with self._session_lock:
            stop_event = self._heartbeat_stop
            thread = self._heartbeat_thread
            if stop_event:
                stop_event.set()
        if thread and thread is not threading.current_thread():
            thread.join(timeout=1.2)
        with self._session_lock:
            if self._heartbeat_thread is thread:
                self._heartbeat_thread = None
            if self._heartbeat_stop is stop_event:
                self._heartbeat_stop = None

    def set_color(self, r: int, g: int, b: int) -> bool:
        return self.send_command(f"rgb {r},{g},{b}")

    def set_effect(self, effect: str, r: int = 0, g: int = 0, b: int = 0) -> bool:
        return self.send_command(f"effect {effect} {r},{g},{b}")

    def set_power(self, on: bool) -> bool:
        return self.send_command("power on" if on else "power off")


# ---------------------------------------------------------------- env override

def _apply_env_config() -> None:
    """One-time bootstrap from environment variables on module import."""
    client = RingLightClient()
    transport = os.environ.get("AGENTAURA_TRANSPORT", "").strip().lower() or None
    host = os.environ.get("AGENTAURA_HOST", "").strip() or None
    port_raw = os.environ.get("AGENTAURA_PORT", "").strip()
    serial_port = os.environ.get("AGENTAURA_SERIAL_PORT", "").strip() or None
    baud_raw = os.environ.get("AGENTAURA_BAUD", "").strip()
    debounce_raw = os.environ.get("AGENTAURA_DEBOUNCE_MS", "").strip()
    auth_token = os.environ.get("AGENTAURA_AUTH_TOKEN", "").strip() or None
    port = int(port_raw) if port_raw.isdigit() else None
    baud = int(baud_raw) if baud_raw.isdigit() else None
    debounce = int(debounce_raw) if debounce_raw.isdigit() else None
    if (
        transport
        or host
        or port is not None
        or serial_port
        or baud is not None
        or debounce is not None
        or auth_token
    ):
        client.configure(
            transport=transport,
            host=host,
            port=port,
            serial_port=serial_port,
            baud=baud,
            debounce_ms=debounce,
            auth_token=auth_token,
        )


_apply_env_config()
