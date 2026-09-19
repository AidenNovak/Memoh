import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
const bots = await (
  await fetch(`${base}/bots`, { headers: { Authorization: `Bearer ${token}` } })
).json();
const botId = bots.items[0].id;
// 复用一个已有会话，避免每次新建
const sessions = await (
  await fetch(`${base}/bots/${botId}/sessions?limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  })
).json();
let sessionId = sessions.items[0]?.id;
if (!sessionId) {
  const c = await (
    await fetch(`${base}/bots/${botId}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ws probe' }),
    })
  ).json();
  sessionId = c.id;
}
console.log('session', sessionId);
const ws = new WebSocket(`${base.replace('http', 'ws')}/bots/${botId}/web/ws`, {
  headers: { Authorization: `Bearer ${token}` },
});
const events = [];
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'runtime_subscribe', session_id: sessionId }));
  setTimeout(() => {
    ws.send(
      JSON.stringify({
        type: 'message',
        invocation_id: crypto.randomUUID(),
        session_id: sessionId,
        text: 'Reply with exactly: hello from the client.',
      }),
    );
  }, 1200);
});
ws.on('message', (d) => {
  const f = JSON.parse(d.toString());
  events.push(f.type);
  if (f.type === 'runtime_delta') {
    const delta = f.delta || {};
    const appends = (delta.message_appends || [])
      .map((a) => `${a.type}#${a.id}:${JSON.stringify(a.content)}`)
      .join(' | ');
    const upserts = (delta.message_upserts || [])
      .map((u) => `${u.type}#${u.id}${u.running !== undefined ? `(running=${u.running})` : ''}`)
      .join(' | ');
    if (appends || upserts || delta.run || delta.current_run_view)
      console.log(
        `  delta seq=${f.seq}`,
        appends || '',
        upserts || '',
        delta.run ? `run=${delta.run.status}` : '',
      );
  } else if (f.type === 'runtime_snapshot') {
    console.log('  snapshot seq=', f.seq, 'run=', f.snapshot?.current_run_view?.status ?? 'none');
  } else if (f.type === 'error') {
    console.log('  ERROR:', f.message);
  } else {
    console.log(' ', f.type, JSON.stringify(f).slice(0, 140));
  }
});
setTimeout(() => {
  ws.close();
  console.log('\nevent types:', [...new Set(events)].join(', '));
  process.exit(0);
}, 75000);
