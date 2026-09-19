#!/usr/bin/env node
/**
 * 协议漂移探测：比较两份 swagger 路径集合，打印"只在 A / 只在 B"。
 *
 * 上游源码就在本仓库里，所以默认 A 是**本仓库自己的** `spec/swagger.json`（= 我们
 * fork 的上游基线），默认 B 是部署实例。"源码里有这个接口"不等于"它能用"——
 * 三层事实源的分工见 memoh-ios-dev.md §4.5。
 *
 *   node tools/spec-drift.mjs                       # 本仓库的 spec vs 部署实例
 *   node tools/spec-drift.mjs --a <路径|URL> --b <路径|URL>
 *   node tools/spec-drift.mjs --full                # 打印全部差异路径
 *
 * 比部署实例（走隧道，只读）：
 *   node tools/spec-drift.mjs --b http://127.0.0.1:18080/api/swagger.json
 *
 * 比 fork 的检出（fork 在服务器上，本地没有副本）：
 *   ssh vultr-sg "cat /opt/memoh-dev/src/spec/swagger.json" > /tmp/fork-swagger.json
 *   node tools/spec-drift.mjs --a /tmp/fork-swagger.json --b http://127.0.0.1:18080/api/swagger.json
 *
 * 退出码：有漂移为 1，两边一致为 0。只读，不改任何东西。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 默认 A = 本仓库的 spec（脚本在 tools/ 下，所以往上走一层）。
const DEFAULT_A = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec', 'swagger.json');
const DEFAULT_B = 'http://127.0.0.1:18080/api/swagger.json';

function parseArgs(argv) {
  const options = { a: DEFAULT_A, b: DEFAULT_B, full: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--a') options.a = argv[index + 1];
    if (argv[index] === '--b') options.b = argv[index + 1];
    if (argv[index] === '--full') options.full = true;
  }
  return options;
}

/** swag 生成的 doc 有时带尾逗号（部署实例上就出现过），严格解析失败时退一步。 */
function parseSpec(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const relaxed = text.replace(/,(\s*[}\]])/g, '$1');
    try {
      return JSON.parse(relaxed);
    } catch {
      throw new Error(`${label} 不是合法的 swagger JSON：${error.message}`);
    }
  }
}

async function loadSpec(source) {
  if (/^https?:/.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`${source} 返回 HTTP ${response.status}`);
    return { spec: parseSpec(await response.text(), source), label: `${source}（部署实例）` };
  }
  return { spec: parseSpec(readFileSync(source, 'utf8'), source), label: `${source}（本地副本）` };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [sideA, sideB] = [await loadSpec(options.a), await loadSpec(options.b)];
  const pathsA = new Set(Object.keys(sideA.spec.paths ?? {}));
  const pathsB = new Set(Object.keys(sideB.spec.paths ?? {}));
  const onlyA = [...pathsA].filter((path) => !pathsB.has(path)).sort();
  const onlyB = [...pathsB].filter((path) => !pathsA.has(path)).sort();

  console.log(`A = ${sideA.label}  ${pathsA.size} 条路径`);
  console.log(`B = ${sideB.label}  ${pathsB.size} 条路径`);
  for (const [sign, list, other] of [
    ['只在 A', onlyA, 'B'],
    ['只在 B', onlyB, 'A'],
  ]) {
    console.log(`\n${sign}（${list.length} 条）${list.length > 0 ? `，${other} 没有：` : ''}`);
    for (const path of options.full ? list : list.slice(0, 10)) console.log(`  ${path}`);
    if (!options.full && list.length > 10)
      console.log(`  …另有 ${list.length - 10} 条，用 --full 看全`);
  }

  const drifted = onlyA.length > 0 || onlyB.length > 0;
  console.log(
    `\n${drifted ? '⚠️ 两边不一致——判定"能不能用"要实测部署实例，别信源码' : '✅ 两边路径集合一致'}`,
  );
  console.log('口径提醒：路径集合只能证明"这个端点不存在"，不代表存在的那条在这个版本行为一致。');
  process.exit(drifted ? 1 : 0);
}

main().catch((error) => {
  console.error(`探测失败：${error.message}`);
  process.exit(2);
});
