# -*- coding: utf-8 -*-
"""AgentAura backend plugin entry point.

Wires together:
  * register       — declare hooks and mount the HTTP router
  * startup hook   — refresh the frontend entry cache-buster, apply the
                     query-stream / approval patches, then (in the
                     background) install missing optional deps, discover the
                     device and emit ``init`` (rainbow)
  * shutdown hook  — emit ``offline`` (lights off), restore patches

This build targets **QwenPaw >= 2.3.0** only: support for 1.x/2.0–2.2 was
dropped so the event capture can rely on one stable entry point
(``Workspace.stream_query``) instead of fallback chains.

The QwenPaw 2.3.0 plugin contract this file has to satisfy:

* Declared ``dependencies`` are enforced *before* the backend is imported
  (``DependencyGate``). A single missing wheel marks the whole plugin
  ``failed`` — so only packages the plugin really needs at import time may
  be declared. ``pyserial`` / ``psutil`` are optional extras (serial
  transport and per-adapter discovery broadcast), imported lazily, and
  auto-installed by ``src/deps.py`` into QwenPaw's plugin dependency site
  on startup — so no manual ``pip install`` is needed.
* Startup-hook exceptions fail the plugin, so every side effect here is
  defensive: a broken internal (e.g. a renamed query stream) must not take
  the HTTP routes down with it.
* ``register_shutdown_hook`` is deprecated (still functional); the warning
  is suppressed so plugin logs stay readable.
"""

# pylint: disable=wrong-import-position,wrong-import-order

import logging
import threading
import warnings
from pathlib import Path
from typing import Any

from qwenpaw.plugins.api import PluginApi

from .src import deps
from .src.client import RingLightClient
from .src.frontend import cache_token
from .src.discovery import discover_first
from .src.mapper import dispatch_sync, schedule_emit
from .src.runner import patch_query_stream, restore_query_stream
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
# Oldest QwenPaw this build supports (must match plugin.json).
_MIN_QWENPAW = (2, 3, 0)
# Reported by /status; must match plugin.json ``version``.
_PLUGIN_VERSION = "0.3.1"


class AgentAuraPlugin:
    """Sync QwenPaw agent lifecycle to an ESP32 Ring Light."""

    def __init__(self) -> None:
        # Snapshot of the plugin config captured at ``register`` time so
        # ``_startup`` (which takes no args, matching qwenpaw-pet's hook
        # convention) can still consult ``auto_discover`` etc.
        self._auto_discover: bool = True
        self._auto_install_deps: bool = True
        self._api: PluginApi | None = None
        # Keeps a reference to the background bootstrap thread so it is not
        # garbage collected mid-flight.
        self._bootstrap_thread: threading.Thread | None = None

    def register(self, api: PluginApi):
        logger.info(
            "Registering AgentAura plugin (QwenPaw %s)",
            _qwenpaw_version(),
        )

        self._api = api
        self._warn_if_unsupported()

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
        # QwenPaw 2.3.0 marks register_shutdown_hook deprecated; it still
        # runs, the DeprecationWarning is just noise in the plugin log.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            api.register_shutdown_hook(
                hook_name="agentaura_shutdown",
                callback=self._shutdown,
                priority=115,
            )

        try:
            # Make a dependency site populated by an earlier boot importable
            # again before reporting what is missing.
            deps.expose_install_target()
            absent = deps.missing()
        except Exception:  # pragma: no cover - defensive
            absent = []
        if absent:
            logger.info(
                "AgentAura: optional deps not importable yet (%s); "
                "they will be installed in the background",
                ", ".join(absent),
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
        # auto_install_deps default true unless explicitly disabled
        self._auto_install_deps = _truthy(cfg.get("auto_install_deps", True))

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

    def _start_background_bootstrap(self) -> None:
        """Install optional deps and discover the device off the hot path.

        Both steps are slow (pip download, UDP broadcast ~1.5 s) and QwenPaw
        2.3.0 runs startup hooks on the event loop, so they must not block.
        Order matters: ``psutil`` improves the discovery broadcast, and the
        serial transport needs ``pyserial`` before the user retries.
        """
        needs_work = self._auto_install_deps or self._auto_discover
        if not needs_work:
            return

        thread = threading.Thread(
            target=self._bootstrap,
            name="agentaura-bootstrap",
            daemon=True,
        )
        thread.start()
        self._bootstrap_thread = thread

    def _bootstrap(self) -> None:
        """Background worker: optional deps first, then device discovery."""
        if self._auto_install_deps:
            try:
                # A site populated on a previous boot is importable once it is
                # back on sys.path — usually turns this into a no-op.
                deps.expose_install_target()
            except Exception:  # pragma: no cover - defensive
                logger.debug("AgentAura: sys.path expose failed", exc_info=True)
            try:
                result = deps.ensure()
                if result.get("installed"):
                    logger.info(
                        "AgentAura: installed optional deps %s",
                        ", ".join(result["installed"]),
                    )
                elif result.get("failed"):
                    logger.warning(
                        "AgentAura: optional deps still missing (%s): %s. "
                        "Install them manually in the QwenPaw environment "
                        "if the host is offline.",
                        ", ".join(result["failed"]),
                        result.get("detail") or "pip failed",
                    )
            except Exception:
                logger.warning(
                    "AgentAura: optional dependency bootstrap failed",
                    exc_info=True,
                )
        try:
            self._maybe_auto_discover()
        except Exception:
            logger.warning("AgentAura: auto-discovery failed", exc_info=True)

    def _warn_if_unsupported(self) -> None:
        """Log a warning when the host is older than the supported range.

        The manifest gate (``qwenpaw_version.min``) normally refuses such
        hosts before this code runs; this only helps when the plugin was
        force-installed.
        """
        current = _parse_version(_qwenpaw_version())
        if current is None:
            return
        if current < _MIN_QWENPAW:
            logger.warning(
                "AgentAura %s requires QwenPaw >= %s but the host is %s; "
                "lifecycle events will not work",
                _PLUGIN_VERSION,
                ".".join(str(part) for part in _MIN_QWENPAW),
                ".".join(str(part) for part in current),
            )

    # ---------------------------------------------------------------- hooks

    async def _startup(self):
        """Patch the query stream + approvals, discover device, emit ``init``.

        All side effects that touch QwenPaw internals happen here so that
        re-installing the plugin at runtime takes effect without a full
        QwenPaw restart.

        Every step is individually guarded: QwenPaw 2.3.x fails a plugin
        whose startup hook raises, and the HTTP routes must stay usable
        for manual control even when event capture is unavailable.
        """
        # 1. Bust the frontend bundle cache so the browser fetches the
        #    freshly-installed JS instead of a stale cached copy.
        _patch_frontend_entry_cache_buster(self._api)

        # 2. Install missing optional deps + auto-discover the device, both
        #    in the background (never on the startup critical path).
        try:
            self._start_background_bootstrap()
        except Exception:
            logger.warning(
                "AgentAura: background bootstrap could not be started",
                exc_info=True,
            )

        # 3. Apply monkey patches for lifecycle event capture.
        try:
            patch_query_stream()
        except Exception:
            logger.exception(
                "AgentAura: failed to patch Workspace.stream_query; "
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
            restore_query_stream()
        except Exception:
            logger.exception("AgentAura: failed to restore class methods")
        logger.info("AgentAura shutdown hook complete")


# ---------------------------------------------------------- module-level helpers


def _qwenpaw_version() -> str:
    """Return the running QwenPaw version for log lines (never raises)."""
    try:
        from qwenpaw.__version__ import __version__  # type: ignore

        return str(__version__)
    except Exception:  # pragma: no cover - defensive
        return "unknown"


def _parse_version(text: str) -> tuple[int, int, int] | None:
    """Parse ``"2.3.1b1"`` / ``"2.3.0.post4"`` into ``(2, 3, 1)``."""
    parts: list[int] = []
    for chunk in str(text or "").split(".")[:3]:
        digits = "".join(ch for ch in chunk if ch.isdigit())
        if not digits:
            return None
        parts.append(int(digits))
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)  # type: ignore[return-value]


def _plugin_loader(api: PluginApi | None):
    """Locate the live ``PluginLoader`` through the public plugin API.

    QwenPaw 2.3.0 binds ``api._loader`` directly; older builds only expose
    it through ``api._registry._plugin_http_app.state``.
    """
    loader = getattr(api, "_loader", None)
    if loader is not None:
        return loader
    registry = getattr(api, "_registry", None)
    app = getattr(registry, "_plugin_http_app", None)
    return getattr(getattr(app, "state", None), "plugin_loader", None)


def _patch_frontend_entry_cache_buster(api: PluginApi | None) -> None:
    """Append ``?v=<token>`` to the frontend entry URL in-memory.

    The plugin manifest stays clean (``dist/index.js``) but the running
    loader sees ``dist/index.js?v=<token>`` so the browser always fetches the
    bundle matching the currently installed build. Without this,
    re-installing the plugin would leave the console serving the
    previously-cached ``index.js`` until the user does a hard refresh.

    The token is ``<version>-<content hash>`` (see ``src/frontend.py``):
    version alone is not enough, because a rebuilt bundle can keep the same
    version number — e.g. local iteration on 0.3.1.

    Adapted from ``qwenpaw-remote-plugin/remote/plugin.py``.
    """
    try:
        loader = _plugin_loader(api)
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
        # Compare on the bare path so repeated startup-hook invocations (or a
        # rebuild under the same version) replace the token instead of
        # stacking ``?v=``.
        if str(frontend).split("?", 1)[0] != _FRONTEND_ENTRY:
            return

        token = cache_token(
            str(version),
            Path(__file__).resolve().parent / _FRONTEND_ENTRY,
        )
        if not token:
            return
        manifest.entry.frontend = f"{_FRONTEND_ENTRY}?v={token}"
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
