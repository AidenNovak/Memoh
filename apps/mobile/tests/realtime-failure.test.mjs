/**
 * 实时通道的**失败路径**。
 *
 * ## 这一份和 `realtime-weaknet.test.mjs` 的分工
 *
 * `realtime-weaknet.test.mjs` 是**端到端**的（真固定服务端 + 真 TCP），盯的是"弱网下
 * 症状会不会出现"。这一份是**单点故障注入**：用一条假 socket，把每一条错误分支单独
 * 按出来——包括那些端到端跑不到的分支（`send` 抛错、坏帧、不可序列化的帧、1008 关闭）。
 *
 * ## 为什么这些分支值得一条一条钉
 *
 * 它们全都是"坏了以后界面上什么都不显示"的类型：
 *
 * - 帧没送出去但 `pendingCount` 是 0 → 用户以为发出去了；
 * - 坏帧把连接搞崩 → 表现成"网不好"；
 * - 401 被当成"网断了" → 用户盯着"正在重连"等到天亮；
 * - `run_rejected` 没透给上层 → 那条乐观消息永远停在"等确认"。
 *
 * 断言一律写成**能当规格读**的句子（照 `session-send.test.mjs` 的写法），不用
 * `assert.ok(x)` 打天下。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemohRealtime } from '../src/api/realtime.ts';

/** 把"等一件事发生"写成有上限的等待：等不到就抛，绝不静默放行。 */
async function until(predicate, { timeoutMs = 2000, what = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`等了 ${timeoutMs}ms 也没等到：${what}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 一条假的 WebSocket。
 *
 * 只实现客户端真正用到的那四件事：`readyState`、`send`、`close`、四个回调。
 * 服务端的动作由测试显式驱动（`serverOpen` / `serverFrame` / `serverClose`），
 * 所以每条用例都是确定性的，不靠等。
 */
class FakeSocket {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.closed = false;
    /** 设成 Error 就让这一次 `send` 抛错（模拟原生层的发送失败）。 */
    this.sendError = null;
  }

  send(payload) {
    if (this.sendError !== null) throw this.sendError;
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  frames(type) {
    return this.sent.filter((frame) => frame.type === type);
  }

  // ---------------------------------------------------------- 测试驱动的服务端
  serverOpen() {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  serverFrame(frame) {
    const data = typeof frame === 'string' ? frame : JSON.stringify(frame);
    this.onmessage?.({ data });
  }

  serverClose(info = {}) {
    this.readyState = 3;
    this.onclose?.(info);
  }
}

/** 装一个实时客户端，并把所有对外信号记下来。 */
function harness(options = {}) {
  const sockets = [];
  const states = [];
  const errors = [];
  const gaps = [];
  const snapshots = [];
  const deltas = [];
  const runAccepted = [];
  const runRejected = [];
  const others = [];
  const pending = [];
  let token = Object.hasOwn(options, 'token') ? options.token : 'tok';
  let attempt = 0;

  const realtime = new MemohRealtime({
    baseUrl: 'http://x',
    botId: 'bot-1',
    getToken: () => token,
    listener: {
      onStateChange: (state) => states.push(state),
      onError: (error) => errors.push(error.message),
      onGap: (sessionId, reason) => gaps.push(reason),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onDelta: (delta) => deltas.push(delta),
      onRunAccepted: (frame) => runAccepted.push(frame),
      onRunRejected: (frame) => runRejected.push(frame),
      onOther: (frame) => others.push(frame),
      onPendingChange: (count) => pending.push(count),
    },
    createSocket: (url, tokenAtConnect) => {
      attempt += 1;
      const socket = options.socketFactory
        ? options.socketFactory(attempt, url, tokenAtConnect)
        : new FakeSocket(url, tokenAtConnect);
      sockets.push(socket);
      return socket;
    },
    timing: {
      connectTimeoutMs: 5_000,
      heartbeatMs: 5_000,
      livenessGraceMs: 5_000,
      baseDelayMs: 40,
      maxDelayMs: 80,
      stableConnectionMs: 5_000,
      resubscribeCooldownMs: 200,
      ...(options.timing ?? {}),
    },
    probe: options.probe,
    probeAuth: options.probeAuth,
    probeIntervalMs: options.probeIntervalMs ?? 10,
  });

  return {
    realtime,
    sockets,
    states,
    errors,
    gaps,
    snapshots,
    deltas,
    runAccepted,
    runRejected,
    others,
    pending,
    setToken: (value) => {
      token = value;
    },
    /** 连上并订阅一个会话——后面每条用例都从这里开始。 */
    open(sessionId = 's1') {
      realtime.connect();
      const socket = sockets.at(-1);
      socket.serverOpen();
      if (sessionId !== null) realtime.subscribe(sessionId);
      return socket;
    },
  };
}

// ---------------------------------------------------------------- 建连失败

test('没有凭据：不许建连，必须说清是凭据问题而不是"正在连"', () => {
  // 建一条注定 401 的连接只会让界面停在 connecting 上骗人。
  const h = harness({ token: null });
  try {
    h.realtime.connect();

    assert.deepEqual(h.sockets, [], '没有 token 时一次都不该连');
    assert.equal(h.realtime.connectionState, 'closed', '状态必须是 closed，不是 connecting');
    assert.deepEqual(h.errors, ['no token'], '要说清原因，否则排查时只能看到"没反应"');
  } finally {
    h.realtime.dispose();
  }
});

test('建连方式本身抛错：不许把异常冒给调用方，必须排重连', () => {
  // `createSocket` 抛错（原生层报错、header 拼错）是同步异常。冒出去会从
  // `sendMessage` 一路炸到界面；吞掉不排重连则永远不再试。
  const h = harness({
    socketFactory: (attempt, url, token) => {
      if (attempt === 1) throw new Error('socket ctor boom');
      return new FakeSocket(url, token);
    },
    timing: { baseDelayMs: 120, maxDelayMs: 200, connectTimeoutMs: 3_000 },
  });
  try {
    h.realtime.connect(); // 不许抛

    assert.equal(h.realtime.connectionState, 'reconnecting', 'ctor 失败要走重连分支');
    assert.deepEqual(h.errors, ['socket ctor boom'], '要把底层原因留下来（否则只剩"连不上"）');
  } finally {
    h.realtime.dispose();
  }
});

test('建连没有任何回调：必须判超时换连接，不能永远停在 connecting', async () => {
  // 实测 15s 零事件的网络（酒店门户 / NAT 黑洞）。停在 connecting 的后果是所有发送
  // 都被静默排队——用户以为发出去了。
  const h = harness({ timing: { connectTimeoutMs: 60, baseDelayMs: 40, maxDelayMs: 80 } });
  try {
    h.realtime.connect();
    assert.equal(h.realtime.connectionState, 'connecting');

    await until(() => h.sockets.length >= 2, { what: '超时后换一条连接' });
    assert.ok(
      h.errors.some((message) => message.includes('建连超时')),
      `应当报建连超时，实际：${JSON.stringify(h.errors)}`,
    );
    assert.notEqual(
      h.realtime.connectionState,
      'connecting',
      '超时之后不许还停在 connecting（此后所有发送都会被静默排队）',
    );
  } finally {
    h.realtime.dispose();
  }
});

test('刚连上就断不算"连好了"：第二次退避必须比第一次长', async () => {
  // 网关接受握手后立刻掐断时，退避若被清零就是**每秒一次、永不增长**的重连风暴
  // （实测 15s 内 14 次）。判据是"活够 stableConnectionMs"，不是"open 过"。
  const h = harness({
    timing: {
      baseDelayMs: 100,
      maxDelayMs: 400,
      stableConnectionMs: 1_000,
      connectTimeoutMs: 5_000,
    },
  });
  try {
    h.realtime.connect();
    h.sockets[0].serverOpen();
    const firstClosedAt = Date.now();
    h.sockets[0].serverClose({ code: 1006, reason: 'gateway hangup' });

    await until(() => h.sockets.length >= 2, { what: '第一次重连' });
    const secondAt = Date.now();
    h.sockets[1].serverOpen();
    h.sockets[1].serverClose({ code: 1006, reason: 'gateway hangup' });

    await until(() => h.sockets.length >= 3, { what: '第二次重连' });
    const thirdAt = Date.now();

    // 退避被清零时的第二次间隔 ≈ baseDelay（100–120ms）；不清零是 200–240ms。
    assert.ok(
      thirdAt - secondAt >= 170,
      `第二次退避没有增长：${thirdAt - secondAt}ms（第一次 ${secondAt - firstClosedAt}ms）——` +
        '握手成功不等于链路可用',
    );
  } finally {
    h.realtime.dispose();
  }
});

// ---------------------------------------------------------------- 出站失败

test('掉线时发送：那条帧必须进 outbox，并当场把"还欠几帧"说出来', async () => {
  // 掉线时 `sendMessage` 一样返回一个 invocation_id。不说清楚，界面就会谎报成功。
  const h = harness();
  try {
    h.realtime.sendMessage({ sessionId: 's1', text: '掉线期间发的' });

    assert.equal(h.realtime.pendingCount, 1, '掉线时那条帧必须进 outbox，不许假装送达');
    assert.deepEqual(h.pending, [1], '要立刻通知界面（那一刻连接状态并没有变化）');
  } finally {
    h.realtime.dispose();
  }
});

test('socket.send 抛错：帧必须回队列，重连后带同一个 invocation_id 补发', async () => {
  // 发送失败最坏的形态是"帧丢了但界面以为成功"。回队列 + 幂等补发是唯一安全的处理。
  const h = harness({ timing: { baseDelayMs: 200, maxDelayMs: 400, connectTimeoutMs: 5_000 } });
  try {
    const socket = h.open('s1');
    socket.sendError = new Error('send boom');

    const invocationId = h.realtime.sendMessage({ sessionId: 's1', text: '这一帧没送出去' });

    assert.equal(h.realtime.pendingCount, 1, 'send 抛错时帧必须回到 outbox——发失败≠发成功');
    assert.deepEqual(socket.frames('message'), [], '抛错的那条不可能真的到了服务端');
    assert.deepEqual(h.errors, ['send boom'], '这个失败要说出来，否则没人知道它是坏的');

    // 换一条连接：那条帧必须带着同一个 invocation_id 补发（服务端据此识别同一件事）。
    socket.sendError = null;
    h.realtime.disconnect();
    h.realtime.retryNow();
    const next = h.sockets.at(-1);
    next.serverOpen();

    assert.equal(h.realtime.pendingCount, 0, '重连后必须把 outbox 清空');
    const [delivered] = next.frames('message');
    assert.equal(delivered.invocation_id, invocationId, '补发必须复用 invocation_id，不是新一轮');
    assert.equal(delivered.text, '这一帧没送出去');
  } finally {
    h.realtime.dispose();
  }
});

test('掉线期间的订阅意图不许丢：重连时必须先订阅、再补发消息', async () => {
  // 协议硬顺序：发消息的连接收不到正文。顺序反了这一轮跑的正文可能一帧都收不到。
  const h = harness({ timing: { baseDelayMs: 200, maxDelayMs: 400, connectTimeoutMs: 5_000 } });
  try {
    h.realtime.subscribe('s1');
    h.realtime.sendMessage({ sessionId: 's1', text: '补发的那句' });

    h.realtime.retryNow();
    const socket = h.sockets.at(-1);
    socket.serverOpen();

    assert.deepEqual(
      socket.sent.slice(0, 2).map((frame) => frame.type),
      ['runtime_subscribe', 'message'],
      `帧序必须是"先订阅、后补发"，实际：${JSON.stringify(socket.sent.map((f) => f.type))}`,
    );
  } finally {
    h.realtime.dispose();
  }
});

test('不可序列化的帧：不许把连接搞崩，也不许静默丢掉', async () => {
  // `JSON.stringify` 遇到 BigInt 会抛。抛在 `send` 里如果不接住，一条坏附件就能把
  // 整条实时通道带走。
  const h = harness();
  try {
    const socket = h.open('s1');
    h.realtime.sendMessage({
      sessionId: 's1',
      text: '带着一个不可能序列化的附件',
      attachments: [{ kind: 'file', size: BigInt(1) }],
    });

    assert.equal(h.realtime.connectionState, 'open', '一次序列化失败不该杀掉连接');
    assert.equal(h.realtime.pendingCount, 1, '送不出去的帧要留在队列里（不许静默丢掉）');
    assert.ok(h.errors.length === 1, `要留下一条错误，实际 ${JSON.stringify(h.errors)}`);
    assert.deepEqual(socket.frames('message'), [], '它不可能已经送达');
  } finally {
    h.realtime.dispose();
  }
});

test('unauthorized 之后：不许偷偷重连，但用户点重试要给一次机会', async () => {
  // 凭据没了要人去重新登录；他登完回来点"重试"，得真的再试一次（否则按钮是安慰剂）。
  const h = harness({ timing: { baseDelayMs: 40, maxDelayMs: 80 } });
  try {
    const socket = h.open('s1');
    socket.serverClose({
      code: 1006,
      reason: "Expected HTTP 101 response but was '401 Unauthorized'",
    });
    assert.equal(h.realtime.connectionState, 'unauthorized');

    await sleep(140); // 三倍退避的窗口
    assert.equal(h.sockets.length, 1, '确认凭据失效后不许再自动重连（重试到天亮也一样）');

    h.realtime.retryNow();
    assert.equal(h.sockets.length, 2, '用户点重试必须立刻建一条（他可能刚重新登录）');
  } finally {
    h.realtime.dispose();
  }
});

test('unauthorized 状态下发送：帧进队列，但一条连接都不许建', async () => {
  // 否则每次点发送都会再撞一次 401，而界面看起来像"一直在连"。
  const h = harness({ timing: { baseDelayMs: 40, maxDelayMs: 80 } });
  try {
    const socket = h.open('s1');
    socket.serverClose({
      code: 1006,
      reason: "Expected HTTP 101 response but was '401 Unauthorized'",
    });
    const before = h.sockets.length;

    h.realtime.sendMessage({ sessionId: 's1', text: '登出状态下发的' });
    await sleep(100);

    assert.equal(h.sockets.length, before, 'unauthorized 状态不该被一次发送拉起来重连');
    assert.equal(h.realtime.pendingCount, 1, '那句话要留在队列里（用户重登后还得发出去）');
  } finally {
    h.realtime.dispose();
  }
});

test('404 关闭是"这条路没了"，不是"凭据没了"——不重连，也不骗人去重登', async () => {
  const h = harness({ timing: { baseDelayMs: 40, maxDelayMs: 80 } });
  try {
    const socket = h.open('s1');
    socket.serverClose({
      code: 1006,
      reason: "Expected HTTP 101 response but was '404 Not Found'",
    });

    assert.equal(
      h.realtime.connectionState,
      'closed',
      'bot 被删这类 4xx 说成"登录已过期"会把用户骗去重登，而问题不在凭据',
    );
    await sleep(100);
    assert.equal(h.sockets.length, 1, '这条路以后也走不通，重试没有意义');
  } finally {
    h.realtime.dispose();
  }
});

test('1008（升级后被拒）：按凭据处理，要用户去重新登录', async () => {
  // 服务端用 1008 表示"权限不足"那一类拒绝，这时自动重连是白撞。
  const h = harness({ timing: { baseDelayMs: 40, maxDelayMs: 80 } });
  try {
    const socket = h.open('s1');
    socket.serverClose({ code: 1008, reason: 'policy violation' });

    assert.equal(h.realtime.connectionState, 'unauthorized');
    await sleep(100);
    assert.equal(h.sockets.length, 1, '升级后被拒的凭据不会自己变好');
  } finally {
    h.realtime.dispose();
  }
});

// ---------------------------------------------------------------- 入站失败

test('非 JSON 的调试输出：整帧丢掉，既不上屏也不动游标', () => {
  // 服务端偶尔会往这条通道里插一段非 JSON 的日志。接不住就会把界面搅乱。
  const h = harness();
  try {
    const socket = h.open('s1');
    socket.serverFrame('这不是 JSON {{{');

    assert.equal(h.realtime.connectionState, 'open', '一个坏帧不许杀掉连接');
    assert.deepEqual(h.deltas, [], '解析失败的帧不许被当成 delta');
    assert.deepEqual(h.gaps, [], '它也不是"空洞"——谎报"刷新中"会让界面白刷一次');
    assert.deepEqual(h.others, [], '它更不该被当成"其他帧"扔给上层');
  } finally {
    h.realtime.dispose();
  }
});

test('字段缺失的 delta：丢掉，不逼近游标、也不报空洞', () => {
  const h = harness();
  try {
    const socket = h.open('s1');
    socket.serverFrame({
      type: 'runtime_snapshot',
      session_id: 's1',
      epoch: 'e1',
      seq: 1,
      snapshot: {},
    });
    socket.serverFrame({ type: 'runtime_delta', session_id: 's1' });

    assert.deepEqual(h.deltas, [], '缺 epoch/seq/delta 的帧没有可应用的内容');
    assert.deepEqual(h.gaps, [], '形状不对不等于序号有空洞');
    assert.equal(
      h.realtime.cursorFor('s1').seq,
      1,
      '游标不许被一条读不懂的帧推着走（推错了后面每一帧都会被判成空洞）',
    );
  } finally {
    h.realtime.dispose();
  }
});

test('超过 8 MiB 的帧：直接丢，不许把 JS 内存撑爆', () => {
  // 一条畸形/超大的帧不该让整个界面 OOM——协议里没有任何一帧有这么大。
  const h = harness();
  try {
    const socket = h.open('s1');
    const huge = `{"type":"runtime_delta","padding":"${'x'.repeat(9 * 1024 * 1024)}"}`;
    socket.serverFrame(huge);

    assert.equal(h.realtime.connectionState, 'open', '丢帧不等于断连');
    assert.deepEqual(h.deltas, []);
    assert.deepEqual(h.others, [], '超长帧连"其他帧"都不该是（解析它本身就是风险）');
  } finally {
    h.realtime.dispose();
  }
});

test('没订阅到 snapshot 就来的 delta：重订阅要 snapshot，且不许带 cursor', () => {
  // 服务端明确不做增量补齐（"合成增量等于伪造历史"），所以恢复手段只有重订阅。
  const h = harness();
  try {
    const socket = h.open('s1');
    socket.serverFrame({ type: 'runtime_delta', session_id: 's1', epoch: 'e1', seq: 1, delta: {} });

    assert.deepEqual(h.deltas, [], '没有基准的 delta 不许应用');
    assert.deepEqual(h.gaps, ['delta before snapshot'], '这段空窗必须告诉界面');
    const resubscribe = socket.frames('runtime_subscribe').at(-1);
    assert.equal(
      resubscribe.cursor,
      undefined,
      '重订阅不许带 cursor——带了就等于让服务端替我们补一段伪造的历史',
    );
  } finally {
    h.realtime.dispose();
  }
});

test('重复帧（seq ≤ 本地）：丢弃，不许重复应用、也不许报空洞', () => {
  const h = harness();
  try {
    const socket = h.open('s1');
    socket.serverFrame({
      type: 'runtime_snapshot',
      session_id: 's1',
      epoch: 'e1',
      seq: 5,
      snapshot: {},
    });
    socket.serverFrame({ type: 'runtime_delta', session_id: 's1', epoch: 'e1', seq: 5, delta: {} });

    assert.deepEqual(h.deltas, [], '重复帧应用两次就是内容翻倍');
    assert.deepEqual(h.gaps, [], '重复帧不是空洞：谎报"刷新中"会让界面闪一下');
    assert.equal(h.realtime.cursorFor('s1').seq, 5);
  } finally {
    h.realtime.dispose();
  }
});

test('epoch 变了：跨 epoch 不比较 seq，也不合并内容', () => {
  // epoch 变了 seq 从 0 重来，拿它跟本地比只会得到一个假的"空洞"或假的"重复"。
  const h = harness();
  try {
    const socket = h.open('s1');
    socket.serverFrame({
      type: 'runtime_snapshot',
      session_id: 's1',
      epoch: 'e1',
      seq: 7,
      snapshot: {},
    });
    socket.serverFrame({ type: 'runtime_delta', session_id: 's1', epoch: 'e2', seq: 1, delta: {} });

    assert.deepEqual(h.deltas, [], '跨 epoch 的帧不许被并进旧内容');
    assert.deepEqual(h.gaps, ['epoch changed'], '要按"epoch 变了"说，而不是编一个 seq 空洞');
  } finally {
    h.realtime.dispose();
  }
});

test('seq 空洞持续存在：每一次都要报，但重新订阅必须节流', () => {
  // 实测症状：一条 delta 一次重订阅，4s 内订阅 38 次，把服务端打爆。而界面什么都不说。
  const h = harness({ timing: { resubscribeCooldownMs: 400, heartbeatMs: 5_000 } });
  try {
    const socket = h.open('s1');
    socket.serverFrame({
      type: 'runtime_snapshot',
      session_id: 's1',
      epoch: 'e1',
      seq: 1,
      snapshot: {},
    });
    for (const seq of [5, 6, 7, 8, 9]) {
      socket.serverFrame({ type: 'runtime_delta', session_id: 's1', epoch: 'e1', seq, delta: {} });
    }

    assert.equal(h.gaps.length, 5, '每一次空洞都要报告（少报一次就是一段静默缺失的内容）');
    const subscribes = socket.frames('runtime_subscribe').length;
    assert.ok(
      subscribes <= 3,
      `5 次空洞不该变成 5 次订阅：实际 ${subscribes} 次（初始 1 次 + 立即 1 次 + 冷却到点 1 次）`,
    );
    assert.ok(subscribes >= 2, '空洞之后必须真的重新订阅，否则恢复不了');
  } finally {
    h.realtime.dispose();
  }
});

test('runtime_dropped：按服务端给的原因说"这段可能不全"', () => {
  const h = harness();
  try {
    const socket = h.open('s1');
    socket.serverFrame({
      type: 'runtime_dropped',
      session_id: 's1',
      message: 'ring buffer overflow',
    });

    assert.deepEqual(
      h.gaps,
      ['ring buffer overflow'],
      '原因要原样转达：这一条决定用户看到的是"刷新中"还是"内容齐了"',
    );
  } finally {
    h.realtime.dispose();
  }
});

test('run_rejected：必须透给上层，code 与 message 一个字都不能丢', () => {
  // 这条帧是"那条乐观消息变成失败态"的唯一依据。丢在 realtime 层，用户就会一直
  // 看着"等确认"，而服务端早就拒了。`code` 决定界面给不给"重试"。
  const h = harness();
  try {
    const socket = h.open('s1');
    socket.serverFrame({
      type: 'run_rejected',
      session_id: 's1',
      invocation_id: 'inv-1',
      code: 'busy',
      message: 'agent is busy',
    });

    assert.equal(h.runRejected.length, 1, '必须交给上层（否则那条消息永远停在"等确认"）');
    assert.equal(h.runRejected[0].invocation_id, 'inv-1', '要能对上本地那条乐观消息');
    assert.equal(h.runRejected[0].code, 'busy', 'code 决定能不能重试，不许在这里丢掉');
    assert.equal(h.runRejected[0].message, 'agent is busy');
    assert.deepEqual(h.others, [], '它不该同时被当成"其他帧"再发一遍');
  } finally {
    h.realtime.dispose();
  }
});

test('未知帧类型：交给 onOther，不许静默丢', () => {
  // 服务端加新帧类型时，静默丢会让"以后需要它的功能"看起来毫无缘由地失效。
  const h = harness();
  try {
    const socket = h.open('s1');
    socket.serverFrame({ type: 'command_result', id: 'c1', ok: true });

    assert.equal(h.others.length, 1, '未归类的帧要冒到上层（诊断与日志都靠它）');
    assert.equal(h.others[0].type, 'command_result');
  } finally {
    h.realtime.dispose();
  }
});

test('有回音时不许判死链：误判会白断一条好链路', async () => {
  // 判据是"探针发出去了、回音没回来"。只要回音到了（哪怕不是 snapshot），
  // 就绝不能换连接——换一次就是正文断一截。
  const h = harness({
    timing: { heartbeatMs: 40, livenessGraceMs: 120, connectTimeoutMs: 5_000, baseDelayMs: 1_000 },
  });
  let pump = null;
  try {
    const socket = h.open('s1');
    pump = setInterval(() => {
      socket.serverFrame({
        type: 'runtime_snapshot',
        session_id: 's1',
        epoch: 'e1',
        seq: 1,
        snapshot: {},
      });
    }, 30);

    await sleep(260); // 至少一个心跳 + 它的回音期限

    assert.equal(h.realtime.connectionState, 'open', '有回音的链路不许被换掉');
    assert.deepEqual(h.errors, [], `有回音时不该判死链：${JSON.stringify(h.errors)}`);
    assert.equal(h.sockets.length, 1, '更不许真的重连');
  } finally {
    clearInterval(pump);
    h.realtime.dispose();
  }
});

// ------------------------------------------------- 死链（心跳无回音）与"重试≠重发"

test('心跳没有回音：必须判死链换一条连接，不许一直停在 open 上装作在线', async () => {
  // 现场（NAT 黑洞链路）：订阅发得出去、一个字节都回不来，`readyState` 一直是 open，
  // 界面显示"已连接"——用户对着一个永远收不到正文的会话打字。
  const h = harness({
    timing: {
      heartbeatMs: 40,
      livenessGraceMs: 120,
      connectTimeoutMs: 5_000,
      baseDelayMs: 30,
      maxDelayMs: 60,
    },
  });
  try {
    const socket = h.open('s1'); // 连上并订阅；此后服务端一言不发

    await until(() => h.errors.length > 0, { what: '死链判定' });

    assert.match(
      h.errors[0],
      /心跳/,
      `死链要把判据说出来（"心跳没有回音"），实际读到的是 ${JSON.stringify(h.errors[0])}`,
    );
    assert.equal(socket.closed, true, '旧 socket 必须被摘掉（它的 onclose 不许再排一次重连）');
    assert.notEqual(
      h.realtime.connectionState,
      'open',
      '判死链之后不许继续报 open——界面就是这么谎报"已连接"的',
    );

    await until(() => h.sockets.length >= 2, { what: '换一条新连接' });
    // 换连接必须带上订阅意图：否则新连接"连上了但收不到正文"，症状换个样子还在。
    const next = h.sockets.at(-1);
    next.serverOpen();
    assert.equal(
      next.frames('runtime_subscribe').length,
      1,
      '死链换连接之后必须重新订阅（订阅是这条链路上唯一有可观测行为的东西）',
    );
  } finally {
    h.realtime.dispose();
  }
});

test('回音期限不许被后面的心跳推后：推一次就等于永远判不出死链', async () => {
  // `beat()` 里那句"已经在等回音就别把期限往后推"是这条用例守的。假如每次都重设一遍
  // 定时器，下面的形状就成立：心跳周期（30ms）永远短于回音期限（100ms），于是每次心跳
  // 都把期限改成"从现在起 100ms"——死链**永远发现不了**，静默烂在屏幕上。
  const h = harness({
    timing: {
      heartbeatMs: 30,
      livenessGraceMs: 100,
      connectTimeoutMs: 5_000,
      baseDelayMs: 30,
      maxDelayMs: 60,
    },
  });
  try {
    const startedAt = Date.now();
    h.open('s1');

    await until(() => h.errors.length > 0, { timeoutMs: 1_500, what: '死链判定' });
    const elapsed = Date.now() - startedAt;

    assert.ok(
      elapsed < 400,
      `判死链用了 ${elapsed}ms；正确实现是"第一次探针 + 一个回音期限"（≈130ms）——` +
        '超过 400ms 就说明期限被后续心跳推后了',
    );
  } finally {
    h.realtime.dispose();
  }
});

test('没有订阅时不做死链判定：不去猜一条没有可观测行为的链路', async () => {
  // 协议里没有"无副作用的探针帧"，所以没有订阅时客户端根本没有判据。这时候判死链就是
  // 纯猜——一猜就白断一条本来好着的链路，还会在用户刚打开 App 时先断一次再连。
  const h = harness({
    timing: {
      heartbeatMs: 20,
      livenessGraceMs: 40,
      connectTimeoutMs: 5_000,
      baseDelayMs: 30,
      maxDelayMs: 60,
    },
  });
  try {
    h.open(null); // 连上，但不订阅任何会话

    await sleep(300); // = 7 个心跳 × 各自的回音期限

    assert.deepEqual(h.errors, [], `没有订阅时不许判死链，实际报了：${JSON.stringify(h.errors)}`);
    assert.equal(h.sockets.length, 1, '更不许因此换连接');
    assert.equal(h.realtime.connectionState, 'open');
  } finally {
    h.realtime.dispose();
  }
});

test('点"重试"只换连接、不重发：已经送达的那句不许被再发一遍', async () => {
  // "重试"在界面上有两个意思，协议上是两件事：`retryNow()` 是**重连**，重发一条消息是
  // `sendMessage`。混起来的后果是用户点一次"重连"，agent 就再答一遍同一句话。
  const h = harness({ timing: { baseDelayMs: 30, maxDelayMs: 60, connectTimeoutMs: 5_000 } });
  try {
    const socket = h.open('s1');
    h.realtime.sendMessage({ sessionId: 's1', text: '这句已经送到了' });

    assert.equal(socket.frames('message').length, 1, '前提：这一句真的送出去了');
    assert.equal(h.realtime.pendingCount, 0, '前提：送出去之后队列是空的');

    h.realtime.retryNow();
    const next = h.sockets.at(-1);
    next.serverOpen();

    assert.deepEqual(
      next.frames('message'),
      [],
      '重连不许把已经送达的消息再发一遍（服务端会真的再起一轮）',
    );
    assert.equal(next.frames('runtime_subscribe').length, 1, '但订阅意图要重放');
    assert.equal(h.realtime.pendingCount, 0);
  } finally {
    h.realtime.dispose();
  }
});

test('dispose 之后：不再建连，队列清空并通知界面', async () => {
  // 组件卸载后残留的心跳会继续发订阅，`dispose` 之后还建连接就是给服务端留野连接。
  const h = harness();
  const socketsBefore = () => h.sockets.length;
  h.realtime.sendMessage({ sessionId: 's1', text: '释放前没送出去的' });
  const afterSend = socketsBefore();

  h.realtime.dispose();
  await sleep(100);

  assert.equal(h.realtime.pendingCount, 0, 'dispose 必须清空 outbox（否则界面永远显示"还欠一帧"）');
  assert.equal(h.pending.at(-1), 0, '最后一次通知必须是 0');
  assert.equal(socketsBefore(), afterSend, 'dispose 之后一条连接都不许再建');
  assert.equal(h.realtime.connectionState, 'closed');
});
