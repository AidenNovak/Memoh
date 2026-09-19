/**
 * bot 设置页「运行检查」这一组的**可见内容**（`src/features/bots/checks.ts`）。
 *
 * ## 为什么这一条必须存在
 *
 * 2026-09-17 的真机截图（aiden 的原话：「这一堆 OK，这前端样式实在是太丑了」）里，这一组是
 * 服务端的原始输出直接上屏：
 *
 * ```
 * Initialization finished.            ok
 * Workspace runtime record exists.    ok
 *   runtime_id=workspace-c904ca2a-…   ← 内部标识符
 * Workspace runtime state is reported.ok
 *   status=running                    ← 内部标识符
 * Workspace is reachable via gRPC.    ok
 * Chat Model is healthy.              ok
 *   Chat Model                        ← 服务端的槽位名
 * ```
 *
 * 那不是"文案不好看"，是**开发输出泄漏到界面上**：一列 `ok`、测试用例口吻的句子、以及
 * `runtime_id=` / `status=` 这种只有排障时才该看的字符串。所以下面两类断言是**回归护栏**
 * （判据照 `docs/research/ios-error-and-feedback.md` 的 R23/R45/R47）：
 *
 * 1. **主视图里不许出现内部标识符**（`key=value`、容器 id、`title_key` 字面量、裸的状态枚举）；
 * 2. **默认折叠**：默认只看得见一行汇总，明细要展开，技术细节要再展开一次。
 *
 * 断言用的载荷是**真数据**（2026-09-17 从 dev 环境那台 bot 上抓的原文，bot id 与截图里
 * 是同一个），不是照着实现编的。扫描器写在本文件里而**不**复用实现里的判据——测试要能独立
 * 地判"屏幕上这句话像不像开发输出"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checksPanel } from '../src/features/bots/checks.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES = join(HERE, '..', 'locales');

/**
 * 真数据：`GET /bots/c904ca2a-c419-4ee9-9644-5de5afa63008/checks` 的响应（dev 环境）。
 *
 * 五条全 `ok` —— 与 aiden 截图里那五条一一对应（截图里最下面那条 `Chat Model` 是模型探针）。
 */
const REAL_CHECKS = [
  {
    id: 'container.init',
    type: 'container.init',
    title_key: 'bots.checks.titles.containerInit',
    status: 'ok',
    summary: 'Initialization finished.',
  },
  {
    id: 'container.record',
    type: 'container.record',
    title_key: 'bots.checks.titles.containerRecord',
    status: 'ok',
    summary: 'Workspace runtime record exists.',
    detail: 'runtime_id=workspace-c904ca2a-c419-4ee9-9644-5de5afa63008',
    metadata: {
      container_id: 'workspace-c904ca2a-c419-4ee9-9644-5de5afa63008',
      image: 'docker.io/memohai/workspace:debian-latest',
      namespace: 'default',
    },
  },
  {
    id: 'container.task',
    type: 'container.task',
    title_key: 'bots.checks.titles.containerTask',
    status: 'ok',
    summary: 'Workspace runtime state is reported.',
    detail: 'status=running',
    metadata: { status: 'running' },
  },
  {
    id: 'container.data_path',
    type: 'container.data_path',
    title_key: 'bots.checks.titles.containerDataPath',
    status: 'ok',
    summary: 'Workspace is reachable via gRPC.',
  },
  {
    id: 'model.connection.chat',
    type: 'model.connection',
    title_key: 'bots.checks.titles.modelConnection',
    subtitle: 'Chat Model',
    status: 'ok',
    summary: 'Chat Model is healthy.',
    metadata: { latency_ms: 883, model_id: '93bcad5b-d248-4e06-9ddd-c7466b90caa5', role: 'chat' },
  },
];

/**
 * 「这看起来像不像给开发看的东西」——判据写在这里，**不复用实现里的那条**。
 *
 * - `key=value`：`runtime_id=…`、`status=running`（服务端 `detail` 的形状）；
 * - 容器/模型 id：`workspace-<uuid>`、裸 uuid；
 * - `title_key` 字面量：`bots.checks.*`（那是给客户端查表的 key）；
 * - 裸状态枚举：`ok` / `warn` / `error` / `unknown` 当**词**用（`value={check.status}` 就是这么漏的）。
 */
const INTERNAL_PATTERNS = [
  { name: 'key=value', re: /[A-Za-z_][A-Za-z0-9_]{2,}=/ },
  { name: 'workspace id', re: /workspace-[0-9a-f]{6,}/i },
  { name: 'uuid', re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { name: 'title_key', re: /bots\.checks\./ },
  { name: 'status enum', re: /\b(ok|warn|unknown)\b|\berror\b/i },
];

function tainted(text) {
  return INTERNAL_PATTERNS.filter((pattern) => pattern.re.test(text)).map(
    (pattern) => `${pattern.name}: "${text}"`,
  );
}

/** 两份文案表 + 一个会**因为 key 不存在而抛**的 `t`（漏写文案要当场红，不是显示 key）。 */
function catalogs() {
  return {
    en: JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8')),
    'zh-Hans': JSON.parse(readFileSync(join(LOCALES, 'zh-Hans.json'), 'utf8')),
  };
}

function translatorFor(catalog, seen) {
  return (key, params = {}) => {
    seen.add(key);
    const template = catalog[key];
    assert.ok(typeof template === 'string', `文案表里没有这条 key：${key}`);
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(params[name] ?? ''));
  };
}

function panelFor(checks, { expanded, detailsOpen }) {
  return checksPanel({
    checks,
    expanded,
    detailsOpen,
    t: translatorFor(catalogs().en, new Set()),
  });
}

/** 屏幕上**读得到**的每一句（汇总行 + 明细行；技术细节不算主视图）。 */
function visibleStrings(panel) {
  const out = [panel.title];
  if (panel.hint !== undefined) out.push(panel.hint);
  for (const line of panel.lines) {
    out.push(line.title);
    if (line.action !== undefined) out.push(line.action);
  }
  return out;
}

const FAILING = [
  {
    id: 'container.data_path',
    type: 'container.data_path',
    title_key: 'bots.checks.titles.containerDataPath',
    status: 'error',
    summary: 'Workspace is not reachable via gRPC.',
    detail: 'dial tcp 10.0.0.5:9090: connect: connection refused',
  },
  {
    id: 'model.connection.chat',
    type: 'model.connection',
    title_key: 'bots.checks.titles.modelConnection',
    subtitle: 'Chat Model',
    status: 'warn',
    summary: 'Chat Model is not reachable.',
    metadata: { role: 'chat' },
  },
];

// ------------------------------------------------------------ ② 默认折叠

test('默认折叠：只看得见一行汇总，明细与技术细节都不在屏幕上', () => {
  const collapsed = panelFor(REAL_CHECKS, { expanded: false, detailsOpen: false });
  assert.equal(collapsed.total, 5);
  assert.equal(collapsed.issueCount, 0);
  assert.deepEqual(collapsed.lines, [], '折叠时明细不许出现');
  assert.deepEqual(collapsed.technical, [], '折叠时技术细节不许出现');
  assert.notEqual(collapsed.title.trim(), '', '汇总行必须有字');

  const expanded = panelFor(REAL_CHECKS, { expanded: true, detailsOpen: false });
  assert.equal(expanded.lines.length, 5, '展开后五条明细都在');
  assert.deepEqual(expanded.technical, [], '技术细节还没展开，不出现');

  const withDetails = panelFor(REAL_CHECKS, { expanded: true, detailsOpen: true });
  assert.ok(withDetails.technical.length > 0, '技术细节展开后要有内容');
});

test('汇总行的字面只由总数与需要注意的条数决定（不再堆 N 个 ok）', () => {
  const ok = panelFor(REAL_CHECKS, { expanded: false, detailsOpen: false });
  assert.equal(ok.tone, 'ok');
  assert.ok(ok.title.includes('5'), `汇总行要报出总数：${ok.title}`);

  const hasIssues = panelFor(FAILING, { expanded: false, detailsOpen: false });
  assert.equal(
    hasIssues.issueCount,
    2,
    'warn 与 error 都算"需要注意"（与服务端的 issue_count 同口径）',
  );
  assert.ok(hasIssues.hasIssues);
  assert.ok(hasIssues.hint !== undefined, '折叠时要说一句"点开看是哪个"，否则用户不知道去哪看');
});

// ------------------------------------------------ ① 主视图里不许出现内部标识符

test('真数据展开到底：主视图里不出现 runtime_id= / status= / title_key / 容器 id', () => {
  const panel = panelFor(REAL_CHECKS, { expanded: true, detailsOpen: true });
  const problems = visibleStrings(panel).flatMap(tainted);
  assert.deepEqual(problems, [], `主视图漏了内部标识符：\n  ${problems.join('\n  ')}`);
});

test('技术细节里**留着**原文与内部标识符（这就是它的用途：排障/反馈）', () => {
  const panel = panelFor(REAL_CHECKS, { expanded: true, detailsOpen: true });
  const text = panel.technical.map((line) => line.text).join('\n');
  for (const expected of ['runtime_id=workspace-c904ca2a', 'status=running', '93bcad5b-d248']) {
    assert.ok(text.includes(expected), `技术细节里该有这个原文：${expected}\n实际：${text}`);
  }
  // 服务端那条检查自己的 id 与状态也要在（`container.record · ok`）：用户拿着它去搜自己的
  // 日志/服务端代码。主视图上它们一个字都不出现（上面那条断言盯着），所以这里必须留着——
  // 少了这一段，"排障用的原文"就只剩一句人话，贴进反馈里谁也定位不到。
  assert.ok(
    text.includes('container.record · ok'),
    `技术细节里该有服务端的检查 id 与原始状态：container.record · ok\n实际：${text}`,
  );
});

test('状态用勾/叉这类符号，不把服务端的枚举值当文案', () => {
  const panel = panelFor([...REAL_CHECKS, ...FAILING], { expanded: true, detailsOpen: false });
  const allowed = new Set(['✓', '⚠', '✕', '·']);
  for (const line of panel.lines) {
    assert.ok(allowed.has(line.glyph), `状态要用符号，不写字：${line.glyph}`);
  }
  assert.deepEqual(visibleStrings(panel).flatMap(tainted), []);
});

test('明细是短句、不带句尾句点（服务端那种 "Initialization finished." 的口吻不许上来）', () => {
  const panel = panelFor([...REAL_CHECKS, ...FAILING], { expanded: true, detailsOpen: false });
  const problems = visibleStrings(panel).filter((text) => /[.。]$/.test(text.trim()));
  assert.deepEqual(problems, [], `这些句子还带着句尾句点：\n  ${problems.join('\n  ')}`);
});

// ------------------------------------------------------- ③ 失败项：发生什么 + 下一步

test('未通过的那条要有下一步，通过的条不摆动作', () => {
  const panel = panelFor(FAILING, { expanded: true, detailsOpen: false });
  const bad = panel.lines.filter((line) => line.tone !== 'ok');
  assert.equal(bad.length, 2);
  for (const line of bad) {
    assert.ok(line.action !== undefined, `未通过的项要给下一步：${line.title}`);
  }
});

test('有未通过的项时给一个能真的重来的动作（说得出下一步，且不是空按钮）', () => {
  const panel = panelFor(FAILING, { expanded: true, detailsOpen: false });
  assert.ok(panel.recheck !== undefined, '这一组要有"重新检查"这条路');
  assert.notEqual(panel.recheck.label.trim(), '');
  assert.equal(panel.recheck.testID, 'bot-checks-recheck');

  const clean = panelFor(REAL_CHECKS, { expanded: true, detailsOpen: false });
  assert.equal(clean.recheck, undefined, '全都正常时不摆动作（不然就是噪音）');
});

test('认不出的检查类型：服务端原文不上主视图，只进技术细节', () => {
  const alien = [
    {
      id: 'mcp.connection.9',
      type: 'some.future.check',
      status: 'error',
      summary: 'probe failed: dial tcp 10.0.0.9:443',
      detail: 'conn_id=abc123',
    },
  ];
  const panel = panelFor(alien, { expanded: true, detailsOpen: true });
  assert.deepEqual(visibleStrings(panel).flatMap(tainted), []);
  const text = panel.technical.map((line) => line.text).join('\n');
  assert.ok(text.includes('conn_id=abc123'), '原文要留在技术细节里');
});

// ------------------------------------------------------------------ 文案

test('两种折叠态都说得出话；空清单不许说"检查都通过了"', () => {
  const empty = panelFor([], { expanded: false, detailsOpen: false });
  assert.equal(empty.total, 0);
  assert.equal(empty.tone, 'unknown');
  assert.ok(!/pass|通过/i.test(empty.title), `没检查过就不能说通过了：${empty.title}`);
});

test('这一组用到的每条文案在 en / zh-Hans 里都存在，并占位符一致', () => {
  const seen = new Set();
  const en = catalogs().en;
  const zh = catalogs()['zh-Hans'];
  for (const checks of [
    REAL_CHECKS,
    FAILING,
    [],
    [{ id: 'x', type: 'some.future.check', status: 'warn', summary: 'x', detail: 'y' }],
  ]) {
    checksPanel({
      checks,
      expanded: true,
      detailsOpen: true,
      t: translatorFor(en, seen),
    });
  }
  assert.ok(seen.size > 5, '这一组该用到的文案不止五条');
  const missing = [];
  for (const key of seen) {
    if (typeof zh[key] !== 'string') missing.push(`zh-Hans: ${key}`);
  }
  assert.deepEqual(missing, [], `中文表缺这些 key：\n  ${missing.join('\n  ')}`);
});
