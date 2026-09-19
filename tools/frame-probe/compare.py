#!/usr/bin/env python3
"""把两轮（或更多轮）尺子结果放在一起比：负载可比吗、掉帧差多少、几何判据谁红了。

## 为什么必须比而不看绝对值

本机被多个 agent 同时压着，1 分钟 load 常在 400 上下。绝对掉帧数在这个环境下
**不归因于实现**——同一份代码在安静窗口与满载窗口能差一个数量级。所以：

- **配对**：要断言"改前 vs 改后"，两轮必须**挨着跑**（同一个负载窗口内），
  且两份结果里 `load1_median` 相差 ≤ `LOAD_RATIO_LIMIT` 才算可比；
- **相对判据**：场景的掉帧率不直接与阈值比，而是与**同一负载窗口内的对照**
  （噪声地板或改前那一版）比：`rate_scene <= rate_control * K + FLOOR`；
- 不可比就写 `comparable: false`，**不当结论用**。

## 用法

    python3 tools/frame-probe/compare.py before/result.json after/result.json
    python3 tools/frame-probe/compare.py --control floor/result.json stream/result.json
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

# 负载可比的门槛：两轮 load1 中位数相差超过这个倍数，就不下"谁更快"的结论。
LOAD_RATIO_LIMIT = 1.5

# 相对判据：`rate(A) <= rate(control) * K + FLOOR`。
# K 给 2 是承认"同一份代码两次跑也会有波动"；FLOOR 给 0.2%（1000 帧里 2 帧）是
# 让"两轮都是 0"和"一个是 0 一个不是"能区分开。**这两个数不许为了变绿而放大。**
HITCH_RATE_K = 2.0
HITCH_RATE_FLOOR = 0.002


def load(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def comparable(first: dict, second: dict) -> tuple[bool, str]:
    a = first['load'].get('load1_median')
    b = second['load'].get('load1_median')
    if a is None or b is None or min(a, b) <= 0:
        return False, 'load1 缺失'
    ratio = max(a, b) / min(a, b)
    if ratio > LOAD_RATIO_LIMIT:
        return False, f'load1 中位相差 {ratio:.2f} 倍（>{LOAD_RATIO_LIMIT}）'
    return True, f'load1 中位相差 {ratio:.2f} 倍'


def row(result: dict) -> dict:
    during = result.get('during_stream', {})
    return {
        'label': result['label'],
        'scenario': result.get('scenario'),
        'stall_ms': result.get('stall_ms'),
        # 变更集合走的是哪一条路：同一个二进制里用 `--deep-compare` 切（改前/改后的配对）。
        # 老结果里没有这个字段（那一版还没有对照开关），打 `—` 而不是假装走的是哈希。
        'deep': '深比较' if result.get('deep_compare')
                else ('哈希' if 'deep_compare' in result else '—'),
        'load1': result['load'].get('load1_median'),
        'frames': during.get('frames'),
        'nominal_ms': during.get('nominal_ms'),
        'p95_ms': (during.get('dt_ms') or {}).get('p95'),
        'max_ms': (during.get('dt_ms') or {}).get('max'),
        'hitches': during.get('hitches'),
        'rate': during.get('hitch_rate'),
        'dropped': during.get('dropped_frames'),
        'hitch_time_ms': during.get('hitch_time_ms'),
    }


def shift(result: dict):
    return result['geometry']['same_row_shift'].get('worst_pt')


def shrink(result: dict):
    return result['geometry']['reader_gap_shrink'].get('worst_pt')


def settled(result: dict):
    return result['geometry']['follow_gap_settled'].get('worst_pt')


def print_append_costs(results: list[dict]) -> None:
    """把各轮的"每次追加的单价"并排打出来——**跨长度**的读法就在这里。

    同一场之内追加不改行数，所以"转录长度"这个变量只能靠两个档次的场景来变
    （`probe-stream` 17 行 / `probe-stream-long` 101 行 / `probe-stream-long-300` 600 行）。
    修了 `NativeMessageList` 的追加路径之后，这两行数字就是"改前 vs 改后"。

    老结果（这一列字段还没有时落的盘）打 `—`，不是 0。
    """
    rows = [result.get('append_cost') or {} for result in results]
    if not any(cost.get('count') for cost in rows):
        return
    print('\n每次追加的单价（主线程同步段中位 ms；括号里是转录行数中位）：')
    print('  '.join(f'{name:>16}' for name in
                    ['label', '变更集合', '前 1/3', '中 1/3', '后 1/3']))
    for result, cost in zip(results, rows):
        cells = []
        for bucket in cost.get('buckets') or []:
            cells.append(f"{bucket['ms_median']:g}ms({int(bucket['rows_median'])})")
        while len(cells) < 3:
            cells.append('—')
        mode = '深比较' if result.get('deep_compare') else '哈希'
        print('  '.join(f'{str(cell):>16}' for cell in [result['label'], mode, *cells]))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('results', nargs='+', type=pathlib.Path)
    parser.add_argument('--control', type=pathlib.Path,
                        help='对照组（噪声地板）。给了就按相对判据判，而不是只看数字')
    arguments = parser.parse_args(argv)

    results = [load(path) for path in arguments.results]
    control = load(arguments.control) if arguments.control else None

    header = ('label', 'deep', 'load1', 'frames', 'nominal', 'p95', 'max', 'hitches', 'rate', 'dropped')
    print('  '.join(f'{name:>10}' for name in header))
    for result in results:
        data = row(result)
        print('  '.join(f'{str(data[key]):>10}' for key in
                        ('label', 'deep', 'load1', 'frames', 'nominal_ms', 'p95_ms', 'max_ms',
                         'hitches', 'rate', 'dropped')))

    problems: list[str] = []

    if control is not None:
        ok, why = comparable(control, results[-1])
        print(f'\n可比性（对照 vs 最后一轮）：{why} → {"可比" if ok else "不可比"}')
        if not ok:
            problems.append(f'不可比：{why}')
        control_rate = control['during_stream'].get('hitch_rate') or 0.0
        allowed = control_rate * HITCH_RATE_K + HITCH_RATE_FLOOR
        for result in results:
            rate = result['during_stream'].get('hitch_rate')
            if rate is None:
                continue
            verdict = 'OK' if rate <= allowed else 'FAIL'
            print(f"  {result['label']}: rate {rate} vs 允许 {allowed:.5f}"
                  f" = control {control_rate}×{HITCH_RATE_K}+{HITCH_RATE_FLOOR} → {verdict}")
            if verdict == 'FAIL':
                problems.append(f"{result['label']} 掉帧率 {rate} > {allowed:.5f}")

    for a, b in zip(results, results[1:]):
        ok, why = comparable(a, b)
        print(f"\n{a['label']} vs {b['label']}：{why} → {'可比' if ok else '不可比'}")
        if not ok:
            continue
        before = row(a)['rate'] or 0.0
        after = row(b)['rate'] or 0.0
        print(f"  掉帧率 {before} → {after}（{after - before:+.5f}）")
        print(f"  几何：同首行位移 {shift(a)} → {shift(b)}pt；"
              f"距底收缩 {shrink(a)} → {shrink(b)}pt；"
              f"落定后距底 {settled(a)} → {settled(b)}pt")

    print_append_costs(results)

    if problems:
        print('\n❌ ' + '；'.join(problems))
        return 2
    print('\n✅ 没有违反判据的组合')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
