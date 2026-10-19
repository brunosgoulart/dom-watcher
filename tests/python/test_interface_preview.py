import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))
from interface_preview import SIMULATED_METRICS, simulated_servers


class InterfacePreviewTests(unittest.TestCase):
    def test_profiles_have_current_samples_and_independent_absolute_alarm(self):
        servers = simulated_servers(1700000000000)
        self.assertEqual([s['id'] for s in servers], ['COGCGPRO12', 'COGCGPRO34', 'COGCGPRO56'])
        for server in servers:
            self.assertTrue(server['collecting'])
            self.assertTrue(all(server['metricQuality'][key]['good'] for key in SIMULATED_METRICS))
            self.assertTrue(all(a['writeStatus'] == 'disabled' for a in server['absoluteAlarms']))
        cpu = next(a for a in servers[0]['absoluteAlarms'] if a['metric'] == 'runCPU')
        self.assertEqual(cpu['state'], 20)
        self.assertEqual(next(t for t in servers[0]['trends'] if t['metric'] == 'runCPU')['state'], 0)
