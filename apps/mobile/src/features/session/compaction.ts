/**
 * 手动压缩上下文（`POST /bots/{bot_id}/sessions/{session_id}/compact`）的结果与文案。
 *
 * ## 为什么把这件事抽成纯逻辑
 *
 * 压缩是**同步**跑的（服务端 `RunCompactionSync`），所以界面只有三种结论，而每种要给用户的
 * 下一步完全不同：
 *
 * - **成功**：说清"压掉了多少条"，用户才知道自己刚才那一按有没有用（服务端返回了
 *   `message_count` 与可选 `summary`）。
 * - **不可用**：服务端用**类型化错误码**回答（`compaction_model_unavailable` 之类）——
 *   这不是"失败"，是"这台部署现在没有能用来做压缩的模型"。说成"失败了，请重试"会让用户
 *   一直重试一件不可能成的事。所以按码分开，能给具体原因的给具体原因。
 * - **失败**：其它情况（网络、500）。
 *
 * 另外两个约束写在这里，免得界面自己发明：
 *
 * - **压缩要花时间和 token**：它是真的调一次模型把上下文写成摘要，所以调用方必须给 loading、
 *   并且成功后**重新拉一次会话状态**（否则面板上还是压缩前的数字）。
 * - 服务端对"该不该压"有自己的判断（阈值、目标比例）。客户端**不做**前置判断去禁用按钮——
 *   那等于把服务端策略复制一份到手机上，两边必然漂移。用户在面板上看到用量、想压就压。
 */
import { ApiError } from '../../api/client.ts';

/** 服务端返回的压缩结果。 */
export interface CompactResult {
  status?: string;
  summary?: string;
  message_count?: number;
}

export type CompactOutcome =
  | { kind: 'ok'; messageCount: number; summary: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; message: string }
  | { kind: 'unauthorized' };

/**
 服务端明确说"现在压不了"的错误码。

 列在这里的都是**实测过或源码里读到过**的：`apperror.CodeCompactionModelUnavailable`
 与它带出的 `reason`。没见过的码一律走 `failed`——猜一个码去编文案，比说"失败"更糟。
 */
const UNAVAILABLE_CODES = new Set([
  'compaction_model_unavailable',
  'model_unavailable',
  'compaction_not_configured',
]);

export function compactOutcomeOf(result: CompactResult): CompactOutcome {
  return {
    kind: 'ok',
    messageCount: result.message_count ?? 0,
    summary: result.summary ?? '',
  };
}

export function compactFailureOf(caught: unknown): CompactOutcome {
  if (caught instanceof ApiError) {
    if (caught.isUnauthorized) return { kind: 'unauthorized' };
    if (caught.code !== undefined && UNAVAILABLE_CODES.has(caught.code)) {
      // 服务端的 message 已经写明了原因（哪个模型不可用），原样带出去给用户看。
      return { kind: 'unavailable', reason: caught.message };
    }
    return { kind: 'failed', message: caught.message };
  }
  return { kind: 'failed', message: caught instanceof Error ? caught.message : String(caught) };
}

/**
 压缩结果那一行怎么写。
 *
 * `messageCount` 为 0 时不编"压缩了 0 条"这种话：那可能意味着"没什么可压的"，
 * 也可能意味着服务端没回这个字段。两种情况都只说"完成"更诚实。
 */
/** 文案 key + 插值参数。参数类型跟着 i18n 的 `Params`（`string | number`）。 */
export function compactSummaryText(
  outcome: CompactOutcome,
): { key: string; values?: { count: number } } | null {
  if (outcome.kind === 'ok') {
    if (outcome.messageCount > 0) {
      return { key: 'sessionInfo.compact.done', values: { count: outcome.messageCount } };
    }
    return { key: 'sessionInfo.compact.doneNoCount' };
  }
  if (outcome.kind === 'unavailable') return { key: 'sessionInfo.compact.unavailable' };
  if (outcome.kind === 'failed') return { key: 'sessionInfo.compact.failed' };
  return null;
}
