/**
 * 定时任务的「运行位置」（新会话 / 复用某个会话）——纯逻辑。
 *
 * ## 为什么这一项之前一直没做
 *
 * 上一轮的结论是"改成「复用同一个会话」需要会话选择器，没有它就会写出缺
 * `target_session_id` 的必然被拒请求，所以宁可不给"。也就是说**这一项的门槛不是界面，
 * 是那条约束**：`run_target = existing_session` 与一个非空的 `target_session_id` 必须
 * 同时成立。所以这里第一件事就是把那条约束写成能直测的函数，界面只负责照着它禁用/提示。
 *
 * ## 两个容易漏的分支
 *
 * 1. **切回"新会话"时要清掉 target_session_id**：不清的话服务端会收到
 *    `run_target=new_session` + 一个残留的会话 id——语义含混（有的实现会忽略、有的会报错），
 *    而且下次切回复用时那个旧 id 会**悄悄回来**，用户以为自己选的是刚点的那个。
 * 2. **被选中的会话可能不在第一页**：`GET /sessions` 是分页的（默认 50 条），定时任务经常
 *    复用一个"很久以前建好的"会话。列表里找不到时不能显示成"没选"，要显示它的 id 并让
 *    用户能确认——那比一个空白值诚实。
 */
import type { Session } from '../../api/types.ts';

/** 这个模块只关心"哪个会话"和"怎么叫它"，所以要的字段就这两个。 */
type SessionLike = Pick<Session, 'id' | 'title'>;

export type RunTarget = 'new_session' | 'existing_session';

export interface RunTargetDraft {
  runTarget: string;
  targetSessionId: string;
}

/** 界面状态：能不能保存、为什么不能。 */
export interface RunTargetCheck {
  ok: boolean;
  /** 不 ok 时给用户的下一步（i18n key）。 */
  problemKey: string | null;
}

/**
 能不能用这个"运行位置"保存。

 只有一种不合法：说要用已有会话，却没给会话 id。其余情况（新会话、或者已有的 + 给了 id）
 都可以直接保存——**不做别的推测**（比如"那个会话是不是还存在"要问服务端，客户端猜只会错）。
 */
export function checkRunTarget(draft: RunTargetDraft): RunTargetCheck {
  if (draft.runTarget !== 'existing_session') return { ok: true, problemKey: null };
  if (draft.targetSessionId.trim() === '') {
    return { ok: false, problemKey: 'schedule.runTarget.needsSession' };
  }
  return { ok: true, problemKey: null };
}

/** 切"运行位置"：切回新会话时**顺手清掉**残留的会话 id（见文件头注释第 1 条）。 */
export function switchRunTarget(draft: RunTargetDraft, runTarget: RunTarget): RunTargetDraft {
  if (runTarget === 'new_session') return { runTarget, targetSessionId: '' };
  return { runTarget, targetSessionId: draft.targetSessionId };
}

/**
 会话在列表里怎么显示。

 标题为空时**不写"未命名会话"**这种自造文案，而是把 id 的前 8 位给出来——定时任务里那个
 会话是用户自己选的，id 至少能让他对上是哪一个（服务端的会话标题本来就可能为空）。
 */
export function sessionLabel(session: SessionLike): string {
  const title = (session.title ?? '').trim();
  if (title !== '') return title;
  return session.id.slice(0, 8);
}

/**
 当前选中的会话怎么显示（可能不在已加载的那一页里）。
 */
export function selectedSessionLabel(targetSessionId: string, sessions: SessionLike[]): string {
  if (targetSessionId.trim() === '') return '';
  const found = sessions.find((session) => session.id === targetSessionId);
  if (found === undefined) return targetSessionId.slice(0, 8);
  return sessionLabel(found);
}
