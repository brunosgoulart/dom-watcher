import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[2] / 'scada_api'))

import copy
import math
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from absolute_alarms import evaluate_absolute, validate_absolute
from server import SnapshotStore, empty_server, load_config
from trend_output import TrendPublisher


class AbsoluteAlarmTests(unittest.TestCase):
    def setUp(self):
        self.item = {"id": "s", "tags": {"runCPU": "CPU"}, "absoluteLimits": {"runCPU": 90},
                     "absoluteOutputs": {"runCPU": "CSEO.S.SCADA.Absolute.CPU.State"}}
        self.sample = empty_server(self.item, "")
        self.sample["metrics"]["runCPU"] = 95
        self.sample["metricQuality"]["runCPU"] = {"good": True, "timestamp": 100000}

    def evaluate(self):
        return evaluate_absolute(self.item, self.sample, 100000, 120)

    def test_high_stable_value_and_exact_limit_activate_immediately(self):
        for value, state in ((95, 20), (90, 20), (89.9, 0), (0, 0)):
            self.sample["metrics"]["runCPU"] = value
            self.assertEqual(self.evaluate()[0]["state"], state)

    def test_blank_and_omitted_limits_are_disabled_including_outputs(self):
        for limits in ({}, {"runCPU": ""}):
            self.item["absoluteLimits"] = limits
            self.assertEqual(self.evaluate(), [])
            client = Mock()
            publisher = TrendPublisher({"enableWrites": True, "servers": [self.item]}, "absoluteOutputs")
            publisher.publish("s", self.evaluate(), client, 100000)
            client.write_alarm.assert_not_called()

    def test_zero_limit_is_enabled(self):
        self.item["absoluteLimits"]["runCPU"] = 0
        self.assertEqual(self.evaluate()[0]["state"], 20)

    def test_bad_missing_stale_future_and_out_of_range_are_invalid(self):
        for field, value in (("value", None), ("value", math.nan), ("value", True),
                             ("value", -1), ("value", 101), ("timestamp", -30000),
                             ("timestamp", 100001), ("good", False)):
            sample = copy.deepcopy(self.sample)
            if field == "value":
                sample["metrics"]["runCPU"] = value
            else:
                sample["metricQuality"]["runCPU"][field] = value
            self.assertEqual(evaluate_absolute(self.item, sample, 100000, 120)[0]["state"], 40)

    def test_all_six_metrics_and_blank_output(self):
        keys = ("runCPU", "runMemory", "runPVT", "runErrorsPerMinute", "runLocalPending", "runRemotePending")
        self.item["absoluteLimits"] = dict.fromkeys(keys, 10)
        self.item["tags"] = {key: key for key in keys}
        for key in keys:
            self.sample["metrics"][key] = 11
            self.sample["metricQuality"][key] = {"good": True, "timestamp": 100000}
        self.assertEqual([a["state"] for a in self.evaluate()], [20] * 6)
        self.item["absoluteOutputs"] = {"runCPU": ""}
        publisher = TrendPublisher({"enableWrites": True, "servers": [self.item]}, "absoluteOutputs")
        alarms = self.evaluate()
        client = Mock()
        publisher.publish("s", alarms, client, 100000)
        client.write_alarm.assert_not_called()
        self.assertTrue(all(a["writeStatus"] == "not-configured" for a in alarms))

    def test_invalid_configuration_rejected(self):
        for limit in (True, -1, 101, math.inf, "90", " "):
            self.item["absoluteLimits"]["runCPU"] = limit
            with self.assertRaises(ValueError):
                validate_absolute(self.item)
        self.item["absoluteLimits"] = {"runTRD": 100}
        with self.assertRaises(ValueError):
            validate_absolute(self.item)

    def test_publish_heartbeat_recovery_and_failure(self):
        publisher = TrendPublisher({"enableWrites": True, "servers": [self.item]}, "absoluteOutputs")
        client = Mock()
        alarms = self.evaluate()
        publisher.publish("s", alarms, client, 100000)
        client.write_alarm.assert_called_once_with(self.item["absoluteOutputs"]["runCPU"], 20)
        publisher.publish("s", self.evaluate(), client, 101000)
        self.assertEqual(client.write_alarm.call_count, 1)
        self.sample["metrics"]["runCPU"] = 80
        publisher.publish("s", self.evaluate(), client, 131000)
        self.assertEqual(client.write_alarm.call_args.args[1], 0)
        client.write_alarm.side_effect = RuntimeError("offline")
        self.sample["metrics"]["runCPU"] = 95
        alarms = self.evaluate()
        publisher.publish("s", alarms, client, 162000)
        self.assertEqual(alarms[0]["writeStatus"], "failed")

    def reference_config(self):
        with patch("server.os.path.exists", return_value=True):
            return load_config(Path(__file__).resolve().parents[2] / "scada_api" / "config.reference.toml")

    def test_reference_defaults_disabled_and_original_trends_preserved(self):
        config = self.reference_config()
        self.assertFalse(config["enableWrites"])
        self.assertEqual(sum(len(s["outputs"]) for s in config["servers"]), 42)
        store = SnapshotStore(config)
        store.poll()
        for server in store.get()["servers"]:
            self.assertEqual(len(server["trends"]), 6)
            self.assertEqual(server["absoluteAlarms"], [])

    def test_global_collision_and_input_overlap_rejected(self):
        config = self.reference_config()
        tag = "CSEO.S.SCADA.Absolute.CPU.State"
        for overlap in (False, True):
            changed = copy.deepcopy(config)
            changed["servers"][0]["absoluteOutputs"] = {"runCPU": tag}
            if overlap:
                changed["servers"][0]["tags"]["runCPU"] = tag
            else:
                changed["servers"][1]["absoluteOutputs"] = {"runCPU": tag}
            with patch("server.tomllib.load", return_value=changed), patch("server.os.path.exists", return_value=True):
                with self.assertRaises(ValueError):
                    load_config(Path(__file__).resolve().parents[2] / "scada_api" / "config.reference.toml")

    def test_snapshot_exposes_absolute_independent_from_insufficient_trend(self):
        config = {"servers": [self.item], "staleSeconds": 120, "enableWrites": False}
        store = SnapshotStore(config)
        with patch("server.time.time", return_value=100):
            store.publish([self.sample], "degraded")
        server = store.get()["servers"][0]
        self.assertEqual(server["absoluteAlarms"][0]["state"], 20)
        self.assertEqual(server["absoluteAlarms"][0]["writeStatus"], "disabled")
        self.assertEqual(next(t for t in server["trends"] if t["metric"] == "runCPU")["state"], 30)


if __name__ == "__main__":
    unittest.main()
