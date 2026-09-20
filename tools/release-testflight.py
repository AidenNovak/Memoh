#!/usr/bin/env python3
"""Archive, sign and optionally upload the iOS app to TestFlight.

The command is deliberately explicit about the external write: without
``--upload`` it stops after producing and verifying a signed IPA. Credentials
come only from ASC_KEY_PATH / ASC_KEY_ID / ASC_ISSUER_ID.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import plistlib
import secrets
import shlex
import subprocess
import sys
import time
import zipfile
from contextlib import contextmanager
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MOBILE = ROOT / 'apps/mobile'
IOS = MOBILE / 'ios'
ASC = ROOT / 'tools/asc-api.py'
TEAM_ID = '7533A52C52'
BUNDLE_ID = 'ai.memoh.ios'
PROFILE = 'Memoh iOS App Store (mini)'
SCHEME = 'Memoh'
SIGNING_HOME = Path.home() / '.memoh-signing'


def fail(message: str) -> None:
    raise SystemExit(message)


def run(command: list[str], *, cwd: Path = ROOT, env=None, log: Path | None = None) -> None:
    print('+', ' '.join(command[:6]), '…' if len(command) > 6 else '', file=sys.stderr)
    if log is None:
        result = subprocess.run(command, cwd=cwd, env=env)
    else:
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open('w') as output:
            result = subprocess.run(command, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode != 0:
        suffix = f'; see {log}' if log else ''
        fail(f'{command[0]} exited {result.returncode}{suffix}')


def capture(command: list[str], *, cwd: Path = ROOT) -> str:
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        fail(result.stderr.strip() or f'{command[0]} exited {result.returncode}')
    return result.stdout.strip()


def asc_credentials(environ=None) -> tuple[str, str, str]:
    environ = os.environ if environ is None else environ
    missing = [name for name in ('ASC_KEY_PATH', 'ASC_KEY_ID', 'ASC_ISSUER_ID') if not environ.get(name)]
    if missing:
        fail('missing App Store Connect environment: ' + ', '.join(missing))
    key_path = str(Path(environ['ASC_KEY_PATH']).expanduser().resolve())
    if not Path(key_path).is_file():
        fail(f'ASC_KEY_PATH does not exist: {key_path}')
    return key_path, environ['ASC_KEY_ID'], environ['ASC_ISSUER_ID']


def auth_arguments(credentials: tuple[str, str, str]) -> list[str]:
    key_path, key_id, issuer_id = credentials
    return [
        '-allowProvisioningUpdates',
        '-authenticationKeyPath', key_path,
        '-authenticationKeyID', key_id,
        '-authenticationKeyIssuerID', issuer_id,
    ]


def verify_distribution_material() -> Path:
    for required in ('dist.key', 'dist.cert.pem', 'memoh-signing.keychain-db'):
        if not (SIGNING_HOME / required).is_file():
            fail(f'missing local signing material: {SIGNING_HOME / required}')
    profiles = Path.home() / 'Library/MobileDevice/Provisioning Profiles'
    for profile in profiles.glob('*.mobileprovision'):
        decoded = subprocess.run(
            ['security', 'cms', '-D', '-i', str(profile)], capture_output=True
        )
        if decoded.returncode != 0:
            continue
        payload = plistlib.loads(decoded.stdout)
        if payload.get('Name') != PROFILE:
            continue
        expiration = payload.get('ExpirationDate')
        entitlements = payload.get('Entitlements', {})
        valid = (
            isinstance(expiration, dt.datetime)
            and expiration > dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
            and payload.get('TeamIdentifier') == [TEAM_ID]
            and entitlements.get('application-identifier') == f'{TEAM_ID}.{BUNDLE_ID}'
            and entitlements.get('aps-environment') == 'production'
            and entitlements.get('com.apple.developer.usernotifications.time-sensitive') is True
            and entitlements.get('get-task-allow') is False
        )
        if valid:
            return profile
        fail(f'installed profile {PROFILE!r} has invalid team, app, expiry or entitlements')
    fail(f'installed provisioning profile not found: {PROFILE}')


def checked(command: list[str], *, env=None, stdout=None) -> subprocess.CompletedProcess:
    result = subprocess.run(command, cwd=ROOT, env=env, stdout=stdout, capture_output=stdout is None)
    if result.returncode != 0:
        error = result.stderr.decode(errors='replace').strip() if result.stderr else ''
        fail(error or f'{command[0]} exited {result.returncode}')
    return result


@contextmanager
def ephemeral_signing_keychain(artifacts: Path):
    """Import the loose key into a fresh keychain; the old keychain password is irrelevant."""
    keychain = artifacts / 'release-signing.keychain-db'
    identity = artifacts / '.release-identity.p12'
    intermediates = artifacts / '.wwdr.pem'
    keychain_password = secrets.token_hex(24)
    identity_password = secrets.token_hex(24)
    old_search = shlex.split(capture(['security', 'list-keychains', '-d', 'user']))
    try:
        checked(['security', 'create-keychain', '-p', keychain_password, str(keychain)])
        checked(['security', 'set-keychain-settings', '-lut', '21600', str(keychain)])
        checked(['security', 'unlock-keychain', '-p', keychain_password, str(keychain)])
        p12_env = os.environ.copy()
        p12_env['MEMOH_RELEASE_P12_PASSWORD'] = identity_password
        checked([
            'openssl', 'pkcs12', '-export', '-inkey', str(SIGNING_HOME / 'dist.key'),
            '-in', str(SIGNING_HOME / 'dist.cert.pem'), '-out', str(identity),
            '-passout', 'env:MEMOH_RELEASE_P12_PASSWORD',
        ], env=p12_env)
        checked([
            'security', 'import', str(identity), '-k', str(keychain), '-P', identity_password,
            '-T', '/usr/bin/codesign', '-T', '/usr/bin/security',
        ])
        with intermediates.open('wb') as output:
            checked([
                'security', 'find-certificate', '-a',
                '-c', 'Apple Worldwide Developer Relations Certification Authority',
                '-p', str(SIGNING_HOME / 'memoh-signing.keychain-db'),
            ], stdout=output)
        checked(['security', 'import', str(intermediates), '-k', str(keychain), '-T', '/usr/bin/codesign'])
        checked([
            'security', 'set-key-partition-list', '-S', 'apple-tool:,apple:',
            '-s', '-k', keychain_password, str(keychain),
        ])
        checked(['security', 'list-keychains', '-d', 'user', '-s', str(keychain), *old_search])
        identities = capture(['security', 'find-identity', '-v', '-p', 'codesigning', str(keychain)])
        if TEAM_ID not in identities or 'Distribution:' not in identities:
            fail(f'ephemeral keychain has no valid distribution identity for team {TEAM_ID}')
        yield keychain
    finally:
        if old_search:
            subprocess.run(
                ['security', 'list-keychains', '-d', 'user', '-s', *old_search],
                cwd=ROOT,
                capture_output=True,
            )
        if keychain.exists():
            subprocess.run(['security', 'delete-keychain', str(keychain)], cwd=ROOT, capture_output=True)
        for temporary in (identity, intermediates):
            temporary.unlink(missing_ok=True)


def next_build_number() -> int:
    raw = capture([sys.executable, str(ASC), 'next-build'])
    if not raw.isdigit() or int(raw) < 1:
        fail(f'ASC returned an invalid next build number: {raw!r}')
    return int(raw)


def clean_head() -> str:
    dirty = capture(['git', 'status', '--porcelain', '--untracked-files=no'])
    if dirty:
        fail('tracked worktree is dirty; commit or stash before making a release')
    return capture(['git', 'rev-parse', 'HEAD'])


def export_options(destination: str) -> dict:
    if destination not in ('export', 'upload'):
        raise ValueError(f'unsupported destination {destination!r}')
    return {
        'destination': destination,
        'manageAppVersionAndBuildNumber': False,
        'method': 'app-store-connect',
        'provisioningProfiles': {BUNDLE_ID: PROFILE},
        'signingStyle': 'manual',
        'teamID': TEAM_ID,
        'uploadSymbols': True,
    }


def write_plist(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('wb') as output:
        plistlib.dump(value, output, sort_keys=True)


def archive_metadata(archive: Path) -> dict[str, str]:
    archive_info = plistlib.loads((archive / 'Info.plist').read_bytes())
    app = next((archive / 'Products/Applications').glob('*.app'), None)
    if app is None:
        fail(f'{archive} does not contain an application')
    app_info = plistlib.loads((app / 'Info.plist').read_bytes())
    properties = archive_info.get('ApplicationProperties', {})
    return {
        'bundle': str(app_info.get('CFBundleIdentifier', '')),
        'version': str(app_info.get('CFBundleShortVersionString', '')),
        'build': str(app_info.get('CFBundleVersion', '')),
        'archive_build': str(properties.get('CFBundleVersion', '')),
    }


def verify_archive(archive: Path, build_number: int) -> dict[str, str]:
    metadata = archive_metadata(archive)
    if metadata['bundle'] != BUNDLE_ID:
        fail(f"archive bundle is {metadata['bundle']!r}, expected {BUNDLE_ID!r}")
    expected = str(build_number)
    if metadata['build'] != expected or metadata['archive_build'] != expected:
        fail(f'archive build numbers do not both equal {expected}: {metadata}')
    return metadata


def ipa_metadata(ipa: Path) -> dict[str, str]:
    with zipfile.ZipFile(ipa) as bundle:
        candidates = [name for name in bundle.namelist() if name.startswith('Payload/') and name.endswith('.app/Info.plist')]
        if len(candidates) != 1:
            fail(f'{ipa} contains {len(candidates)} application Info.plists')
        info = plistlib.loads(bundle.read(candidates[0]))
    return {
        'bundle': str(info.get('CFBundleIdentifier', '')),
        'version': str(info.get('CFBundleShortVersionString', '')),
        'build': str(info.get('CFBundleVersion', '')),
    }


def verify_signed_ipa(ipa: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    with zipfile.ZipFile(ipa) as bundle:
        bundle.extractall(destination)
    apps = list((destination / 'Payload').glob('*.app'))
    if len(apps) != 1:
        fail(f'{ipa} extracted {len(apps)} applications')
    result = subprocess.run(
        ['codesign', '--verify', '--deep', '--strict', '--verbose=2', str(apps[0])],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        fail(result.stderr.strip() or 'codesign verification failed')
    details = subprocess.run(
        ['codesign', '-dvv', str(apps[0])], capture_output=True, text=True, check=True
    ).stderr
    if f'TeamIdentifier={TEAM_ID}' not in details or 'Authority=' not in details:
        fail('signed IPA does not carry the expected distribution team and authority')
    entitlements_result = subprocess.run(
        ['codesign', '-d', '--entitlements', ':-', str(apps[0])],
        capture_output=True,
    )
    if entitlements_result.returncode != 0:
        fail('could not read signed IPA entitlements')
    entitlements = plistlib.loads(entitlements_result.stdout)
    if entitlements.get('aps-environment') != 'production':
        fail('signed IPA is missing the production APNs entitlement')
    if entitlements.get('com.apple.developer.usernotifications.time-sensitive') is not True:
        fail('signed IPA is missing the Time Sensitive Notifications entitlement')


def wait_for_valid_build(build_number: int, timeout: int) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        output = capture([sys.executable, str(ASC), 'builds'])
        target = next((line for line in output.splitlines() if line.startswith(f'构建号={build_number} ')), '')
        if '状态=VALID ' in target:
            return
        if target and '状态=PROCESSING ' not in target:
            fail(f'App Store Connect rejected build {build_number}: {target}')
        print(f'waiting for App Store Connect to process build {build_number}', file=sys.stderr)
        time.sleep(30)
    fail(f'build {build_number} did not become VALID within {timeout} seconds')


@contextmanager
def release_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail('another TestFlight release is already running')
        yield


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-number', type=int, help='default: query ASC max + 1')
    parser.add_argument('--artifact-dir', help='default: .verify/testflight-build-<number>-<sha>')
    parser.add_argument('--upload', action='store_true', help='upload and attach the VALID build to the internal group')
    parser.add_argument('--processing-timeout', type=int, default=1800)
    return parser.parse_args(argv)


def main(argv=None) -> int:
    arguments = parse_arguments(argv)
    credentials = asc_credentials()
    verify_distribution_material()
    head = clean_head()
    build_number = arguments.build_number or next_build_number()
    if build_number < 1:
        fail('build number must be positive')
    artifacts = Path(arguments.artifact_dir or ROOT / '.verify' / f'testflight-build-{build_number}-{head[:9]}').resolve()
    if artifacts.exists():
        fail(f'artifact directory already exists: {artifacts}')
    archive = artifacts / 'Memoh.xcarchive'
    derived_data = artifacts / 'DerivedData'

    with release_lock(ROOT / '.verify/testflight-release.lock'):
        env = os.environ.copy()
        env['MEMOH_BUILD_NUMBER'] = str(build_number)
        run(['pnpm', 'ios:prebuild'], env=env, log=artifacts / 'prebuild.log')
        run(['pnpm', 'ios:pods'], log=artifacts / 'pods.log')
        workspace = IOS / 'Memoh.xcworkspace'
        with ephemeral_signing_keychain(artifacts) as keychain:
            run([
                'xcodebuild', 'archive', '-workspace', str(workspace), '-scheme', SCHEME,
                '-configuration', 'Release', '-destination', 'generic/platform=iOS',
                '-archivePath', str(archive), '-derivedDataPath', str(derived_data),
                *auth_arguments(credentials), 'CODE_SIGN_STYLE=Manual', f'DEVELOPMENT_TEAM={TEAM_ID}',
                'CODE_SIGN_IDENTITY=iPhone Distribution', f'PROVISIONING_PROFILE_SPECIFIER={PROFILE}',
                f'OTHER_CODE_SIGN_FLAGS=--keychain {keychain}',
            ], log=artifacts / 'archive.log')
            metadata = verify_archive(archive, build_number)

            export_plist = artifacts / 'ExportOptions.plist'
            write_plist(export_plist, export_options('export'))
            export_dir = artifacts / 'export'
            run([
                'xcodebuild', '-exportArchive', '-archivePath', str(archive),
                '-exportPath', str(export_dir), '-exportOptionsPlist', str(export_plist),
                *auth_arguments(credentials),
            ], log=artifacts / 'export.log')
            ipas = list(export_dir.glob('*.ipa'))
            if len(ipas) != 1:
                fail(f'expected one IPA in {export_dir}, found {len(ipas)}')
            ipa = ipas[0]
            packaged = ipa_metadata(ipa)
            if packaged['bundle'] != BUNDLE_ID or packaged['build'] != str(build_number):
                fail(f'IPA metadata does not match the release: {packaged}')
            verify_signed_ipa(ipa, artifacts / 'ipa-inspect')

            if arguments.upload:
                upload_plist = artifacts / 'UploadOptions.plist'
                write_plist(upload_plist, export_options('upload'))
                run([
                    'xcodebuild', '-exportArchive', '-archivePath', str(archive),
                    '-exportPath', str(artifacts / 'upload'), '-exportOptionsPlist', str(upload_plist),
                    *auth_arguments(credentials),
                ], log=artifacts / 'upload.log')
                wait_for_valid_build(build_number, arguments.processing_timeout)
                run([sys.executable, str(ASC), 'distribute', str(build_number)], log=artifacts / 'distribute.log')

    print(json.dumps({
        'head': head,
        'build': build_number,
        'version': metadata['version'],
        'ipa': str(ipa),
        'uploaded': arguments.upload,
        'artifacts': str(artifacts),
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
