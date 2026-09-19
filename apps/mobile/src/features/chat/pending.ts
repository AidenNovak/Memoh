/**
 * "发出去了但看不见"——那一帧的**可见表达**（纯逻辑，不碰 React）。
 *
 * ## 这一块解决的是什么
 *
 * 发一条消息有三个时刻，而它们对用户是**三件不同的事**：
 *
 * 1. 消息还在本地（没连上/刚断线，帧躺在 outbox 里）；
 * 2. 消息已经交给服务端，但服务端还没把它广播回来（run 的 user_turns 还没到）；
 * 3. 服务端明确拒了这一次提交（`run_rejected`）。
 *
 * 之前这三种状态在界面上**都不存在**：输入框清空、屏幕上看不到刚发的那句话，
 * 用户唯一能得出的结论是"App 把我的话吃了"。桌面端没有这个问题（写先落本地），
 * 所以这是移动端独有的一处缺口。
 *
 * ## 判据（照 Lody 三条硬规则，见
 * `docs/research/lody-desktop-vs-ios-feature-surface.md` §3.3）
 *
 * | 规则 | 落在这里 |
 * | --- | --- |
 * | **未确认 ≠ 进行中**：没确认的时候不给转圈 | 三个阶段的文案都是**文字**，这个模块里根本没有"忙/转圈"这一档 |
 * | 每个阶段有名字 | `awaiting` / `queued` / `failed` 各有自己的一句（不是"发送中…"打天下） |
 * | 行上有动作，且**重试 ≠ 重连** | `failed` 里**可原样重发**的才给 retry（白名单见下）；`queued（未连接）→ reconnect`。两者的 id、文案、无障碍提示都是分开的两套 |
 *
 * 还有一条来自同一处的硬规矩：**结果未确认时等同步，不要重发**。所以 `awaiting` 阶段
 * **没有**动作——那一帧可能已经进了服务端，再发一次就是重复一轮。这也正是"重试"与
 * "重连"必须分开的原因：前者是"再发一次这句话"，后者只是"把管子接回来"，两者对
 * 服务端的效果完全不同。
 *
 * `connected` 只影响 `queued` 的措辞吗？不是——它决定**该不该给重连这个动作**：
 * 已经连着的时候给"重连"是一个点了没用的按钮（AutoRecovery 正在做的事，用户再点一次
 * 只是噪音，判据 J9）。
 */
/** 一次提交的失败信息（服务端 `run_rejected` 的 code/message）。 */
export interface SendFailure {
  invocationId: string;
  /** 稳定错误码。客户端据此决定能不能原样重试——不显示给用户（那是开发者的话）。 */
  code: string;
  /** 服务端写好的句子（可能为空）。**给用户看的是这一句**。 */
  message: string;
}

export type PendingPhase = 'awaiting' | 'queued' | 'failed';

export interface PendingSendView {
  phase: PendingPhase;
  /** 等待态的那句话（i18n key）。**不是**转圈。 */
  textKey: string;
  /** 失败时服务端给的原因（没有就是 null，不编一句）。 */
  reason: string | null;
  action: PendingAction | null;
}

export interface PendingAction {
  id: 'retry' | 'reconnect';
  labelKey: string;
  /**
   无障碍提示：两个动作的**效果不同**，只念"重试"会让读屏用户以为它是重连
   （或反过来）。所以每个动作都自带一句"按下去会发生什么"。
   */
  hintKey: string;
}

const RETRY: PendingAction = {
  id: 'retry',
  labelKey: 'chat.pending.retry',
  hintKey: 'chat.pending.retry.hint',
};

const RECONNECT: PendingAction = {
  id: 'reconnect',
  labelKey: 'chat.pending.reconnect',
  hintKey: 'chat.pending.reconnect.hint',
};

/**
 可以**原样重发**的拒绝码。白名单，不是默认值（同 `features/errors/present.ts`）。

 `run_rejected` 的取值域是封闭的：服务端只有 `wsRunRejectionCode()`
 （`internal/handlers/local_channel.go`）会产出它，一共两个值，逐条对着
 `internal/apperror/error.go` 的注释核对过：

 | code                                  | 服务端注释（原话摘录）                                                                                     | 原样重发 |
 | ------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------- |
 | `session_runtime.session_busy`        | "ordinary backpressure and the same submission succeeds once the session frees up… the one conflict in this catalog that a client should retry unchanged" | 可以     |
 | `session_runtime.invocation_conflict` | "retrying changes nothing, because the same retry identity was already used for different input"             | **不行** |

 空 code / 没见过的 code 都算"我们看不懂的拒绝"，不给按钮：服务端的契约是
 `run_rejected` 一定带稳定 code（`api/protocol.ts`），没有 code 说明这不是我们理解的
 那条路——猜"也许再发一次能成"就是在让用户做一件我们并不知道会不会成的事。
 话照说（`reason`），只是没有可点的部分。
 */
const RETRYABLE_REJECTION_CODES = new Set(['session_runtime.session_busy']);

/** 这个拒绝码能不能**原样**（同一个 `invocation_id`）重发。 */
export function rejectionIsRetryable(code: string): boolean {
  return RETRYABLE_REJECTION_CODES.has(code.trim());
}

/**
 一条待发消息此刻该怎么说。
 
 返回 `null` = 没有待发的东西，界面不该出现这一块（**空容器会白占一行高度**，
 与 QueueStrip 同一条规矩）。
 */
export function pendingSendView(input: {
  /** 有本地乐观消息还没被权威轮次覆盖（`ChatState.pendingInvocationId !== null`）。 */
  unconfirmed: boolean;
  /** outbox 里还有没送出去的帧（`UiState.pendingSends > 0`）。 */
  queuedLocally: boolean;
  /** 实时通道现在是不是 `open`。 */
  connected: boolean;
  /** 服务端拒过这一次提交。 */
  failure: SendFailure | null;
}): PendingSendView | null {
  // 服务端明确拒了。**能不能再发一次由 code 说了算**（白名单见 `RETRYABLE_REJECTION_CODES`）：
  // 不可重试的拒绝照样把话说清楚，但不给按钮——那是在让用户去撞同一面墙。
  if (input.failure !== null) {
    return {
      phase: 'failed',
      textKey: 'chat.pending.failed',
      reason: input.failure.message === '' ? null : input.failure.message,
      action: rejectionIsRetryable(input.failure.code) ? RETRY : null,
    };
  }
  if (!input.unconfirmed) return null;

  if (input.queuedLocally || !input.connected) {
    return {
      phase: 'queued',
      textKey: 'chat.pending.queued',
      reason: null,
      action: RECONNECT,
    };
  }

  /**
   已交给服务端、等它把这一轮广播回来。

   **不给动作**：这一帧可能已经在服务端了，重发就是重复一轮（Lody 的
   "结果未确认时等同步，不要重发"）。要给也是给"重新订阅/刷新"那一条，
   而那条已经在连接状态行上了（J9：系统正在自己恢复时别再给第二个恢复者）。
   */
  return { phase: 'awaiting', textKey: 'chat.pending.awaiting', reason: null, action: null };
}
