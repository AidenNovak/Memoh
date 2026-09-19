/**
 * 手动压缩的结论分档（`src/features/session/compaction.ts`）。
 *
 * 分档的意义全在"用户下一步做什么"上：成功要说清压了多少条；**"压不了"不是"失败"**
 * （让用户重试一件不可能成的事是最坏的文案）；没见过的错误码一律走"失败"，别猜。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../src/api/client.ts';
import {
  compactFailureOf,
  compactOutcomeOf,
  compactSummaryText,
} from '../src/features/session/compaction.ts';

test('成功：带出压掉的条数', () => {
  assert.deepEqual(compactOutcomeOf({ status: 'ok', message_count: 12, summary: '摘要' }), {
    kind: 'ok',
    messageCount: 12,
    summary: '摘要',
  });
});

test('成功但没给条数：不编"压缩了 0 条"', () => {
  const line = compactSummaryText({ kind: 'ok', messageCount: 0, summary: '' });
  assert.deepEqual(line, { key: 'sessionInfo.compact.doneNoCount' });
});

test('成功且有条数：文案带插值', () => {
  assert.deepEqual(compactSummaryText({ kind: 'ok', messageCount: 3, summary: '' }), {
    key: 'sessionInfo.compact.done',
    values: { count: 3 },
  });
});

test('服务端说"压不了"：是"不可用"而不是"失败"，并带上它给的原因', () => {
  const outcome = compactFailureOf(
    new ApiError(400, 'no compaction model available', 'compaction_model_unavailable'),
  );
  assert.deepEqual(outcome, { kind: 'unavailable', reason: 'no compaction model available' });
  assert.deepEqual(compactSummaryText(outcome), { key: 'sessionInfo.compact.unavailable' });
});

test('没见过的错误码：走"失败"，不硬套"不可用"', () => {
  const outcome = compactFailureOf(new ApiError(500, 'boom', 'some_new_code'));
  assert.deepEqual(outcome, { kind: 'failed', message: 'boom' });
});

test('401 单独一档（调用方据此回登录页）', () => {
  assert.deepEqual(compactFailureOf(new ApiError(401, 'expired')), { kind: 'unauthorized' });
});

test('网络异常也算失败，且带出原因', () => {
  assert.deepEqual(compactFailureOf(new ApiError(0, 'Network request failed')), {
    kind: 'failed',
    message: 'Network request failed',
  });
});
