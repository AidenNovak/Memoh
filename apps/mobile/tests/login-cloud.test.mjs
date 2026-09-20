/**
 * Cloud 登录入口的纯逻辑（`src/features/auth/cloud.ts`）与它的诚实性。
 *
 * 为什么值得测：这三个入口（GitHub / Google / 邮箱）是**占位**——服务端合同落地之前
 * 它们不发请求、不收集凭据。但"占位"不等于"这格可以乱来"：邮箱的本地校验决定了
 * "继续"什么时候亮，这是界面在教用户规则。校验挂在 React 组件里就只能靠渲染去猜，
 * 所以它是纯函数，这里直测。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canContinueWithEmail,
  emailProblemOf,
  shouldShowEmailError,
} from '../src/features/auth/cloud.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = join(HERE, '..');

// ---------------------------------------------------------- 邮箱校验

test('空是 empty（不亮也不报错）；首尾空格当作没看见', () => {
  assert.equal(emailProblemOf(''), 'empty');
  assert.equal(emailProblemOf('   '), 'empty');
  assert.equal(canContinueWithEmail(''), false);
  // 空着不该显示"格式不对"：用户可能还没填到这一格，报错是说教。
  assert.equal(shouldShowEmailError(''), false);
});

test('明显不对的（缺 @、缺域名点、带空格）是 invalid：不亮，且给那句说明', () => {
  for (const bad of ['alice', 'alice@', '@memoh.ai', 'alice@memoh', 'ali ce@memoh.ai', 'a@b .co']) {
    assert.equal(emailProblemOf(bad), 'invalid', `expected ${bad} to be invalid`);
    assert.equal(canContinueWithEmail(bad), false);
    assert.equal(shouldShowEmailError(bad), true);
  }
});

test('形状对的放行：亮"继续"（这一格今天也不会离开手机，更怪的地址不值得拦）', () => {
  for (const good of ['alice@memoh.ai', 'a@b.co', 'alice+ios@sub.memoh.ai', ' alice@memoh.ai ']) {
    assert.equal(emailProblemOf(good), null, `expected ${good} to pass`);
    assert.equal(canContinueWithEmail(good), true);
    assert.equal(shouldShowEmailError(good), false);
  }
});

// ------------------------------------------- 占位逻辑的诚实性（结构断言）

test('cloud.ts 不碰网络、不碰凭据存储：它是纯校验', () => {
  const source = readFileSync(join(MOBILE, 'src/features/auth/cloud.ts'), 'utf8');
  for (const forbidden of ['fetch', 'MemohClient', 'Keychain', 'credentials', 'import']) {
    const occurrences = source.split('\n').filter((line) => {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      return code.includes(forbidden);
    });
    assert.deepEqual(occurrences, [], `cloud.ts 出现了 ${forbidden}：占位逻辑不该有副作用`);
  }
});
