/**
 * 会话行上的动作清单（长按出来的那张原生清单）。
 *
 * ## 为什么是"长按 + 原生 action sheet"，不是行内按钮
 *
 * 与文件列表同一个裁决（`features/files/actions.ts` 的文件头）：行内 swipe 在会话列表上
 * 表示"改变这条记录的状态"（归档、标记已读），而这两个动作是**对整条会话做一件事**，
 * 更重要的一层是——**行内放一排按钮会把每一行撑高**，而这一屏读的就是"最近有哪些会话"。
 * iOS 的既有位置是长按（邮件、信息、文件都是这样）。
 *
 * 桌面端对应的位置是会话行的右键菜单（重命名 / 标记未读 / 分享 / 在 PR 里打开 / 复制分支…），
 * 手机端按 J11 只留"在手机上真会做的事"。
 *
 * ## 这个模块只管"该显示哪些动作、哪些点不了、为什么"
 *
 * 画法（`ActionSheetIOS`）在屏幕那一层，取数与副作用也在那一层；这里统一
 * "哪些能点"，避免向用户暴露必然返回 409 的动作。
 *
 * ## 为什么 Fork 要按会话类型判
 *
 * 实测：非 chat 会话（这台部署上一堆 `schedule` 会话）POST `/fork` 会回
 * 409 `only chat sessions can be forked`。给一个必然失败的入口比不给更坏，所以这里
 * **直接不列出来**（不是列出来再置灰：桌面端也没有"定时任务会话的分叉"这个概念，
 * 用户不会来找它）。
 */
import type { UITurn } from '../../api/types.ts';

export type SessionActionId = 'rename' | 'fork';

export interface SessionAction {
  id: SessionActionId;
  labelKey: string;
}

/**
 清单顺序 = 用户的心智顺序：先改名字（轻、可撤销），再分叉（会多出一条会话）。

 `type` 是服务端给的会话类型（`session.type`）。**空/缺失时按"不能分叉"处理**——
 分叉的判据在服务端，客户端猜错一次就是 409。

 这里**没有** `enabled` 这个字段（文件列表那份清单有）：会话这一处没有"列出来但点不了"
 的动作——不能做的事就**不出现**（分叉对非 chat 会话），原因由屏幕那层清单说明承担
 （`session.action.fork.unavailable`）。
 */
export function sessionActions(input: { type: string | undefined }): SessionAction[] {
  const actions: SessionAction[] = [{ id: 'rename', labelKey: 'session.action.rename' }];
  if (isForkable(input.type)) {
    actions.push({ id: 'fork', labelKey: 'session.action.fork' });
  }
  return actions;
}

/** 哪些类型的会话服务端允许分叉。实测只有 `chat`（`internal/handlers/session.go` 判的）。 */
export function isForkable(type: string | undefined): boolean {
  return type !== undefined && type.trim().toLowerCase() === 'chat';
}

/**
 分叉的**锚点**：最近一条助手轮次。
 
 为什么不用"最新一条消息"：服务端按 `turn_id` 找那一轮，而**用户轮次做不了锚点**
 （`ForkFromAssistantTurn` 复制的是那条助手回复之前的状态）。取不到就返回 `null`，
 调用方据此说清楚"这个会话还没有可复制的回复"，而不是发一个必然 400 的请求。
 */
export function forkTarget(turns: readonly UITurn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn === undefined || turn.role !== 'assistant') continue;
    const turnId = turn.turn_id.trim();
    if (turnId !== '') return turnId;
  }
  return null;
}

/**
 新会话的名字。
 
 服务端在没给 `title` 时用 `<源标题> fork`（英文、且源标题为空时会变成 "Untitled fork"）。
 中文界面里那句读起来像没说完，所以客户端自己拼一个：源标题为空时**返回 null，交给服务端**
 ——不要编一个"未命名会话的分支"出来。
 */
export function forkTitle(sourceTitle: string, suffix: string): string | null {
  const title = sourceTitle.trim();
  if (title === '') return null;
  return suffix.replace('{{title}}', title);
}

/** 重命名要不要发出去（没改就不发——与服务端差分保存同一条规矩）。 */
export function renamePatch(current: string, draft: string): { title: string } | null {
  const next = draft.trim();
  if (next === '' || next === current) return null;
  return { title: next };
}
