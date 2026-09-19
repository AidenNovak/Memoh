#!/usr/bin/env node
/**
 * 强制 AGENTS.md 里那条「不要嵌套三元表达式」的规则。
 *
 * 一条规则写进文档但没人执行，等于没有。理由也是真实的：嵌套三元读起来要来回跳，
 * 而"读反了"是这类代码最常见的错。
 *
 * ## 为什么用"链式"判定而不是解析器
 *
 * 第一版试图对每个 `?` 找配对 `:` 再检查分支里有没有 `?`。实测它在 JSX 上全是
 * 误报——`<Foo a={x} b={y} />` 里的冒号会被当成三元的分隔符。一个会误报的检查
 * 等于没有：大家会直接把它关掉。
 *
 * 所以这里只抓**真正有害且能精确识别**的那一种形态——链式三元本身，形如
 * `cond ? a : cond2 ? b : c`。它的特征是两个分支各自是简单表达式（不含括号、
 * 大括号、分号），于是 `? ... :` 后面紧跟 `... ?` 能无歧义匹配。JSX 的属性列表里
 * `:` 后面跟的不是这种形态，因此不会误报。
 *
 * 更深层的嵌套（分支里带函数调用等）这里抓不到——那属于漏报，但漏报不会让人
 * 关掉检查，误报会。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', 'src');
const EXTENSIONS = ['.ts', '.tsx'];

/** 去掉注释与字符串字面量，避免把它们里面的 ? : 算进去。 */
function stripNoise(source) {
  const blank = (match) => ' '.repeat(match.length).replace(/\n/g, '\n');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank)
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, blank)
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, blank)
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, blank);
}

/**
 * 简单分支：不含 `?`、`:`、`;`、括号、大括号、方括号、换行。
 * 一旦分支里出现这些，说明它是复合表达式——要么是 JSX，要么已经超出这条判定
 * 能可靠识别的范围（宁可漏报）。
 */
const SIMPLE = String.raw`[^?:;(){}[\]\n]+`;

/** 链式三元：`? <simple> : <simple> ?`。 */
const CHAIN = new RegExp(String.raw`\?\s*${SIMPLE}\s*:\s*${SIMPLE}\s*\?`, 'g');

function findChains(source) {
  const text = stripNoise(source);
  const problems = [];
  for (const match of text.matchAll(CHAIN)) {
    const index = match.index ?? 0;
    const line = text.slice(0, index).split('\n').length;
    problems.push({ line, snippet: match[0].replace(/\s+/g, ' ').trim().slice(0, 70) });
  }
  return problems;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules') continue;
      yield* walk(path);
    } else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      yield path;
    }
  }
}

/** 自检：这个检测器必须真的抓得到目标形态，否则它只是个摆设。 */
function selfTest() {
  const caught = findChains('const x = a ? b : c ? d : e;');
  if (caught.length === 0) {
    console.error('自检失败：链式三元没被抓到，检测器无效');
    return false;
  }
  const jsx = findChains('<Foo label={x} value={y} onPress={z} />');
  if (jsx.length !== 0) {
    console.error('自检失败：JSX 被误报，检测器不可用');
    return false;
  }
  const optional = findChains('const y = obj?.a ?? fallback;');
  if (optional.length !== 0) {
    console.error('自检失败：可选链被误报');
    return false;
  }
  return true;
}

if (!selfTest()) process.exit(2);

const problems = [];
for (const file of walk(ROOT)) {
  for (const problem of findChains(readFileSync(file, 'utf8'))) {
    problems.push(`${relative(join(here, '..'), file)}:${problem.line}  ${problem.snippet}`);
  }
}

if (problems.length > 0) {
  console.error(`发现 ${problems.length} 处链式三元（AGENTS.md 禁止嵌套三元）：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\n改法：用 if/else 或 switch；封闭集合用字典映射。');
  process.exit(1);
}

console.log('ternary check ok：没有链式三元');
