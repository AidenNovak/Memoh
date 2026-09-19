#!/usr/bin/env node
/**
 * 强制「按压反馈只有两档」。
 *
 * 规则来自视觉评审 `docs/research/review-visual-design.md` §2 第 3 行：全 App 的按压反馈
 * 当时有 **6 种透明度**（0.5×6、0.55×2、0.6×8、0.8×1、0.85×6、0.9×1），**对话页一屏里
 * 就占了 3 种**（头部动作 0.5 / 标题可点 0.6 / 发送 0.8）——用户报的"同一屏里两种观感"
 * 就是这么来的。收敛成两档：**行内小控件 0.6**、**独立成块的按钮 0.85**（`PRESS_OPACITY`）。
 *
 * ## 为什么要有这条检查
 *
 * "收敛成两档"如果只靠一次性的批量替换，下一处新写的 `Pressable` 又会随手写 0.7——
 * 而 0.7 和 0.6 的差别没人看得出来，只有"同一屏里两种"这件事看得出来。这条检查让
 * "随手写一个数值"在 `pnpm check` 里就红，而不是等下一次视觉评审。
 *
 * ## 判据（两条）
 *
 * 1. `opacity: pressed ? X : 1` 里的 X 必须是 `PRESS_OPACITY.control` 或
 *    `PRESS_OPACITY.button`，**不许是字面量数字**；
 * 2. `tokens.ts` 的 `PRESS_OPACITY` 必须**恰好两档**、值是 0.6 与 0.85——要动这两个值
 *    就得连着改这里，也就是必须是一次有意识的决定，而不是顺手调一下。
 *
 * ## 不查什么
 *
 * - `backgroundColor: pressed ? palette.field` 那 30 多处「换底」是**另一套合法做法**
 *   （列表行 / 大块用它，评审也要求保留），不在本检查范围内；
 * - 原生侧的按压高亮（`MessageCells.swift` 那些）归各自的验收，这里只看 JS 侧。
 *
 * 与 `check-ternaries.mjs` 同一个取舍：**宁可漏报，不要误报**。一条会误报的检查等于没有，
 * 大家会直接把它关掉。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const SRC = join(ROOT, 'src');
const TOKENS = join(SRC, 'lib', 'theme', 'tokens.ts');
const EXTENSIONS = ['.ts', '.tsx'];

/** 两档的名字与值。改这里就要连着改 `tokens.ts`——这正是这条检查存在的意义。 */
const TIERS = { control: 0.6, button: 0.85 };

/** 去掉注释与字符串字面量，避免把它们里面的内容算进去。**保留换行**，否则行号会漂。 */
function stripNoise(source) {
  const blank = (match) => match.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank)
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, blank)
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, blank)
    .replace(/"(?:\\[\s\S]|[^"\\])*"/g, blank);
}

function walk(directory, found = []) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      walk(path, found);
      continue;
    }
    if (EXTENSIONS.some((extension) => entry.endsWith(extension))) found.push(path);
  }
  return found;
}

/** 第 1 条：`opacity: pressed ? <值>` 里的值必须是那两档之一。 */
function checkOpacityLiterals() {
  const problems = [];
  // 值取到 `:` 之前、逗号/换行/右括号为止：`pressed ? 0.55 : 1,` 抓到 `0.55`。
  const pattern = /opacity:\s*pressed\s*\?\s*([^:,\n}]+?)\s*:/g;
  for (const path of walk(SRC)) {
    const source = stripNoise(readFileSync(path, 'utf8'));
    for (const match of source.matchAll(pattern)) {
      const value = match[1].trim();
      if (/^PRESS_OPACITY\.(control|button)$/.test(value)) continue;
      const line = source.slice(0, match.index).split('\n').length;
      problems.push(
        `${relative(ROOT, path)}:${line} 按压透明度是字面量 \`${value}\`——` +
          `要用 PRESS_OPACITY.control / PRESS_OPACITY.button`,
      );
    }
  }
  return problems;
}

/** 第 2 条：`tokens.ts` 里必须恰好两档，且值是 0.6 / 0.85。 */
function checkTiers() {
  const source = readFileSync(TOKENS, 'utf8');
  const block = /export const PRESS_OPACITY = \{([\s\S]*?)\} as const;/.exec(source);
  if (block === null) {
    return ['tokens.ts 里找不到 `export const PRESS_OPACITY = { … } as const;`'];
  }
  const entries = [...block[1].matchAll(/(\w+):\s*([0-9.]+)\s*,/g)].map((match) => ({
    name: match[1],
    value: Number(match[2]),
  }));
  const problems = [];
  if (entries.length !== 2) {
    problems.push(
      `PRESS_OPACITY 必须是两档，现在是 ${entries.length} 档：${entries.map((e) => e.name).join(' / ')}`,
    );
  }
  for (const [name, value] of Object.entries(TIERS)) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (entry === undefined) {
      problems.push(`PRESS_OPACITY 少了 \`${name}\`（应该是 ${value}）`);
      continue;
    }
    if (entry.value !== value) {
      problems.push(`PRESS_OPACITY.${name} 现在是 ${entry.value}，评审定的是 ${value}`);
    }
  }
  return problems;
}

const problems = [...checkTiers(), ...checkOpacityLiterals()];
if (problems.length > 0) {
  console.error(
    `按压反馈必须只有两档（${Object.entries(TIERS)
      .map(([k, v]) => `${k} ${v}`)
      .join(' / ')}）：`,
  );
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('按压反馈两档：ok');
