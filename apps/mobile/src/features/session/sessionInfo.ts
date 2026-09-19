/**
 * 会话信息的**显示规则**（纯逻辑）。
 *
 * ## 为什么单开一个模块
 *
 * 这里最要紧的一条是"**不要编数**"。会话信息面板要回答的是"还要多久撞上下文上限"，
 * 而那个答案必须由**服务端给的窗口**做分母；这台部署（memohai/server 8/30 镜像）
 * 实测不给窗口——`GET …/status` 只回 `used_tokens`，模型配置里也没有
 * `context_window`。
 *
 * 没有窗口时算百分比就是在编：`used / 猜的窗口` 会给出一个看起来精确、实际没有
 * 依据的数。桌面端在同样的缺失下也确实不显示百分比（`session-context-view.ts`
 * 把 `contextWindow` 留成 null，只有 `contextPercent` 有分母时才算）。这里照同一条
 * 规则：**有分母才给百分比，没有就只报绝对值**。
 *
 * 上游较新的版本会给 `context_window` / `budget_plan`，那时同一套代码会自动开始
 * 显示百分比——不需要改界面。
 */

import type { SessionStatus } from '../../models/chat.ts';

export interface SessionInfoView {
  /** 服务端给的窗口大小；`null` = 这次拿不到（不是 0）。 */
  contextWindow: number | null;
  /** 已用 token（绝对值，一定可显示）。 */
  usedTokens: number;
  /** 有分母才算；没有分母就是 `null`。 */
  contextPercent: number | null;
  /** 自动压缩阈值（服务端给了才算）。 */
  autoCompactTokens: number | null;
  /** cache 命中率（0-100）；服务端没给就是 `null`。 */
  cacheHitRate: number | null;
  cacheReadTokens: number | null;
  totalInputTokens: number | null;
  messageCount: number | null;
  /** 这次会话用过的技能名（可能为空；空 = 服务端说"没用过"或没这个字段）。 */
  skills: string[];
}

/**
 * 只接受**正数**。0、负数、NaN、非数字都当作"没给"。
 *
 * 为什么不用 `?? `：服务端可能给 0（字段存在但值为 0），而 0 作为窗口是个没有
 * 意义的除数（会算出 Infinity）；作为 token 数则和"没给"要分开处理。
 */
function positive(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** 非负数（0 有意义：比如命中率 0%）。 */
function nonNegative(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export function sessionInfoView(status: SessionStatus | null): SessionInfoView {
  const usage = status?.context_usage;
  const cache = status?.cache_stats;

  // 窗口的优先级照桌面端：这一轮实际跑的窗口（budget_plan）优先于解析出的模型
  // 窗口——"这一轮按多大的窗口跑的"比"模型理论上多大"更该做分母。
  const planWindow = positive(usage?.budget_plan?.window);
  const contextWindow = planWindow ?? positive(usage?.context_window);

  const usedTokens = nonNegative(usage?.used_tokens) ?? 0;
  const compaction = usage?.compaction;
  const autoCompactTokens = compaction?.enabled === true ? positive(compaction.auto_tokens) : null;

  return {
    contextWindow,
    usedTokens,
    // 关键：没有分母就不给百分比。算出来是编的。
    contextPercent:
      contextWindow === null ? null : Math.min(100, (usedTokens / contextWindow) * 100),
    autoCompactTokens,
    cacheHitRate: nonNegative(cache?.cache_hit_rate),
    cacheReadTokens: nonNegative(cache?.cache_read_tokens),
    totalInputTokens: nonNegative(cache?.total_input_tokens),
    messageCount: nonNegative(status?.message_count),
    skills: skillNames(status?.skills),
  };
}

/**
 这次会话用过的技能名。

 服务端给的是**字符串数组**（`HandlersSessionInfoResponse.skills`）。这里只做两件事：
 丢掉空的、去掉重复的（同一次会话里同一个技能被用过多次时服务端会重复列出），
 **顺序照服务端**——它是"用过的时间顺序"，按字典序重排等于篡改信息。
 */
function skillNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * token 数的可读写法。
 *
 * 用 K/M 而不是逐位数字：面板是"扫一眼"的地方，`1.8K` 一眼能读，`1798` 要数位。
 * 与桌面端 `formatTokenCount` 的口径一致（保留一位小数）。
 */
export function formatTokenCount(value: number | null): string {
  if (value === null) return '—';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** 命中率的可读写法（服务端给的是 0-100 的百分数，不是 0-1 的小数）。 */
export function formatPercent(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value)}%`;
}
