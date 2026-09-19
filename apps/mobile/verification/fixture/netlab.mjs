#!/usr/bin/env node
/**
 * 弱网实验台。
 *
 * ## 它验的是什么
 *
 * 弱网下的毛病（连不上一直重连、断了不告诉用户、空洞被当成连续、掉线期间发的消息
 * 到底发出去没有）**都不在界面上留下痕迹**：界面看起来一切正常，内容是旧的。
 * 所以它们只能靠"把对面弄坏，然后看客户端每一毫秒做了什么"来验。
 *
 * 这个脚本 import 的是 **App 自己的源码**（`src/api/realtime.ts`），不是另写一遍
 * 逻辑；对面是可以注入故障的固定服务端（`server.mjs` 的 `/__ws-fault`）。两边都是
 * 真实实现，中间没有"模拟层"——坏网络是**服务端**扮演的。
 *
 * ## 两种用法
 *
 * - 直接跑（人看）：打印带时间戳的轨迹，用来判断"这个行为合不合理"。
 * - 被 `tests/realtime-weaknet.test.mjs` import：把同一批场景变成断言。
 *
 * 用法：
 *     node verification/fixture/netlab.mjs            # 全部场景
 *     node verification/fixture/netlab.mjs flap hang  # 只跑某几个
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import WS from 'ws';

import { MemohRealtime } from '../../src/api/realtime.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'server.mjs');
/** 固定服务端里那个"一直在跑"的会话（见 `server.mjs` 的 `sceneForSession`）。 */
export const SESSION = 'fixture-session-active';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 起一个可以注入故障的固定服务端。
 
 端口默认 18299：刻意避开验收用的 18099 与自检用的 18199，好几个人（和好几条脚本）
 同时跑的时候不会互相打断。
 */
export async function startFixture(port = 18299) {
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SERVER, '--port', String(port)], { stdio: 'ignore' });
  const stop = () => child.kill();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`${base}/bots`);
      return {
        base,
        port,
        stop,
        /** 换故障模式（`normal` 关掉）。默认**把观测台归零**：每个场景的计数必须是自己那次。 */
        fault: (mode, options = {}) =>
          fetch(`${base}/__ws-fault`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              reset: options.reset !== false,
              ...(typeof mode === 'string' ? { mode } : mode),
            }),
          }).then((response) => response.json()),
        /** 把所有活着的连接掐掉。 */
        drop: () =>
          fetch(`${base}/__ws-drop`, { method: 'POST' }).then((response) => response.json()),
        /** 连接数、每次升级尝试的时刻、客户端帧的顺序。 */
        log: () => fetch(`${base}/__ws-log`).then((response) => response.json()),
      };
    } catch {
      await sleep(100);
    }
  }
  child.kill();
  throw new Error(`固定服务端没能在 :${port} 上起来`);
}

/** 用 `ws` 建连（它支持 headers）。RN 那侧是全局 WebSocket，形状一样。 */
export const wsFactory = (url, token) =>
  new WS(url, { headers: { Authorization: `Bearer ${token}` } });

/**
 造一个客户端，并把它的每一次状态变化/帧计数记下来。
 
 弱网下"界面看起来正常"和"真的正常"的区别就在这几条里：状态轨迹、收到的帧数、
 `gap` 事件（界面有没有被告诉"这段可能不全"）、连接层错误。
 */
export function makeClient({
  base,
  timing,
  socketFactory = wsFactory,
  probe,
  probeAuth,
  probeIntervalMs,
  token = 'fixture-token',
  now = () => Date.now(),
} = {}) {
  const trace = {
    states: [],
    gaps: [],
    errors: [],
    snapshots: 0,
    deltas: 0,
    lastFrameAt: null,
  };
  const realtime = new MemohRealtime({
    baseUrl: base,
    botId: 'fixture-bot',
    getToken: () => token,
    createSocket: socketFactory,
    timing,
    probe,
    probeAuth,
    probeIntervalMs,
    listener: {
      onStateChange: (state) => trace.states.push({ state, at: now() }),
      onSnapshot: () => {
        trace.snapshots += 1;
        trace.lastFrameAt = now();
      },
      onDelta: () => {
        trace.deltas += 1;
        trace.lastFrameAt = now();
      },
      onGap: (_sessionId, reason) => trace.gaps.push(reason),
      onError: (error) => trace.errors.push(error.message),
    },
  });
  return { realtime, trace };
}

/** 轨迹里某个状态出现过吗。 */
export const sawState = (trace, state) => trace.states.some((entry) => entry.state === state);

/** 两次升级尝试之间的间隔（毫秒）。 */
export function attemptIntervals(log) {
  return log.attempts.slice(1).map((at, index) => at - log.attempts[index]);
}

// ---------------------------------------------------------------- 场景

/**
 握手成功就断（代理/网关的典型行为）。
 
 看的是**重连节奏**：一看到 `open` 就把退避清零的话，这里会变成"每秒一次、永不增长"
 的无限重连——弱网下就是一台不断往网上砸包的机器。
 */
export async function scenarioFlap(fixture, options = {}) {
  const { listenMs = 15_000 } = options;
  await fixture.fault('flap');
  const { realtime, trace } = makeClient({ base: fixture.base, timing: options.timing });
  realtime.connect();
  await sleep(listenMs);
  realtime.dispose();
  const log = await fixture.log();
  await fixture.fault('normal');
  return { trace, log, intervals: attemptIntervals(log) };
}

/**
 黑洞：对面接受了握手，然后永远不出声、也不断。
 
 NAT/运营商静默丢包就是这个形状：**没有任何 TCP close**，所以客户端不会触发重连。
 唯一的办法是自己保活，并检查"保活有没有得到回音"。
 */
export async function scenarioSilent(fixture, options = {}) {
  const { listenMs = 40_000 } = options;
  await fixture.fault('silent');
  const { realtime, trace } = makeClient({ base: fixture.base, timing: options.timing });
  realtime.connect();
  realtime.subscribe(SESSION);
  await sleep(listenMs);
  const log = await fixture.log();
  const state = realtime.connectionState;
  realtime.dispose();
  await fixture.fault('normal');
  return {
    trace,
    log,
    state,
    subscribes: log.frames.filter((f) => f.type === 'runtime_subscribe').length,
  };
}

/**
 建连没有任何回调。
 
 连接建立要有超时：没有超时的话，弱网下界面会永远停在"连接中"，而且因为
 `connect()` 见到 connecting 就返回，后续所有发送都被塞进队列——用户看到的是
 "发出去了"，实际上一个字节都没出去。
 */
export async function scenarioHang(fixture, options = {}) {
  const { listenMs = 15_000 } = options;
  let created = 0;
  const dead = () => {
    created += 1;
    return { readyState: 0, send() {}, close() {} };
  };
  const { realtime, trace } = makeClient({
    base: fixture.base,
    timing: options.timing,
    socketFactory: dead,
  });
  realtime.connect();
  await sleep(listenMs);
  const state = realtime.connectionState;
  realtime.dispose();
  return { trace, state, created };
}

/** 发一半就断：run 跑到中途网没了。 */
export async function scenarioPartial(fixture, options = {}) {
  const { listenMs = 6_000 } = options;
  await fixture.fault('partial');
  const { realtime, trace } = makeClient({ base: fixture.base, timing: options.timing });
  realtime.connect();
  realtime.subscribe(SESSION);
  await sleep(listenMs);
  const state = realtime.connectionState;
  realtime.dispose();
  const log = await fixture.log();
  await fixture.fault('normal');
  return { trace, log, state };
}

/** seq 空洞（服务端明确不做补齐，客户端只能重新要 snapshot）。 */
export async function scenarioGap(fixture, options = {}) {
  const { listenMs = 4_000 } = options;
  await fixture.fault('gap');
  const { realtime, trace } = makeClient({ base: fixture.base, timing: options.timing });
  realtime.connect();
  realtime.subscribe(SESSION);
  await sleep(listenMs);
  realtime.dispose();
  const log = await fixture.log();
  await fixture.fault('normal');
  return { trace, log, subscribes: log.subscribes[SESSION] ?? 0 };
}

/** 换 epoch：seq 从 0 重来，本地用旧 epoch 攒的游标全部作废。 */
export async function scenarioEpoch(fixture, options = {}) {
  const { listenMs = 4_000 } = options;
  await fixture.fault('epoch');
  const { realtime, trace } = makeClient({ base: fixture.base, timing: options.timing });
  realtime.connect();
  realtime.subscribe(SESSION);
  await sleep(listenMs);
  realtime.dispose();
  const log = await fixture.log();
  await fixture.fault('normal');
  return { trace, log, subscribes: log.subscribes[SESSION] ?? 0 };
}

/**
 掉线期间发一条消息。
 
 两个问题：① 这句话会不会丢；② 重连后是**先订阅还是先发消息**（协议要求先订阅——
 正文只发给订阅了这个会话的连接，而补发的消息会立刻起一轮新的 run）。
 */
export async function scenarioSendWhileDown(fixture, options = {}) {
  const { listenMs = 4_000 } = options;
  await fixture.fault('normal');
  const { realtime, trace } = makeClient({ base: fixture.base, timing: options.timing });
  realtime.connect();
  realtime.subscribe(SESSION);
  await sleep(options.readyMs ?? 1_000);

  await fixture.drop();
  // 等客户端真的发现掉了（状态离开 open）再发：不然这一句会在**还连着的**连接上
  // 发出去，验不到"掉线期间发"这条路径。
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (realtime.connectionState !== 'open') break;
    await sleep(10);
  }
  const invocationId = realtime.sendMessage({ sessionId: SESSION, text: '弱网下发的这句' });
  const pendingAfterSend = realtime.pendingCount;
  await sleep(listenMs);

  const log = await fixture.log();
  const lastConnection = log.connections;
  const frames = log.frames.filter((frame) => frame.conn === lastConnection).map((f) => f.type);
  const pendingAtEnd = realtime.pendingCount;
  realtime.dispose();
  return { trace, log, frames, invocationId, pendingAfterSend, pendingAtEnd };
}

/**
 token 失效（握手回 401）。
 
 客户端看到的是"一次没升成 101 的失败"，和断网长得一模一样——但处置完全相反：
 断网要重试，凭据没了重试到天亮也没用。所以这里要的是**停止重连**并且把状态说成
 `unauthorized`（界面据此让用户去重新登录，而不是让他等）。
 */
export async function scenarioUnauthorized(fixture, options = {}) {
  const { listenMs = 2_000 } = options;
  await fixture.fault({ mode: 'unauthorized', tokenRejected: true });
  const { realtime, trace } = makeClient({
    base: fixture.base,
    timing: options.timing,
    probeAuth: options.probeAuth,
  });
  realtime.connect();
  await sleep(listenMs / 2);
  const logHalf = await fixture.log();
  await sleep(listenMs / 2);
  const state = realtime.connectionState;
  const log = await fixture.log();
  realtime.dispose();
  await fixture.fault({ mode: 'normal', tokenRejected: false });
  return { trace, log, logHalf, state, intervals: attemptIntervals(log) };
}

/**
 退避期间网络回来。
 
 这是"从电梯里出来"的那一刻：退避可能已经涨到十几秒了，但网络其实已经好了。
 探测（`probe`）通了就该立刻重连，而不是把这一轮退避等满。
 */
export async function scenarioRecovery(fixture, options = {}) {
  const { listenMs = 4_000, recoverAfterMs = 500 } = options;
  await fixture.fault('unauthorized'); // 握手永远失败，但主机是通的（模拟"服务端不认这条路"）
  const startedAt = Date.now();
  const { realtime, trace } = makeClient({
    base: fixture.base,
    timing: options.timing,
    probeIntervalMs: options.probeIntervalMs ?? 40,
    // 网络在 `recoverAfterMs` 之前是不通的（探测失败），之后回到通。
    probe: options.probe ?? (async () => Date.now() - startedAt >= recoverAfterMs),
  });
  realtime.connect();
  await sleep(listenMs);
  const log = await fixture.log();
  realtime.dispose();
  await fixture.fault('normal');
  return { trace, log, intervals: attemptIntervals(log), recoverAfterMs };
}

// ---------------------------------------------------------------- 实验模式

const scenarios = {
  flap: scenarioFlap,
  silent: scenarioSilent,
  hang: scenarioHang,
  partial: scenarioPartial,
  gap: scenarioGap,
  epoch: scenarioEpoch,
  send: scenarioSendWhileDown,
  unauthorized: scenarioUnauthorized,
  recovery: scenarioRecovery,
};

/** 只有直接跑这个文件时才执行（被 import 时什么都不做）。 */
const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const arguments_ = process.argv.slice(2);
  function flag(name, fallback) {
    const index = arguments_.indexOf(`--${name}`);
    return index === -1 ? fallback : arguments_[index + 1];
  }
  const port = Number(flag('port', '18299'));
  const wanted = arguments_.filter((value, index) => {
    if (value === '--port') return false;
    return index === 0 || arguments_[index - 1] !== '--port';
  });
  const fixture = await startFixture(port);
  const start = Date.now();
  const note = (text) =>
    console.log(`        ${String(Date.now() - start).padStart(7)}ms  ${text}`);

  try {
    for (const name of wanted.length > 0 ? wanted : Object.keys(scenarios)) {
      const run = scenarios[name];
      if (run === undefined) {
        console.log(`未知场景：${name}`);
        continue;
      }
      console.log(`\n— ${name} —`);
      const result = await run(fixture);
      note(`状态轨迹：${stateSequence(result.trace)}`);
      note(`结果：${JSON.stringify(summary(name, result))}`);
    }
  } finally {
    fixture.stop();
  }
  process.exit(0);
}

/** 状态轨迹压成 "connecting×1 open×14 reconnecting×15"，人看的是**形状**。 */
function stateSequence(trace) {
  const counts = [];
  for (const entry of trace.states) {
    const last = counts.at(-1);
    if (last !== undefined && last.state === entry.state) last.count += 1;
    else counts.push({ state: entry.state, count: 1 });
  }
  return counts.map((entry) => `${entry.state}×${entry.count}`).join(' ');
}

/** 实验模式下打印的摘要（字段太多的对象只挑结论）。 */
function summary(name, result) {
  switch (name) {
    case 'flap':
      return { attempts: result.log.connections, intervals: result.intervals };
    case 'silent':
      return {
        state: result.state,
        subscribes: result.subscribes,
        snapshots: result.trace.snapshots,
        attempts: result.log.connections,
        errors: result.trace.errors,
      };
    case 'hang':
      return { state: result.state, created: result.created, errors: result.trace.errors };
    case 'partial':
      return {
        state: result.state,
        snapshots: result.trace.snapshots,
        deltas: result.trace.deltas,
        gaps: result.trace.gaps.length,
        subscribes: result.log.subscribes,
      };
    case 'gap':
      return { gaps: result.trace.gaps.length, subscribes: result.subscribes };
    case 'epoch':
      return {
        snapshots: result.trace.snapshots,
        deltas: result.trace.deltas,
        subscribes: result.subscribes,
      };
    case 'send':
      return { frames: result.frames, pendingAfterSend: result.pendingAfterSend };
    case 'unauthorized':
      return {
        state: result.state,
        attempts: result.log.connections,
        intervals: result.intervals,
        errors: result.trace.errors,
      };
    case 'recovery':
      return {
        attempts: result.log.connections,
        intervals: result.intervals,
        attemptsAfterRecovery: result.log.attempts.filter(
          (at) => at - result.trace.states[0].at > result.recoverAfterMs,
        ).length,
      };
    default:
      return result;
  }
}
