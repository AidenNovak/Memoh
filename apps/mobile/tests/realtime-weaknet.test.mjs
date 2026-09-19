/**
 * 弱网行为测试。
 *
 * ## 为什么是"跑真实客户端 + 真实固定服务端"
 *
 * 弱网下的毛病（无退避重连风暴、黑洞链路永远发现不了、空洞不节流、掉线期间发的消息
 * 先于订阅出去）**都不在界面上留下痕迹**：界面看起来一切正常，内容是旧的。凭空想
 * 想不出它们，靠"等 40 秒看看"又不现实。
 *
 * 所以这一组是：`src/api/realtime.ts`（App 真正跑的那个类）+ `server.mjs`
 * 的**服务端故障注入**。中间没有"模拟层"——坏网络是服务端演出来的，客户端走的
 * 是完全真实的代码路径。时间参数被压到几十毫秒（`timing`），所以整套不到 10 秒。
 *
 * 每条用例针对的都是一个**实测过的症状**，症状写在用例里。
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import {
  SESSION,
  attemptIntervals,
  makeClient,
  scenarioFlap,
  scenarioGap,
  scenarioHang,
  scenarioRecovery,
  scenarioSendWhileDown,
  scenarioSilent,
  scenarioUnauthorized,
  sleep,
  startFixture,
} from '../verification/fixture/netlab.mjs';

/** 把"几秒的事"压成"几十毫秒的事"，好让这些时序用例真的能被跑。 */
const FAST = {
  baseDelayMs: 60,
  maxDelayMs: 400,
  connectTimeoutMs: 80,
  heartbeatMs: 60,
  livenessGraceMs: 40,
  stableConnectionMs: 300,
  resubscribeCooldownMs: 400,
};

let fixture;

before(async () => {
  // 18400：避开验收（18099）、自检（18199）、实验台（18299）。
  fixture = await startFixture(18400);
});

after(() => {
  fixture?.stop();
});

describe('弱网', () => {
  test('握手成功就断：重连必须退避，而不是每秒一次', async () => {
    // 症状（实测 15s / 默认参数）：14 次连接，间隔恒定 1.08s——因为 `onopen` 无条件
    // 把退避清零，"连上了"被当成"连好了"。网关接受后又掐掉时就是这个形状。
    const { log, intervals } = await scenarioFlap(fixture, { listenMs: 1_200, timing: FAST });

    assert.ok(log.connections >= 2, `应当重试，实际连接 ${log.connections} 次`);
    assert.ok(log.connections < 8, `重连次数过多，像是退避没生效：${log.connections} 次`);
    const last = intervals.at(-1) ?? 0;
    const first = intervals[0] ?? 0;
    assert.ok(last > first, `退避没有增长：间隔 ${intervals.join(', ')}`);
  });

  test('黑洞链路（接受了但永不出声）：必须自己发现并重连', async () => {
    // 症状（实测 40s / 默认参数）：状态一直是 open，心跳发了 2 次、收到的帧 0 个，
    // 客户端毫无反应——NAT 静默丢包不会发 TCP close，用户对着永远不更新的界面。
    const { trace, log, subscribes } = await scenarioSilent(fixture, {
      listenMs: 700,
      timing: FAST,
    });

    assert.ok(subscribes >= 1, '心跳（重订阅）应当发出去过');
    assert.equal(trace.snapshots, 0, '这一条验的是"没有回音"的情形，不该收到 snapshot');
    assert.ok(
      trace.errors.some((message) => message.includes('心跳没有回音')),
      `应当判定死链，实际错误：${JSON.stringify(trace.errors)}`,
    );
    assert.ok(log.connections >= 2, `判定死链后应当换一条连接，实际 ${log.connections} 次`);
  });

  test('建连没有任何回调：必须有超时，不能永远停在 connecting', async () => {
    // 症状（实测 15s / 默认参数）：状态恒为 connecting、零事件。而 `connect()` 见到
    // connecting 就返回，于是此后所有发送都被静默排队——用户以为已经发出去了。
    const { trace, state, created } = await scenarioHang(fixture, { listenMs: 500, timing: FAST });

    assert.ok(
      trace.errors.some((message) => message.includes('建连超时')),
      `应当报建连超时，实际：${JSON.stringify(trace.errors)}`,
    );
    assert.notEqual(state, 'connecting', '超时后不该还停在 connecting');
    assert.ok(created >= 2, `超时后应当重试，实际只建了 ${created} 条`);
  });

  test('seq 空洞：要告诉界面，也要节流（一次空洞不等于可以猛订阅）', async () => {
    // 症状（实测 4s / 默认参数）：38 次订阅——服务端只要持续"快照与 delta 对不上"，
    // 一条 delta 一次重订阅就成了订阅风暴。而界面上什么都没说。
    //
    // 心跳也是订阅，所以把心跳拉长到不会混进计数里（默认 30s 的心跳在 1.5s 的窗口里
    // 本来也只发一次；这里用 1s 保持同样的量级）。
    const { trace, subscribes } = await scenarioGap(fixture, {
      listenMs: 1_500,
      timing: { ...FAST, heartbeatMs: 1_000, livenessGraceMs: 200, resubscribeCooldownMs: 400 },
    });

    assert.ok(trace.gaps.length >= 1, '空洞必须报告给界面（否则就是假装连续）');
    assert.ok(
      trace.gaps.every((reason) => reason.includes('gap')),
      `gap 原因：${trace.gaps[0]}`,
    );
    assert.ok(
      subscribes <= 6,
      `重新订阅没有被节流：1.5s 内订阅了 ${subscribes} 次（冷却期 400ms，心跳另算）`,
    );
    assert.ok(subscribes >= 2, '空洞之后必须真的重新订阅（否则恢复不了）');
  });

  test('掉线期间发消息：重连后必须先订阅、再发消息', async () => {
    // 症状（实测）：重连后补发的消息比订阅先出队。发消息的连接**收不到正文**
    // （正文只发给订阅了这个会话的连接），所以顺序反了这一轮跑的正文可能一帧都收不到。
    const { frames, log, pendingAfterSend, pendingAtEnd } = await scenarioSendWhileDown(fixture, {
      listenMs: 1_200,
      readyMs: 300,
      // 退避比"发现掉线"慢一点，这一句才真的落在掉线期间（否则它会直接发出去）。
      // 心跳也会发订阅，拉长到 1s 让它别混进"帧序"里（默认 30s）。
      timing: { ...FAST, baseDelayMs: 300, heartbeatMs: 1_000, livenessGraceMs: 200 },
    });

    assert.equal(pendingAfterSend, 1, '掉线时那条消息应当进队列（而不是假装已送达）');
    assert.equal(pendingAtEnd, 0, '重连后队列应当被补发出去');
    assert.equal(
      log.frames.filter((frame) => frame.type === 'message').length,
      1,
      '那条消息应当只送达一次（invocation_id 幂等，但不能重复发）',
    );
    assert.deepEqual(
      frames.slice(0, 2),
      ['runtime_subscribe', 'message'],
      `同一个连接上的帧序不对：${JSON.stringify(frames.slice(0, 4))}`,
    );
  });

  test('凭据失效（握手 401）：确认之后不再重连，状态说成"登录已过期"', async () => {
    // 症状：401 和"网断了"在客户端看起来一模一样（都是一次没升成 101 的失败），
    // 于是 token 没了也每秒重试，界面一直说"正在重连"——等下去永远好不了。
    const { state, log, trace } = await scenarioUnauthorized(fixture, {
      listenMs: 600,
      timing: FAST,
      probeAuth: async () => true,
    });

    assert.equal(state, 'unauthorized', `状态应当是 unauthorized，实际 ${state}`);
    assert.equal(log.connections, 1, `确认凭据失效后不该再连，实际 ${log.connections} 次`);
    assert.ok(
      trace.errors.some((message) => message.includes('401')),
      `应当留下原因：${JSON.stringify(trace.errors)}`,
    );
  });

  test('握手失败但问不出凭据问题：照旧退避重试（宁可多试，不要误判成掉登录）', async () => {
    const { log } = await scenarioUnauthorized(fixture, {
      listenMs: 600,
      timing: FAST,
      probeAuth: async () => false,
    });

    assert.ok(log.connections >= 2, '问不出"凭据被拒"时应当继续重试');
    assert.ok(log.connections < 8, `仍然要退避，实际 ${log.connections} 次`);
  });

  test('网络恢复：探测到"从不通到通"就立刻重连，不等满退避', async () => {
    // 症状：用户从电梯里出来时退避已经涨到十几秒，网络其实早好了。
    const timing = { ...FAST, baseDelayMs: 2_000, maxDelayMs: 8_000 };
    const { log, intervals, recoverAfterMs } = await scenarioRecovery(fixture, {
      listenMs: 1_500,
      recoverAfterMs: 400,
      probeIntervalMs: 30,
      timing,
    });

    assert.ok(log.connections >= 2, '恢复后应当重连');
    const secondAttemptDelay = intervals[0] ?? Number.POSITIVE_INFINITY;
    assert.ok(
      secondAttemptDelay < recoverAfterMs + 400,
      `网络在 ${recoverAfterMs}ms 回来，却在 ${secondAttemptDelay}ms 才重连（退避 ${timing.baseDelayMs}ms 没被提前打断）`,
    );
  });

  test('用户点"重试"：立刻建连，不等退避', async () => {
    // 界面上的状态条是可点的（"现在再试一次"是弱网下用户最想做的事）。退避已经涨到
    // 几秒的时候，这一次点击必须立刻换一条连接——否则那个按钮就是安慰剂。
    await fixture.fault('refuse');
    const { realtime } = makeClient({
      base: fixture.base,
      timing: { ...FAST, baseDelayMs: 3_000, maxDelayMs: 8_000 },
    });
    realtime.connect();
    await sleep(300); // 首连已经失败，正在等 3s 的退避
    const before = (await fixture.log()).connections;
    realtime.retryNow();
    await sleep(200);
    const after = (await fixture.log()).connections;
    realtime.dispose();
    await fixture.fault('normal');

    assert.ok(
      after > before,
      `点重试之后应当立刻再连一次（退避 3000ms 还没到）：${before} → ${after}`,
    );
  });

  test('同一个会话不会同时有两条连接（建连只有一个入口）', async () => {
    // 症状（实测）：掉线期间点一次发送 → 立刻建一条新连接 → 排队的重连定时器到点
    // 又建一条，服务端看到 3 条连接，其中一条成了没人回收的野连接。
    await fixture.fault('unauthorized'); // 一条永远失败但要耗时的路
    const { realtime } = makeClient({
      base: fixture.base,
      timing: { ...FAST, baseDelayMs: 500, maxDelayMs: 2_000 },
    });
    realtime.connect();
    realtime.subscribe(SESSION);
    await sleep(150);
    // 退避期间再"发一句 + 再订阅一次"——以前这会抢跑建连，并把已经排队的定时器留在
    // 那里，于是服务端看到两条连接（其中一条没人回收）。
    realtime.sendMessage({ sessionId: SESSION, text: '退避期间发的' });
    realtime.subscribe(SESSION);
    await sleep(550);
    const log = await fixture.log();
    realtime.dispose();
    await fixture.fault('normal');

    assert.equal(
      log.connections,
      2, // 1 次首连 + 1 次到点的重连
      `退避期间的操作不该建新连接，实际 ${log.connections} 次（间隔 ${attemptIntervals(log).join(', ')}）`,
    );
    assert.equal(realtime.connectionState, 'closed', 'dispose 之后应当是 closed');
  });
});
