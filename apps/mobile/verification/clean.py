#!/usr/bin/env python3
"""Reclaim what verification leaves behind.

Three kinds of scratch accumulate:

* a stray Xcode build cache or a copied checkout in the temp directory (a
  per-task ``-derivedDataPath`` costs gigabytes; ``pnpm verify:build`` shares one
  cache so nothing else is needed),
* a managed ``Memoh * Verify`` Simulator that no run is using any more,
* loose build/result scratch under ``verification/.artifacts``.

    pnpm verify:clean                        # what would be removed
    pnpm verify:clean --apply                # remove scratch idle for 12h+
    pnpm verify:clean --apply --older-than 0 # everything reported

Only directories this project can prove are verification scratch are reported:
a directory is never removed because it merely looks old.
"""
import argparse
import os
from pathlib import Path
import shutil
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from simulator import SimulatorPool, device_data_path  # noqa: E402

DERIVED_DATA_MARKERS = ('ModuleCache.noindex', 'SDKStatCaches.noindex')
PROJECT_PREFIXES = ('memoh-', 'expo-')
ARTIFACTS = HERE / '.artifacts'


def default_roots():
    roots = [Path('/tmp')]
    tmpdir = os.environ.get('TMPDIR')
    if tmpdir:
        roots.append(Path(tmpdir))
    unique = []
    for root in roots:
        resolved = root.resolve()
        if resolved.is_dir() and resolved not in unique:
            unique.append(resolved)
    return unique


def is_scratch(path):
    """True only for an Xcode build cache or a staged copy of this checkout."""
    path = Path(path)
    if path.is_symlink() or not path.is_dir():
        return False
    if (path / 'Build' / 'Products').is_dir():
        return True
    if all((path / marker).is_dir() for marker in DERIVED_DATA_MARKERS):
        return True
    return path.name.startswith(PROJECT_PREFIXES) and (path / 'apps/mobile').is_dir()


def directory_size(path):
    total = 0
    for entry in Path(path).rglob('*'):
        try:
            if entry.is_file() and not entry.is_symlink():
                total += entry.stat().st_size
        except OSError:
            continue
    return total


def human_size(size):
    if size >= 1024**3:
        return f'{size / 1024**3:6.2f} GB'
    return f'{size / 1024**2:6.1f} MB'


def age_hours(path):
    try:
        return (time.time() - Path(path).stat().st_mtime) / 3600
    except OSError:
        return 0.0


def collect(roots, older_than_hours, minimum_bytes):
    cutoff = time.time() - older_than_hours * 3600
    found = []
    for root in roots:
        root = Path(root)
        if not root.is_dir():
            continue
        for entry in sorted(root.iterdir()):
            try:
                if not is_scratch(entry) or entry.stat().st_mtime > cutoff:
                    continue
                size = directory_size(entry)
            except OSError:
                continue
            if size >= minimum_bytes:
                found.append((entry, size, entry.stat().st_mtime))
    return found


def collect_artifact_scratch(artifacts=ARTIFACTS, older_than_hours=12.0):
    """Loose build caches under verification/.artifacts, never the shared one."""
    artifacts = Path(artifacts)
    if not artifacts.is_dir():
        return []
    cutoff = time.time() - older_than_hours * 3600
    found = []
    for entry in sorted(artifacts.iterdir()):
        if entry.name in ('derived-data', 'verify-build.lock') or entry.is_symlink():
            continue
        if not entry.is_dir() or not is_scratch(entry):
            continue
        try:
            if entry.stat().st_mtime > cutoff:
                continue
        except OSError:
            continue
        found.append(entry)
    return found


def collect_simulators(pool, older_than_hours):
    """Managed devices nothing is using; age comes from the device store."""
    idle = []
    for entry in pool.report():
        if entry['locked']:
            continue
        hours = age_hours(device_data_path(entry['udid']))
        if hours < older_than_hours:
            continue
        idle.append((entry, hours))
    return idle


def parse_arguments(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--root', action='append', default=None, help='Temp root to scan; repeatable')
    parser.add_argument(
        '--older-than',
        type=float,
        default=12.0,
        metavar='HOURS',
        help='Skip anything touched more recently than this (default 12)',
    )
    parser.add_argument('--min-size', type=float, default=0.0, metavar='MB', help='Skip entries smaller than this')
    parser.add_argument('--simulators', action='store_true', help='Also report idle managed Simulators')
    parser.add_argument('--only', choices=['directories', 'simulators'], default='directories')
    parser.add_argument('--apply', action='store_true', help='Delete what the report lists')
    return parser.parse_args(argv)


def main(argv=None):
    arguments = parse_arguments(argv)
    plan = []
    if arguments.only != 'simulators':
        roots = [Path(root).expanduser().resolve() for root in arguments.root] if arguments.root else default_roots()
        for path, size, modified in collect(roots, arguments.older_than, arguments.min_size * 1024 * 1024):
            plan.append(('directory', path, size, (time.time() - modified) / 3600))
        for path in collect_artifact_scratch(ARTIFACTS, arguments.older_than):
            plan.append(('directory', path, directory_size(path), age_hours(path)))
    simulators = []
    if arguments.only == 'simulators' or arguments.simulators:
        simulators = collect_simulators(SimulatorPool(), arguments.older_than)
    if not plan and not simulators:
        print('no verification scratch to reclaim')
        return 0
    if arguments.only == 'simulators' and not simulators:
        print('no idle managed Simulator to reclaim')
        return 0
    plan.sort(key=lambda entry: entry[2], reverse=True)
    total = sum(size for _, _, size, _ in plan)
    verb = 'Removing' if arguments.apply else 'Would remove'
    print(f'{verb} {len(plan)} directories, {total / 1024**3:.2f} GB, and {len(simulators)} Simulators:')
    for kind, path, size, age in plan:
        print(f'  {human_size(size)}  {age:5.1f}h  {path}')
    for entry, hours in simulators:
        print(f'  {"simulator":>9}  {hours:5.1f}h  {entry["udid"]}  {entry["name"]} ({entry["state"]})')
    if not arguments.apply:
        print('Pass --apply to delete these entries.')
        return 0
    released = 0
    for _, path, size, _ in plan:
        try:
            shutil.rmtree(path)
        except OSError as error:
            print(f'failed to remove {path}: {error}', file=sys.stderr)
            continue
        released += size
    pool = SimulatorPool()
    for entry, _ in simulators:
        try:
            pool.simctl('delete', entry['udid'])
            pool.marker(entry['udid']).unlink(missing_ok=True)
        except Exception as error:  # simctl failures must not hide the directory report
            print(f'failed to delete {entry["udid"]}: {error}', file=sys.stderr)
    print(f'released {released / 1024**3:.2f} GB and {len(simulators)} Simulators')
    return 0


if __name__ == '__main__':
    sys.exit(main())
