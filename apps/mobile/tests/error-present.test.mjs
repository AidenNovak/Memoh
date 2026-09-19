/**
 * 一次失败 → 「说什么 + 给什么动作」的映射（`src/features/errors/present.ts`）。
 *
 * 这一组测试盯的是**判据**，不是文案措辞：
 *
 * - 哪些错误配得上"重试"（只有传输层那几种），哪些给重试就是在骗人；
 * - 服务端原文什么时候能上屏（只有类型化错误码在场时），什么时候永远不能。
 *
 * 这两条错了的形态都不是崩溃，而是"界面上看起来很合理但其实在撒谎"——只有测试能钉住。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../src/api/client.ts';
import { canRetry, detailOf, presentError, reasonKeyOf } from '../src/features/errors/present.ts';

test('没网：说"连不上"，给重试', () => {
  const seen = presentError(new ApiError(0, 'Network request failed'));
  assert.deepEqual(seen, { key: 'error.network', recovery: 'retry' });
  assert.equal(canRetry(seen), true);
});

test('超时不是"没网"：文案分开，但同样可以重试', () => {
  const seen = presentError(new ApiError(0, 'request timed out after 15000ms', 'timeout'));
  assert.equal(seen.key, 'error.timeout');
  assert.equal(seen.recovery, 'retry');
  // 超时的兜底 message 是英文技术句，不该跟着上屏。
  assert.equal(seen.detail, undefined);
});

test('凭据失效：说重新登录，**不给**重试', () => {
  const seen = presentError(new ApiError(401, 'expired'));
  assert.deepEqual(seen, { key: 'error.unauthorized', recovery: 'signin' });
  assert.equal(canRetry(seen), false);
});

test('5xx 与 429 可以重试', () => {
  assert.equal(canRetry(presentError(new ApiError(500, 'HTTP 500'))), true);
  assert.equal(canRetry(presentError(new ApiError(502, 'bad gateway'))), true);
  assert.equal(presentError(new ApiError(429, 'slow down')).key, 'error.rateLimited');
});

test('带类型化 code 的 5xx：服务端说了原因 → 原样上屏，且**不给重试**', () => {
  // 真实形状：编辑定时任务时另一个客户端改过这条（`schedule_write_conflict`）。
  // 重发还是同一个拒绝——给"重试"等于让用户去做一件我们已知不会成的事。
  const seen = presentError(
    new ApiError(500, 'another client changed this schedule', 'schedule_write_conflict'),
  );
  assert.deepEqual(seen, {
    key: 'error.server',
    detail: 'another client changed this schedule',
    recovery: 'none',
  });
  assert.equal(canRetry(seen), false);
  assert.equal(reasonKeyOf(seen), 'another client changed this schedule');
});

test('带 code 但 message 是状态码兜底：退回"服务器出错了 + 重试"', () => {
  // `HTTP 500` 这种兜底文案对用户是零信息（R23），所以它不算"服务端说了原因"。
  const seen = presentError(new ApiError(500, 'HTTP 500', 'internal'));
  assert.deepEqual(seen, { key: 'error.server', recovery: 'retry' });
});

test('业务拒绝（400/409/422）不给重试：同一个请求再发一次还是被拒', () => {
  for (const status of [400, 409, 422]) {
    const seen = presentError(new ApiError(status, 'nope'));
    assert.equal(seen.key, 'error.rejected', `status ${status}`);
    assert.equal(canRetry(seen), false, `status ${status}`);
  }
});

test('403 不给动作（换页或重试都不会好）', () => {
  assert.deepEqual(presentError(new ApiError(403, 'forbidden')), {
    key: 'error.forbidden',
    recovery: 'none',
  });
});

test('404 单独一档：调用方可以换成"某某不在了"的标题', () => {
  assert.deepEqual(presentError(new ApiError(404, 'not found')), {
    key: 'error.notFound',
    recovery: 'none',
  });
});

test('非 API 层的意外：不重试，也不把内部消息给用户', () => {
  const seen = presentError(new TypeError('undefined is not a function'));
  assert.deepEqual(seen, { key: 'error.unexpected', recovery: 'none' });
  assert.equal(seen.detail, undefined);
});

// ------------------------------------------------------------ 服务端原文的边界

test('有类型化错误码：原文带上（它就是原因，用户需要它）', () => {
  const seen = presentError(
    new ApiError(400, 'no compaction model available', 'compaction_model_unavailable'),
  );
  assert.equal(seen.detail, 'no compaction model available');
  assert.equal(reasonKeyOf(seen), 'no compaction model available');
});

test('没有 code：原文**不上屏**（那是给开发者看的）', () => {
  assert.equal(detailOf(new ApiError(500, 'goroutine 42 [running]: panic')), undefined);
  assert.equal(presentError(new ApiError(500, 'goroutine 42 panic')).detail, undefined);
});

test('有 code 但 message 是状态码兜底：仍然不上屏', () => {
  // 网关的 HTML 错误页 / 没有 message 字段时，`toApiError` 会拼出 "HTTP 500"。
  // 即使碰巧带着 code，这句话对用户也是零信息。
  assert.equal(detailOf(new ApiError(500, 'HTTP 500', 'internal')), undefined);
  assert.equal(detailOf(new ApiError(500, '   ', 'internal')), undefined);
  assert.equal(detailOf(new ApiError(500, 'boom', '   ')), undefined);
});

test('没有原文时，补充说明用我们自己的那一句', () => {
  const seen = presentError(new ApiError(0, 'Network request failed'));
  assert.equal(reasonKeyOf(seen), 'error.network');
});
