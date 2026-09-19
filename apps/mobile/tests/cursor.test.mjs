/**
 * 序号校验与重连策略的测试。
 *
 * 这些用例钉死的是"静默丢内容"这类最难在真机上发现的 bug：seq 错一格、epoch
 * 变了还在合并、重复帧被当成新内容。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONNECT_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  LIVENESS_GRACE_MS,
  RECONNECT_MAX_MS,
  RESUBSCRIBE_COOLDOWN_MS,
  STABLE_CONNECTION_MS,
  isStableConnection,
  judgeClose,
  judgeDelta,
  judgeSnapshot,
  nextAttempt,
  reconnectDelay,
  shouldResubscribe,
} from '../src/api/cursor.ts';
import { realtimeUrl } from '../src/api/realtime.ts';

test('realtimeUrl 拼出完整的 bot 路径', () => {
  // 这个断言来自一次真实故障：漏掉 bot 段会连到根路径拿 404，
  // 而现象看起来像"连接不稳"（一直重连），排查成本很高。
  assert.equal(
    realtimeUrl('http://127.0.0.1:18080', 'abc-123'),
    'ws://127.0.0.1:18080/bots/abc-123/web/ws',
  );
});

test('realtimeUrl 处理 https 与末尾斜杠', () => {
  assert.equal(
    realtimeUrl('https://memoh.example.com/', 'bot-1'),
    'wss://memoh.example.com/bots/bot-1/web/ws',
  );
  assert.equal(
    realtimeUrl('https://memoh.example.com///', 'bot-1'),
    'wss://memoh.example.com/bots/bot-1/web/ws',
  );
});

test('realtimeUrl 对 bot id 做转义', () => {
  assert.equal(realtimeUrl('http://x', 'a/b'), 'ws://x/bots/a%2Fb/web/ws');
});

test('连续帧被应用，游标前进', () => {
  const verdict = judgeDelta({ epoch: 'e1', seq: 41 }, { epoch: 'e1', seq: 42 });
  assert.equal(verdict.action, 'apply');
  assert.deepEqual(verdict.cursor, { epoch: 'e1', seq: 42 });
});

test('重复帧被丢弃', () => {
  assert.equal(judgeDelta({ epoch: 'e1', seq: 42 }, { epoch: 'e1', seq: 42 }).action, 'drop');
  assert.equal(judgeDelta({ epoch: 'e1', seq: 42 }, { epoch: 'e1', seq: 41 }).action, 'drop');
});

test('seq 空洞触发重新订阅', () => {
  const verdict = judgeDelta({ epoch: 'e1', seq: 10 }, { epoch: 'e1', seq: 12 });
  assert.equal(verdict.action, 'resubscribe');
  assert.match(verdict.reason, /seq gap 10 → 12/);
});

test('epoch 变化触发重新订阅，不跨 epoch 比较 seq', () => {
  // seq 看起来是连续的，但 epoch 变了就是重建。
  const verdict = judgeDelta({ epoch: 'e1', seq: 10 }, { epoch: 'e2', seq: 11 });
  assert.equal(verdict.action, 'resubscribe');
  assert.equal(verdict.reason, 'epoch changed');
});

test('还没收到 snapshot 就收到 delta → 重新订阅', () => {
  const verdict = judgeDelta({ epoch: null, seq: 0 }, { epoch: 'e1', seq: 1 });
  assert.equal(verdict.action, 'resubscribe');
  assert.equal(verdict.reason, 'delta before snapshot');
});

test('snapshot 直接覆盖游标，包括比本地更旧的情况', () => {
  // 服务端换 epoch 后 seq 从 0 重来，本地 seq 可能比它大——这不是"旧帧"。
  assert.deepEqual(judgeSnapshot({ epoch: 'e2', seq: 0 }), { epoch: 'e2', seq: 0 });
  assert.deepEqual(judgeSnapshot({ epoch: 'e1', seq: 43 }), { epoch: 'e1', seq: 43 });
});

test('心跳间隔在代理超时之内', () => {
  // 仓库 nginx 对这条路径的 proxy_read_timeout 是 300s。
  assert.ok(HEARTBEAT_INTERVAL_MS < 300_000);
  assert.ok(HEARTBEAT_INTERVAL_MS >= 15_000, '太频繁会给服务端添无谓的负载');
});

test('重连退避指数增长并有上限', () => {
  const noJitter = () => 0;
  assert.equal(reconnectDelay(1, noJitter), 1_000);
  assert.equal(reconnectDelay(2, noJitter), 2_000);
  assert.equal(reconnectDelay(3, noJitter), 4_000);
  assert.equal(reconnectDelay(10, noJitter), RECONNECT_MAX_MS);
  assert.equal(reconnectDelay(50, noJitter), RECONNECT_MAX_MS);
});

test('重连退避带抖动，且抖动不超过 20%', () => {
  const min = reconnectDelay(3, () => 0);
  const max = reconnectDelay(3, () => 1);
  assert.equal(min, 4_000);
  assert.equal(max, 4_800);
});

/**
 * 握手成功 ≠ 链路可用。
 *
 * 网关接受握手后又掐掉（代理过载、后端处理器崩掉）时，如果一看到 `open` 就把退避
 * 清零，就变成每秒一次、永不增长的重连——实测 15s 内 14 次，间隔恒定 1.08s。
 */
test('刚连上就断的连接不算"稳定"，退避要继续增长', () => {
  assert.equal(isStableConnection(null, 1_000), false, '从没连上过');
  assert.equal(isStableConnection(1_000, 1_000 + STABLE_CONNECTION_MS - 1), false);
  assert.equal(isStableConnection(1_000, 1_000 + STABLE_CONNECTION_MS), true);

  // 活着很久再断 → 退避清零（下一次失败从 1s 重新开始）
  assert.equal(nextAttempt(7, true), 1);
  // 刚连上就断 → 继续累加
  assert.equal(nextAttempt(1, false), 2);
  assert.equal(nextAttempt(5, false), 6);
});

test('退避上限要短到"网络恢复后用户等得起"', () => {
  assert.ok(RECONNECT_MAX_MS <= 30_000, '上限太大 = 网络回来了还要干等');
  assert.ok(CONNECT_TIMEOUT_MS > 0 && CONNECT_TIMEOUT_MS <= 15_000, '建连超时要在用户能忍的范围内');
  assert.ok(LIVENESS_GRACE_MS > 0 && LIVENESS_GRACE_MS < HEARTBEAT_INTERVAL_MS);
});

/**
 * 401 和"网断了"是两件事：一个要重新登录，一个要重试。
 *
 * RN 把原生失败原因放在 close 事件的 `reason` 上（error 事件本身没有 message），
 * iOS 的描述形如 `Expected HTTP 101 response but was '401 Unauthorized'`。判定就靠
 * 这段文本里的 4xx——**注意不能取"第一个三位数"**，因为那段话里还带着 101。
 */
test('close 事件里读得出 401/403：不再重试', () => {
  const unauthorized = judgeClose({
    code: 1006,
    reason: "Expected HTTP 101 response but was '401 Unauthorized'",
  });
  assert.equal(unauthorized.action, 'stop');
  assert.equal(unauthorized.kind, 'auth');

  assert.equal(judgeClose({ code: 1006, reason: 'HTTP 403 forbidden' }).kind, 'auth');
});

test('其余 4xx 是"这条路没了"，也不是重试能解决的', () => {
  const gone = judgeClose({
    code: 1006,
    reason: 'Expected HTTP 101 response but was 404 Not Found',
  });
  assert.equal(gone.action, 'stop');
  assert.equal(gone.kind, 'permanent');
});

test('断网/超时/服务端 5xx 一律重试', () => {
  assert.equal(judgeClose({ code: 1006, reason: '' }).action, 'retry');
  assert.equal(
    judgeClose({ code: 1006, reason: 'connect ECONNREFUSED 127.0.0.1:18099' }).action,
    'retry',
  );
  assert.equal(judgeClose({ code: 1006, reason: 'request timed out' }).action, 'retry');
  // 101 单独出现不能被当成"对面拒了我们"
  assert.equal(judgeClose({ code: 1006, reason: 'Expected HTTP 101 response' }).action, 'retry');
  assert.equal(judgeClose({ code: 1006, reason: 'HTTP 503 Service Unavailable' }).action, 'retry');
  // 1008 = policy violation：升级之后被服务端拒掉
  assert.equal(judgeClose({ code: 1008, reason: 'permission denied' }).kind, 'auth');
});

/**
 * 重新订阅必须节流。
 *
 * 服务端如果持续处于"snapshot 与 delta 对不上"的状态，一条 delta 一次重订阅就是
 * 订阅风暴——实测 4s 内对同一个会话订阅了 38 次。
 */
test('重新订阅有冷却期', () => {
  assert.equal(shouldResubscribe(null, 10_000), true, '第一次总是允许');
  assert.equal(shouldResubscribe(10_000, 10_000), false);
  assert.equal(shouldResubscribe(10_000, 10_000 + RESUBSCRIBE_COOLDOWN_MS - 1), false);
  assert.equal(shouldResubscribe(10_000, 10_000 + RESUBSCRIBE_COOLDOWN_MS), true);
});

test('心跳能保活，但重新订阅要更克制', () => {
  // 心跳是"每 30s 一次"，重新订阅是"空洞之后的恢复手段"——后者更花钱（要 snapshot），
  // 所以它的冷却期不该比心跳还短。
  assert.ok(RESUBSCRIBE_COOLDOWN_MS >= 1_000);
  assert.ok(RESUBSCRIBE_COOLDOWN_MS < HEARTBEAT_INTERVAL_MS);
});
