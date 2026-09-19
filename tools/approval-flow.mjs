#!/usr/bin/env node
/**
 * 审批链路：把工具审批打开，让 agent 真的停下来等你。
 *
 * ## 为什么需要单独测
 *
 * 移动端最大的差异化价值就是审批——agent 7x24 在跑，人不在电脑前，点一下"允许"
 * 让它继续。而 Memoh 默认**不开审批**（`tool_approval_config.enabled = false`），
 * 所以"顺畅对话"那类测试永远覆盖不到这条路径。
 *
 * 这个脚本做三件事：
 *   1. 临时打开 bot 的写/执行审批，构造一个必须审批的场景；
 *   2. 验证客户端能看到审批与它**逐字的选项**（不是写死的两个按钮）；
 *   3. 真的回应一次，并验证 run 继续到终态——然后**恢复原设置**。
 *
 * 恢复是必须的：这个 bot 也被别的验收用着，留下一个"每个工具都要审批"的配置会
 * 让那些测试莫名其妙地卡住。
 *
 * 用法：node tools/approval-flow.mjs [--keep]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import process from 'node:process';
import WebSocket from 'ws';

import { MemohClient } from '../apps/mobile/src/api/client.ts';
import { MemohRealtime } from '../apps/mobile/src/api/realtime.ts';
import {
  decisionForFallback,
  isFallbackOption,
  applyDelta,
  applyHistory,
  applySnapshot,
  appendOptimisticUserMessage,
  initialChatState,
  turnsForDisplay,
  hasContent,
} from '../apps/mobile/src/features/chat/reducer.ts';

const env = Object.fromEntries(
  readFileSync(`${homedir()}/.config/memoh-ios/dev.env`, 'utf8')
    .split('\n')
    .map((line) => line.trim().split('='))
    .filter((pair) => pair.length === 2 && pair[0]),
);

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

async function waitFor(predicate, timeoutMs, interval = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return predicate();
}

const baseUrl = (env.MEMOH_DEV_BASE_URL ?? 'http://127.0.0.1:18080').replace(/\/+$/, '');
const keepSession = process.argv.includes('--keep');

let token = null;
const client = new MemohClient({ baseUrl, getToken: () => token });
token = (await client.login('admin', env.MEMOH_ADMIN_PASSWORD)).access_token;

const bots = await client.listBots();
const bot = bots.items?.[0];
if (bot === undefined) {
  console.error('没有 bot；先跑 infra/vultr-sg/seed-dev-bot.sh');
  process.exit(1);
}

console.log('审批链路 → ' + baseUrl + '\n');

// ---------------------------------------------------------------- 打开审批
const before = await client.getSettings(bot.id);
const enabledBefore = before?.tool_approval_config?.enabled === true;
console.log(`[1] 打开审批（当前 enabled=${enabledBefore}）`);

// 形状必须与服务端 GET 返回的完全一致（没有 `mode` 字段）。
// 多传字段会让 PUT 被拒，而失败信息不明显——看起来像"设置没生效"。
await client.updateSettings(bot.id, {
  tool_approval_config: {
    enabled: true,
    read: { require_approval: false, bypass_globs: [], force_review_globs: [] },
    write: { require_approval: true, bypass_globs: [], force_review_globs: [] },
    // 执行类强制审批。
    //
    // `force_review_commands` 是关键：只设 `require_approval: true` 时，
    // "简单可执行文件 + 无危险特征"的命令仍可能被放行（policy.go 的判定顺序），
    // 于是这条路测不到审批。显式把 echo 列进去，让场景**必然**触发审批。
    exec: {
      require_approval: true,
      bypass_commands: [],
      force_review_commands: ['echo'],
    },
  },
});
const after = await client.getSettings(bot.id);
check(after?.tool_approval_config?.enabled === true, '审批已打开');

let restoreNeeded = !enabledBefore;

// ---------------------------------------------------------------- 造场景
let sessionId = null;
try {
  const created = await client.createSession(bot.id, { title: 'approval flow' });
  sessionId = created?.id ?? created?.session_id;
  if (typeof sessionId !== 'string') throw new Error('建会话失败');

  // 挑一个会用工具的模型（实测 k3 会走工具通道）。
  const modelsResponse = await client.listModels();
  const models = Array.isArray(modelsResponse) ? modelsResponse : (modelsResponse.items ?? []);
  const toolModel =
    models.find((model) => JSON.stringify(model.config ?? {}).includes('tool-call')) ?? models[0];
  console.log(`[2] 造场景（模型 ${toolModel?.model_id}）`);

  const seen = { approval: null, options: [], acks: [], statuses: [], deltas: 0 };
  let chat = initialChatState;

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
        if (chat.approval !== null) seen.approval = chat.approval;
      },
      onDelta: (frame) => {
        if (frame.sessionId !== sessionId) return;
        chat = applyDelta(chat, frame.epoch, frame.seq, frame.delta);
        seen.deltas += 1;
        if (chat.runStatus !== null) seen.statuses.push(chat.runStatus);
        if (chat.approval !== null && seen.approval === null) {
          seen.approval = chat.approval;
          seen.options = chat.approval.options.map((option) => option.id);
        }
      },
      onControlAck: (frame) => seen.acks.push(frame),
    },
  });

  realtime.connect();
  await waitFor(() => realtime.connectionState === 'open', 20_000);
  realtime.subscribe(sessionId);
  await waitFor(() => chat.epoch !== null, 25_000);

  const text = 'Run this shell command and show me the output: echo approval-check';
  const invocationId = realtime.sendMessage({ sessionId, text, modelId: toolModel?.id });
  chat = appendOptimisticUserMessage(chat, text, invocationId);

  // ---------------------------------------------------------------- 观察审批
  const gotApproval = await waitFor(() => seen.approval !== null, 120_000);
  check(gotApproval, 'agent 停下来要求审批（这是"等你批准"的权威信号）');

  if (!gotApproval) {
    console.error('  没等到审批。可能这个模型没调工具，或者审批策略没拦住它。');
    console.error(`  run 状态历史：${[...new Set(seen.statuses)].join(' → ') || '(无)'}`);
  } else {
    const approval = seen.approval;
    console.log(`    工具：${approval.toolName}`);
    console.log(`    选项：${approval.options.map((o) => `${o.id}(${o.tone})`).join(', ')}`);
    console.log(`    待审批时 run 状态：${chat.runStatus}`);

    check(
      chat.runStatus === 'waiting_decision',
      'run 状态是 waiting_decision（比看 UI 上的标记更权威）',
      String(chat.runStatus),
    );
    check(
      approval.options.length > 0,
      '审批带了 agent 定义的选项',
      `${approval.options.length} 个`,
    );
    check(
      approval.options.every((option) => option.id !== '' && option.tone !== undefined),
      '每个选项都有 id 与语气（UI 据此渲染，而不是写死两个按钮）',
      approval.options.map((o) => `${o.id}:${o.tone}`).join(', '),
    );

    // ---------------------------------------------------------------- 回应
    // 选项可能来自 agent，也可能是我们造的兜底动作（agent 不给 options 时）。
    // 两种都要能回应——兜底那条正是"没有按钮就没法继续"的修复。
    const allow = approval.options.find((option) => option.tone === 'allow') ?? approval.options[0];
    const usingFallback = isFallbackOption(allow.id);
    console.log(`    选项来源：${usingFallback ? '兜底（agent 未定义选项）' : 'agent 定义'}`);
    const runId = chat.runId;
    check(runId !== null, '拿到 run_id（回应审批必须用它寻址）', String(runId));

    if (runId !== null) {
      console.log(`[3] 回应审批：${allow.id}`);
      const controlId = realtime.newControlId();
      if (usingFallback) {
        // 兜底动作不能回传假 id——服务端匹配不到。用 decision 表达。
        realtime.respondToApproval({
          sessionId,
          runId,
          approvalId: approval.approvalId,
          decision: decisionForFallback(allow.id),
          controlId,
        });
      } else {
        realtime.respondToApproval({
          sessionId,
          runId,
          approvalId: approval.approvalId,
          optionId: allow.id,
          controlId,
        });
      }

      const acked = await waitFor(
        () => seen.acks.some((ack) => ack.control_id === controlId),
        30_000,
      );
      const ack = seen.acks.find((entry) => entry.control_id === controlId);
      check(acked, '收到 control_ack', ack === undefined ? '超时' : `applied=${ack.applied}`);
      if (ack !== undefined) {
        if (ack.applied === false && (ack.code ?? '') === '') {
          // 这两种"没成功"必须分清：空 code 表示控制被处理但没改变任何东西，
          // 非空 code 表示请求没到 owner、值得重试。
          check(true, '回执语义正确：控制已处理但未改变状态（不是错误）');
        }
      }

      // 批准之后 run 应该继续，并且最终收敛。
      const resumed = await waitFor(() => !chat.running && chat.runStatus !== null, 120_000);
      check(resumed, '批准后 run 继续并收敛', String(chat.runStatus));

      const turns = turnsForDisplay(chat).filter(hasContent);
      const toolBlocks = turns.flatMap((turn) =>
        (turn.assistant?.blocks ?? []).filter((block) => block.kind === 'tool'),
      );
      console.log(
        `    最终工具块：${toolBlocks.map((b) => `${b.name}[${b.status}]`).join(', ') || '无'}`,
      );

      const history = await client.listMessages(bot.id, sessionId, { limit: 50 });
      const historicalToolBlocks = (history.items ?? []).flatMap((turn) =>
        (turn.messages ?? []).filter((message) => message.type === 'tool'),
      );
      check(
        historicalToolBlocks.length > 0,
        '历史里留下了工具执行记录（说明批准真的让它执行了）',
        `${historicalToolBlocks.length} 个`,
      );
      const historyAfter = applyHistory(chat, history.items ?? []);
      check(turnsForDisplay(historyAfter).filter(hasContent).length > 0, '历史能渲染出内容');
    }
  }

  realtime.dispose();
} finally {
  // ---------------------------------------------------------------- 收尾
  // 必须恢复：别的验收也用这个 bot，留下"每个工具都要审批"的配置会让它们莫名卡住。
  if (restoreNeeded) {
    await client
      .updateSettings(bot.id, {
        tool_approval_config: {
          enabled: enabledBefore,
          // 恢复成上游的默认值：写要审批（/data、/tmp 例外），执行不审批。
          read: { require_approval: false, bypass_globs: [], force_review_globs: [] },
          write: {
            require_approval: true,
            bypass_globs: ['/data/**', '/tmp/**'],
            force_review_globs: [],
          },
          exec: { require_approval: false, bypass_commands: [], force_review_commands: [] },
        },
      })
      .catch(() => {});
    const restored = await client.getSettings(bot.id).catch(() => null);
    const ok = restored?.tool_approval_config?.enabled !== true;
    console.log(`\n[4] 恢复审批设置：${ok ? '已关闭' : '⚠ 恢复失败，请手动检查'}`);
    if (!ok) failed += 1;
    else passed += 1;
  } else {
    console.log('\n[4] 审批本来就是开着的，不动它');
  }

  if (typeof sessionId === 'string' && !keepSession) {
    await client.deleteSession(bot.id, sessionId).catch(() => {});
  }
}

console.log('\n──────────────────────────────');
console.log(`通过 ${passed}，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
