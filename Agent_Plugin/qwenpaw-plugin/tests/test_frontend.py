# -*- coding: utf-8 -*-
"""Tests for the frontend bundle cache token (``src/frontend.py``)."""

import tempfile
import unittest
from pathlib import Path

from src.frontend import cache_token


class CacheTokenTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _bundle(self, name: str, content: str) -> Path:
        path = self.dir / name
        path.write_text(content, encoding="utf-8")
        return path

    def test_token_contains_version_and_fingerprint(self):
        bundle = self._bundle("index.js", "console.log('a')")
        token = cache_token("0.3.1", bundle)
        prefix, _, digest = token.partition("-")
        self.assertEqual(prefix, "0.3.1")
        self.assertEqual(len(digest), 8)
        self.assertTrue(all(ch in "0123456789abcdef" for ch in digest))

    def test_same_version_different_content_changes_token(self):
        """The whole point: a rebuild under the same version must bust cache."""
        first = cache_token("0.3.1", self._bundle("a.js", "old"))
        second = cache_token("0.3.1", self._bundle("b.js", "new"))
        self.assertNotEqual(first, second)

    def test_same_content_is_stable(self):
        first = cache_token("0.3.1", self._bundle("a.js", "same"))
        second = cache_token("0.3.1", self._bundle("b.js", "same"))
        self.assertEqual(first, second)

    def test_missing_bundle_falls_back_to_version(self):
        self.assertEqual(
            cache_token("0.3.1", self.dir / "nope.js"),
            "0.3.1",
        )

    def test_empty_version_uses_fingerprint_only(self):
        token = cache_token("", self._bundle("a.js", "x"))
        self.assertEqual(len(token), 8)

    def test_both_missing_returns_empty(self):
        self.assertEqual(cache_token("", self.dir / "nope.js"), "")


if __name__ == "__main__":
    unittest.main()
