# -*- coding: utf-8 -*-
"""Self-provisioning for AgentAura's optional dependencies.

Why this exists
---------------
QwenPaw >= 2.3.0 evaluates ``plugin.json`` ``dependencies`` with
``allow_install=False`` **before the backend module is imported**. A single
missing wheel therefore marks the whole plugin ``failed`` and plugin code
never runs — so ``pyserial`` / ``psutil`` must stay *optional* (lazy
imports) and the plugin installs them itself.

Where things get installed
--------------------------
Into QwenPaw's per-plugin dependency site (``plugin_runtime/<py-tag>/site``),
which lives under the ``working`` directory and therefore survives container
recreation. When that directory cannot be found/written, pip falls back to
the running interpreter's own site-packages.

Safety rails
------------
* Only the packages in :data:`OPTIONAL_DEPS` can be installed — the HTTP
  route never accepts arbitrary names.
* Installation runs in the calling thread's subprocess with a hard timeout
  and never raises: callers get a result dict instead.
* ``AGENTAURA_AUTO_INSTALL_DEPS=0`` / ``auto_install_deps=false`` disables it.
"""

from __future__ import annotations

import importlib
import importlib.util
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger("agentaura")

# module name -> pip requirement
OPTIONAL_DEPS: dict[str, str] = {
    "serial": "pyserial>=3.5",  # USB serial transport + port enumeration
    "psutil": "psutil>=5.9",  # per-interface UDP discovery broadcast
}

DEFAULT_TIMEOUT_SECONDS = 180.0

_LOCK = threading.Lock()
_LAST_RESULT: dict[str, Any] | None = None


# ------------------------------------------------------------- availability


def _module_available(module: str) -> bool:
    """True when *module* can be imported right now."""
    try:
        importlib.invalidate_caches()
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def is_available(module: str) -> bool:
    """Public wrapper used by the router and the plugin entry point."""
    return _module_available(module)


def missing(modules: Iterable[str] | None = None) -> list[str]:
    """Return the whitelisted modules that are currently unavailable."""
    names = _validate(modules)
    return [name for name in names if not _module_available(name)]


def _validate(modules: Iterable[str] | None) -> list[str]:
    """Normalise the request and reject anything outside the whitelist."""
    if modules is None:
        return list(OPTIONAL_DEPS)
    if isinstance(modules, str):
        modules = [modules]
    names: list[str] = []
    for module in modules:
        name = str(module).strip()
        if name not in OPTIONAL_DEPS:
            raise ValueError(
                f"unsupported dependency {name!r}; "
                f"known: {sorted(OPTIONAL_DEPS)}",
            )
        if name not in names:
            names.append(name)
    return names


# ----------------------------------------------------------- install target


def _candidate_sites() -> list[Path]:
    """Dependency directories QwenPaw may use for this plugin, best first."""
    candidates: list[Path] = []

    env_site = os.environ.get("QWENPAW_PLUGIN_SITE")
    if env_site:
        candidates.append(Path(env_site))

    try:  # QwenPaw 2.3.x
        from qwenpaw.plugins.loader import (  # type: ignore
            _plugin_site_dir,
        )

        candidates.append(Path(_plugin_site_dir()))
    except Exception:  # noqa: BLE001 - helper is private and may move
        pass

    return candidates


def expose_install_target() -> str | None:
    """Prepend an existing plugin dependency site to ``sys.path``.

    QwenPaw only wires ``plugin_runtime/<py-tag>/site`` into ``sys.path`` in
    frozen desktop builds (``_ensure_plugin_site_on_path_async`` returns
    early otherwise). Without this, packages installed there persist on disk
    but are invisible after a restart, so the plugin would reinstall them on
    every boot. Returns the exposed path, if any.
    """
    for candidate in _candidate_sites():
        if not candidate.is_dir():
            continue
        entry = str(candidate)
        if entry not in sys.path:
            sys.path.insert(0, entry)
        os.environ.setdefault("QWENPAW_PLUGIN_SITE", entry)
        importlib.invalidate_caches()
        return entry
    return None


def install_target(create: bool = True) -> Path | None:
    """Return QwenPaw's writable per-plugin dependency site, if any.

    Args:
        create: Create the directory when missing. ``False`` keeps read-only
            callers (``GET /status``) free of side effects.
    """
    candidates = _candidate_sites()

    for candidate in candidates:
        if create:
            try:
                candidate.mkdir(parents=True, exist_ok=True)
            except OSError:
                continue
        elif not candidate.is_dir():
            continue
        if os.access(candidate, os.W_OK):
            return candidate
    return None


def _ensure_on_sys_path(target: Path | None) -> None:
    """Make a fresh ``--target`` install importable in this process."""
    if target is None:
        return
    entry = str(target)
    if entry not in sys.path:
        sys.path.insert(0, entry)
    os.environ.setdefault("QWENPAW_PLUGIN_SITE", entry)
    importlib.invalidate_caches()


# ---------------------------------------------------------------- installing


def _auto_install_enabled() -> bool:
    raw = os.environ.get("AGENTAURA_AUTO_INSTALL_DEPS")
    if raw is None:
        return True
    return str(raw).strip().lower() not in ("0", "false", "no", "off", "")


def _timeout_seconds() -> float:
    raw = os.environ.get("AGENTAURA_PIP_TIMEOUT")
    try:
        return max(5.0, float(raw)) if raw else DEFAULT_TIMEOUT_SECONDS
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_SECONDS


def install(
    modules: Iterable[str] | None = None,
    *,
    timeout: float | None = None,
) -> dict[str, Any]:
    """Install the whitelisted *modules* that are missing.

    Never raises for pip/network problems (the failure is reported in the
    returned dict); raises ``ValueError`` for a non-whitelisted name.

    Returns:
        ``{"ok", "requested", "installed", "failed", "target",
        "returncode", "detail"}``.
    """
    global _LAST_RESULT

    requested = _validate(modules)
    pending = [name for name in requested if not _module_available(name)]
    result: dict[str, Any] = {
        "ok": True,
        "requested": pending,
        "installed": [],
        "failed": [],
        "target": None,
        "returncode": None,
        "detail": "already available" if not pending else "",
        "timestamp": time.time(),
    }
    if not pending:
        _LAST_RESULT = result
        return result

    with _LOCK:
        # Re-check under the lock: a concurrent caller may have installed it.
        pending = [name for name in requested if not _module_available(name)]
        if not pending:
            result["requested"] = []
            result["detail"] = "already available"
            _LAST_RESULT = result
            return result

        target = install_target()
        result["target"] = str(target) if target else None
        specs = [OPTIONAL_DEPS[name] for name in pending]

        argv = [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "--no-warn-script-location",
            "--upgrade",
        ]
        if target is not None:
            argv += ["--target", str(target)]
        argv += specs

        logger.info("AgentAura installing optional deps: %s", ", ".join(specs))
        try:
            proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
                argv,
                capture_output=True,
                text=True,
                timeout=timeout if timeout is not None else _timeout_seconds(),
                check=False,
            )
            result["returncode"] = proc.returncode
            output = ((proc.stderr or "") + (proc.stdout or "")).strip()
            result["detail"] = _tail(output)
        except subprocess.TimeoutExpired:
            result["ok"] = False
            result["returncode"] = None
            result["detail"] = "pip install timed out"
        except Exception as exc:  # noqa: BLE001 - never raise to the caller
            result["ok"] = False
            result["returncode"] = None
            result["detail"] = f"{type(exc).__name__}: {exc}"

        _ensure_on_sys_path(target)
        installed = [name for name in pending if _module_available(name)]
        failed = [name for name in pending if name not in installed]
        result["requested"] = pending
        result["installed"] = installed
        result["failed"] = failed
        result["ok"] = not failed and bool(result["ok"])

        if installed:
            logger.info(
                "AgentAura installed optional deps: %s (target=%s)",
                ", ".join(installed),
                result["target"],
            )
        if failed:
            logger.warning(
                "AgentAura could not install %s: %s",
                ", ".join(failed),
                result["detail"],
            )

        _LAST_RESULT = result
        return result


def ensure(*, timeout: float | None = None) -> dict[str, Any]:
    """Install whatever optional dependency is missing (no-op when ready).

    Honours ``AGENTAURA_AUTO_INSTALL_DEPS``; when disabled an "available"
    snapshot is returned without touching pip.
    """
    if not _auto_install_enabled():
        return {
            "ok": True,
            "requested": [],
            "installed": [],
            "failed": [],
            "target": None,
            "returncode": None,
            "detail": "auto-install disabled",
            "timestamp": time.time(),
        }
    return install(None, timeout=timeout)


def state() -> dict[str, Any]:
    """Snapshot for ``GET /status`` — always JSON serialisable."""
    return {
        "available": {
            name: _module_available(name) for name in OPTIONAL_DEPS
        },
        "requirements": dict(OPTIONAL_DEPS),
        "target": str(install_target(create=False) or "") or None,
        "auto_install": _auto_install_enabled(),
        "last_result": _LAST_RESULT,
    }


def _tail(text: str, limit: int = 600) -> str:
    text = (text or "").strip()
    return text[-limit:] if len(text) > limit else text
