# -*- coding: utf-8 -*-
"""UDP discovery for ESP32 Ring Light devices.

The firmware listens on UDP port 8888 and answers ``discover`` / ``ping``
/ ``who`` with a JSON payload describing itself. We broadcast on the
wildcard address and collect any replies within a short window.
"""

from __future__ import annotations

import json
import ipaddress
import logging
import socket
import time
from typing import Any

logger = logging.getLogger("agentaura")

DISCOVERY_PORT = 8888
DISCOVERY_KEYWORDS = (b"discover", b"ping", b"who")
DISCOVERY_TIMEOUT_SEC = 1.5
DISCOVERY_BUFFER_SIZE = 2048


def _broadcast_addresses() -> list[str]:
    """Return limited and per-interface IPv4 broadcast addresses."""
    addresses = {"255.255.255.255"}
    try:
        import psutil  # type: ignore

        for entries in psutil.net_if_addrs().values():
            for entry in entries:
                if entry.family != socket.AF_INET or not entry.address:
                    continue
                if entry.netmask:
                    try:
                        network = ipaddress.IPv4Network(
                            f"{entry.address}/{entry.netmask}",
                            strict=False,
                        )
                        addresses.add(str(network.broadcast_address))
                    except ValueError:
                        logger.debug(
                            "ignore invalid adapter address %s/%s",
                            entry.address,
                            entry.netmask,
                        )
    except (ImportError, OSError):
        pass

    # Standard-library fallback for minimal QwenPaw installations.
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                addresses.add(str(ipaddress.IPv4Network(f"{ip}/24", strict=False).broadcast_address))
    except (OSError, ValueError):
        pass
    return sorted(addresses)


def discover_devices(
    *,
    timeout: float = DISCOVERY_TIMEOUT_SEC,
    port: int = DISCOVERY_PORT,
) -> list[dict[str, Any]]:
    """Broadcast a discovery probe and collect device replies.

    Returns a list of parsed JSON dicts. Each reply is expected to carry
    at least ``device`` / ``ip`` / ``mac`` / ``http`` fields per the
    firmware API contract; malformed replies are skipped.
    """
    found: list[dict[str, Any]] = []
    seen_keys: set[str] = set()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.settimeout(timeout)
    try:
        for bcast in _broadcast_addresses():
            for keyword in DISCOVERY_KEYWORDS:
                try:
                    sock.sendto(keyword + b"\n", (bcast, port))
                except OSError as exc:
                    logger.debug("discover sendto %s failed: %s", bcast, exc)

        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            sock.settimeout(min(remaining, 0.5))
            try:
                data, addr = sock.recvfrom(DISCOVERY_BUFFER_SIZE)
            except socket.timeout:
                continue
            except OSError as exc:
                logger.debug("discover recv failed: %s", exc)
                break
            try:
                info = json.loads(data.decode("utf-8", errors="replace"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if not isinstance(info, dict):
                continue
            ip = str(info.get("ip") or addr[0] or "")
            mac = str(info.get("mac") or "")
            key = mac or ip
            if not key or key in seen_keys:
                continue
            seen_keys.add(key)
            # Normalise: make sure ``ip`` is filled from the datagram source
            # even when the firmware omits it.
            if not info.get("ip"):
                info["ip"] = ip
            found.append(info)
    finally:
        sock.close()

    logger.info("RingLight discovery found %d device(s)", len(found))
    return found


def discover_first(
    *,
    timeout: float = DISCOVERY_TIMEOUT_SEC,
    port: int = DISCOVERY_PORT,
) -> dict[str, Any] | None:
    """Convenience wrapper: return the first device or ``None``."""
    devices = discover_devices(timeout=timeout, port=port)
    return devices[0] if devices else None
