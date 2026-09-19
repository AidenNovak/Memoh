#!/usr/bin/env node
/**
 * 探针：一轮真实 run 期间，服务端到底发了哪些**状态载体**。
 *
 * 起因：真机上"正文已经在流式到达，而 composer 的按钮仍是禁用的发送键、副标题也没有
 * Thinking"。这一半说明 `chat.running` 是 false。它由 `isRunActive(current_run_view.status)`
 * 算出，所以要看的是：**哪一帧带 `current_run_view`**，以及带的时候 status 是什么。
 *
 * 只读：建一个会话、发一句话、把每一帧的形状打出来（不打印正文内容，避免把会话内容
 * 带进日志）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import WebSocket from 'ws';

import { MemohClient } from '../apps/mobile/src/api/client.ts';
import { MemohRealtime } from '../apps/mobile/src/api/realtime.ts';

const env = Object.fromEntries(
  readFileSync(`${homedir()}/.config/memoh-ios/dev.env`, 'utf8')
    .split('\n')
    .map((line) => line.trim().split('='))
    .filter((pair) => pair.length === 2 && pair[0]),
);

let token = null;
const client = new MemohClient({ baseUrl: env.MEMOH_DEV_BASE_URL, getToken: () => token });
token = (await client.login('admin', env.MEMOH_ADMIN_PASSWORD)).access_token;
const bot = (await client.listBots()).items[0];

const created = await client.createSession(bot.id, { title: `状态载体探针 ${Date.now()}` });
const sessionId = created?.id ?? created?.session_id;
console.log('session', sessionId);

const started = Date.now();
const stamp = () => `${String(((Date.now() - started) / 1000).toFixed(1)).padStart(5)}s`;

const realtime = new MemohRealtime({
  baseUrl: env.MEMOH_DEV_BASE_URL,
  botId: bot.id,
  getToken: () => token,
  createSocket: (url, authToken) =>
    new WebSocket(url, { headers: { Authorization: `Bearer ${authToken}` } }),
  listener: {
    onSnapshot: (frame) => {
      const run = frame.snapshot?.current_run_view;
      console.log(
        `${stamp()} SNAPSHOT  current_run_view=${run ? run.status : 'null'} seq=${frame.snapshot?.seq}`,
      );
    },
    onDelta: (frame) => {
      const delta = frame.delta ?? {};
      const run = delta.current_run_view;
      const keys = Object.keys(delta).filter((k) => k !== 'seq');
      const statuses = (delta.message_upserts ?? []).map((m) => `${m.type}:${m.running}`).join(',');
      console.log(
        `${stamp()} delta seq=${frame.seq ?? delta.seq} run=${run ? run.status : '-'} keys=[${keys.join(' ')}] msgs=${statuses}` +
          (delta.run === undefined ? '' : ` delta.run=${JSON.stringify(delta.run).slice(0, 200)}`),
      );
    },
  },
});
realtime.connect();
for (let i = 0; i < 40; i += 1) {
  if (realtime.connectionState === 'open') break;
  await new Promise((r) => setTimeout(r, 500));
}
realtime.subscribe(sessionId);
await new Promise((r) => setTimeout(r, 1500));
realtime.sendMessage({ sessionId, text: '用一句话说明你是谁' });

await new Promise((r) => setTimeout(r, 45000));
realtime.dispose();
console.log('done');
process.exit(0);
