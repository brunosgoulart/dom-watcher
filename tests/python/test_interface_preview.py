import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))
from interface_preview import SIMULATED_METRICS, SnapshotStore, main, publish_simulation, simulated_servers


class InterfacePreviewTests(unittest.TestCase):
    def test_preview_uses_a_temporary_history_database(self):
        with patch('interface_preview.serve_preview') as serve, patch.object(sys, 'argv', ['interface_preview', '--port', '8771']):
            main()
        port, history_path = serve.call_args.args
        self.assertEqual(port, 8771)
        self.assertEqual(history_path.name, 'history.sqlite3')
        self.assertTrue(history_path.parent.name.startswith('dom-watcher-preview-'))
        self.assertFalse(history_path.parent.exists())

    def test_preview_publishes_alarm_history_without_duplicate_active_events(self):
        with TemporaryDirectory() as directory:
            servers = simulated_servers()
            store = SnapshotStore({'piAdapter': 'simulated', 'staleSeconds': 120,
                                   'historyDbPath': str(Path(directory) / 'history.sqlite3'),
                                   'servers': servers})
            for _ in range(2):
                store.stop.clear()
                with patch.object(store.stop, 'wait', side_effect=lambda _: store.stop.set()):
                    publish_simulation(store)
            snapshot = store.get()
            self.assertEqual(snapshot['source'], 'simulated')
            self.assertEqual(len(snapshot['alarmHistory']), 6)
            self.assertEqual(len(store.alarm_history()), 6)

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
