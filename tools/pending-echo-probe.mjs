#!/usr/bin/env node
/**
 * 「发出去了但看不见」的**真服务端**帧级证据。
 *
 * ## 这一份要证的那句话
 *
 * > 用户发出去的那句话，从点发送到权威轮次落地之间，**必须一直在屏幕上，而且只出现一次**。
 *
 * 它跑的是 **App 自己的源码**（`src/api/client.ts` / `realtime.ts` /
 * `features/chat/reducer.ts`），不是脚本里另写的一套解析——所以结论对真机上那套代码成立。
 *
 * ## 为什么它值得单独存在
 *
 * 之前 `turnsForDisplay` 是"有权威用户轮次就整段丢掉本地乐观副本"的二选一，于是**只要
 * 会话里已经有一轮用户输入**（上一轮跑完的、或一个 steer 轮次），刚发出去、服务端还没
 * 回显的那句话就从屏幕上消失：输入框已清空、请求确实发出去了、屏幕上什么都没有
 * （`docs/research/e2e-suite.md` §4.3 的现场）。第二轮就是那个现场（第一轮跑完 → 会话里
 * 已经有权威用户轮次 → 再发一句）。
 *
 * 单测（`apps/mobile/tests/pending-send.test.mjs`）按帧序列把这条钉住；这一份在真服务端上
 * 再钉一次，因为**两件只有真服务端能回答的事**：
 *
 * 1. 回显的帧**形状**——是 `user_turn_upserts`、还是 `current_run_view.user_turns`、
 *    带不带 `invocation_id`。覆盖判断（`reducer.ts` 的 `coverOptimistic`）全靠它，
 *    而这一条在仓库文档里**没有**结论，必须实测；
 * 2. 真实的时间窗口：从发出去到权威内容落地之间，屏幕上不能出现"一句话都没有"的一帧。
 *
 * ## 怎么跑
 *
 * ```sh
 * node --experimental-strip-types tools/pending-echo-probe.mjs            # 走隧道
 * node --experimental-strip-types tools/pending-echo-probe.mjs --base-url http://127.0.0.1:18080
 * ```
 *
 * 它**只碰自己新建的会话**：跑完把那条会话删掉（`--keep-session` 留着排查）。
 * 凭据从 `~/.config/memoh-ios/dev.env` 读，不打印。
 *
 * 在 `vultr-sg` 上跑（容器里连宿主 127.0.0.1 的 dev 栈）时，先把凭据按 600 放进去，
 * 跑完删掉——**不进仓库、不打印**：
 *
 * ```sh
 * ssh vultr-sg 'mkdir -p /srv/memoh-ios-js/work/.config/memoh-ios &&
 *   install -m 600 /opt/memoh-dev/secrets/memoh-dev.env \
 *   /srv/memoh-ios-js/work/.config/memoh-ios/dev.env'
 * ssh vultr-sg "docker run --rm --network host -v /srv/memoh-ios-js/work:/work -w /work \
 *   -e HOME=/work node:22-bookworm-slim \
 *   node --experimental-strip-types tools/pending-echo-probe.mjs --base-url http://127.0.0.1:18080"
 * ssh vultr-sg 'rm -f /srv/memoh-ios-js/work/.config/memoh-ios/dev.env'
 * ```
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import WebSocket from 'ws';

import { MemohClient } from '../apps/mobile/src/api/client.ts';
import { MemohRealtime } from '../apps/mobile/src/api/realtime.ts';
import {
  appendOptimisticUserMessage,
  applyDelta,
  applyHistory,
  applySnapshot,
  hasContent,
  initialChatState,
  turnsForDisplay,
} from '../apps/mobile/src/features/chat/reducer.ts';
import { pendingSendView } from '../apps/mobile/src/features/chat/pending.ts';

const ENV_PATH = join(homedir(), '.config', 'memoh-ios', 'dev.env');

function loadEnv() {
  try {
    const env = {};
    for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match) env[match[1]] = match[2];
    }
    return env;
  } catch {
    return {};
  }
}

function parseArgs(argv) {
  const args = { baseUrl: null, keep: false, timeoutMs: 90_000 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base-url') args.baseUrl = argv[++i];
    else if (argv[i] === '--keep-session') args.keep = true;
    else if (argv[i] === '--timeout') args.timeoutMs = Number(argv[++i]) * 1000;
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

/** 屏幕上所有用户消息的正文（按 `turnsForDisplay` 的真实输出顺序）。 */
function visibleUserTexts(chat) {
  return turnsForDisplay(chat)
    .filter(hasContent)
    .map((turn) =>
      (turn.user?.blocks ?? [])
        .map((block) => (block.kind === 'text' ? block.text : ''))
        .join('')
        .trim(),
    )
    .filter((visible) => visible !== '');
}

const countOf = (texts, text) => texts.filter((visible) => visible === text).length;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const baseUrl = (args.baseUrl ?? env.MEMOH_DEV_BASE_URL ?? 'http://127.0.0.1:18080').replace(
    /\/+$/,
    '',
  );
  const password = env.MEMOH_ADMIN_PASSWORD;
  if (!password) {
    console.error(`需要 ${ENV_PATH} 里的 MEMOH_ADMIN_PASSWORD（见 docs/environment.md）`);
    process.exit(2);
  }

  console.log(`待发回显探针（跑 App 自己的源码） → ${baseUrl}\n`);

  let token = null;
  const client = new MemohClient({ baseUrl, getToken: () => token, onUnauthorized: () => {} });
  const login = await client.login('admin', password);
  token = login.access_token;
  const bots = await client.listBots();
  const bot = (bots.items ?? []).find((item) =>
    (item.current_user_permissions ?? []).includes('workspace_exec'),
  );
  if (bot === undefined) {
    console.error('没有带 workspace_exec 的 bot');
    process.exit(1);
  }
  const created = await client.createSession(bot.id, { title: 'pending-echo-probe' });
  const sessionId = created?.id;
  if (typeof sessionId !== 'string') {
    console.error('建会话失败');
    process.exit(1);
  }

  let chat = initialChatState;
  /** 只装"发出之后"的采样点（发送那一刻 + 每一帧之后）。 */
  let samples = [];
  /** 帧序（给人看的证据）。 */
  let wire = [];
  /** 服务端**在线上**有没有给出这一轮的用户输入（有就是"回显"）。 */
  let echoedOnWire = false;

  const sample = (label) => {
    const texts = visibleUserTexts(chat);
    const view = pendingSendView({
      unconfirmed: chat.pendingInvocationId !== null,
      queuedLocally: realtime.pendingCount > 0,
      connected: realtime.connectionState === 'open',
      failure: chat.sendFailure,
    });
    samples.push({
      label,
      texts,
      phase: view?.phase ?? null,
      action: view?.action?.id ?? null,
    });
    return texts;
  };

  const realtime = new MemohRealtime({
    baseUrl,
    botId: bot.id,
    getToken: () => token,
    createSocket: (url, authToken) =>
      new WebSocket(url, { headers: { Authorization: `Bearer ${authToken}` } }),
    listener: {
      onSnapshot: (frame) => {
        chat = applySnapshot(chat, frame.snapshot);
        const userTurns = frame.snapshot?.current_run_view?.user_turns ?? [];
        if (userTurns.length > 0) echoedOnWire = true;
        wire.push(`snapshot(seq=${frame.seq}, user_turns=${userTurns.length})`);
        sample(`snapshot seq=${frame.seq}`);
      },
      onDelta: (frame) => {
        chat = applyDelta(chat, frame.epoch, frame.seq, frame.delta);
        const view = frame.delta?.current_run_view;
        const userTurns = view?.user_turns ?? [];
        if (userTurns.length > 0) echoedOnWire = true;
        const kinds = Object.keys(frame.delta ?? {}).filter((key) => key !== 'run');
        const detail = [
          kinds.join('+'),
          view === undefined
            ? ''
            : `run.invocation=${String(view?.invocation_id ?? '∅').slice(0, 8)}… user_turns=${userTurns.length}`,
        ]
          .filter((part) => part !== '')
          .join(' ');
        wire.push(`delta(seq=${frame.seq}: ${detail})`);
        sample(`delta seq=${frame.seq} ${detail}`);
      },
      onRunAccepted: (frame) => {
        wire.push(`run_accepted(invocation=${String(frame?.invocation_id ?? '').slice(0, 8)}…)`);
      },
      onRunRejected: (frame) => {
        wire.push(`run_rejected(${String(frame?.code ?? '')})`);
      },
      onError: (error) => {
        wire.push(`error(${error.message})`);
      },
    },
  });

  realtime.connect();
  const connected = await waitFor(() => realtime.connectionState === 'open', 15_000);
  check(connected, '实时通道连上', realtime.connectionState);
  realtime.subscribe(sessionId);
  const gotSnapshot = await waitFor(() => chat.epoch !== null, 20_000);
  check(gotSnapshot, '收到 snapshot（reducer 有 epoch）');

  /**
   两轮：第一轮让会话里出现一条权威用户轮次；第二轮才是真正的现场
   （会话已经有一轮用户输入时，新发的那一句会不会被顶掉）。
   */
  const questions = [
    {
      label: '第一句（会话里还没有权威用户轮次）',
      text: 'pending-echo-probe one. Reply with: ok1',
    },
    {
      label: '第二句（会话里已有一轮权威用户轮次）',
      text: 'pending-echo-probe two. Reply with: ok2',
    },
  ];

  for (const question of questions) {
    console.log(`\n[${question.label}]`);
    samples = [];
    wire = [];
    echoedOnWire = false;

    const invocationId = realtime.sendMessage({ sessionId, text: question.text });
    chat = appendOptimisticUserMessage(chat, question.text, invocationId);
    // **发送那一刻**：服务端一个字节都还没回。这是用户看到的第一帧。
    const atSend = sample('sent（服务端还没回任何帧）');
    check(
      countOf(atSend, question.text) === 1,
      '发送那一刻：我发的这句话在屏幕上',
      JSON.stringify(atSend),
    );

    // 先等这一轮**真的起来**（否则"running 已经是 false"会立刻返回，采样窗口就空了——
    // 第一版探针就是这么骗过自己的），再等它跑完。
    const started = await waitFor(() => chat.running, 30_000);
    const finished = await waitFor(() => started && !chat.running, args.timeoutMs);
    const seen = samples.map((entry) => countOf(entry.texts, question.text));
    check(
      seen.every((count) => count === 1),
      '从发出去到跑完：**每一帧之后都恰好一条**（没有空屏，也没有两个气泡）',
      `采样 ${samples.length} 点；出现过的条数 = ${JSON.stringify([...new Set(seen)])}`,
    );

    // 权威历史（App 在 run 结束时就是这么拉的）。等落盘（轮次屏障）再拉，
    // 否则会拉到"还没有这一轮"的历史——那也是真实存在的一段窗口。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const history = await client.listMessages(bot.id, sessionId, { limit: 50 });
    const inHistory = (history.items ?? []).some(
      (turn) => turn.role === 'user' && (turn.text ?? '').trim() === question.text,
    );
    check(inHistory, '这一轮已经落盘（REST 历史里有这句话）', `${(history.items ?? []).length} 轮`);
    chat = applyHistory(chat, history.items ?? []);
    const afterHistory = visibleUserTexts(chat);
    check(
      countOf(afterHistory, question.text) === 1,
      '权威（REST）历史落地之后：仍然只有一条（本地那份让位）',
      JSON.stringify(afterHistory),
    );
    check(chat.pendingInvocationId === null, '待确认状态收掉了（pendingInvocationId → null）');
    check(finished, '这一轮跑完了（历史是权威的）');

    console.log(`  线上帧序：${wire.join(' → ') || '（没有任何帧）'}`);
    console.log(`  服务端在线上给出过用户轮次（回显）：${echoedOnWire ? '是' : '否'}`);
    for (const entry of samples) {
      console.log(
        `    · ${entry.label}\n        phase=${entry.phase ?? '—'} action=${entry.action ?? '—'} texts=${JSON.stringify(entry.texts)}`,
      );
    }
  }

  // ---------------------------------------------------------------- 收尾
  realtime.dispose();
  if (!args.keep) {
    await client.deleteSession(bot.id, sessionId);
    console.log('\n（探针建的会话已删掉）');
  } else {
    console.log(`\n（--keep-session：会话 ${sessionId} 留着）`);
  }

  console.log(`\n结论：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
