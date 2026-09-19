#!/usr/bin/env python3
"""断言固定服务端收到的**审批回应帧**（`GET /__last-approval-response`）。

为什么不能只看界面：点了通知上的"允许"之后，界面上"审批框消失"只说明我们自己清了状态；
真正要证的是**那一帧发出去了、且指向那次审批**。帧的落点只有服务端知道，所以这里读它。

用法（由 push-run.sh 调用）：

    python3 assert-approval.py <last-approval-response.json> --session fixture-session-untitled \
        --decision-id scene-approval-2 --decision approve
"""
import argparse
import json
import sys
from pathlib import Path


def fail(message):
    print(f'FAILED: {message}', file=sys.stderr, flush=True)
    raise SystemExit(1)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('payload', type=Path)
    parser.add_argument('--session', required=True)
    parser.add_argument('--decision-id', required=True)
    parser.add_argument('--decision', required=True, choices=['approve', 'reject'])
    parser.add_argument('--empty', action='store_true', help='断言服务端**没有**收到任何回应')
    arguments = parser.parse_args(argv)

    if not arguments.payload.exists():
        fail(f'{arguments.payload} 不存在（固定服务端没被问到？）')
    raw = arguments.payload.read_text().strip()
    frame = json.loads(raw) if raw else None
    if arguments.empty:
        if frame not in (None, {}):
            fail(f'服务端收到了回应（应当没有）：{raw[:400]}')
        print(json.dumps({'ok': True, 'received': None}, ensure_ascii=False))
        return 0

    if frame is None:
        fail(f'服务端没有收到审批回应帧（期望 decision_id={arguments.decision_id}）')

    problems = []
    if frame.get('type') != 'tool_approval_response':
        problems.append(f"type={frame.get('type')!r} 不是 tool_approval_response")
    if frame.get('session_id') != arguments.session:
        problems.append(f"session_id={frame.get('session_id')!r} ≠ {arguments.session!r}")
    if frame.get('decision_id') != arguments.decision_id:
        problems.append(f"decision_id={frame.get('decision_id')!r} ≠ {arguments.decision_id!r}")
    if frame.get('decision') != arguments.decision:
        problems.append(f"decision={frame.get('decision')!r} ≠ {arguments.decision!r}")
    # 从通知里回应审批**不许**带 option_id：agent 定义的选项表不在通知里，硬编一个等于
    # 替 agent 编一个它可能没给过的选项（服务端匹配不到，run 会一直卡着）。
    if 'option_id' in frame:
        problems.append(f"不该出现 option_id（={frame.get('option_id')!r}）")
    if problems:
        fail('；'.join(problems) + f'\n原始帧：{raw[:600]}')
    print(json.dumps({'ok': True, 'frame': frame}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
