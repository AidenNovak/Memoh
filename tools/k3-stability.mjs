/**
 * k3 稳定性探针。
 *
 * 起因：`api-scenarios` 里 k3 间歇性卡在 running、3 帧后没下文，而服务端日志同时
 * 出现 `session runtime persistence fence is stale`。单独跑一次却能通。
 * 这个脚本连跑 N 次，回答"是不是稳定复现""和什么条件相关"。
 *
 * 用法：node tools/k3-stability.mjs [次数]
 */
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
const rounds = Number(process.argv[2] ?? 4);

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
const list = Array.isArray(models) ? models : (models.items ?? []);
const k3 = list.find((m) => m.model_id === 'k3');

const results = [];
for (let round = 1; round <= rounds; round += 1) {
  const created = await (
    await fetch(`${base}/bots/${bot.id}/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: `k3 stability ${round}` }),
    })
  ).json();
  const sessionId = created.id;

  const ws = new WebSocket(`${base.replace('http', 'ws')}/bots/${bot.id}/web/ws`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  let frames = 0,
    appends = 0,
    status = null,
    err = null,
    text = '';
  const done = new Promise((resolve) => {
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
              text: 'Say exactly: ok',
              model_id: k3.id,
            }),
          ),
        1200,
      );
    });
    ws.on('message', (data) => {
      const f = JSON.parse(data.toString());
      frames += 1;
      if (f.type === 'runtime_delta') {
        const d = f.delta ?? {};
        appends += (d.message_appends ?? []).length;
        for (const a of d.message_appends ?? []) if (a.type === 'text') text += a.content;
        status = d.current_run_view?.status ?? d.run?.status ?? status;
        if (status === 'completed' || status === 'errored' || status === 'aborted') {
          clearTimeout(deadline);
          resolve(status);
        }
      }
      if (f.type === 'error') err = f.message;
    });
  });

  const outcome = await done;
  ws.close();
  results.push({ round, outcome, frames, appends, text: text.slice(0, 20), err });
  console.log(
    `  第 ${round} 次：${outcome}  frames=${frames} appends=${appends} text=${JSON.stringify(text.slice(0, 20))}${err ? ` err=${err.slice(0, 60)}` : ''}`,
  );
  await new Promise((r) => setTimeout(r, 1500));
}

const ok = results.filter((r) => r.outcome === 'completed').length;
console.log(`\n${ok}/${rounds} 次成功`);
if (ok < rounds) {
  console.log('失败的：');
  for (const r of results.filter((x) => x.outcome !== 'completed')) {
    console.log(`  第 ${r.round} 次 ${r.outcome} frames=${r.frames} err=${r.err ?? '(无)'}`);
  }
}
