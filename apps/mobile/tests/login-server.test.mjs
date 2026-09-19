/**
 * 服务器地址的规范化、候选优先级与 Memoh 探测（`src/features/auth/server.ts`）。
 *
 * 为什么值得测：**"地址错""不是 Memoh""密码错"是三件不同的事**，混成一句话会让用户去
 * 反复重输密码；而口令只能在确认对方是 Memoh 之后发出去——探测逻辑错了就是凭据泄露。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  discoverMemohServer,
  discoveryCandidates,
  hostOf,
  normalizeServer,
  serverProblemOf,
} from '../src/features/auth/server.ts';

// ---------------------------------------------------------- 规范化

test('空地址是 empty（不是"连不上"）', () => {
  assert.equal(serverProblemOf(''), 'empty');
  assert.equal(serverProblemOf('   '), 'empty');
  assert.deepEqual(normalizeServer(''), { ok: false, problem: 'empty' });
});

test('裸域名补 https://；localhost / loopback / 私网补 http://', () => {
  const pub = normalizeServer('memoh.example.com');
  assert.equal(pub.ok, true);
  assert.equal(pub.server.baseUrl, 'https://memoh.example.com');
  assert.equal(pub.server.explicitPath, false);
  assert.equal(pub.server.local, false);

  assert.equal(normalizeServer('localhost:8080').server.baseUrl, 'http://localhost:8080');
  assert.equal(normalizeServer('127.0.0.1:18080').server.baseUrl, 'http://127.0.0.1:18080');
  assert.equal(normalizeServer('192.168.1.20').server.baseUrl, 'http://192.168.1.20');
  assert.equal(normalizeServer('10.0.0.5').server.baseUrl, 'http://10.0.0.5');
  assert.equal(normalizeServer('172.16.3.4').server.baseUrl, 'http://172.16.3.4');
  assert.equal(normalizeServer('nas.local').server.baseUrl, 'http://nas.local');
});

test('公网地址的 http:// 拒绝（口令不能明文上公网）；内网 http:// 放行', () => {
  assert.deepEqual(normalizeServer('http://memoh.example.com'), { ok: false, problem: 'invalid' });
  assert.deepEqual(normalizeServer('http://8.8.8.8'), { ok: false, problem: 'invalid' });
  assert.equal(normalizeServer('http://192.168.1.20').ok, true);
  assert.equal(normalizeServer('http://127.0.0.1:18080').ok, true);
  assert.equal(normalizeServer('http://localhost:8080').ok, true);
});

test('userinfo / query / fragment / 空 host / 非 http(s) 协议一律拒绝', () => {
  assert.equal(serverProblemOf('https://user:pass@memoh.example.com'), 'invalid');
  assert.equal(serverProblemOf('https://user@memoh.example.com'), 'invalid');
  assert.equal(serverProblemOf('https://memoh.example.com/?a=1'), 'invalid');
  assert.equal(serverProblemOf('https://memoh.example.com/#x'), 'invalid');
  assert.equal(serverProblemOf('https://'), 'invalid');
  assert.equal(serverProblemOf('http://:8080'), 'invalid');
  assert.equal(serverProblemOf('https://memoh.example.com:'), 'invalid');
  assert.equal(serverProblemOf('ftp://memoh.example.com'), 'invalid');
  assert.equal(serverProblemOf('http://memoh example.com'), 'invalid');
  assert.equal(serverProblemOf('https://memoh.example.com:abc'), 'invalid');
  assert.equal(serverProblemOf('https://999.1.1.1'), 'invalid');
});

test('显式路径保留、末尾斜杠去掉；只有裸斜杠不算显式路径', () => {
  const withPath = normalizeServer('https://memoh.example.com/api/');
  assert.equal(withPath.ok, true);
  assert.equal(withPath.server.baseUrl, 'https://memoh.example.com/api');
  assert.equal(withPath.server.explicitPath, true);

  const bare = normalizeServer('https://memoh.example.com/');
  assert.equal(bare.server.baseUrl, 'https://memoh.example.com');
  assert.equal(bare.server.explicitPath, false);

  assert.equal(serverProblemOf('  https://memoh.example.com  '), null);
});

// ---------------------------------------------------------- 候选优先级

function normalized(raw) {
  const result = normalizeServer(raw);
  assert.equal(result.ok, true, `expected ${raw} to normalize`);
  return result.server;
}

test('候选优先级：公网先 /api；本机/内网/显式 8080/18080 先裸根；显式路径只探它自己', () => {
  assert.deepEqual(discoveryCandidates(normalized('memoh.example.com')), [
    'https://memoh.example.com/api',
    'https://memoh.example.com',
  ]);
  assert.deepEqual(discoveryCandidates(normalized('localhost:8080')), [
    'http://localhost:8080',
    'http://localhost:8080/api',
  ]);
  assert.deepEqual(discoveryCandidates(normalized('127.0.0.1:18080')), [
    'http://127.0.0.1:18080',
    'http://127.0.0.1:18080/api',
  ]);
  // 公网主机但显式写了 8080（https）：也先裸根。
  assert.deepEqual(discoveryCandidates(normalized('https://memoh.example.com:8080')), [
    'https://memoh.example.com:8080',
    'https://memoh.example.com:8080/api',
  ]);
  // 用户明确写了路径：只探测那一条，不猜。
  assert.deepEqual(discoveryCandidates(normalized('https://memoh.example.com/memoh')), [
    'https://memoh.example.com/memoh',
  ]);
});

// ---------------------------------------------------------- 探测

/** 路由表驱动的假 fetch：命中返回 `{status:'ok'}`，未命中 404。 */
function fakeFetch(routes) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push(url);
    if (url.endsWith('/auth/login')) {
      assert.equal(init.method, 'POST');
      assert.equal(init.body, '{}');
      return { ok: false, status: 400, json: async () => ({ message: 'invalid request' }) };
    }
    if (!Object.hasOwn(routes, url)) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => routes[url] };
  };
  return { calls, fetchFn };
}

test('标准部署：/api/ping 成功 → base URL 带 /api', async () => {
  const { fetchFn } = fakeFetch({ 'https://memoh.example.com/api/ping': { status: 'ok' } });
  const found = await discoverMemohServer(normalized('memoh.example.com'), { fetchFn });
  assert.equal(found, 'https://memoh.example.com/api');
});

test('兼容部署：/api/ping 404、裸根 /ping 成功 → base URL 是裸根', async () => {
  const { fetchFn } = fakeFetch({ 'https://memoh.example.com/ping': { status: 'ok' } });
  const found = await discoverMemohServer(normalized('memoh.example.com'), { fetchFn });
  assert.equal(found, 'https://memoh.example.com');
});

test('两个候选都成功时按优先级选（公网 = /api），不按理应快的那个', async () => {
  const { fetchFn } = fakeFetch({
    'https://memoh.example.com/api/ping': { status: 'ok' },
    'https://memoh.example.com/ping': { status: 'ok' },
  });
  const found = await discoverMemohServer(normalized('memoh.example.com'), { fetchFn });
  assert.equal(found, 'https://memoh.example.com/api');
});

test('本机地址两个都成功时按优先级选裸根', async () => {
  const { fetchFn } = fakeFetch({
    'http://127.0.0.1:18080/ping': { status: 'ok' },
    'http://127.0.0.1:18080/api/ping': { status: 'ok' },
  });
  const found = await discoverMemohServer(normalized('127.0.0.1:18080'), { fetchFn });
  assert.equal(found, 'http://127.0.0.1:18080');
});

test('200 但正文是 HTML 不算 Memoh（那是网关/别的站点）', async () => {
  const { fetchFn } = fakeFetch({
    'https://memoh.example.com/api/ping': '<!doctype html><html>…</html>',
    'https://memoh.example.com/ping': { status: 'ok' },
  });
  const found = await discoverMemohServer(normalized('memoh.example.com'), { fetchFn });
  assert.equal(found, 'https://memoh.example.com');
});

test('ping 成功但 self-host 登录端点不存在时拒绝（Cloud 边界）', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url === 'https://app.memoh.net/api/ping') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const found = await discoverMemohServer(normalized('app.memoh.net'), { fetchFn });
  assert.equal(found, null);
  assert.ok(calls.includes('https://app.memoh.net/api/auth/login'));
});

test('2xx 且 status 不是 ok 也不算；JSON 解析失败也不算', async () => {
  const wrong = fakeFetch({
    'https://memoh.example.com/api/ping': { status: 'error' },
    'https://memoh.example.com/ping': { status: 'ok' },
  });
  assert.equal(
    await discoverMemohServer(normalized('memoh.example.com'), { fetchFn: wrong.fetchFn }),
    'https://memoh.example.com',
  );

  const brokenJson = {
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }),
  };
  assert.equal(await discoverMemohServer(normalized('memoh.example.com'), brokenJson), null);
});

test('显式路径时只探测那个 base（不猜其他路径）', async () => {
  const { calls, fetchFn } = fakeFetch({
    'https://memoh.example.com/memoh/ping': { status: 'ok' },
  });
  const found = await discoverMemohServer(normalized('https://memoh.example.com/memoh/'), {
    fetchFn,
  });
  assert.equal(found, 'https://memoh.example.com/memoh');
  assert.deepEqual(calls, [
    'https://memoh.example.com/memoh/ping',
    'https://memoh.example.com/memoh/auth/login',
  ]);
});

test('全部失败返回 null（不把口令发给一台不是 Memoh 的机器）', async () => {
  const fetchFn = async () => {
    throw new TypeError('Network request failed');
  };
  assert.equal(await discoverMemohServer(normalized('memoh.example.com'), { fetchFn }), null);
});

test('每个候选受同一个超时约束：挂起的请求被 abort，整体返回 null', async () => {
  const hanging = {
    fetchFn: (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
    timeoutMs: 30,
  };
  const started = Date.now();
  const found = await discoverMemohServer(normalized('memoh.example.com'), hanging);
  assert.equal(found, null);
  assert.ok(Date.now() - started < 2000, '探测必须在超时后返回，不能无限挂起');
});

// ---------------------------------------------------------- 显示摘要

test('摘要只留主机与端口：协议和路径都不显示；裸域名原样显示', () => {
  assert.equal(hostOf('https://memoh.example.com'), 'memoh.example.com');
  assert.equal(hostOf('http://127.0.0.1:18080'), '127.0.0.1:18080');
  assert.equal(hostOf('https://memoh.example.com/sub/path'), 'memoh.example.com');
  assert.equal(hostOf('  https://memoh.example.com/  '), 'memoh.example.com');
  assert.equal(hostOf('memoh.example.com'), 'memoh.example.com');
  assert.equal(hostOf('localhost:8080'), 'localhost:8080');
});
