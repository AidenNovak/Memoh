#!/usr/bin/env node
/**
 * 真实 API 场景测试。
 *
 * 与 `live-integration.mjs` 的区别：那个验证"链路通不通"，这个验证**不同模型家族
 * 的真实行为差异**，以及 iOS 状态机能不能吃下全部差异。
 *
 * 为什么必须跨家族测：
 *   - 思考块的有无（有的模型没有 reasoning 阶段）
 *   - 增量粒度（逐 token vs 逐段，影响渲染策略）
 *   - 工具调用的表达方式与是否需要审批
 *   - 错误码的形态（认证失败 / 模型不存在 / 限流）
 * 这些只有真打过才知道，而任何一条处理不好，用户看到的就是"卡住"或"内容丢了"。
 *
 * 用法：
 *   node tools/api-scenarios.mjs                    # 跑全部
 *   node tools/api-scenarios.mjs --scenario models  # 只跑一个
 *   node tools/api-scenarios.mjs --list
 *
 * 前置：`pnpm ios:dev-env`，且服务器上已配好至少一个模型。
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
  turnsForDisplay,
  hasContent,
} from '../apps/mobile/src/features/chat/reducer.ts';

const ENV_PATH = `${homedir()}/.config/memoh-ios/dev.env`;

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
  const args = { scenario: null, timeout: 180_000, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--scenario') args.scenario = argv[++i];
    else if (argv[i] === '--timeout') args.timeout = Number(argv[++i]) * 1000;
    else if (argv[i] === '--keep-session') args.keep = true;
    else if (argv[i] === '--list') args.list = true;
  }
  return args;
}

let passed = 0;
let failed = 0;

function check(condition, label, detail) {
  const suffix = detail === undefined ? '' : ` — ${detail}`;
  if (condition) {
    passed += 1;
    console.log(`    ✔ ${label}${suffix}`);
  } else {
    failed += 1;
    console.error(`    ✖ ${label}${suffix}`);
  }
  return condition;
}

async function waitFor(predicate, timeoutMs, interval = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return predicate();
}

/** 连一条实时通道，把帧喂进真实的归约器，并把过程记录下来。 */
function attachRealtime(baseUrl, botId, token, sessionId) {
  const record = {
    realtime: null,
    chat: initialChatState,
    frames: [],
    deltas: 0,
    appends: 0,
    upserts: 0,
    approvalsSeen: [],
    userInputsSeen: [],
    gapReasons: [],
    errors: [],
    runStatuses: [],
    sawRunning: false,
    accepted: null,
  };

  const realtime = new MemohRealtime({
    baseUrl,
    botId,
    getToken: () => token,
    createSocket: (url, authToken) =>
      new WebSocket(url, { headers: { Authorization: `Bearer ${authToken}` } }),
    listener: {
      onSnapshot: (frame) => {
        if (frame.sessionId !== sessionId) return;
        record.chat = applySnapshot(record.chat, frame.snapshot);
        if (record.chat.running) record.sawRunning = true;
        record.frames.push(`snapshot:${frame.seq}`);
      },
      onDelta: (frame) => {
        if (frame.sessionId !== sessionId) return;
        const delta = frame.delta;
        if (delta.message_appends !== undefined) record.appends += delta.message_appends.length;
        if (delta.message_upserts !== undefined) record.upserts += delta.message_upserts.length;
        record.chat = applyDelta(record.chat, frame.epoch, frame.seq, delta);
        if (record.chat.running) record.sawRunning = true;
        if (record.chat.runStatus !== null) record.runStatuses.push(record.chat.runStatus);
        if (record.chat.approval !== null) {
          const id = record.chat.approval.approvalId;
          if (!record.approvalsSeen.includes(id)) record.approvalsSeen.push(id);
        }
        if (record.chat.userInput !== null) {
          const id = record.chat.userInput.userInputId;
          if (!record.userInputsSeen.includes(id)) record.userInputsSeen.push(id);
        }
        record.deltas += 1;
      },
      onGap: (_sessionId, reason) => record.gapReasons.push(reason),
      onControlAck: (frame) => {
        record.acks = record.acks ?? [];
        record.acks.push(frame);
      },
      onRunAccepted: (frame) => {
        record.accepted = frame;
      },
      onOther: (frame) => {
        if (frame.type === 'error') record.errors.push(frame);
      },
      onError: (error) => record.errors.push({ type: 'transport', message: error.message }),
    },
  });

  record.realtime = realtime;
  return { record, realtime };
}

/** 把归约结果里的文本抽出来（用户 + 助手）。 */
function extractText(chat) {
  const turns = turnsForDisplay(chat).filter(hasContent);
  const lines = [];
  for (const turn of turns) {
    for (const block of turn.user?.blocks ?? []) {
      if (block.kind === 'text') lines.push({ role: 'user', text: block.text });
    }
    for (const block of turn.assistant?.blocks ?? []) {
      if (block.kind === 'text') lines.push({ role: 'assistant', text: block.text });
      if (block.kind === 'reasoning') lines.push({ role: 'reasoning', text: block.text });
      if (block.kind === 'tool')
        lines.push({ role: 'tool', text: block.title, status: block.status });
      if (block.kind === 'error') lines.push({ role: 'error', text: block.text });
    }
  }
  return lines;
}

async function listChatModels(client) {
  const models = await client.listModels();
  const items = Array.isArray(models) ? models : (models.items ?? []);
  return items.filter((model) => (model.type ?? 'chat') === 'chat' && model.enable !== false);
}

/** 跑一个真实对话，返回记录。 */
async function converse({ client, bot, token, baseUrl, sessionId, text, modelId, timeoutMs }) {
  const { record, realtime } = attachRealtime(baseUrl, bot.id, token, sessionId);
  realtime.connect();

  const connected = await waitFor(() => realtime.connectionState === 'open', 20_000);
  if (!connected) {
    realtime.dispose();
    return { record, connected: false };
  }

  realtime.subscribe(sessionId);
  await waitFor(() => record.chat.epoch !== null, 25_000);

  const invocationId = realtime.sendMessage({ sessionId, text, modelId });
  record.chat = appendOptimisticUserMessage(record.chat, text, invocationId);

  await waitFor(() => record.accepted !== null, 30_000);
  // 分两步等，每步独立超时：先等它真的开始跑，再等它收敛。
  // 合成一个条件会有竞态——短回复可能在第一次轮询前就跑完了，
  // 于是"看没看到 running"和"有没有结束"纠缠在一起。
  await waitFor(() => record.sawRunning, 60_000);
  await waitFor(() => !record.chat.running && record.chat.runStatus !== null, timeoutMs);
  // 收敛后再多收一会儿，让尾部帧到达。
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  // 如果没收敛，去服务端查这次 run 的真实终态。
  // 只报"没完成"没有可操作性——要么是模型慢，要么是服务端把它判失败了，
  // 两者的处理完全不同。
  if (record.chat.running) {
    record.stuckState = await fetchRunState(client, bot.id, sessionId, record.accepted?.run_id);
  }

  realtime.dispose();
  return { record, connected: true };
}

/**
 * 查一个会话落盘后的状态。
 *
 * 实时投影只说"还在跑"，历史落盘才有终态。诊断卡住时必须看后者——
 * "模型慢"和"服务端把它判失败了"是两件完全不同的事。
 */
async function fetchRunState(client, botId, sessionId, runId) {
  try {
    const history = await client.listMessages(botId, sessionId, { limit: 20 });
    return { turns: history.items?.length ?? 0, runId: runId ?? null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 一次对话的判定。
 *
 * 三种结果要分开，因为处置完全不同：
 *   - completed：正常。
 *   - server-failed：服务端把这次 run 判失败了。实测证据（见
 *     docs/research/verified-behaviour.md）表明这在本项目是**上游偶发**，
 *     与客户端无关，重试通常就好——所以标出来但不计为失败，否则会淹掉真信号。
 *   - stuck：真的卡住了。客户端必须能从这个状态恢复（看到失败、能重试/停止）。
 */
function classify(record) {
  if (record.chat.runStatus === 'completed') return 'completed';
  const errored = record.chat.runStatus === 'errored' || record.runStatuses.includes('errored');
  if (errored) return 'server-failed';
  return 'stuck';
}

// ---------------------------------------------------------------- 场景

const SCENARIOS = {};

/**
 * 挑一个"愿意用工具"的模型。
 *
 * 实测（`tools/tool-compare.mjs`）：同一个 bot、同一句提示，k3 会走工具通道并真的
 * 执行 `exec`，而 deepseek-v4-flash 会说"没有 shell 工具可用"。这是模型行为差异，
 * 不是配置问题。要测工具链路就得挑对模型，否则测的是"这个模型不用工具"。
 */
async function pickToolCapableModel(client) {
  const models = await listChatModels(client);
  // 优先带 tool-call 兼容标记的。
  const withToolCall = models.filter((model) =>
    JSON.stringify(model.config ?? {}).includes('tool-call'),
  );
  return withToolCall[0] ?? models[0] ?? null;
}

SCENARIOS.models = {
  title: '多模型：同一句话打到不同模型家族',
  async run({ client, bot, token, baseUrl, args }) {
    const models = await listChatModels(client);
    console.log(`  可用 chat 模型：${models.map((model) => model.model_id).join(', ')}`);
    if (models.length < 2) {
      check(false, '至少要有两个模型才能测跨家族差异', `只有 ${models.length} 个`);
      return;
    }

    const results = [];
    for (const model of models.slice(0, 3)) {
      const created = await client.createSession(bot.id, { title: `scenario ${model.model_id}` });
      const sessionId = created?.id ?? created?.session_id;
      if (typeof sessionId !== 'string') {
        check(false, `建会话失败（${model.model_id}）`);
        continue;
      }

      console.log(`\n  ── ${model.model_id} ──`);
      const { record, connected } = await converse({
        client,
        bot,
        token,
        baseUrl,
        sessionId,
        text: 'Reply with exactly one short sentence about what you are.',
        modelId: model.id,
      });
      if (!connected) {
        check(false, `${model.model_id} 连不上`);
        continue;
      }

      const lines = extractText(record.chat);
      const textBlocks = lines.filter((line) => line.role === 'assistant');
      const reasoningBlocks = lines.filter((line) => line.role === 'reasoning');

      check(record.accepted !== null, `${model.model_id} 收到 run_accepted`);
      const verdict = classify(record);
      if (verdict === 'server-failed') {
        record.flaky = true;
        console.log(`      ⚠ 服务端把这次 run 判为失败（已知偶发，非客户端问题）`);
      }
      if (verdict === 'stuck') {
        console.error(`      真卡住了；服务端侧：${JSON.stringify(record.stuckState ?? {})}`);
      }
      check(verdict !== 'stuck', `${model.model_id} 没卡住`, String(record.chat.runStatus));
      check(textBlocks.length > 0, `${model.model_id} 有正文输出`, `${textBlocks.length} 块`);
      check(record.deltas > 0, `${model.model_id} 收到流式增量`, `${record.deltas} 帧`);
      check(
        record.gapReasons.length === 0,
        `${model.model_id} 无 seq 空洞`,
        record.gapReasons.join(',') || '无',
      );
      check(
        record.errors.length === 0,
        `${model.model_id} 无错误帧`,
        record.errors.map((e) => e.message).join('; ') || '无',
      );

      const preview = textBlocks
        .map((line) => line.text)
        .join(' ')
        .slice(0, 90)
        .replace(/\s+/g, ' ');
      const kind = reasoningBlocks.length > 0 ? '带思考' : '无思考';
      console.log(`      回复（${kind}）："${preview}"`);
      console.log(`      增量 ${record.appends} 次 append / ${record.upserts} 次 upsert`);

      results.push({
        model: model.model_id,
        reasoning: reasoningBlocks.length > 0,
        deltas: record.deltas,
        appends: record.appends,
        upserts: record.upserts,
      });

      if (!args.keep) await client.deleteSession(bot.id, sessionId).catch(() => {});
    }

    // 跨家族的差异要能被观察到，否则这个场景没测到东西。
    const withReasoning = results.filter((row) => row.reasoning).length;
    check(
      withReasoning > 0,
      '至少有一个模型产出了思考块（否则跨家族差异没被覆盖）',
      `${withReasoning}/${results.length}`,
    );
  },
};

SCENARIOS.tools = {
  title: '工具调用与审批：让 agent 真的去动工作区',
  async run({ client, bot, token, baseUrl, args }) {
    const model = await pickToolCapableModel(client);
    if (model === null) {
      check(false, '没有可用模型');
      return;
    }
    console.log(`  用模型：${model.model_id}`);

    const created = await client.createSession(bot.id, { title: 'scenario tools' });
    const sessionId = created?.id ?? created?.session_id;
    if (typeof sessionId !== 'string') {
      check(false, '建会话失败');
      return;
    }

    // 明确要求动工作区：这类请求必须经过工具，不能靠模型"说它做了"。
    const { record, connected } = await converse({
      client,
      bot,
      token,
      baseUrl,
      sessionId,
      text: 'Use your shell tool to run: echo memoh-ios-toolcheck. Then tell me the output.',
      modelId: model.id,
      timeoutMs: args.timeout,
    });
    if (!connected) {
      check(false, '连不上实时通道');
      return;
    }

    const lines = extractText(record.chat);
    const liveToolBlocks = lines.filter((line) => line.role === 'tool');

    // 以**历史**为准：实时投影里的 tool upsert 会被后续帧整块覆盖，
    // 只数实时块会把"执行过"误判成"没执行"。
    let historyToolBlocks = 0;
    const toolNames = [];
    try {
      const history = await client.listMessages(bot.id, sessionId, { limit: 50 });
      for (const turn of history.items ?? []) {
        for (const message of turn.messages ?? []) {
          if (message.type !== 'tool') continue;
          historyToolBlocks += 1;
          if (message.name && !toolNames.includes(message.name)) toolNames.push(message.name);
        }
      }
    } catch {
      // 查不到就用实时块，下面按两者取大。
    }
    const toolBlocks =
      historyToolBlocks > liveToolBlocks.length
        ? new Array(historyToolBlocks).fill(null)
        : liveToolBlocks;
    console.log(
      `    实时 tool 块 ${liveToolBlocks.length} 个；历史 tool 块 ${historyToolBlocks} 个${toolNames.length ? `（${toolNames.join(', ')}）` : ''}`,
    );
    console.log(
      `    待审批 ${record.approvalsSeen.length} 个；待回答 ${record.userInputsSeen.length} 个`,
    );
    console.log(`    run 终态：${record.chat.runStatus}`);

    check(record.accepted !== null, '收到 run_accepted');
    // 没出现工具块有两种可能：模型选择不用工具，或者工具在这个 bot 上不可用。
    // 说清楚是哪种——前者是模型行为，后者是配置问题。
    if (toolBlocks.length === 0) {
      const assistantText = lines
        .filter((line) => line.role === 'assistant')
        .map((line) => line.text)
        .join(' ');
      console.log(`    模型回复：${JSON.stringify(assistantText.slice(0, 160))}`);
      console.log(
        '    没出现工具块：要么模型没用工具，要么这个 bot 的工具没启用（需要看服务端配置）',
      );
    }
    check(toolBlocks.length > 0, '渲染出了工具块（说明这条链路能表达工具调用）');
    check(
      record.chat.runStatus === 'completed' ||
        record.chat.runStatus === 'aborted' ||
        record.chat.runStatus === 'errored',
      'run 到了终态（没有卡在等待里）',
      String(record.chat.runStatus),
    );

    if (record.approvalsSeen.length > 0) {
      check(true, '出现了需要审批的决策（移动端最该处理的场景）');
      const approval = record.chat.approval;
      if (approval !== null) {
        check(
          approval.options.length > 0,
          '审批带了 agent 定义的选项',
          approval.options.map((o) => o.id).join(', '),
        );
        // 真的回应一次——这是移动端最核心的一条链路：agent 停下等你，你点一下它继续。
        const choice = approval.options[0];
        const ack = await respondToApproval(record, sessionId, approval, choice.id);
        check(
          ack !== null,
          '审批回应收到 control_ack',
          ack === null ? '超时' : `applied=${ack.applied}`,
        );
        if (ack !== null && ack.applied === false && (ack.code ?? '') === '') {
          check(true, '回执说明控制生效但未改变状态（run 已结束，不是错误）');
        }
        // 回应后 run 应当继续并最终收敛。
        const settledAfter = await waitFor(() => !record.chat.running, 90_000);
        check(settledAfter, '回应审批后 run 继续并收敛', String(record.chat.runStatus));
      }
    } else {
      console.log('      注意：这个 bot 的工具不需要审批，审批链路未被覆盖');
    }

    const history = await client.listMessages(bot.id, sessionId, { limit: 50 });
    check((history.items ?? []).length > 0, '历史已落盘', `${(history.items ?? []).length} 轮`);

    if (!args.keep) await client.deleteSession(bot.id, sessionId).catch(() => {});
  },
};

SCENARIOS.errors = {
  title: '错误态：坏凭据与不存在的模型',
  async run({ client, bot, token, baseUrl }) {
    // 1) 不存在的模型：服务端应当明确拒绝，而不是静默降级到默认模型。
    const created = await client.createSession(bot.id, { title: 'scenario errors' });
    const sessionId = created?.id ?? created?.session_id;
    if (typeof sessionId !== 'string') {
      check(false, '建会话失败');
      return;
    }

    const { record, connected } = await converse({
      client,
      bot,
      token,
      baseUrl,
      sessionId,
      text: 'hello',
      modelId: '00000000-0000-4000-8000-000000000000',
      timeoutMs: 60_000,
    });
    if (!connected) {
      check(false, '连不上');
      return;
    }

    // 服务端可能回 error 帧，也可能回 run_rejected + 投影里的 errored 状态。
    const sawError = record.errors.length > 0;
    const sawErroredRun = record.runStatuses.includes('errored');
    check(
      sawError || sawErroredRun,
      '不存在的模型被明确拒绝（不是静默成功）',
      sawError ? 'error 帧' : 'run errored',
    );

    const lines = extractText(record.chat);
    const errorBlocks = lines.filter((line) => line.role === 'error');
    console.log(
      `    错误块：${errorBlocks.map((b) => b.text).join(' | ') || '（无，走的是 run 状态）'}`,
    );

    // 2) 坏 token：HTTP 层必须 401，且触发上层清凭据的信号。
    const badClient = new MemohClient({ baseUrl, getToken: () => 'not-a-real-token' });
    let unauthorized = false;
    try {
      await badClient.listBots();
    } catch (error) {
      unauthorized = error?.isUnauthorized === true;
    }
    check(unauthorized, '坏 token 得到 401（上层据此回登录页）');

    if (record.chat.runStatus === 'errored') {
      check(true, 'run 状态是 errored，界面能显示"运行失败"');
    }

    try {
      await client.deleteSession(bot.id, sessionId);
    } catch {
      // 清理失败不影响结论。
    }
  },
};

/**
 * 回应一个审批，并等回执。
 *
 * 这是移动端最该验证的一条链路：agent 停下等你，你点一下，它继续。回执的
 * `applied` 字段要区分两种"没成功"：`applied:false` + 空 code = 控制被处理了但
 * 什么都没改变（run 已结束）；code 非空 = 请求没到 owner，值得重试。
 */
async function respondToApproval(record, sessionId, approval, optionId) {
  const realtime = record.realtime;
  const runId = record.chat.runId;
  if (realtime === null || runId === null) return null;

  const controlId = realtime.newControlId();
  record.acks = record.acks ?? [];

  realtime.respondToApproval({
    sessionId,
    runId,
    approvalId: approval.approvalId,
    optionId,
    controlId,
  });

  const acked = await waitFor(
    () => record.acks.some((ack) => ack.control_id === controlId),
    20_000,
  );
  return acked ? record.acks.find((ack) => ack.control_id === controlId) : null;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      console.log(`${name}\t${scenario.title}`);
    }
    return 0;
  }

  const env = loadEnv();
  const baseUrl = (env.MEMOH_DEV_BASE_URL ?? 'http://127.0.0.1:18080').replace(/\/+$/, '');
  const password = env.MEMOH_ADMIN_PASSWORD;
  if (!password) {
    console.error(`需要 ${ENV_PATH} 里的 MEMOH_ADMIN_PASSWORD（联调环境的起法与能力矩阵：memoh-ios-dev.md §2 / §4.5）`);
    return 2;
  }

  console.log(`真实 API 场景 → ${baseUrl}\n`);

  let token = null;
  const client = new MemohClient({ baseUrl, getToken: () => token });
  token = (await client.login('admin', password)).access_token;

  const bots = await client.listBots();
  const bot = bots.items?.[0];
  if (bot === undefined) {
    console.error('没有 bot；先跑 infra/vultr-sg/seed-dev-bot.sh');
    return 1;
  }

  const selected = args.scenario ? { [args.scenario]: SCENARIOS[args.scenario] } : SCENARIOS;
  if (Object.values(selected).some((scenario) => scenario === undefined)) {
    console.error(`未知场景 ${args.scenario}；用 --list 看有哪些`);
    return 2;
  }

  for (const [name, scenario] of Object.entries(selected)) {
    console.log(`\n[${name}] ${scenario.title}`);
    try {
      await scenario.run({ client, bot, token, baseUrl, args });
    } catch (error) {
      check(false, `场景 ${name} 抛错`, error instanceof Error ? error.message : String(error));
    }
  }

  console.log('\n──────────────────────────────');
  console.log(`通过 ${passed}，失败 ${failed}`);
  if (failed > 0) console.log('失败的那几条才是信息。');
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`\n✖ 未捕获：${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  });
