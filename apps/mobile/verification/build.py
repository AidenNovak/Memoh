#!/usr/bin/env python3
"""Build the Debug Simulator app for verification, on one shared DerivedData.

    pnpm verify:simulator --name 'app-launch' -- pnpm verify:build

stdout carries the app path and nothing else (so ``APP=$(pnpm --silent verify:build)``
works); progress and the xcodebuild log go to stderr. ``--json`` prints
``{"app", "derivedData", "log"}`` instead. **目前没有自动消费这个路径的 harness**
（UI harness 已于 2026-09-19 删除，见 memoh-ios-dev.md §9），手工验收时用得上。

One checkout has exactly one build cache - ``verification/.artifacts/derived-data``
- so a rebuild after a source change reuses the previous products. Do not hand
every task its own ``-derivedDataPath``: that costs gigabytes per task and makes
every build cold. Concurrent builds of this checkout are serialized with a file
lock, because one DerivedData cannot serve two xcodebuild runs.

Signing stays exactly as a normal Xcode run: no ``CODE_SIGNING_ALLOWED=NO``.
"""
import argparse
import fcntl
import json
import os
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
IOS = ROOT / 'apps/mobile/ios'
ARTIFACTS = HERE / '.artifacts'
DEFAULT_DERIVED_DATA = ARTIFACTS / 'derived-data'
DEFAULT_LOG = ARTIFACTS / 'build.log'
DEFAULT_CONFIGURATION = 'Debug'
DEFAULT_SCHEME = 'Memoh'
MOBILE_PACKAGE = '@memoh-ios/mobile'
SDK = 'iphonesimulator'
ENVIRONMENT_VARIABLE = 'MEMOH_VERIFY_UDID'
GENERIC_DESTINATION = 'generic/platform=iOS Simulator'


def progress(message):
    print(message, file=sys.stderr)


def default_destination(environ=None):
    """A lease pins the build to one device; without one the caller must say so."""
    environ = os.environ if environ is None else environ
    udid = environ.get(ENVIRONMENT_VARIABLE)
    if udid:
        return f'id={udid}'
    return None


def destination(explicit, environ=None):
    if explicit:
        return explicit
    leased = default_destination(environ)
    if leased:
        return leased
    raise SystemExit(
        f'{ENVIRONMENT_VARIABLE} is not set.\n'
        'Wrap the build in a Simulator lease so it targets one device:\n'
        "  pnpm verify:simulator --name 'app-launch' -- pnpm verify:build\n"
        'Pass --destination to build for an explicit device or for '
        f'{GENERIC_DESTINATION}.'
    )


def find_workspace(ios_directory=IOS):
    """The prebuild workspace, never the Pods workspace nested inside it."""
    candidates = sorted(
        path
        for path in Path(ios_directory).glob('*.xcworkspace')
        if path.is_dir() and path.name != 'Pods.xcworkspace'
    )
    if not candidates:
        return None
    preferred = [path for path in candidates if path.stem == DEFAULT_SCHEME]
    return (preferred or candidates)[0]


def find_scheme(workspace, fallback=DEFAULT_SCHEME):
    """The app scheme; prebuild names it after the app, so prefer that name."""
    schemes = sorted(path.stem for path in Path(workspace).glob('xcshareddata/xcschemes/*.xcscheme'))
    if DEFAULT_SCHEME in schemes:
        return DEFAULT_SCHEME
    return schemes[0] if schemes else fallback


def pods_installed(ios_directory=IOS):
    """CocoaPods finished when the workspace and the Pods manifest both exist."""
    ios_directory = Path(ios_directory)
    if not (ios_directory / 'Pods').is_dir():
        return False
    return (ios_directory / 'Podfile.lock').exists() or (ios_directory / 'Pods/Manifest.lock').exists()


def run_command(command, capture=True):
    return subprocess.run(command, cwd=ROOT, capture_output=capture, text=True)


def prebuild():
    progress('prebuild       expo prebuild --platform ios')
    result = run_command(['pnpm', '--filter', MOBILE_PACKAGE, 'prebuild'])
    if result.returncode != 0:
        raise SystemExit(f'prebuild failed\n{result.stdout}{result.stderr}')


def install_pods():
    progress('pods           pod install')
    result = run_command(['pnpm', '--filter', MOBILE_PACKAGE, 'pods'])
    if result.returncode != 0:
        raise SystemExit(
            f'pod install failed; the Simulator build cannot proceed\n{result.stdout}{result.stderr}'
        )


def ensure_native_project(skip_pods=False):
    """prebuild + pod install as needed; the native project stays generated."""
    workspace = find_workspace()
    if workspace is None:
        prebuild()
        workspace = find_workspace()
        if workspace is None:
            raise SystemExit(f'{IOS} has no workspace after prebuild')
    if skip_pods:
        return workspace
    if not pods_installed():
        install_pods()
        if not pods_installed():
            raise SystemExit('pod install did not produce Pods; check apps/mobile/ios')
    return workspace


def xcodebuild_command(arguments, workspace):
    command = [
        'xcodebuild',
        '-workspace',
        str(workspace),
        '-scheme',
        arguments.scheme,
        '-configuration',
        arguments.configuration,
        '-sdk',
        SDK,
        '-destination',
        arguments.destination,
        '-derivedDataPath',
        str(arguments.derived_data),
    ]
    return command


def show_build_settings(command, run=subprocess.run):
    """Ask Xcode where the product is instead of guessing the path."""
    result = run([*command, '-showBuildSettings', '-json'], cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(
            result.stderr.strip() or f'xcodebuild -showBuildSettings exited {result.returncode}'
        )
    return json.loads(result.stdout)


def resolve_product(settings):
    """(app path, xcode's build directory) from a parsed -showBuildSettings document."""
    build_settings = settings[0]['buildSettings']
    app = Path(build_settings['TARGET_BUILD_DIR']) / build_settings['FULL_PRODUCT_NAME']
    return app, Path(build_settings['BUILD_DIR'])


def run_build(command, log_path):
    log_path.parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        [*command, 'build'],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    with log_path.open('w') as log:
        for line in process.stdout:
            log.write(line)
            print(line, end='', file=sys.stderr)
    process.stdout.close()
    return process.wait()


@contextmanager
def build_lock(path=None):
    """Serialize builds: one shared DerivedData cannot serve two xcodebuild runs."""
    lock_path = Path(path or (ARTIFACTS / 'verify-build.lock'))
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('w') as lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            progress('waiting for another build of this checkout')
            fcntl.flock(lock_file, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


def parse_arguments(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--configuration', default=DEFAULT_CONFIGURATION)
    parser.add_argument('--destination', default=None, help='xcodebuild destination; defaults to the lease')
    parser.add_argument(
        '--derived-data',
        default=None,
        help='Override the shared build cache; only for comparing two builds',
    )
    parser.add_argument('--scheme', default=None, help=f'Scheme to build (default {DEFAULT_SCHEME})')
    parser.add_argument('--log', default=str(DEFAULT_LOG))
    parser.add_argument('--skip-pods', action='store_true', help='Do not run pod install')
    parser.add_argument('--json', action='store_true', help='Print one JSON object instead of the app path')
    return parser.parse_args(argv)


def main(argv=None):
    arguments = parse_arguments(argv)
    arguments.destination = destination(arguments.destination)
    arguments.derived_data = Path(arguments.derived_data or DEFAULT_DERIVED_DATA).expanduser().resolve()
    workspace = ensure_native_project(skip_pods=arguments.skip_pods)
    arguments.scheme = arguments.scheme or find_scheme(workspace)
    log_path = Path(arguments.log).expanduser().resolve()
    command = xcodebuild_command(arguments, workspace)
    with build_lock():
        settings = show_build_settings(command)
        app, products = resolve_product(settings)
        progress(f'workspace      {workspace}')
        progress(f'scheme         {arguments.scheme} {arguments.configuration}')
        progress(f'destination    {arguments.destination}')
        progress(f'derived data   {arguments.derived_data}')
        progress(f'products       {products}')
        if run_build(command, log_path) != 0:
            raise SystemExit(f'build failed; see {log_path}')
    if not app.exists():
        raise SystemExit(f'{app} was not produced; see {log_path}')
    progress(f'log            {log_path}')
    if arguments.json:
        print(
            json.dumps(
                {
                    'app': str(app),
                    'derivedData': str(arguments.derived_data),
                    'log': str(log_path),
                    'configuration': arguments.configuration,
                    'destination': arguments.destination,
                }
            )
        )
    else:
        print(app)
    return 0


if __name__ == '__main__':
    sys.exit(main())
