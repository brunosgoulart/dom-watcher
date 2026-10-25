"""Version: 1.1 | Date: 24/10/2026
Changes: Verified that the simulated publisher retains its explicit alarm scenarios.
"""
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scada_api"))

from server import SnapshotStore
from simulated_data import BASIC_PROFILES, SIMULATED_METRICS, publish_simulation, simulated_config, simulated_servers


class SimulatedDataTests(unittest.TestCase):
    def test_profiles_are_explicitly_marked_as_simulated_and_read_only(self):
        servers = simulated_servers(1700000000000)
        self.assertEqual(len(BASIC_PROFILES), 3)
        self.assertEqual([server["id"] for server in servers], ["COGCGPRO12", "COGCGPRO34", "COGCGPRO56"])
        for server in servers:
            self.assertTrue(server["collecting"])
            self.assertIn("simulados", server["message"])
            self.assertTrue(all(server["metricQuality"][key]["status"] == "Simulated" for key in SIMULATED_METRICS))
            self.assertTrue(all(alarm["writeStatus"] == "disabled" for alarm in server["absoluteAlarms"]))

    def test_simulated_config_never_enables_writes(self):
        with TemporaryDirectory() as directory:
            config = simulated_config(Path(directory) / "history.sqlite3")
            store = SnapshotStore(config)
            self.assertEqual(store.get()["source"], "simulated")
            self.assertFalse(config["enableWrites"])

    def test_publish_simulation_updates_snapshot(self):
        with TemporaryDirectory() as directory:
            store = SnapshotStore(simulated_config(Path(directory) / "history.sqlite3"))
            with patch.object(store.stop, "wait", side_effect=lambda _: store.stop.set()):
                publish_simulation(store)
            snapshot = store.get()
            self.assertEqual(snapshot["serviceStatus"], "connected")
            self.assertTrue(any(alarm["state"] == 20
                                for server in snapshot["servers"]
                                for alarm in server["absoluteAlarms"]))
