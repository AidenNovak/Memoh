/**
 * bot 设置页「运行检查」这一组的**可见内容**。
 *
 * ## 为什么不能把服务端的话直接倒到屏幕上
 *
 * 服务端 `/bots/{id}/checks` 返回的是**给运维和桌面端看**的原始读数，实测长这样
 * （2026-09-17，dev 环境那台 bot）：
 *
 * ```json
 * { "id": "container.record", "type": "container.record", "status": "ok",
 *   "summary": "Workspace runtime record exists.",
 *   "detail": "runtime_id=workspace-c904ca2a-c419-4ee9-9644-5de5afa63008" }
 * ```
 *
 * 上一版把 `summary` / `detail` / `status` 三样原样摊进设置行的三列，于是真机截图上是
 * 一列 `ok`、一串测试用例口吻的句子、以及 `runtime_id=` `status=` 这种内部标识符。
 * 这不是排版问题，是**开发输出泄漏到界面上**（判据：`docs/research/ios-error-and-feedback.md`
 * 的 R23「绝不能把面向开发者的东西直接倒给用户」、R45「原文只有带着类型化 code 时才当补充
 * 说明上屏」、R47「技术细节默认收起，但要留着」）。
 *
 * 所以这一层统一做三件事：
 *
 * 1. **认得的类型 → 我们自己的文案**（`botSettings.checks.item.*`，中英都写），一眼是
 *    "能用 / 不能用"，不是"某句话的原文"；
 * 2. **认不出的类型 → 服务端那句话只有在"干净"（不含 `key=value`、id、`title_key` 这类
 *    形状）时才当说明**；不干净就用我们的兜底句，原文一个字不上主视图；
 * 3. **原文一律收进技术细节**（`key=value`、容器 id、模型 id、metadata 全在里面，可复制）。
 *    自托管部署的运维就是用户本人，他需要那个标识去查自己的日志——所以是**收起来**，不是删掉。
 *
 * ## 折叠的语义
 *
 * 默认只有一行汇总（"5 项检查全部正常" / "有 1 项需要注意"），展开才看明细，技术细节要再
 * 展开一次。`lines` / `technical` 由本函数按 `expanded` / `detailsOpen` 直接切好——**屏幕
 * 只负责画**，于是"默认折叠"这件事是可断言的（不用渲染一棵树就能红）。
 *
 * ## 状态的画法
 *
 * 符号 + 文字，**不吃颜色语义**（R27/R31）：`✓` / `⚠` / `✕` / `·` 四档，颜色只是第二遍强化。
 */
import type { BotCheck } from '../../api/types.ts';

/** 一行检查的语气（决定符号与颜色档）。 */
export type CheckTone = 'ok' | 'warn' | 'bad' | 'unknown';

/** 状态符号。用文本符号而不是图标：与 `BotCreateProgressScreen` 的阶段行同一套画法。 */
export const CHECK_GLYPH: Record<CheckTone, string> = {
  ok: '✓',
  warn: '⚠',
  bad: '✕',
  unknown: '·',
};

/** 汇总行/明细行的标题色档（由屏幕翻成 palette 里的具体颜色）。 */
export type CheckColorRole = 'success' | 'warning' | 'destructive' | 'secondaryLabel';

export const CHECK_COLOR_ROLE: Record<CheckTone, CheckColorRole> = {
  ok: 'success',
  warn: 'warning',
  bad: 'destructive',
  unknown: 'secondaryLabel',
};

export interface CheckLine {
  /** 断言用（`bot-check-<服务端 id>`）。服务端 id 只在这里出现，不进文案。 */
  testID: string;
  tone: CheckTone;
  glyph: string;
  /** 发生了什么（人话）。 */
  title: string;
  /** 下一步（只有需要注意的项才有；照 R13/R14 的三段式）。 */
  action?: string;
}

export interface CheckTechnicalLine {
  testID: string;
  /** 服务端原值（含内部标识符），技术细节里**原样**保留。 */
  text: string;
}

export interface ChecksPanel {
  tone: CheckTone;
  glyph: string;
  /** 汇总行：折叠时唯一可见的一行。 */
  title: string;
  /** 折叠时的补充（"点开看是哪个"）。 */
  hint?: string;
  total: number;
  /** 与服务端 `check_issue_count` 同口径：`warn` + `error`。 */
  issueCount: number;
  hasIssues: boolean;
  /** 用户是否展开了明细（屏幕用它决定提示语与"最后一行是谁"）。 */
  expanded: boolean;
  /** 展开后可见的明细（折叠时是空数组）。 */
  lines: CheckLine[];
  /** 展开 + 再展开技术细节后可见的原文（否则空数组）。 */
  technical: CheckTechnicalLine[];
  /** 有未通过的项时的"重新检查"动作（折叠时不给——折叠态只有一行）。 */
  recheck?: { testID: string; label: string };
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * 服务端类型 → 我们的文案族。
 *
 * 这份清单对着服务端源码核过（`internal/bots/service.go` 的 `buildRuntimeChecks` 与
 * `internal/healthcheck/checkers/{model,mcp,channel}`）：内置四条 `container.*`、模型探针
 * `model.connection`、MCP `mcp.connection`、渠道 `channel.connection`、删除中的 `bot.delete`。
 * 认不出的走兜底（见 `fallbackTitle`）——新类型上线的第一晚不该在手机上显示一串英文原文。
 */
type CheckFamily =
  'init' | 'record' | 'task' | 'reachable' | 'model' | 'mcp' | 'channel' | 'delete';

const CHECK_FAMILY: Record<string, CheckFamily> = {
  'container.init': 'init',
  'container.record': 'record',
  'container.task': 'task',
  'container.data_path': 'reachable',
  'model.connection': 'model',
  'mcp.connection': 'mcp',
  'channel.connection': 'channel',
  'bot.delete': 'delete',
};

/** 模型探针的槽位名（服务端的 `subtitle` 是 "Chat Model" 这种英文原文，不上屏）。 */
type ModelSlot = 'chat' | 'memory' | 'embedding';

const MODEL_SLOT: Record<string, ModelSlot> = {
  chat: 'chat',
  memory: 'memory',
  embedding: 'embedding',
};

/** 服务端状态 → 我们的语气。 */
const CHECK_TONE: Record<string, CheckTone> = {
  ok: 'ok',
  warn: 'warn',
  error: 'bad',
  // `failed` 不在服务端的枚举里，但旧服务端可能用它表示
  // 同一档，而切换器上的文案是"未通过"。两种写法都认，别只认其中一种。
  failed: 'bad',
  unknown: 'unknown',
};

/**
 * 「这段文字像不像给开发看的东西」。
 *
 * 用它决定**认不出类型的服务端原文**能不能当说明上屏。四类形状：`key=value`、
 * 容器/模型 id、`title_key` 字面量、裸的状态枚举。命中就用我们自己的兜底句。
 */
const INTERNAL_SHAPES = [
  /[A-Za-z_][A-Za-z0-9_]{2,}=/,
  /workspace-[0-9a-f]{6,}/i,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /bots\.checks\./,
  /^(ok|warn|error|failed|unknown)$/i,
];

export function looksInternal(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return true;
  return INTERNAL_SHAPES.some((shape) => shape.test(trimmed));
}

function stripTrailingPeriod(text: string): string {
  return text.trim().replace(/[.。]+$/, '');
}

/** 语气 → 文案后缀（`botSettings.checks.item.<family>.<suffix>`）。 */
const SUFFIX: Record<CheckTone, string> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'bad',
  unknown: 'unknown',
};

/** 需要注意的语气 → 下一步那句话。照 R19：只有用户做了有用的事才给动作。 */
const FAMILY_ACTION: Record<CheckFamily, string> = {
  init: 'botSettings.checks.action.recheck',
  record: 'botSettings.checks.action.recheck',
  task: 'botSettings.checks.action.recheck',
  reachable: 'botSettings.checks.action.recheck',
  // 模型这一档用户**在手机上就能修**：下面「对话」那一组里就能换模型。
  model: 'botSettings.checks.action.model',
  // MCP 与渠道是桌面端才配得动的东西，手机上只说"去哪看"。
  mcp: 'botSettings.checks.action.desktop',
  channel: 'botSettings.checks.action.desktop',
  delete: 'botSettings.checks.action.recheck',
};

const OTHER_ACTION = 'botSettings.checks.action.details';

/**
 * 一条检查 → 明细行。
 *
 * `t` 由调用方给（i18n 的语言是运行时可切的），所以这里不 import 任何 i18n 运行时。
 */
function lineFor(check: BotCheck, t: Translate): CheckLine {
  const tone = toneOf(check.status);
  const family = CHECK_FAMILY[check.type.trim()];
  const testID = `bot-check-${check.id}`;
  const glyph = CHECK_GLYPH[tone];

  if (family === undefined) {
    const title = fallbackTitle(check, tone, t);
    return { testID, tone, glyph, title, action: actionUnder(tone, OTHER_ACTION, t) };
  }

  if (family === 'model') {
    const slot = modelSlotOf(check);
    const name = t(`botSettings.checks.model.${slot}`);
    return {
      testID,
      tone,
      glyph,
      title: t(`botSettings.checks.item.model.${SUFFIX[tone]}`, { name }),
      action: actionUnder(tone, FAMILY_ACTION.model, t),
    };
  }

  const key = `botSettings.checks.item.${family}.${SUFFIX[tone]}`;
  return {
    testID,
    tone,
    glyph,
    title: t(key),
    action: actionUnder(tone, FAMILY_ACTION[family], t),
  };
}

/** 只有"需要注意"的两档才给下一步；正常与还没结果的项不摆动作。 */
function actionUnder(tone: CheckTone, key: string, t: Translate): string | undefined {
  if (tone === 'ok' || tone === 'unknown') return undefined;
  return t(key);
}

/**
 * 认不出类型时写什么。
 *
 * 服务端那句话是**干净**的（不含内部标识符）才当说明用；否则退回我们自己的兜底句——
 * 主视图上宁可少说一句，也不把 `probe failed: dial tcp 10.0.0.9:443` 摆给用户。
 */
function fallbackTitle(check: BotCheck, tone: CheckTone, t: Translate): string {
  const summary = stripTrailingPeriod(check.summary ?? '');
  if (!looksInternal(summary)) return summary;
  return t(`botSettings.checks.item.other.${SUFFIX[tone]}`);
}

function toneOf(status: string): CheckTone {
  return CHECK_TONE[status.trim().toLowerCase()] ?? 'unknown';
}

/** 模型探针是哪一档：先看 `metadata.role`，再看 id 的后缀，最后当聊天模型。 */
function modelSlotOf(check: BotCheck): ModelSlot {
  const fromMetadata = check.metadata?.['role'];
  if (typeof fromMetadata === 'string') {
    const slot = MODEL_SLOT[fromMetadata.trim().toLowerCase()];
    if (slot !== undefined) return slot;
  }
  const suffix = check.id.split('.').pop() ?? '';
  const slot = MODEL_SLOT[suffix.trim().toLowerCase()];
  return slot ?? 'chat';
}

/** 汇总行的语气：有未通过就以它为准（error 压 warn）。 */
function summaryTone(
  issueCount: number,
  errorCount: number,
  unknownCount: number,
  total: number,
): CheckTone {
  if (issueCount > 0) return errorCount > 0 ? 'bad' : 'warn';
  if (total > 0 && unknownCount === total) return 'unknown';
  if (total === 0) return 'unknown';
  return 'ok';
}

function summaryTitle(
  tone: CheckTone,
  counts: { total: number; issueCount: number },
  t: Translate,
): string {
  if (counts.total === 0) return t('botSettings.checks.summary.none');
  if (counts.issueCount > 0) {
    // 与切换器上那句 `bots.issue`（"有 N 项检查未通过"）**同一句话**：同一个数字在
    // 两个地方说成两件事，用户会以为是两批检查。
    return t('bots.issue', { count: counts.issueCount });
  }
  if (tone === 'unknown') return t('botSettings.checks.summary.pending');
  return t('botSettings.checks.summary.ok', { count: counts.total });
}

/**
 * 技术细节的一行：**原文原样**（服务端 id / 状态 / 副标题 / summary / detail / metadata）。
 *
 * 这里不翻译、不删减、不脱敏——它的用途就是排障与反馈（R47），用户要能把它复制出去。
 */
function technicalTextFor(check: BotCheck): string {
  const parts = [check.id.trim(), check.status.trim()];
  if (check.subtitle !== undefined && check.subtitle.trim() !== '')
    parts.push(check.subtitle.trim());
  if (check.summary !== undefined && check.summary.trim() !== '') parts.push(check.summary.trim());
  if (check.detail !== undefined && check.detail.trim() !== '') parts.push(check.detail.trim());
  const metadata = check.metadata;
  if (metadata !== undefined) {
    for (const [key, value] of Object.entries(metadata)) {
      const pair = `${key}=${String(value)}`;
      // `metadata` 经常和服务端已经写在 `detail` 里的东西重复（实测：`detail` 是
      // `status=running`，`metadata.status` 也是 running）。同一行里说两遍会让人以为
      // 是两个不同的值，所以重复的丢掉。
      if (!parts.includes(pair)) parts.push(pair);
    }
  }
  return parts.join(' · ');
}

/**
 * 技术细节的全部原文（一行一条，直接可以复制出去）。
 *
 * 导出它是为了让屏幕的"复制"动作**只有一份实现**：屏幕上画的那几行与复制走的是同一个
 * 函数，不会出现"看到三条、复制到五条"这种事后才发现的偏差。
 */
export function checksTechnicalText(checks: readonly BotCheck[]): string {
  return checks.map((check) => technicalTextFor(check)).join('\n');
}

/**
 * 这一组在屏幕上的样子。
 *
 * `expanded` / `detailsOpen` 是**用户意图**（屏幕自己持有的 state），不是从数据推出来的：
 * 一次刷新（重试/重新检查）不许把用户点开的细节合上（R51 的 JS 侧同一条纪律）。
 */
export function checksPanel(input: {
  checks: readonly BotCheck[];
  expanded: boolean;
  detailsOpen: boolean;
  t: Translate;
}): ChecksPanel {
  const { checks, expanded, detailsOpen, t } = input;
  const issueCount = checks.filter(
    (check) => toneOf(check.status) === 'warn' || toneOf(check.status) === 'bad',
  ).length;
  const errorCount = checks.filter((check) => toneOf(check.status) === 'bad').length;
  const unknownCount = checks.filter((check) => toneOf(check.status) === 'unknown').length;
  const tone = summaryTone(issueCount, errorCount, unknownCount, checks.length);
  const hasIssues = issueCount > 0;

  return {
    tone,
    glyph: CHECK_GLYPH[tone],
    title: summaryTitle(tone, { total: checks.length, issueCount }, t),
    // 折叠时唯一能点的那一行要说清"点开有什么"——否则用户不知道那一条失败藏在哪。
    hint: hasIssues && !expanded ? t('botSettings.checks.issuesHint') : undefined,
    total: checks.length,
    issueCount,
    hasIssues,
    expanded,
    lines: expanded ? checks.map((check) => lineFor(check, t)) : [],
    technical:
      expanded && detailsOpen
        ? checks.map((check) => ({
            testID: `bot-checks-technical-${check.id}`,
            text: technicalTextFor(check),
          }))
        : [],
    recheck:
      expanded && hasIssues
        ? { testID: 'bot-checks-recheck', label: t('botSettings.checks.recheck') }
        : undefined,
  };
}
