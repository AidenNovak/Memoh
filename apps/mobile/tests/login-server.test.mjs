/**
 * 服务器地址的校验与显示（`src/features/auth/server.ts`）。
 *
 * 为什么值得测：**"地址错"和"连不上"混成一句话**会让用户去反复重输密码。
 * 而地址的合法形状是自托管产品的第一个坑（漏 `http://`、粘进空格、带路径）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hostOf, serverProblemOf } from '../src/features/auth/server.ts';

test('空地址是 empty（不是"连不上"）', () => {
  assert.equal(serverProblemOf(''), 'empty');
  assert.equal(serverProblemOf('   '), 'empty');
});

test('缺协议的地址是 invalid —— 这是自托管最常见的填错方式', () => {
  assert.equal(serverProblemOf('memoh.example.com'), 'invalid');
  assert.equal(serverProblemOf('127.0.0.1:18080'), 'invalid');
});

test('中间带空格的粘贴内容是 invalid', () => {
  assert.equal(serverProblemOf('http://memoh example.com'), 'invalid');
});

test('正常地址（含端口、带路径、末尾斜杠）都算可用', () => {
  assert.equal(serverProblemOf('https://memoh.example.com'), null);
  assert.equal(serverProblemOf('http://127.0.0.1:18080'), null);
  assert.equal(serverProblemOf('https://memoh.example.com/'), null);
  assert.equal(serverProblemOf('  https://memoh.example.com  '), null);
});

test('摘要只留主机与端口：协议和路径都不显示', () => {
  assert.equal(hostOf('https://memoh.example.com'), 'memoh.example.com');
  assert.equal(hostOf('http://127.0.0.1:18080'), '127.0.0.1:18080');
  assert.equal(hostOf('https://memoh.example.com/sub/path'), 'memoh.example.com');
  assert.equal(hostOf('  https://memoh.example.com/  '), 'memoh.example.com');
});
