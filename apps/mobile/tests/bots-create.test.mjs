/**
 * 新建 bot 的纯逻辑契约（`src/features/bots/create.ts`）。
 *
 * 每一条断言都对应一个"写错了也不明显"的规则：slug 与服务端的一致性、名字四态、
 * 请求体只发填了的字段、轮询节奏与超时、以及"建成了但设置失败不算创建失败"。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOT_NAME_SHAPE,
  CREATE_TIMEOUT_MS,
  DEFAULT_ACL_PRESET,
  RESERVED_BOT_NAMES,
  buildCreatePayload,
  canSubmit,
  createTimedOut,
  emptyBotForm,
  localNameProblem,
  nameStatusFromReason,
  pollDelayMs,
  phaseFor,
  slugifyBotName,
} from '../src/features/bots/create.ts';

test('slug：与服务端规则一致（小写、连字符、去首尾、48 位截断）', () => {
  assert.equal(slugifyBotName('My Bot'), 'my-bot');
  assert.equal(slugifyBotName('  周报助手  '), '');
  assert.equal(slugifyBotName('Research Agent 2'), 'research-agent-2');
  assert.equal(slugifyBotName('--weird__name--'), 'weird-name');
  assert.equal(slugifyBotName('a'.repeat(80)).length, 48);
  // 中文名 slug 化后为空 → 界面必须让用户自己填一个 URL 名
  assert.equal(slugifyBotName('助手'), '');
});

test('名字形状：与服务端的正则一字不差', () => {
  assert.ok(BOT_NAME_SHAPE.test('ab'));
  assert.ok(!BOT_NAME_SHAPE.test('a')); // 至少 2 位
  assert.ok(BOT_NAME_SHAPE.test('a-1'));
  assert.ok(!BOT_NAME_SHAPE.test('-ab')); // 首字符不能是连字符
  assert.ok(!BOT_NAME_SHAPE.test('Ab')); // 不能有大写
  assert.ok(!BOT_NAME_SHAPE.test('a_b'));
  assert.ok(!BOT_NAME_SHAPE.test('a'.repeat(64)));
});

test('本地先判：保留字与形状不符不必问服务端', () => {
  for (const reserved of RESERVED_BOT_NAMES) {
    assert.equal(localNameProblem(reserved), 'reserved', reserved);
  }
  assert.equal(localNameProblem('My Bot'), 'invalid');
  assert.equal(localNameProblem('ok-name'), null);
  assert.equal(localNameProblem(''), null);
});

test('服务端 reason → 四态（认不出来时给 invalid，不放行）', () => {
  assert.equal(nameStatusFromReason(true, 'available'), 'available');
  assert.equal(nameStatusFromReason(false, 'taken'), 'taken');
  assert.equal(nameStatusFromReason(false, 'reserved'), 'reserved');
  assert.equal(nameStatusFromReason(false, 'invalid'), 'invalid');
  assert.equal(nameStatusFromReason(false, 'something-new'), 'invalid');
  // 自相矛盾的组合（available=true 但 reason 不是 available）也不放行
  assert.equal(nameStatusFromReason(true, 'taken'), 'taken');
});

test('能不能提交：名字必须**校验通过**，不只是非空', () => {
  const base = { ...emptyBotForm(), displayName: '周报助手', name: 'weekly-report' };
  assert.equal(canSubmit(base), false, '还没校验时不能提交');
  assert.equal(canSubmit({ ...base, nameStatus: 'checking' }), false);
  assert.equal(canSubmit({ ...base, nameStatus: 'taken' }), false);
  assert.equal(canSubmit({ ...base, nameStatus: 'available' }), true);
  assert.equal(canSubmit({ ...base, nameStatus: 'available', displayName: '  ' }), false);
  assert.equal(canSubmit({ ...base, nameStatus: 'available', submitting: true }), false);
  assert.equal(canSubmit({ ...base, nameStatus: 'available', aclPreset: '' }), false);
});

test('请求体：空的可选项不发送，默认档位照桌面给 allow_all', () => {
  const form = { ...emptyBotForm(), displayName: ' 周报助手 ', name: 'weekly-report' };
  assert.deepEqual(buildCreatePayload(form), {
    name: 'weekly-report',
    display_name: '周报助手',
    is_active: true,
    acl_preset: DEFAULT_ACL_PRESET,
  });
  // 不该出现 wait_for_ready：iOS 走"先建再轮询"，同步等待会让客户端先超时
  assert.equal('wait_for_ready' in buildCreatePayload(form), false);

  const filled = {
    ...form,
    avatarUrl: ' https://example.com/a.png ',
    timezone: 'Asia/Shanghai',
    aclPreset: 'private_only',
  };
  assert.deepEqual(buildCreatePayload(filled), {
    name: 'weekly-report',
    display_name: '周报助手',
    is_active: true,
    acl_preset: 'private_only',
    avatar_url: 'https://example.com/a.png',
    timezone: 'Asia/Shanghai',
  });
});

test('轮询状态机：creating → ready，deleting 是失败', () => {
  assert.deepEqual(phaseFor('creating', 3), { phase: 'creating', polls: 3 });
  assert.deepEqual(phaseFor('ready', 3), { phase: 'ready' });
  assert.deepEqual(phaseFor('deleting', 1), { phase: 'failed', reason: 'deleting' });
  // 认不出来的状态当成"还在建"：宁可多轮询几次，也别把建着的 bot 说成失败
  assert.deepEqual(phaseFor('weird', 0), { phase: 'creating', polls: 0 });
});

test('轮询节奏：先快后慢，且封顶 5s', () => {
  assert.ok(pollDelayMs(0) < pollDelayMs(3));
  assert.equal(pollDelayMs(4), 5000);
  assert.equal(pollDelayMs(99), 5000, '越界不能变成 undefined');
  assert.equal(pollDelayMs(-1), 800, '负数也不能崩');
});

test('超时是 5 分钟（与服务端流式那条路一致）', () => {
  assert.equal(createTimedOut(CREATE_TIMEOUT_MS - 1), false);
  assert.equal(createTimedOut(CREATE_TIMEOUT_MS), true);
});
