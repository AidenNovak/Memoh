/**
 * 审批回应的帧参数（`src/features/chat/approval.ts`）。
 *
 * 这一份钉的是**发出去的那一帧长什么样**，不是界面：
 *
 * 1. agent 定义了选项 → 回 `option_id`；没定义 → 回 `decision`（我们造的兜底 id 服务端匹配不到）；
 * 2. 空理由**不能**变成一个字段（`reason: ''` 会被当成"一条空理由"记进上下文，比不说更糟）；
 * 3. 哪些选项算"拒绝"——只有它才该先问一句理由。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { approvalResponseFor, isRejectChoice } from '../src/features/chat/approval.ts';

test('agent 定义的选项：回 option_id，不带 decision', () => {
  assert.deepEqual(approvalResponseFor('allow_once'), { optionId: 'allow_once' });
  assert.deepEqual(approvalResponseFor('reject_always'), { optionId: 'reject_always' });
});

test('兜底动作：回 decision，**不带**那个假 id', () => {
  assert.deepEqual(approvalResponseFor('__fallback_approve__'), { decision: 'approve' });
  assert.deepEqual(approvalResponseFor('__fallback_reject__'), { decision: 'reject' });
});

test('拒绝时理由随帧发出（两端都 trim）', () => {
  assert.deepEqual(approvalResponseFor('reject_once', '  别删 docs/，改成写新文件 '), {
    optionId: 'reject_once',
    reason: '别删 docs/，改成写新文件',
  });
  assert.deepEqual(approvalResponseFor('__fallback_reject__', '太危险'), {
    decision: 'reject',
    reason: '太危险',
  });
});

test('空理由 / 只有空白 → 帧里**没有** reason 这个键', () => {
  for (const reason of ['', '   ', '\n\t']) {
    const frame = approvalResponseFor('reject_once', reason);
    assert.equal('reason' in frame, false, `${JSON.stringify(reason)} 不该产生 reason`);
  }
  // 不传第三个参数也一样（老调用点的形状）。
  assert.equal('reason' in approvalResponseFor('reject_once'), false);
});

test('哪些选项算"拒绝"', () => {
  assert.equal(isRejectChoice({ id: 'reject_once', tone: 'reject' }), true);
  assert.equal(isRejectChoice({ id: '__fallback_reject__' }), true, '兜底拒绝没有 tone，认 id');
  assert.equal(isRejectChoice({ id: 'allow_once', tone: 'allow' }), false);
  assert.equal(isRejectChoice({ id: '__fallback_approve__' }), false);
  assert.equal(isRejectChoice({ id: 'weird', tone: 'neutral' }), false);
  assert.equal(isRejectChoice({ id: '__fallback_something__' }), false, '认不出的兜底当成非拒绝');
});
