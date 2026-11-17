# -*- coding: utf-8 -*-
"""Tests for the QwenPaw event classification / stream wrapping layer.

Targets QwenPaw >= 2.3.0 only: the suite feeds the schema shapes that
``Workspace.stream_query`` actually yields (``TextContent`` /
``DataContent`` blocks, ``Message`` and ``AgentResponse`` envelopes). It is
import-only — no running QwenPaw required — and injects a stand-in
``qwenpaw.app.workspace.workspace`` module to test the patch target.
"""

import asyncio
import sys
import types
import unittest
from enum import Enum
from types import SimpleNamespace

import src.runner as runner


class ContentType(str, Enum):
    """Stand-in for ``qwenpaw.schemas.ContentType``."""

    TEXT = "text"
    DATA = "data"


def v2_text(text):
    return SimpleNamespace(type=ContentType.TEXT, text=text)


def v2_call(name, arguments=""):
    return SimpleNamespace(
        type=ContentType.DATA,
        data={"call_id": "c1", "name": name, "arguments": arguments},
    )


def v2_call_delta(fragment):
    return SimpleNamespace(
        type=ContentType.DATA,
        data={"arguments": fragment},
    )


def v2_result(output=""):
    return SimpleNamespace(
        type=ContentType.DATA,
        data={"call_id": "c1", "name": "shell", "output": output},
    )


def v2_message(*blocks, status="in_progress"):
    return SimpleNamespace(
        type="message",
        object="message",
        content=list(blocks),
        status=status,
    )


def v2_response(*messages, status="completed"):
    return SimpleNamespace(
        type=None,
        object="response",
        output=list(messages),
        status=status,
    )


class ClassifyTests(unittest.TestCase):
    def test_text_block(self):
        self.assertEqual(
            runner.classify_item(v2_text("hello"))[0],
            "query.first_token",
        )

    def test_empty_text_is_ignored(self):
        self.assertEqual(runner.classify_item(v2_text("   ")), (None, None))

    def test_function_call(self):
        event, text = runner.classify_item(v2_call("shell"))
        self.assertEqual(event, "tool.detected")
        self.assertIn("shell", text)

    def test_function_call_argument_delta_is_tool_call(self):
        # Argument fragments arrive without a name; still a tool call.
        self.assertEqual(
            runner.classify_item(v2_call_delta('{"cmd": '))[0],
            "tool.detected",
        )

    def test_function_call_output(self):
        self.assertEqual(
            runner.classify_item(v2_result("ok"))[0],
            "tool.result",
        )

    def test_tool_call_wins_over_text_in_same_message(self):
        msg = v2_message(v2_text("running it"), v2_call("shell"))
        self.assertEqual(runner.classify_item(msg)[0], "tool.detected")

    def test_response_envelope_is_classified_through_output(self):
        item = v2_response(v2_message(v2_result("ok")))
        self.assertEqual(runner.classify_item(item)[0], "tool.result")

    def test_tool_guard_approval_message_is_skipped(self):
        msg = {
            "content": [v2_text("approve?")],
            "metadata": {"message_type": "tool_guard_approval"},
        }
        self.assertEqual(runner.classify_item(msg), (None, None))

    def test_unknown_object_is_ignored(self):
        self.assertEqual(runner.classify_item(object()), (None, None))
        self.assertEqual(runner.classify_item(None), (None, None))


class _FakeStream:
    """Async-generator factory with scripted outcomes."""

    def __init__(self, items=(), error=None, cancel=False):
        self.items = list(items)
        self.error = error
        self.cancel = cancel
        self.seen = []

    def __call__(self, owner, request=None, *args, **kwargs):
        return self._gen()

    async def _gen(self):
        for item in self.items:
            self.seen.append(item)
            yield item
        if self.cancel:
            raise asyncio.CancelledError()
        if self.error is not None:
            raise self.error


class _Owner:
    agent_id = "agent-1"
    agent_name = "QwenPaw"


class _Request:
    session_id = "sess-1"
    user_id = "user-1"
    channel = "console"


class StreamWrapperTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.events = []
        self._orig_schedule = runner.schedule_emit
        runner.schedule_emit = self._record

    def tearDown(self):
        runner.schedule_emit = self._orig_schedule

    def _record(self, event, **payload):
        self.events.append((event, payload))

    def _names(self):
        return [event for event, _ in self.events]

    async def _collect(self, stream):
        wrapped = runner._wrap_stream(stream)
        return [item async for item in wrapped(_Owner(), _Request())]

    async def test_full_turn_emits_lifecycle(self):
        stream = _FakeStream([v2_text("hi"), v2_call("shell"), v2_result("ok")])
        items = await self._collect(stream)

        self.assertEqual(len(items), 3)
        self.assertEqual(
            self._names(),
            [
                "query.received",
                "query.running",
                "query.first_token",
                "tool.detected",
                "tool.result",
                "query.done",
            ],
        )

    async def test_repeated_events_are_debounced(self):
        stream = _FakeStream(
            [v2_call("a"), v2_call_delta("x"), v2_call_delta("y")],
        )
        await self._collect(stream)
        self.assertEqual(self._names().count("tool.detected"), 1)

    async def test_identity_fields_are_forwarded(self):
        stream = _FakeStream([v2_text("hi")])
        await self._collect(stream)
        payload = self.events[0][1]
        self.assertEqual(payload["agent_id"], "agent-1")
        self.assertEqual(payload["session_id"], "sess-1")
        self.assertEqual(payload["user_id"], "user-1")
        self.assertEqual(payload["channel"], "console")

    async def test_cancellation_emits_cancelled(self):
        stream = _FakeStream([v2_text("hi")], cancel=True)
        with self.assertRaises(asyncio.CancelledError):
            await self._collect(stream)
        self.assertIn("query.cancelled", self._names())
        self.assertNotIn("query.done", self._names())

    async def test_error_emits_error_with_exception_name(self):
        stream = _FakeStream([], error=ValueError("boom"))
        with self.assertRaises(ValueError):
            await self._collect(stream)
        names = self._names()
        self.assertIn("query.error", names)
        self.assertEqual(
            dict(self.events)["query.error"]["text"],
            "ValueError",
        )


_FAKE_MODULES = (
    "qwenpaw",
    "qwenpaw.app",
    "qwenpaw.app.workspace",
    "qwenpaw.app.workspace.workspace",
)


class QueryStreamPatchTests(unittest.TestCase):
    """The patch target must be exactly ``Workspace.stream_query``."""

    def setUp(self):
        runner._ORIGINALS.clear()
        runner._PATCHED = False
        self._saved = {name: sys.modules.get(name) for name in _FAKE_MODULES}

        class Workspace:
            async def stream_query(self, request=None):  # pragma: no cover
                yield None

        workspace_module = types.ModuleType("qwenpaw.app.workspace.workspace")
        workspace_module.Workspace = Workspace
        package = types.ModuleType("qwenpaw")
        package.__path__ = []
        app_module = types.ModuleType("qwenpaw.app")
        app_module.__path__ = []
        workspace_package = types.ModuleType("qwenpaw.app.workspace")
        workspace_package.__path__ = []
        workspace_package.workspace = workspace_module
        app_module.workspace = workspace_package
        package.app = app_module
        sys.modules.update(
            {
                "qwenpaw": package,
                "qwenpaw.app": app_module,
                "qwenpaw.app.workspace": workspace_package,
                "qwenpaw.app.workspace.workspace": workspace_module,
            },
        )

        self.Workspace = Workspace
        self.original = Workspace.stream_query

    def tearDown(self):
        runner.restore_query_stream()
        for name, module in self._saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
        runner._ORIGINALS.clear()
        runner._PATCHED = False

    def test_patch_and_restore(self):
        runner.patch_query_stream()
        self.assertTrue(
            getattr(self.Workspace.stream_query, "_agentaura_wrapped", False),
        )

        runner.restore_query_stream()
        self.assertIs(self.Workspace.stream_query, self.original)

    def test_patch_is_idempotent(self):
        runner.patch_query_stream()
        patched = self.Workspace.stream_query
        runner.patch_query_stream()
        self.assertIs(self.Workspace.stream_query, patched)

    def test_missing_target_raises(self):
        del self.Workspace.stream_query
        with self.assertRaises(RuntimeError):
            runner.patch_query_stream()


if __name__ == "__main__":
    unittest.main()
