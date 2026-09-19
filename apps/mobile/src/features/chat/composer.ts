/**
 * composer 上那颗圆按钮此刻是什么（纯逻辑，可单测）。
 *
 * ## 为什么值得一个纯函数
 *
 * 运行中按钮的语义（与上游同一个圆按钮一致，见 chat-pane 的 handleSendButton）：
 *
 * - **有文字**：这句话排进队列（follow-up，这一轮跑完再跑）；
 * - **没文字**：停止这一轮。
 *
 * 所以 `canSend` 不再等于"正在生成"——正在生成且有文字时它也能点，而那时点下去
 * 是**排队**而不是停止。以前是"运行中一律停止"，于是用户想补一句只能先打断，
 * 而"补一句"恰恰是人在外面最常见的动作。
 *
 * 判据本身在 `queue.ts`（`composerActionWithSupport`，它依赖"这个服务端到底支不支持
 * 队列"）；这里把**按钮需要知道的四件事**一次算齐：能不能点、点下去是什么、字形、
 * 以及读屏该念哪句话。分四处算就会出现"字形是停止、标签是发送"这种错位——
 * 那正是 A6/B2 判据要拦的东西。
 */
import type { QueueSupport } from './queue.ts';
import { composerActionWithSupport } from './queue.ts';

/** 按钮此刻的动作。取自判据函数本身，不另写一份联合类型（两份会漂）。 */
export type ComposerAction = ReturnType<typeof composerActionWithSupport>;

export interface ComposerView {
  /** 草稿去掉首尾空白之后还有没有内容。 */
  hasDraft: boolean;
  /** 按钮能不能点：有文字，或正在跑（那时是停止）。 */
  canSend: boolean;
  action: ComposerAction;
  /**
   * 读屏标签的 i18n key："排队"和"发送"对用户是两件事，标签要说清这一下会发生什么。
   */
  labelKey: string;
  /** 字形：形状不变、只换字形，所以同一个位置中途不会闪。 */
  glyph: '↑' | '■';
}

export function composerView(input: {
  draft: string;
  running: boolean;
  support: QueueSupport;
}): ComposerView {
  const hasDraft = input.draft.trim() !== '';
  const action = composerActionWithSupport({
    running: input.running,
    hasDraft,
    support: input.support,
  });
  return {
    hasDraft,
    // 空闲且没文字时按钮是**禁用**的发送键（不是停止）——语义与禁用分开。
    canSend: hasDraft || input.running,
    action,
    labelKey: labelKeyFor(action),
    glyph: action === 'stop' ? '■' : '↑',
  };
}

function labelKeyFor(action: ComposerAction): string {
  if (action === 'stop') return 'chat.stop';
  if (action === 'queue') return 'queue.send';
  return 'chat.send';
}
