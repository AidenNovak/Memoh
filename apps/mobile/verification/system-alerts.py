#!/usr/bin/env python3
"""判断一张截图里有没有**系统弹窗**，以及该点它哪个按钮、点在哪儿。

## 为什么需要它

系统权限框（"「Memoh」Would Like to Send You Notifications"）是 **SpringBoard 画的**，
不进 App 的无障碍树。后果有两层：

1. Maestro 的 `tapOn: <文本>` 命不中它（实测：报 WARNED 而框还在，见
   `verification/push/flows/01-enable-permission.yaml`），所以"点掉它"只能按坐标点；
2. 它**没人点掉就一直留着**，而且**跨重启存活**：一次没点掉的框会让后面每一条 flow
   在同一个位置失败，看起来像"一堆互不相关的回归"。

坐标点有个反面风险：**没有弹窗时那条坐标点击会直接点在 App 上**（可能点到按钮、
翻走页面）。所以"点"这件事必须先**看见**才能做，而"看见"这件事不能靠猜——
这就是这个文件存在的理由：把"这一屏上到底有没有系统框"变成一个可判定的问题。

## 判据（两条都要成立，缺一不点）

1. OCR 文本里出现**权限请求的句式**（`Would Like to Access/Send/Use …`、`Wants to …`）；
   只认句式不认单个词，是因为 App 自己的界面里也有 `Allow` / `Deny`（审批面板就是），
   认单词会把 App 的按钮当成系统框的按钮；
2. **按钮行**读到了，而且它的纵向位置离标题足够近（系统框的按钮就在标题下面）。
   读到标题却读不到按钮 → 返回 `button: null`，**不点**，由调用方失败并说明。

`choice` 决定点哪一个（默认 `deny`）：

- `deny`：拒绝。验收不需要通知权限，而授予之后**横幅会随时盖在屏幕上**，
  把截图与录屏的判据搅浑（"这一帧里为什么多了个横幅"）。
- `allow`：`MEMOH_ALERT_CHOICE=allow` 时给授权，留给真要看授权之后行为的场景。

## 用法

    system-alerts.py decide --ocr <textdump.json> [--choice deny|allow]
    system-alerts.py self-test        # 判据的回归，用合成 OCR 数据，不碰设备

`--ocr` 吃的是 `verification/ui/textdump.swift` 的 JSON（它有每个文本块的归一化
`x` / `y`）。输出是给 shell 用的 JSON：`{"kind": ..., "button": ..., "x": ..., "y": ...}`。
"""
import argparse
import json
import pathlib
import re
import sys

# 标题句式 → 这是哪一类权限框。`kind` 只用于日志与证据文件名。
TITLES = (
    ('notifications', re.compile(r'would like to send you notifications', re.I)),
    ('camera', re.compile(r'would like to access the camera', re.I)),
    ('microphone', re.compile(r'would like to access the microphone', re.I)),
    ('photos', re.compile(r'would like to (access|add to) your photos', re.I)),
    ('location', re.compile(r'would like to use your (current )?location', re.I)),
    ('contacts', re.compile(r'would like to access your contacts', re.I)),
    ('tracking', re.compile(r'would like to track your activity', re.I)),
)

# 没在表里的权限框也要能认出来：只要句式对，就算"系统在问权限"。
GENERIC_TITLE = re.compile(r'(would like to|wants to) (access|send|use|track)', re.I)

# 按钮文案。**顺序就是优先级**（`Allow` 必须排在 `Allow While Using App` 之后吗？
# 不必——匹配是整行相等的，不是子串，所以两者不会互相冒充）。
DENY_BUTTONS = ("Don't Allow", "Don't Allow Once", "Deny", "Never", 'Not Now', 'Cancel')
ALLOW_BUTTONS = (
    'Allow While Using App',
    'Allow Once',
    'Allow Full Access',
    'Always Allow',
    'Allow',
    'OK',
    'Continue',
)

# 按钮离标题多远还算"这个框上的按钮"（占屏比例）。系统框的按钮紧贴标题下方；
# 更远的同名单词大概率是 App 自己的界面。
MAX_BUTTON_DISTANCE = 0.35

# 同一段文字里，两行的纵向间距超过这个值就不当成同一段（标题会被 OCR 拆行，见下）。
MAX_PARAGRAPH_GAP = 0.06

# 一个标题最多由几行拼成（连续的那几行）。
#
# 为什么必须封顶（2026-09-16 实测）：一开始写成"纵向相邻的一路拼下去"（不封顶），
# 结果调试页每行的间距都小于阈值，整页文字被粘成**一段**——匹配到的"标题"是一大坨
# （y 落在页顶），于是按钮的纵向距离失去意义（0.59 的按钮离 0.11 的"标题"太远）→
# 读不到按钮 → **明明该点却不点**。系统框的标题在真机上是 1~2 行，3 行是留的余量。
MAX_TITLE_LINES = 3

# 拼标题时，两行之间最多允许跳过几行。
#
# 为什么需要"跳过"：系统框浮在 App 上面，底下的界面文字会被 OCR 一起读进来，而且会
# **插在标题的两半之间**（实测 `01-alert-up.png`：`non` 正好夹在
# `"Memoh" Would Like to Send` 与 `You Notifications` 之间）。只认"严格相邻的两行"
# 会被它切断，又退回泛匹配（`kind` 写成 `permission`）。
MAX_TITLE_SKIP = 2


def normalize(text):
    """OCR 的弯引号 / 空白要归一，否则 `Don’t Allow` 认不出来。"""
    return re.sub(r'\s+', ' ', text.replace('\u2019', "'").replace('\u2018', "'")).strip()


def _lines(payload):
    out = []
    for entry in payload.get('lines') or []:
        text = normalize(entry.get('text') or '')
        if not text:
            continue
        out.append(
            {
                'text': text,
                'x': float(entry.get('x') or 0.0),
                'y': float(entry.get('y') or 0.0),
            }
        )
    return out


def _title_candidates(lines):
    """可能的"标题"行：**每一行，连同它下面紧邻的若干行**（`MAX_PARAGRAPH_GAP` 内、最多
    `MAX_TITLE_LINES` 行）。

    为什么要拼：Vision 会把一行标题拆成两行。实测通知框读出来是

        y=0.430  "Memoh" Would Like to Send
        y=0.456  You Notifications

    只按单行匹配的话，`would like to send you notifications` 一条都命不中，退化成
    `GENERIC_TITLE` 的 `would like to send`——框还是认出来了、也点掉了，但 `kind` 是错的
    （日志与证据里写着 `permission` 而不是 `notifications`）：判据里"认得出是哪一类"这一半
    会悄悄失效。

    为什么**必须**带上相邻行、而不是只拼"刚好挨着的那两行"：系统框是浮在 App 上面的，
    底下的界面文字会被一起读进来（实测 `01-alert-up.png` 里 `non` 插在标题两半之间）。
    严格相邻的话标题就被插进来的那行切断了，又退回泛匹配。

    为什么封顶（见 `MAX_TITLE_LINES`）：一开始写成"纵向相邻的一路拼下去"（不封顶），
    结果调试页每行间距都小于阈值，整页被粘成一段，匹配到的"标题"落在页顶——按钮的纵向
    距离随之失去意义，变成"认得出框却读不到按钮"，也就是**该点却不点**。
    """
    ordered = sorted(lines, key=lambda entry: entry['y'])

    def joined(items):
        return {'text': ' '.join(item['text'] for item in items), 'x': items[0]['x'], 'y': items[0]['y']}

    # ① 单行：最干净，先试它。
    for entry in ordered:
        yield {'text': entry['text'], 'x': entry['x'], 'y': entry['y']}
    # ② 连续 2~MAX_TITLE_LINES 行：标题被拆成相邻的几行。
    for size in range(2, MAX_TITLE_LINES + 1):
        for index in range(len(ordered) - size + 1):
            window = ordered[index:index + size]
            if window[-1]['y'] - window[0]['y'] <= MAX_PARAGRAPH_GAP:
                yield joined(window)
    # ③ 两头两行、中间允许跳过最多 MAX_TITLE_SKIP 行：系统框是浮在 App 上面的，下面的界面
    #    文字会被 OCR 一起读进来，而且**插在标题两半之间**——实测那个位置上是 `non`，
    #    于是 ② 拼出来的句子变成 `…Send non You Notifications`，具体那一条又命不中。
    for index, entry in enumerate(ordered):
        for offset in range(2, MAX_TITLE_SKIP + 2):
            if index + offset >= len(ordered):
                break
            later = ordered[index + offset]
            if later['y'] - entry['y'] > MAX_PARAGRAPH_GAP:
                break
            yield joined([entry, later])


def find_alert(payload, choice='deny'):
    """返回决定：`{'kind', 'button', 'x', 'y'}`；没弹窗时 `kind` 是 None。"""
    lines = _lines(payload)
    candidates = list(_title_candidates(lines))
    title = None
    title_kind = None
    # 两趟：**先认具体的**（`notifications` / `camera` …），再退到"某个权限框"。
    # 一趟下来先撞上哪个算哪个的话，短窗里的泛匹配会盖掉长窗里的具体匹配。
    for kind, pattern in TITLES:
        for entry in candidates:
            if pattern.search(entry['text']):
                title, title_kind = entry, kind
                break
        if title is not None:
            break
    if title is None:
        for entry in candidates:
            if GENERIC_TITLE.search(entry['text']):
                title, title_kind = entry, 'permission'
                break
    if title is None:
        return {'kind': None, 'button': None, 'x': None, 'y': None, 'title': None}

    wanted = DENY_BUTTONS if choice != 'allow' else ALLOW_BUTTONS
    candidates = []
    for entry in lines:
        if entry['text'] not in wanted:
            continue
        distance = abs(entry['y'] - title['y'])
        if distance > MAX_BUTTON_DISTANCE:
            continue
        candidates.append((wanted.index(entry['text']), distance, entry))
    if not candidates:
        # 认出了系统框，却找不到要点的按钮：**不猜**。调用方会把这件事说成失败，
        # 而不是随便点一下屏幕（那正是"没弹窗时点到 App 上"的成因）。
        return {
            'kind': title_kind,
            'button': None,
            'x': None,
            'y': None,
            'title': title['text'],
        }
    _, _, button = sorted(candidates, key=lambda item: (item[0], item[1]))[0]
    # **整数百分比**：Maestro 的 `tapOn.point` 把百分号前那段按整数解析，写 `59.31%` 会在
    # 点击那一刻抛 `NumberFormatException: For input string: "59.31"`（2026-09-16 验收实测：
    # "看见才点"这条路一直没真的点出去过）。四舍五入的误差最多半个百分点≈2pt，按钮远比这个大。
    return {
        'kind': title_kind,
        'button': button['text'],
        'x': int(round(button['x'] * 100)),
        'y': int(round(button['y'] * 100)),
        'title': title['text'],
    }


def self_test():
    """判据的回归：合成 OCR 数据，不碰设备也不碰网络。

    这几个用例都是**真的会踩到的形态**：正常的系统框、标题被 OCR 拆成两行、
    标题在但按钮读不出、以及"界面上有 Allow 字样但没有系统框"（审批面板）——
    最后一条正是"不能只认单词"。
    """
    def payload(*items):
        return {'lines': [{'text': t, 'x': x, 'y': y} for t, x, y in items]}

    alert = payload(
        ('"Memoh" Would Like to Send You Notifications', 0.5, 0.44),
        ('Notifications may include alerts, sounds, and icon badges.', 0.5, 0.5),
        ("Don't Allow", 0.3, 0.58),
        ('Allow', 0.7, 0.58),
    )
    # 真机上 Vision 读出来的样子（2026-09-16，`01-alert-up.png`）：标题被拆成两行，
    # 而且底下的界面文字**插在中间**（`non`）。
    split_alert = payload(
        ('"Memoh" Would Like to Send', 0.462, 0.430),
        ('non', 0.069, 0.443),
        ('You Notifications', 0.342, 0.456),
        ('ansv', 0.073, 0.468),
        ('Notifications may include alerts，', 0.450, 0.488),
        ("Don't Allow", 0.317, 0.593),
        ('Allow', 0.685, 0.594),
    )
    cases = [
        ("认得出通知框，并挑「Don't Allow」", find_alert(alert), ('notifications', "Don't Allow")),
        (
            '允许模式下挑「Allow」',
            find_alert(alert, choice='allow'),
            ('notifications', 'Allow'),
        ),
        (
            '**标题被 OCR 拆成两行**也要认出是哪一类（并按整数百分比给坐标）',
            find_alert(split_alert),
            ('notifications', "Don't Allow"),
        ),
        (
            '标题在、按钮没读出来 → 不点',
            find_alert(payload(('Would Like to Access the Camera', 0.5, 0.45))),
            ('camera', None),
        ),
        (
            'App 自己的 Allow / Deny（审批面板）→ 不认成系统框',
            find_alert(
                payload(
                    ('Waiting for your approval', 0.5, 0.3),
                    ('Allow', 0.7, 0.8),
                    ('Deny', 0.3, 0.8),
                )
            ),
            (None, None),
        ),
        (
            '离标题太远的同名按钮不认',
            find_alert(
                payload(
                    ('Would Like to Use Your Current Location', 0.5, 0.2),
                    ('Allow While Using App', 0.5, 0.95),
                )
            ),
            ('location', None),
        ),
        (
            '弯引号要认（Don’t Allow）',
            find_alert(payload(('Would Like to Access Your Contacts', 0.5, 0.4), ('Don\u2019t Allow', 0.3, 0.52))),
            ('contacts', "Don't Allow"),
        ),
        ('空屏（什么都没有）→ 不点', find_alert(payload()), (None, None)),
    ]
    failures = 0
    for label, decision, expected in cases:
        actual = (decision['kind'], decision['button'])
        if actual != expected:
            print(f'✗ {label}：期望 {expected}，实际 {actual}')
            failures += 1
        else:
            print(f'✓ {label}')

    # 坐标必须是**整数百分比**：Maestro 的 `tapOn.point` 写 `59.31%` 会在点击那一刻抛
    # `NumberFormatException`（"看见才点"整条路会变成"发现框 → 点不出去 → 失败"）。
    for label, decision in (('通知框', find_alert(alert)), ('拆行标题', find_alert(split_alert))):
        coordinates = (decision['x'], decision['y'])
        if all(value is None or isinstance(value, int) for value in coordinates):
            print(f'✓ {label}的坐标是整数百分比 {coordinates}')
        else:
            print(f'✗ {label}的坐标不是整数百分比：{coordinates}')
            failures += 1
    print('自检通过：判据与预期一致。' if failures == 0 else f'自检失败：{failures} 项不符。')
    return 1 if failures else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    decide = sub.add_parser('decide', help='判断这一屏有没有系统框')
    decide.add_argument('--ocr', required=True, help='textdump 的输出（JSON 文件，或 - 读 stdin）')
    decide.add_argument('--choice', default='deny', choices=('deny', 'allow'))
    sub.add_parser('self-test', help='用合成数据跑判据回归')
    arguments = parser.parse_args(argv)

    if arguments.command == 'self-test':
        return self_test()

    raw = sys.stdin.read() if arguments.ocr == '-' else pathlib.Path(arguments.ocr).read_text()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise SystemExit(f'读不了 OCR 输出（{arguments.ocr}）：{error}')
    print(json.dumps(find_alert(payload, arguments.choice), ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
