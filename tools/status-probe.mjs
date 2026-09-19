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
const sessions = await (
  await fetch(`${base}/bots/${botId}/sessions?limit=3`, {
    headers: { Authorization: `Bearer ${token}` },
  })
).json();
for (const s of sessions.items) {
  const st = await (
    await fetch(`${base}/bots/${botId}/sessions/${s.id}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  console.log(s.id.slice(0, 8), '| keys:', Object.keys(st).join(', '));
  console.log('   ', JSON.stringify(st).slice(0, 400));
}
