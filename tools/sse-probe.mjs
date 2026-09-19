// 探针：/sessions/events 到底会推什么？特别是"某个会话进入等待决策"时会不会有事件。
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
const bots = await (
  await fetch(`${base}/bots`, { headers: { Authorization: `Bearer ${token}` } })
).json();
const botId = bots.items[0].id;

// 1) SSE: /sessions/events
const sse = await fetch(`${base}/bots/${botId}/sessions/events`, {
  headers: { Authorization: `Bearer ${token}` },
});
console.log('SSE status:', sse.status, '| content-type:', sse.headers.get('content-type'));
const reader = sse.body.getReader();
const decoder = new TextDecoder();
const sseEvents = [];
(async () => {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split('\n')) {
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          sseEvents.push(payload);
          if (sseEvents.length <= 12) console.log('  SSE:', payload.slice(0, 160));
        }
      }
    }
  } catch (e) {
    console.log('SSE reader ended:', e.message);
  }
})();

// 2) 同时开始一轮对话，看 SSE 会不会报
await new Promise((r) => setTimeout(r, 800));
const sessions = await (
  await fetch(`${base}/bots/${botId}/sessions?limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  })
).json();
const sessionId = sessions.items[0].id;
const ws = new WebSocket(`${base.replace('http', 'ws')}/bots/${botId}/web/ws`, {
  headers: { Authorization: `Bearer ${token}` },
});
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
        }),
      ),
    800,
  );
});
ws.on('message', () => {});
setTimeout(() => {
  console.log('\n共收到 SSE 事件:', sseEvents.length);
  console.log(
    '类型:',
    [
      ...new Set(
        sseEvents.map((e) => {
          try {
            return JSON.parse(e).type;
          } catch {
            return e.slice(0, 30);
          }
        }),
      ),
    ].join(', '),
  );
  process.exit(0);
}, 45000);
