"""Version: 1.0 | Date: 13/10/2026
Changes: Added offline tests for good, bad, missing, stale and future PI samples and read-only API behavior.
"""
import json
import threading
import time
import unittest
import sys
from types import SimpleNamespace
from unittest.mock import Mock, patch
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server import ESSENTIAL, SnapshotStore, load_config, make_handler, read_server
from pi_client import PIReadClient


class FakePI:
    def __init__(self, value=10, timestamp=100000, good=True):
        self.value, self.timestamp, self.good = value, timestamp, good

    def read(self, tag):
        if tag == "missing":
            raise RuntimeError("Missing point")
        return {"value": self.value, "timestamp": self.timestamp, "good": self.good, "status": "Good" if self.good else "Bad"}


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.item = {"id": "server1", "tags": {key: key for key in ESSENTIAL}}

    def test_sdk_dispatch_and_windows_open_without_credentials(self):
        server = SimpleNamespace(Connected=True, Open=Mock(), Close=Mock())
        sdk = SimpleNamespace(Servers=SimpleNamespace(Item=Mock(return_value=server)))
        dispatch = Mock(return_value=sdk)
        win32 = SimpleNamespace(client=SimpleNamespace(Dispatch=dispatch))
        with patch.dict(sys.modules, {"win32com": win32, "win32com.client": win32.client}):
            client = PIReadClient("TEST_ARCHIVE")
            client.connect()
            dispatch.assert_called_once_with("PISDK.PISDK")
            sdk.Servers.Item.assert_called_once_with("TEST_ARCHIVE")
            server.Open.assert_called_once_with()
            client.close()
            server.Close.assert_called_once_with()

    def test_good(self):
        value = read_server(self.item, FakePI(), 101000, 120)
        self.assertTrue(value["collecting"])
        self.assertEqual(value["sampleTime"], 100000)
        self.assertIsNone(value["metrics"]["runPVT"])

    def test_bad_stale_future_and_nan(self):
        for client in (FakePI(good=False), FakePI(timestamp=1), FakePI(timestamp=102000), FakePI(value=float("nan")), FakePI(value=-1), FakePI(value=101)):
            value = read_server(self.item, client, 101000, 10)
            self.assertFalse(value["collecting"])
            self.assertIsNone(value["sampleTime"])

    def test_missing_point_isolated(self):
        self.item["tags"]["runCPU"] = "missing"
        value = read_server(self.item, FakePI(), 101000, 120)
        self.assertIsNone(value["metrics"]["runCPU"])
        self.assertEqual(value["metrics"]["runMemory"], 10)
        self.assertFalse(value["collecting"])

    def test_unconfigured_never_connects(self):
        config = load_config(Path(__file__).with_name("config.example.toml"))
        store = SnapshotStore(config)
        store.poll()
        snapshot = store.get()
        self.assertEqual(snapshot["serviceStatus"], "not-configured")
        self.assertEqual(len(snapshot["servers"]), 7)
        self.assertTrue(all(not s["collecting"] for s in snapshot["servers"]))

    def test_history_deduplication(self):
        config = load_config(Path(__file__).with_name("config.example.toml"))
        store = SnapshotStore(config)
        servers = [read_server(s, FakePI(), 101000, 120) for s in config["servers"]]
        for s in servers:
            for key in ("localEnteredRate", "localHandledRate", "localDiscardPercent"):
                s["metrics"][key] = 0
                s["metricQuality"][key] = {"timestamp": 100000, "good": True}
        store.publish(servers, "degraded")
        store.publish(servers, "degraded")
        self.assertEqual(len(store.get()["servers"][0]["histories"]["local"]), 1)

    def test_http_status_and_no_write(self):
        config = load_config(Path(__file__).with_name("config.example.toml"))
        store = SnapshotStore(config)
        store.poll()
        http = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(store, Path(__file__).resolve().parents[1] / "web"))
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{http.server_port}/api/v1/status"
        try:
            with urlopen(url) as response:
                self.assertEqual(json.load(response)["source"], "pi-sdk-com")
            with self.assertRaises(HTTPError) as error:
                urlopen(Request(url, data=b"{}", method="POST"))
            self.assertEqual(error.exception.code, 501)
        finally:
            http.shutdown()
            http.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
