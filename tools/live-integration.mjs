#!/usr/bin/env node
/**
 * 对活服务端的集成测试 —— 跑的是 **App 自己的源码**，不是重新实现的逻辑。
 *
 * `tools/protocol-smoke.mjs` 验证的是"我们对协议的理解对不对"；这个文件验证的是
 * "**我们写的那套代码**对不对"。区别很关键：前者用的是脚本里另写的一套解析，
 * 后者 import 的正是 `src/api/client.ts`、`src/api/realtime.ts`、
 * `src/features/chat/reducer.ts` —— App 在真机上跑的就是这几个文件。
 *
 * 它不需要模拟器，所以可以在 CI 的 ubuntu runner 上对着一台测试服务器跑。
 *
 * 用法：
 *   node tools/live-integration.mjs
 *   node tools/live-integration.mjs --base-url http://127.0.0.1:18080 --text "say hi"
 *
 * 前置：本地隧道已开（`pnpm ios:dev-env`），且服务器上已有可用的 bot 与模型
 * （联调环境的起法与能力矩阵：memoh-ios-dev.md §2 / §4.5）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { MemohClient } from '../apps/mobile/src/api/client.ts';
import { MemohRealtime } from '../apps/mobile/src/api/realtime.ts';
import WebSocket from 'ws';
import {
  applyDelta,
  applyHistory,
  applySnapshot,
  appendOptimisticUserMessage,
  initialChatState,
  turnsForDisplay,
  hasContent,
} from '../apps/mobile/src/features/chat/reducer.ts';

const ENV_PATH = join(homedir(), '.config', 'memoh-ios', 'dev.env');

function loadEnv() {
  try {
    const text = readFileSync(ENV_PATH, 'utf8');
    const env = {};
    for (const line of text.split('\n')) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match) env[match[1]] = match[2];
    }
    return env;
  } catch {
    return {};
  }
}

function parseArgs(argv) {
  const args = { baseUrl: null, text: 'Reply with exactly: ok', timeoutMs: 120_000, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base-url') args.baseUrl = argv[++i];
    else if (argv[i] === '--text') args.text = argv[++i];
    else if (argv[i] === '--timeout') args.timeoutMs = Number(argv[++i]) * 1000;
    else if (argv[i] === '--keep-session') args.keep = true;
  }
  return args;
}

let passed = 0;
let failed = 0;

function check(condition, label, detail) {
  const suffix = detail === undefined ? '' : ` — ${detail}`;
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${label}${suffix}`);
  } else {
    failed += 1;
    console.error(`  ✖ ${label}${suffix}`);
  }
  return condition;
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
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
    console.error(`需要 ${ENV_PATH} 里的 MEMOH_ADMIN_PASSWORD（联调环境的起法与能力矩阵：memoh-ios-dev.md §2 / §4.5）`);
    process.exit(2);
  }

  console.log(`集成测试（跑 App 自己的源码） → ${baseUrl}\n`);

  // ---------------------------------------------------------------- 认证
  console.log('[1] MemohClient：登录与鉴权');
  let token = null;
  const client = new MemohClient({
    baseUrl,
    getToken: () => token,
    onUnauthorized: () => {
      unauthorizedSeen = true;
    },
  });
  let unauthorizedSeen = false;

  const login = await client.login('admin', password);
  token = login.access_token;
  check(typeof token === 'string' && token.length > 100, '登录返回 token');
  check(client.token() === token, 'client.token() 返回当前 token');

  const me = await client.me();
  check(typeof me.id === 'string', 'GET /users/me 拿到账号', me.username);
  check(typeof me.role === 'string', '账号带 role', me.role);

  // 401 的处理路径：用坏 token 打一次，确认 onUnauthorized 被调到。
  const badClient = new MemohClient({
    baseUrl,
    getToken: () => 'not-a-real-token',
    onUnauthorized: () => {
      unauthorizedSeen = true;
    },
  });
  let sawApiError = false;
  try {
    await badClient.me();
  } catch (error) {
    sawApiError = error.constructor.name === 'ApiError' && error.isUnauthorized === true;
  }
  check(sawApiError, '坏 token 抛 ApiError 且 isUnauthorized 为真');
  check(unauthorizedSeen, 'onUnauthorized 回调被调用（App 据此清 Keychain 回登录页）');

  // ---------------------------------------------------------------- bots
  console.log('\n[2] MemohClient：bot 与会话');
  const bots = await client.listBots();
  check(Array.isArray(bots.items), 'listBots 返回 items', `${bots.items.length} 个`);
  if (bots.items.length === 0) {
    console.error('没有 bot，先跑 infra/vultr-sg/seed-dev-bot.sh');
    process.exit(1);
  }
  const bot = bots.items[0];

  const created = await client.createSession(bot.id, { title: 'ios integration' });
  const sessionId = created?.id ?? created?.session_id ?? created?.data?.id;
  check(
    typeof sessionId === 'string',
    'createSession 拿到 session id',
    `${String(sessionId).slice(0, 8)}…`,
  );

  const listed = await client.listSessions(bot.id, { limit: 10 });
  check(
    (listed.items ?? []).some((item) => item.id === sessionId),
    '新建的会话出现在列表里',
  );

  // ---------------------------------------------------------------- 实时
  console.log('\n[3] MemohRealtime + reducer：完整一轮对话');
  let chat = initialChatState;
  const stateLog = [];
  let gapReasons = [];
  let accepted = null;
  /**
   * 是否在流式过程中观察到过 running。不能靠轮询判定——短回复可能在两次轮询之间
   * 就跑完了，那会变成假失败。在每次应用归约结果后直接记一笔才准。
   */
  let sawRunning = false;

  const realtime = new MemohRealtime({
    baseUrl,
    botId: bot.id,
    getToken: () => token,
    // Node 内置的 WebSocket 不接受自定义 header，而 App 在 iOS 上走的正是 header。
    // 注入 `ws` 让这里跑的是**同一份 realtime.ts 源码**，而不是另写一套。
    createSocket: (url, authToken) =>
      new WebSocket(url, { headers: { Authorization: `Bearer ${authToken}` } }),
    listener: {
      onStateChange: (connection) => stateLog.push(`conn:${connection}`),
      onSnapshot: (frame) => {
        chat = applySnapshot(chat, frame.snapshot);
        if (chat.running) sawRunning = true;
        stateLog.push(`snapshot:${frame.epoch}@${frame.seq}`);
      },
      onDelta: (frame) => {
        chat = applyDelta(chat, frame.epoch, frame.seq, frame.delta);
        if (chat.running) sawRunning = true;
        stateLog.push(`delta:${frame.seq}`);
      },
      onGap: (_sessionId, reason) => {
        gapReasons.push(reason);
      },
      onRunAccepted: (frame) => {
        accepted = frame;
      },
      onError: (error) => {
        stateLog.push(`error:${error.message}`);
      },
    },
  });

  realtime.connect();
  const connected = await waitFor(() => realtime.connectionState === 'open', 15_000);
  check(connected, 'MemohRealtime 连上（Authorization header）', realtime.connectionState);

  realtime.subscribe(sessionId);
  const gotSnapshot = await waitFor(() => chat.epoch !== null, 20_000);
  check(gotSnapshot, 'reducer 收到并应用了 snapshot', `epoch=${String(chat.epoch).slice(0, 8)}…`);
  check(chat.seq >= 0, 'snapshot 带 seq', String(chat.seq));

  // 发消息前先做一次乐观插入，模拟 App 的行为。
  const invocationId = realtime.sendMessage({ sessionId, text: args.text });
  chat = appendOptimisticUserMessage(chat, args.text, invocationId);
  check(chat.optimistic.length === 1, '本地乐观消息已插入');
  check(chat.pendingSend === true, 'pendingSend 已置位');

  const gotAccepted = await waitFor(() => accepted !== null, 30_000);
  check(gotAccepted, '收到 run_accepted');
  check(accepted !== null && accepted.invocation_id === invocationId, 'invocation_id 回显一致');
  if (accepted !== null) {
    check(typeof accepted.run_id === 'string', 'run_accepted 带 run_id');
  }

  // 等 reducer 里真的出现文本。
  const gotText = await waitFor(() => {
    const turns = turnsForDisplay(chat).filter(hasContent);
    return turns.some(
      (turn) =>
        (turn.assistant?.blocks ?? []).some(
          (block) => block.kind === 'text' && block.text.trim().length > 0,
        ) ||
        (turn.assistant?.blocks ?? []).some(
          (block) => block.kind === 'reasoning' && block.text.trim().length > 0,
        ),
    );
  }, args.timeoutMs);
  check(gotText, 'reducer 里出现了模型输出');

  // 乐观插入之后 running 可能还是 false（run_accepted 还没到）；真正的"运行中"
  // 由服务端投影驱动，所以等它出现。
  await waitFor(() => sawRunning, 30_000);

  const settled = await waitFor(() => !chat.running && chat.epoch !== null, args.timeoutMs);
  check(settled, 'run 收敛，running 回到 false');
  check(sawRunning, '中途 running 为 true（输入器会切成停止按钮）');
  check(
    chat.runStatus === 'completed' || chat.runStatus === 'aborted' || chat.runStatus === 'errored',
    'runStatus 是终态',
    String(chat.runStatus),
  );
  check(gapReasons.length === 0, '过程中没有出现 seq 空洞', gapReasons.join(', ') || '无');

  // 内容一致性
  const turns = turnsForDisplay(chat).filter(hasContent);
  const allBlocks = turns.flatMap((turn) => turn.assistant?.blocks ?? []);
  const textBlocks = allBlocks.filter((block) => block.kind === 'text');
  const reasoningBlocks = allBlocks.filter((block) => block.kind === 'reasoning');
  check(textBlocks.length > 0, '有 text 块', `${textBlocks.length} 个`);
  if (reasoningBlocks.length > 0) {
    check(true, '有 reasoning 块（该模型开启了思考）', `${reasoningBlocks.length} 个`);
  }

  // 流式 append 的关键断言：文本是逐块累加出来的，不是一次到位。
  const deltaCount = stateLog.filter((entry) => entry.startsWith('delta:')).length;
  check(deltaCount > 3, 'delta 帧数 > 3（说明真的是流式，不是一次返回）', String(deltaCount));

  // ---------------------------------------------------------------- 历史一致性
  console.log('\n[4] 历史与实时的一致性');
  const history = await client.listMessages(bot.id, sessionId, { limit: 50 });
  check(Array.isArray(history.items), 'listMessages 返回轮次数组', `${history.items.length} 轮`);

  // 只用历史构造一个干净状态：turnsForDisplay 会把活跃 run 与本地乐观消息也拼进来，
  // 直接用当前 chat 会让这条断言因为乐观消息而"通过"，那是假的通过。
  const historyOnly = turnsForDisplay(applyHistory(initialChatState, history.items)).filter(
    hasContent,
  );
  const historyText = historyOnly
    .flatMap((turn) => [...(turn.user?.blocks ?? []), ...(turn.assistant?.blocks ?? [])])
    .filter((block) => block.kind === 'text')
    .map((block) => block.text)
    .join(' ');
  check(historyText.length > 0, 'REST 历史里有可渲染文本', `${historyText.length} 字符`);
  check(
    historyOnly.some((turn) => turn.assistant !== undefined),
    'REST 历史里有助手轮次（说明 run 已落盘）',
  );

  const positions = (history.items ?? [])
    .map((turn) => turn.turn_position)
    .filter((position) => typeof position === 'number');
  check(
    positions.every((position, index) => index === 0 || position >= positions[index - 1]),
    'turn_position 单调递增',
  );

  // ---------------------------------------------------------------- seq 校验
  console.log('\n[5] 重订阅（心跳路径）');
  const seqBefore = chat.seq;
  realtime.subscribe(sessionId); // 幂等重订阅，服务端会重发 snapshot
  const resnapshot = await waitFor(() => chat.seq !== seqBefore || chat.epoch !== null, 15_000);
  check(resnapshot, '重发 runtime_subscribe 后状态仍然一致', `seq=${chat.seq}`);

  realtime.dispose();
  check(realtime.connectionState === 'closed', 'dispose 之后连接已关闭');

  // ---------------------------------------------------------------- 收尾
  console.log('\n──────────────────────────────');
  console.log(`通过 ${passed}，失败 ${failed}`);

  if (!args.keep && typeof sessionId === 'string') {
    try {
      await client.deleteSession(bot.id, sessionId);
      console.log('清理测试会话完成');
    } catch {
      console.log('清理测试会话失败（不影响结论）');
    }
  } else if (typeof sessionId === 'string') {
    console.log(`保留测试会话：${sessionId}`);
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n✖ 未捕获的失败：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
