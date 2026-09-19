#!/usr/bin/env python3
"""对一张截图做**文字断言**（OCR），失败时把屏幕上真实读到的东西说出来。

为什么需要它：`push-run.sh` 里好几条证据是"某段字在/不在屏幕上"——例如"未授权时投递
不崩"要证明**没有**横幅（屏幕上不出现通知标题），"前台由 App 自己接住"同理。断言"不
存在"时最忌只写一句 `grep` 失败：那时读者既不知道屏幕上有什么，也不知道是断言写错了
还是功能坏了。所以失败时把整屏文字打出来。

复用 `verification/ui/textdump.swift`（Vision OCR，编译产物与 UI 那一套共用），
不引入 Appium / Detox。

用法：

    python3 assert-text.py shot.png --contains 'Waiting for you' --absent 'Turn on notifications'
    python3 assert-text.py shot.png --json          # 只打印读到的文字
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
UI = HERE.parent / 'ui'
sys.path.insert(0, str(UI))

from driver import DriverError, compile_textdump  # noqa: E402


def fail(message):
    print(f'FAILED: {message}', file=sys.stderr, flush=True)
    raise SystemExit(1)


def read_text(image):
    binary = compile_textdump()
    result = subprocess.run([str(binary), str(image)], capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        fail(f'textdump failed: {result.stderr.strip() or result.returncode}')
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        fail(f'textdump printed no JSON: {error}')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('image', type=Path)
    parser.add_argument('--contains', action='append', default=[])
    parser.add_argument('--absent', action='append', default=[])
    parser.add_argument('--json', action='store_true')
    arguments = parser.parse_args(argv)

    if not arguments.image.exists():
        fail(f'{arguments.image} 不存在（上一步没截到图？）')
    payload = read_text(arguments.image)
    text = payload.get('text', '')
    if arguments.json:
        print(json.dumps({'text': text, 'image': str(arguments.image)}, ensure_ascii=False))
        return 0

    missing = [needle for needle in arguments.contains if needle.casefold() not in text.casefold()]
    present = [needle for needle in arguments.absent if needle.casefold() in text.casefold()]
    if missing or present:
        print(f'--- {arguments.image.name} 上读到的文字 ---', file=sys.stderr)
        print(text, file=sys.stderr)
        reasons = []
        if missing:
            reasons.append(f'缺少 {missing}')
        if present:
            reasons.append(f'不该出现却出现了 {present}')
        fail('；'.join(reasons))
    print(json.dumps({'image': arguments.image.name, 'contains': arguments.contains, 'absent': arguments.absent,
                      'bytes': arguments.image.stat().st_size}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
