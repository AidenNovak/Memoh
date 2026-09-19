/**
 * 探针：run 期间用户消息从哪来？
 *
 * 起因：真机截图显示助手回复渲染在用户气泡**上方**。这个脚本为了回答"为什么"——
 * 查清 `current_run_view.user_turns` 与 REST 历史里各自有什么，以及它们什么时候到。
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

const baseUrl = 'http://127.0.0.1:18080';
const login = await (
  await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: env.MEMOH_ADMIN_PASSWORD }),
  })
).json();
const token = login.access_token;
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const bots = await (await fetch(`${baseUrl}/bots`, { headers: auth })).json();
const bot = bots.items[0];
const created = await (
  await fetch(`${baseUrl}/bots/${bot.id}/sessions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ title: 'user_turn probe' }),
  })
).json();
const sessionId = created.id;
console.log('session', sessionId.slice(0, 8));

const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/bots/${bot.id}/web/ws`, {
  headers: { Authorization: `Bearer ${token}` },
});

let dumpedSnapshot = false;
let dumpedDelta = false;

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'runtime_subscribe', session_id: sessionId }));
  setTimeout(
    () =>
      ws.send(
        JSON.stringify({
          type: 'message',
          invocation_id: crypto.randomUUID(),
          session_id: sessionId,
          text: 'Say exactly: beta',
        }),
      ),
    1500,
  );
});

ws.on('message', (data) => {
  const frame = JSON.parse(data.toString());

  if (frame.type === 'runtime_snapshot' && !dumpedSnapshot) {
    dumpedSnapshot = true;
    const view = frame.snapshot.current_run_view;
    console.log(
      '\n[首个 snapshot] current_run_view:',
      view === null || view === undefined ? 'null' : Object.keys(view).join(', '),
    );
  }

  if (frame.type === 'runtime_delta') {
    const view = frame.delta.current_run_view;
    if (view !== undefined && view !== null && !dumpedDelta) {
      dumpedDelta = true;
      console.log('\n[delta 里的 current_run_view]');
      console.log('  user_turns:', JSON.stringify(view.user_turns ?? null)?.slice(0, 400));
      console.log('  messages:', (view.messages ?? []).map((m) => `${m.id}:${m.type}`).join(', '));
      console.log('  run status:', view.status);
    }
    if (frame.delta.user_turn_upserts !== undefined) {
      console.log(
        '\n[user_turn_upserts]',
        JSON.stringify(frame.delta.user_turn_upserts).slice(0, 500),
      );
    }
  }
});

setTimeout(async () => {
  const hist = await (
    await fetch(`${baseUrl}/bots/${bot.id}/messages?session_id=${sessionId}&limit=20`, {
      headers: auth,
    })
  ).json();
  console.log(`\n[REST 历史] ${hist.items.length} 轮:`);
  for (const turn of hist.items) {
    const msgs = (turn.messages ?? []).map((m) => m.type).join('+');
    console.log(
      `  role=${turn.role} pos=${turn.turn_position} text=${JSON.stringify((turn.text ?? '').slice(0, 30))} msgs=${msgs}`,
    );
  }
  ws.close();
  process.exit(0);
}, 45000);
