#!/usr/bin/env python3
"""帧级尺子：跑一个场景 → 收探针 JSONL → 记宿主负载 → 算分布与几何不变量 → 给结论。

## 这套东西由三块组成，缺一块都不成立

1. **App 里的探针**（`modules/memoh-kit/ios/Chat/MessageListFrameProbe.swift`）：
   逐帧记主线程帧投递间隔 + 消息列表的几何。口径写在那个文件头。
2. **这个脚本**：驱动场景、做手势、**把宿主负载一起记下来**、把 `t`（探针相对时间）
   对齐到本机时钟（探针 `start` 事件里的 `wall`）。
3. **判据**：`INVARIANTS` 里那几条，是**断言**不是形容词。跑 `--assert` 时会红。

## 为什么必须记负载

本机被多个 agent 同时压着，1 分钟 load 常在 400 上下，帧数据会被负载污染。
**负载噪声不是实现问题**，所以：

- 每次运行都记 loadavg（0.5s 一次）与 App RSS；
- 每个场景都与**同一时间窗内的对照跑**（`--control` 或 `--label noise-floor`）比，
  用 `hitches <= control_hitches * K + 绝对地板` 这种**相对**判据，不比绝对值；
- 两组负载相差超过 1.5 倍时，结论标 `comparable: false`，不当结论用。

## 用法

    # ① 流式追加（基准场景，含"往上翻之后不被拽回底部"）
    python3 tools/frame-probe/measure.py --udid "$UDID" --out /tmp/fp/stream-1 \
        --label probe-stream --scene probe-stream --swipe-up

    # 噪声地板：同一个 App、同一个列表，但**没有流式**（场景回放完就静止）。
    python3 tools/frame-probe/measure.py --udid "$UDID" --out /tmp/fp/floor-1 \
        --label noise-floor --scene chat-tools

    # ③ 已知会掉帧的对照：证明探针真的量得出掉帧
    python3 tools/frame-probe/measure.py --udid "$UDID" --out /tmp/fp/stall-1 \
        --label stall-control --scene probe-stream --stall-ms 25

    # 再拿两份 result.json 比
    python3 tools/frame-probe/compare.py /tmp/fp/stream-1/result.json /tmp/fp/floor-1/result.json

## 别做的事

- **不要把阈值调宽让断言变绿**。红了就写进报告（`docs/research/ios-performance-practices.md`）。
- **不要在负载不可比的两轮之间下"谁更快"的结论**——脚本会把 `comparable` 标出来。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import pathlib
import statistics
import subprocess
import sys
import threading
import time

BUNDLE_ID = 'ai.memoh.ios'
SCHEME_HINT = 'memoh'

# ---------------------------------------------------------------- 判据（断言用的阈值）

INVARIANTS = {
    # A. 首条可见行在**同一行**、无手指/惯性参与的连续两帧之间，屏幕坐标位移上限（pt）。
    #    出处：docs/research/lody-ios-deep-dive.md（"one pixel is already a regression"）。
    'first_row_shift_pt': 1.0,
    # C. **不许把读者拽回底部**：阅读模式下每来一次追加，距底距离不许变小（留 1pt 容差）。
    #    注意不能拿"offset 不变"当判据——锚点修正本来就会改 offset（内容在锚点上方变高时
    #    必须改，否则那行会漂）。真正要守的是"读者离底部的距离不许缩短"。
    'reader_gap_shrink_pt': 1.0,
    # D. 跟随底部时**更新落定之后**必须贴底（pt）。只算"上一次 apply 之后已经静止"的帧：
    #    更新进行中 gap 会等于这次更新带来的高度增量，那是设计如此，不是问题。
    'follow_gap_pt': 2.0,
    # 锚点修正的漂移上限（pt）。
    'anchor_drift_pt': 3.0,
    # 一帧超过名义帧长的这个倍数才算 hitch。
    'hitch_factor': 1.5,
    # 相邻两帧间隔超过这个值（秒）就不参与几何比较：中间发生了什么看不出来，
    # 拿它当"漂移"会把掉帧算成几何问题（排除数会写进结果里）。
    'geometry_gap_limit_s': 0.1,
    # "落定"的定义：距离上一次 apply 超过这么久（秒）。
    'settled_after_apply_s': 0.06,
    # "静止"的定义：这么久没有新的追加了。判据 D 用这个窗口——它问的是
    # "列表不再长的时候贴不贴底"，不是"内容正在长的时候落后多少"（后者是增长本身）。
    'quiet_after_apply_s': 1.5,
    # 离开底部的门槛（pt）：安静帧里距底超过它才算"读者真的在别处"。
    'reading_min_gap_pt': 40.0,
}

PERCENTILES = (50, 90, 95, 99)


# ---------------------------------------------------------------- 宿主负载采样


class LoadSampler:
    """0.5 秒采一次 loadavg + App RSS。负载必须和帧数据一起报，否则数字没法解释。"""

    def __init__(self, udid: str, bundle_id: str):
        self.udid = udid
        self.bundle_id = bundle_id
        self.samples: list[dict] = []
        self.container: str | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                one, five, fifteen = os.getloadavg()
            except OSError:
                one = five = fifteen = float('nan')
            self.samples.append({
                'wall': round(time.time(), 3),
                'load1': round(one, 2),
                'load5': round(five, 2),
                'load15': round(fifteen, 2),
                'rss_mb': app_rss_mb(self.udid, self.bundle_id),
            })
            self._stop.wait(0.5)

    def stop(self) -> dict:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        loads = [s['load1'] for s in self.samples if not math.isnan(s['load1'])]
        rss = [s['rss_mb'] for s in self.samples if s['rss_mb'] is not None]
        if not loads:
            return {'samples': len(self.samples), 'cpus': os.cpu_count()}
        return {
            'samples': len(self.samples),
            'cpus': os.cpu_count(),
            'load1_min': round(min(loads), 2),
            'load1_median': round(statistics.median(loads), 2),
            'load1_max': round(max(loads), 2),
            'rss_mb_max': round(max(rss), 1) if rss else None,
        }


def app_rss_mb(udid: str, bundle_id: str) -> float | None:
    """模拟器里的 App 是宿主进程，`ps` 直接读得到（匹配安装路径，bundle id 不出现）。"""
    if not hasattr(app_rss_mb, '_container'):
        container = subprocess.run(
            ['xcrun', 'simctl', 'get_app_container', udid, bundle_id, 'app'],
            capture_output=True, text=True).stdout.strip()
        app_rss_mb._container = container or None
    container = app_rss_mb._container
    if container is None:
        return None
    out = subprocess.run(['ps', '-Ao', 'rss=,command='], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if line.endswith(f'{container}/Memoh') or f'{container}/Memoh ' in line:
            try:
                return round(int(line.split()[0]) / 1024, 1)
            except ValueError:
                continue
    return None


# ---------------------------------------------------------------- simctl / 种子


def simctl(*arguments: str, check: bool = True) -> str:
    result = subprocess.run(['xcrun', 'simctl', *arguments], capture_output=True, text=True)
    if check and result.returncode != 0:
        raise SystemExit(f'simctl {arguments[0]} 失败：{result.stderr.strip()}')
    return result.stdout.strip()


def data_container(udid: str) -> pathlib.Path:
    return pathlib.Path(simctl('get_app_container', udid, BUNDLE_ID, 'data'))


def write_seed(container: pathlib.Path, payload: dict) -> None:
    documents = container / 'Documents'
    documents.mkdir(parents=True, exist_ok=True)
    target = documents / 'memoh-verify-seed.json'
    temporary = target.with_suffix('.tmp')
    temporary.write_text(json.dumps(payload), encoding='utf-8')
    temporary.replace(target)


def reinstall(udid: str, app: pathlib.Path) -> None:
    """卸载再装。

    为什么每次都重装：实测到过 `simctl launch` 被 SpringBoard 永久拒绝
    （`SBSMainWorkspace` / "request was denied by service delegate"），重装一次就好了——
    那是 CoreSimulator 的注册状态坏了，不是 App 的问题。宁可每次多花几秒，
    也不要让"启动失败"看起来像"这一轮没数据"。
    """
    subprocess.run(['xcrun', 'simctl', 'terminate', udid, BUNDLE_ID],
                   capture_output=True, text=True)
    subprocess.run(['xcrun', 'simctl', 'uninstall', udid, BUNDLE_ID],
                   capture_output=True, text=True)
    result = subprocess.run(['xcrun', 'simctl', 'install', udid, str(app)],
                            capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f'simctl install 失败：{result.stderr.strip()}')


def launch(udid: str, metro_port: int, probe_name: str, stall_ms: int,
           app: pathlib.Path | None = None, deep_compare: bool = False) -> float:
    """启动 App（带探针启动参数），返回启动那一刻的本机 wall clock。

    满载时 `simctl launch` 会偶发 `SBMainWorkspace` 拒绝（本机 load 500+ 时实测到，
    而且**会持续**拒绝，不是一次性的）——重装一次即可恢复，所以重试时带上重装。
    """
    arguments = [
        'launch', udid, BUNDLE_ID,
        '--initialUrl', f'http://127.0.0.1:{metro_port}?disableOnboarding=1',
        '-expo.devlauncher.hasGrantedNetworkPermission', 'YES',
        '-EXDevMenuShowsAtLaunch', 'NO', '-EXDevMenuIsOnboardingFinished', 'YES',
        '-EXDevMenuShowFloatingActionButton', 'NO',
        '-AppleLanguages', '(en)', '-AppleLocale', 'en_US',
        # 探针（见 MessageListFrameProbe.swift 的表）
        '-MemohFrameProbe', '1',
        '-MemohFrameProbeName', probe_name,
        '-MemohFrameProbeStallMs', str(stall_ms),
        # 量测对照：把 apply 的变更集合换回改动前的逐行深比较（见 measure.py --deep-compare）
        '-MemohFrameProbeDeepCompare', '1' if deep_compare else '0',
    ]
    started = time.time()
    last = ''
    for attempt in range(3):
        result = subprocess.run(['xcrun', 'simctl', *arguments], capture_output=True, text=True)
        if result.returncode == 0:
            return started
        last = (result.stderr or result.stdout).strip()
        print(f'⚠️ 启动失败（第 {attempt + 1}/3 次）：{last.splitlines()[0] if last else "?"}')
        if app is not None:
            reinstall(udid, app)
        simctl('bootstatus', udid, '-b', check=False)
        time.sleep(3)
    raise SystemExit(f'simctl launch 失败：{last}')


def probe_file(container: pathlib.Path, probe_name: str) -> pathlib.Path:
    return container / 'Documents' / f'frame-probe-{probe_name}.jsonl'


def read_probe(path: pathlib.Path) -> tuple[list[dict], list[dict], list[str]]:
    """探针文件的每一行都是**一行 JSON**；探针自己保证不写半行（缓冲落盘）。"""
    frames: list[dict] = []
    events: list[dict] = []
    broken: list[str] = []
    if not path.exists():
        return frames, events, ['探针文件不存在：' + str(path)]
    for raw in path.read_text(encoding='utf-8', errors='replace').splitlines():
        line = raw.strip()
        if line == '':
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            broken.append(line[:120])
            continue
        if parsed.get('k') == 'f':
            frames.append(parsed)
        elif parsed.get('k') == 'e':
            events.append(parsed)
        else:
            broken.append(line[:120])
    return frames, events, broken


# ---------------------------------------------------------------- 手势


def begin_maestro(udid: str, flow: pathlib.Path, out: pathlib.Path) -> subprocess.Popen:
    """**先起** Maestro，让它在外面等 App 起来。

    为什么必须错开启动：Maestro 要装并起自己的 XCTest runner，满载时冷启动 30–60 秒，
    比"流式回放"整段还长——先启动 App 再起 Maestro，等它准备好时流式早演完了，
    阅读模式那一整段判据就一对样本都拿不到（本轮实测踩到两次）。先起它，让 flow 里的
    `extendedWaitUntil` 去等场景出现。
    """
    return subprocess.Popen(
        ['maestro', 'test', '--udid', udid, '--debug-output', str(out),
         '--flatten-debug-output', str(flow)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        env={**os.environ, 'PATH': f"{pathlib.Path.home()}/.maestro/bin:{os.environ['PATH']}"})


def finish_maestro(process: subprocess.Popen, flow: pathlib.Path,
                   out: pathlib.Path) -> int:
    output, _ = process.communicate()
    (out.parent / f'{flow.stem}-maestro.log').write_text(output or '', encoding='utf-8')
    return process.returncode


def run_maestro(udid: str, flow: pathlib.Path, out: pathlib.Path) -> tuple[float, float, int]:
    """同步跑一段 Maestro 手势，返回 (开始, 结束, 退出码)。

    **退出码要一起带回去**：本轮踩到过"36 次滑动全部 COMPLETED 却一步没动"
    （方向写反），光看时间窗口看不出手势有没有真的生效。
    """
    started = time.time()
    result = subprocess.run(
        ['maestro', 'test', '--udid', udid, '--debug-output', str(out),
         '--flatten-debug-output', str(flow)],
        check=False, capture_output=True, text=True,
        env={**os.environ, 'PATH': f"{pathlib.Path.home()}/.maestro/bin:{os.environ['PATH']}"})
    (out.parent / f'{flow.stem}-maestro.log').write_text(
        (result.stdout or '') + '\n--- stderr ---\n' + (result.stderr or ''), encoding='utf-8')
    return started, time.time(), result.returncode


def start_fixture(port: int, out: pathlib.Path) -> subprocess.Popen:
    """起一个自己的固定服务端（`apps/mobile/verification/fixture/server.mjs`）。

    **自己起、不复用别人在跑的**：复用会让"界面拿到的是上一版的响应"这种事伪装成通过。
    端口也用非默认的，别和别人的 18099 撞。
    """
    mobile = pathlib.Path(__file__).resolve().parents[2] / 'apps' / 'mobile'
    stale = subprocess.run(['pgrep', '-f', f'fixture/server.mjs --port {port}'],
                           capture_output=True, text=True).stdout.split()
    if stale:
        print(f'⚠️ 端口 {port} 上有旧固定服务端（pid {" ".join(stale)}），先停掉')
        subprocess.run(['kill', *stale], check=False)
        time.sleep(1)
    log = (out / 'fixture.log').open('w')
    process = subprocess.Popen(['node', 'verification/fixture/server.mjs', '--port', str(port)],
                               cwd=str(mobile), stdout=log, stderr=subprocess.STDOUT)
    for _ in range(40):
        probe = subprocess.run(
            ['curl', '-s', '--max-time', '1', f'http://127.0.0.1:{port}/bots'],
            capture_output=True, text=True)
        if probe.returncode == 0 and probe.stdout.strip() != '':
            return process
        time.sleep(0.5)
    process.terminate()
    raise SystemExit(f'固定服务端（:{port}）20 秒内没起来')


def set_scenario(port: int, scenario: str) -> None:
    if scenario == '':
        return
    subprocess.run(
        ['curl', '-s', '-X', 'POST', '-H', 'Content-Type: application/json',
         '-d', json.dumps({'scenario': scenario}), f'http://127.0.0.1:{port}/__scenario'],
        check=False, capture_output=True, text=True)


# ---------------------------------------------------------------- 统计


def percentiles(values: list[float]) -> dict[str, float]:
    if not values:
        return {}
    ordered = sorted(values)
    out: dict[str, float] = {}
    for percent in PERCENTILES:
        index = min(len(ordered) - 1, max(0, round((percent / 100) * (len(ordered) - 1))))
        out[f'p{percent}'] = round(ordered[index], 2)
    out['max'] = round(ordered[-1], 2)
    out['min'] = round(ordered[0], 2)
    return out


def hitch_stats(frames: list[dict], window: tuple[float, float] | None) -> dict:
    """主线程帧投递的分布与 hitch。

    名义帧长取 `nom`（display link 自己报的 `targetTimestamp - timestamp`）的中位数——
    不去假设是 60Hz 还是 120Hz。
    """
    selected = [f for f in frames if window is None or window[0] <= f['t'] <= window[1]]
    if not selected:
        return {'frames': 0}
    nominal = statistics.median([f['nom'] for f in selected if f['nom'] > 0] or [1 / 60])
    deltas = [f['dt'] for f in selected]
    late = [d for d in deltas if d > nominal * INVARIANTS['hitch_factor']]
    return {
        'frames': len(selected),
        'seconds': round(selected[-1]['t'] - selected[0]['t'], 3),
        'nominal_ms': round(nominal * 1000, 3),
        'implied_fps': round(1 / nominal, 1) if nominal > 0 else None,
        'dt_ms': {k: round(v * 1000, 3) for k, v in percentiles(deltas).items()},
        'hitches': len(late),
        'hitch_rate': round(len(late) / len(selected), 5),
        'hitch_time_ms': round(sum(d - nominal for d in late) * 1000, 2),
        'dropped_frames': int(sum(max(0, round(d / nominal) - 1) for d in deltas)),
    }


# 追加单价分几档。三档够看出"随追加推进怎么变"，再多就是噪声里挑数字。
APPEND_COST_BUCKETS = 3


def append_cost_stats(events: list[dict]) -> dict:
    """每次**追加**的花费，按追加的先后分档（并记下当时的转录行数）。

    ## 为什么要有这个

    判据 A/C/D 量的是几何，看不见"每来一个 token 就要重算整份转录"这件事
    （`docs/research/ios-native-code-comparison.md` §2.2）。`apply` 事件里自带行数
    `n` 与两段耗时——`ms`（主线程同步段：建行表 + 变更集合 + 组装快照）与 `dec`
    （后台解码往返）——把两者放在一起，"单价随长度怎么变"就从推理变成数字。

    ## 为什么按先后分档，而不是按行数分档

    追加**不改行数**（只往同一行加字），所以一场之内行数是常数：按行数分档只会得到
    一个档。"转录变长"这个变量来自**两个档次的场景**（`probe-stream-long` 101 行 vs
    `probe-stream-long-300` 600 行），宿主侧拿 `compare.py` 把两轮的这三个档摆在一起读。
    档内记 `rows_median`，就是为了一眼看出"这两轮比的是什么长度"。

    ## 为什么只取 `added == 0` 的 apply

    那是**追加**：第一档历史按批进，一批新增几十行，混进来会把"每行多少钱"算歪
    （那一批的钱花在新增上）。`dec == 0` 的那种（展开态重放）不进解码统计，
    但仍在主线程统计里——它确实花了主线程时间。
    """
    appends = [
        event for event in events
        if event.get('ev') == 'apply' and event.get('added') == 0
        and isinstance(event.get('ms'), (int, float))
    ]
    if not appends:
        return {'count': 0}
    appends.sort(key=lambda event: event['t'])

    summary = []
    for index in range(APPEND_COST_BUCKETS):
        start = index * len(appends) // APPEND_COST_BUCKETS
        end = (index + 1) * len(appends) // APPEND_COST_BUCKETS
        bucket = appends[start:end]
        if not bucket:
            continue
        main_ms = [float(event['ms']) for event in bucket]
        decode_ms = [float(event['dec']) for event in bucket if event.get('dec', 0) > 0]
        summary.append({
            'append_from': start + 1,
            'append_to': end,
            'rows_median': statistics.median([event['n'] for event in bucket]),
            'count': len(bucket),
            'ms_median': round(statistics.median(main_ms), 3),
            'ms_p95': percentiles(main_ms).get('p95'),
            'ms_max': round(max(main_ms), 3),
            'decode_median': None if not decode_ms else round(statistics.median(decode_ms), 3),
            'decode_p95': None if not decode_ms else percentiles(decode_ms).get('p95'),
        })

    return {
        'count': len(appends),
        'rows_median': statistics.median([event['n'] for event in appends]),
        'buckets': summary,
    }


def geometry_stats(frames: list[dict], events: list[dict]) -> dict:
    """几何不变量。只看**没有手指/惯性参与**的连续两帧。

    为什么必须排除手势帧：手指在动的时候位移是**用户造成的**，把它算成漂移等于
    用"用户滑了一下"去判实现有罪。
    """
    quiet = [f for f in frames if not f['di'] and not f['tr'] and not f['fn']]
    limit = INVARIANTS['geometry_gap_limit_s']

    same_row_shift: list[dict] = []
    reader_gap: list[dict] = []
    follow_gap_settled: list[dict] = []
    follow_gap_transient: list[float] = []
    follow_off_jumps: list[dict] = []
    reading_frames = 0
    reading_off_shift: list[float] = []
    pairs_examined = 0
    pairs_skipped = 0

    for previous, current in zip(quiet, quiet[1:]):
        if current['t'] - previous['t'] > limit:
            pairs_skipped += 1
            continue
        if current['fo'] and previous['fo']:
            # 诊断：内容在长的时候，视口落后底部多少（这是"这次增长有多大"的量度，
            # 不是缺陷——除非它在列表停止增长之后仍然回不去，那才由判据 D 抓）。
            follow_gap_transient.append(current['gap'])
            if current.get('quiet', 0):
                follow_gap_settled.append({'t': current['t'], 'gap': current['gap']})
            follow_off_jumps.append({'t': current['t'], 'd_off': current['off'] - previous['off']})
        # 阅读模式（两边都不在底部）：只有"真的离开底部"才算
        if not current['fo'] and not previous['fo'] and current['gap'] > INVARIANTS['reading_min_gap_pt']:
            reading_frames += 1
            reading_off_shift.append(current['off'] - previous['off'])
            if not current.get('applied'):
                continue
            pairs_examined += 1
            # C：不许把读者拽回底部——距底距离不许变小
            reader_gap.append({'t': current['t'], 'd_gap': round(current['gap'] - previous['gap'], 2),
                               'gap': round(current['gap'], 2)})
            # A：同一行的话，屏幕坐标不许动
            if current['fv'] == previous['fv'] and current['fv'] >= 0:
                same_row_shift.append({
                    't': current['t'],
                    'd_fvy': round(current['fvy'] - previous['fvy'], 2),
                })

    def worst(rows: list[dict], key: str, absolute: bool = True) -> dict:
        """给最坏的那一端。

        `absolute=True`：关心"幅度"（位移不问方向），报 |值| 最大的那一端。
        `absolute=False`：关心"方向"（距底只能变大不能变小），报**代数值最小**的那一端——
        只报最大会把"收缩了 44pt"印成"44pt"，读起来像通过。两个端点都写进结果。
        """
        if not rows:
            return {'count': 0}
        pick = (lambda row: abs(row[key])) if absolute else (lambda row: -row[key])
        ordered = sorted(rows, key=pick, reverse=True)
        values = sorted(row[key] for row in rows)
        return {
            'count': len(rows),
            'worst_pt': ordered[0][key],
            'worst_t': round(ordered[0]['t'], 3),
            'min_pt': round(values[0], 2),
            'max_pt': round(values[-1], 2),
            'abs_p95': round(sorted(abs(value) for value in values)[int(0.95 * (len(values) - 1))], 2),
        }

    anchors = [e for e in events if e.get('ev') == 'anchor']
    return {
        'quiet_frames': len(quiet),
        'pairs_examined': pairs_examined,
        'pairs_skipped_long_gap': pairs_skipped,
        'reading_frames': reading_frames,
        'same_row_shift': worst(same_row_shift, 'd_fvy'),
        # 越大越好：这里要报的是**最小的**一次收缩
        'reader_gap_shrink': worst(reader_gap, 'd_gap', absolute=False),
        'follow_gap_settled': worst(follow_gap_settled, 'gap'),
        'follow_gap_transient_max_pt': round(max((abs(g) for g in follow_gap_transient), default=0.0), 2),
        'follow_gap_transient_frames': len(follow_gap_transient),
        'follow_off_jump': worst(follow_off_jumps, 'd_off'),
        'reading_off_shift_max_pt': round(max((abs(v) for v in reading_off_shift), default=0.0), 2),
        'anchor_events': len(anchors),
        'anchor_shift_max_pt': round(
            max((abs(a.get('from', 0) - a.get('to', 0)) for a in anchors), default=0.0), 2),
    }


def stream_window(events: list[dict]) -> tuple[float, float] | None:
    applies = [e for e in events if e.get('ev') == 'apply']
    if not applies:
        return None
    return (applies[0]['t'], applies[-1]['t'])


def applied_times(events: list[dict]) -> set[float]:
    """把 `apply` 事件的时刻做成集合，用来识别"这一帧之前刚 append 过"。"""
    return {e['t'] for e in events if e.get('ev') == 'apply'}


def mark_applied(frames: list[dict], events: list[dict], within: float = 0.05) -> None:
    """给帧样本打两个标：`applied`（这一刻之前刚发生过 apply）、`settled`（距上次 apply 已足够久）。

    为什么不用"行数变了"来识别追加：流式追加的是**同一行的正文变长**，行数根本不变。
    """
    times = sorted(applied_times(events))
    if not times:
        return
    index = 0
    for frame in frames:
        while index < len(times) and times[index] < frame['t'] - within:
            index += 1
        frame['applied'] = 1 if (index < len(times) and times[index] <= frame['t']) else 0
    for key, window in (('settled', INVARIANTS['settled_after_apply_s']),
                        ('quiet', INVARIANTS['quiet_after_apply_s'])):
        index = 0
        for frame in frames:
            while index < len(times) and times[index] < frame['t'] - window:
                index += 1
            recent = index < len(times) and times[index] <= frame['t']
            frame[key] = 0 if recent else 1


# ---------------------------------------------------------------- 主流程


def build_flow(out: pathlib.Path, steps: list[str]) -> pathlib.Path:
    flow = out / 'gesture.yaml'
    flow.parent.mkdir(parents=True, exist_ok=True)
    flow.write_text(f'appId: {BUNDLE_ID}\n---\n' + ''.join(steps), encoding='utf-8')
    return flow


def wait_for_stream(frames_path: pathlib.Path, minimum_applies: int, timeout: float) -> bool:
    """等流式真的开始（探针文件里出现足够多的 `apply`），而不是靠 sleep 猜。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if frames_path.exists():
            text = frames_path.read_text(encoding='utf-8', errors='replace')
            if text.count('"ev":"apply"') >= minimum_applies:
                return True
        time.sleep(0.3)
    return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--udid')
    parser.add_argument('--out', type=pathlib.Path)
    parser.add_argument('--label')
    parser.add_argument('--scene', help='场景 id（本地帧回放，不联网）。不给就只开一个空列表当噪声地板')
    parser.add_argument('--route', help='真实路由（要 --fixture-port 起的固定服务端，例如 '
                                       '/chat/fixture-session-stream）')
    parser.add_argument('--fixture-port', type=int, default=18097,
                        help='固定服务端的端口（自己起、自己收，默认 18097，避开别人的 18099）')
    parser.add_argument('--fixture-scenario', default='',
                        help='固定服务端的 __scenario（见 server.mjs 的 faultForScenario）')
    parser.add_argument('--app', type=pathlib.Path,
                        help='.app 路径：每轮开始先重装一次（CoreSimulator 的注册状态坏了时，'
                             '唯一有效的解法就是重装）')
    parser.add_argument('--maestro', type=pathlib.Path,
                        help='要跑的 Maestro flow 文件（手势窗口会被实测并记进结果）')
    parser.add_argument('--metro-port', type=int, default=8097)
    parser.add_argument('--stall-ms', type=int, default=0,
                        help='已知掉帧对照：每帧在主线程忙等这么多毫秒')
    parser.add_argument('--swipe-up', action='store_true',
                        help='流式期间往上翻（造出"阅读模式"，量追加会不会把读者拽回底部）')
    parser.add_argument('--hold', type=float, default=3.0,
                        help='流式结束后再等这么久才杀 App（保证探针缓冲落盘）')
    parser.add_argument('--wait-applies', type=int, default=12,
                        help='等探针里出现这么多次 apply 才认为"已经进到场景里了"')
    parser.add_argument('--timeout', type=float, default=120.0)
    parser.add_argument('--window-seconds', type=float, default=20.0,
                        help='观测窗口长度（秒），从"场景真的起来了"那一刻算起。'
                             '所有场景用同一个长度，噪声地板才有可比性（否则地板的'
                             '窗口只有几百毫秒，掉帧率会离谱地高）')
    parser.add_argument('--expect-reading', dest='expect_reading', action='store_true',
                        help='这一轮的手势应当把列表带离底部（read.yaml / --swipe-up）。'
                             '给了就要求阅读模式里真有带追加的帧对，否则该轮不作数；'
                             'sheet/composer 那类手势不要求')
    parser.add_argument('--assert', dest='do_assert', action='store_true',
                        help='跑判据；违反就非零退出（红了不要调阈值）')
    parser.add_argument('--deep-compare', dest='deep_compare', action='store_true',
                        help='量测对照：让 App 的变更集合走**改动前**那条逐行深比较的路'
                             '（`MemohFrameProbeDeepCompare`）。同一个二进制里切这一条，'
                             '改前/改后的两个数字才是配对的——见 changedSet 的说明')
    parser.add_argument('--keep', action='store_true', help='保留 App 不杀（排查用）')
    parser.add_argument('--reanalyze', type=pathlib.Path, nargs='+',
                        help='拿已落盘的 frames.jsonl 重算判据（不碰设备）。判据改了就用它，'
                             '不要为了改判据重跑一轮')
    arguments = parser.parse_args(argv)
    if arguments.reanalyze:
        pass
    elif arguments.udid is None or arguments.out is None or arguments.label is None:
        parser.error('要么给 --reanalyze <目录...>，要么给 --udid / --out / --label')
    if arguments.reanalyze:
        return max(reanalyze(directory) for directory in arguments.reanalyze)

    arguments.out.mkdir(parents=True, exist_ok=True)
    # 设备没完全起来时 `simctl install/launch` 会以各种脸色失败，先等它。
    simctl('bootstatus', arguments.udid, '-b', check=False)
    simctl('terminate', arguments.udid, BUNDLE_ID, check=False)
    time.sleep(0.8)
    # ⚠️ **重装必须在解析容器路径与写种子之前**：`uninstall` 会连数据容器一起删掉
    # （本轮踩到过：种子被删，App 起来停在首页，探针一次都没 attach，看起来像"尺子坏了"）。
    if arguments.app is not None:
        reinstall(arguments.udid, arguments.app)

    container = data_container(arguments.udid)

    sampler = LoadSampler(arguments.udid, BUNDLE_ID)
    sampler.start()

    fixture: subprocess.Popen | None = None
    if arguments.route:
        fixture = start_fixture(arguments.fixture_port, arguments.out)
        set_scenario(arguments.fixture_port, arguments.fixture_scenario)

    if arguments.route:
        write_seed(container, {
            'baseUrl': f'http://127.0.0.1:{arguments.fixture_port}',
            'username': 'fixture', 'password': 'fixture',
            'scenario': 'route', 'path': arguments.route,
        })
    else:
        write_seed(container, {
            'baseUrl': 'http://scene.invalid', 'username': 'scene', 'password': 'scene',
            'scenario': 'scene', 'scene': arguments.scene or 'chat-long',
        })
    probe_name = arguments.label
    target = probe_file(container, probe_name)
    if target.exists():
        target.unlink()

    # 手势**先起**（见 begin_maestro）：它自己会等 App 起来。
    gesture: subprocess.Popen | None = None
    gesture_started = time.time()
    if arguments.maestro is not None:
        gesture = begin_maestro(arguments.udid, arguments.maestro, arguments.out / 'gesture')

    launched = launch(arguments.udid, arguments.metro_port, probe_name, arguments.stall_ms,
                      app=arguments.app, deep_compare=arguments.deep_compare)
    marks: list[dict] = [{'step': 'launch', 'wall': launched}]
    if gesture is not None:
        marks.append({'step': f'{arguments.maestro.stem}_start', 'wall': gesture_started})

    # 进场景：靠"探针里出现了 apply"确认，不靠 sleep 猜。
    ready = wait_for_stream(target, arguments.wait_applies, arguments.timeout)
    marks.append({'step': 'stream_started' if ready else 'stream_timeout', 'wall': time.time()})

    if arguments.swipe_up and ready:
        flow = build_flow(arguments.out, [
            '- swipe:\n    start: 50%, 20%\n    end: 50%, 80%\n',
            '- swipe:\n    start: 50%, 20%\n    end: 50%, 80%\n',
            '- swipe:\n    start: 50%, 20%\n    end: 50%, 80%\n',
        ])
        began, ended, code = run_maestro(arguments.udid, flow, arguments.out / 'gesture')
        marks.append({'step': 'swipe_up', 'wall': began, 'wall_end': ended, 'exit': code})

    if gesture is not None:
        code = finish_maestro(gesture, arguments.maestro, arguments.out / 'gesture')
        marks.append({'step': arguments.maestro.stem, 'wall': gesture_started,
                      'wall_end': time.time(), 'exit': code})
        # flow 跑完还可能有余波（惯性、键盘收起），多留一点再收。
        time.sleep(1.5)

    time.sleep(arguments.hold)
    marks.append({'step': 'hold_done', 'wall': time.time()})

    frames, events, broken = read_probe(target)
    if not arguments.keep:
        simctl('terminate', arguments.udid, BUNDLE_ID, check=False)
    # 杀进程之后把文件再读一次：缓冲里最后那点可能刚好在这时候落盘。
    if not arguments.keep:
        time.sleep(0.3)
    frames2, events2, _ = read_probe(target)
    if len(frames2) > len(frames):
        frames, events, broken = frames2, events2, broken

    load = sampler.stop()
    if fixture is not None:
        fixture.terminate()

    start_event = next((e for e in events if e.get('ev') == 'start'), None)
    origin_wall = start_event.get('wall') if start_event else None
    if isinstance(origin_wall, str):
        try:
            origin_wall = float(origin_wall)
        except ValueError:
            origin_wall = None

    mark_applied(frames, events)
    window = stream_window(events)

    # 观测窗口：**所有场景同一个长度**，从"场景真的起来了"（第一次 apply）算起。
    # 为什么不能只取"流式那一段"：噪声地板没有流式段，它的窗口会退化成几百毫秒，
    # 掉帧率随即失真（本轮实测过：地板 0.75 vs 流式 0.34，那是窗口的错，不是负载）。
    ready_at = window[0] if window is not None else None
    observe = None
    if ready_at is not None:
        observe = (ready_at, ready_at + arguments.window_seconds)

    starts = [e for e in events if e.get('ev') == 'start']
    host_gone = [e for e in events if e.get('ev') == 'host_gone']
    invalid_reasons: list[str] = []
    if len(starts) > 1:
        invalid_reasons.append(f'探针启动了 {len(starts)} 次（App 中途重启/热重载）')
    if host_gone:
        invalid_reasons.append(
            f'宿主视图在 t={host_gone[0]["t"]:.2f}s 消失（Metro 热重载或页面被替换），'
            '之后的帧全是噪声')
    if window is None:
        invalid_reasons.append('没有任何 apply 事件，这一轮没进到场景里')
    if broken:
        invalid_reasons.append(f'探针文件有 {len(broken)} 行读不出来')

    result = {
        'label': arguments.label,
        'scenario': arguments.scene,
        'route': arguments.route,
        'stall_ms': arguments.stall_ms,
        'deep_compare': arguments.deep_compare,
        'udid': arguments.udid,
        'metro_port': arguments.metro_port,
        'valid': len(invalid_reasons) == 0,
        'invalid_reasons': invalid_reasons,
        'host_gone_at': None if not host_gone else round(host_gone[0]['t'], 3),
        'probe': {
            'file': str(target),
            'start': starts[0] if starts else None,
            'starts': len(starts),
            'events': len(events),
            'frames': len(frames),
            'event_kinds': sorted({e.get('ev') for e in events}),
            'broken_lines': broken[:5],
            'broken_count': len(broken),
        },
        'probe_origin_wall': origin_wall,
        'stream_window_t': None if window is None else [round(window[0], 3), round(window[1], 3)],
        'stream_applies': len(applied_times(events)),
        'stream_seconds': None if window is None else round(window[1] - window[0], 3),
        'marks': marks,
        'load': load,
        'window_seconds': arguments.window_seconds,
        'observe_window_t': None if observe is None else [round(observe[0], 3), round(observe[1], 3)],
        'all': hitch_stats(frames, None),
        # 判据用的是这个窗口：同长度、从场景起来算起，噪声地板与流式场景才可比。
        'during_stream': hitch_stats(frames, observe),
        'during_apply_window': hitch_stats(frames, window),
        'geometry': geometry_stats(frames, events),
        # 每次追加的单价（按转录长度分档）：这是"每个 token 要重算整份转录"的直接读数。
        'append_cost': append_cost_stats(events),
    }
    # 原始轨迹一起留下（含 time 锚点），否则别人只能信我的加工结果。
    if target.exists():
        (arguments.out / 'frames.jsonl').write_text(
            target.read_text(encoding='utf-8', errors='replace'), encoding='utf-8')
    (arguments.out / 'load.csv').write_text(
        'wall,load1,load5,load15,rss_mb\n'
        + ''.join(f"{s['wall']},{s['load1']},{s['load5']},{s['load15']},{s['rss_mb']}\n"
                  for s in sampler.samples), encoding='utf-8')
    if origin_wall is not None:
        result['marks_probe_time'] = [
            {
                'step': mark['step'],
                't': round(mark['wall'] - origin_wall, 3),
                **({'t_end': round(mark['wall_end'] - origin_wall, 3)} if 'wall_end' in mark else {}),
                **({'exit': mark['exit']} if 'exit' in mark else {}),
            }
            for mark in marks
        ]
        result['during_gesture'] = gesture_window_stats(
            frames, result.get('marks_probe_time', []),
            step=arguments.maestro.stem if arguments.maestro else 'swipe_up')

    (arguments.out / 'result.json').write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    violations = report(result, swiped=arguments.swipe_up or arguments.expect_reading)
    if arguments.do_assert:
        return 2 if violations else 0
    return 0


def reanalyze(directory: pathlib.Path, window_seconds: float = 20.0) -> int:
    """拿已经落盘的 `frames.jsonl` 重算一遍（不碰设备）。

    为什么要有这个入口：判据本身会被修正（本轮就把"停止增长"的窗口从 0.5s 改成 1.5s——
    0.5s 比流式的追加间隔还短，把"正在长"的帧误判成"已经停"）。判据改了**不能重跑**
    才叫可复现：原始轨迹留着，结论重算一遍就行。
    """
    label = json.loads((directory / 'result.json').read_text(encoding='utf-8'))['label']
    frames, events, broken = read_probe(directory / 'frames.jsonl')
    mark_applied(frames, events)
    window = stream_window(events)
    observe = None if window is None else (window[0], window[0] + window_seconds)
    result = {
        'label': label, 'scenario': None,
        'route': json.loads((directory / 'result.json').read_text(encoding='utf-8')).get('route'),
        'stall_ms': json.loads((directory / 'result.json').read_text(encoding='utf-8'))['stall_ms'],
        'deep_compare': json.loads((directory / 'result.json').read_text(encoding='utf-8')
                                   ).get('deep_compare', False),
        'valid': True, 'invalid_reasons': [],
        'probe': {'events': len(events), 'frames': len(frames), 'broken_count': len(broken),
                  'start': None, 'starts': 1, 'event_kinds': [], 'broken_lines': []},
        'stream_seconds': None if window is None else round(window[1] - window[0], 3),
        'stream_applies': len(applied_times(events)),
        'load': json.loads((directory / 'result.json').read_text(encoding='utf-8'))['load'],
        'during_stream': hitch_stats(frames, observe),
        'geometry': geometry_stats(frames, events),
        'append_cost': append_cost_stats(events),
    }
    (directory / 'reanalyzed.json').write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    report(result, swiped=False)
    return 0


def gesture_window_stats(frames: list[dict], marks: list[dict], step: str) -> dict:
    gesture = next((m for m in marks if m['step'] == step), None)
    if gesture is None:
        return {'measured': False}
    window = (gesture['t'], gesture.get('t_end', gesture['t']))
    return {
        'measured': True,
        'step': step,
        'window_t': [round(window[0], 3), round(window[1], 3)],
        **hitch_stats(frames, window),
    }


def print_append_cost(cost: dict) -> None:
    """打印"每次追加的单价"。**不进断言**：它是读数，不是判据。

    判据是几何那三条（A/C/D）；这一行回答的是另一个问题——"要不要做增量通道"。
    没有它，"每个 token 的代价是 O(整份转录)"就只是推理（`measure.py` 文件头第 3 条）。

    同一个场景内部只按"追加的先后"分档（追加不改行数）；**跨长度**的读法是把两个
    档次的场景放在一起看：`compare.py` 会把两轮的三档并排打出来。
    """
    if not cost or cost.get('count', 0) == 0:
        return
    print(f"  追加单价（{cost['count']} 次 added=0 的 apply，转录中位 {cost['rows_median']} 行）：")
    for bucket in cost['buckets']:
        decode = ''
        if bucket.get('decode_median') is not None:
            decode = f"，解码中位 {bucket['decode_median']:g}ms"
        print(f"    第 {bucket['append_from']}–{bucket['append_to']} 次：主线程中位"
              f" {bucket['ms_median']:g}ms（p95 {bucket['ms_p95']:g}，max {bucket['ms_max']:g}，"
              f"{int(bucket['rows_median'])} 行）{decode}")


def report(result: dict, swiped: bool) -> list[str]:
    """打印一轮，返回违反的判据（空 = 全过）。**不在这里调阈值**：红了就进报告。"""
    geometry = result['geometry']
    during = result['during_stream']
    print(f"── {result['label']}（场景 {result['scenario'] or result['route']}，stall {result['stall_ms']}ms"
          + ("，变更集合走深比较对照" if result.get('deep_compare') else "") + "）")
    print(f"  探针：{result['probe']['events']} 事件 /"
          f" 流式 {result['stream_seconds']}s / {result['stream_applies']} 次 apply")
    if result['probe']['broken_count']:
        print(f"  ⚠️ 有 {result['probe']['broken_count']} 行读不出来（截断写入？）")
    load = result['load']
    print(f"  宿主负载：load1 中位 {load.get('load1_median')}"
          f"（{load.get('load1_min')}–{load.get('load1_max')}），{load.get('cpus')} 核，"
          f"App RSS 峰值 {load.get('rss_mb_max')}MB")
    if during.get('frames'):
        print(f"  流式窗口帧投递：{during['frames']} 帧 / 名义 {during['nominal_ms']}ms"
              f"（≈{during['implied_fps']}fps）/ p95 {during['dt_ms']['p95']}ms"
              f" / max {during['dt_ms']['max']}ms")
        print(f"    hitches {during['hitches']} 次（rate {during['hitch_rate']}）"
              f" 掉帧合计 {during['dropped_frames']} 帧 / hitch time {during['hitch_time_ms']}ms")
    print(f"  几何：安静帧 {geometry['quiet_frames']}，阅读帧 {geometry['reading_frames']}，"
          f"可比较帧对 {geometry['pairs_examined']}（因间隔过大排除 {geometry['pairs_skipped_long_gap']}）")
    print(f"    A 同首行位移最差 {geometry['same_row_shift'].get('worst_pt')}pt"
          f"（{geometry['same_row_shift'].get('count', 0)} 对）")
    print(f"    C 距底收缩最大 {geometry['reader_gap_shrink'].get('worst_pt')}pt（负=被拉向底部）")
    print(f"    D 停止增长后距底最差 {geometry['follow_gap_settled'].get('worst_pt')}pt"
          f"（{geometry['follow_gap_settled'].get('count', 0)} 帧）"
          f"；增长中落后最多 {geometry['follow_gap_transient_max_pt']}pt（诊断，非判据）")
    print(f"    诊断：跟随中单帧 offset 跳变最大 {geometry['follow_off_jump'].get('worst_pt')}pt；"
          f"阅读中 offset 变化最大 {geometry['reading_off_shift_max_pt']}pt；"
          f"锚点事件 {geometry['anchor_events']} 次")
    print_append_cost(result.get('append_cost') or {})

    violations: list[str] = []
    if not result['valid']:
        for reason in result['invalid_reasons']:
            print(f"  ⚠️ 这一轮不作数：{reason}")
        violations.append('invalid: ' + '；'.join(result['invalid_reasons']))
        return violations
    if swiped and geometry['pairs_examined'] < 20:
        # 这一轮**没在流式期间造出阅读模式**（方向翻错、手势落在流式之后）：不是通过，是没测到。
        # A/C 要求的是"读者在别处时来了追加"，一个样本都没有就无从谈起。
        violations.append(
            f"invalid: 阅读模式里只有 {geometry['pairs_examined']} 个带追加的帧对"
            f"（阅读帧 {geometry['reading_frames']} 个）——手势没落在流式进行中，"
            'A/C 两条判据没被行使')
        print(f"  ⚠️ {violations[-1]}")
        return violations

    worst_shift = abs(geometry['same_row_shift'].get('worst_pt') or 0)
    if worst_shift > INVARIANTS['first_row_shift_pt']:
        violations.append(
            f"A 首条可见行位移 {worst_shift}pt > {INVARIANTS['first_row_shift_pt']}pt"
            f"（t={geometry['same_row_shift'].get('worst_t')}）")
    shrink = geometry['reader_gap_shrink'].get('worst_pt')
    if shrink is not None and shrink < -INVARIANTS['reader_gap_shrink_pt']:
        violations.append(
            f"C 阅读时被拉向底部 {shrink}pt（距底缩小）"
            f"（t={geometry['reader_gap_shrink'].get('worst_t')}）")
    settled = abs(geometry['follow_gap_settled'].get('worst_pt') or 0)
    if settled > INVARIANTS['follow_gap_pt']:
        violations.append(
            f"D 列表停止增长后仍未贴底 {settled}pt > {INVARIANTS['follow_gap_pt']}pt"
            f"（t={geometry['follow_gap_settled'].get('worst_t')}）")
    if geometry['anchor_shift_max_pt'] > INVARIANTS['anchor_drift_pt']:
        violations.append(
            f"锚点修正 {geometry['anchor_shift_max_pt']}pt"
            f" > {INVARIANTS['anchor_drift_pt']}pt")
    for line in violations:
        print(f"  ❌ {line}")
    if not violations:
        print('  ✅ 几何判据全部通过')
    return violations


if __name__ == '__main__':
    raise SystemExit(main())
