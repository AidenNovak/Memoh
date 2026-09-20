#!/usr/bin/env python3
"""Compile and run the small Vision OCR helper used by simulator verification."""

import argparse
import os
import platform
import subprocess
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent
SOURCE = HERE / 'textdump.swift'
BINARY = HERE.parent / '.artifacts' / 'textdump'


def fail(message, code=1):
    print(f'textdump: {message}', file=sys.stderr, flush=True)
    raise SystemExit(code)


def compile_if_needed():
    if platform.system() != 'Darwin':
        fail('Vision OCR requires macOS', 2)
    if BINARY.exists() and BINARY.stat().st_mtime_ns >= SOURCE.stat().st_mtime_ns:
        return

    BINARY.parent.mkdir(parents=True, exist_ok=True)
    temporary = BINARY.with_name(f'{BINARY.name}.{os.getpid()}.tmp')
    try:
        result = subprocess.run(
            ['xcrun', 'swiftc', '-O', str(SOURCE), '-o', str(temporary)],
            capture_output=True,
            text=True,
            timeout=180,
        )
        if result.returncode != 0:
            fail(f'compile failed: {result.stderr.strip() or result.returncode}')
        temporary.replace(BINARY)
    finally:
        temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', nargs='?', type=Path)
    parser.add_argument('--self-test', action='store_true')
    arguments = parser.parse_args(argv)
    if arguments.self_test == (arguments.image is not None):
        parser.error('pass exactly one image or --self-test')

    compile_if_needed()
    command = [str(BINARY), '--self-test'] if arguments.self_test else [str(BINARY), str(arguments.image)]
    result = subprocess.run(command, timeout=120)
    return result.returncode


if __name__ == '__main__':
    sys.exit(main())
