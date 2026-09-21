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
import type { Bot } from '../../api/types.ts';
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

/**
 * agent 自己的状态（不是我们这条连接的状态——那是 Hub 顶部的连接行的事，见
 * `features/session/hubChrome.ts`）。
 *
 * 服务端 `status` 的取值域没有文档，这里只认我们已知的三个；认不出来就退回
 * `is_active`（"这个 bot 是启用的"）。宁可说得保守，也不要凭一个不认识的字符串
 * 编出一个状态。
 *
 * ## 为什么住在这里（而不是 `ui/BotSwitcher.tsx`）
 *
 * 模块 9 之后这个判据的调用方横跨三处 UI（会话页顶部的 agent 行、设置页的 agent 卡片、
 * 原生 Hub 的 agent 菜单），其中两处已经不在 RN 的 `ui/` 里。判据跟着**文案**走
 * （同文件的 `agentPlaceholderKey`）比跟着某一个组件走更稳：谁都能 import，而抄第二份
 * 一定会有一天只改了一处。
 */
export function agentStatus(
  bot: Bot | null,
  t: (key: string) => string,
): { label: string | null; color: 'success' | 'warning' | 'muted' } {
  if (bot === null) return { label: null, color: 'muted' };
  if (bot.status === 'starting') return { label: t('bot.status.starting'), color: 'warning' };
  if (bot.status === 'online') return { label: t('bot.status.online'), color: 'success' };
  if (bot.status === 'offline') return { label: t('bot.status.offline'), color: 'muted' };
  return bot.is_active
    ? { label: t('bot.status.online'), color: 'success' }
    : { label: t('bot.status.offline'), color: 'muted' };
}
