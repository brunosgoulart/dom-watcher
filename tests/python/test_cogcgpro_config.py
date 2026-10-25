"""Verify the approved input inventory without contacting PI or loading its SDK."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scada_api'))
from server import ESSENTIAL, SnapshotStore, load_config, read_server

PROFILE = Path(__file__).resolve().parents[2] / 'scada_api' / 'config.toml'
MAPPING = {
    'runCPU': 'E3Run.CPU', 'runMemory': 'E3Run.Memory',
    'runPVT': 'E3Run.PVT', 'runTRD': 'E3Run.TRD',
    'runLocalPending': 'E3Run.PendingEvents', 'runRemotePending': 'E3Run.RemotePending',
    'runOccupancy': 'E3Run.Occupancy', 'runErrorsPerMinute': 'E3Run.ErrorsPerMinute',
    'serverCPU': 'E3Server.CPU', 'serverHDL': 'E3Server.HDL',
    'ioQueuePending': 'ioQueue.Pending', 'ioQueueAvgDelay': 'ioQueue.AvgDelay',
    'totalTime': 'TotalTime', 'runUptimeMinutes': 'E3Run.UpTimeMinutes',
    'remoteHandledRate': 'E3Run.RemoteHandledPerMinute',
    'remoteDiscardPercent': 'E3Run.RemoteDiscardPercent',
    'runAvgScriptTime': 'E3Run.AvgScriptTime',
    'runDiscardedEvents': 'E3Run.DiscardedEvents',
    'runErrors': 'E3Run.Errors',
    'runHDL': 'E3Run.HDL',
    'runPageFaults': 'E3Run.PageFaults',
    'remoteDiscardedRate': 'E3Run.RemoteDiscardedPerMinute',
    'serverPVT': 'E3Server.PVT',
    'collectionTimestamp': 'CollectionTimeStamp',
    'fileRead': 'FileRead',
    'serverStatus': 'E3Server.Status',
}


class CogcgproConfigTests(unittest.TestCase):
    def config(self):
        # Only assembly existence is mocked; all TOML validation runs normally.
        with patch('server.os.path.exists', return_value=True):
            return load_config(PROFILE)

    def test_exact_case_sensitive_point_names_and_real_inventory(self):
        config = self.config()
        self.assertEqual([s['id'] for s in config['servers']],
                         ['COGCGPRO12', 'COGCGPRO34', 'COGCGPRO56'])
        for item in config['servers']:
            self.assertEqual(item['name'], item['id'])
            self.assertEqual(item['tags'], {key: f"CSEO.{item['id']}.{suffix}" for key, suffix in MAPPING.items()})
            self.assertTrue(set(ESSENTIAL).issubset(item['tags']))

    def test_confirmed_archive_without_assumed_limits_or_output_points(self):
        config = self.config()
        self.assertEqual(config['piAdapter'], 'af-sdk')
        self.assertEqual(config['piServer'], 'pidatapro')
        self.assertFalse(config['enableWrites'])
        for item in config['servers']:
            self.assertFalse(item.get('outputs'))
            self.assertFalse(item.get('absoluteOutputs'))
            self.assertFalse(item.get('absoluteLimits'))

    def test_all_78_mapped_inputs_are_read_and_unavailable_inputs_stay_empty(self):
        requested = []

        class Client:
            def read_value(self, tag):
                requested.append(tag)
                return {'value': 'Publicado no PI', 'timestamp': 100000, 'good': True, 'status': 'Good'}

            def read(self, tag):
                requested.append(tag)
                return {'value': 10.5, 'timestamp': 100000, 'good': True, 'status': 'Good'}

        config = self.config()
        snapshots = [read_server(item, Client(), 101000, 120) for item in config['servers']]
        store = SnapshotStore(config)
        store.publish(snapshots, 'connected')
        for item in store.get()['servers']:
            self.assertTrue(item['collecting'])
            self.assertEqual(item['metrics']['runPVT'], 10.5)
            self.assertEqual(item['metrics']['remoteHandledRate'], 10.5)
            for key in ['localEnteredRate', 'localHandledRate', 'localDiscardPercent', 'remoteEnteredRate', 'driveCFreeMB', 'etlFileSizeMB']:
                self.assertIsNone(item['metrics'][key])
            self.assertEqual(item['histories'], {'local': [], 'remote': []})
            self.assertEqual(item['metrics']['serverStatus'], 'Publicado no PI')
            self.assertEqual(item['metrics']['fileRead'], 'Publicado no PI')
            self.assertEqual(item['metrics']['runHDL'], 10.5)
        self.assertEqual(len(requested), 78)
        self.assertEqual(len(set(requested)), 78)
