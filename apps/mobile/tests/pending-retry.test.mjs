/**
 * `run_rejected.code` 的用法：**能不能原样重试**是服务端说了算，不是默认给按钮。
 *
 * 之前 `pending.ts` 只要 `failure !== null` 就无条件给"重试"，于是服务端用一个
 * **明确不可重试**的 code 拒了这次提交（同一个 `invocation_id` 换了内容、会话类型
 * 不允许、权限不够…）时，界面照样给按钮，用户点下去得到同一个拒绝——正是
 * `features/errors/present.ts` 自己写下的规则："给按钮等于让用户去做一件我们已经知道
 * 不会成的事"。
 *
 * 白名单的依据不是猜的，是服务端 `internal/apperror/error.go` 的目录 + 源码注释：
 *
 * - `session_runtime.session_busy`：注释原话 "ordinary backpressure and the same
 *   submission succeeds once the session frees up. It is the one conflict in this
 *   catalog that a client should retry unchanged." → **唯一**可原样重发的拒绝；
 * - `session_runtime.invocation_conflict`：注释原话 "retrying changes nothing,
 *   because the same retry identity was already used for different input." → 不给按钮。
 *
 * 这两个 code 是 `wsRunRejectionCode()` 的全部取值（`local_channel.go`），所以白名单
 * 的取值域是封闭的、可穷举的——不是"先给按钮，用户自己试"。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pendingSendView, rejectionIsRetryable } from '../src/features/chat/pending.ts';

const BASE = { unconfirmed: true, queuedLocally: false, connected: true, failure: null };

function viewFor(code, message = 'server said no') {
  return pendingSendView({
    ...BASE,
    failure: { invocationId: 'inv-1', code, message },
  });
}

test('服务端说"稍后再来"（session_busy）：给重试', () => {
  const view = viewFor('session_runtime.session_busy');
  assert.equal(view?.phase, 'failed');
  assert.equal(view?.action?.id, 'retry');
  assert.equal(view?.action?.labelKey, 'chat.pending.retry');
  assert.equal(view?.reason, 'server said no', '服务端写的原因照转达');
});

test('服务端说"重试没用"（invocation_conflict）：**不给按钮**，但话照说', () => {
  const view = viewFor(
    'session_runtime.invocation_conflict',
    'already submitted with different content',
  );
  assert.equal(view?.phase, 'failed');
  assert.equal(view?.action, null, '已知不会成的事不许给按钮');
  assert.equal(view?.reason, 'already submitted with different content');
});

test('认不出来的 code：也不给按钮（白名单是白名单）', () => {
  assert.equal(viewFor('session_runtime.some_future_code')?.action, null);
  assert.equal(rejectionIsRetryable('session_runtime.some_future_code'), false);
});

test('空 code：不当成"可重试"（协议说 run_rejected 一定带稳定 code）', () => {
  assert.equal(viewFor('')?.action, null);
  assert.equal(rejectionIsRetryable(''), false);
  assert.equal(rejectionIsRetryable('   '), false);
});

test('白名单只认那一个 code（前后空格容错，大小写不猜）', () => {
  assert.equal(rejectionIsRetryable(' session_runtime.session_busy '), true);
  assert.equal(rejectionIsRetryable('SESSION_RUNTIME.SESSION_BUSY'), false);
});

test('没有失败时那两条路径不受影响（未确认 ≠ 进行中）', () => {
  // queued：动作是**重连**（不重发），awaiting：没有动作。两者都不该被这次改动碰到。
  assert.equal(pendingSendView({ ...BASE, queuedLocally: true })?.action?.id, 'reconnect');
  assert.equal(pendingSendView(BASE)?.action, null);
});
