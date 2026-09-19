// 假设：多个会话/连接同时活跃时，run 之间会互相把 fence 顶掉。
// 做法：同时发起 2 个 run（不同会话），看有几个能完成。
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

async function makeSession(title) {
  const c = await (
    await fetch(`${base}/bots/${bot.id}/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title }),
    })
  ).json();
  return c.id;
}

async function runOne(sessionId, label, sendDelayMs) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/bots/${bot.id}/web/ws`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let status = null,
    appends = 0,
    err = null;
  const done = new Promise((res) => {
    const t = setTimeout(() => res('timeout'), 100000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'runtime_subscribe', session_id: sessionId }));
      setTimeout(
        () =>
          ws.send(
            JSON.stringify({
              type: 'message',
              invocation_id: crypto.randomUUID(),
              session_id: sessionId,
              text: 'Say exactly: ok',
              model_id: k3.id,
            }),
          ),
        sendDelayMs,
      );
    });
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString());
      if (f.type === 'runtime_delta') {
        const dd = f.delta || {};
        appends += (dd.message_appends || []).length;
        status = dd.current_run_view?.status ?? dd.run?.status ?? status;
        if (['completed', 'errored', 'aborted'].includes(status)) {
          clearTimeout(t);
          res(status);
        }
      }
      if (f.type === 'error') err = f.message;
    });
  });
  const out = await done;
  ws.close();
  return { label, out, appends, err };
}

console.log('并发：两个会话同时发（间隔 800ms）：');
const s1 = await makeSession('concurrent A');
const s2 = await makeSession('concurrent B');
const [r1, r2] = await Promise.all([runOne(s1, 'A', 1200), runOne(s2, 'B', 2000)]);
for (const r of [r1, r2])
  console.log(
    `  ${r.label} → ${r.out} appends=${r.appends}${r.err ? ` err=${r.err.slice(0, 60)}` : ''}`,
  );
process.exit(0);
