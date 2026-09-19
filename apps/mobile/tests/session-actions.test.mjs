/**
 * 会话行长按动作清单的纯逻辑测试。
 *
 * 这里最值得钉的是**"哪些会话能分叉"**：这台部署上的会话一半是定时任务会话
 * （`type: 'schedule'`），而 POST `/fork` 对它们回 409
 * `only chat sessions can be forked`（实测）。清单里多列一项，用户就会吃到一次必然失败。
 *
 * 另外两个是"发出去之前就说清楚"：锚点（没有助手回复就别发请求）、标题（源标题为空时
 * 交给服务端，不编）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  forkTarget,
  forkTitle,
  isForkable,
  renamePatch,
  sessionActions,
} from '../src/features/session/actions.ts';

test('chat 会话有两项（重命名 + 分叉），其它类型只有重命名', () => {
  assert.deepEqual(
    sessionActions({ type: 'chat' }).map((action) => action.id),
    ['rename', 'fork'],
  );
  // 定时任务会话：分叉不列出来（不是列出来再置灰——桌面端也没有这个概念）。
  assert.deepEqual(
    sessionActions({ type: 'schedule' }).map((action) => action.id),
    ['rename'],
  );
  // 类型缺失时**不敢猜**：宁可只给重命名。
  assert.deepEqual(
    sessionActions({ type: undefined }).map((action) => action.id),
    ['rename'],
  );
  assert.equal(isForkable('CHAT'), true);
  assert.equal(isForkable('schedule'), false);
  assert.equal(isForkable(undefined), false);
});

test('分叉的锚点是**最近一条**助手轮次', () => {
  const turns = [
    { turn_id: 't1', role: 'user', text: '问' },
    { turn_id: 'a1', role: 'assistant', messages: [] },
    { turn_id: 't2', role: 'user', text: '再问' },
    { turn_id: 'a2', role: 'assistant', messages: [] },
  ];
  assert.equal(forkTarget(turns), 'a2');
  // 只有用户轮次：没有锚点（调用方据此说"还没有可复制的回复"，而不是发一个 400）。
  assert.equal(forkTarget([{ turn_id: 't1', role: 'user', text: '问' }]), null);
  assert.equal(forkTarget([]), null);
  // turn_id 为空的助手轮次也不当锚点。
  assert.equal(forkTarget([{ turn_id: '  ', role: 'assistant' }]), null);
});

test('分叉出来的名字：有源标题就拼，没有就交给服务端', () => {
  assert.equal(forkTitle('整理邮件', '{{title}}（分支）'), '整理邮件（分支）');
  assert.equal(forkTitle('  整理邮件  ', '{{title}}（分支）'), '整理邮件（分支）');
  // 源标题为空 → null（服务端会用它自己的默认，我们不编一个"未命名会话的分支"）。
  assert.equal(forkTitle('', '{{title}}（分支）'), null);
  assert.equal(forkTitle('   ', '{{title}}（分支）'), null);
});

test('重命名是差分的：没改 / 改成空 都不发请求', () => {
  assert.deepEqual(renamePatch('旧名', '新名'), { title: '新名' });
  assert.deepEqual(renamePatch('旧名', '  新名  '), { title: '新名' });
  assert.equal(renamePatch('同一个', '同一个'), null);
  assert.equal(renamePatch('旧名', ''), null);
  assert.equal(renamePatch('旧名', '   '), null);
});
