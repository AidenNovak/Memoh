#!/usr/bin/env python3
"""在 TOML 里按 section 精确写入字符串键值，保留注释与格式。

用法:
  set-config.py <config.toml> <section> <key> <value> [<section> <key> <value> ...]

只做「在指定 section 内替换或追加一个 key = "value"」这一件事，
不引入 toml 依赖，也不整篇重写文件。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SECTION_RE = re.compile(r"^\s*\[([^\]]+)\]\s*(?:#.*)?$")


def set_key(lines: list[str], section: str, key: str, value: str) -> list[str]:
    start = None
    for i, line in enumerate(lines):
        m = SECTION_RE.match(line)
        if m and m.group(1).strip() == section:
            start = i
            break
    if start is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(f"[{section}]")
        lines.append(f'{key} = "{value}"')
        return lines

    end = len(lines)
    for i in range(start + 1, len(lines)):
        if SECTION_RE.match(lines[i]):
            end = i
            break

    key_re = re.compile(r"^(\s*)" + re.escape(key) + r"\s*=")
    for i in range(start + 1, end):
        if key_re.match(lines[i]):
            indent = key_re.match(lines[i]).group(1)  # type: ignore[union-attr]
            lines[i] = f'{indent}{key} = "{value}"'
            return lines

    lines.insert(end, f'{key} = "{value}"')
    return lines


def main(argv: list[str]) -> int:
    if len(argv) < 5 or (len(argv) - 2) % 3 != 0:
        print(__doc__, file=sys.stderr)
        return 2

    path = Path(argv[1])
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    for i in range(2, len(argv), 3):
        section, key, value = argv[i], argv[i + 1], argv[i + 2]
        lines = set_key(lines, section, key, value)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
