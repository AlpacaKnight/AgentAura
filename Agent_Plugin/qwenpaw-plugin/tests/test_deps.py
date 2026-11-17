# -*- coding: utf-8 -*-
"""Tests for the optional-dependency bootstrap (``src/deps.py``).

pip and module availability are stubbed, so nothing is downloaded and no
real environment is touched.
"""

import sys
import tempfile
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

import src.deps as deps


class WhitelistTests(unittest.TestCase):
    def test_unknown_module_is_rejected(self):
        with self.assertRaises(ValueError):
            deps._validate(["requests"])

    def test_none_means_every_optional_dep(self):
        self.assertEqual(deps._validate(None), list(deps.OPTIONAL_DEPS))

    def test_duplicates_collapse(self):
        self.assertEqual(deps._validate(["serial", "serial"]), ["serial"])

    def test_string_is_accepted(self):
        self.assertEqual(deps._validate("psutil"), ["psutil"])


class InstallTests(unittest.TestCase):
    def setUp(self):
        deps._LAST_RESULT = None

    def test_noop_when_everything_available(self):
        with patch.object(deps, "_module_available", return_value=True):
            result = deps.install(["serial"])
        self.assertTrue(result["ok"])
        self.assertEqual(result["installed"], [])
        self.assertEqual(result["requested"], [])
        self.assertEqual(result["detail"], "already available")

    def test_runs_pip_with_target_and_spec(self):
        completed = subprocess.CompletedProcess(args=[], returncode=0)
        with patch.object(
            deps,
            "_module_available",
            side_effect=[False, False, True],
        ), patch.object(
            deps,
            "install_target",
            return_value=Path("/tmp/plugin-site"),
        ), patch.object(
            deps.subprocess,
            "run",
            return_value=completed,
        ) as run, patch.object(deps, "_ensure_on_sys_path"):
            result = deps.install(["serial"])

        argv = run.call_args.args[0]
        self.assertEqual(argv[0], deps.sys.executable)
        self.assertIn("-m", argv)
        self.assertIn("pip", argv)
        self.assertIn("--target", argv)
        self.assertEqual(argv[argv.index("--target") + 1], "/tmp/plugin-site")
        self.assertIn("pyserial>=3.5", argv)
        self.assertEqual(result["installed"], ["serial"])
        self.assertEqual(result["failed"], [])
        self.assertTrue(result["ok"])

    def test_falls_back_to_interpreter_when_no_target(self):
        completed = subprocess.CompletedProcess(args=[], returncode=0)
        with patch.object(
            deps,
            "_module_available",
            side_effect=[False, False, True],
        ), patch.object(
            deps,
            "install_target",
            return_value=None,
        ), patch.object(
            deps.subprocess,
            "run",
            return_value=completed,
        ) as run, patch.object(deps, "_ensure_on_sys_path"):
            deps.install(["psutil"])

        self.assertNotIn("--target", run.call_args.args[0])

    def test_failure_is_reported_not_raised(self):
        with patch.object(
            deps,
            "_module_available",
            side_effect=[False, False, False],
        ), patch.object(
            deps,
            "install_target",
            return_value=None,
        ), patch.object(
            deps.subprocess,
            "run",
            side_effect=OSError("no pip"),
        ), patch.object(deps, "_ensure_on_sys_path"):
            result = deps.install(["serial"])

        self.assertFalse(result["ok"])
        self.assertEqual(result["failed"], ["serial"])
        self.assertIn("no pip", result["detail"])

    def test_timeout_is_reported_not_raised(self):
        with patch.object(
            deps,
            "_module_available",
            side_effect=[False, False, False],
        ), patch.object(
            deps,
            "install_target",
            return_value=None,
        ), patch.object(
            deps.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(cmd="pip", timeout=1),
        ), patch.object(deps, "_ensure_on_sys_path"):
            result = deps.install(["serial"], timeout=1)

        self.assertFalse(result["ok"])
        self.assertEqual(result["detail"], "pip install timed out")


class EnsureTests(unittest.TestCase):
    def setUp(self):
        deps._LAST_RESULT = None

    def test_auto_install_can_be_disabled(self):
        with patch.dict("os.environ", {"AGENTAURA_AUTO_INSTALL_DEPS": "0"}):
            result = deps.ensure()
        self.assertTrue(result["ok"])
        self.assertEqual(result["detail"], "auto-install disabled")
        self.assertEqual(result["installed"], [])

    def test_ensure_delegates_to_install(self):
        with patch.object(
            deps,
            "install",
            return_value={"ok": True, "installed": ["serial"]},
        ) as install:
            result = deps.ensure()
        install.assert_called_once_with(None, timeout=None)
        self.assertEqual(result["installed"], ["serial"])


class ExposeTargetTests(unittest.TestCase):
    """A site populated on a previous boot must become importable again."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.site = Path(self._tmp.name)
        self._saved_path = list(sys.path)
        self._saved_env = deps.os.environ.get("QWENPAW_PLUGIN_SITE")

    def tearDown(self):
        sys.path[:] = self._saved_path
        if self._saved_env is None:
            deps.os.environ.pop("QWENPAW_PLUGIN_SITE", None)
        else:
            deps.os.environ["QWENPAW_PLUGIN_SITE"] = self._saved_env
        self._tmp.cleanup()

    def test_existing_site_is_prepended(self):
        with patch.object(deps, "_candidate_sites", return_value=[self.site]):
            exposed = deps.expose_install_target()
        self.assertEqual(exposed, str(self.site))
        self.assertEqual(sys.path[0], str(self.site))
        self.assertEqual(
            deps.os.environ["QWENPAW_PLUGIN_SITE"],
            str(self.site),
        )

    def test_missing_site_is_skipped(self):
        missing = self.site / "nope"
        with patch.object(deps, "_candidate_sites", return_value=[missing]):
            self.assertIsNone(deps.expose_install_target())
        self.assertNotIn(str(missing), sys.path)

    def test_install_target_creates_when_asked(self):
        target = self.site / "deep" / "site"
        with patch.object(deps, "_candidate_sites", return_value=[target]):
            self.assertEqual(deps.install_target(), target)
            self.assertTrue(target.is_dir())
            # read-only call must not create
            target.rmdir()
            target.parent.rmdir()
            self.assertIsNone(deps.install_target(create=False))


class StateTests(unittest.TestCase):
    def test_state_is_json_friendly(self):
        with patch.object(deps, "_module_available", return_value=False):
            state = deps.state()
        self.assertEqual(set(state["available"]), set(deps.OPTIONAL_DEPS))
        self.assertFalse(any(state["available"].values()))
        self.assertIsInstance(state["auto_install"], bool)
        # target may be None on machines without QwenPaw
        self.assertIn("target", state)


if __name__ == "__main__":
    unittest.main()
