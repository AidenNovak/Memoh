#!/usr/bin/env node
/**
 * agent 提问（`ask_user`）的**真实服务端**端到端验收。
 *
 * ## 为什么必须有这一条
 *
 * 提问表单是"run 会不会继续"的开关：agent 调 `ask_user` 后 run 停在
 * `waiting_decision`，不回应就永远不继续。所以它不能只靠单测——单测证明不了
 * 服务端到底发不发 `user_input`、答案形状收不收、取消会不会被当成空提交。
 *
 * 这个脚本走**生产代码**（`MemohClient` / `MemohRealtime` / reducer 与
 * `features/chat/userInput.ts` 的答案构建），对着**真实部署的 dev 服务端**跑：
 *
 *   1. 起一个会话，让模型真的去调 `ask_user`（要挑会用工具的模型）；
 *   2. 断言 reducer 从真实帧里读出了提问（问题、选项、kind）；
 *   3. 用生产逻辑构建答案并回应，断言 run 继续（不再停在 waiting_decision）；
 *   4. 再要一次提问并**取消**，断言取消也被接受、run 同样继续。
 *
 * 第 4 步单列是因为"取消"很容易被实现成"发一个空答案"——服务端会把它当成一次
 * 无效提交，run 就继续挂着。取消必须显式带 `canceled`。
 *
 * 用法：node tools/ask-user-e2e.mjs [--model <id>] [--keep]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import process from 'node:process';
import WebSocket from 'ws';

import { MemohClient } from '../apps/mobile/src/api/client.ts';
import { MemohRealtime } from '../apps/mobile/src/api/realtime.ts';
import {
  applyDelta,
  applySnapshot,
  appendOptimisticUserMessage,
  initialChatState,
  isRunActive,
} from '../apps/mobile/src/features/chat/reducer.ts';
import { answerFor, buildAnswers } from '../apps/mobile/src/features/chat/userInput.ts';

const env = Object.fromEntries(
  readFileSync(`${homedir()}/.config/memoh-ios/dev.env`, 'utf8')
    .split('\n')
    .map((line) => line.trim().split('='))
    .filter((pair) => pair.length === 2 && pair[0]),
);

const baseUrl = (env.MEMOH_DEV_BASE_URL ?? 'http://127.0.0.1:18080').replace(/\/+$/, '');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const modelArgIndex = args.indexOf('--model');
const modelArg = modelArgIndex >= 0 ? args[modelArgIndex + 1] : undefined;

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

async function waitFor(predicate, timeoutMs, interval = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return predicate();
}

let token = null;
const client = new MemohClient({ baseUrl, getToken: () => token });
token = (await client.login('admin', env.MEMOH_ADMIN_PASSWORD)).access_token;

const bots = await client.listBots();
const bot = bots.items?.[0];
if (bot === undefined) {
  console.error('没有 bot；先在服务器上跑 ops/seed-dev-bot.sh');
  process.exit(1);
}

const modelsResponse = await client.listModels();
const models = Array.isArray(modelsResponse) ? modelsResponse : (modelsResponse.items ?? []);
const model =
  models.find((entry) => entry.id === modelArg) ??
  models.find((entry) => /kimi|k3/i.test(String(entry.name))) ??
  models[0];

console.log(`ask_user 端到端 → ${baseUrl}`);
console.log(`bot=${bot.id} model=${model?.name} (${model?.id})\n`);

const created = await client.createSession(bot.id, { title: 'ask_user e2e' });
const sessionId = created?.id ?? created?.session_id;
if (typeof sessionId !== 'string') {
  console.error('建会话失败：', JSON.stringify(created).slice(0, 200));
  process.exit(1);
}
console.log(`会话 ${sessionId}\n`);

let chat = initialChatState;
const seen = { statuses: [], acks: [], snapshots: 0, deltas: 0 };

const realtime = new MemohRealtime({
  baseUrl,
  botId: bot.id,
  getToken: () => token,
  createSocket: (url, authToken) =>
    new WebSocket(url, { headers: { Authorization: `Bearer ${authToken}` } }),
  listener: {
    onSnapshot: (frame) => {
      if (frame.sessionId !== sessionId) return;
      chat = applySnapshot(chat, frame.snapshot);
      seen.snapshots += 1;
    },
    onDelta: (frame) => {
      if (frame.sessionId !== sessionId) return;
      chat = applyDelta(chat, frame.epoch, frame.seq, frame.delta);
      seen.deltas += 1;
      if (chat.runStatus !== null) seen.statuses.push(chat.runStatus);
    },
    onControlAck: (frame) => seen.acks.push(frame),
  },
});

try {
  realtime.connect();
  await waitFor(() => realtime.connectionState === 'open', 20_000);
  realtime.subscribe(sessionId);
  await waitFor(() => chat.epoch !== null, 25_000);

  // ---------------------------------------------------------------- 第一次：提问 → 回答
  const askText =
    '请用 ask_user 工具问我一个问题，把"发布渠道"做成多选（App Store / TestFlight / 企业分发），必答，并允许自定义答案。';
  const invocationId = realtime.sendMessage({ sessionId, text: askText, modelId: model?.id });
  chat = appendOptimisticUserMessage(chat, askText, invocationId);

  const gotQuestion = await waitFor(() => chat.userInput !== null, 150_000);
  check(gotQuestion, '从真实帧里读出了 agent 的提问');

  if (!gotQuestion) {
    console.error('  没等到提问。可能这个模型没调 ask_user，或该部署版本不暴露这个工具。');
    console.error(`  run 状态历史：${[...new Set(seen.statuses)].join(' → ') || '(无)'}`);
    console.error(`  收到的帧：snapshot=${seen.snapshots} delta=${seen.deltas}`);
    throw new Error('no question');
  }

  const pending = chat.userInput;
  const question = pending.questions[0];
  console.log(`    问题：${question?.text}`);
  console.log(`    类型：${question?.kind}，选项 ${question?.options.length ?? 0} 个`);
  console.log(`    allowCustom=${question?.allowCustom} required=${question?.required}`);

  check(pending.userInputId !== '', '提问带 user_input_id');
  check((question?.options.length ?? 0) > 0, '提问带 agent 定义的选项');
  check(
    (pending.questions.length === 1 && question?.allowCustom === true) ||
      pending.questions.length > 1,
    'allow_custom 被正确读出（缺省必须视为不允许）',
    `allowCustom=${question?.allowCustom}`,
  );

  // 用生产逻辑构建答案：选第一个选项（多选则再叠一个自定义文本）。
  const draft = {
    optionIds: (question?.options ?? [])
      .slice(0, question?.kind === 'multi_select' ? 2 : 1)
      .map((option) => option.id),
    customSelected: false,
    customText: '',
    text: '',
  };
  const single = pending.questions.length === 1;
  const answer = answerFor(question, draft, single);
  check(answer !== null, '生产逻辑为这个问题构建出了答案', JSON.stringify(answer)?.slice(0, 120));
  const answers = buildAnswers([question], { [question.questionId]: draft });
  check(answers !== null, '整份表单答案完整（否则提交按钮会禁用）');
  console.log(`    提交答案：${JSON.stringify(answers)}`);

  const beforeSubmitStatus = chat.runStatus;
  realtime.respondToUserInput({
    sessionId,
    runId: chat.runId ?? '',
    decisionId: pending.userInputId,
    answers,
  });

  const leftWaiting = await waitFor(
    () => chat.userInput === null || chat.runStatus !== beforeSubmitStatus,
    120_000,
  );
  check(
    leftWaiting,
    '提交答案后 run 不再停在等待上（提问消失或状态推进）',
    `status ${beforeSubmitStatus} → ${chat.runStatus}`,
  );

  const completed = await waitFor(() => !isRunActive(chat.runStatus), 180_000);
  check(completed, 'run 走到终态（没有卡在 waiting_decision）', String(chat.runStatus));

  // ---------------------------------------------------------------- 第二次：提问 → 取消
  const cancelText = '再用 ask_user 问我一个单问题（比如"要不要继续"），必答。';
  const cancelInvocation = realtime.sendMessage({
    sessionId,
    text: cancelText,
    modelId: model?.id,
  });
  chat = appendOptimisticUserMessage(chat, cancelText, cancelInvocation);

  const gotSecond = await waitFor(() => chat.userInput !== null, 150_000);
  check(gotSecond, '第二次提问到达（同一会话可以反复提问）');

  if (gotSecond) {
    const second = chat.userInput;
    const statusBeforeCancel = chat.runStatus;
    // 取消必须显式带 canceled：发空答案会被服务端当成一次无效提交，run 继续挂着。
    realtime.respondToUserInput({
      sessionId,
      runId: chat.runId ?? '',
      decisionId: second.userInputId,
      canceled: true,
      reason: 'user_canceled',
    });
    const cancelled = await waitFor(
      () => chat.userInput === null || chat.runStatus !== statusBeforeCancel,
      120_000,
    );
    check(
      cancelled,
      '取消被接受（提问消失或状态推进）',
      `status ${statusBeforeCancel} → ${chat.runStatus}`,
    );
    const afterCancel = await waitFor(() => !isRunActive(chat.runStatus), 180_000);
    check(afterCancel, '取消后 run 也走到终态', String(chat.runStatus));
  }

  console.log(
    `\n  帧统计：snapshot=${seen.snapshots} delta=${seen.deltas} acks=${seen.acks.length}`,
  );
  console.log(`  状态轨迹：${[...new Set(seen.statuses)].join(' → ') || '(无)'}`);
} catch (error) {
  if (!(error instanceof Error && error.message === 'no question')) {
    console.error('\n✖ 未捕获：', error instanceof Error ? error.stack : String(error));
  }
} finally {
  realtime.dispose();
  if (!keep) {
    try {
      await client.request('DELETE', `/bots/${bot.id}/sessions/${sessionId}`);
      console.log('  已删除临时会话');
    } catch (error) {
      console.error(
        '  删除会话失败（不影响结论）：',
        error instanceof Error ? error.message : error,
      );
    }
  }
}

console.log(`\n通过 ${passed}，失败 ${failed}。`);
if (failed > 0) console.log('失败的那几条才是信息。');
process.exit(failed === 0 ? 0 : 1);
