# -*- coding: utf-8 -*-
"""AgentAura backend plugin entry point.

Wires together:
  * register       — declare hooks only (no router mount yet)
  * startup hook   — patch frontend entry cache-buster, mount HTTP router,
                     apply runner/approval patches, auto-discover device,
                     emit ``init`` (rainbow)
  * shutdown hook  — emit ``offline`` (lights off), restore patches

The router is mounted inside the startup hook (not ``register``) so that
re-installing the plugin at runtime takes effect without a full QwenPaw
restart — mirroring the pattern used by the ``remote`` plugin. The
frontend cache-buster appends ``?v=<version>`` to the bundle URL so the
browser fetches the freshly-installed JS instead of serving a stale
cached copy.
"""

# pylint: disable=wrong-import-position,wrong-import-order

import logging
from typing import Any

from qwenpaw.plugins.api import PluginApi

from .src.client import RingLightClient
from .src.discovery import discover_first
from .src.mapper import dispatch_sync, schedule_emit
from .src.runner import patch_agent_runner, restore_agent_runner
from .src.approval import (
    patch_approval_service,
    restore_approval_service,
)
from .src.router import build_router
logger = logging.getLogger("agentaura")

# Plugin identity — must match plugin.json ``id``.
_PLUGIN_ID = "agentaura"
# The frontend bundle path as declared in plugin.json ``entry.frontend``.
_FRONTEND_ENTRY = "dist/index.js"


class AgentAuraPlugin:
    """Sync QwenPaw agent lifecycle to an ESP32 Ring Light."""

    def __init__(self) -> None:
        # Snapshot of the plugin config captured at ``register`` time so
        # ``_startup`` (which takes no args, matching qwenpaw-pet's hook
        # convention) can still consult ``auto_discover`` etc.
        self._auto_discover: bool = True
        self._api: PluginApi | None = None

    def register(self, api: PluginApi):
        logger.info("Registering AgentAura plugin")

        self._api = api

        # Apply user-configured host/port/debounce from the plugin config
        # system *now* (register time). Environment variables were already
        # applied at ``client`` import time and serve as
        # a fallback; explicit plugin config overrides them.
        self._apply_config(api)

        # Mount the HTTP router FIRST — if this fails (e.g. prefix conflict
        # on plugin reload), we bail before registering hooks so we don't
        # end up with hooks firing but no routes to serve config requests.
        try:
            api.register_http_router(
                build_router(),
                prefix="/agentaura",
                tags=["agentaura"],
            )
        except ValueError as e:
            # Prefix already registered — happens when the plugin is
            # re-installed without a full restart. Log and continue; the
            # previously-mounted router is still serving requests.
            logger.warning("AgentAura: router mount skipped: %s", e)

        # Hooks — frontend cache-busting + monkey patches happen in the
        # startup hook so a runtime reinstall picks them up.
        api.register_startup_hook(
            hook_name="agentaura_startup",
            callback=self._startup,
            priority=85,
        )
        api.register_shutdown_hook(
            hook_name="agentaura_shutdown",
            callback=self._shutdown,
            priority=115,
        )

        logger.info("AgentAura plugin registered")

    # -------------------------------------------------------------- helpers

    def _apply_config(self, api: PluginApi) -> None:
        cfg = getattr(api, "config", None) or {}
        kwargs: dict[str, Any] = {}
        for key, cast in (
            ("transport", str),
            ("host", str),
            ("port", int),
            ("serial_port", str),
            ("baud", int),
            ("debounce_ms", int),
            ("auth_token", str),
        ):
            val = cfg.get(key)
            if val is not None and val != "":
                try:
                    kwargs[key] = cast(val)
                except (TypeError, ValueError):
                    pass
        if kwargs:
            RingLightClient().configure(**kwargs)
        # auto_discover default true unless explicitly disabled
        auto = cfg.get("auto_discover", True)
        self._auto_discover = _truthy(auto)

    def _maybe_auto_discover(self) -> None:
        if not self._auto_discover:
            return
        client = RingLightClient()
        # Auto-discovery only makes sense for network transports — skip
        # when the user has explicitly chosen serial, or when a target
        # is already configured (env / plugin config / prior discovery).
        if client.transport_name == "serial":
            return
        if client.is_configured:
            return
        try:
            info = discover_first()
        except Exception:
            logger.warning("AgentAura: auto-discovery failed", exc_info=True)
            return
        if not info:
            logger.info("AgentAura: no device found via auto-discovery")
            return
        ip = str(info.get("ip") or "").strip()
        http_port = info.get("http") or 80
        if not ip:
            return
        # Auto-discovered devices always speak HTTP — pick that transport
        # explicitly so a prior serial choice doesn't shadow the discovery.
        client.configure(transport="http", host=ip, port=int(http_port))
        logger.info(
            "AgentAura: auto-discovered device %s (ip=%s http=%s)",
            info.get("device") or "ESP32-Ring",
            ip,
            http_port,
        )

    # ---------------------------------------------------------------- hooks

    async def _startup(self):
        """Patch frontend cache-buster, mount router, patch classes, emit ``init``.

        All side effects that touch QwenPaw internals (router mounting,
        monkey patches) happen here so that re-installing the plugin at
        runtime takes effect without a full QwenPaw restart.

        Patch failures (e.g. an upstream rename of ``AgentRunner``) are
        logged but do not abort startup — the HTTP routes remain usable
        for manual control even when event capture is unavailable.
        """
        # 1. Bust the frontend bundle cache so the browser fetches the
        #    freshly-installed JS instead of a stale cached copy.
        _patch_frontend_entry_cache_buster(self._api)

        # 2. Auto-discover the device if no explicit target was configured.
        self._maybe_auto_discover()

        # 3. Apply monkey patches for lifecycle event capture.
        try:
            patch_agent_runner()
        except Exception:
            logger.exception(
                "AgentAura: failed to patch AgentRunner; "
                "lifecycle events will be unavailable",
            )
        try:
            patch_approval_service()
        except Exception:
            logger.exception(
                "AgentAura: failed to patch ApprovalService; "
                "approval events will be unavailable",
            )

        # 4. Signal QwenPaw startup on the ring light.
        try:
            schedule_emit("qwenpaw.startup", text="QwenPaw started")
            logger.info("AgentAura startup hook complete")
        except Exception:
            logger.exception("AgentAura startup hook failed")

    def _shutdown(self):
        """Emit ``offline``, restore patches."""
        try:
            dispatch_sync("qwenpaw.shutdown", text="QwenPaw shutdown")
            RingLightClient().disconnect_agent()
        except Exception:
            logger.warning(
                "AgentAura: shutdown event emit failed",
                exc_info=True,
            )
        try:
            restore_approval_service()
            restore_agent_runner()
        except Exception:
            logger.exception("AgentAura: failed to restore class methods")
        logger.info("AgentAura shutdown hook complete")


# ---------------------------------------------------------- module-level helpers


def _patch_frontend_entry_cache_buster(api: PluginApi | None) -> None:
    """Append ``?v=<version>`` to the frontend entry URL in-memory.

    The plugin manifest stays clean (``dist/index.js``) but the running
    loader sees ``dist/index.js?v=<version>`` so the browser always fetches
    the bundle matching the currently installed version. Without this,
    re-installing the plugin would leave the console serving the
    previously-cached ``index.js`` until the user does a hard refresh.

    Adapted from ``qwenpaw-remote-plugin/remote/plugin.py``.
    """
    try:
        registry = getattr(api, "_registry", None)
        app = getattr(registry, "_plugin_http_app", None)
        loader = getattr(getattr(app, "state", None), "plugin_loader", None)
        if loader is None:
            logger.debug(
                "AgentAura: plugin loader unavailable for frontend cache busting",
            )
            return

        record = loader.get_all_loaded_plugins().get(_PLUGIN_ID)
        if record is None:
            logger.debug(
                "AgentAura: plugin record unavailable for frontend cache busting",
            )
            return

        manifest = record.manifest
        frontend = getattr(getattr(manifest, "entry", None), "frontend", None)
        if not frontend:
            return

        version = getattr(manifest, "version", "")
        # Only patch if the entry is the bare path (no query yet) — avoids
        # stacking multiple ``?v=`` on repeated startup hook invocations.
        if frontend == _FRONTEND_ENTRY and version:
            manifest.entry.frontend = f"{_FRONTEND_ENTRY}?v={version}"
            logger.info(
                "AgentAura: frontend entry exposed as %s",
                manifest.entry.frontend,
            )
    except Exception as e:
        logger.debug("AgentAura: failed to add frontend cache buster: %s", e)


def _truthy(value) -> bool:
    """Lenient bool parser for config values coming in as str/bool/int."""
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    s = str(value).strip().lower()
    return s not in ("0", "false", "no", "off", "")


plugin = AgentAuraPlugin()
