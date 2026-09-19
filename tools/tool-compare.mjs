/**
 * 工具调用的对照探针。
 *
 * 起因：用 k3 发"用 shell 工具跑 echo"时，模型把工具调用当**文本**吐了出来：
 *
 *     <tool_calls>
 *     <invoke name="Bash">
 *     <parameter name="command">echo memoh-ios-toolcheck</parameter>
 *     ...
 *
 * 也就是说它想调工具，但没走工具通道。这有两种可能，处置完全不同：
 *   a) 上游给这个模型的工具描述/格式提示没生效 —— 服务端/提示词问题；
 *   b) 这个模型不支持该工具调用格式 —— 换模型就好。
 *
 * 这个脚本用**同一个提示**分别打不同模型，看谁真的产出了 tool 块。
 * 分不清 a 和 b 就没法决定"该改提示还是该换模型"。
 *
 * 用法：node tools/tool-compare.mjs
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import WebSocket from 'ws';

const env = Object.fromEntries(
  readFileSync(`${homedir()}/.config/memoh-ios/dev.env`, 'utf8')
    .split('\n')
    .map((line) => line.trim().split('='))
    .filter((pair) => pair.length === 2 && pair[0]),
);

const base = 'http://127.0.0.1:18080';
const PROMPT = 'Use your shell tool to run: echo memoh-ios-toolcheck. Then tell me the output.';

const login = await (
  await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: env.MEMOH_ADMIN_PASSWORD }),
  })
).json();
const token = login.access_token;
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const bots = await (await fetch(`${base}/bots`, { headers: auth })).json();
const bot = bots.items[0];
const modelsResponse = await (await fetch(`${base}/models`, { headers: auth })).json();
const models = (
  Array.isArray(modelsResponse) ? modelsResponse : (modelsResponse.items ?? [])
).filter((model) => model.enable !== false && (model.type ?? 'chat') === 'chat');

console.log(`对 ${models.length} 个模型用同一提示测试工具调用：\n${PROMPT}\n`);

const summary = [];

for (const model of models) {
  const created = await (
    await fetch(`${base}/bots/${bot.id}/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: `tool ${model.model_id}` }),
    })
  ).json();
  const sessionId = created.id;

  const observed = { toolBlocks: 0, approvals: 0, text: '', toolNames: [] };
  const ws = new WebSocket(`${base.replace('http', 'ws')}/bots/${bot.id}/web/ws`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const finished = new Promise((resolve) => {
    const deadline = setTimeout(() => resolve('timeout'), 120_000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'runtime_subscribe', session_id: sessionId }));
      setTimeout(
        () =>
          ws.send(
            JSON.stringify({
              type: 'message',
              invocation_id: crypto.randomUUID(),
              session_id: sessionId,
              text: PROMPT,
              model_id: model.id,
            }),
          ),
        1_500,
      );
    });
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type !== 'runtime_delta') return;
      const delta = frame.delta ?? {};
      for (const upsert of delta.message_upserts ?? []) {
        if (upsert.type === 'tool') {
          observed.toolBlocks += 1;
          if (!observed.toolNames.includes(upsert.name)) observed.toolNames.push(upsert.name);
          if (upsert.approval) observed.approvals += 1;
        }
        if (upsert.type === 'text' && typeof upsert.content === 'string')
          observed.text = upsert.content;
      }
      for (const append of delta.message_appends ?? []) {
        if (append.type === 'text') observed.text += append.content;
      }
      const status = delta.current_run_view?.status ?? delta.run?.status;
      if (status === 'completed' || status === 'errored' || status === 'aborted') {
        clearTimeout(deadline);
        resolve(status);
      }
    });
  });

  const outcome = await finished;
  ws.close();

  // 历史里有 tool 块才算真的调用了工具——实时投影可能还没到。
  let historyTools = 0;
  try {
    const history = await (
      await fetch(`${base}/bots/${bot.id}/messages?session_id=${sessionId}&limit=20`, {
        headers: auth,
      })
    ).json();
    for (const turn of history.items ?? []) {
      for (const message of turn.messages ?? []) {
        if (message.type === 'tool') historyTools += 1;
      }
    }
  } catch {
    // 查不到不影响主结论。
  }

  const looksLikeTextToolCall =
    /<tool_calls>|<invoke name=|<\/antml:invoke>|<function_calls>/i.test(observed.text);

  const verdict =
    historyTools > 0 || observed.toolBlocks > 0
      ? '工具通道'
      : looksLikeTextToolCall
        ? '文本冒充'
        : '未使用工具';

  summary.push({
    model: model.model_id,
    verdict,
    toolBlocks: observed.toolBlocks,
    historyTools,
    approvals: observed.approvals,
    outcome,
  });

  console.log(`── ${model.model_id} ──`);
  console.log(`   结果：${verdict}（${outcome}）`);
  console.log(
    `   实时 tool 块 ${observed.toolBlocks} 个；历史 tool 块 ${historyTools} 个；审批 ${observed.approvals} 个`,
  );
  if (observed.toolNames.length > 0) console.log(`   工具名：${observed.toolNames.join(', ')}`);
  if (looksLikeTextToolCall) {
    console.log(`   ⚠ 正文里出现了工具调用语法，说明它想调但没走通道：`);
    console.log(`     ${observed.text.slice(0, 160).replace(/\s+/g, ' ')}`);
  } else if (observed.text !== '') {
    console.log(`   正文：${observed.text.slice(0, 140).replace(/\s+/g, ' ')}`);
  }
  console.log();
}

console.log('──────────────────────────────');
console.log('结论：');
const viaChannel = summary.filter((row) => row.verdict === '工具通道');
const viaText = summary.filter((row) => row.verdict === '文本冒充');
const unused = summary.filter((row) => row.verdict === '未使用工具');
console.log(`  走工具通道：${viaChannel.map((row) => row.model).join(', ') || '（无）'}`);
console.log(`  把工具调用当文本吐：${viaText.map((row) => row.model).join(', ') || '（无）'}`);
console.log(`  完全没用工具：${unused.map((row) => row.model).join(', ') || '（无）'}`);
if (viaChannel.length > 0 && viaText.length > 0) {
  console.log(
    '  → 同一个 bot、同一个提示下有的走通道有的不走，说明是模型能力/兼容性问题，不是配置问题。',
  );
} else if (viaText.length > 0 && viaChannel.length === 0) {
  console.log('  → 全部模型都把工具调用当文本，指向服务端给模型的工具描述没有生效。');
}

process.exit(viaChannel.length > 0 ? 0 : 1);
