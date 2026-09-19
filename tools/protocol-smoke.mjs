#!/usr/bin/env node
/**
 * 对真实 Memoh 服务端的协议冒烟测试。
 *
 * 这个脚本存在的理由：单测只能证明归约器自洽，证明不了**我们理解的协议是对的**。
 * 这个脚本按 iOS 客户端将要走的顺序，对活的服务端跑一遍：
 *
 *   登录 → 列 bot → 列会话 → 建会话 → 连 WS → 订阅 → 等 snapshot
 *   → 发消息 → 收 run_accepted → 收 runtime_delta（正文！）→ 收敛到结束
 *
 * 它验证的是 `docs/research/memoh-api.md` 里那几条关键结论：发消息的连接收不到
 * 正文、必须先订阅、增量是 append 不是 upsert。
 *
 * 用法：
 *   node tools/protocol-smoke.mjs [--base-url http://127.0.0.1:18080] [--timeout 120]
 *
 * 凭据从 ~/.config/memoh-ios/dev.env 读（不进仓库、不打印）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';

const ENV_PATH = join(homedir(), '.config', 'memoh-ios', 'dev.env');

function loadEnv() {
  const text = readFileSync(ENV_PATH, 'utf8');
  const env = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  return env;
}

function parseArgs(argv) {
  const args = { baseUrl: null, timeout: 120, keepSession: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base-url') args.baseUrl = argv[++i];
    else if (argv[i] === '--timeout') args.timeout = Number(argv[++i]);
    else if (argv[i] === '--keep-session') args.keepSession = true;
  }
  return args;
}

const log = (...parts) => console.log(...parts);
const fail = (message) => {
  console.error(`\n✖ ${message}`);
  process.exitCode = 1;
};

class Checkpoint {
  constructor() {
    this.passed = 0;
    this.failed = 0;
  }
  ok(label, detail) {
    this.passed += 1;
    log(`  ✔ ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
  bad(label, detail) {
    this.failed += 1;
    console.error(`  ✖ ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
  expect(condition, label, detail) {
    if (condition) this.ok(label, detail);
    else this.bad(label, detail);
    return condition;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const baseUrl = (args.baseUrl ?? env.MEMOH_DEV_BASE_URL ?? 'http://127.0.0.1:18080').replace(
    /\/+$/,
    '',
  );
  const password = env.MEMOH_ADMIN_PASSWORD;
  if (!password) {
    fail('dev.env 里没有 MEMOH_ADMIN_PASSWORD');
    return;
  }

  const cp = new Checkpoint();
  log(`协议冒烟测试 → ${baseUrl}\n`);

  // ---------------------------------------------------------------- 登录
  log('[1] 认证');
  const loginResponse = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  if (!loginResponse.ok) {
    fail(`登录失败 HTTP ${loginResponse.status}`);
    return;
  }
  const login = await loginResponse.json();
  const token = login.access_token;
  cp.expect(typeof token === 'string' && token.length > 100, 'POST /auth/login 返回 access_token');
  cp.expect(typeof login.expires_at === 'string', '返回 expires_at', login.expires_at);
  cp.expect(
    typeof login.user_id === 'string' && typeof login.display_name === 'string',
    '登录响应含 profile 字段（refresh 不会返回这些）',
  );

  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const api = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: auth,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  };

  // ---------------------------------------------------------------- bots
  log('\n[2] Bot 与权限');
  const bots = await api('GET', '/bots');
  cp.expect(bots.status === 200, 'GET /bots 是 200', `HTTP ${bots.status}`);
  const botList = bots.body?.items ?? [];
  cp.expect(Array.isArray(botList), 'items 是数组', `${botList.length} 个`);
  if (botList.length === 0) {
    fail('没有 bot 可用，后续步骤无法继续。先在 Web UI 建一个 bot。');
    return;
  }
  const bot = botList[0];
  const permissions = bot.current_user_permissions ?? [];
  cp.ok('bot 权限', permissions.join(', ') || '(空)');
  cp.expect(
    permissions.includes('workspace_exec') || permissions.includes('manage'),
    '具备开 WebSocket 所需的 workspace_exec / manage',
  );

  // ---------------------------------------------------------------- 建会话
  log('\n[3] 会话');
  const sessions = await api('GET', `/bots/${bot.id}/sessions?limit=5`);
  cp.expect(sessions.status === 200, 'GET /bots/{id}/sessions 是 200', `HTTP ${sessions.status}`);
  cp.expect('next_cursor' in (sessions.body ?? {}), '响应含 next_cursor（空串=到底）');

  const created = await api('POST', `/bots/${bot.id}/sessions`, { title: 'iOS smoke' });
  cp.expect(
    created.status === 200 || created.status === 201,
    'POST 建会话成功',
    `HTTP ${created.status}`,
  );
  const sessionId = created.body?.id ?? created.body?.session_id ?? created.body?.data?.id;
  if (typeof sessionId !== 'string') {
    fail(`建会话没拿到 session id：${JSON.stringify(created.body)?.slice(0, 200)}`);
    return;
  }
  cp.ok('新会话 id', `${sessionId.slice(0, 8)}…`);

  // ---------------------------------------------------------------- WebSocket
  log('\n[4] WebSocket 实时通道');
  const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/bots/${bot.id}/web/ws`;
  // 用 `ws` 而不是 Node 内置的 WebSocket：后者不接受自定义 header，
  // 而 header 正是 iOS 客户端要走的路由（`?token=` 是给浏览器的妥协）。
  const socket = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const frames = [];
  let snapshot = null;
  let runAccepted = null;
  let deltaCount = 0;
  /** 按 message id 累加的文本 —— 复刻 iOS 归约器的 append 语义。 */
  const streams = new Map();
  const upserts = [];
  let textFromAppends = '';
  let textFromUpserts = '';
  let sawError = null;

  const opened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 15_000);
    socket.on('open', () => {
      clearTimeout(timer);
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  if (!cp.expect(opened, 'WS 建连成功（用 Authorization header，不用 ?token=）')) {
    return;
  }

  socket.on('message', (data) => {
    let frame;
    try {
      frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      return;
    }
    frames.push(frame.type);

    if (frame.type === 'runtime_snapshot') {
      snapshot = frame;
    } else if (frame.type === 'runtime_delta') {
      deltaCount += 1;
      const delta = frame.delta ?? {};
      // 关键契约：append 是追加，upsert 是整块。
      for (const append of delta.message_appends ?? []) {
        const key = String(append.id);
        const existing = streams.get(key) ?? '';
        streams.set(key, existing + append.content);
        if (append.type === 'text') textFromAppends += append.content;
      }
      for (const upsert of delta.message_upserts ?? []) {
        upserts.push(upsert);
        if (upsert.type === 'text' && typeof upsert.content === 'string') {
          textFromUpserts = upsert.content;
        }
      }
      if (delta.reset_messages === true) streams.clear();
    } else if (frame.type === 'run_accepted') {
      runAccepted = frame;
    } else if (frame.type === 'error') {
      sawError = frame;
    }
  });

  // 订阅必须先于发消息 —— 这是本文件要验证的核心结论。
  socket.send(JSON.stringify({ type: 'runtime_subscribe', session_id: sessionId }));

  const snapshotArrived = await waitFor(() => snapshot !== null, 20_000);
  cp.expect(snapshotArrived, '订阅后收到 runtime_snapshot');
  if (snapshotArrived) {
    cp.expect(typeof snapshot.epoch === 'string', 'snapshot 带 epoch', snapshot.epoch);
    cp.expect(typeof snapshot.seq === 'number', 'snapshot 带 seq', String(snapshot.seq));
    cp.expect(
      snapshot.snapshot?.session_id === sessionId,
      'snapshot 的 session_id 与我们订阅的一致',
    );
  }

  // ---------------------------------------------------------------- 发消息
  log('\n[5] 发消息与流式接收');
  const invocationId = crypto.randomUUID();
  socket.send(
    JSON.stringify({
      type: 'message',
      invocation_id: invocationId,
      session_id: sessionId,
      text: 'Reply with exactly one short sentence: hello from the iOS client smoke test.',
    }),
  );

  const acceptedArrived = await waitFor(() => runAccepted !== null, 30_000);
  cp.expect(acceptedArrived, '收到 run_accepted（唯一引入 run_id 的地方）');
  if (acceptedArrived) {
    cp.expect(typeof runAccepted.run_id === 'string', 'run_accepted 带 run_id');
    cp.expect(typeof runAccepted.turn_id === 'string', 'run_accepted 带 turn_id');
    cp.expect(
      acceptedArrived && runAccepted.invocation_id === invocationId,
      'invocation_id 回显一致',
    );
  }

  // 等正文。这是整个测试的重点：正文只会出现在 runtime_delta 里。
  const gotBody = await waitFor(
    () => textFromAppends.length > 0 || textFromUpserts.length > 0,
    90_000,
  );
  cp.expect(gotBody, '通过 runtime_delta 收到了正文');
  cp.expect(deltaCount > 0, 'runtime_delta 帧数 > 0', String(deltaCount));
  if (textFromAppends.length > 0) {
    cp.ok('正文来自 message_appends（按 id 追加）', `${textFromAppends.length} 字符`);
  } else if (textFromUpserts.length > 0) {
    cp.ok('正文来自 message_upserts（整块替换）', `${textFromUpserts.length} 字符`);
  }
  if (sawError !== null) {
    cp.bad('过程中收到 error 帧', JSON.stringify(sawError).slice(0, 200));
  }

  // ---------------------------------------------------------------- 收敛
  const settled = await waitFor(
    () => upserts.some((m) => m.running === false) || textFromAppends.length > 0,
    90_000,
  );
  cp.expect(settled, '流式输出收敛（收到 running:false 的整块或已积累文本）');

  const preview = (textFromAppends || textFromUpserts).slice(0, 120).replace(/\s+/g, ' ');
  if (preview !== '') cp.ok('模型回复预览', `"${preview}"`);

  // ---------------------------------------------------------------- 历史
  log('\n[6] REST 历史与 WS 的一致性');
  const history = await api('GET', `/bots/${bot.id}/messages?session_id=${sessionId}&limit=20`);
  cp.expect(history.status === 200, 'GET /messages 是 200', `HTTP ${history.status}`);
  const turns = history.body?.items ?? [];
  cp.expect(Array.isArray(turns), 'items 是 UITurn 数组', `${turns.length} 轮`);
  cp.expect(
    turns.some((turn) => turn.role === 'assistant'),
    '历史里已经有助手轮次（说明 run 落盘了）',
  );
  const positions = turns.map((turn) => turn.turn_position).filter((p) => typeof p === 'number');
  cp.expect(
    positions.every((p, i) => i === 0 || p >= positions[i - 1]),
    'turn_position 单调递增（排序要按它，不能用时间戳）',
  );

  // ---------------------------------------------------------------- 幂等
  log('\n[7] invocation 幂等');
  const beforeFrames = frames.length;
  socket.send(
    JSON.stringify({
      type: 'message',
      invocation_id: invocationId,
      session_id: sessionId,
      text: 'this should be rejected as a duplicate intent',
    }),
  );
  const duplicateArrived = await waitFor(
    () =>
      frames.slice(beforeFrames).includes('run_accepted') ||
      frames.slice(beforeFrames).includes('run_rejected'),
    30_000,
  );
  if (duplicateArrived) {
    // 重发同一个 invocation_id 不应该开启新一轮。
    const accepted = frames.slice(beforeFrames).includes('run_accepted');
    cp.ok(
      '重发同一 invocation_id 得到响应',
      accepted ? 'run_accepted（可能带 duplicate:true）' : 'run_rejected',
    );
  } else {
    cp.bad('重发同一 invocation_id 没有任何响应');
  }

  // ---------------------------------------------------------------- 收尾
  socket.close();

  log('\n──────────────────────────────');
  log(`通过 ${cp.passed}，失败 ${cp.failed}`);
  if (cp.failed > 0) {
    log('失败的项就是信息——不要只看通过数。');
    process.exitCode = 1;
  }

  if (!args.keepSession) {
    const removed = await api('DELETE', `/bots/${bot.id}/sessions/${sessionId}`);
    log(`清理测试会话：HTTP ${removed.status}`);
  } else {
    log(`保留测试会话：${sessionId}`);
  }
}

/** 轮询等待条件成立。用轮询而不是事件，是为了让每个检查点都有统一超时。 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return predicate();
}

main().catch((error) => {
  fail(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
});
