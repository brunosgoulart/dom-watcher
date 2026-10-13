"""Version: 1.2 | Date: 13/10/2026
Changes: Tested exact ten-minute sustained-rise activation, tolerated oscillations, optional historical severity and no added activation delay.
"""
import copy
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from pi_client import PIReadClient
from server import load_config, SnapshotStore
from trend_output import TrendPublisher
from trends import TREND_METRICS, TrendEngine

BASE = 1700000000000


class TrendTests(unittest.TestCase):
    def point(self, engine, index, value, metric="runCPU", good=True, stamp=None):
        stamp = BASE + index * 60000 if stamp is None else stamp
        return engine.evaluate("s", metric, value, stamp, good, BASE + index * 60000, 120)

    def rising(self, metric="runCPU"):
        e = TrendEngine()
        for i in range(41):
            r = self.point(e, i, 10 if i <= 30 else 10 + i - 30, metric)
        return e, r

    def test_warmup_and_absolute_high_value(self):
        for value in (0, 95):
            e = TrendEngine()
            for i in range(11):
                self.assertEqual(self.point(e, i, value)["state"], 30 if i < 10 else 0)

    def test_alarm_exactly_at_ten_minutes_without_reference(self):
        e = TrendEngine()
        for i in range(11):
            r = self.point(e, i, 10 + i * .01)
            self.assertEqual(r["state"], 30 if i < 10 else 10)
        self.assertFalse(r["referenceReady"])
        self.assertEqual(r["riseDurationSeconds"], 600)
        self.assertEqual(r["pendingSamples"], 0)

    def test_habitual_rise_still_alarms(self):
        e = TrendEngine()
        for i in range(50):
            r = self.point(e, i, 10 + i * .01)
        self.assertEqual(r["state"], 10)
        self.assertTrue(r["referenceReady"])
        self.assertAlmostEqual(r["score"], 0)

    def test_historical_severity_no_extra_delay(self):
        e, r = self.rising()
        self.assertEqual(r["state"], 20)
        self.assertEqual(r["riseDurationSeconds"], 600)
        self.assertTrue(r["referenceReady"])
        self.assertEqual(r["pendingSamples"], 0)

    def test_duplicates_do_not_complete_period(self):
        e = TrendEngine()
        for i in range(10):
            r = self.point(e, i, 10 + i)
        for _ in range(10):
            self.assertEqual(self.point(e, 9, 19)["state"], 30)
        self.assertEqual(self.point(e, 10, 20)["state"], 10)

    def test_small_oscillations_allowed(self):
        e = TrendEngine()
        values = [10, 11, 12, 11.8, 14, 15, 16, 15.8, 18, 19, 20]
        for i, value in enumerate(values):
            r = self.point(e, i, value)
        self.assertEqual(r["state"], 10)

    def test_prolonged_plateau_interrupts_rise(self):
        e = TrendEngine()
        for i in range(11):
            r = self.point(e, i, min(i, 7) + 10)
        self.assertEqual(r["state"], 0)

    def test_single_spike_rejected(self):
        e = TrendEngine()
        for i in range(25):
            r = self.point(e, i, 95 if i == 15 else 10)
            if i >= 10:
                self.assertEqual(r["state"], 0)

    def test_no_early_alarm_on_partial_duration(self):
        e = TrendEngine()
        for i in range(11):
            stamp = BASE + i * 59000
            r = e.evaluate("s", "runCPU", i, stamp, True, stamp, 120)
        self.assertEqual(r["state"], 30)

    def test_recovery_requires_three_new_samples(self):
        e, r = self.rising()
        self.assertEqual(r["state"], 20)
        self.assertEqual([self.point(e, i, 10)["state"] for i in range(41, 44)], [20, 20, 0])

    def test_invalid_retains_confirmed_alarm(self):
        e, _ = self.rising()
        r = self.point(e, 41, None, good=False)
        self.assertEqual((r["state"], r["confirmedState"]), (40, 20))

    def test_gap_requires_full_new_ten_minutes(self):
        e, _ = self.rising()
        for i in range(43, 53):
            self.assertEqual(self.point(e, i, 20)["state"], 30)
        self.assertEqual(self.point(e, 53, 20)["state"], 20)

    def test_future_and_reordered(self):
        e, _ = self.rising()
        self.assertEqual(self.point(e, 41, 20, stamp=BASE + 42 * 60000)["state"], 40)
        self.assertEqual(self.point(e, 41, 20, stamp=BASE + 39 * 60000)["state"], 40)

    def test_nonfinite_negative_and_boolean(self):
        for value in (float("nan"), float("inf"), -1, True):
            self.assertEqual(self.point(TrendEngine(), 0, value)["state"], 40)

    def test_custom_two_minute_duration(self):
        e = TrendEngine({"windowSeconds": 120, "referenceSeconds": 600, "memoryWindowSeconds": 300})
        for i in range(3):
            r = self.point(e, i, i + 10)
            self.assertEqual(r["state"], 30 if i < 2 else 10)
        self.assertEqual(e.history_capacity, 19)

    def test_memory_secondary_does_not_delay_principal(self):
        e = TrendEngine()
        for i in range(16):
            r = self.point(e, i, 1000 + i, "runPVT")
            if i >= 10:
                self.assertEqual(r["state"], 10)
        self.assertTrue(r["longWindowReady"])

    def test_history_capacity_and_six_independent_metrics(self):
        e = TrendEngine()
        for i in range(70):
            for metric in TREND_METRICS:
                self.point(e, i, 10, metric)
        self.assertEqual(len(e.states), 6)
        self.assertTrue(all(len(s.points) <= e.history_capacity for s in e.states.values()))


class OutputTests(unittest.TestCase):
    def config(self, enabled=True):
        return {"enableWrites": enabled, "servers": [{"id": "s", "outputs": {"runCPU": "CSEO.S.SCADA.Trend.CPU.State"}}]}

    def alarm(self, state):
        return [{"metric": "runCPU", "state": state}]

    def test_disabled_no_write(self):
        client = Mock()
        publisher = TrendPublisher(self.config(False))
        alarms = self.alarm(20)
        publisher.publish("s", alarms, client, BASE)
        client.write_alarm.assert_not_called()
        self.assertEqual(alarms[0]["writeStatus"], "disabled")

    def test_state_change_heartbeat_and_retry(self):
        client = Mock()
        p = TrendPublisher(self.config())
        p.publish("s", self.alarm(10), client, BASE)
        p.publish("s", self.alarm(10), client, BASE + 30000)
        self.assertEqual(client.write_alarm.call_count, 1)
        p.publish("s", self.alarm(10), client, BASE + 60000)
        self.assertEqual(client.write_alarm.call_count, 2)
        client.write_alarm.side_effect = RuntimeError("rejected")
        failed = self.alarm(20)
        p.publish("s", failed, client, BASE + 90000)
        self.assertEqual(failed[0]["writeStatus"], "failed")
        delayed = self.alarm(40)
        p.publish("s", delayed, client, BASE + 100000)
        self.assertEqual(delayed[0]["writeStatus"], "failed")
        client.write_alarm.side_effect = None
        recovered = self.alarm(40)
        p.publish("s", recovered, client, BASE + 120000)
        self.assertEqual(recovered[0]["lastWrittenState"], 40)

    def test_client_write_allowlist_and_codes(self):
        c = PIReadClient("S", ["CSEO.S.SCADA.Trend.CPU.State"])
        with self.assertRaises(PermissionError):
            c.write_alarm("INPUT", 20)
        with self.assertRaises(ValueError):
            c.write_alarm("CSEO.S.SCADA.Trend.CPU.State", 99)
        with self.assertRaises(ValueError):
            c.write_alarm("CSEO.S.SCADA.Trend.CPU.State", True)

    def test_actual_sdk_call_shape_with_mock(self):
        update = Mock()
        point = SimpleNamespace(Data=SimpleNamespace(UpdateValue=update))
        c = PIReadClient("S", ["CSEO.S.SCADA.Trend.CPU.State"])
        c.server = SimpleNamespace(Connected=True, PIPoints=SimpleNamespace(Item=Mock(return_value=point)))
        time_object = SimpleNamespace(InputString=None)
        dispatch = Mock(return_value=time_object)
        win32 = SimpleNamespace(client=SimpleNamespace(Dispatch=dispatch))
        with patch.dict(sys.modules, {"win32com": win32, "win32com.client": win32.client}):
            c.write_alarm("CSEO.S.SCADA.Trend.CPU.State", 20)
            update.assert_called_once_with(20, time_object, 1, None)
            self.assertEqual(time_object.InputString, "*")

    def test_missing_client_stays_pending(self):
        p = TrendPublisher(self.config())
        alarms = self.alarm(40)
        p.publish("s", alarms, None, BASE)
        self.assertEqual(alarms[0]["writeStatus"], "pending")


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.path = Path(__file__).with_name("config.example.toml")
        self.config = load_config(self.path)

    def load_fake(self, config):
        with patch("server.tomllib.load", return_value=copy.deepcopy(config)):
            return load_config(self.path)

    def test_example_outputs_42_disabled(self):
        self.assertFalse(self.config["enableWrites"])
        self.assertEqual(sum(len(s["outputs"]) for s in self.config["servers"]), 42)

    def test_output_collision_and_input_overlap_rejected(self):
        c = copy.deepcopy(self.config)
        c["servers"][1]["outputs"]["runCPU"] = c["servers"][0]["outputs"]["runCPU"]
        with self.assertRaises(ValueError):
            self.load_fake(c)
        c = copy.deepcopy(self.config)
        c["servers"][0]["tags"]["runCPU"] = c["servers"][0]["outputs"]["runCPU"]
        with self.assertRaises(ValueError):
            self.load_fake(c)

    def test_enable_requires_real_inputs_and_server(self):
        c = copy.deepcopy(self.config)
        c["enableWrites"] = True
        with self.assertRaises(ValueError):
            self.load_fake(c)

    def test_resolution_and_scores_validated(self):
        c = copy.deepcopy(self.config)
        c["trend"]["resolution"]["runCPU"] = 0
        with self.assertRaises(ValueError):
            self.load_fake(c)

    def test_configurable_window_validation(self):
        c = copy.deepcopy(self.config)
        c["trend"].update(windowSeconds=120, referenceSeconds=600, memoryWindowSeconds=300)
        self.assertEqual(self.load_fake(c)["trend"]["windowSeconds"], 120)
        for key, value in (("windowSeconds", 61), ("windowSeconds", 0), ("referenceSeconds", 300), ("memoryWindowSeconds", 60), ("windowSeconds", True)):
            invalid = copy.deepcopy(c)
            invalid["trend"][key] = value
            with self.assertRaises(ValueError):
                self.load_fake(invalid)
        c = copy.deepcopy(self.config)
        c["trend"]["criticalScore"] = -1
        with self.assertRaises(ValueError):
            self.load_fake(c)

    def test_api_contains_quality_states_without_connection(self):
        store = SnapshotStore(self.config)
        store.poll()
        data = store.get()
        self.assertEqual(len(data["servers"][0]["trends"]), 6)
        self.assertTrue(all(t["state"] == 40 and t["writeStatus"] == "disabled" for s in data["servers"] for t in s["trends"]))


if __name__ == "__main__":
    unittest.main()
