// 审批的 options 为什么是空的？看服务端原始帧。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import WebSocket from 'ws';
const env = Object.fromEntries(
  readFileSync(`${homedir()}/.config/memoh-ios/dev.env`, 'utf8')
    .split('\n')
    .map((l) => l.trim().split('='))
    .filter((p) => p.length === 2 && p[0]),
);
const base = 'http://127.0.0.1:18080';
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
const models = await (await fetch(`${base}/models`, { headers: auth })).json();
const list = Array.isArray(models) ? models : models.items || [];
const k3 = list.find((m) => m.model_id === 'k3');

const created = await (
  await fetch(`${base}/bots/${bot.id}/sessions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ title: 'approval shape' }),
  })
).json();
const sessionId = created.id;
const ws = new WebSocket(`${base.replace('http', 'ws')}/bots/${bot.id}/web/ws`, {
  headers: { Authorization: `Bearer ${token}` },
});
let dumped = false;
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'runtime_subscribe', session_id: sessionId }));
  setTimeout(
    () =>
      ws.send(
        JSON.stringify({
          type: 'message',
          invocation_id: crypto.randomUUID(),
          session_id: sessionId,
          text: 'Run this shell command: echo approval-shape',
          model_id: k3.id,
        }),
      ),
    1500,
  );
});
ws.on('message', (d) => {
  const f = JSON.parse(d.toString());
  if (f.type === 'runtime_delta') {
    for (const u of f.delta.message_upserts || []) {
      if (u.approval && !dumped) {
        dumped = true;
        console.log('=== tool 块 ===');
        console.log('name:', u.name, '| running:', u.running);
        console.log('=== approval 原始形状 ===');
        console.log(JSON.stringify(u.approval, null, 2).slice(0, 900));
      }
    }
    const v = f.delta.current_run_view;
    if (v?.status === 'waiting_decision' && !dumped) {
      for (const m of v.messages || []) {
        if (m.approval) {
          dumped = true;
          console.log('=== snapshot 里的 approval ===');
          console.log(JSON.stringify(m.approval, null, 2).slice(0, 900));
        }
      }
    }
  }
});
setTimeout(() => {
  if (!dumped) console.log('没抓到 approval');
  ws.close();
  process.exit(0);
}, 70000);
