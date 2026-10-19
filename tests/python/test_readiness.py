import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scada_api'))
from readiness import REQUIRED_INPUTS, configuration_report


class ReadinessTests(unittest.TestCase):
    def config(self):
        return {"piServer": "ARCHIVE", "piAdapter": "pi-sdk-com", "enableWrites": False,
                "servers": [{"id": "s", "tags": {key: key for key in REQUIRED_INPUTS}}]}

    def test_valid_configuration_and_modules_do_not_connect(self):
        with patch('readiness.os.name', 'nt'), patch('readiness.importlib.util.find_spec', return_value=Mock()), patch('pi_client.PIReadClient') as client:
            report = configuration_report(self.config())
            self.assertTrue(report['readyForConnection'])
            self.assertFalse(report['writesEnabled'])
            client.assert_not_called()

    def test_missing_archive_and_input_are_reported(self):
        config = self.config()
        config['piServer'] = ''
        del config['servers'][0]['tags']['runCPU']
        with patch('readiness.os.name', 'nt'), patch('readiness.importlib.util.find_spec', return_value=Mock()):
            report = configuration_report(config)
        self.assertFalse(report['readyForConnection'])
        self.assertEqual(report['servers'][0]['missingEssentialInputs'], ['runCPU'])
        self.assertEqual(len(report['issues']), 2)

    def test_missing_sdk_dependency_and_non_windows_are_not_ready(self):
        with patch('readiness.os.name', 'posix'), patch('readiness.importlib.util.find_spec', return_value=None):
            report = configuration_report(self.config())
        self.assertFalse(report['readyForConnection'])
        self.assertEqual(len(report['issues']), 3)

    def test_af_sdk_requires_pythonnet_only(self):
        config = self.config()
        config['piAdapter'] = 'af-sdk'
        with patch('readiness.os.name', 'nt'), patch('readiness.importlib.util.find_spec', return_value=Mock()) as modules:
            self.assertTrue(configuration_report(config)['readyForConnection'])
            modules.assert_called_once_with('pythonnet')
