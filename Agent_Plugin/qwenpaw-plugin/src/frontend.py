# -*- coding: utf-8 -*-
"""Frontend bundle cache-busting token.

QwenPaw serves plugin bundles by URL, so the browser caches them. Appending
``?v=<token>`` to ``entry.frontend`` forces a refetch whenever the bundle
changes.

The manifest version alone is not enough: a rebuild can ship under the same
version number (hot-fixed 0.3.1, local iteration), which would leave users on
the previously cached JavaScript. The token therefore combines the version
with a short content fingerprint of the bundle itself.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

_FINGERPRINT_BYTES = 8


def cache_token(version: str, entry: Path) -> str:
    """Return ``"<version>-<hash8>"`` (or whichever half is available).

    Args:
        version: Manifest version, e.g. ``"0.3.1"``.
        entry: Path to the built frontend bundle.
    """
    version = (version or "").strip()
    try:
        digest = hashlib.sha256(entry.read_bytes()).hexdigest()
    except OSError:
        return version

    fingerprint = digest[:_FINGERPRINT_BYTES]
    if not version:
        return fingerprint
    return f"{version}-{fingerprint}"
