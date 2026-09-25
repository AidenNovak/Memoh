#!/usr/bin/env node
/**
 * 用 **TS 客户端**（`apps/mobile/src/api/client.ts`）把 `api-fixtures/raw/` 里的原始响应
 * 规范化成 `api-fixtures/expected/`（golden）。
 *
 * ## 为什么是"生成"而不是"手写"
 *
 * golden 是"这一片行为对不对"的判据。手写 golden 等于把我**以为**客户端会做什么写成判据，
 * 于是实现和判据一起错，测试还是绿的。所以这里让**真客户端**去跑 raw：raw 是服务端发过
 * 的字节（见 `capture-raw.sh`），expected 是 TS 对它的规范化结果，两者都不是人写的。
 *
 * ## 怎么让真客户端跑一份"服务端已经发过的响应"
 *
 * 把全局 `fetch` 换成桩：不管客户端请求什么，都返回 `raw/<name>.json` 的字节。于是
 * `MemohClient` 走的是它自己的真实代码路径（拼 URL、发 query、解响应、跑规范化），
 * 只有"字节从哪来"这一件事被替换。这样生成出来的 golden 才是"TS 会怎么处理这份响应"，
 * 而不是"我以为 TS 会怎么处理"。
 *
 * 同时钉住一条不变量：**每个夹具必须真的触发一次 fetch**（`downloadTarget` 那种不发请求的
 * 方法混进来会让夹具静默失效——桩没被调用、expected 照样写出来，等于假通过）。
 *
 * ## 怎么跑
 *
 *   node --experimental-strip-types tools/gen-api-goldens.mjs
 *
 * node 22.20 的 `--experimental-strip-types` 能直接跑 `.ts` 源：`client.ts` 的 import 全是
 * `import type`，剥掉类型后不剩运行时依赖。运行时会打一条
 * `MODULE_TYPELESS_PACKAGE_JSON` 警告（因为 `apps/mobile/package.json` 没有 `"type": "module"`）
 * ——那条警告是预期的，**不要**去改 RN 的 package.json 来消它（本片不动 `apps/mobile/src/**`）。
 *
 * manifest 里 `source: "unavailable"` 的条目没有 raw、也不生成 expected：拿不到真响应时
 * 宁可少覆盖，也不许手编一份形状出来。生成器对"声明了有夹具却没有文件"会直接报错退出。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const fixturesDir = join(repoRoot, 'tools', 'api-fixtures');
const rawDir = join(fixturesDir, 'raw');
const expectedDir = join(fixturesDir, 'expected');

const { MemohClient } = await import(
  pathToFileURL(join(repoRoot, 'apps', 'mobile', 'src', 'api', 'client.ts')).href
);

/**
 * manifest 的 `call`（一个普通对象）→ 客户端方法的**位置参数**。
 *
 * 每个端点的参数形状不同（`listSessions(botId, {limit})`、`listFiles(botId, path)`、
 * `login(username, password)`），所以这里是一张显式表：多写几行，也不要"猜参数顺序"——
 * 猜错会让夹具打到一个不是它本意的端点上，然后照样"通过"。表里没有的 endpoint 直接抛错。
 */
const ARG_BUILDERS = {
  login: (a) => [a.username, a.password],
  me: () => [],
  listBots: () => [],
  listModels: () => [],
  listProviders: () => [],
  listSessions: (a) => [a.botId, { limit: a.limit, cursor: a.cursor }],
  getSession: (a) => [a.botId, a.sessionId],
  listMessages: (a) => [a.botId, a.sessionId, { limit: a.limit, beforeMessageId: a.beforeMessageId }],
  getSessionStatus: (a) => [a.botId, a.sessionId],
  sessionStatus: (a) => [a.botId, a.sessionId],
  getBotSettings: (a) => [a.botId],
  getContainer: (a) => [a.botId],
  getContainerMetrics: (a) => [a.botId],
  getDisplay: (a) => [a.botId],
  listBotChecks: (a) => [a.botId],
  listSkills: (a) => [a.botId],
  listFiles: (a) => [a.botId, a.path],
  readFile: (a) => [a.botId, a.path],
  statFile: (a) => [a.botId, a.path],
  listSchedules: (a) => [a.botId],
  getSchedule: (a) => [a.botId, a.scheduleId],
  listScheduleLogs: (a) => [a.botId, { limit: a.limit, offset: a.offset }],
  checkBotNameAvailability: (a) => [a.name, a.excludeBotId],
  getSessionQueue: (a) => [a.botId, a.sessionId],
  tokenUsage: (a) => [a.botId],
};

function argsFor(entry) {
  const build = ARG_BUILDERS[entry.endpoint];
  if (!build) {
    throw new Error(
      `${entry.name}: manifest 的 endpoint ${entry.endpoint} 在 gen-api-goldens.mjs 的 ` +
        `ARG_BUILDERS 里没有参数构造器——加夹具时也要加它，否则参数只能靠猜`,
    );
  }
  return build(entry.call ?? {});
}

/** 假 baseUrl：桩会吃掉所有请求，它只是为了让客户端把 URL 拼出来。 */
const FIXTURE_BASE_URL = 'http://fixture.invalid';

/**
 * 把 fetch 换成"只回一份预置字节"的桩，并记录调用次数。
 * 返回 `{ calls, restore }`——`calls` 用来钉"夹具真的走了一次网络路径"。
 */
function stubFetch(body, status) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET' });
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const manifest = JSON.parse(readFileSync(join(fixturesDir, 'manifest.json'), 'utf8'));
if (!Array.isArray(manifest)) throw new Error('manifest.json 必须是数组');
if (manifest.length === 0) throw new Error('manifest.json 是空的：没有夹具等于没有这一层验证');

mkdirSync(expectedDir, { recursive: true });

const rows = [];
const problems = [];
let generated = 0;

for (const entry of manifest) {
  const { name, source } = entry;
  if (!name) throw new Error(`manifest 条目缺 name：${JSON.stringify(entry)}`);

  if (source === 'unavailable') {
    // 明确标注拿不到真响应的端点：不许有夹具，也不生成 expected。
    if (existsSync(join(rawDir, `${name}.json`))) {
      problems.push(`${name}: 标了 source=unavailable 却存在 raw/${name}.json——两者必须一致`);
    }
    rows.push({ name, method: '—', bytes: '—', note: 'unavailable（无夹具）' });
    continue;
  }
  if (source !== 'dev-instance') {
    throw new Error(`${name}: source 只能是 "dev-instance" 或 "unavailable"，实际是 ${JSON.stringify(source)}`);
  }

  const rawPath = join(rawDir, `${name}.json`);
  if (!existsSync(rawPath)) {
    problems.push(`${name}: 声明有夹具但 raw/${name}.json 不存在（先跑 capture-raw.sh，别手编）`);
    continue;
  }
  if (typeof entry.endpoint !== 'string' || entry.endpoint === '') {
    throw new Error(`${name}: 缺 endpoint（方法名，与 tools/test-api-contract.swift 的派发一致）`);
  }

  const rawText = readFileSync(rawPath, 'utf8');
  const client = new MemohClient({ baseUrl: FIXTURE_BASE_URL, getToken: () => 'fixture-token' });
  // `endpoint` 是**方法名**（`listBots` / `getSessionStatus`…），`call` 是它的参数。
  // 与 Swift 契约测试（tools/test-api-contract.swift 的 normalizedJSON）同一套约定：
  // 两个消费方读同一份清单，加夹具时不会出现"一边认这个字段、一边认那个字段"。
  const method = client[entry.endpoint];
  if (typeof method !== 'function') {
    throw new Error(`${name}: TS 客户端没有 ${entry.endpoint}() —— manifest 和客户端对不上了`);
  }

  const stub = stubFetch(rawText, entry.status ?? 200);
  let result;
  try {
    result = await method.call(client, ...argsFor(entry));
  } finally {
    stub.restore();
  }

  if (stub.calls.length !== 1) {
    problems.push(`${name}: 期望恰好 1 次 fetch，实际 ${stub.calls.length} 次（夹具没有真的走客户端）`);
  }

  // TS 的 `undefined`（204 / 空体）在 JSON 里只能写成 null：golden 必须能被 JSON 承载，
  // 而且要显式写出来——"文件不存在"和"结果是空"是两件事。
  const payload = result === undefined ? null : result;
  const text = JSON.stringify(payload, null, 2) + '\n';
  writeFileSync(join(expectedDir, `${name}.json`), text);
  generated += 1;
  rows.push({
    name,
    method: entry.endpoint,
    bytes: `${text.length}`,
    note: payload === null ? '空响应 → null' : '',
  });
}

const width = Math.max(...rows.map((r) => r.name.length));
for (const row of rows) {
  console.log(`  ${row.name.padEnd(width)}  ${row.method.padEnd(22)} ${row.bytes.padStart(6)}  ${row.note}`);
}
console.log(`\n生成 ${generated} 份 golden（${rows.length - generated} 条标注为 unavailable，跳过）`);

if (problems.length > 0) {
  console.error('\n夹具问题：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
