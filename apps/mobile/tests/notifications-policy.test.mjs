/**
 * 通知判据层（`src/features/notifications/policy.ts`）。
 *
 * 这一组测试盯的是**打扰用户的判据**，不是文案措辞。判据错了的形态不是崩溃，而是
 * "App 在冷启动拦你一次、被拒之后又缠你一次、同一件事提醒你三遍"——每一条都让用户
 * 关掉整个 App 的通知，而且关掉之后很难挽回。
 *
 * 所以这里钉四件事：
 *
 * 1. **什么时候不请求权限**（冷启动、被拒、冷却期、已授权）；
 * 2. **什么事件不该打扰**（前台、正在看的那个会话、未授权）；
 * 3. **提醒的紧急度如实**（失败**不是** Time Sensitive）；
 * 4. **文案 key 真的存在**（两语都有）——通知文案漏 key 时用户看到的是
 *    `notification.approval.title` 这种原始键名，而它只会在真机推送到达时暴露。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_EXPLICIT_REQUESTS,
  NEVER_NOTIFY,
  NOTIFICATION_EVENTS,
  REQUEST_COOLDOWN_MS,
  badgeCountFor,
  deliveryFor,
  interruptionLevelFor,
  payloadFor,
  permissionActionFor,
  threadIdFor,
  EVENT_COPY,
} from '../src/features/notifications/policy.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES = join(HERE, '..', 'locales');

const NOW = 1_760_000_000_000;

/** 默认：没问过、没决定。 */
const FRESH = { status: 'notDetermined', askedCount: 0, lastAskedAt: null };

// ---------------------------------------------------------------- 权限时机

test('冷启动不请求权限：系统框要在用户理解价值之后才出现', () => {
  assert.equal(permissionActionFor(FRESH, 'cold_start', NOW), 'nothing');
});

test('上下文里才请求：第一次遇到"有任务等你批准"时问', () => {
  assert.equal(permissionActionFor(FRESH, 'first_approval', NOW), 'ask');
});

test('用户主动点"开启通知"时请求', () => {
  assert.equal(permissionActionFor(FRESH, 'user_asked', NOW), 'ask');
});

test('已授权 / 试探授权：都不要再问', () => {
  for (const status of ['authorized', 'ephemeral', 'provisional']) {
    assert.equal(
      permissionActionFor({ status, askedCount: 1, lastAskedAt: NOW }, 'user_asked', NOW),
      'nothing',
      status,
    );
  }
});

test('被拒之后系统不会再弹框：只有用户主动要，才给一条去系统设置的路', () => {
  const denied = { status: 'denied', askedCount: 1, lastAskedAt: NOW - REQUEST_COOLDOWN_MS - 1 };
  assert.equal(permissionActionFor(denied, 'user_asked', NOW), 'open_system_settings');
  // **不缠着用户**：被拒之后再遇到待审批、再冷启动，都不该提这件事。
  assert.equal(permissionActionFor(denied, 'first_approval', NOW), 'nothing');
  assert.equal(permissionActionFor(denied, 'cold_start', NOW), 'nothing');
});

test('请求次数封顶：问够了就不再问，只留系统设置入口', () => {
  const asked = {
    status: 'notDetermined',
    askedCount: MAX_EXPLICIT_REQUESTS,
    lastAskedAt: NOW - REQUEST_COOLDOWN_MS - 1,
  };
  assert.equal(permissionActionFor(asked, 'user_asked', NOW), 'open_system_settings');
  assert.equal(permissionActionFor(asked, 'first_approval', NOW), 'nothing');
});

test('冷却期内不重复问：今天拒了明天再问一遍等于缠人', () => {
  const recent = { status: 'notDetermined', askedCount: 1, lastAskedAt: NOW - 1000 };
  assert.equal(permissionActionFor(recent, 'user_asked', NOW), 'nothing');
  // 冷却期过了、次数没到顶，才允许再问一次。
  const old = {
    status: 'notDetermined',
    askedCount: 1,
    lastAskedAt: NOW - REQUEST_COOLDOWN_MS - 1,
  };
  assert.equal(permissionActionFor(old, 'user_asked', NOW), 'ask');
});

// ---------------------------------------------------------------- 该不该打扰

const BASE = { isForeground: false, visibleSessionId: null, eventSessionId: 's1' };

test('没授权就没什么可发的：系统不会显示，我们也不该假装发了', () => {
  for (const status of ['notDetermined', 'denied']) {
    assert.equal(deliveryFor('approval_waiting', { ...BASE, status }), 'drop', status);
  }
});

test('后台收到：三条事件都交给系统发', () => {
  for (const event of NOTIFICATION_EVENTS) {
    assert.equal(deliveryFor(event, { ...BASE, status: 'authorized' }), 'notify', event);
  }
});

test('前台不弹横幅：审批改为在界面上接住，其他两条直接丢掉', () => {
  const foreground = { ...BASE, status: 'authorized', isForeground: true };
  assert.equal(deliveryFor('approval_waiting', foreground), 'in_app');
  assert.equal(deliveryFor('run_finished', foreground), 'drop');
  assert.equal(deliveryFor('run_failed', foreground), 'drop');
});

test('正在看的那个会话不用再强调：审批 panel 就在眼前', () => {
  const watching = {
    ...BASE,
    status: 'authorized',
    isForeground: true,
    visibleSessionId: 's1',
  };
  assert.equal(deliveryFor('approval_waiting', watching), 'drop');
});

// ---------------------------------------------------------------- 内容与紧急度

test('紧急度如实：只有"现在正在等你"才是 Time Sensitive，失败不是', () => {
  assert.equal(interruptionLevelFor('approval_waiting'), 'timeSensitive');
  assert.equal(interruptionLevelFor('run_finished'), 'active');
  assert.equal(interruptionLevelFor('run_failed'), 'active');
});

test('同一会话的通知归到同一个线程，不同会话分开', () => {
  const a1 = payloadFor('approval_waiting', { sessionId: 's1', botName: 'memoh' });
  const a2 = payloadFor('run_finished', { sessionId: 's1', botName: 'memoh' });
  const b = payloadFor('run_finished', { sessionId: 's2', botName: 'memoh' });
  assert.equal(a1.threadId, a2.threadId);
  assert.notEqual(a1.threadId, b.threadId);
  assert.equal(a1.threadId, threadIdFor('s1'));
});

test('审批通知带审批分类（不进 App 也要能批），其余带 run 分类', () => {
  const approval = payloadFor('approval_waiting', { sessionId: 's1', botName: 'memoh' });
  assert.equal(approval.category, 'approval');
  assert.equal(payloadFor('run_finished', { sessionId: 's1', botName: 'memoh' }).category, 'run');
  assert.equal(payloadFor('run_failed', { sessionId: 's1', botName: 'memoh' }).category, 'run');
});

test('通知文案的 key 两语都在：漏了的话用户看到的是原始键名', () => {
  const catalogs = ['en.json', 'zh-Hans.json'].map((name) =>
    JSON.parse(readFileSync(join(LOCALES, name), 'utf8')),
  );
  const keys = new Set();
  for (const event of NOTIFICATION_EVENTS) {
    const payload = payloadFor(event, { sessionId: 's1', botName: 'memoh' });
    keys.add(payload.titleKey);
    keys.add(payload.bodyKey);
    keys.add(EVENT_COPY[event].titleKey);
    keys.add(EVENT_COPY[event].subtitleKey);
  }
  for (const catalog of catalogs) {
    for (const key of keys) {
      assert.ok(typeof catalog[key] === 'string' && catalog[key] !== '', `缺文案：${key}`);
    }
  }
});

// ---------------------------------------------------------------- 徽标

test('徽标是"有多少条在等你处理"，不是会话数；归零就是归零', () => {
  assert.equal(badgeCountFor(3), 3);
  assert.equal(badgeCountFor(0), 0);
  assert.equal(badgeCountFor(-1), 0);
  assert.equal(badgeCountFor(Number.NaN), 0);
  assert.equal(badgeCountFor(2.7), 2);
});

// ---------------------------------------------------------------- 封闭集合

test('事件集合是封闭的：界面列出的三条与文案映射的键完全一致', () => {
  assert.deepEqual([...NOTIFICATION_EVENTS].sort(), Object.keys(EVENT_COPY).sort());
});

test('明确不发的东西写在案：营销与流式 token 都不在事件集合里', () => {
  const ids = NEVER_NOTIFY.map((item) => item.id);
  assert.ok(ids.includes('marketing'));
  assert.ok(ids.includes('stream_tokens'));
  // 每条都要写明代价，否则它只是口号。
  for (const item of NEVER_NOTIFY) assert.ok(item.why.length > 20, item.id);
  // 事件集合里不该出现营销类事件（HIG：营销要单独同意，且不许 Time Sensitive）。
  assert.equal(
    NOTIFICATION_EVENTS.some((event) => event.includes('marketing')),
    false,
  );
});
