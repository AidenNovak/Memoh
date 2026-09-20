#!/usr/bin/env node
/**
 * 文档链接检查：把 Markdown 里的**相对链接**解析成本地路径，报告解析不到的。
 *
 * 只查链接（`[文本](目标)`），不查正文里裸写的路径。
 *
 * 默认范围是 **iOS 侧**（`AGENTS.md` + `memoh-ios-dev.md` + `apps/mobile/`）：
 * 上游那几百份 Markdown 不归我们管，扫进来只会刷噪声。
 *
 *   node tools/docs-links.mjs            # 查 iOS 侧的 Markdown
 *   node tools/docs-links.mjs docs README.md AGENTS.md
 *
 * 退出码：发现死链为 1。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.expo',
  'ios',
  'android',
  'Pods',
  'out',
  'results',
]);
const roots =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2)
    : ['AGENTS.md', 'memoh-ios-dev.md', 'apps/mobile'];

function walk(target, found) {
  if (!existsSync(target)) return found;
  const stats = statSync(target);
  if (stats.isFile()) {
    if (target.endsWith('.md')) found.push(target);
    return found;
  }
  for (const entry of readdirSync(target)) {
    if (SKIP_DIRS.has(entry)) continue;
    walk(join(target, entry), found);
  }
  return found;
}

const files = roots.flatMap((root) => walk(root, []));
const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const problems = [];
let checked = 0;

for (const file of files) {
  const body = readFileSync(file, 'utf8');
  for (const match of body.matchAll(linkPattern)) {
    const href = match[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    checked += 1;
    const target = resolve(dirname(file), decodeURIComponent(href.split('#')[0]));
    if (existsSync(target)) continue;
    problems.push(`${relative(process.cwd(), file)} → ${href}`);
  }
}

for (const problem of problems) console.error(`死链 ${problem}`);
console.log(
  `检查 ${files.length} 个 Markdown 文件、${checked} 条相对链接，死链 ${problems.length} 条。`,
);
process.exit(problems.length > 0 ? 1 : 0);
