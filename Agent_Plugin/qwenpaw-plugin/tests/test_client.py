import unittest
from unittest.mock import patch
import socket
import sys
import threading
import time
from types import SimpleNamespace

import src.client as client_module
from src.client import RingLightClient, _HttpTransport
from src.discovery import _broadcast_addresses
from src.mapper import _event_message, dispatch_sync


class FakeHttpTransport(_HttpTransport):
    def __init__(self, register_status=200):
        super().__init__("127.0.0.1", 3030)
        self.register_status = register_status
        self.requests = []
        self.commands = []

    def request_json(self, method, path, payload=None, *, instance_id=""):
        self.requests.append((method, path, payload, instance_id))
        if path == "/api/v1/agents/register":
            return self.register_status, {"heartbeatIntervalMs": 10_000}
        return 200, {"ok": True}

    def send_command(self, command):
        self.commands.append(command)
        return True


class DelayedHeartbeatTransport(FakeHttpTransport):
    def __init__(self):
        super().__init__()
        self.heartbeat_entered = threading.Event()
        self.heartbeat_release = threading.Event()

    def request_json(self, method, path, payload=None, *, instance_id=""):
        if path.endswith("/heartbeat"):
            self.heartbeat_entered.set()
            self.heartbeat_release.wait(1)
            self.requests.append((method, path, payload, instance_id))
            return 500, None
        return super().request_json(
            method,
            path,
            payload,
            instance_id=instance_id,
        )


class QwenPawPetDesktopTests(unittest.TestCase):
    def setUp(self):
        self.client = RingLightClient()
        self.client.disconnect_agent()
        self.client._last_state = ""
        self.client._last_state_ts = 0
        self.client._unreachable_until = 0

    def tearDown(self):
        self.client.disconnect_agent()

    def test_register_state_message_and_disconnect(self):
        transport = FakeHttpTransport()
        self.client._transport = transport
        self.client._transport_name = "http"
        self.client._http_target = "unknown"

        self.assertTrue(self.client.set_agent_state("busy"))
        self.assertTrue(self.client.send_message("正在审查", "activity", 30))
        self.client.disconnect_agent()

        paths = [(method, path) for method, path, _, _ in transport.requests]
        self.assertIn(("POST", "/api/v1/agents/register"), paths)
        self.assertTrue(any(path.endswith("/state") for _, path in paths))
        self.assertTrue(any(path.endswith("/message") for _, path in paths))
        self.assertTrue(any(method == "DELETE" for method, _ in paths))

    def test_firmware_fallback_keeps_legacy_agent_command(self):
        transport = FakeHttpTransport(register_status=404)
        self.client._transport = transport
        self.client._transport_name = "http"
        self.client._http_target = "unknown"

        self.assertTrue(self.client.set_agent_state("running"))
        self.assertEqual(transport.commands, ["agent running"])
        self.assertEqual(self.client._http_target, "firmware")

    def test_temporary_registration_failure_is_retried(self):
        transport = FakeHttpTransport(register_status=500)
        self.client._transport = transport
        self.client._transport_name = "http"
        self.client._http_target = "unknown"

        self.assertTrue(self.client.set_agent_state("running"))
        self.assertEqual(self.client._http_target, "unknown")
        transport.register_status = 200
        self.assertTrue(self.client.set_agent_state("running"))

        registrations = [
            path
            for _, path, _, _ in transport.requests
            if path == "/api/v1/agents/register"
        ]
        self.assertEqual(len(registrations), 2)
        self.assertEqual(self.client._http_target, "petdesktop")

    def test_event_messages_use_payload_for_tools(self):
        self.assertEqual(
            _event_message("tool.detected", {"text": "Using shell"}),
            ("Using shell", "activity", 30),
        )
        self.assertEqual(
            _event_message("approval.pending", {}),
            ("QwenPaw 等待操作授权", "warning", 70),
        )

    def test_mapper_sends_state_and_bubble(self):
        fake = unittest.mock.Mock()
        with patch("src.mapper.RingLightClient", return_value=fake):
            dispatch_sync("query.done", text="Done")
        fake.set_agent_state.assert_called_once_with("idle")
        fake.send_message.assert_called_once_with(
            "QwenPaw 任务已完成", "success", 50
        )

    def test_discovery_uses_each_adapter_broadcast(self):
        fake_psutil = SimpleNamespace(
            net_if_addrs=lambda: {
                "wifi": [
                    SimpleNamespace(
                        family=socket.AF_INET,
                        address="192.168.7.12",
                        netmask="255.255.255.0",
                    )
                ],
                "ethernet": [
                    SimpleNamespace(
                        family=socket.AF_INET,
                        address="10.8.4.20",
                        netmask="255.255.252.0",
                    )
                ],
            }
        )
        with patch.dict(sys.modules, {"psutil": fake_psutil}):
            addresses = _broadcast_addresses()
        self.assertIn("192.168.7.255", addresses)
        self.assertIn("10.8.7.255", addresses)
        self.assertIn("255.255.255.255", addresses)

    def test_invalid_adapter_does_not_hide_later_valid_adapters(self):
        fake_psutil = SimpleNamespace(
            net_if_addrs=lambda: {
                "broken": [
                    SimpleNamespace(
                        family=socket.AF_INET,
                        address="not-an-ip",
                        netmask="bad-mask",
                    )
                ],
                "wifi": [
                    SimpleNamespace(
                        family=socket.AF_INET,
                        address="192.168.9.12",
                        netmask="255.255.255.0",
                    )
                ],
            }
        )
        with patch.dict(sys.modules, {"psutil": fake_psutil}):
            addresses = _broadcast_addresses()
        self.assertIn("192.168.9.255", addresses)

    def test_disconnect_cancels_in_flight_heartbeat_without_reregistering(self):
        transport = DelayedHeartbeatTransport()
        self.client._transport = transport
        self.client._transport_name = "http"
        self.client._http_target = "petdesktop"
        self.client._last_state = "idle"
        self.client._start_heartbeat(0.01)
        self.assertTrue(transport.heartbeat_entered.wait(0.5))

        release = threading.Timer(0.05, transport.heartbeat_release.set)
        release.start()
        self.client.disconnect_agent()
        release.join()
        time.sleep(0.05)

        paths = [(method, path) for method, path, _, _ in transport.requests]
        delete_index = next(i for i, (method, _) in enumerate(paths) if method == "DELETE")
        self.assertFalse(
            any(path == "/api/v1/agents/register" for _, path in paths[delete_index + 1 :])
        )
        self.assertEqual(self.client._http_target, "unknown")

    def test_concurrent_heartbeat_start_creates_one_thread(self):
        real_thread = threading.Thread
        started = []

        class SlowFakeThread:
            def __init__(self, **_kwargs):
                self.alive = False
                time.sleep(0.05)

            def is_alive(self):
                return self.alive

            def start(self):
                self.alive = True
                started.append(self)

            def join(self, timeout=None):
                self.alive = False

        with patch.object(client_module.threading, "Thread", SlowFakeThread):
            callers = [
                real_thread(target=self.client._start_heartbeat, args=(10,))
                for _ in range(2)
            ]
            for caller in callers:
                caller.start()
            for caller in callers:
                caller.join()

        self.assertEqual(len(started), 1)
        self.client._heartbeat_thread = None
        self.client._heartbeat_stop = None

    def test_status_never_returns_raw_auth_token(self):
        self.client._transport = None
        self.client._auth_token = "top-secret"
        status = self.client.status_summary()
        self.assertNotIn("auth_token", status)
        self.assertTrue(status["has_auth_token"])


if __name__ == "__main__":
    unittest.main()
