#!/usr/bin/env node
/**
 * 固定服务端的自检：**它自己起一个服务端，把协议和场景数据验一遍，再把服务端收掉**。
 *
 * ## 为什么要有它
 *
 * 固定服务端替 App 说话，它自己坏了的表现是"App 里是空的"——那种失败信息最难查。
 * 所以把它当一个独立组件验：协议对不对、场景数据有没有真的发出来、`PUT` 是不是
 * **真的改到了内存里那条**（而不是回一个 200 就完事），几秒钟就有答案，不用起模拟器。
 *
 * ## 为什么要自己起（而不是"先开服务端再跑它"）
 *
 * 一条命令就该能全绿。要求先手动开另一个终端，等于让"自检"多一个会忘记的步骤，
 * 而忘记的表现是"探针连不上"这种跟 fixture 无关的红。
 *
 * ## 端口：**一律独占**，绝不复用（2026-09-16 改）
 *
 * 以前这里默认 18199，而且"那个端口上已经有人在服务就直接用它"（当初的理由是"多半是你
 * 自己开着调试，抢过来会打断你的会话"）。那个理由只对了一半，代价却由别人付：这台机器上
 * 同时有好几个 agent 在起固定服务端，谁都可能先占住 18199——于是"自检通过"是在**测别人的
 * 旧代码**，而两种输出长得一模一样（`程昱` 因此吃到过一次假失败）。
 *
 * 现在与验收那两条脚本同一条规矩：**要么自己独占端口，要么明确失败**。
 *   * 默认（不给 `--port`）：问系统要一个空闲端口，跑完就收掉；
 *   * `--port N`：N 被占着就**失败**，并把占用者（pid + 命令行）印出来，
 *     让人自己决定是换端口还是收掉那个进程——不自作主张接管。
 *
 * 用法：
 *     node verification/fixture/probe.mjs                # 自动挑一个空闲端口
 *     node verification/fixture/probe.mjs --port 18199   # 端口被占则失败
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'server.mjs');

const arguments_ = process.argv.slice(2);
function flag(name, fallback) {
  const index = arguments_.indexOf(`--${name}`);
  return index === -1 ? fallback : arguments_[index + 1];
}

/** 谁在监听这个端口（失败信息里要说清"谁占着"，否则下一个人只能靠猜或绕开）。 */
function portHolder(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  const lines = String(result.stdout ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '');
  return lines.length > 1 ? lines.slice(1).join('\n') : '（`lsof` 没报出占用者）';
}

/** 这个端口现在能不能由自己独占。 */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/**
 挑一个**只属于这次自检**的端口。

 `--port` 是"我想用这个端口"，不是"随便一个都行"：被占就失败，不复用、也不悄悄换一个
 继续跑——悄悄换一个等于把 `--port` 这个参数变成谎话。
 */
async function exclusivePort(pinned) {
  if (pinned !== undefined) {
    const port = Number(pinned);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error(`✗ --port ${pinned} 不是一个端口号。`);
      process.exit(2);
    }
    if (await portIsFree(port)) return port;
    console.error(`✗ ${port} 上已经有进程在监听，这次自检不跑（也不复用那个进程）。`);
    console.error(`  占用者：\n${portHolder(port)}`);
    console.error('  复用它是以前的做法：看着"自检通过"，实际测的是别人的代码。');
    console.error('  要么换端口（--port <别的>），要么收掉那个进程（kill <pid>）。');
    process.exit(2);
  }
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const PORT = await exclusivePort(flag('port', undefined));
const BASE = `http://127.0.0.1:${PORT}`;
const BOT = 'fixture-bot';

/**
 客户端自己的定时任务模型层（`src/features/schedule/model.ts`）。

 探针要用它来验一条 JSON 断言验不出的事：**这些响应喂进界面真正会走的代码之后，
 读出来的是不是同一个东西**（比如"正在跑"必须由 `status` + `completed_at` 两个字段
 合起来判定，而不是靠一个服务端从不发的 `status: 'running'`）。
 */
const model = await import(new URL('../../src/features/schedule/model.ts', import.meta.url).href);

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`);
  if (!ok) failures += 1;
}

/** 一条断言的"实际值"摘要：失败时能把形状直接看出来，不用再加打印重跑。 */
function show(value) {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function setScenario(scenario) {
  const result = await call('/__scenario', { method: 'POST', body: { scenario } });
  if (result.status !== 200) throw new Error(`切场景失败：${scenario} → ${result.status}`);
}

// ------------------------------------------------------------------ 形状断言

/**
 单条任务**必须**有的键。`omitempty` 的那几个不在这里（见下一组）——这条断言的
 意思是"客户端要读的字段一个都不能少"，而不是"响应只能有这些键"。
 */
const SCHEDULE_REQUIRED_KEYS = [
  'id',
  'name',
  'description',
  'pattern',
  'current_calls',
  'created_at',
  'updated_at',
  'enabled',
  'command',
  'bot_id',
  'run_target',
];

/**
 允许出现、但**空就不该出现**的键。

 为什么空值不能输出：客户端把"键缺失"读成空串（`normalizeSchedule` 的 `str()`），
 而"存在且为空"是另一回事。固定服务端输出一个空值，等于替真服务端发明了一条约定，
 而这条约定恰恰会让"字段被清空"这种 bug 在 fixture 上看着正常。
 */
const SCHEDULE_OPTIONAL_KEYS = [
  'max_calls',
  'target_session_id',
  'runtime_type',
  'bot_agent_id',
  'acp_agent_id',
  'model_id',
  'acp_model_id',
  'reasoning_effort',
  'workdir_id',
];

function checkScheduleShape(label, raw) {
  const keys = Object.keys(raw);
  const missing = SCHEDULE_REQUIRED_KEYS.filter((key) => !keys.includes(key));
  const unknown = keys.filter(
    (key) => !SCHEDULE_REQUIRED_KEYS.includes(key) && !SCHEDULE_OPTIONAL_KEYS.includes(key),
  );
  const emptyOptional = SCHEDULE_OPTIONAL_KEYS.filter(
    (key) => keys.includes(key) && (raw[key] === '' || raw[key] === null),
  );
  check(
    `${label}：键齐全`,
    missing.length === 0,
    missing.length === 0 ? '' : `缺 ${missing.join(', ')}`,
  );
  check(
    `${label}：没有多余/未知的键`,
    unknown.length === 0,
    unknown.length === 0 ? '' : `多了 ${unknown.join(', ')} → ${show(raw)}`,
  );
  check(
    `${label}：omitempty 的键空就别输出`,
    emptyOptional.length === 0,
    emptyOptional.length === 0 ? '' : `空值被输出了 ${emptyOptional.join(', ')}`,
  );
  // 平铺而不是嵌套：`execution` 这个键在 GET 里**不该存在**（那是 PUT 的写法）。
  check(
    `${label}：是平铺而不是嵌套 execution`,
    !keys.includes('execution') && typeof raw.run_target === 'string',
    keys.includes('execution') ? `出现了 execution：${show(raw.execution)}` : '',
  );
}

function checkLogShape(label, raw) {
  const required = [
    'id',
    'schedule_id',
    'bot_id',
    'status',
    'result_text',
    'error_message',
    'started_at',
  ];
  const keys = Object.keys(raw);
  const missing = required.filter((key) => !keys.includes(key));
  check(
    `${label}：键齐全`,
    missing.length === 0,
    missing.length === 0 ? '' : `缺 ${missing.join(', ')} → ${show(raw)}`,
  );
  const emptyOptional = ['session_id', 'completed_at', 'usage'].filter(
    (key) => keys.includes(key) && (raw[key] === '' || raw[key] === null),
  );
  check(
    `${label}：omitempty 的键空就别输出`,
    emptyOptional.length === 0,
    emptyOptional.length === 0 ? '' : `空值被输出了 ${emptyOptional.join(', ')}`,
  );
}

// ------------------------------------------------------------------ 各段自检

/**
 运行态：**固定服务端必须画得出"正在跑"**（2026-09-17）。

 ## 为什么单开一条自检

 "工具在转圈 + 发送键是禁用的发送箭头 ↑"这张画面评过一整轮产品。它是固定服务端拼出来的：
 工具块按场景数据在转（REST 历史里 `status: 'running'`），而**它从不发 `current_run_view`**
 ——于是 `chat.running` 恒为 false、按钮回落到"发送"。真服务端不会同时给出这两个表达
 （run 期间一路发 `current_run_view`，见 `docs/CHAT-ACCEPTANCE.md` §6.①）。

 根因不在 `server.mjs`，在**场景数据**：run 视图写在第二个 snapshot 帧里，而一条订阅流只发
 第一个 snapshot（`sendScene`）——那一帧在真实 WS 上永远到不了客户端。场景台回放**全部**
 帧，所以这件事在那边看不出来（两个"同一份帧"的表面互相矛盾，而产品只有 WS 那一条）。

 所以判据必须落在**真实 WS 收到的帧**上：喂进**真实 reducer**，再问
 `composerActionWithSupport` 那颗按钮此刻是什么。夹具再"骗人"（工具在转、run 说没在跑），
 这条自检就红。
 */
async function checkRunState() {
  console.log('\n— 运行态：run=running 要真的到客户端（发送键 = 停止）—');
  const reducer = await import(new URL('../../src/features/chat/reducer.ts', import.meta.url).href);
  const queue = await import(new URL('../../src/features/chat/queue.ts', import.meta.url).href);

  /** 把真实 WS 帧按协议喂进真实 reducer——和 App 走的是同一段代码。 */
  function replay(frames) {
    let state = reducer.initialChatState;
    for (const frame of frames) {
      if (frame.type === 'runtime_snapshot') {
        state = reducer.applySnapshot(state, frame.snapshot);
      } else if (frame.type === 'runtime_delta') {
        state = reducer.applyDelta(state, frame.epoch, frame.seq, frame.delta ?? {});
      }
    }
    return state;
  }

  /** 订阅一个会话，收 `ms` 毫秒的帧。 */
  async function collect(sessionId, ms) {
    const frames = [];
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/bots/${BOT}/web/ws`);
    await new Promise((resolve) => {
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'runtime_subscribe', session_id: sessionId }));
      });
      socket.addEventListener('message', (event) => {
        try {
          frames.push(JSON.parse(event.data));
        } catch {
          // 非 JSON 帧会在断言里表现为"少了一帧"。
        }
      });
      socket.addEventListener('error', () => resolve());
      setTimeout(resolve, ms);
    });
    socket.close();
    return frames;
  }

  // ① 正在跑的那一场（`chat-tools`：工具块在转，所以按钮必须是"停止"）。
  const live = await collect('fixture-session-active', 1500);
  const runningViews = live.filter(
    (frame) =>
      frame.type === 'runtime_delta' && frame.delta?.current_run_view?.status === 'running',
  );
  check(
    '运行中：delta 里带 current_run_view=running',
    runningViews.length > 0,
    `收到 ${runningViews.length} 帧`,
  );

  const liveState = replay(live);
  check(
    '运行中：chat.running 为真',
    liveState.running === true,
    `runStatus=${liveState.runStatus}`,
  );
  const action = queue.composerActionWithSupport({
    running: liveState.running,
    hasDraft: false,
    support: 'no',
  });
  check('运行中：发送键是"停止"，不是"发送"', action === 'stop', `action=${action}`);

  // ② 这两个表达**不许同时出现**——"转圈 + 发送箭头"就是这一条红的样子。
  const spinning = Object.values(liveState.blocks).filter(
    (block) => block.type === 'tool' && block.running === true,
  );
  check(
    '工具在转圈时 run 必须在跑（不许"转圈 + 发送"）',
    spinning.length === 0 || liveState.running === true,
    `转圈的工具 ${spinning.length} 个，running=${liveState.running}`,
  );

  // ③ 跑完的那一场要收尾（否则又会留下"工具全绿 + 还在 Thinking"的画面）。
  const settled = replay(await collect('fixture-session-stream', 2000));
  check(
    '收尾：跑完的场景不再是 running',
    settled.running === false,
    `runStatus=${settled.runStatus}`,
  );
  check(
    '收尾：终态是 completed',
    settled.runStatus === 'completed',
    `runStatus=${settled.runStatus}`,
  );
}

async function checkWebsocket() {
  console.log('\n— WebSocket（会话帧）—');
  const frames = [];
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/bots/${BOT}/web/ws`);

  const done = new Promise((resolve) => {
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({ type: 'runtime_subscribe', session_id: 'fixture-session-active' }),
      );
    });
    socket.addEventListener('message', (event) => {
      try {
        frames.push(JSON.parse(event.data));
      } catch {
        // 非 JSON 的帧直接忽略：它会在下面的断言里表现为"少了一帧"。
      }
    });
    socket.addEventListener('error', () => resolve());
    // 给 delta 足够时间发完（服务端每帧间隔 120ms）。
    setTimeout(resolve, 3000);
  });
  await done;

  const snapshots = frames.filter((frame) => frame.type === 'runtime_snapshot');
  const deltas = frames.filter((frame) => frame.type === 'runtime_delta');
  const upserts = deltas.flatMap((frame) => frame.delta.message_upserts ?? []);
  check('订阅后收到 snapshot', snapshots.length === 1, `收到 ${snapshots.length} 个`);
  check('收到 delta', deltas.length > 0, `收到 ${deltas.length} 个`);

  // 游标必须在**帧顶层**。踩过：只放在 `snapshot` 里的话，客户端认为"还没收到过
  // snapshot"，第一个 delta 就被判成 "delta before snapshot" → 重新订阅 → 页面永远
  // 停在 Refreshing…。
  const cursorOk = snapshots.every(
    (frame) =>
      typeof frame.epoch === 'string' && frame.epoch !== '' && typeof frame.seq === 'number',
  );
  check('snapshot 帧顶层有 epoch/seq', cursorOk);

  // seq 必须连续（服务端自己编号）。踩过：直接发场景帧里写死的 seq（有跳号），
  // 客户端光标判定"视图过期"→ 重订阅 → 停在 Refreshing…。
  const sequences = deltas.map((frame) => frame.seq);
  const contiguous = sequences.every((seq, index) => seq === index + 1);
  check('delta seq 连续', contiguous, `实际 ${sequences.join(', ')}`);
  check('upsert 里有消息块', upserts.length > 0, `${upserts.length} 条`);
  socket.close();
}

/**
 弱网故障注入的自检。
 
 这一段的理由和别处一样：**它坏了的表现是"弱网那条用例莫名其妙地过/不过"**，那种
 失败信息最难查。所以把服务端这一侧的演员单独验一遍：说断就真的断、说 401 就真的
 401、说静默就真的一帧不发，观测台记的帧序也要真的可用。
 */
async function checkWeakNetworkFaults() {
  console.log('\n— WebSocket 故障注入（弱网场景的演员）—');

  async function setFault(body) {
    const response = await fetch(`${BASE}/__ws-fault`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.json();
  }
  async function readLog() {
    return (await fetch(`${BASE}/__ws-log`)).json();
  }

  /** 连上去，等 `ms`，返回收到的帧与"是否被断开"。 */
  async function probeSocket(ms, subscribe = true) {
    const frames = [];
    let closed = false;
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/bots/${BOT}/web/ws`);
    await new Promise((resolve) => {
      socket.addEventListener('open', () => {
        if (subscribe) {
          socket.send(
            JSON.stringify({ type: 'runtime_subscribe', session_id: 'fixture-session-active' }),
          );
        }
      });
      socket.addEventListener('message', (event) => {
        try {
          frames.push(JSON.parse(event.data));
        } catch {
          /* 非 JSON 帧会被算成"少了一帧" */
        }
      });
      socket.addEventListener('close', () => {
        closed = true;
        resolve();
      });
      socket.addEventListener('error', () => resolve());
      setTimeout(resolve, ms);
    });
    try {
      socket.close();
    } catch {
      /* 已经断了 */
    }
    return { frames, closed, socket };
  }

  // flap：握手成功就断。验的是"客户端会看到一次 open 然后又没了"。
  await setFault({ mode: 'flap', reset: true });
  const flap = await probeSocket(500);
  check(
    'flap：连上就断（没有一帧数据）',
    flap.closed && flap.frames.length === 0,
    `closed=${flap.closed} frames=${flap.frames.length}`,
  );

  // unauthorized：不升级，直接 401。
  await setFault({ mode: 'unauthorized', reset: true });
  const unauthorized = await probeSocket(400);
  check('unauthorized：一帧都不给', unauthorized.frames.length === 0);
  check('unauthorized：观测台记到了这次尝试', (await readLog()).connections >= 1);
  // REST 一侧的 401 开关（客户端靠它把"超时"和"凭据没了"分开）。
  await setFault({ mode: 'unauthorized', tokenRejected: true, reset: true });
  const rest401 = await fetch(`${BASE}/bots`, {
    headers: { authorization: 'Bearer fixture-token' },
  });
  check('tokenRejected：REST 也回 401', rest401.status === 401, `实际 ${rest401.status}`);
  await setFault({ mode: 'normal', tokenRejected: false });

  // silent：接受握手、收下订阅、但一帧不发（NAT 黑洞）。
  await setFault({ mode: 'silent', reset: true });
  const silent = await probeSocket(400);
  check('silent：接受了但永不出声', silent.frames.length === 0 && !silent.closed);
  const silentLog = await readLog();
  check(
    'silent：订阅帧被记下来（探针确实发出去了）',
    silentLog.subscribes['fixture-session-active'] >= 1,
  );

  // gap / epoch：帧序本身要被造出来（客户端据此重新订阅）。
  await setFault({ mode: 'gap', reset: true });
  const gap = await probeSocket(500);
  const gapSeq = gap.frames.filter((f) => f.type === 'runtime_delta').map((f) => f.seq);
  check('gap：seq 真的跳号', gapSeq.includes(5) && !gapSeq.includes(2), `seq=${gapSeq.join(',')}`);

  await setFault({ mode: 'epoch', reset: true });
  const epoch = await probeSocket(500);
  const epochs = new Set(epoch.frames.map((f) => f.epoch));
  check('epoch：中途换了 epoch', epochs.size === 2, `epochs=${[...epochs].join(',')}`);

  // 帧序观测台：客户端帧的顺序必须真的记下来（"先订阅后发消息"这条协议要求靠它验）。
  await setFault({ mode: 'normal', reset: true });
  const ordered = new WebSocket(`ws://127.0.0.1:${PORT}/bots/${BOT}/web/ws`);
  await new Promise((resolve) => {
    ordered.addEventListener('open', resolve);
    ordered.addEventListener('error', resolve);
    setTimeout(resolve, 500);
  });
  ordered.send(JSON.stringify({ type: 'runtime_subscribe', session_id: 'fixture-session-active' }));
  ordered.send(JSON.stringify({ type: 'message', invocation_id: 'probe-1', text: 'hi' }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const orderLog = await readLog();
  const order = orderLog.frames.map((f) => f.type);
  check(
    '观测台记下了帧序（先订阅后消息）',
    order[0] === 'runtime_subscribe' && order.includes('message'),
    `实际 ${order.slice(0, 3).join(' → ')}`,
  );
  check(
    '观测台的帧带连接号',
    orderLog.frames.every((f) => typeof f.conn === 'number'),
  );
  // drop：掐掉**活着**的连接。
  // ⚠️ 顺序：必须在 `close()` **之前**发起 drop。先关再 drop 的话，服务端那边这条连接
  // 可能已经被移除，`dropped` 就是 0 —— 这条自检会变成"随机红"，而不是在测它要测的东西。
  const dropped = await (await fetch(`${BASE}/__ws-drop`, { method: 'POST' })).json();
  check('drop：能掐掉活着的连接', dropped.dropped >= 1, `dropped=${dropped.dropped}`);
  ordered.close();

  await setFault({ mode: 'normal' });
  await checkJsonEndpoint();
}

/**
 消息流里的错误块（`bots-run.sh chat-errors` 那两条 flow 的前提）。
 
 为什么单列一条：那两条 flow 断的是**客户端判据**（标题来自我们、原因来自服务端、技术细节
 默认收起、动作只在该给的时候给）。判据写在客户端，但前提是固定服务端真的把这两种形状发出来
 ——场景里 code 拼错、或者 error 块被写成 text 块时，flow 会以"界面不对"失败，
 而真正的原因在服务端这一侧。所以在这里把形状钉住。
 */
async function checkChatErrorBlocks() {
  console.log('\n— 消息流里的错误块：工具执行失败 / 可重试的超时 —');
  const cases = [
    {
      session: 'fixture-session-error',
      // REST 那一侧的 message id。**flow 里钉的节点 id 从它派生**：
      // 客户端把 REST message 重新按 `m<message id>` 编号，所以 `41` ↔ `message-block-m41`。
      // 这个对应关系很容易改坏（改场景里的 message id，flow 的断言就会指向不存在的节点），
      // 所以在这里钉住——probe 红的时候，先看这里，而不是去 flow 里改断言。
      id: 41,
      code: 'fs.readonly',
      content: '权限不足：目标文件在只读挂载上。',
    },
    {
      session: 'fixture-session-timeout',
      id: 51,
      code: 'agent.response_timeout',
      content: 'The model did not respond in time. Please try again.',
    },
  ];
  const codes = new Set();
  for (const item of cases) {
    const response = await call(`/bots/${BOT}/messages?session_id=${item.session}`);
    const messages = (response.body?.items ?? []).flatMap((turn) => turn.messages ?? []);
    const error = messages.find((message) => message.type === 'error');
    check(
      `${item.session}：转录里有一块 error，且 id/code/content 都对得上`,
      error?.id === item.id && error?.code === item.code && error?.content === item.content,
      show(error),
    );
    // 工具失败那一块得在同一个回合里（错误块挨着它解释的那一步，不是飘在别处）。
    check(
      `${item.session}：同一个回合里还有一条工具块`,
      messages.some((message) => message.type === 'tool'),
      show(messages.map((message) => message.type)),
    );
    codes.add(error?.code ?? '');
  }
  // 两档必须是**不同**的 code：归到同一个上的话，两条 flow 就都变成同一条断言了
  //（一条要"没有动作"、一条要"有动作"，它们必须由判据决定，而不是由场景碰巧一样决定）。
  check('两档错误码不同（一个不给动作、一个给）', codes.size === 2, show([...codes]));
}

/** 顺手确认观测台端点自己没坏（观测定时任务那一段用的）。 */
async function checkJsonEndpoint() {
  const log = await (await fetch(`${BASE}/__ws-log`)).json();
  const shaped =
    typeof log.connections === 'number' &&
    Array.isArray(log.frames) &&
    Array.isArray(log.attempts) &&
    typeof log.subscribes === 'object';
  check('__ws-log 的形状可用', shaped);
}

async function checkScheduleDefault() {
  console.log('\n— schedule-default：列表 / 单条 / 日志 —');
  await setScenario('schedule-default');

  const list = await call(`/bots/${BOT}/schedule`);
  check('列表 200', list.status === 200, `实际 ${list.status} ${show(list.body)}`);
  // `items` 而不是 `entries`：两个键在本仓库里分属不同端点，串了会让列表永远是空的。
  const items = list.body?.items;
  check('列表用 items 而不是 entries', Array.isArray(items), `实际 ${show(list.body)}`);
  check('三条任务', items?.length === 3, `实际 ${items?.length}`);
  for (const item of items ?? []) checkScheduleShape(`单条 ${item.id}`, item);

  // 三种样子：启用 + 每天九点 + 最近一次 ok；停用 + 每十五分钟 + error；启用 + 每小时 + running。
  const byId = new Map((items ?? []).map((item) => [item.id, item]));
  check(
    '① 启用 + 0 9 * * *',
    byId.get('fixture-schedule-morning')?.enabled === true &&
      byId.get('fixture-schedule-morning')?.pattern === '0 9 * * *',
  );
  check(
    '② 停用 + */15 * * * *',
    byId.get('fixture-schedule-quarter')?.enabled === false &&
      byId.get('fixture-schedule-quarter')?.pattern === '*/15 * * * *',
  );
  check(
    '③ 启用 + 0 * * * *',
    byId.get('fixture-schedule-hourly')?.enabled === true &&
      byId.get('fixture-schedule-hourly')?.pattern === '0 * * * *',
  );
  check(
    'bot_id 与请求的 bot 一致',
    (items ?? []).every((item) => item.bot_id === BOT),
    show((items ?? []).map((item) => item.bot_id)),
  );

  const logs = await call(`/bots/${BOT}/schedule/logs?limit=50`);
  check('日志 200', logs.status === 200, `实际 ${logs.status}`);
  check(
    '日志用 items + total_count',
    Array.isArray(logs.body?.items) && typeof logs.body?.total_count === 'number',
    show(logs.body),
  );
  check('日志总数 3', logs.body?.total_count === 3, `实际 ${logs.body?.total_count}`);
  for (const log of logs.body?.items ?? []) checkLogShape(`日志 ${log.id}`, log);
  // 每条日志都要指向一条存在的任务，否则界面按 schedule_id 归并时会出现"孤儿日志"：
  // 有"最近一次"，但列表里没有那一行。
  const ids = new Set((items ?? []).map((item) => item.id));
  const orphan = (logs.body?.items ?? []).filter((log) => !ids.has(log.schedule_id));
  check(
    '每条日志都指向存在的任务',
    orphan.length === 0,
    show(orphan.map((log) => log.schedule_id)),
  );
  // 每个任务各一条（不多不少）：列表行的"最近一次"因此没有歧义。
  const logIds = (logs.body?.items ?? []).map((log) => log.schedule_id).sort();
  check('任务与日志一一对应', logIds.join(',') === [...ids].sort().join(','), logIds.join(','));
  const statuses = (logs.body?.items ?? []).map((log) => `${log.schedule_id}=${log.status}`).sort();
  check(
    '三种"最近一次"的状态值都在（两条 ok、一条 error）',
    statuses.join(',') ===
      'fixture-schedule-hourly=ok,fixture-schedule-morning=ok,fixture-schedule-quarter=error',
    statuses.join(','),
  );
  // 正在跑的那次：真服务端**从不发** `status: 'running'`，它是 `status='ok'` 且
  // 没有 `completed_at`（`docs/research/schedule-server-behaviour.md` §5，dev 实例上
  // 抓到过这样一行）。固定数据按这个形状写，就顺带验了客户端
  // `lastRunState(status, completedAt)` 里"别把正在跑显示成成功"那条判断。
  const inFlight = (logs.body?.items ?? []).find((log) => log.id === 'fixture-log-hourly');
  check(
    '正在跑的日志是 status=ok + 没有 completed_at（真服务端的形状）',
    inFlight?.status === 'ok' && !('completed_at' in (inFlight ?? {})),
    show(inFlight),
  );
  // 三种样子最终要能被**客户端自己的**映射收成 ok / failed / running。
  const stateOf = (scheduleId) => {
    const raw = (logs.body?.items ?? []).find((log) => log.schedule_id === scheduleId);
    const normalized = model.normalizeLog(raw ?? {});
    return model.lastRunState(normalized.status, normalized.completedAt);
  };
  const states = [
    stateOf('fixture-schedule-morning'),
    stateOf('fixture-schedule-quarter'),
    stateOf('fixture-schedule-hourly'),
  ];
  check(
    '三种样子按客户端 lastRunState 收出来是 ok / failed / running',
    states.join(',') === 'ok,failed,running',
    states.join(','),
  );

  const one = await call(`/bots/${BOT}/schedule/fixture-schedule-morning`);
  check('单条 200', one.status === 200, `实际 ${one.status}`);
  check('单条 id 对得上', one.body?.id === 'fixture-schedule-morning', show(one.body));
  checkScheduleShape('单条', one.body);

  const missing = await call(`/bots/${BOT}/schedule/fixture-schedule-does-not-exist`);
  check('不存在的任务 → 404', missing.status === 404, `实际 ${missing.status}`);
}

async function checkScheduleWrite() {
  console.log('\n— 写语义：POST 校验 / PUT patch / max_calls 三态 / execution 整块 —');
  await setScenario('schedule-default');

  // 缺字段必须是 **500 而不是 400**，且 message 与真服务端一字不差：界面就是靠这条
  // 验"本地先拦，别让用户吃一个服务器错误"。
  for (const field of ['name', 'description', 'pattern', 'command']) {
    const body = { name: 'n', description: 'd', pattern: '0 9 * * *', command: 'c' };
    delete body[field];
    const result = await call(`/bots/${BOT}/schedule`, { method: 'POST', body });
    check(
      `POST 缺 ${field} → 500 + 固定 message`,
      result.status === 500 &&
        result.body?.message === 'name, description, pattern, command are required',
      `实际 ${result.status} ${show(result.body)}`,
    );
  }
  // 空字符串同样缺：Go 的 `binding:"required"` 判零值，界面上也确实先拦。
  const empty = await call(`/bots/${BOT}/schedule`, {
    method: 'POST',
    body: { name: '  ', description: '', pattern: '0 9 * * *', command: 'c' },
  });
  check(
    'POST 空 description → 500',
    empty.status === 500 &&
      empty.body?.message === 'name, description, pattern, command are required',
    `实际 ${empty.status} ${show(empty.body)}`,
  );

  const created = await call(`/bots/${BOT}/schedule`, {
    method: 'POST',
    body: {
      name: '新建的任务',
      description: '用来验写语义',
      pattern: '0 7 * * *',
      command: '把今天的日程发给我',
      enabled: true,
      max_calls: 3,
      run_target: 'new_session',
      model_id: 'kimi-k3',
      reasoning_effort: 'low',
    },
  });
  check(
    'POST 全字段 → 201',
    created.status === 201,
    `实际 ${created.status} ${show(created.body)}`,
  );
  const id = created.body?.id;
  check('POST 返回建好的整条（带 id）', typeof id === 'string' && id !== '', show(created.body));
  check(
    'POST 是平铺形状',
    created.body?.run_target === 'new_session' && created.body?.model_id === 'kimi-k3',
    show(created.body),
  );
  check('POST current_calls 从 0 开始', created.body?.current_calls === 0, show(created.body));
  check('POST max_calls 被存下', created.body?.max_calls === 3, show(created.body));

  const afterCreate = await call(`/bots/${BOT}/schedule`);
  check(
    '新建后列表 4 条',
    afterCreate.body?.items?.length === 4,
    `实际 ${afterCreate.body?.items?.length}`,
  );

  // 只改一个字段：**其余一个都不许变**。这是"改名字把模型覆盖清空了"那条 bug 的
  // 唯一防线——只有在内存里真的做过 patch，才验得出来。
  const before = (afterCreate.body?.items ?? []).find(
    (item) => item.id === 'fixture-schedule-morning',
  );
  const renamed = await call(`/bots/${BOT}/schedule/fixture-schedule-morning`, {
    method: 'PUT',
    body: { name: '改过名字的早报' },
  });
  check(
    'PUT 只给 name → 200',
    renamed.status === 200,
    `实际 ${renamed.status} ${show(renamed.body)}`,
  );
  check('PUT 改到了 name', renamed.body?.name === '改过名字的早报', show(renamed.body?.name));
  const untouched = [
    'description',
    'pattern',
    'enabled',
    'command',
    'current_calls',
    'created_at',
    'bot_id',
    'run_target',
    'model_id',
    'reasoning_effort',
  ].filter((key) => JSON.stringify(renamed.body?.[key]) !== JSON.stringify(before?.[key]));
  check(
    'PUT 只改 name 时其余字段没被动',
    untouched.length === 0,
    untouched.length === 0
      ? ''
      : `被改了：${untouched.map((key) => `${key}: ${show(before?.[key])} → ${show(renamed.body?.[key])}`).join('；')}`,
  );
  const reread = await call(`/bots/${BOT}/schedule/fixture-schedule-morning`);
  check(
    'PUT 的结果真的进了列表数据（GET 读得回来）',
    reread.body?.name === '改过名字的早报',
    show(reread.body?.name),
  );

  const limited = await call(`/bots/${BOT}/schedule/fixture-schedule-morning`, {
    method: 'PUT',
    body: { max_calls: 20 },
  });
  check('PUT max_calls=20 → 出现该键', limited.body?.max_calls === 20, show(limited.body));
  const unlimited = await call(`/bots/${BOT}/schedule/fixture-schedule-morning`, {
    method: 'PUT',
    body: { max_calls: null },
  });
  // 显式 `null` = 取消上限，响应里这个键就该消失（omitempty 的指针，读成"不限"）。
  check(
    'PUT max_calls=null → 键消失（取消上限）',
    !('max_calls' in (unlimited.body ?? {})),
    show(unlimited.body),
  );
  const omittedMax = await call(`/bots/${BOT}/schedule/fixture-schedule-morning`, {
    method: 'PUT',
    body: { name: '省略 max_calls 不算改' },
  });
  check(
    '省略 max_calls 不等于清空',
    !('max_calls' in (omittedMax.body ?? {})),
    show(omittedMax.body),
  );

  // `execution` 整块替换：给全九项 → 九项都在；只给 run_target → 其余八项被清掉。
  const full = {
    execution: {
      run_target: 'session',
      target_session_id: 'fixture-session-active',
      runtime_type: 'native',
      bot_agent_id: 'agent-1',
      acp_agent_id: 'acp-1',
      model_id: 'deepseek-v4-flash',
      acp_model_id: 'acp-model-1',
      reasoning_effort: 'high',
      workdir_id: 'workdir-1',
    },
  };
  const replaced = await call(`/bots/${BOT}/schedule/fixture-schedule-morning`, {
    method: 'PUT',
    body: full,
  });
  const replacedKeys = [
    'target_session_id',
    'runtime_type',
    'bot_agent_id',
    'acp_agent_id',
    'model_id',
    'acp_model_id',
    'reasoning_effort',
    'workdir_id',
  ];
  check(
    'PUT execution 九项平铺写回响应',
    replaced.body?.run_target === 'session' &&
      replacedKeys.every((key) => replaced.body?.[key] === full.execution[key]),
    show(replaced.body),
  );
  const partial = await call(`/bots/${BOT}/schedule/fixture-schedule-morning`, {
    method: 'PUT',
    body: { execution: { run_target: 'new_session' } },
  });
  const leftOver = replacedKeys.filter((key) => key in (partial.body ?? {}));
  check(
    'PUT execution 只给一项 → 其余整块被清掉（不是"保持不变"）',
    partial.body?.run_target === 'new_session' && leftOver.length === 0,
    `残留 ${leftOver.join(', ')} → ${show(partial.body)}`,
  );

  const notFound = await call(`/bots/${BOT}/schedule/fixture-schedule-does-not-exist`, {
    method: 'PUT',
    body: { name: 'x' },
  });
  check('PUT 不存在的任务 → 404', notFound.status === 404, `实际 ${notFound.status}`);

  const deleted = await call(`/bots/${BOT}/schedule/${id}`, { method: 'DELETE' });
  check('DELETE → 204', deleted.status === 204, `实际 ${deleted.status}`);
  const deletedAgain = await call(`/bots/${BOT}/schedule/${id}`, { method: 'DELETE' });
  check('DELETE 同一条两次 → 404', deletedAgain.status === 404, `实际 ${deletedAgain.status}`);
  const afterDelete = await call(`/bots/${BOT}/schedule`);
  check(
    '删除后列表回到 3 条',
    afterDelete.body?.items?.length === 3,
    `实际 ${afterDelete.body?.items?.length}`,
  );

  // 删一条**有日志的**任务：它的日志跟着走（`schedule_logs.schedule_id` 是
  // ON DELETE CASCADE），也就是删完之后这个任务的执行历史也读不到了。
  await call(`/bots/${BOT}/schedule/fixture-schedule-hourly`, { method: 'DELETE' });
  const logsAfterDelete = await call(`/bots/${BOT}/schedule/logs`);
  check(
    '删任务时它的日志一起消失（CASCADE）',
    logsAfterDelete.body?.total_count === 2 &&
      (logsAfterDelete.body?.items ?? []).every(
        (log) => log.schedule_id !== 'fixture-schedule-hourly',
      ),
    show({
      total: logsAfterDelete.body?.total_count,
      ids: (logsAfterDelete.body?.items ?? []).map((log) => log.schedule_id),
    }),
  );
}

/**
 用**客户端自己的模型层**把固定数据读一遍再写回去。

 这一段和上面那些"看 JSON 长什么样"的断言不同：它走的是界面真正会走的代码
 （`src/features/schedule/model.ts` 的 `normalizeSchedule` / `draftOf` / `updatePayload`），
 所以能验出一件纯 JSON 断言验不出的事——**读→改→写 一整圈下来数据没被弄丢**。
 界面最怕的 bug 正是"改了个名字，模型覆盖和推理强度被清空"，而它只在真的往返一次
 之后才现形。
 */
async function checkClientRoundTrip() {
  console.log('\n— 用客户端模型层走一遍读→改→写 —');
  await setScenario('schedule-default');
  const raw = await call(`/bots/${BOT}/schedule/fixture-schedule-quarter`);
  const before = model.normalizeSchedule(raw.body);
  check(
    'normalizeSchedule 读得出九个执行字段（平铺收成对象）',
    before.execution.runTarget === 'session' &&
      before.execution.targetSessionId === 'fixture-session-active' &&
      before.execution.runtimeType === 'native' &&
      before.execution.workdirId === 'fixture-workdir-home',
    show(before.execution),
  );
  check('maxCalls 缺失读成 null（不限），不是 0', before.maxCalls === null, show(before.maxCalls));

  // 草稿就用归一化后的值拼（`draftOf` 在 `useSchedule.ts` 里，那个文件 import 了
  // React，探针不该为一个纯函数把整棵界面依赖拉进来）。
  const draft = {
    name: before.name,
    description: before.description,
    pattern: before.pattern,
    command: before.command,
    enabled: before.enabled,
    maxCalls: before.maxCalls,
    execution: before.execution,
  };
  const patch = model.updatePayload({ ...draft, name: '只改名字' });
  const written = await call(`/bots/${BOT}/schedule/fixture-schedule-quarter`, {
    method: 'PUT',
    body: patch,
  });
  const after = model.normalizeSchedule(written.body);
  const lost = Object.keys(before.execution).filter(
    (key) => after.execution[key] !== before.execution[key],
  );
  check(
    '改名字后九个执行字段一个都没丢',
    lost.length === 0,
    lost.length === 0 ? '' : `丢了 ${lost.join(', ')}`,
  );
  check(
    '改名字后其余字段也没动',
    after.pattern === before.pattern &&
      after.enabled === before.enabled &&
      after.command === before.command &&
      after.currentCalls === before.currentCalls,
    show({ pattern: after.pattern, enabled: after.enabled, currentCalls: after.currentCalls }),
  );
  check('改名字确实生效了', after.name === '只改名字', show(after.name));

  // 新建走的是**平铺**的 `createPayload`，和修改的嵌套形状不同——两条路都要走通。
  const created = await call(`/bots/${BOT}/schedule`, {
    method: 'POST',
    body: model.createPayload({ ...draft, name: '客户端建的任务' }),
  });
  const createdNormalized = model.normalizeSchedule(created.body);
  check(
    'createPayload（平铺）能被服务端接受并原样读回',
    created.status === 201 &&
      createdNormalized.name === '客户端建的任务' &&
      createdNormalized.pattern === before.pattern,
    `实际 ${created.status} ${show(created.body)}`,
  );
  check(
    '新建后 execution 与草稿一致',
    createdNormalized.execution.modelId === before.execution.modelId &&
      createdNormalized.execution.runTarget === before.execution.runTarget,
    show(createdNormalized.execution),
  );
  if (typeof created.body?.id === 'string') {
    await call(`/bots/${BOT}/schedule/${created.body.id}`, { method: 'DELETE' });
  }
}

async function checkScenarioIsolation() {
  console.log('\n— 场景之间不互相污染 —');
  await setScenario('schedule-default');
  const created = await call(`/bots/${BOT}/schedule/fixture-schedule-morning`, {
    method: 'PUT',
    body: { name: '这条改动只该活在本次场景里' },
  });
  check('准备动作：改掉一条', created.status === 200);

  await setScenario('schedule-empty');
  const emptyList = await call(`/bots/${BOT}/schedule`);
  check(
    'schedule-empty：items 为空',
    emptyList.status === 200 && emptyList.body?.items?.length === 0,
    show(emptyList.body),
  );
  const emptyLogs = await call(`/bots/${BOT}/schedule/logs`);
  check(
    'schedule-empty：日志也为空',
    emptyLogs.body?.items?.length === 0 && emptyLogs.body?.total_count === 0,
    show(emptyLogs.body),
  );

  await setScenario('schedule-default');
  const back = await call(`/bots/${BOT}/schedule/fixture-schedule-morning`);
  check(
    '回到 schedule-default：改动被清掉，数据回到该场景该有的样子',
    back.body?.name === '生成每日早报',
    show(back.body?.name),
  );
}

async function checkScenarioVariants() {
  console.log('\n— schedule-many / schedule-error —');
  await setScenario('schedule-many');
  const many = await call(`/bots/${BOT}/schedule`);
  const items = many.body?.items ?? [];
  check('schedule-many：40 条', items.length === 40, `实际 ${items.length}`);
  check(
    'schedule-many：名字带序号',
    items.every((item, index) => item.name.includes(String(index + 1))),
    show(items.slice(0, 2).map((item) => item.name)),
  );
  check(
    'schedule-many：pattern 有轮换',
    new Set(items.map((item) => item.pattern)).size > 1,
    `${new Set(items.map((item) => item.pattern)).size} 种`,
  );
  check('schedule-many：id 唯一', new Set(items.map((item) => item.id)).size === items.length);
  for (const item of items.slice(0, 3)) checkScheduleShape(`批量 ${item.id}`, item);
  const manyLogs = await call(`/bots/${BOT}/schedule/logs?limit=100`);
  const logItems = manyLogs.body?.items ?? [];
  check(
    'schedule-many：total_count 是分页前的总数',
    manyLogs.body?.total_count === logItems.length && logItems.length > 0,
    show(manyLogs.body?.total_count),
  );
  check(
    'schedule-many：日志只给一部分（不是每条都有）',
    logItems.length < items.length,
    `${logItems.length} 条日志 / ${items.length} 条任务`,
  );
  const manyIds = new Set(items.map((item) => item.id));
  check(
    'schedule-many：日志都指向存在的任务',
    logItems.every((log) => manyIds.has(log.schedule_id)),
  );
  const paged = await call(`/bots/${BOT}/schedule/logs?limit=5&offset=2`);
  check(
    'logs：limit / offset 真的分页（total_count 不变）',
    paged.body?.items?.length === 5 &&
      paged.body?.total_count === logItems.length &&
      paged.body.items[0].id === logItems[2].id,
    show({ returned: paged.body?.items?.length, total: paged.body?.total_count }),
  );

  await setScenario('schedule-error');
  const errorList = await call(`/bots/${BOT}/schedule`);
  check('schedule-error：列表 500', errorList.status === 500, `实际 ${errorList.status}`);
  const errorOne = await call(`/bots/${BOT}/schedule/fixture-schedule-morning`);
  check('schedule-error：单条 500', errorOne.status === 500, `实际 ${errorOne.status}`);
}

async function checkSessions() {
  console.log('\n— 会话列表的长列表与失败态 —');
  await setScenario('sessions-many');
  const many = await call(`/bots/${BOT}/sessions`);
  const items = many.body?.items ?? [];
  check('sessions-many：300 条', items.length === 300, `实际 ${items.length}`);
  check(
    'sessions-many：用 items 而不是 entries',
    Array.isArray(many.body?.items),
    show(many.body).slice(0, 80),
  );
  check(
    'sessions-many：updated_at 递减（越靠后越旧）',
    items.every(
      (item, index) =>
        index === 0 || Date.parse(items[index - 1].updated_at) > Date.parse(item.updated_at),
    ),
  );
  check(
    'sessions-many：名字带序号',
    items.every((item, index) => item.title.includes(String(index + 1))),
    show(items.slice(0, 2).map((item) => item.title)),
  );
  // 长列表里点一行也要能进会话页：详情得解析得出来，否则那是 404 而不是页面。
  const one = await call(`/bots/${BOT}/sessions/${items[items.length - 1]?.id}`);
  check(
    'sessions-many：最后一条能被点开（详情 200）',
    one.status === 200 && one.body?.id === items[items.length - 1]?.id,
    `实际 ${one.status}`,
  );

  await setScenario('home-empty');
  const empty = await call(`/bots/${BOT}/sessions`);
  check(
    'home-empty：空列表 200',
    empty.status === 200 && empty.body?.items?.length === 0,
    show(empty.body),
  );

  await setScenario('home-error');
  const broken = await call(`/bots/${BOT}/sessions`);
  // 500 而不是空列表：空态会说"还没有会话"，那是假话。
  check(
    'home-error：会话列表 500',
    broken.status === 500,
    `实际 ${broken.status} ${show(broken.body)}`,
  );

  /**
   会话状态里的 `skills`（会话信息面板最后那一组要列它）。

   形状是**字符串数组**——`HandlersSessionInfoResponse.skills?: Array<string>`。
   两种形状都要演：默认场景"用过技能"，`compact-unavailable` 场景"没用过"。客户端
   两种情况各有一句不同的话，只有一种形状时那条空态就无法验收。
   */
  await setScenario('default');
  const status = await call(`/bots/${BOT}/sessions/fixture-session-active/status`);
  const skills = status.body?.skills;
  check(
    'status：用过技能时是字符串数组',
    Array.isArray(skills) && skills.length > 0 && skills.every((name) => typeof name === 'string'),
    show(skills),
  );
  check(
    'status：仍然**不给** context_window（面板因此不显示百分比）',
    status.body?.context_usage?.context_window === undefined,
    show(status.body?.context_usage),
  );
  const history = await call(`/bots/${BOT}/messages?session_id=fixture-session-active&limit=50`);
  const historyItems = history.body?.items ?? [];
  check(
    '普通 REST 历史也是 UITurn[]（不是 RenderTurn[]），含可分叉的 assistant turn',
    historyItems.some((turn) => turn.role === 'user' && typeof turn.turn_id === 'string') &&
      historyItems.some(
        (turn) =>
          turn.role === 'assistant' &&
          typeof turn.turn_id === 'string' &&
          Array.isArray(turn.messages) &&
          turn.messages.length > 0,
      ) &&
      historyItems.every((turn) => !('user' in turn) && !('assistant' in turn)),
    show(historyItems.slice(0, 2)),
  );
  await setScenario('compact-unavailable');
  const noSkills = await call(`/bots/${BOT}/sessions/fixture-session-active/status`);
  check(
    'status：没用过技能时是空数组（不是缺字段）',
    Array.isArray(noSkills.body?.skills) && noSkills.body.skills.length === 0,
    show(noSkills.body?.skills),
  );
  await setScenario('default');

  // 回应审批的帧：一开始必须是空的，"最后一条"才有意义（界面没点过 = 没有帧）。
  const noApproval = await call('/__last-approval-response');
  check(
    '审批帧：还没点过时是 null',
    noApproval.status === 200 && noApproval.body === null,
    show(noApproval.body),
  );
}

/**
 分页与"缺字段/null 的会话形状"（2026-09-17 加）。

 这一组钉的是**"界面能看到"的前提**：列表尾部的两个状态（还有更早的会话 / 没拉到更早的
 会话）与消息流上方的翻页失败条，以前在这个固定服务端上**造不出来**——`next_cursor`
 永远空串、`/messages` 无视 `before_message_id`。造不出来的形状就等于没有验收，
 而没有验收的东西会一直坏（2026-09-17 视觉评审的原话）。

 所以这里逐条断言"服务端真的能产出那些形状"，包括**不该有的东西不许有**：
 `next_cursor` 空串时尾部不许冒出"还有更早的"。
 */
async function checkPagingShapes() {
  console.log('\n— 分页：真有下一页 / 第二页失败 / 缺字段的会话 —');

  await setScenario('sessions-paged');
  const first = await call(`/bots/${BOT}/sessions`);
  check(
    'sessions-paged：第一页 50 条',
    first.body?.items?.length === 50,
    `实际 ${first.body?.items?.length}`,
  );
  check(
    'sessions-paged：第一页的 next_cursor **非空**（界面上"还有更早的会话"就靠它）',
    typeof first.body?.next_cursor === 'string' && first.body.next_cursor !== '',
    show(first.body?.next_cursor),
  );
  const second = await call(`/bots/${BOT}/sessions?cursor=${first.body?.next_cursor}`);
  check(
    'sessions-paged：第二页与第一页不重叠、序号接着长',
    second.body?.items?.length === 50 && second.body.items[0]?.id !== first.body.items[0]?.id,
    `${second.body?.items?.[0]?.id} vs ${first.body?.items?.[0]?.id}`,
  );
  const third = await call(`/bots/${BOT}/sessions?cursor=${second.body?.next_cursor}`);
  check(
    'sessions-paged：最后一页的 next_cursor 是空串（= 到底，尾部那行该消失）',
    third.body?.items?.length === 20 && third.body?.next_cursor === '',
    `${third.body?.items?.length} / ${show(third.body?.next_cursor)}`,
  );
  check(
    'sessions-paged：不认识的游标回空页，不装作还有内容',
    (await call(`/bots/${BOT}/sessions?cursor=nonsense`)).body?.items?.length === 0,
  );

  await setScenario('sessions-more-error');
  const errorFirst = await call(`/bots/${BOT}/sessions`);
  check(
    'sessions-more-error：第一页照常（尾部要能出现"还有更早的"）',
    errorFirst.status === 200 && errorFirst.body?.next_cursor !== '',
    `${errorFirst.status} / ${show(errorFirst.body?.next_cursor)}`,
  );
  const errorSecond = await call(`/bots/${BOT}/sessions?cursor=${errorFirst.body?.next_cursor}`);
  check(
    'sessions-more-error：第二页 500（失败态要说一句、游标要留着）',
    errorSecond.status === 500,
    `实际 ${errorSecond.status}`,
  );
  /**
   分页流水：验收要断言"失败之后重试拿的是**同一个游标**"。界面只能证明"重试之后好了"，
   证明不了它用的是哪个游标——所以这个流水必须真的按请求逐条记。
   */
  const pageLog = await call('/__page-log');
  check(
    '/__page-log：逐条记下会话分页的游标与状态（同一游标先 500 再重试）',
    pageLog.status === 200 &&
      pageLog.body?.sessions?.length === 2 &&
      pageLog.body.sessions[0]?.cursor === '' &&
      pageLog.body.sessions[0]?.status === 200 &&
      pageLog.body.sessions[1]?.cursor === errorFirst.body?.next_cursor &&
      pageLog.body.sessions[1]?.status === 500,
    show(pageLog.body?.sessions),
  );

  /**
   短页那两档（`verification/ui` 那一层没有滑动，所以尾部那行必须落在首屏里）。

   判据不只是"能出数据"，还包括**它真的短**：页大小如果不是 3，那一层的 case 会在 50 条的
   列表底下找不到尾部那行，而失败信息看起来像"界面没画"。
   */
  await setScenario('sessions-paged-short');
  const shortFirst = await call(`/bots/${BOT}/sessions`);
  const shortSecond = await call(`/bots/${BOT}/sessions?cursor=${shortFirst.body?.next_cursor}`);
  check(
    'sessions-paged-short：第一页 3 条 + 游标非空（尾部落在首屏）',
    shortFirst.body?.items?.length === 3 && shortFirst.body?.next_cursor === 'fixture-paged-1',
    `${shortFirst.body?.items?.length} / ${show(shortFirst.body?.next_cursor)}`,
  );
  check(
    'sessions-paged-short：第二页 3 条 + 游标空串（到底）',
    shortSecond.body?.items?.length === 3 && shortSecond.body?.next_cursor === '',
    `${shortSecond.body?.items?.length} / ${show(shortSecond.body?.next_cursor)}`,
  );

  await setScenario('sessions-more-error-short');
  const shortErrorFirst = await call(`/bots/${BOT}/sessions`);
  const shortErrorSecond = await call(
    `/bots/${BOT}/sessions?cursor=${shortErrorFirst.body?.next_cursor}`,
  );
  check(
    'sessions-more-error-short：第一页 3 条正常，第二页 500',
    shortErrorFirst.body?.items?.length === 3 && shortErrorSecond.status === 500,
    `${shortErrorFirst.body?.items?.length} / ${shortErrorSecond.status}`,
  );

  await setScenario('sessions-sparse');
  const sparse = await call(`/bots/${BOT}/sessions`);
  const sparseItems = sparse.body?.items ?? [];
  check(
    'sessions-sparse：三条特殊形状都在',
    sparseItems.length === 3,
    `实际 ${sparseItems.length}`,
  );
  check(
    'sessions-sparse：标题空串那一条（真实的"新会话"）',
    sparseItems[0]?.title === '',
    show(sparseItems[0]?.title),
  );
  check(
    'sessions-sparse：`channel_type` 与 `type` 真的缺字段（不是空串）',
    sparseItems[1] !== undefined &&
      !('channel_type' in sparseItems[1]) &&
      !('type' in sparseItems[1]),
    show(Object.keys(sparseItems[1] ?? {})),
  );
  check(
    'sessions-sparse：`title` 真的是 `null`（JSON 显式 null）',
    sparseItems[2]?.title === null && 'title' in sparseItems[2],
    show(sparseItems[2]?.title),
  );

  /**
   往前翻页那条路（`chat-older-error` / `chat-older-ok`）。

   两条都要：第一页**必须有游标**（`turn.id`），否则客户端根本不会去翻页——
   而失败条只在"翻页失败"时才存在，游标为空时它永远不出现。
   */
  await setScenario('chat-older-error');
  const olderFirst = await call(`/bots/${BOT}/messages?session_id=fixture-session-older&limit=100`);
  const olderItems = olderFirst.body?.items ?? [];
  check(
    'chat-older-error：第一页是 20 轮 = 40 条 UITurn（每轮 user/assistant 各一条）',
    olderItems.length === 40 && typeof olderItems[0]?.turn_id === 'string',
    `实际 ${olderItems.length} 条，第一条 ${show(olderItems[0])}`.slice(0, 120),
  );
  check(
    'chat-older-error：最老那一轮带 `id`（往前翻页的游标就是它）',
    typeof olderItems[0]?.id === 'string' && olderItems[0].id !== '',
    show(olderItems[0]?.id),
  );
  const olderFailed = await call(
    `/bots/${BOT}/messages?session_id=fixture-session-older&before_message_id=older-row-21`,
  );
  check(
    'chat-older-error：带游标的那一跳 500（界面上要出现"没能拉到更早的消息"）',
    olderFailed.status === 500,
    `实际 ${olderFailed.status}`,
  );

  await setScenario('chat-older-ok');
  const olderOk = await call(
    `/bots/${BOT}/messages?session_id=fixture-session-older&before_message_id=older-row-21`,
  );
  const olderOkItems = olderOk.body?.items ?? [];
  check(
    'chat-older-ok：同样的那一跳回更老的一页（"重试"要真的接上内容）',
    olderOk.status === 200 && olderOkItems.length === 40 && olderOkItems[0]?.id === 'older-row-1',
    `${olderOk.status} / ${olderOkItems.length} / ${show(olderOkItems[0]?.id)}`,
  );

  await setScenario('default');
}

async function checkFiles() {
  console.log('\n— 文件树：fs-many 与"不替客户端排序" —');
  await setScenario('default');
  const base = await call(`/bots/${BOT}/container/fs/list?path=/data`);
  const baseEntries = base.body?.entries ?? [];
  check(
    '默认场景：fs/list 用 entries（不是 items）',
    Array.isArray(base.body?.entries) && !('items' in (base.body ?? {})),
    show(Object.keys(base.body ?? {})),
  );
  const firstFile = baseEntries.findIndex((entry) => entry.isDir === false);
  const firstDir = baseEntries.findIndex((entry) => entry.isDir === true);
  // dirs-first 是**客户端**行为（`src/features/files/entries.ts`）。固定服务端要是
  // 先替它排好序，那条断言就等于被删了——截图里看不出客户端到底做了没做。
  check(
    '默认场景：服务端不排序（文件出现在目录之前）',
    firstFile !== -1 && firstDir !== -1 && firstFile < firstDir,
    `首个文件 #${firstFile}，首个目录 #${firstDir}`,
  );

  await setScenario('fs-many');
  const many = await call(`/bots/${BOT}/container/fs/list?path=/data`);
  const entries = many.body?.entries ?? [];
  check('fs-many：data/ 下 300 项', entries.length === 300, `实际 ${entries.length}`);
  const directories = entries.filter((entry) => entry.isDir === true);
  const files = entries.filter((entry) => entry.isDir === false);
  check(
    'fs-many：目录与文件混合',
    directories.length > 0 && files.length > 0,
    `目录 ${directories.length} / 文件 ${files.length}`,
  );
  check(
    'fs-many：每个条目都有大小与时间',
    entries.every((entry) => typeof entry.size === 'number' && typeof entry.modTime === 'string'),
    show(entries[0]),
  );
  // 同样不排序：目录与文件按生成顺序交错，客户端该自己把目录排前面。
  const manyFirstFile = entries.findIndex((entry) => entry.isDir === false);
  const manyFirstDir = entries.findIndex((entry) => entry.isDir === true);
  check(
    'fs-many：服务端不排序（文件出现在目录之前）',
    manyFirstFile !== -1 && manyFirstDir !== -1 && manyFirstFile < manyFirstDir,
    `首个文件 #${manyFirstFile}，首个目录 #${manyFirstDir}`,
  );
  // ⚠️ stat 的路径是 `/container/fs?path=...`（没有 `/stat` 后缀），照客户端
  // `statFile` 的写法来。
  const one = await call(
    `/bots/${BOT}/container/fs?path=${encodeURIComponent(files[0]?.path ?? '')}`,
  );
  check(
    'fs-many：条目能 stat（不是只列出来）',
    one.status === 200 && one.body?.path === files[0]?.path,
    `实际 ${one.status} ${show(one.body)}`,
  );
}

/**
 端到端旅程用到的三个钩子：登录必拒、写必败、**只跳一次**的 seq 空洞。

 为什么要在这里验：这三个都是"让服务端演一个坏情况"，而它们自己坏了的表现是
 "旅程莫名其妙过不去"——那种红最难归因。放在自检里，几秒钟就能把 ① 开关没生效、
 ② 关不回去（渗到下一条）③ 只跳一次变成每次都跳 这三种错分开。
 */
async function checkE2eHooks() {
  console.log('\n— 端到端旅程的钩子 —');
  const credentials = { username: 'fixture', password: 'fixture' };

  async function fault(path, body) {
    const response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.json();
  }

  // ① 登录必拒。默认必须是**正常**——随开随坏会让所有别的验收莫名其妙红。
  const discoveryProbe = await call('/auth/login', { method: 'POST', body: {} });
  check(
    '空登录载荷只证明路由存在（400）',
    discoveryProbe.status === 400,
    show(discoveryProbe.status),
  );
  const beforeLogin = await call('/auth/login', { method: 'POST', body: credentials });
  check('默认登录是正常的', beforeLogin.status === 200, show(beforeLogin.status));
  await fault('/__auth-fault', { mode: 'reject', times: 1 });
  const guardedProbe = await call('/auth/login', { method: 'POST', body: {} });
  check(
    '空登录载荷不消耗一次性 401 故障额度',
    guardedProbe.status === 400,
    show(guardedProbe.status),
  );
  const rejected = await call('/auth/login', { method: 'POST', body: credentials });
  check('打开后登录回 401', rejected.status === 401, show(rejected.status));
  await fault('/__auth-fault', { mode: 'normal' });
  const restored = await call('/auth/login', { method: 'POST', body: credentials });
  check('关掉之后恢复', restored.status === 200, show(restored.status));

  // ② 写必败：bot 的两种写都要挡住（设置页改名字走 PUT，改模型走 POST）。
  await fault('/__write-fault', { mode: 'fail' });
  const putFailed = await call(`/bots/${BOT}`, { method: 'PUT', body: { display_name: 'x' } });
  const settingsFailed = await call(`/bots/${BOT}/settings`, {
    method: 'POST',
    body: { chat_model_id: 'k3' },
  });
  check(
    '写故障：PUT 与设置都回 500',
    putFailed.status === 500 && settingsFailed.status === 500,
    `${putFailed.status}/${settingsFailed.status}`,
  );
  await fault('/__write-fault', { mode: 'normal' });
  const putOk = await call(`/bots/${BOT}`, { method: 'PUT', body: { display_name: 'assistant' } });
  check('写故障关掉之后能写', putOk.status === 200, show(putOk.status));

  // ③ 新建会话：旅程"新建会话 → 发消息"的起点。建出来的会话要能查、能列。
  const created = await call(`/bots/${BOT}/sessions`, { method: 'POST', body: { title: '' } });
  const createdId = created.body?.id;
  check(
    'POST /sessions 返回 201 与会话',
    created.status === 201 && typeof createdId === 'string',
    `${created.status}/${createdId}`,
  );
  const listed = await call(`/bots/${BOT}/sessions`);
  check(
    '新建的会话进得了列表',
    (listed.body?.items ?? []).some((item) => item.id === createdId),
    show((listed.body?.items ?? []).length),
  );
  const single = await call(`/bots/${BOT}/sessions/${createdId}`);
  check(
    '新建的会话查得到',
    single.status === 200 && single.body?.id === createdId,
    show(single.status),
  );
  const history = await call(`/bots/${BOT}/messages?session_id=${createdId}`);
  check(
    '新建的会话没有历史（刚开的会话是空的）',
    (history.body?.items ?? []).length === 0,
    show(history.body?.items),
  );

  // ④ 会话动作：重命名必须改进列表；分叉必须建出一条能查、能开的新会话。
  const sourceHistory = await call(
    `/bots/${BOT}/messages?session_id=fixture-session-long-title&limit=50`,
  );
  const assistantTurnId = sourceHistory.body?.items?.find(
    (turn) => turn.role === 'assistant',
  )?.turn_id;
  const renamed = await call(`/bots/${BOT}/sessions/fixture-session-long-title`, {
    method: 'PATCH',
    body: { title: 'Renamed session' },
  });
  const afterRename = await call(`/bots/${BOT}/sessions`);
  check(
    'PATCH /sessions 返回更新后的会话并同步列表',
    renamed.status === 200 &&
      renamed.body?.title === 'Renamed session' &&
      afterRename.body?.items?.find((item) => item.id === 'fixture-session-long-title')?.title ===
        'Renamed session',
    `${renamed.status}/${show(renamed.body?.title)}`,
  );

  const forked = await call(`/bots/${BOT}/sessions/fixture-session-long-title/fork`, {
    method: 'POST',
    body: { turn_id: assistantTurnId, title: 'Renamed session (fork)' },
  });
  const forkedId = forked.body?.id;
  const forkedOne = await call(`/bots/${BOT}/sessions/${forkedId}`);
  const forkedHistory = await call(`/bots/${BOT}/messages?session_id=${forkedId}`);
  const actionLog = await call('/__session-action-log');
  check(
    'POST /fork 返回 201，新会话能查、复制源历史且在请求账里保留助手轮次锚点',
    forked.status === 201 &&
      typeof forkedId === 'string' &&
      forkedOne.status === 200 &&
      forkedOne.body?.title === 'Renamed session (fork)' &&
      forkedHistory.body?.items?.some((turn) => turn.role === 'assistant') &&
      actionLog.body?.patches?.[0]?.body?.title === 'Renamed session' &&
      typeof assistantTurnId === 'string' &&
      actionLog.body?.forks?.[0]?.body?.turn_id === assistantTurnId &&
      actionLog.body?.forks?.[0]?.created_session_id === forkedId,
    `${forked.status}/${forkedOne.status}/${forkedHistory.body?.items?.length}/${show(actionLog.body)}`,
  );

  /**
   **没有 session_id 的消息** = "新建会话页发出的第一句"（端到端旅程 3 的第一步）。

   协议是：服务端建会话 → `session_created` 告知 id → 之后的帧都挂在那个 id 上。
   这一步不实现的话，那条旅程只有一个空会话页可看。这里验的是三件事：
   ① 回 `session_created`；② 新建的会话进得了列表；③ 回的那一轮里，
   **回显的用户轮次是我刚发的那句话**（不是场景里写死的那句）。
   */
  await setScenario('default');
  const firstMessage = await new Promise((resolve) => {
    const received = [];
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/bots/${BOT}/web/ws`);
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({ type: 'message', invocation_id: 'probe-1', text: 'probe first message' }),
      );
    });
    socket.addEventListener('message', (event) => received.push(JSON.parse(event.data)));
    setTimeout(() => {
      socket.close();
      resolve(received);
    }, 1400);
  });
  const createdEvent = firstMessage.find((frame) => frame.type === 'session_created');
  check(
    '没有 session_id 的消息会拿到 session_created',
    typeof createdEvent?.session_id === 'string',
    show(createdEvent),
  );
  const autoCreatedId = createdEvent?.session_id;
  const afterCreate = (await call(`/bots/${BOT}/sessions`)).body?.items ?? [];
  check(
    '这样建出来的会话进得了列表',
    afterCreate.some((item) => item.id === autoCreatedId),
    show(afterCreate.length),
  );
  const echoed = firstMessage.some(
    (frame) =>
      frame.type === 'runtime_delta' &&
      (frame.delta?.user_turn_upserts ?? []).some((turn) => turn.text === 'probe first message'),
  );
  check('回的那一轮里带着我发的那句话（回显）', echoed, `收到 ${firstMessage.length} 帧`);

  // ④ `gap-once`：第一次订阅跳号，重订阅是正常的——这是"空洞后的自愈"能验到的前提。
  await setScenario('gap-once');
  const collectSeqs = async (ms) => {
    const seqs = [];
    await new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${PORT}/bots/${BOT}/web/ws`);
      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify({ type: 'runtime_subscribe', session_id: 'fixture-session-active' }),
        );
      });
      socket.addEventListener('message', (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type === 'runtime_delta') seqs.push(frame.seq);
      });
      setTimeout(() => {
        socket.close();
        resolve();
      }, ms);
    });
    return seqs;
  };
  const firstSeqs = await collectSeqs(700);
  check(
    'gap-once：第一次订阅跳号（1 之后不是 2）',
    firstSeqs.length >= 2 && firstSeqs[1] > firstSeqs[0] + 1,
    show(firstSeqs),
  );
  const secondSeqs = await collectSeqs(700);
  check(
    'gap-once：重订阅之后是连续的（自愈有终点）',
    secondSeqs.length >= 2 && secondSeqs[1] === secondSeqs[0] + 1,
    show(secondSeqs),
  );

  // 帧日志要能回答"这句话发给哪个 bot 了"（切换 agent 那条旅程的核心证据）。
  const log = await call('/__ws-log');
  check(
    '帧日志带 bot',
    (log.body?.frames ?? []).length > 0 &&
      (log.body?.frames ?? []).every((f) => typeof f.bot === 'string'),
    show((log.body?.frames ?? [])[0]),
  );

  // 切场景必须把钩子清干净（否则上一条旅程的故障会跟到下一条）。
  await setScenario('default');
  const afterSwitch = await call('/auth/login', { method: 'POST', body: credentials });
  const sessionsAfter = (await call(`/bots/${BOT}/sessions`)).body?.items ?? [];
  check(
    '切场景把登录故障与新建会话都清掉',
    afterSwitch.status === 200 && sessionsAfter.length === 5,
    `${afterSwitch.status}/${sessionsAfter.length}`,
  );
}

/**
 切换器 / 新建 bot 用的那几个端点。

 它们存在的意义是**让验收能真跑一遍创建流程**：dev 栈上建一个 bot 要真拉容器，
 又慢又动生产数据。这几条断言盯的是"界面能看到的四种状态都拿得到"：
 名字可用性的四种 reason、列表里四种形状的 bot、以及 creating → ready 的轮询。
 */
async function checkBots() {
  console.log('\n— bots：切换器与新建 —');
  await setScenario('bots-many');
  const many = await call('/bots');
  const items = many.body?.items ?? [];
  check('bots-many：四个 bot', items.length === 4, show(items.length));
  check(
    'bots-many：有一个 check_state=issue',
    items.some((b) => b.check_state === 'issue'),
    'issue',
  );
  check(
    'bots-many：有一个 status=creating',
    items.some((b) => b.status === 'creating'),
    'creating',
  );
  check(
    'bots-many：有一个带头像 url',
    items.some((b) => b.avatar_url !== ''),
    'avatar',
  );

  const available = await call('/bots/name-availability?name=fresh-name');
  check('名字可用', available.body?.available === true, show(available.body));
  const taken = await call('/bots/name-availability?name=assistant');
  check('名字被占用', taken.body?.reason === 'taken', show(taken.body));
  const reserved = await call('/bots/name-availability?name=bots');
  check('名称保留字', reserved.body?.reason === 'reserved', show(reserved.body));
  const invalid = await call('/bots/name-availability?name=Bad_Name');
  check('名字形状不对', invalid.body?.reason === 'invalid', show(invalid.body));

  const created = await call('/bots', {
    method: 'POST',
    body: { name: 'probe-agent', display_name: '探针 agent' },
  });
  check(
    '新建返回 201 且是 creating',
    created.status === 201 && created.body?.status === 'creating',
    `${created.status}/${created.body?.status}`,
  );
  const id = created.body?.id;
  const first = await call(`/bots/${id}`);
  check('第一次问还在建', first.body?.status === 'creating', show(first.body?.status));
  await call(`/bots/${id}`);
  const third = await call(`/bots/${id}`);
  check('第三次问已就绪', third.body?.status === 'ready', show(third.body?.status));
  const conflict = await call('/bots', { method: 'POST', body: { name: 'assistant' } });
  check('重名返回 409', conflict.status === 409, show(conflict.status));

  await setScenario('default');
  const after = await call('/bots');
  check(
    '切场景清掉建出来的 bot',
    (after.body?.items ?? []).length === 1,
    show((after.body?.items ?? []).length),
  );

  /**
   真服务端的形状：`avatar_url` 这个 key **不在响应里**（dev 栈实测），以及显式 `null`。

   这条盯的是"固定服务端能造出真形状"——以前它只会给 `''`，所以客户端里
   "把 `avatar_url` 当必然存在"的写法（`.trim()`）在这套验收里永远绿，
   而 dev 栈上一进会话列表就红屏（2026-09-16）。
   */
  await setScenario('bots-avatar-missing');
  const shaped = await call('/bots');
  const shapedItems = shaped.body?.items ?? [];
  check('bots-avatar-missing：两条记录', shapedItems.length === 2, show(shapedItems.length));
  check(
    'bots-avatar-missing：有一条**没有** avatar_url 这个 key',
    shapedItems.some((b) => !('avatar_url' in b)),
    'absent',
  );
  check(
    'bots-avatar-missing：有一条 avatar_url 是 null',
    shapedItems.some((b) => 'avatar_url' in b && b.avatar_url === null),
    'null',
  );
  check(
    'bots-avatar-missing：其余字段照真服务端给全（只缺这一个）',
    shapedItems.every(
      (b) =>
        typeof b.id === 'string' &&
        typeof b.name === 'string' &&
        typeof b.display_name === 'string' &&
        typeof b.check_state === 'string' &&
        typeof b.status === 'string' &&
        Array.isArray(b.current_user_permissions),
    ),
    'shape',
  );
  const shapedOne = await call(`/bots/${BOT}`);
  check(
    'bots-avatar-missing：按 id 取也是同一个形状',
    shapedOne.status === 200 && !('avatar_url' in shapedOne.body),
    show(shapedOne.body?.avatar_url),
  );

  await setScenario('default');
  const normal = await call('/bots');
  check(
    '默认场景的形状没变（仍然给空串，不是缺失）',
    (normal.body?.items ?? []).every((b) => b.avatar_url === ''),
    show((normal.body?.items ?? []).map((b) => b.avatar_url)),
  );
}

/**
 错误/失败类场景的自检。

 这一组不是"顺便验一下 500 能不能返回"：**每一个错误态都要能被造出来**，否则界面上那句
 文案就是死代码，没人知道它到底长什么样。所以探针把每条场景的**关键字段**钉住：
 状态码对不对、有没有带类型化 `code`（决定客户端能不能透出服务端原文）、
 以及"能不能重试"那一档（403/404 不该被当成可重试的传输层错误）。
 */
async function checkErrors() {
  console.log('\n— 错误场景：每一条都得能造出来 —');

  await setScenario('bots-error');
  const bots = await call('/bots');
  check(
    'bots-error：bot 列表 500（不然界面会停在一句假话上）',
    bots.status === 500,
    `${bots.status}`,
  );

  await setScenario('home-error');
  const sessions = await call(`/bots/${BOT}/sessions`);
  check('home-error：会话列表 500', sessions.status === 500, `${sessions.status}`);
  /**
   诊断接口本身也要验：断言"界面没说话"时，**先分清是没发请求还是发了拿到 200**。
   这两个数就是干这个的；它坏了的表现是"以后每次查弱网/错误态都要靠猜"。
   */
  const readBack = await call('/__scenario');
  check(
    'GET /__scenario：读得到当前场景与"会话列表被问过几次、最后回什么"',
    readBack.body?.scenario === 'home-error' &&
      readBack.body?.sessionsListHits >= 1 &&
      readBack.body?.lastSessionsStatus === 500,
    show(readBack.body),
  );

  await setScenario('home-denied');
  const denied = await call(`/bots/${BOT}/sessions`);
  check('home-denied：403（可重试的白名单里没有它）', denied.status === 403, `${denied.status}`);

  await setScenario('bot-error');
  const oneBot = await call(`/bots/${BOT}`);
  check('bot-error：单个 bot 500', oneBot.status === 500, `${oneBot.status}`);

  await setScenario('models-error');
  const models = await call('/models');
  check('models-error：模型目录 500', models.status === 500, `${models.status}`);

  // 技能清单的失败态：它和"这台 bot 没有技能"必须是两种画法（R41）。
  await setScenario('skills-error');
  const skillsFailed = await call(`/bots/${BOT}/skills/catalog`);
  check(
    'skills-error：技能清单 500（"拉不到"与"没有技能"是两件事）',
    skillsFailed.status === 500,
    `${skillsFailed.status}`,
  );
  await setScenario('default');
  const skillsOk = await call(`/bots/${BOT}/skills/catalog`);
  check(
    '切回默认场景：技能清单恢复 200 且有 2 条',
    skillsOk.status === 200 && (skillsOk.body?.skills ?? []).length === 2,
    show([skillsOk.status, (skillsOk.body?.skills ?? []).length]),
  );

  await setScenario('fs-missing');
  const missing = await call(`/bots/${BOT}/container/fs/list?path=/data/docs`);
  check('fs-missing：目录 404（不是空目录）', missing.status === 404, `${missing.status}`);
  const stillThere = await call(`/bots/${BOT}/container/fs/list?path=/data`);
  check(
    'fs-missing：只影响那一个目录，列表本身照常',
    stillThere.status === 200,
    `${stillThere.status}`,
  );

  await setScenario('schedule-error');
  const schedule = await call(`/bots/${BOT}/schedule`);
  check('schedule-error：定时列表 500', schedule.status === 500, `${schedule.status}`);

  await setScenario('schedule-save-error');
  const saveFailed = await call(`/bots/${BOT}/schedule`, {
    method: 'POST',
    body: { name: 'n', description: 'd', pattern: '0 9 * * *', command: 'c', enabled: true },
  });
  check(
    'schedule-save-error：写失败带类型化 code（原因可以给用户看）',
    saveFailed.status === 500 && saveFailed.body?.code === 'schedule_write_conflict',
    show([saveFailed.status, saveFailed.body?.code]),
  );
  /**
   编辑**已有**任务走的是 PUT，不是 POST。

   2026-09-16 踩到：只在 POST 上挡了一下，于是那条验收实际验的是"保存成功"——
   界面照常退回列表，断言在错误块上失败，看起来像功能回归。两条路都要挡，这里也都要钉。
   */
  const editFailed = await call(`/bots/${BOT}/schedule/fixture-schedule-morning`, {
    method: 'PUT',
    body: { name: 'renamed' },
  });
  check(
    'schedule-save-error：**PUT**（编辑已有任务）也失败，且带同一个 code',
    editFailed.status === 500 && editFailed.body?.code === 'schedule_write_conflict',
    show([editFailed.status, editFailed.body?.code]),
  );

  await setScenario('login-rejected');
  const rejected = await call('/auth/login', {
    method: 'POST',
    body: { username: 'fixture', password: 'wrong' },
  });
  check('login-rejected：401', rejected.status === 401, `${rejected.status}`);

  await setScenario('login-error');
  const broken = await call('/auth/login', {
    method: 'POST',
    body: { username: 'fixture', password: 'fixture' },
  });
  check(
    'login-error：500 且**不带** code',
    broken.status === 500 && broken.body?.code === undefined,
    show([broken.status, broken.body?.code]),
  );
  check(
    'login-error：原文是给开发者看的那一类（断言用得上）',
    typeof broken.body?.error === 'string' && broken.body.error.includes('pq:'),
    show(broken.body?.error),
  );

  await setScenario('default');
}

async function checkModels() {
  console.log('\n— models：模型选择器的数据 —');
  const models = await call('/models');
  // 家数与 `manyModels()` 同步：加了第三家 provider（认不出图标的那家）时这里也要跟着改。
  check('目录返回 6 条', (models.body ?? []).length === 6, show((models.body ?? []).length));
  const k3 = (models.body ?? []).find((m) => m.model_id === 'k3');
  check('k3 关不掉思考', k3?.reasoning?.can_disable === false, show(k3?.reasoning));
  check('k3 有三档', (k3?.reasoning?.efforts ?? []).length === 3, show(k3?.reasoning?.efforts));
  const created = await call(`/bots/${BOT}/schedule`, {
    method: 'POST',
    body: { name: 'n', description: 'd', pattern: '0 9 * * 3,5', command: 'c', enabled: true },
  });
  check(
    '新建定时任务会把 pattern 原样收下',
    created.status === 201 && created.body?.pattern === '0 9 * * 3,5',
    show([created.status, created.body?.pattern]),
  );

  const container = await call(`/bots/${BOT}/container`);
  check(
    '容器在跑但任务闲着（两件事分开）',
    container.body?.status === 'running' && container.body?.task_running === false,
    show([container.body?.status, container.body?.task_running]),
  );
  const metrics = await call(`/bots/${BOT}/container/metrics`);
  check(
    '用量有 cpu 与上限',
    metrics.body?.metrics?.cpu?.usage_percent !== undefined &&
      metrics.body?.resource_limits?.memory?.limit_bytes !== undefined,
    show(metrics.body?.metrics?.cpu),
  );
  const display = await call(`/bots/${BOT}/container/display`);
  check(
    '桌面：可用但没在推',
    display.body?.available === true && display.body?.running === false,
    show([display.body?.available, display.body?.running]),
  );

  await setScenario('compact-unavailable');
  const unavailable = await call(`/bots/${BOT}/sessions/s/compact`, { method: 'POST' });
  check(
    '压不了时给类型化错误码',
    unavailable.status === 400 && unavailable.body?.code === 'compaction_model_unavailable',
    show([unavailable.status, unavailable.body?.code]),
  );
  await setScenario('default');
  const compacted = await call(`/bots/${BOT}/sessions/s/compact`, { method: 'POST' });
  check('压缩成功带条数', compacted.body?.message_count === 7, show(compacted.body?.message_count));

  const botSettings = await call(`/bots/${BOT}/settings`);
  check(
    '设置里有 display_enabled',
    botSettings.body?.display_enabled === true,
    show(botSettings.body?.display_enabled),
  );
  // 对话语言的默认值必须是字符串 `"auto"`：桌面端与实测的部署实例都是这个形状，
  // 客户端据此把"跟随"当成一项（而不是"没这个字段"）。
  check(
    '设置里的语言默认是 auto',
    botSettings.body?.language === 'auto',
    show(botSettings.body?.language),
  );
  const settingsWrite = await call(`/bots/${BOT}/settings`, {
    method: 'POST',
    body: { chat_model_id: 'k3', language: 'zh-cn' },
  });
  check(
    '设置是"只覆盖传了的键"',
    settingsWrite.body?.chat_model_id === 'k3' &&
      settingsWrite.body?.language === 'zh-cn' &&
      settingsWrite.body?.display_enabled === true,
    show(settingsWrite.body),
  );
  // 语言是这个接口上**唯一**不走指针语义的字段：空串在真服务端会被归一化成 `"auto"`。
  const resetLanguage = await call(`/bots/${BOT}/settings`, {
    method: 'POST',
    body: { language: '' },
  });
  check(
    '语言发空串会被归一化成 auto（照真服务端）',
    resetLanguage.body?.language === 'auto' && resetLanguage.body?.chat_model_id === 'k3',
    show(resetLanguage.body?.language),
  );
  const checks = await call(`/bots/${BOT}/checks`);
  check(
    '检查里有通过也有未通过',
    (checks.body?.items ?? []).every((item) => typeof item.summary === 'string') &&
      (checks.body?.items ?? []).length === 2,
    show((checks.body?.items ?? []).length),
  );
  const botPatch = await call(`/bots/${BOT}`, {
    method: 'PUT',
    body: { display_name: '探针改名' },
  });
  check(
    'PUT 只覆盖传了的字段',
    botPatch.body?.display_name === '探针改名' && botPatch.body?.name === 'assistant',
    show([botPatch.body?.display_name, botPatch.body?.name]),
  );

  const skills = await call(`/bots/${BOT}/skills/catalog`);
  check(
    '技能清单两条',
    (skills.body?.skills ?? []).length === 2,
    show((skills.body?.skills ?? []).length),
  );
  check(
    '技能带 description',
    (skills.body?.skills?.[0]?.description ?? '') !== '',
    show(skills.body?.skills?.[0]?.description),
  );
  const providers = await call('/providers');
  check(
    'provider 有名字',
    providers.body?.providers?.[0]?.name === 'Kimi',
    show(providers.body?.providers?.[0]?.name),
  );
}

async function checkTimezone() {
  console.log('\n— tz-pacific：bot 时区 —');
  await setScenario('default');
  const shanghai = await call('/bots');
  check(
    '默认场景：Asia/Shanghai',
    shanghai.body?.items?.[0]?.timezone === 'Asia/Shanghai',
    show(shanghai.body?.items?.[0]?.timezone),
  );

  await setScenario('tz-pacific');
  const pacific = await call('/bots');
  check(
    'tz-pacific：America/Los_Angeles',
    pacific.body?.items?.[0]?.timezone === 'America/Los_Angeles',
    show(pacific.body?.items?.[0]?.timezone),
  );
  // 时区是"下次执行"怎么算的输入：这个场景必须仍有任务，否则截图里没有那一栏。
  const list = await call(`/bots/${BOT}/schedule`);
  check(
    'tz-pacific：定时任务数据还在',
    list.status === 200 && list.body?.items?.length > 0,
    show(list.body?.items?.length),
  );

  await setScenario('default');
  const restored = await call('/bots');
  check(
    '切回默认场景：时区回到 Asia/Shanghai',
    restored.body?.items?.[0]?.timezone === 'Asia/Shanghai',
    show(restored.body?.items?.[0]?.timezone),
  );
}

// ------------------------------------------------------------------ 起/收服务端

async function reachable() {
  try {
    const response = await fetch(`${BASE}/bots`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startServer() {
  // **没有"复用"这一支**：`PORT` 已经确认过是空的（`exclusivePort`），这一支起的就是
  // 这次自检自己的服务端。端口若在两步之间被别人抢走，那要**失败**而不是拿别人的进程
  // 当自己的验——那正是"测的是别人旧代码"的来源。
  const child = spawn('node', [SERVER, '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await reachable()) {
      console.log(`固定服务端就绪：${BASE}（pid ${child.pid}，这次自检自己的）`);
      return child;
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill();
  const printed = output.join('');
  if (printed.includes('EADDRINUSE')) {
    console.error(`✗ ${PORT} 在我们起服务端之前被别的进程抢走了：\n${portHolder(PORT)}`);
    console.error('  换一个端口重跑（--port <别的>）——不复用别人的进程。');
    process.exit(2);
  }
  console.error(`固定服务端在 15s 内没有就绪。它自己打印的内容：\n${printed}`);
  process.exit(1);
}

const child = await startServer();
try {
  await checkWebsocket();
  await checkRunState();
  await checkWeakNetworkFaults();
  await checkScheduleDefault();
  await checkScheduleWrite();
  await checkClientRoundTrip();
  await checkScenarioIsolation();
  await checkScenarioVariants();
  await checkSessions();
  await checkPagingShapes();
  await checkFiles();
  await checkTimezone();
  await checkBots();
  await checkE2eHooks();
  await checkModels();
  await checkErrors();
  await checkChatErrorBlocks();
} finally {
  child.kill();
}

console.log(
  failures === 0
    ? '\n自检通过：固定服务端的协议与场景数据都对得上。'
    : `\n自检失败：${failures} 项不符。`,
);
process.exit(failures === 0 ? 0 : 1);
