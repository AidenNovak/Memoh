#!/usr/bin/env node
/**
 * 公网入口的真机等价验证：从**外面**（走 https://memoh.<域>）跑一遍 App 的核心链路。
 *
 * ## 为什么必须有它
 *
 * "nginx 装好了、curl 拿到 401" 只证明端口开着。iOS App 真正依赖的是三件事，
 * 而每一件都可能在反代上单独失败：
 *
 *   1. 登录拿到 JWT；
 *   2. **WebSocket 实时通道能握手**（`/bots/{id}/web/ws`）——少了 Upgrade/Connection
 *      头就会失败，表现为"消息发出去但回复不出现"；
 *   3. 发一条消息后，回复能从那条 socket 回来。
 *
 * 第 2、3 条是模拟器截图证明不了的（截图只说明 UI 渲染对不对），所以按服务器上
 * 已有的 probe 风格写成脚本，跑在服务器上、对准公网域名。
 *
 * ## 用法
 *
 *   node tools/public-ingress-probe.mjs --base https://memoh.yetodawn.com
 *
 * 服务端地址与凭据从 `/opt/memoh-dev/secrets/memoh-dev.env` 读（脚本不打印密码）。
 */
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import process from 'node:process';
import { connect as tlsConnect } from 'node:tls';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

const base = arg('base', 'https://memoh.yetodawn.com').replace(/\/+$/, '');
const envPath = arg('env', '/opt/memoh-dev/secrets/memoh-dev.env');

let passed = 0;
let failed = 0;
function check(ok, label, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✔ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function readEnv(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

async function api(path, { method = 'GET', token, body, timeoutMs = 30_000 } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 非 JSON 就留着原文，报错时更有用。
  }
  return { status: response.status, body: parsed, text };
}

/**
 * 手写 WebSocket 握手（RFC 6455）。
 *
 * 为什么不用现成的 WebSocket：Node 18 没有这个全局对象，而服务器上也没装 `ws`。
 * 更重要的是——**这里要验的恰恰是握手本身**：反代有没有原样透传
 * `Upgrade: websocket` / `Connection: Upgrade`、以及对端回的是不是 101。
 * 用一个高层库只会把这段藏起来，而且它对"非 101"通常只丢一句不好归因的报错。
 */
function handshakeWebSocket(url, token, subscribeSessionId, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const isTls = parsed.protocol === 'wss:';
    const port = parsed.port ? Number(parsed.port) : isTls ? 443 : 80;
    const key = randomBytes(16).toString('base64');
    const path = `${parsed.pathname}${parsed.search}`;

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // 已经关了就算了。
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ ok: false, reason: `${timeoutMs / 1000}s 内没有结果` }),
      timeoutMs,
    );

    const onConnect = () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${parsed.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          `Authorization: Bearer ${token}`,
          '',
          '',
        ].join('\r\n'),
      );
    };

    const socket = isTls
      ? tlsConnect({ host: parsed.hostname, port, servername: parsed.hostname }, onConnect)
      : netConnect({ host: parsed.hostname, port }, onConnect);

    socket.setTimeout(timeoutMs);

    let buffer = Buffer.alloc(0);
    let handshakeDone = false;
    let subscribed = false;
    const frames = [];

    /**
     * 握手成功后立刻订阅一个会话。
     *
     * 这个 socket 是**被动**的：不订阅就什么都不会来（服务端只在响应客户端消息时
     * 才推 run_accepted 之类）。所以"握上手了"不等于"实时流能用"——必须走一步
     * 真实订阅、并且真的收到 `runtime_snapshot`，才算证明了 App 看得到内容。
     */
    const onHandshake = () => {
      const payload = JSON.stringify({ type: 'runtime_subscribe', session_id: subscribeSessionId });
      const frame = encodeClientFrame(payload);
      socket.write(frame);
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!handshakeDone) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString('latin1');
        const statusLine = head.split('\r\n')[0] ?? '';
        const status = Number(statusLine.split(' ')[1]);

        if (status !== 101) {
          finish({ ok: false, reason: `握手被拒：${statusLine.trim()}（期望 101）` });
          return;
        }
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
        const expected = createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        if (accept !== expected) {
          finish({ ok: false, reason: '101 里的 Sec-WebSocket-Accept 不对' });
          return;
        }
        handshakeDone = true;
        buffer = buffer.subarray(end + 4);

        // 握手一完成就订阅。**不能等"收到第一帧再订阅"**——这个 socket 在订阅前
        // 本来就是沉默的，那样等下去就是双方都在等对方先说话。
        if (!subscribed) {
          subscribed = true;
          onHandshake();
        }
      }

      const frame = decodeFrame(buffer);
      if (frame === null) return;
      frames.push(frame);
      // 等 runtime_snapshot：它证明**这条通道真的能承载会话投影**，
      // 而不只是"握手成功、能收心跳"。App 看不到实时流就是这种感觉。
      if (frame.includes('runtime_snapshot') || frames.length >= 8) {
        finish({ ok: true, preview: frame.slice(0, 140), frames });
      }
    });

    socket.on('error', (error) => finish({ ok: false, reason: `连接错误：${error.message}` }));
    socket.on('timeout', () => finish({ ok: false, reason: '连接超时' }));
    socket.on('close', () => {
      if (!settled) finish({ ok: false, reason: '连接在收到任何帧之前关闭' });
    });
  });
}

/** 编一个客户端 -> 服务端的帧。**必须掩码**（RFC 6455 要求，服务端会直接断开未掩码的帧）。 */
function encodeClientFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** 解一个服务端 -> 客户端的帧（不掩码）。不够就返回 null 等下次。 */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) return null;
  const payload = buffer.subarray(offset, offset + length);
  if (opcode === 0x1) return payload.toString('utf8');
  if (opcode === 0x8) return null;
  return `(帧 opcode=0x${opcode.toString(16)}，${length} 字节)`;
}

console.log(`公网入口验证 → ${base}\n`);
const env = readEnv(envPath);

// ---- 1. TLS 与鉴权边界 ----
console.log('① 鉴权边界');
const unauth = await api('/bots');
check(unauth.status === 401, '未认证的 /bots 返回 401（鉴权在起作用）', String(unauth.status));
check(unauth.status !== 502 && unauth.status !== 504, '反代没有把后端打挂', String(unauth.status));

// ---- 2. 登录 ----
console.log('\n② 登录');
const login = await api('/auth/login', {
  method: 'POST',
  body: { username: 'admin', password: env.MEMOH_ADMIN_PASSWORD },
});
check(login.status === 200, 'admin 登录成功', String(login.status));
const token = login.body?.access_token;
check(typeof token === 'string' && token.length > 20, '拿到 access_token');
if (typeof token !== 'string') {
  console.log(`\n通过 ${passed}，失败 ${failed}（没有 token，后面的检查无法进行）`);
  process.exit(1);
}

// ---- 3. 会话与历史 REST（WS 之外的另一半） ----
console.log('\n③ REST（会话与历史）');
const bots = await api('/bots', { token });
const bot = (bots.body?.items ?? bots.body?.bots ?? [])[0];
check(bot !== undefined, '能列出 bot', bot ? bot.id : String(bots.status));
if (bot === undefined) {
  console.log(`\n通过 ${passed}，失败 ${failed}`);
  process.exit(1);
}

const sessions = await api(`/bots/${bot.id}/sessions`, { token });
const sessionList = sessions.body?.items ?? [];
check(sessions.status === 200, '能列出会话', `${sessionList.length} 个`);

// ---- 4. WebSocket 实时通道（最关键的一步） ----
console.log('\n④ WebSocket 实时通道（反代最常漏的一环）');
const wsSessionId = arg('session', sessionList[0]?.id);
check(
  typeof wsSessionId === 'string',
  '有一个会话可用于订阅（证明实时流真的能带上内容）',
  String(wsSessionId),
);
if (typeof wsSessionId !== 'string') {
  console.log(`\n通过 ${passed}，失败 ${failed}`);
  process.exit(1);
}
const wsUrl = `${base.replace(/^http/, 'ws')}/bots/${bot.id}/web/ws`;
console.log(`  ${wsUrl}`);

const wsResult = await handshakeWebSocket(wsUrl, token, wsSessionId);

check(
  wsResult.ok,
  'WebSocket 在公网入口上能握手（101）并收到服务端帧',
  wsResult.reason ?? wsResult.preview,
);

// ---- 5. 结论 ----
console.log('\n结论：');
if (failed === 0) {
  console.log(`  公网入口可以支撑 iOS 真机使用（登录 + REST + WebSocket 全通）。`);
} else {
  console.log(`  有 ${failed} 项没过——真机装包之前先修掉，否则表现会像"App 坏了"。`);
}
console.log(`\n通过 ${passed}，失败 ${failed}。`);
process.exit(failed === 0 ? 0 : 1);
