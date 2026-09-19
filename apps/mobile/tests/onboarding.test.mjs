/**
 * 首启引导的内容与判断。
 *
 * 这一屏没有复杂逻辑，坏的方式却很具体：**文案 key 写错一个字母**（界面上会出现
 * `onboarding.agents.titel` 这种原文）、**两个页面用同一个 id**（React key 重复）、
 * **"该不该显示"判断反了**（要么每次启动都弹一次，要么新用户永远看不到）。
 * 三样都是只看截图不容易发现的，所以钉在这里。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ONBOARDING_PAGES, shouldShowOnboarding } from '../src/features/onboarding/pages.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES = join(HERE, '..', 'locales');

function catalog(file) {
  return JSON.parse(readFileSync(join(LOCALES, file), 'utf8'));
}

test('引导有三页，id 不重复（重复的 id 在 React 里就是重复的 key）', () => {
  assert.equal(ONBOARDING_PAGES.length, 3);
  const ids = ONBOARDING_PAGES.map((page) => page.id);
  assert.equal(new Set(ids).size, ids.length, `页 id 重复：${ids.join(',')}`);
});

test('每一页的文案 key 在中英两份语言文件里都存在且非空', () => {
  const en = catalog('en.json');
  const zh = catalog('zh-Hans.json');
  for (const page of ONBOARDING_PAGES) {
    for (const key of [page.titleKey, page.bodyKey]) {
      assert.equal(typeof en[key], 'string', `en.json 缺 ${key}`);
      assert.notEqual(en[key].trim(), '', `en.json 的 ${key} 是空的`);
      assert.equal(typeof zh[key], 'string', `zh-Hans.json 缺 ${key}`);
      assert.notEqual(zh[key].trim(), '', `zh-Hans.json 的 ${key} 是空的`);
    }
  }
});

test('每一页的符号名非空（符号名写错会变成一块空白，不报错）', () => {
  for (const page of ONBOARDING_PAGES) {
    assert.notEqual(page.symbol.trim(), '', `${page.id} 没有符号名`);
  }
});

test('动作文案（跳过 / 继续 / 开始 / 页码）两份语言文件里都有', () => {
  const en = catalog('en.json');
  const zh = catalog('zh-Hans.json');
  for (const key of [
    'onboarding.skip',
    'onboarding.next',
    'onboarding.start',
    'onboarding.progress',
  ]) {
    assert.equal(typeof en[key], 'string', `en.json 缺 ${key}`);
    assert.equal(typeof zh[key], 'string', `zh-Hans.json 缺 ${key}`);
  }
  // 页码文案里的占位符必须两边一致，否则切换语言时会带上一个没被替换的 {{total}}。
  assert.match(en['onboarding.progress'], /\{\{current\}\}/);
  assert.match(en['onboarding.progress'], /\{\{total\}\}/);
  assert.match(zh['onboarding.progress'], /\{\{current\}\}/);
  assert.match(zh['onboarding.progress'], /\{\{total\}\}/);
});

test('该不该显示：只有"没看过 且 没有验收种子"才显示', () => {
  assert.equal(shouldShowOnboarding({ seen: false, hasVerifySeed: false }), true);
  // 看过就不再打扰。
  assert.equal(shouldShowOnboarding({ seen: true, hasVerifySeed: false }), false);
  // 验收种子代表"已经配好的状态"：验收和录屏都不该被引导挡在前面。
  assert.equal(shouldShowOnboarding({ seen: false, hasVerifySeed: true }), false);
  assert.equal(shouldShowOnboarding({ seen: true, hasVerifySeed: true }), false);
});
