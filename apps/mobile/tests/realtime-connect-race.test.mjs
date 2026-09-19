/**
 * 建连窗口里的两条不变量（2026-09-18，从一条间歇红里挖出来的）。
 *
 * ## 症状与根因
 *
 * `pnpm test` 偶发 708/709，失败信息
 * `uncaughtException: WebSocket was closed before the connection was established`，
 * 栈是 `WebSocket.close → dropSocket → declareDeadLink → livenessTimer 回调`。
 * 拆开是两条独立的问题，**各自都能单独要命**：
 *
 * 1. **判死链判的是"没发出去的探针"。** `beat()` 先 `subscribe()`（探针）再武装回音
 *    期限，但 `send()` 在 socket 不是 OPEN 时**根本不发**（`readyState !== 1` 就只
 *    记账 + `connect()`）。而 `declareDeadLink()` 不关心跳：黑洞链路上判死一次之后，
 *    心跳仍在跑，于是重连窗口里的一次心跳会给一条**还没连上**的链路判死刑——
 *    `livenessGraceMs` 之后 `this.socket !== null`（新的那条还在 CONNECTING）、
 *    `lastInboundAt` 是旧 socket 的 ⇒ 判定"心跳没有回音" ⇒ 掐掉一条可能马上就通的
 *    连接。真机上的代价不是测试红，是**慢网重连被反复掐死**。
 * 2. **`dropSocket()` 在 CONNECTING 上 close。** 它先把 `onopen/onmessage/onerror/onclose`
 *    全摘成 `null` 再 `close()`；而 `ws` 对 CONNECTING 的 socket 会在**下一个 tick
 *    异步 emit `'error'`**（`abortHandshake` 走 `process.nextTick`）——那时监听器已经没了
 *    ⇒ 未捕获异常。**外面那个 `try/catch` 抓不到**，因为错误不是同步抛的。
 *    建连超时（`armConnectTimeout`）与 `dispose()` 同样会在 CONNECTING 上 close。
 *
 * ## 两条为什么用两种造法
 *
 * - 第 1 条验的是**客户端自己的判定逻辑**（探针到底发出去没有），所以用替身 socket
 *   把"第一条 OPEN、重连那条永远 CONNECTING"钉死，不依赖任何网络时序；
 * - 第 2 条验的是 **`ws` 的语义**，所以用真库 + 一个**接了 TCP 但永不完成 WS 握手**的
 *   服务端，socket 永远停在 CONNECTING。
 *
 * 用固定服务端的 `silent` 场景两条都验不了：它是"接受握手但永不出声"，socket 会变成
 * OPEN，于是只能在"握手恰好慢过判定"的窗口里偶发命中（实测单跑 10 次红 2 次）。
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';

import WS from 'ws';

import { MemohRealtime } from '../src/api/realtime.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 心跳/回音期限压到几十毫秒：让判定落在 CONNECTING 窗口里。 */
const RACE_TIMING = { heartbeatMs: 30, livenessGraceMs: 30, baseDelayMs: 40, maxDelayMs: 60 };

function makeClient(base, errors, overrides = {}) {
  return new MemohRealtime({
    baseUrl: base,
    botId: 'race-bot',
    getToken: () => 'race-token',
    timing: { ...RACE_TIMING, ...overrides.timing },
    probe: async () => true,
    probeIntervalMs: 1_000,
    createSocket:
      overrides.createSocket ??
      ((url, token) => new WS(url, { headers: { Authorization: `Bearer ${token}` } })),
    listener: {
      onStateChange: () => {},
      onSnapshot: () => {},
      onDelta: () => {},
      onGap: () => {},
      onError: (error) => errors.push(error.message),
    },
  });
}

/** 替身 socket：第一条 OPEN（心跳起得来），之后的重连**永远停在 CONNECTING**。 */
function fakeSocketSequence() {
  const sockets = [];
  const create = () => {
    const socket = {
      readyState: sockets.length === 0 ? 1 : 0, // WebSocket.OPEN / CONNECTING
      sent: [],
      send(frame) {
        this.sent.push(frame);
      },
      close() {},
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    sockets.push(socket);
    // 客户端的心跳是在 `onopen` 里起的，所以第一条要真的"开"起来。
    if (socket.readyState === 1) setTimeout(() => socket.onopen?.(), 0);
    return socket;
  };
  return { sockets, create };
}

test('重连窗口里 socket 还没 OPEN：心跳不许给一条没连上的链路判死链', async () => {
  const { sockets, create } = fakeSocketSequence();
  const errors = [];
  const realtime = makeClient('http://127.0.0.1:1', errors, {
    createSocket: create,
    timing: { connectTimeoutMs: 5_000 },
  });

  try {
    realtime.connect();
    realtime.subscribe('race-session');
    // 心跳 30ms：第一条 OPEN 的那条会在 ~30ms 发出探针、~60ms 被判死链；
    // 之后每次心跳都落在"重连那条还在 CONNECTING"的窗口里（跑到 400ms 够好几轮）。
    await sleep(400);

    const verdicts = errors.filter((message) => message.includes('心跳没有回音'));
    assert.equal(
      verdicts.length,
      1,
      `只该给真正发过探针的那条链路判一次死链，实际 ${verdicts.length} 次：${JSON.stringify(errors)}`,
    );
    assert.ok(sockets.length >= 2, `判死链之后应当换过一条连接（实际 ${sockets.length} 条）`);
    assert.equal(sockets[1].readyState, 0, '第二条应当一直停在 CONNECTING（这是本用例的前提）');
  } finally {
    realtime.dispose();
  }
});

/** 接了 TCP 就什么都不做：不回握手、不断开——socket 永远停在 CONNECTING。 */
async function neverUpgradingServer() {
  const sockets = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

test('close 一个还在 CONNECTING 的 socket：不许变成未捕获异常', async () => {
  const server = await neverUpgradingServer();
  const errors = [];
  const realtime = makeClient(`http://127.0.0.1:${server.port}`, errors, {
    // 建连超时留大：本用例要验的是"close 一个 CONNECTING 的 socket"这件事本身，
    // 而不是它由哪条路径触发（心跳判定、建连超时、dispose 都走同一个 dropSocket）。
    timing: { connectTimeoutMs: 5_000 },
  });

  try {
    realtime.connect();
    realtime.subscribe('race-session');
    await sleep(150);
    assert.deepEqual(
      errors.filter((message) => message.includes('心跳没有回音')),
      [],
      `探针在 CONNECTING 上根本没发出去，不该判"心跳没有回音"；实际：${JSON.stringify(errors)}`,
    );
  } finally {
    // dispose 也会 close 这条 CONNECTING 的 socket——未捕获异常会在这里炸出来。
    realtime.dispose();
    await sleep(50);
    await server.close();
  }
});
