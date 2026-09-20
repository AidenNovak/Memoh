/**
 * 会话队列的**纯逻辑**：提交闸门 + 队列项的整理。
 *
 * ## 队列是干什么的
 *
 * agent 在跑的时候，用户最常见的动作是"再补一句"（人在外面没时间等它跑完）。
 * 服务端为此有两列队列：
 *
 * - **follow-up**：这一轮跑完后再跑（默认）；
 * - **steer**：插进正在跑的那一轮，agent 立刻看到。
 *
 * 两条都在服务端，不在客户端合成——客户端只负责入队、显示、删除、转 steer。
 * **绝不**在本地假装一条消息已经"发出去"：那会让用户以为 agent 收到了。
 *
 * ## 提交闸门为什么值得存在
 *
 * 一个发送手势 = 一个幂等身份（`invocation_id`）。双击发送、网络重试、界面重挂载
 * 都可能让同一个手势进两次；服务端按 invocation_id 去重，但**前提是两次带同一个
 * id**。闸门保证：
 *
 * 1. 上一次请求在飞行中时，第二次手势直接拒绝（返回 null）；
 * 2. 失败（结果不明）时保留身份——重试同一段文字会**重放**而不是再入一条。
 *
 * 这条抄自上游 `session-queue-submission.ts`，语义逐条对齐。
 */

import type { QueueItem } from '../../models/chat.ts';

export type QueueMode = 'steer' | 'follow-up';

export interface QueueSubmission {
  key: string;
  invocationId: string;
}

function submissionKey(input: { sessionId: string; mode: QueueMode; text: string }): string {
  return JSON.stringify([input.sessionId, input.mode, input.text]);
}

/** 一次提交手势的幂等身份。语义见文件头。 */
export class QueueSubmissionGate {
  private active: QueueSubmission | null = null;
  private retry: QueueSubmission | null = null;
  /** 显式字段让构造器只负责注入幂等 id 的来源。 */
  private readonly createInvocationId: () => string;

  constructor(createInvocationId: () => string) {
    this.createInvocationId = createInvocationId;
  }

  begin(input: { sessionId: string; mode: QueueMode; text: string }): QueueSubmission | null {
    // 已有请求在飞行中：这一次手势不接受（否则同一个手势会入两条）。
    if (this.active !== null) return null;
    const key = submissionKey(input);
    // 失败的重试沿用同一个 invocation_id —— 服务端据此识别为同一件事。
    const submission =
      this.retry !== null && this.retry.key === key
        ? this.retry
        : { key, invocationId: this.createInvocationId() };
    this.active = submission;
    return submission;
  }

  succeed(submission: QueueSubmission): void {
    if (this.active !== submission) return;
    this.active = null;
    this.retry = null;
  }

  fail(submission: QueueSubmission): void {
    if (this.active !== submission) return;
    this.active = null;
    this.retry = submission;
  }
}

/**
 * 队列里**还该显示**的项。
 *
 * 终态（`applied` / `rejected` / `expired` / `canceled`）不再显示：它们要么已经变成
 * 消息流里的一条真实消息，要么已经被放弃——继续挂在"待发送"里会让用户以为还欠着。
 * `accepted` / `claimed` 是"排队中"和"agent 正在取用"。
 *
 * 排序按服务端给的 `position`（那是权威顺序）；同 position 时用 itemId 兜底，
 * 免得两个设备上的顺序抖动。
 */
export function visibleQueueItems(items: QueueItem[]): QueueItem[] {
  return items
    .filter((item) => item.status === 'accepted' || item.status === 'claimed')
    .slice()
    .sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      return a.itemId.localeCompare(b.itemId);
    });
}

/**
 * 队列条一次显示几条。
 *
 * 理由（同 Lody 的规则：它的"待发草稿"列表最多显示 3 条）：队列条钉在输入框**上方**，
 * 每条行高下限 44pt——它越长，正在读的正文被顶掉得越多。排队是等待期的临时状态，
 * 要紧的是"还欠着几条"，不是把每一条都摊开。超出部分不静默丢弃，改成一行计数
 * （`queue.hidden`）：用户既知道有几条在等，也知道看不到的那几条**没有**被吃掉。
 */
export const QUEUE_PREVIEW_LIMIT = 3;

/**
 * 队列条的显示切片：前 `limit` 条 + 被折叠的条数。
 *
 * 顺序**沿用传入顺序**（调用方已用 `visibleQueueItems()` 按服务端 `position` 排好）。
 * 这里再排一次会让"服务端顺序"和"界面顺序"变成两个真源。
 */
export function queuePreview(
  items: QueueItem[],
  limit: number = QUEUE_PREVIEW_LIMIT,
): { visible: QueueItem[]; hidden: number } {
  const visible = items.slice(0, Math.max(0, limit));
  return { visible, hidden: Math.max(0, items.length - visible.length) };
}

/**
 队列能力。`unknown` = 还没探测出来。

 它是**服务端能力**，不是会话数据：实测部署版本（`memohai/server` 8/30 镜像）
 对 `/queue`、`/follow-up-queue` 一律 404，而同部署的桌面端产物里也**没有**队列
 相关代码。所以"运行中能排队"不是通用事实，是一个要探测的能力——不探测就会给
 用户一个必然失败的按钮。
 */
export type QueueSupport = 'unknown' | 'yes' | 'no';

/**
 * 发送按钮在给定状态下该做什么。
 *
 * - `send`：空闲且有文字 → 开一轮；
 * - `queue`：**运行中**、有文字、且服务端支持队列 → 排进队列（这轮跑完再跑）；
 * - `stop`：运行中但没有可排队的地方 → 停止。这是与**部署版桌面端**对齐的行为：
 *   桌面端在这个版本上，运行中的按钮就是"停止"。
 */
export function composerAction(input: {
  running: boolean;
  hasDraft: boolean;
  queueSupported: boolean;
}): 'send' | 'queue' | 'stop' {
  if (input.running && input.hasDraft && input.queueSupported) return 'queue';
  if (input.running) return 'stop';
  return 'send';
}

/** 能力还没探测出来时按"不支持"处理：宁可不给入口，也不要给一个必然失败的。 */
export function composerActionWithSupport(input: {
  running: boolean;
  hasDraft: boolean;
  support: QueueSupport;
}): 'send' | 'queue' | 'stop' {
  return composerAction({
    running: input.running,
    hasDraft: input.hasDraft,
    queueSupported: input.support === 'yes',
  });
}

/** 入队失败时给用户看的话。队列失败不静默——用户以为排上了、实际没有，是最坏的。 */
export function queueFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail === '' ? 'queue.failed' : `queue.failed:${detail}`;
}
