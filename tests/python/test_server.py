import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[2] / 'scada_api'))

"""Version: 1.3 | Date: 14/10/2026
Changes: Tested AF session reuse, recovery after snapshot failure and failed-connect cleanup; isolated DLL validation from write-guard tests.
"""
import json
import threading
import time
import tempfile
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
        dll_check = patch("server.os.path.exists", return_value=True)
        dll_check.start()
        self.addCleanup(dll_check.stop)
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
        for client in (FakePI(good=False), FakePI(timestamp=1), FakePI(timestamp=102000), FakePI(value=float("nan")), FakePI(value=-1), FakePI(value=101), FakePI(value=True)):
            value = read_server(self.item, client, 101000, 10)
            self.assertFalse(value["collecting"])
            self.assertIsNone(value["sampleTime"])

    def test_missing_point_isolated(self):
        self.item["tags"]["runCPU"] = "missing"
        value = read_server(self.item, FakePI(), 101000, 120)
        self.assertIsNone(value["metrics"]["runCPU"])
        self.assertEqual(value["metrics"]["runMemory"], 10)
        self.assertFalse(value["collecting"])

    def test_non_finite_and_boolean_timestamps_produce_valid_json(self):
        for timestamp in (float('nan'), float('inf'), True):
            value = read_server(self.item, FakePI(timestamp=timestamp), 101000, 120)
            self.assertFalse(value['collecting'])
            self.assertIsNone(value['metricQuality']['runCPU']['timestamp'])
            json.dumps(value, allow_nan=False)

    def test_unconfigured_never_connects(self):
        config = load_config(Path(__file__).resolve().parents[2] / "scada_api" / "config.reference.toml")
        store = SnapshotStore(config)
        store.poll()
        snapshot = store.get()
        self.assertEqual(snapshot["serviceStatus"], "not-configured")
        self.assertEqual(len(snapshot["servers"]), 7)
        self.assertTrue(all(not s["collecting"] for s in snapshot["servers"]))

    def test_malformed_tags_mapping_is_rejected(self):
        config = load_config(Path(__file__).resolve().parents[2] / "scada_api" / "config.reference.toml")
        config["servers"][0]["tags"] = []
        with patch("server.tomllib.load", return_value=config):
            with self.assertRaises(ValueError):
                load_config(Path(__file__).resolve().parents[2] / "scada_api" / "config.reference.toml")

    def test_history_deduplication(self):
        config = load_config(Path(__file__).resolve().parents[2] / "scada_api" / "config.reference.toml")
        store = SnapshotStore(config)
        servers = [read_server(s, FakePI(), 101000, 120) for s in config["servers"]]
        for s in servers:
            for key in ("localEnteredRate", "localHandledRate", "localDiscardPercent"):
                s["metrics"][key] = 0
                s["metricQuality"][key] = {"timestamp": 100000, "good": True}
        store.publish(servers, "degraded")
        store.publish(servers, "degraded")
        self.assertEqual(len(store.get()["servers"][0]["histories"]["local"]), 1)

    def test_alarm_history_persists_new_active_events_without_duplicates(self):
        config = load_config(Path(__file__).resolve().parents[2] / "scada_api" / "config.reference.toml")
        with tempfile.TemporaryDirectory() as directory:
            config["historyDbPath"] = str(Path(directory) / "history.sqlite3")
            store = SnapshotStore(config)
            server = {"id": "server1", "name": "Servidor 1", "trends": [{"metric": "runCPU", "label": "CPU", "state": 10, "reason": "Elevação sustentada"}], "absoluteAlarms": []}
            store.record_active_alarms([server], 1000)
            store.record_active_alarms([server], 2000)
            history = store.alarm_history()
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["serverName"], "Servidor 1")
        self.assertEqual(history[0]["state"], "warning")

    def test_http_status_and_no_write(self):
        config = load_config(Path(__file__).resolve().parents[2] / "scada_api" / "config.reference.toml")
        store = SnapshotStore(config)
        store.poll()
        http = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(store, Path(__file__).resolve().parents[2] / "web"))
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{http.server_port}/api/v1/status"
        try:
            with urlopen(url) as response:
                self.assertEqual(json.load(response)["source"], config["piAdapter"])
            with self.assertRaises(HTTPError) as error:
                urlopen(Request(url, data=b"{}", method="POST"))
            self.assertEqual(error.exception.code, 501)
        finally:
            http.shutdown()
            http.server_close()
            thread.join()

    def test_missing_af_sdk_dll_is_rejected(self):
        with patch("server.os.path.exists", return_value=False):
            with self.assertRaises(FileNotFoundError):
                load_config(Path(__file__).resolve().parents[2] / "scada_api" / "config.reference.toml")

    def test_af_sdk_rejects_writes_at_initialization(self):
        config = load_config(Path(__file__).resolve().parents[2] / "scada_api" / "config.reference.toml")
        config["piAdapter"] = "af-sdk"
        config["enableWrites"] = True
        with patch("server.tomllib.load", return_value=config), patch("server.os.path.exists", return_value=True):
            with self.assertRaisesRegex(ValueError, "AF SDK.*read-only|enableWrites.*af-sdk|write.*disabled"):
                load_config(Path(__file__).resolve().parents[2] / "scada_api" / "config.reference.toml")

    def test_af_sdk_timestamp_utc_ms_and_quality(self):
        class FakeDateTime:
            def __init__(self, value):
                self.UtcTime = value

            def ToUniversalTime(self):
                return self.UtcTime

        client = PIReadClient("PIDATAPRO", adapter="af-sdk", af_sdk_dll="C:/temp/afsdk.dll")
        client.server = SimpleNamespace(Connected=True)
        client.points["TEST.TAG"] = SimpleNamespace(
            Snapshot=Mock(return_value=SimpleNamespace(
                Value=42.5,
                Status="Good",
                IsGood=True,
                Timestamp=FakeDateTime(__import__("datetime").datetime(1970, 1, 1, tzinfo=__import__("datetime").timezone.utc)),
            ))
        )
        sample = client._read_af_snapshot("TEST.TAG")
        self.assertTrue(sample["good"])
        self.assertEqual(sample["value"], 42.5)
        self.assertEqual(sample["timestamp"], 0)

        client.points["BAD.TAG"] = SimpleNamespace(
            Snapshot=Mock(return_value=SimpleNamespace(
                Value=1.0,
                Status="Questionable",
                IsGood=False,
                Timestamp=FakeDateTime(__import__("datetime").datetime(2026, 10, 14, 12, 0, tzinfo=__import__("datetime").timezone.utc)),
            ))
        )
        bad = client._read_af_snapshot("BAD.TAG")
        self.assertFalse(bad["good"])
        self.assertIsNone(bad["value"])

    def test_af_sdk_digital_and_boolean_values_are_rejected(self):
        client = PIReadClient("PIDATAPRO", adapter="af-sdk", af_sdk_dll="C:/temp/afsdk.dll")
        client.server = SimpleNamespace(Connected=True)
        client.points["D1"] = SimpleNamespace(Snapshot=Mock(return_value=SimpleNamespace(Value=True, Status="Good", IsGood=True, Timestamp=__import__("datetime").datetime(2026, 10, 14, tzinfo=__import__("datetime").timezone.utc))))
        client.points["D2"] = SimpleNamespace(Snapshot=Mock(return_value=SimpleNamespace(Value=1, Status="DigitalState", IsGood=True, Timestamp=__import__("datetime").datetime(2026, 10, 14, tzinfo=__import__("datetime").timezone.utc))))
        self.assertFalse(client._read_af_snapshot("D1")["good"])
        self.assertFalse(client._read_af_snapshot("D2")["good"])

    def test_af_sdk_metadata_preserves_text_boolean_and_digital_labels(self):
        from datetime import datetime, timezone
        client = PIReadClient('ARCHIVE', adapter='af-sdk')
        client.server = SimpleNamespace()
        for raw, expected in [('arquivo.xml', 'arquivo.xml'), (True, True),
                              (SimpleNamespace(Name='Operando', IsSystem=False), 'Operando'),
                              (SimpleNamespace(Name='I/O Timeout', IsSystem=True), None)]:
            client.points['TAG'] = SimpleNamespace(Snapshot=Mock(return_value=SimpleNamespace(
                Value=raw, Status='Good', IsGood=True, Timestamp=datetime.now(timezone.utc))))
            result = client.read_value('TAG')
            self.assertEqual(result['value'], expected)
            self.assertEqual(result['good'], expected is not None)

    def test_metadata_quality_staleness_and_boolean_metrics_are_isolated(self):
        item = {'id':'s', 'tags':{'serverStatus':'STATUS', 'fileRead':'FILE', 'runCPU':'CPU'}}
        client = SimpleNamespace(read=Mock(return_value={'value':True,'timestamp':100000,'good':True,'status':'Good'}),
                                 read_value=Mock(return_value={'value':'<status>','timestamp':100000,'good':True,'status':'Good'}))
        sample = read_server(item, client, 101000, 120)
        self.assertEqual(sample['metrics']['serverStatus'], '<status>')
        self.assertIsNone(sample['metrics']['runCPU'])
        self.assertFalse(sample['collecting'])
        sample = read_server(item, client, 221000, 120)
        self.assertIsNone(sample['metrics']['serverStatus'])
        client.read_value.return_value['good'] = False
        self.assertIsNone(read_server(item, client, 101000, 120)['metrics']['fileRead'])

    def test_af_sdk_reads_even_when_connected_flag_is_false(self):
        client = PIReadClient("PIDATAPRO", adapter="af-sdk", af_sdk_dll="C:/temp/afsdk.dll")
        client.server = SimpleNamespace(Connected=False)
        client.points["CSEO.COGCGPRO56.E3Run.CPU"] = SimpleNamespace(
            Snapshot=Mock(return_value=SimpleNamespace(
                Value=0.81,
                Status="Good",
                IsGood=True,
                Timestamp=__import__("datetime").datetime(2026, 10, 14, 17, 15, 47, tzinfo=__import__("datetime").timezone.utc),
            ))
        )
        sample = client._read_af_snapshot("CSEO.COGCGPRO56.E3Run.CPU")
        self.assertTrue(sample["good"])
        self.assertEqual(sample["value"], 0.81)

    def test_af_sdk_write_restrictions(self):
        client = PIReadClient("PIDATAPRO", adapter="af-sdk", af_sdk_dll="C:/temp/afsdk.dll")
        client.server = SimpleNamespace(Connected=False)
        with self.assertRaisesRegex(RuntimeError, "AF SDK.*read-only|AF SDK.*disabled|enableWrites"):
            client.write_alarm("CSEO.TAG.State", 10)
        self.assertFalse(client.server.Connected)

    def test_af_sdk_connect_reuses_session_and_point_cache(self):
        client = PIReadClient("TEST", adapter="af-sdk")
        session = SimpleNamespace(Disconnect=Mock())
        client.server = session
        point = object()
        client.points["TAG"] = point
        with patch.object(client, "_ensure_af_runtime") as runtime:
            client.connect()
            client.connect()
        runtime.assert_not_called()
        session.Disconnect.assert_not_called()
        self.assertIs(client.points["TAG"], point)

    def test_af_sdk_snapshot_failure_reconnects_on_next_connect(self):
        client = PIReadClient("TEST", adapter="af-sdk")
        old_session = SimpleNamespace(Disconnect=Mock())
        client.server = old_session
        client.points["TAG"] = SimpleNamespace(Snapshot=Mock(side_effect=RuntimeError("network failure")))
        with self.assertRaisesRegex(RuntimeError, "network failure"):
            client.read("TAG")
        self.assertIsNone(client.server)
        self.assertFalse(client.points)
        old_session.Disconnect.assert_called_once()
        new_session = SimpleNamespace(Connect=Mock(), Disconnect=Mock())
        pi_module = SimpleNamespace(PIServer=SimpleNamespace(FindPIServer=Mock(return_value=new_session)))
        clr = SimpleNamespace(AddReference=Mock())
        with patch.dict(sys.modules, {"OSIsoft.AF.PI": pi_module}), patch.object(client, "_ensure_af_runtime", return_value=clr), patch.object(client, "_validate_af_dll", return_value="test.dll"):
            client.connect()
        new_session.Connect.assert_called_once()
        self.assertIs(client.server, new_session)

    def test_af_sdk_failed_connect_cleans_up_session(self):
        client = PIReadClient("TEST", adapter="af-sdk")
        session = SimpleNamespace(Connect=Mock(side_effect=RuntimeError("denied")), Disconnect=Mock())
        pi_module = SimpleNamespace(PIServer=SimpleNamespace(FindPIServer=Mock(return_value=session)))
        clr = SimpleNamespace(AddReference=Mock())
        with patch.dict(sys.modules, {"OSIsoft.AF.PI": pi_module}), patch.object(client, "_ensure_af_runtime", return_value=clr), patch.object(client, "_validate_af_dll", return_value="test.dll"):
            with self.assertRaisesRegex(RuntimeError, "AF SDK connection unavailable"):
                client.connect()
        session.Disconnect.assert_called_once()
        self.assertIsNone(client.server)


if __name__ == "__main__":
    unittest.main()

