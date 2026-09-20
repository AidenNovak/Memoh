#!/usr/bin/env node
/**
 * 校验 locales/*.json 的 key 集合完全一致、值非空、占位符一致。
 *
 * 这是 `pnpm ios:check` 的一部分。它防的是最容易被 agent 忽略的坑：加了一条英文文案
 * 却忘了中文（或反过来），上线后才发现某个语言缺 key。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'locales');
const FILES = ['en.json', 'zh-Hans.json'];
const REFERENCE = 'en.json';

/** @param {string} text */
function placeholders(text) {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
}

/** @param {string} file */
function load(file) {
  const path = join(localesDir, file);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: not valid JSON — ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file}: expected a flat object of string → string`);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`${file}: ${key} must be a string`);
    }
    if (value.trim() === '') {
      throw new Error(`${file}: ${key} is empty`);
    }
  }
  return parsed;
}

const problems = [];
const catalogs = Object.fromEntries(FILES.map((file) => [file, load(file)]));
const referenceKeys = Object.keys(catalogs[REFERENCE]).sort();

for (const file of FILES) {
  const keys = Object.keys(catalogs[file]).sort();
  for (const key of referenceKeys) {
    if (!keys.includes(key)) problems.push(`${file}: missing key "${key}"`);
  }
  for (const key of keys) {
    if (!referenceKeys.includes(key)) problems.push(`${file}: extra key "${key}"`);
  }
}

// 占位符集合必须在各语言间一致，否则插值会漏字段。
for (const key of referenceKeys) {
  const expected = placeholders(catalogs[REFERENCE][key] ?? '');
  for (const file of FILES) {
    const value = catalogs[file][key];
    if (value === undefined) continue;
    const actual = placeholders(value);
    if (actual.join(',') !== expected.join(',')) {
      problems.push(
        `${file}: ${key} placeholders [${actual.join(', ')}] != ${REFERENCE} [${expected.join(', ')}]`,
      );
    }
  }
}

/**
 * 反向检查：**代码里 `t('x.y')` 写的键必须在 locales 里存在**。
 *
 * 为什么需要它：`i18n:check` 原本只查"两语是否对齐"，所以一个**两边都没写**的键
 * 一路绿灯，直到真机上显示成 `files.preview.binary.title` 这样的原始键名才被发现
 * （2026-09-15 就是这么发现的）。这个类别的 bug 完全可以在 CI 前拦住。
 *
 * 只认静态字符串：`t(someVariable)` 与模板拼接的键没法静态判断，跳过——宁可漏报，
 * 不要误报，否则这条检查会被当成噪音关掉。
 */
function sourceFiles(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (/\.tsx?$/.test(name)) found.push(path);
  }
  return found;
}

const srcDir = join(here, '..', 'src');
const CALL = /(?:^|[^\w.$])t\(\s*['"]([a-zA-Z][\w.]*)['"]/g;
const referenced = new Map();
for (const path of sourceFiles(srcDir)) {
  const text = readFileSync(path, 'utf8');
  for (const match of text.matchAll(CALL)) {
    const key = match[1];
    if (!referenced.has(key)) referenced.set(key, path.slice(srcDir.length + 1));
  }
}
for (const [key, where] of referenced) {
  if (!referenceKeys.includes(key)) {
    problems.push(`${where}: uses "${key}" but no locale defines it`);
  }
}

if (problems.length > 0) {
  console.error(`i18n check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`i18n ok: ${referenceKeys.length} keys × ${FILES.length} locales`);
