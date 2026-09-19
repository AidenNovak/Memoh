// 复验：修完顺序 bug 之后，新会话里的渲染顺序对不对。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import WebSocket from 'ws';
import { MemohClient } from '../apps/mobile/src/api/client.ts';
import { MemohRealtime } from '../apps/mobile/src/api/realtime.ts';
import {
  applyDelta,
  applySnapshot,
  applyHistory,
  appendOptimisticUserMessage,
  initialChatState,
  turnsForDisplay,
  hasContent,
} from '../apps/mobile/src/features/chat/reducer.ts';

const env = Object.fromEntries(
  readFileSync(`${homedir()}/.config/memoh-ios/dev.env`, 'utf8')
    .split('\n')
    .map((l) => l.trim().split('='))
    .filter((p) => p.length === 2 && p[0]),
);
const baseUrl = 'http://127.0.0.1:18080';
let token = null;
const client = new MemohClient({ baseUrl, getToken: () => token });
token = (await client.login('admin', env.MEMOH_ADMIN_PASSWORD)).access_token;
const bots = await client.listBots();
const bot = bots.items[0];
const created = await client.createSession(bot.id, { title: 'order verify' });
const sessionId = created.id ?? created.session_id;

let chat = initialChatState;
const rt = new MemohRealtime({
  baseUrl,
  botId: bot.id,
  getToken: () => token,
  createSocket: (url, t) => new WebSocket(url, { headers: { Authorization: `Bearer ${t}` } }),
  listener: {
    onSnapshot: (f) => {
      if (f.sessionId === sessionId) chat = applySnapshot(chat, f.snapshot);
    },
    onDelta: (f) => {
      if (f.sessionId === sessionId) chat = applyDelta(chat, f.epoch, f.seq, f.delta);
    },
  },
});
rt.connect();
await new Promise((r) => setTimeout(r, 2500));
rt.subscribe(sessionId);
await new Promise((r) => setTimeout(r, 2500));

// 模拟 App 的发送路径：先乐观插入，再发。
const TEXT = 'Say exactly: gamma';
const inv = rt.sendMessage({ sessionId, text: TEXT });
chat = appendOptimisticUserMessage(chat, TEXT, inv);

await new Promise((r) => setTimeout(r, 45000));

const turns = turnsForDisplay(chat).filter(hasContent);
console.log('\n[run 结束后] 渲染顺序：');
turns.forEach((t, i) => {
  const u = (t.user?.blocks ?? []).map((b) => b.text ?? '').join(' ');
  const a = (t.assistant?.blocks ?? []).map((b) => b.text ?? '').join(' ');
  console.log(
    `  [${i}] user=${JSON.stringify(u.slice(0, 40))} assistant=${JSON.stringify(a.slice(0, 40))}`,
  );
});

// 再模拟 run 结束后的历史刷新。
const hist = await client.listMessages(bot.id, sessionId, { limit: 20 });
const after = applyHistory(chat, hist.items);
const t2 = turnsForDisplay(after).filter(hasContent);
console.log('\n[刷新历史后] 渲染顺序：');
t2.forEach((t, i) => {
  const u = (t.user?.blocks ?? []).map((b) => b.text ?? '').join(' ');
  const a = (t.assistant?.blocks ?? []).map((b) => b.text ?? '').join(' ');
  console.log(
    `  [${i}] user=${JSON.stringify(u.slice(0, 40))} assistant=${JSON.stringify(a.slice(0, 40))}`,
  );
});

// 断言
const first = t2[0];
const ok = (first?.user?.blocks.length ?? 0) > 0 && (first?.assistant?.blocks.length ?? 0) > 0;
console.log('\n结果:', ok ? 'PASS —— 同一轮里用户在前、助手在后' : 'FAIL —— 顺序或配对仍然不对');
rt.dispose();
process.exit(ok ? 0 : 1);
