/**
 * 实时协议的帧类型。
 *
 * 两类帧来自同一条 WebSocket：
 *   - **控制帧**（发消息 / 中断 / 审批）——`wsOutboundEvent`，只有发送方收到。
 *   - **投影帧**（`runtime_*`）——只发给 `runtime_subscribe` 过该会话的连接。
 *
 * ⚠️ 最容易踩的坑：**发消息的那条连接收不到正文**。文本/思考/工具增量全部走
 * `runtime_delta`。所以顺序永远是：连上 → `runtime_subscribe` → 收到
 * `runtime_snapshot` → 再发 `message`。
 *
 * 依据：`internal/handlers/local_channel.go:933-1007`、
 * `internal/handlers/runtime_ws.go:211-222,276-345`。
 */
import type { UIAttachment, UIMessage, UITurn } from './types';

// ---------------------------------------------------------------- 客户端 → 服务端

export interface RuntimeCursor {
  epoch: string;
  seq: number;
}

export interface MessageFrame {
  type: 'message';
  /** 客户端生成的幂等键，代表"意图"。重发同一个不会产生第二轮。 */
  invocation_id: string;
  /** 省略时服务端会自动建会话，并用 `session_created` 告知。 */
  session_id?: string;
  text?: string;
  attachments?: UIAttachment[];
  requested_skills?: string[];
  model_id?: string;
  reasoning_effort?: string;
  workspace_target_id?: string;
  composer_scope?: string;
}

export interface RetryMessageFrame {
  type: 'retry_message';
  invocation_id: string;
  session_id: string;
  turn_id: string;
  model_id?: string;
  reasoning_effort?: string;
  workspace_target_id?: string;
}

export interface EditMessageFrame {
  type: 'edit_message';
  invocation_id: string;
  session_id: string;
  turn_id: string;
  text?: string;
  attachments?: UIAttachment[];
  model_id?: string;
  reasoning_effort?: string;
  workspace_target_id?: string;
}

export interface AbortFrame {
  type: 'abort';
  /** 服务端生成的 run 标识，是中断的唯一寻址方式。 */
  run_id: string;
  session_id: string;
  /** 控制类请求的幂等键。 */
  control_id: string;
}

export interface ToolApprovalResponseFrame {
  type: 'tool_approval_response';
  run_id: string;
  session_id: string;
  /** = 原始 `approval_id`。 */
  decision_id: string;
  control_id: string;
  decision?: 'approve' | 'reject';
  /** agent 定义的选项 id。**必填**。 */
  option_id?: string;
  reason?: string;
}

export interface UserInputResponseFrame {
  type: 'user_input_response';
  run_id: string;
  session_id: string;
  decision_id: string;
  control_id: string;
  answers?: unknown;
  canceled?: boolean;
  reason?: string;
}

export interface RuntimeSubscribeFrame {
  type: 'runtime_subscribe';
  session_id: string;
  cursor?: RuntimeCursor;
}

export interface RuntimeUnsubscribeFrame {
  type: 'runtime_unsubscribe';
  session_id: string;
}

export type ClientFrame =
  | MessageFrame
  | RetryMessageFrame
  | EditMessageFrame
  | AbortFrame
  | ToolApprovalResponseFrame
  | UserInputResponseFrame
  | RuntimeSubscribeFrame
  | RuntimeUnsubscribeFrame;

// ---------------------------------------------------------------- 服务端 → 客户端

export interface RunAcceptedEvent {
  type: 'run_accepted';
  run_id: string;
  invocation_id: string;
  session_id: string;
  turn_id: string;
  epoch: string;
  seq: number;
  /** true = 这次是重复提交，服务端复用了已有 run。 */
  duplicate: boolean;
}

export interface RunRejectedEvent {
  type: 'run_rejected';
  session_id?: string;
  invocation_id?: string;
  /** 稳定错误码：客户端据此决定能否原样重试。 */
  code?: string;
  message?: string;
}

export interface SessionCreatedEvent {
  type: 'session_created';
  session_id: string;
}

export interface ErrorEvent {
  type: 'error';
  run_id?: string;
  invocation_id?: string;
  session_id?: string;
  code?: string;
  message?: string;
}

/**
 * abort / 审批 / 回答的结果。
 *
 * `applied: false` + `code: ""` = 控制被处理了但什么都没改变（run 已结束）；
 * `code` 非空 = 请求根本没到 owner，值得重试。**这是两件不同的事。**
 */
export interface ControlAckEvent {
  type: 'control_ack';
  control: string;
  control_id: string;
  applied: boolean;
  code?: string;
  message?: string;
}

export interface CommandResultEvent {
  type: 'command_result';
  [key: string]: unknown;
}

export interface CommandErrorEvent {
  type: 'command_error';
  [key: string]: unknown;
}

// ---------------------------------------------------------------- 投影（delta / snapshot）

/**
 * 流式文本的增量语义。
 *
 * ⚠️ `message_appends` 是**按 id 追加内容**，不是整块替换。把它当 upsert 处理
 * 会让长回复每帧重排整块，直接卡死。
 */
export interface RuntimeMessageAppend {
  id: number;
  type: 'text' | 'reasoning';
  content: string;
}

export interface RuntimeProgressAppend {
  id: number;
  progress: unknown;
  input?: unknown;
}

export interface SteerTurnView {
  item_id: string;
  status: 'claimed' | 'applied';
  text: string;
  turn_id?: string;
  after_message_id?: number;
  timestamp?: string;
}

/**
 * 运行状态机（`internal/agent/runtime/session/types.go:22-32`）。
 *
 * `waiting_decision` 是"run 还活着，但停在一个持久的审批/提问决策上"——
 * 这是"正在等你批准"的**权威信号**，比在 UI 层看 tool 的 approval 状态可靠。
 */
export type RunStatus =
  | 'admitting'
  | 'running'
  | 'waiting_decision'
  | 'finishing'
  | 'completed'
  | 'aborting'
  | 'aborted'
  | 'errored'
  | 'lost';

export interface RunView {
  run_id: string;
  status: RunStatus;
  error_code?: string;
  error?: string;
  updated_at?: string;
  owner_lease_expires_at?: string;
}

export interface RunOperationView {
  kind?: string;
  replace_from_message_id?: number;
  [key: string]: unknown;
}

export interface CurrentRunView {
  run_id: string;
  turn_id?: string;
  invocation_id?: string;
  generation?: string;
  status: RunStatus;
  owner_id?: string;
  /**
   * owner 的租约到期时间。
   *
   * ⚠️ 这是客户端判断"这个 run 是不是已经没人管了"的**唯一依据**。
   *
   * 部署实例中，run 正常失败时投影会给出 `errored`，
   * 重订阅也能拿到终态。但 owner 进程死掉（例如上游的 persistence fence 失效）时，
   * 投影会**永远停在 `running`**——不会报错、不会收敛。这时租约过期是唯一线索。
   *
   * 没有它，客户端的表现就是"永远在转圈"，用户只能杀进程。
   */
  owner_lease_expires_at?: string;
  started_at?: string;
  updated_at?: string;
  /** 助手侧的输出块。**这是运行期间内容的权威来源。** */
  messages?: UIMessage[];
  /** 已准入的用户输入（含 apply 过的 steer）。 */
  user_turns?: UITurn[];
  steer_supported?: boolean;
  fencing_token?: number;
  steer_turns?: SteerTurnView[];
  error_code?: string;
  error?: string;
  proposed_terminal_status?: string;
  finish_proposed_at?: string | null;
  operation?: RunOperationView | null;
}

export interface RuntimeDelta {
  current_run_view?: CurrentRunView | null;
  run?: RunView | null;
  user_turn_upserts?: UITurn[];
  steer_turn_upserts?: SteerTurnView[];
  steer_turn_removals?: string[];
  /** 按 id 追加，不是整块替换。 */
  message_appends?: RuntimeMessageAppend[];
  progress_appends?: RuntimeProgressAppend[];
  /** 整块替换（tool_call_* / 审批 / 终止事件走这里）。 */
  message_upserts?: UIMessage[];
  reset_messages?: boolean;
}

export interface RuntimeSnapshotPayload {
  bot_id: string;
  session_id: string;
  epoch: string;
  seq: number;
  updated_at?: string;
  /** 缺失 = 该会话当前没有活跃 run。 */
  current_run_view?: CurrentRunView | null;
}

export interface RuntimeSnapshotFrame {
  type: 'runtime_snapshot';
  session_id: string;
  epoch: string;
  seq: number;
  snapshot: RuntimeSnapshotPayload;
}

export interface RuntimeDeltaFrame {
  type: 'runtime_delta';
  session_id: string;
  epoch: string;
  seq: number;
  delta: RuntimeDelta;
}

/** 订阅缓冲溢出。语义 = "你的视图已经过期，去重新订阅拿 snapshot"。 */
export interface RuntimeDroppedFrame {
  type: 'runtime_dropped';
  session_id: string;
  epoch: string;
  seq: number;
  message?: string;
}

export type ServerFrame =
  | RunAcceptedEvent
  | RunRejectedEvent
  | SessionCreatedEvent
  | ErrorEvent
  | ControlAckEvent
  | CommandResultEvent
  | CommandErrorEvent
  | RuntimeSnapshotFrame
  | RuntimeDeltaFrame
  | RuntimeDroppedFrame
  | { type: string; [key: string]: unknown };

/** 帧类型判别。未知类型返回空串——服务端加新帧不应让旧客户端崩。 */
export function frameType(frame: unknown): string {
  if (frame !== null && typeof frame === 'object' && 'type' in frame) {
    const value = (frame as { type: unknown }).type;
    if (typeof value === 'string') return value;
  }
  return '';
}
