/**
 * 审批回应的**帧参数**（纯逻辑，有单测）。
 *
 * ## 为什么单独放一个函数
 *
 * "拒绝时带理由"这条特性的落点不在界面上，而在**发出去的那一帧**：
 * `tool_approval_response` 除了 `decision` / `option_id` 之外还接受 `reason`
 * （桌面端 `useChat.ws.ts` 的类型、`tool-approval-actions.vue` 的输入框都指向它）。
 * 界面上多一个输入框很容易验成"我画上去了"，而真正要钉住的是"它有没有随帧发出去"、
 * "空理由**不该**变成一个空字段"。
 *
 * 后者不是洁癖：`reason: ''` 与"没有 reason"在服务端是两件事——前者会被当成
 * 一条空理由记进上下文，模型看到的是"用户拒绝了你，理由：（空）"，比什么都不说更糟。
 *
 * ## 两种回应形状
 *
 * agent 定义了选项时回 `option_id`（它知道那个选项的含义），没定义选项时回
 * `decision`（兜底动作是我们造的，那个假 id 服务端匹配不到）。这条分叉本来写在 store 里，
 * 挪到这里是为了**能被断言**——`decision` 与 `option_id` 同时出现是服务端会拒的形状。
 */
import { decisionForFallback, isFallbackOption } from './reducer.ts';

export interface ApprovalResponseFrame {
  /** 兜底动作（`__fallback_*`）走它。 */
  decision?: 'approve' | 'reject';
  /** agent 定义的选项走它。 */
  optionId?: string;
  /** 只有**非空**理由才会出现。 */
  reason?: string;
}

/**
 把"用户点了哪个选项 + 写了什么理由"翻成一帧的参数。

 空理由一律**不出现**在结果里（见文件头）。理由是字母数字以外的内容（中文、标点）也
 照原样带——服务端自己 trim，客户端不要在这里替用户改写。
 */
export function approvalResponseFor(optionId: string, reason = ''): ApprovalResponseFrame {
  const trimmed = reason.trim();
  const frame: ApprovalResponseFrame = isFallbackOption(optionId)
    ? { decision: decisionForFallback(optionId) }
    : { optionId };
  if (trimmed !== '') frame.reason = trimmed;
  return frame;
}

/**
 这个选项是不是"拒绝"。

 界面据此决定"要不要先问一句理由"。判据有两层，缺一不可：
 1. agent 给的选项用 `tone` 说明语气（`reducer` 已归一化）；
 2. 兜底选项没有 `tone`，用它的 id 前缀认（`__fallback_reject_*`）。

 认不出来的一律当成"不是拒绝"——对允许/中性的动作多问一句是干扰。
 */
export function isRejectChoice(choice: { id: string; tone?: string }): boolean {
  const fallbackReject = isFallbackOption(choice.id) && decisionForFallback(choice.id) === 'reject';
  return choice.tone === 'reject' || fallbackReject;
}
