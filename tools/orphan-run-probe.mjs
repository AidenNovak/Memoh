/**
 * 探针：owner 死掉之后，客户端能不能**发现** run 已经失败了？
 *
 * ## 背景
 *
 * 上游偶发（`persistence fence is stale`）会让 run 在 `admitting` 之后死掉。
 * 服务端把它落盘为 `state=failed / agent.response_interrupted`，但客户端侧只是
 * "3 帧之后没下文"——投影停在 `running`。
 *
 * ## 这个探针要回答的问题
 *
 * 既然事件流不告诉你，那**重新订阅**呢？网络恢复、App 回前台时都会重订阅。
 * 如果重订阅能拿到终态，客户端就有救；如果拿不到，客户端必须自己判定"它死了"
 * ——那是完全不同的实现。
 *
 * 用法：node tools/orphan-run-probe.mjs
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import process from 'node:process';
import WebSocket from 'ws';

import { MemohClient } from '../apps/mobile/src/api/client.ts';

const env = Object.fromEntries(
  readFileSync(`${homedir()}/.config/memoh-ios/dev.env`, 'utf8')
    .split('\n')
    .map((line) => line.trim().split('='))
    .filter((pair) => pair.length === 2 && pair[0]),
);
const baseUrl = 'http://127.0.0.1:18080';

let token = null;
const client = new MemohClient({ baseUrl, getToken: () => token });
token = (await client.login('admin', env.MEMOH_ADMIN_PASSWORD)).access_token;
const bots = await client.listBots();
const bot = bots.items[0];

// 找一个"库里是 failed，但可能还挂在投影里"的会话。
// 直接连库查不了（客户端没这个能力），所以改成：新建会话、发一条、等它出问题。
// 但问题是它偶发——所以这个探针的做法是：**打一个必然失败的 run**，
// 看投影会不会告诉客户端。用不存在的模型 id 就能稳定触发。
const created = await client.createSession(bot.id, { title: 'orphan probe' });
const sessionId = created?.id ?? created?.session_id;
console.log(`会话 ${String(sessionId).slice(0, 8)}`);

/** 订阅并记录看到的一切。 */
async function observe(label, send) {
  const seen = { statuses: [], appends: 0, errors: [], frames: 0, snapshotStatus: null };
  const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/bots/${bot.id}/web/ws`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const finished = new Promise((resolve) => {
    const deadline = setTimeout(() => resolve('timeout'), 45_000);
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'runtime_subscribe', session_id: sessionId }));
      if (send) setTimeout(() => socket.send(JSON.stringify(send)), 1_500);
    });
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      seen.frames += 1;
      if (frame.type === 'runtime_snapshot') {
        seen.snapshotStatus = frame.snapshot?.current_run_view?.status ?? null;
        if (seen.snapshotStatus) seen.statuses.push(`snapshot:${seen.snapshotStatus}`);
      }
      if (frame.type === 'runtime_delta') {
        const delta = frame.delta ?? {};
        seen.appends += (delta.message_appends ?? []).length;
        const status = delta.current_run_view?.status ?? delta.run?.status;
        if (status) seen.statuses.push(status);
        if (
          status === 'completed' ||
          status === 'errored' ||
          status === 'aborted' ||
          status === 'lost'
        ) {
          clearTimeout(deadline);
          resolve(status);
        }
      }
      if (frame.type === 'error') seen.errors.push(frame.message ?? frame.code ?? 'error');
    });
  });

  const outcome = await finished;
  socket.close();
  console.log(`\n[${label}] 结果：${outcome}`);
  console.log(`  帧数 ${seen.frames}，append ${seen.appends}`);
  console.log(`  看到的 run 状态：${[...new Set(seen.statuses)].join(' → ') || '(无)'}`);
  console.log(`  首次订阅时的 snapshot 状态：${seen.snapshotStatus ?? '(无活跃 run)'}`);
  if (seen.errors.length > 0) console.log(`  错误帧：${seen.errors.join(' | ')}`);
  return { outcome, ...seen };
}

// 第一步：发一个必然失败的请求（不存在的模型），看投影给不给终态。
console.log('\n步骤 1：用一个不存在的模型发起 run（必然失败），看投影是否告知');
const first = await observe('必然失败', {
  type: 'message',
  invocation_id: crypto.randomUUID(),
  session_id: sessionId,
  text: 'hello',
  model_id: '00000000-0000-4000-8000-000000000000',
});

// 第二步：**重新订阅同一个会话**。这模拟 App 回前台/网络恢复时的重连。
// 关键问题：此时能不能从 snapshot 里读到失败终态？
console.log('\n步骤 2：重新订阅该会话（模拟重连），看 snapshot 是否给出终态');
const second = await observe('重订阅', null);

console.log('\n──────────────────────────────');
console.log('结论：');
if (first.outcome === 'timeout') {
  console.log('  ✖ 失败发生时投影**不告知**客户端——它停在 running，用户看到的是"卡住"。');
} else {
  console.log(`  ✔ 失败时投影给出了终态：${first.outcome}`);
}
if (second.snapshotStatus === null) {
  console.log('  · 重订阅拿到"无活跃 run"：客户端可据此认为上一轮已结束（虽然不知道原因）。');
} else {
  console.log(
    `  · 重订阅拿到状态 ${second.snapshotStatus}：${second.snapshotStatus === 'running' ? '⚠ 仍然说在跑——客户端无法自行恢复' : '可用于恢复'}`,
  );
}

process.exit(0);
