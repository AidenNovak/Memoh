/**
 * "当前 agent 是谁"这个位置的**兜底文案**（会话页顶部的切换器、设置页的 agent 卡片、
 * 切换 sheet 里的空行）。
 *
 * ## 为什么值得单开一个纯函数
 *
 * 这三处以前各自写了一句 `currentBot === null ? t('home.empty.title') : 名字`，
 * 于是**拉不到 agent 列表时，屏幕上写的是"还没有会话"**——两处错误叠在一起：
 *
 * 1. 那是空态的语气，而真实情况是"没拉到"（规则 R41：拉取失败时显示"还没有内容"是撒谎）；
 * 2. 就算真没有 agent，说的也是**会话**而不是 **agent**（名词用错，用户会去找"被删掉的会话"）。
 *
 * 现在三态各有各的话，而且判断只在这里一处：
 * 正在拉 → "正在加载"；拉失败 → "没拉到"；拉到了但一个都没有 → "还没有 agent"。
 *
 * 返回的是 **i18n key** 而不是译文：调用方自己 `t()`（i18n 的语言是运行时可切的）。
 */
import type { ErrorPresentation } from '../errors/present.ts';

/** i18n key，调用方拿去 `t()`。 */
export type AgentPlaceholderKey = 'common.loading' | 'bots.loadFailed' | 'bots.empty';

/**
 * 没有当前 agent 时那个位置该写什么。
 *
 * ⚠️ **加载态必须排在空态前面**：`bots === []` 在"还没拉到"和"真的一个都没有"时都成立，
 * 拿它当空态的判据就会在启动那一瞬间说"还没有 agent"。
 *
 * 顺序是刻意的（先看错误、再看加载、最后才是空）：错误留在屏幕上直到真的成功，
 * 所以重试期间它继续显示错误——这与 `sessionsLoading` 的纪律一致。
 */
export function agentPlaceholderKey(input: {
  loading: boolean;
  failure: ErrorPresentation | null;
}): AgentPlaceholderKey {
  if (input.failure !== null) return 'bots.loadFailed';
  if (input.loading) return 'common.loading';
  return 'bots.empty';
}
