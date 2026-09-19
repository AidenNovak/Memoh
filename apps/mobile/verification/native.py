#!/usr/bin/env python3
"""Run native behavior checks for the Swift side, without cloud or credentials.

    pnpm verify:native                     # lease a Simulator and run every check
    pnpm verify:native --case kit-loads
    pnpm verify:native --list

A check compiles production Swift sources plus its own ``main.swift`` harness for
``arm64-apple-ios<deployment>-simulator`` and runs the binary inside the leased
Simulator with ``simctl spawn``. It asserts behavior, not implementation
snapshots: no pixel comparison, no private API, no network.

``simulator-toolchain`` is the prerequisite check every other one depends on: it
proves this machine can compile and run iOS Simulator Swift at the app's
deployment target. ``kit-loads`` compiles the ``memoh-kit`` Swift sources and
asserts the module entry point is linked; until that module has Swift sources it
reports ``skipped`` (a skip is not a pass).
"""
import argparse
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
KIT = ROOT / 'apps/mobile/modules/memoh-kit'
NATIVE = HERE / 'native'
DEPLOYMENT_TARGET = '26.0'
ENVIRONMENT_VARIABLE = 'MEMOH_VERIFY_UDID'

sys.path.insert(0, str(HERE))
from simulator import DEVICE_TYPES, SimulatorPool, run_with_simulator  # noqa: E402

# A check is: extra production sources to compile (globs, relative to the kit),
# its harness, and whether it must run inside the Simulator.
CHECKS = {
    'simulator-toolchain': {
        'description': 'iOS Simulator Swift toolchain, SDK and deployment target',
        'sources': [],
        'entry': NATIVE / 'simulator-toolchain' / 'main.swift',
        'simulator': True,
    },
    'kit-loads': {
        'description': 'memoh-kit Swift sources compile and the module entry point links',
        'sources': ['ios/**/*.swift'],
        'entry': NATIVE / 'kit-loads' / 'main.swift',
        'simulator': True,
    },
}


def expand_sources(check):
    """Every existing source file the check asked for; missing globs are not fatal."""
    files = []
    for pattern in check['sources']:
        files.extend(sorted(KIT.glob(pattern)))
    return [path for path in files if path.is_file()]


def simulator_sdk():
    return subprocess.check_output(
        ['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'], text=True
    ).strip()


def swiftc_command(check, sources, binary, sdk=None):
    architecture = 'arm64' if platform.machine() == 'arm64' else 'x86_64'
    target = f'{architecture}-apple-ios{DEPLOYMENT_TARGET}-simulator'
    command = ['xcrun', '--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '6', '-O']
    if check['simulator']:
        command += ['-sdk', sdk or simulator_sdk(), '-target', target]
    command += [str(path) for path in sources]
    command += [str(check['entry']), '-o', str(binary)]
    return command


def compile_check(check, sources, binary, run=subprocess.run):
    run(swiftc_command(check, sources, binary), check=True, timeout=600)


def run_check(check, sources, udid, timeout=300):
    """Compile, then run the binary (in the Simulator when it needs UIKit)."""
    with tempfile.TemporaryDirectory(prefix='memoh-native-verify-') as output:
        binary = Path(output) / 'check'
        compile_check(check, sources, binary)
        command = ['xcrun', 'simctl', 'spawn', udid, str(binary)] if check['simulator'] else [str(binary)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    return result


def external_dependency(sources):
    """返回让这些源码无法独立编译的外部模块名，没有则返回 None。

    只认 Expo 模块：UIKit/Foundation/SwiftUI 都是 SDK 自带的，独立编译没问题；
    `ExpoModulesCore` / `ExpoModulesJSI` 之类只存在于 Pods，不在 SDK 里。
    """
    pattern = re.compile(r'^\s*import\s+(Expo[A-Za-z0-9_]*)', re.MULTILINE)
    for source in sources:
        text = source.read_text(encoding='utf-8', errors='replace')
        match = pattern.search(text)
        if match:
            return match.group(1)
    return None


def select_checks(name):
    if name is None:
        return dict(CHECKS)
    if name not in CHECKS:
        raise SystemExit(f'unknown check {name!r}; choose from {", ".join(CHECKS)}')
    return {name: CHECKS[name]}


def run_all(checks, udid, stream=sys.stdout):
    report = []
    failed = False
    for name, check in checks.items():
        sources = expand_sources(check)
        if check['sources'] and not sources:
            entry = {
                'check': name,
                'status': 'skipped',
                'reason': f'no Swift sources matched {check["sources"]} under {KIT}',
            }
            report.append(entry)
            print(json.dumps(entry), file=stream, flush=True)
            continue

        # 有些源码依赖 Expo 模块的框架，脱离 Pods 的独立编译不可能成功。
        # 这类不是"检查失败"，而是"这个检查方式不适用于它"——报 skipped 并说清
        # 真正的验证在哪，比伪造一个 pass 或报一个看不懂的编译错误都诚实。
        blocker = external_dependency(sources)
        if blocker is not None:
            entry = {
                'check': name,
                'status': 'skipped',
                'reason': (
                    f'{blocker} 需要 Expo 框架才能编译，独立 swiftc 无法解析；'
                    '它的真实验证在 `pnpm verify:build`（完整 Xcode 构建会编到这些源码）'
                ),
            }
            report.append(entry)
            print(json.dumps(entry), file=stream, flush=True)
            continue

        started = time.monotonic()
        try:
            result = run_check(check, sources, udid)
        except subprocess.TimeoutExpired:
            entry = {'check': name, 'status': 'failed', 'reason': 'check timed out'}
            failed = True
        except subprocess.CalledProcessError as error:
            tail = error.stderr if isinstance(error.stderr, str) else ''
            entry = {'check': name, 'status': 'failed', 'reason': f'swiftc failed: {tail.strip()[-400:]}'}
            failed = True
        else:
            output = (result.stdout or '') + (result.stderr or '')
            if result.returncode != 0:
                entry = {
                    'check': name,
                    'status': 'failed',
                    'reason': output.strip()[-400:] or f'exit {result.returncode}',
                }
                failed = True
            else:
                entry = {
                    'check': name,
                    'status': 'passed',
                    'sources': len(sources),
                    'output': output.strip()[-400:],
                }
        entry['seconds'] = round(time.monotonic() - started, 2)
        report.append(entry)
        print(json.dumps(entry), file=stream, flush=True)
    # A skip is not a pass: it is reported, but only a failure fails the run.
    return 1 if failed else 0


def parse_arguments(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--case', help='Run one named check instead of all of them')
    parser.add_argument('--list', action='store_true', help='List checks and exit')
    parser.add_argument('--udid', default=os.environ.get(ENVIRONMENT_VARIABLE) or None,
                        help=f'Existing Simulator; omit to lease one ({ENVIRONMENT_VARIABLE} is read too)')
    return parser.parse_args(argv)


def main(argv=None):
    arguments = parse_arguments(argv)
    if arguments.list:
        for name, check in CHECKS.items():
            print(f'{name}\t{check["description"]}')
        return 0
    checks = select_checks(arguments.case)
    if arguments.udid is None:
        command = [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]]
        return run_with_simulator(SimulatorPool(device_type=DEVICE_TYPES['iphone']), 'Native', command)
    return run_all(checks, arguments.udid)


if __name__ == '__main__':
    sys.exit(main())


def select_checks(name):
    if name is None:
        return dict(CHECKS)
    if name not in CHECKS:
        raise SystemExit(f'unknown check {name!r}; choose from {", ".join(CHECKS)}')
    return {name: CHECKS[name]}


def run_all(checks, udid, stream=sys.stdout):
    report = []
    failed = False
    for name, check in checks.items():
        sources = expand_sources(check)
        if check['sources'] and not sources:
            entry = {
                'check': name,
                'status': 'skipped',
                'reason': f'no Swift sources matched {check["sources"]} under {KIT}',
            }
            report.append(entry)
            print(json.dumps(entry), file=stream, flush=True)
            continue

        # 有些源码依赖 Expo 模块的框架，脱离 Pods 的独立编译不可能成功。
        # 这类不是"检查失败"，而是"这个检查方式不适用于它"——报 skipped 并说清
        # 真正的验证在哪，比伪造一个 pass 或报一个看不懂的编译错误都诚实。
        blocker = external_dependency(sources)
        if blocker is not None:
            entry = {
                'check': name,
                'status': 'skipped',
                'reason': (
                    f'{blocker} 需要 Expo 框架才能编译，独立 swiftc 无法解析；'
                    '它的真实验证在 `pnpm verify:build`（完整 Xcode 构建会编到这些源码）'
                ),
            }
            report.append(entry)
            print(json.dumps(entry), file=stream, flush=True)
            continue

        started = time.monotonic()
        try:
            result = run_check(check, sources, udid)
        except subprocess.TimeoutExpired:
            entry = {'check': name, 'status': 'failed', 'reason': 'check timed out'}
            failed = True
        except subprocess.CalledProcessError as error:
            tail = error.stderr if isinstance(error.stderr, str) else ''
            entry = {'check': name, 'status': 'failed', 'reason': f'swiftc failed: {tail.strip()[-400:]}'}
            failed = True
        else:
            output = (result.stdout or '') + (result.stderr or '')
            if result.returncode != 0:
                entry = {
                    'check': name,
                    'status': 'failed',
                    'reason': output.strip()[-400:] or f'exit {result.returncode}',
                }
                failed = True
            else:
                entry = {
                    'check': name,
                    'status': 'passed',
                    'sources': len(sources),
                    'output': output.strip()[-400:],
                }
        entry['seconds'] = round(time.monotonic() - started, 2)
        report.append(entry)
        print(json.dumps(entry), file=stream, flush=True)
    # A skip is not a pass: it is reported, but only a failure fails the run.
    return 1 if failed else 0


def parse_arguments(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--case', help='Run one named check instead of all of them')
    parser.add_argument('--list', action='store_true', help='List checks and exit')
    parser.add_argument('--udid', default=os.environ.get(ENVIRONMENT_VARIABLE) or None,
                        help=f'Existing Simulator; omit to lease one ({ENVIRONMENT_VARIABLE} is read too)')
    return parser.parse_args(argv)


def main(argv=None):
    arguments = parse_arguments(argv)
    if arguments.list:
        for name, check in CHECKS.items():
            print(f'{name}\t{check["description"]}')
        return 0
    checks = select_checks(arguments.case)
    if arguments.udid is None:
        command = [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]]
        return run_with_simulator(SimulatorPool(device_type=DEVICE_TYPES['iphone']), 'Native', command)
    return run_all(checks, arguments.udid)


if __name__ == '__main__':
    sys.exit(main())
