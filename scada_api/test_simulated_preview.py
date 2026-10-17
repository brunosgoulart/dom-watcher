import unittest

from simulated_preview import SIMULATED_METRICS, simulated_servers


class SimulatedPreviewTests(unittest.TestCase):
    def test_three_servers_expose_all_selected_points_as_good_samples(self):
        servers = simulated_servers(1_700_000_000_000)
        self.assertEqual([server["name"] for server in servers], ["COGCGPRO12", "COGCGPRO34", "COGCGPRO56"])
        for server in servers:
            self.assertTrue(server["collecting"])
            self.assertEqual(len(server["trends"]), 7)
            for metric in SIMULATED_METRICS:
                self.assertIsNotNone(server["metrics"][metric])
                self.assertTrue(server["metricQuality"][metric]["good"])


if __name__ == "__main__":
    unittest.main()
