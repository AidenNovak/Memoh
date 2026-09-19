"""Unit tests for the verification build, the cleaner and the native dispatcher."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).parent


def load(name):
    spec = importlib.util.spec_from_file_location(f'memoh_verify_{name}', HERE / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_settings(app='/cache/Build/Products/Debug-iphonesimulator/Memoh.app'):
    """The shape of `xcodebuild -showBuildSettings -json` that we depend on."""
    return json.dumps(
        [
            {
                'buildSettings': {
                    'TARGET_BUILD_DIR': str(Path(app).parent),
                    'FULL_PRODUCT_NAME': Path(app).name,
                    'BUILD_DIR': '/cache/Build/Products',
                }
            }
        ]
    )


class DestinationTests(unittest.TestCase):
    def test_a_lease_pins_the_build_to_one_device(self):
        build = load('build')

        self.assertEqual(build.destination(None, {'MEMOH_VERIFY_UDID': 'LEASED'}), 'id=LEASED')

    def test_an_explicit_destination_wins(self):
        build = load('build')

        self.assertEqual(build.destination('generic/platform=iOS Simulator', {'MEMOH_VERIFY_UDID': 'LEASED'}),
                         'generic/platform=iOS Simulator')

    def test_without_a_lease_the_build_says_how_to_get_one(self):
        build = load('build')

        with self.assertRaises(SystemExit) as caught:
            build.destination(None, {})

        message = str(caught.exception)
        self.assertIn('MEMOH_VERIFY_UDID', message)
        self.assertIn('verify:simulator', message)


class SharedCacheTests(unittest.TestCase):
    def test_the_default_cache_is_inside_this_checkout(self):
        build = load('build')

        expected = (HERE / '.artifacts' / 'derived-data').resolve()
        self.assertEqual(Path(build.DEFAULT_DERIVED_DATA).resolve(), expected)

    def test_the_build_always_names_one_derived_data(self):
        build = load('build')
        arguments = build.parse_arguments([])
        arguments.destination = 'id=LEASED'
        arguments.scheme = 'Memoh'
        arguments.derived_data = build.DEFAULT_DERIVED_DATA

        command = build.xcodebuild_command(arguments, Path('/tmp/Memoh.xcworkspace'))

        self.assertIn('-derivedDataPath', command)
        self.assertEqual(command[command.index('-derivedDataPath') + 1], str(build.DEFAULT_DERIVED_DATA))
        self.assertNotIn('CODE_SIGNING_ALLOWED=NO', ' '.join(command))

    def test_builds_of_one_checkout_are_serialized(self):
        build = load('build')
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / 'verify-build.lock'
            with build.build_lock(lock):
                held = open(lock, 'w')
                try:
                    import fcntl

                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    held.close()


class NativeProjectTests(unittest.TestCase):
    def test_the_app_workspace_is_chosen_over_the_pods_workspace(self):
        build = load('build')
        with tempfile.TemporaryDirectory() as directory:
            ios = Path(directory)
            (ios / 'Pods.xcworkspace').mkdir()
            (ios / 'Memoh.xcworkspace' / 'xcshareddata' / 'xcschemes').mkdir(parents=True)
            (ios / 'Memoh.xcworkspace' / 'xcshareddata' / 'xcschemes' / 'Memoh.xcscheme').write_text('<Scheme/>')

            workspace = build.find_workspace(ios)
            scheme = build.find_scheme(workspace)

            self.assertEqual(workspace.name, 'Memoh.xcworkspace')
            self.assertEqual(scheme, 'Memoh')

    def test_a_project_without_a_workspace_is_not_built(self):
        build = load('build')
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(build.find_workspace(Path(directory)))

    def test_pods_count_as_installed_only_with_a_lockfile(self):
        build = load('build')
        with tempfile.TemporaryDirectory() as directory:
            ios = Path(directory)
            (ios / 'Pods').mkdir()
            self.assertFalse(build.pods_installed(ios))
            (ios / 'Podfile.lock').write_text('PODS:\n')
            self.assertTrue(build.pods_installed(ios))

    def test_a_scheme_that_is_not_the_app_name_still_resolves(self):
        build = load('build')
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / 'Something.xcworkspace'
            (workspace / 'xcshareddata' / 'xcschemes').mkdir(parents=True)
            (workspace / 'xcshareddata' / 'xcschemes' / 'Something.xcscheme').write_text('<Scheme/>')

            self.assertEqual(build.find_scheme(workspace), 'Something')


class ProductResolutionTests(unittest.TestCase):
    def test_the_app_path_comes_from_xcode_not_from_a_guess(self):
        build = load('build')

        app, products = build.resolve_product(json.loads(build_settings()))

        self.assertEqual(app, Path('/cache/Build/Products/Debug-iphonesimulator/Memoh.app'))
        self.assertEqual(products, Path('/cache/Build/Products'))
        self.assertTrue(str(app).endswith('.app'))

    def test_a_failed_settings_query_is_reported_with_its_stderr(self):
        build = load('build')

        def failing_run(command, **kwargs):
            return subprocess.CompletedProcess(command, 65, '', 'xcodebuild: error: no scheme')

        with self.assertRaises(SystemExit) as caught:
            build.show_build_settings(['xcodebuild'], run=failing_run)

        self.assertIn('no scheme', str(caught.exception))

    def test_settings_are_requested_as_json(self):
        build = load('build')
        seen = {}

        def recording_run(command, **kwargs):
            seen['command'] = command
            return subprocess.CompletedProcess(command, 0, build_settings(), '')

        build.show_build_settings(['xcodebuild', '-scheme', 'Memoh'], run=recording_run)

        self.assertEqual(seen['command'][-2:], ['-showBuildSettings', '-json'])


class ScratchDetectionTests(unittest.TestCase):
    def build_cache(self, root, name='toolbar-repro-build'):
        path = Path(root) / name
        (path / 'Build' / 'Products').mkdir(parents=True)
        return path

    def staged_checkout(self, root, name='memoh-split.abcdef'):
        path = Path(root) / name
        (path / 'apps' / 'mobile').mkdir(parents=True)
        (path / 'pnpm-workspace.yaml').write_text('packages: []\n')
        return path

    def test_build_caches_and_staged_checkouts_are_scratch(self):
        clean = load('clean')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            self.assertTrue(clean.is_scratch(self.build_cache(root)))
            self.assertTrue(clean.is_scratch(self.staged_checkout(root)))

    def test_unrelated_directories_are_never_scratch(self):
        clean = load('clean')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            frames = root / 'codex-smoothness.7OwJdg'
            (frames / 'Build').mkdir(parents=True)
            work = root / 'work'
            (work / 'memoh-ios' / 'apps' / 'mobile').mkdir(parents=True)
            similar = root / 'memoh-notes'
            similar.mkdir()
            (similar / 'apps').mkdir()

            for path in [frames, work, similar, root]:
                with self.subTest(path=path.name):
                    self.assertFalse(clean.is_scratch(path))

    def test_a_bare_xcode_cache_root_is_scratch(self):
        clean = load('clean')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'ModuleCache.noindex').mkdir()
            (root / 'SDKStatCaches.noindex').mkdir()

            self.assertTrue(clean.is_scratch(root))
            self.assertFalse(clean.is_scratch(root / 'ModuleCache.noindex'))

    def test_recent_and_small_entries_stay_out_of_the_report(self):
        clean = load('clean')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.build_cache(root, 'memoh-fresh.abcdef')
            large = self.build_cache(root, 'old-build')
            (large / 'Build' / 'Products' / 'Memoh.app').write_bytes(b'x' * 4096)

            self.assertEqual(clean.collect([root], older_than_hours=24, minimum_bytes=0), [])
            self.assertEqual(clean.collect([root], older_than_hours=0, minimum_bytes=1024 * 1024), [])

            os.utime(large, (0, 0))
            aged = clean.collect([root], older_than_hours=10, minimum_bytes=0)
            self.assertEqual([path.name for path, _, _ in aged], ['old-build'])

    def test_the_shared_build_cache_is_never_collected(self):
        clean = load('clean')
        with tempfile.TemporaryDirectory() as directory:
            artifacts = Path(directory)
            shared = artifacts / 'derived-data'
            (shared / 'Build' / 'Products').mkdir(parents=True)
            os.utime(shared, (0, 0))

            self.assertEqual(clean.collect_artifact_scratch(artifacts, older_than_hours=0), [])

    def test_apply_removes_only_reported_scratch(self):
        clean = load('clean')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = self.build_cache(root)
            bystander = root / 'toolbar-investigation'
            bystander.mkdir()
            (bystander / 'notes.md').write_text('keep\n')

            exit_code = clean.main(['--root', str(root), '--older-than', '0', '--apply'])

            self.assertEqual(exit_code, 0)
            self.assertFalse(cache.exists())
            self.assertTrue((bystander / 'notes.md').exists())

    def test_a_dry_run_reports_without_removing(self):
        clean = load('clean')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = self.build_cache(root)

            result = subprocess.run(
                [sys.executable, str(HERE / 'clean.py'), '--root', str(root), '--older-than', '0'],
                check=True,
                capture_output=True,
                text=True,
            )

            self.assertIn('Would remove 1 directories', result.stdout)
            self.assertIn('Pass --apply', result.stdout)
            self.assertTrue(cache.exists())


class NativeDispatchTests(unittest.TestCase):
    def test_the_prerequisite_check_needs_no_kit_sources(self):
        native = load('native')

        sources = native.expand_sources(native.CHECKS['simulator-toolchain'])

        self.assertEqual(sources, [])

    def test_a_check_without_sources_is_skipped_rather_than_passed(self):
        native = load('native')
        buffer = io.StringIO()

        code = native.run_all({'kit-loads': native.CHECKS['kit-loads']}, 'UNUSED-UDID', stream=buffer)

        self.assertEqual(code, 0)
        self.assertIn('"status": "skipped"', buffer.getvalue())
        self.assertNotIn('"status": "passed"', buffer.getvalue())

    def test_an_unknown_check_is_rejected(self):
        native = load('native')

        with self.assertRaises(SystemExit):
            native.select_checks('nope')

    def test_the_check_binary_targets_the_deployment_floor(self):
        native = load('native')
        check = native.CHECKS['simulator-toolchain']

        command = native.swiftc_command(check, [], Path('/tmp/check'), sdk='/sdk')

        self.assertIn('-target', command)
        self.assertIn('apple-ios26.0-simulator', command[command.index('-target') + 1])

    def test_listing_checks_needs_no_device(self):
        native = load('native')
        buffer = io.StringIO()

        with contextlib.redirect_stdout(buffer):
            code = native.main(['--list'])

        self.assertEqual(code, 0)
        self.assertIn('simulator-toolchain', buffer.getvalue())


if __name__ == '__main__':
    unittest.main()
