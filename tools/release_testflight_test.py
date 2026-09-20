#!/usr/bin/env python3
"""Pure regression tests for the TestFlight release driver."""
import importlib.util
import os
import plistlib
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name('release-testflight.py')


def load():
    spec = importlib.util.spec_from_file_location('memoh_release_testflight', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CredentialTests(unittest.TestCase):
    def test_all_three_asc_values_are_required(self):
        release = load()
        with self.assertRaises(SystemExit) as caught:
            release.asc_credentials({})
        self.assertIn('ASC_KEY_PATH', str(caught.exception))

    def test_key_path_must_exist(self):
        release = load()
        with self.assertRaises(SystemExit) as caught:
            release.asc_credentials({'ASC_KEY_PATH': '/missing/key.p8', 'ASC_KEY_ID': 'id', 'ASC_ISSUER_ID': 'issuer'})
        self.assertIn('does not exist', str(caught.exception))


class ExportOptionsTests(unittest.TestCase):
    def test_export_is_manual_and_never_changes_the_build_number(self):
        release = load()
        options = release.export_options('export')
        self.assertEqual(options['signingStyle'], 'manual')
        self.assertFalse(options['manageAppVersionAndBuildNumber'])
        self.assertEqual(options['provisioningProfiles'], {'ai.memoh.ios': 'Memoh iOS App Store (mini)'})

    def test_only_export_and_upload_are_valid_destinations(self):
        release = load()
        self.assertEqual(release.export_options('upload')['destination'], 'upload')
        with self.assertRaises(ValueError):
            release.export_options('store')


class ArchiveTests(unittest.TestCase):
    def fixture(self, root: str, build='3', archive_build='3', bundle='ai.memoh.ios') -> Path:
        archive = Path(root) / 'Memoh.xcarchive'
        app = archive / 'Products/Applications/Memoh.app'
        app.mkdir(parents=True)
        (archive / 'Info.plist').write_bytes(plistlib.dumps({'ApplicationProperties': {'CFBundleVersion': archive_build}}))
        (app / 'Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': bundle,
            'CFBundleShortVersionString': '0.1.0',
            'CFBundleVersion': build,
        }))
        return archive

    def test_both_archive_build_numbers_must_match(self):
        release = load()
        with tempfile.TemporaryDirectory() as directory:
            metadata = release.verify_archive(self.fixture(directory), 3)
            self.assertEqual(metadata['version'], '0.1.0')
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(SystemExit):
                release.verify_archive(self.fixture(directory, archive_build='2'), 3)

    def test_bundle_identifier_is_pinned(self):
        release = load()
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(SystemExit):
                release.verify_archive(self.fixture(directory, bundle='example.bad'), 3)


if __name__ == '__main__':
    unittest.main()
