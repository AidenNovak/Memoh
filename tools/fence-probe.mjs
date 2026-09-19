// 假设：订阅（runtime activation）会不会自己 bump fence，从而把紧接着发起的 run 顶掉？
// 对比两种时序：A) 订阅后立刻发；B) 订阅后等 3 秒再发。
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

async function run(delayMs, label) {
  const created = await (
    await fetch(`${base}/bots/${bot.id}/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: `fence ${label}` }),
    })
  ).json();
  const sessionId = created.id;
  const ws = new WebSocket(`${base.replace('http', 'ws')}/bots/${bot.id}/web/ws`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let status = null,
    appends = 0,
    err = null;
  const done = new Promise((res) => {
    const t = setTimeout(() => res('timeout'), 90000);
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
        delayMs,
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
  console.log(
    `  ${label}（订阅后 ${delayMs}ms 发）→ ${out} appends=${appends}${err ? ` err=${err.slice(0, 50)}` : ''}`,
  );
  return out;
}

console.log('对比订阅与发送的间隔：');
await run(1200, 'A 快速');
await run(4000, 'B 等待');
await run(1200, 'A 快速');
await run(4000, 'B 等待');
process.exit(0);
