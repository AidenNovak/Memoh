/**
 * 聊天页状态归约器（纯函数，不碰 React、不碰网络）。
 *
 * 这里是本项目最容易写错、也最值得写测试的地方。核心契约只有一条，违反它就会让
 * 长回复直接卡死：
 *
 *   **流式文本是 `message_appends`（按 id 追加），不是整块替换。**
 *   **只有 `tool_call_*`、审批、终止事件才是 `message_upserts`（整块）。**
 *
 * 状态因此分成三层：
 *   - `history`：已完成的历史轮次（来自 REST，或服务端确认过的 snapshot）。
 *   - `live`：当前活跃 run 的输出（整块 `blocks` + 按 id 累加的 `streams`）。
 *   - `optimistic`：本地刚发出、服务端还没确认的消息。
 *
 * 合并只在**渲染层做一次**（`turnsForDisplay`），不在每帧重建整条消息。
 *
 * 另外两个必须守住的点：
 *   - `reset_messages: true`（服务端 `retry`）丢弃本地推测的流式内容，保留已确认的
 *     整块历史。
 *   - `epoch` 变了就整体重建，不尝试合并——跨 epoch 的 seq 没有意义。
 *
 * 第三条（2026-09-18 修）：**同一轮在屏幕上只能有一份**。run 结束后服务端**仍然长期
 * 带着** `status="completed"` 的 `current_run_view`（实测 11 小时后还在），而 REST 历史
 * 要等轮次屏障才落盘；两条通道都在讲同一轮。判据是"**历史里有没有这一轮**"
 * （`representedInHistory`），不是"状态是不是终态"——后者会在"run 刚结束、历史还没刷
 * 回来"那个窗口把屏幕上唯一那份内容清掉。
 */
import type {
  CurrentRunView,
  RunStatus,
  RuntimeDelta,
  RuntimeSnapshotPayload,
} from '../../api/protocol.ts';
import type { UIMessage, UITurn } from '../../api/types.ts';
import type {
  ApprovalChoice,
  PendingApproval,
  PendingQuestion,
  PendingUserInput,
  RenderBlock,
  RenderMessage,
  RenderTurn,
} from '../../models/chat.ts';
import {
  approvalTone,
  attachmentRef,
  fallbackOptionKey,
  toolStatusFrom,
} from '../../models/chat.ts';
import type { SendFailure } from './pending.ts';
import { olderCursorOf, pageBringsNewTurns } from './historyPage.ts';

/** 流式缓冲：message id → 累加内容。 */
export type StreamMap = Record<string, { type: 'text' | 'reasoning'; content: string }>;

export interface ChatState {
  /** null = 还没收到过任何 snapshot。 */
  epoch: string | null;
  seq: number;
  runId: string | null;
  runStatus: RunStatus | null;
  runError: string | null;
  /**
   * owner 的租约到期时间（ISO 字符串）。
   *
   * 用来识别"owner 已经死了但投影还停在 running"——那是用户唯一能看到的线索，
   * 没有它界面就永远转圈。见 `tools/orphan-run-probe.mjs`。
   */
  runLeaseExpiresAt: string | null;
  /** 服务端权威：是否有活跃 run。 */
  running: boolean;
  /**
   当前 run 视图对应的**轮次身份**（`current_run_view.turn_id`）。

   存在的理由只有一个：判断"这一轮在 REST 历史里已经画出来了没有"。服务端在 run 结束
   之后**仍然长期带着** `current_run_view`（实测：run 结束 11 小时后重订阅，拿到的还是
   `status="completed"` + 上一轮的 `messages`，见
   `docs/research/assets/chat-copy-and-reasoning-20260918/`），所以不能只看状态，得看身份。
   协议里它是可选字段；缺失时的兜底见 `representedInHistory`。
   */
  runTurnId: string | null;
  /** 活跃 run 已准入的用户输入（含 apply 过的 steer）。 */
  liveUserTurns: UITurn[];
  /** 活跃 run 的助手侧整块内容，按消息 id 索引。 */
  blocks: Record<string, UIMessage>;
  /** 消息 id 的顺序。服务端不保证 upsert 顺序，自己维护。 */
  order: number[];
  /** 按 id 累加的流式缓冲。 */
  streams: StreamMap;
  /** 工具进度，按消息 id 索引。 */
  progress: Record<string, unknown[]>;
  /** 已完成的历史轮次。 */
  history: RenderTurn[];
  /** 本地乐观插入、尚未被服务端确认的轮次。 */
  optimistic: RenderTurn[];
  approval: PendingApproval | null;
  userInput: PendingUserInput | null;
  /** 视图可能已过期（收到 gap / dropped）。UI 应展示"刷新中"而不是假装还连着。 */
  stale: boolean;
  /** 本地已发出但服务端还没回 `run_accepted`。 */
  pendingSend: boolean;
  /**
   本地乐观那条对应的**提交身份**；`null` = 它已经被权威轮次覆盖（或没有）。

   ⚠️ 与 `pendingSend` 不是一件事，这也是它必须单独存在的理由：
   `pendingSend` 只回答"服务端回过帧没有"（`applyDelta` 收到**任何**一帧就把它清掉），
   而界面要回答的是"**我这句话**在服务端出现了没有"。后者只能等到覆盖它的那一轮
   用户轮次到达——中途别的事件（工具进度、别人的轮次）都不算数。
   覆盖的判断在 `applySnapshot` / `applyDelta` 的 run 视图分支里（`hasServerTurn`）。
   */
  pendingInvocationId: string | null;
  /**
   服务端明确拒了这一次提交（`run_rejected`，带 invocation_id）。

   有它的时候那条乐观消息**仍然留在 `optimistic` 里**——这正是要的效果：用户说得出口的
   话不该因为一次失败就消失（他说完就走了，回来只看到空屏）。区别只是它现在有了
   一个真正的动作"重试"，而不是永远停在"等确认"。
   */
  sendFailure: SendFailure | null;
  /**
   往前翻页的游标（`before_message_id`）：当前这一页里 **最老那一轮**的消息 id。
   `null` = 没有更早的（或还没有可翻的历史），界面据此不给"加载更早"入口。

   规则与判据在 `features/chat/historyPage.ts`（纯函数、有单测）。
   */
  olderCursor: string | null;
  /** 服务端已经明确回答"没有更早的了"（空页）。这时不许再请求。 */
  olderExhausted: boolean;
  /** 上一次往前翻页失败的原因（i18n key）。`null` = 没有失败过。 */
  olderError: string | null;
}

export const initialChatState: ChatState = {
  epoch: null,
  seq: 0,
  runId: null,
  runStatus: null,
  runError: null,
  runLeaseExpiresAt: null,
  running: false,
  runTurnId: null,
  liveUserTurns: [],
  blocks: {},
  order: [],
  streams: {},
  progress: {},
  history: [],
  optimistic: [],
  approval: null,
  userInput: null,
  stale: false,
  pendingSend: false,
  pendingInvocationId: null,
  sendFailure: null,
  olderCursor: null,
  olderExhausted: false,
  olderError: null,
};

// ---------------------------------------------------------------- 消息 → 渲染块

/** 把一条 UIMessage 变成渲染块。`stream` 是该 id 上还没并入的流式增量。 */
export function blocksFromMessage(
  message: UIMessage,
  stream?: { type: 'text' | 'reasoning'; content: string },
): RenderBlock[] {
  const key = `m${message.id}`;
  const blocks: RenderBlock[] = [];

  switch (message.type) {
    case 'text':
    case 'reasoning': {
      const appended = stream !== undefined && stream.type === message.type ? stream.content : '';
      const text = (message.content ?? '') + appended;
      /**
       空白内容的块**不产生渲染块**。

       `text === ''` 不够：有的 provider 先发一条空的 thinking 帧、或者只发一个换行，
       于是 UI 上出现"一个盒子 + 展开思考 + 里面什么都没有"。aiden 2026-09-17 的原话是
       "有的模型没有 thinking 字段"——**没有内容就不该出现那套 UI**，所以判据放在这里，
       在块生成之前。原生侧 `TranscriptDisplayRow.shows` 是同一判据的第二道闸。
       */
      if (text.trim() === '') break;
      const streaming = appended !== '';
      if (message.type === 'text') {
        blocks.push({ kind: 'text', key, text, streaming });
      } else {
        blocks.push({
          kind: 'reasoning',
          key,
          text,
          streaming,
          durationMs: message.reasoning_timing?.duration_ms,
        });
      }
      break;
    }
    case 'tool': {
      const input = message.input;
      // 工具卡片的一行标题：优先取 input.command（执行类工具），退回工具名。
      let title = message.name ?? '';
      if (input !== null && typeof input === 'object' && 'command' in input) {
        title = String((input as { command: unknown }).command);
      }
      blocks.push({
        kind: 'tool',
        key,
        name: message.name ?? '',
        title,
        status: toolStatusFrom(message),
        input,
        output: message.output,
        location: message.execution_location?.name,
      });
      break;
    }
    case 'error':
      blocks.push({ kind: 'error', key, text: message.content ?? '', code: message.code });
      break;
    case 'notice':
      blocks.push({ kind: 'notice', key, text: message.content ?? '', code: message.name });
      break;
    case 'attachments':
      blocks.push({
        kind: 'attachments',
        key,
        items: (message.attachments ?? []).map(attachmentRef),
      });
      break;
    default:
      // 服务端可能加新块类型。静默丢弃比崩溃好，Debug 页能看出来。
      break;
  }

  return blocks;
}

/** 用户轮次（`role: 'user'`）变成一条渲染消息。 */
function userTurnToMessage(turn: UITurn): RenderMessage {
  const blocks: RenderBlock[] = [];
  if (typeof turn.text === 'string' && turn.text !== '') {
    blocks.push({ kind: 'text', key: `${turn.turn_id}:text`, text: turn.text, streaming: false });
  }
  if (turn.attachments !== undefined && turn.attachments.length > 0) {
    blocks.push({
      kind: 'attachments',
      key: `${turn.turn_id}:attachments`,
      items: turn.attachments.map(attachmentRef),
    });
  }
  return {
    key: turn.turn_id,
    role: 'user',
    blocks,
    turnKey: turn.turn_id,
    createdAt: turn.timestamp,
  };
}

/** 助手轮次（`role: 'assistant'`）变成一条渲染消息。 */
function assistantTurnToMessage(turn: UITurn, streams: StreamMap): RenderMessage {
  const blocks: RenderBlock[] = [];
  for (const message of turn.messages ?? []) {
    blocks.push(...blocksFromMessage(message, streams[String(message.id)]));
  }
  return {
    key: turn.turn_id,
    role: 'assistant',
    blocks,
    turnKey: turn.turn_id,
    createdAt: turn.timestamp,
  };
}

function positionOf(turn: UITurn, fallback: number): number {
  return typeof turn.turn_position === 'number' ? turn.turn_position : fallback;
}

/**
 * 把服务端轮次列表组装成渲染轮次。
 *
 * `turn_position` 是准入时预留的不可变序号——排序用它，**不要**用时间戳或文本推。
 * 同一 `turn_id` 的 user 与 assistant 轮次会合并进同一个 `RenderTurn`。
 */
export function renderTurns(turns: UITurn[], streams: StreamMap): RenderTurn[] {
  const byKey = new Map<string, RenderTurn>();
  let fallback = 0;

  for (const turn of turns) {
    const existing = byKey.get(turn.turn_id);
    const message =
      turn.role === 'user' ? userTurnToMessage(turn) : assistantTurnToMessage(turn, streams);
    if (existing !== undefined) {
      if (turn.role === 'user') existing.user = message;
      else existing.assistant = message;
      continue;
    }
    byKey.set(turn.turn_id, {
      key: turn.turn_id,
      position: positionOf(turn, fallback),
      user: turn.role === 'user' ? message : undefined,
      assistant: turn.role === 'assistant' ? message : undefined,
      active: false,
    });
    fallback += 1;
  }

  return [...byKey.values()].sort((a, b) => a.position - b.position);
}

function mergeTurns(base: RenderTurn[], overlay: RenderTurn[]): RenderTurn[] {
  const byKey = new Map<string, RenderTurn>();
  for (const turn of base) byKey.set(turn.key, turn);
  for (const turn of overlay) {
    const existing = byKey.get(turn.key);
    byKey.set(turn.key, existing === undefined ? turn : { ...existing, ...turn });
  }
  return [...byKey.values()].sort((a, b) => a.position - b.position);
}

// ---------------------------------------------------------------- 决策提取

function toApprovalChoice(option: { id: string; name?: string; kind?: string }): ApprovalChoice {
  return { id: option.id, label: option.name, tone: approvalTone(option.id, option.kind) };
}

/** 没有 label 时的本地化兜底文案 key。 */
export function fallbackLabelKey(choice: ApprovalChoice): string {
  return fallbackOptionKey(choice.id);
}

function isPending(status: string | undefined): boolean {
  return status === 'pending' || status === 'waiting';
}

/**
 * 审批的兜底选项。
 *
 * ⚠️ 服务端**不保证**给 `options`。实测（`tools/approval-shape.mjs`）：当 agent 没有
 * 定义权限选项时，approval 里只有 `{approval_id, short_id, status, can_approve}`——
 * 没有 options。
 *
 * 这时必须给出"批准 / 拒绝"两个动作，否则界面上是一个**没有按钮的审批框**，
 * run 永远停在 `waiting_decision`，用户完全不知道为什么不动了。
 * 官方 Web 客户端也是这个回退逻辑（`tool-approval-actions.vue`）。
 *
 * ⚠️ 兜底动作**不带 option_id**：带一个 agent 没定义过的 id 会让服务端无法匹配，
 * 决策由 `decision: 'approve' | 'reject'` 表达。
 */
export const FALLBACK_APPROVAL_OPTIONS: ApprovalChoice[] = [
  { id: '__fallback_approve__', tone: 'allow', label: 'approval.allowOnce' },
  { id: '__fallback_reject__', tone: 'reject', label: 'approval.rejectOnce' },
];

/** 这个选项是不是我们造出来的兜底动作（决定要不要回传 option_id）。 */
export function isFallbackOption(optionId: string): boolean {
  return optionId.startsWith('__fallback_');
}

/** 兜底动作对应的决策。 */
export function decisionForFallback(optionId: string): 'approve' | 'reject' {
  return optionId === '__fallback_reject__' ? 'reject' : 'approve';
}

/** 从整块内容里找出待处理的审批。已决的不再展示。 */
function approvalFromBlocks(blocks: Record<string, UIMessage>): PendingApproval | null {
  for (const message of Object.values(blocks)) {
    const approval = message.approval;
    if (approval === undefined || approval.approval_id === '') continue;
    if (!isPending(approval.status)) continue;
    if (approval.can_approve === false) continue;

    const agentOptions = (approval.options ?? []).map(toApprovalChoice);
    return {
      approvalId: approval.approval_id,
      shortId: approval.short_id,
      runId: '',
      sessionId: '',
      toolName: message.name ?? '',
      toolInput: message.input,
      // agent 没给选项时用兜底，而不是给一个空数组——空数组会让审批框没有按钮。
      options: agentOptions.length > 0 ? agentOptions : FALLBACK_APPROVAL_OPTIONS,
      canApprove: true,
    };
  }
  return null;
}

function questionFrom(raw: {
  id: string;
  text: string;
  kind: string;
  options?: { id: string; label: string; description?: string }[];
  allow_custom?: boolean;
  custom_exclusive?: boolean;
  required?: boolean;
  placeholder?: string;
}): PendingQuestion {
  return {
    questionId: raw.id,
    text: raw.text,
    kind: raw.kind,
    options: raw.options ?? [],
    /**
     * 这两个默认值**必须**与上游 Web 客户端一致，不能按"字段缺省 = false"的直觉写。
     *
     * `allow_custom`：服务端 `UIQuestion.AllowCustom` 是 `bool,omitempty`，校验里
     * `customText != "" && !AllowCustom` 直接报错「does not allow a custom answer」。
     * 所以缺省是**不允许**自定义；写成 `!== false`（缺省允许）会让用户在自认为
     * 合规的情况下提交一个被服务端硬拒的答案。
     *
     * `required`：服务端是**三态** `*bool`（`questionIsExplicitlyRequired` =
     * `Required != nil && *Required`）。缺省表示"老式 ask_user 载荷"，上游 Web
     * 的政策是**必须回答**（`required !== false`）——ACP 表单才会显式给 false。
     * 写成 `=== true`（缺省不必答）会放用户提交空表单，agent 那一轮白转。
     */
    allowCustom: raw.allow_custom === true,
    customExclusive: raw.custom_exclusive === true,
    required: raw.required !== false,
    placeholder: raw.placeholder,
  };
}

/** 从整块内容里找出 agent 的提问。它走审批同一套决策机制。 */
function userInputFromBlocks(blocks: Record<string, UIMessage>): PendingUserInput | null {
  for (const message of Object.values(blocks)) {
    const input = message.user_input;
    if (input === undefined || input.user_input_id === '') continue;
    if (!isPending(input.status)) continue;
    if (input.can_respond === false) continue;
    return {
      userInputId: input.user_input_id,
      shortId: input.short_id,
      runId: '',
      sessionId: '',
      questions: (input.questions ?? []).map(questionFrom),
    };
  }
  return null;
}

function withDecisions(state: ChatState): ChatState {
  return {
    ...state,
    approval: approvalFromBlocks(state.blocks),
    userInput: userInputFromBlocks(state.blocks),
  };
}

// ---------------------------------------------------------------- 归约

function applyUpserts(state: ChatState, upserts: UIMessage[]): ChatState {
  if (upserts.length === 0) return state;
  const blocks = { ...state.blocks };
  const order = [...state.order];
  const streams = { ...state.streams };

  for (const message of upserts) {
    const key = String(message.id);
    blocks[key] = message;
    // 顺序按"这个 id 第一次出现"记，追加通道过来的也一样（见 `applyAppends`）。
    if (!order.includes(message.id)) order.push(message.id);
    // 整块内容到达后，该消息的流式缓冲已经并进去了，删掉避免重复累加。
    delete streams[key];
  }

  return { ...state, blocks, order, streams };
}

function applyAppends(
  state: ChatState,
  appends: { id: number; type: string; content: string }[],
): ChatState {
  if (appends.length === 0) return state;
  const streams: StreamMap = { ...state.streams };
  const order = [...state.order];
  for (const append of appends) {
    const key = String(append.id);
    const type = append.type === 'reasoning' ? 'reasoning' : 'text';
    /**
     顺序也要在这里登记。

     ⚠️ 这是一处真实出现过的顺序错乱（一台模拟器截图就能看见）：

     流式文本**只有 append 通道**（`text_delta` → `message_appends`），而工具块**只有
     upsert 通道**（`tool_call_start/end` → `message_upserts`，一次一条）。所以只按
     upsert 登记顺序时，`blocks` 里只有工具、`streams` 里只有文字，渲染出来的顺序是
     「**全部工具** → **全部文字**」——真实的回合「文字 → 工具 → 文字 → 工具 → 文字」
     在屏幕上变成「工具行 / 文字 / 文字 / 文字」：先说的那句话跑到工具行下面去了，
     而且每多一个工具调用，工具行都插到所有已显示文字的上方。

     上游的分配顺序也是这么说的：块 id 是一个单调计数器，**客户端的块顺序就是 id 顺序**
     （`internal/agent/view/uimessage_stream.go` 的 `uiEmittedBlock` 注释）。

     所以顺序按"第一次见到这个 id"记，与它来自哪个通道无关。这样流式期间与终态
     （`agent_end` 把整轮重发一遍）显示的顺序是同一个，不会在收尾时再跳一次。
     */
    if (!order.includes(append.id)) order.push(append.id);
    const existing = streams[key];
    if (existing !== undefined && existing.type === type) {
      // 同一个 id 的同类增量：追加。这就是本 reducer 存在的理由。
      streams[key] = { type, content: existing.content + append.content };
    } else {
      streams[key] = { type, content: append.content };
    }
  }
  return { ...state, streams, order };
}

function applyProgressAppends(
  state: ChatState,
  appends: { id: number; progress: unknown; input?: unknown }[],
): ChatState {
  if (appends.length === 0) return state;
  const progress = { ...state.progress };
  const blocks = { ...state.blocks };
  for (const append of appends) {
    const key = String(append.id);
    progress[key] = [...(progress[key] ?? []), append.progress];
    // 进度帧可能带来更新的 input（工具开始跑之后才拿到参数），补进整块消息。
    const existing = blocks[key];
    if (existing !== undefined && append.input !== undefined) {
      blocks[key] = { ...existing, input: append.input };
    }
  }
  return { ...state, progress, blocks };
}

export function isRunActive(status: RunStatus | null | undefined): boolean {
  if (status === null || status === undefined) return false;
  return (
    status === 'admitting' ||
    status === 'running' ||
    status === 'waiting_decision' ||
    status === 'finishing' ||
    status === 'aborting'
  );
}

/** 历史里是不是已经有这一轮的助手输出（按**身份**认，`turn_id`）。 */
function historyShowsTurn(history: RenderTurn[], turnId: string | null | undefined): boolean {
  if (typeof turnId !== 'string' || turnId === '') return false;
  const turn = history.find((candidate) => candidate.key === turnId);
  return (turn?.assistant?.blocks.length ?? 0) > 0;
}

/**
 `run.turn_id` 缺失时的兜底：历史里是不是已经画出了同一批消息 id。

 协议里 `turn_id` 是可选字段（`CurrentRunView.turn_id?`），实测这条部署会给。缺了它
 也不能退回"看到 completed 就整段丢"——那会在重连窗口把屏幕清空（见
 `representedInHistory`）。这里按消息 id 再认一次：`blocks` 的 key 就是消息 id，
 渲染块的 key 是 `m<id>`。
 */
function historyShowsMessages(history: RenderTurn[], ids: readonly string[]): boolean {
  if (ids.length === 0) return false;
  return history.some((turn) => {
    const shown = new Set((turn.assistant?.blocks ?? []).map((block) => block.key));
    return ids.every((id) => shown.has(`m${id}`));
  });
}

/**
 这一轮**已经在历史里画出来了**吗——也就是"实时那份可以让位了吗"。

 这是本轮修的那个缺陷的唯一判据，三条路共用它：

 - `applySnapshot` / `applyDelta`（run 视图分支）：真 → 不再把 `run.messages` 当活跃
   输出收进 `blocks`（`turnsForDisplay` 也就不会再多画一个 `__live__` 轮次）；
 - `applyHistory`：**真 → 才允许**清掉活跃缓冲（`blocks` / `streams` / `liveUserTurns`）。

 为什么不能写成"快照里有 completed 就整段丢"（最容易想到的那种修法）：服务端在 run
 结束后**仍然长期带着**这个 run 视图（实测 11 小时后还在），而 REST 历史要等轮次屏障
 才落盘。只看状态的话，"run 刚结束、历史还没刷回来"那一小段里客户端会把屏幕上唯一的
 那份回答丢掉——用户看到的是**整段对话突然少一条**。反过来只看"历史非空"也不行：那是
 别的轮次，同样会丢内容。

 正在跑的 run（`active`）永远不算"已被历史代表"：它还没落盘，历史里不可能有它
 （`docs/research/verified-behaviour.md` §1）。
 */
function representedInHistory(
  history: RenderTurn[],
  turnId: string | null,
  active: boolean,
  ids: readonly string[],
): boolean {
  if (historyShowsTurn(history, turnId)) return true;
  if (active) return false;
  return historyShowsMessages(history, ids);
}

/**
 * 应用一条 snapshot。snapshot 是**权威状态**：直接覆盖，不尝试与本地合并。
 * 服务端明确不做增量补齐（"在客户端位置和现在之间合成增量等于伪造历史"）。
 *
 * ⚠️ 唯一的例外见 `representedInHistory`：一个**已经落进历史**的终态 run 视图不再
 * 收进 `blocks`。这不是"不信任快照"——内容一个字都没丢，它就在 `history` 里，而且那份
 * 带 `reasoning_timing`（实时投影不带，见 `blocksFromMessage`）。收进来的后果是
 * `turnsForDisplay` 把同一轮画两遍，带时长的那份被顶出屏幕。
 */
export function applySnapshot(state: ChatState, payload: RuntimeSnapshotPayload): ChatState {
  const run: CurrentRunView | null = payload.current_run_view ?? null;
  const covered = coverOptimistic(state, run, run?.user_turns);

  const runBlocks: Record<string, UIMessage> = {};
  const runOrder: number[] = [];
  for (const message of run?.messages ?? []) {
    runBlocks[String(message.id)] = message;
    runOrder.push(message.id);
  }
  /**
   历史里已经有这一轮 → 这份实时投影只是同一轮的**旧副本**，不画。
   （历史里还没有它 → 原样收下：那正是"run 刚结束、历史还没刷回来"的重连窗口，
   丢了屏幕上就空了。）
   */
  const represented =
    run !== null &&
    representedInHistory(
      state.history,
      run.turn_id ?? null,
      isRunActive(run.status),
      Object.keys(runBlocks),
    );
  const blocks = represented ? {} : runBlocks;
  const order = represented ? [] : runOrder;

  const base: ChatState = {
    ...initialChatState,
    epoch: payload.epoch,
    seq: payload.seq,
    // 历史由 REST 维护；snapshot 只负责活跃 run 的部分。
    history: state.history,
    // 服务端给出这一轮的用户输入之后，才可以丢掉本地的乐观副本。
    ...covered,
    runId: run?.run_id ?? null,
    runStatus: run?.status ?? null,
    runError: typeof run?.error === 'string' && run.error !== '' ? run.error : null,
    runLeaseExpiresAt: run?.owner_lease_expires_at ?? null,
    running: isRunActive(run?.status),
    runTurnId: run?.turn_id ?? null,
    liveUserTurns: run?.user_turns ?? [],
    blocks,
    order,
  };

  return withDecisions(base);
}

/** `local-<invocationId>`：乐观轮次的 key 与"它属于哪次提交"的唯一对应。 */
function pendingKey(state: ChatState): string {
  return `local-${state.pendingInvocationId ?? ''}`;
}

/** 一条渲染轮次里用户说的那句话（多个 text 块拼起来；没有就是空串）。 */
function turnText(turn: RenderTurn): string {
  const blocks = turn.user?.blocks ?? [];
  return blocks
    .map((block) => (block.kind === 'text' ? block.text : ''))
    .join('')
    .trim();
}

/**
 服务端广播回来的用户轮次里，有没有**和本地那条一模一样**的一句。

 ⚠️ 这条判据（除了比 invocation_id）不是多余的：服务端回显用户轮次的通道是
 `runtime_delta.user_turn_upserts`，而**那一帧里没有 `invocation_id`**
 （形状见 `verification/fixture/server.mjs` 的回显分支与 `docs/research/memoh-api.md`）。
 只按 id 认的话，这一类回显会让同一句话在屏幕上出现**两个气泡**。

 正文相同时丢掉本地那份**不会让任何内容消失**——权威那份已经在同一帧里画出来了
 （`renderTurns(state.liveUserTurns, …)`），所以这不是"猜"，只是不重复。
 */
function serverEchoes(state: ChatState, turns: readonly UITurn[] | undefined): boolean {
  const pending = state.optimistic.find((turn) => turn.key === pendingKey(state));
  if (pending === undefined) return false;
  const text = turnText(pending);
  if (text === '') return false;
  return (turns ?? []).some((turn) => turn.role === 'user' && (turn.text ?? '').trim() === text);
}

/** 这一条本地乐观消息是不是已经被权威内容覆盖了。 */
function isCovered(
  state: ChatState,
  run: CurrentRunView | null,
  incoming: readonly UITurn[] | undefined,
  turn: RenderTurn,
): boolean {
  return hasServerTurn(run, turn.key) || serverEchoes(state, incoming);
}

/**
 按"覆盖了没有"收一次本地乐观内容。

 返回的三个字段是一起变的：只要那条消息还有一条没被覆盖，`pendingInvocationId` 与
 `sendFailure` 就都要留着（界面靠它们说"这句话现在在哪儿"）。
 */
function coverOptimistic(
  state: ChatState,
  run: CurrentRunView | null,
  incoming: readonly UITurn[] | undefined,
): Pick<ChatState, 'optimistic' | 'pendingInvocationId' | 'sendFailure'> {
  const optimistic = state.optimistic.filter((turn) => !isCovered(state, run, incoming, turn));
  const stillPending = optimistic.some((turn) => turn.key === pendingKey(state));
  if (stillPending) {
    return {
      optimistic,
      pendingInvocationId: state.pendingInvocationId,
      sendFailure: state.sendFailure,
    };
  }
  return { optimistic, pendingInvocationId: null, sendFailure: null };
}

/** 服务端是否已经有这个 turn（用于清掉对应的乐观占位）。 */
/**
 * 服务端是否已经能替代这条本地乐观消息。
 *
 * ⚠️ 只有在**真的拿到了服务端的用户轮次**时才算数。早期版本只看
 * `run.invocation_id === invocationId`，结果 run 跑到 `admitting`（此时
 * `user_turns` 还是 null）就把乐观消息清了，屏幕上用户提问直接消失，只剩助手回复。
 *
 * 判据是"服务端有没有给出这一轮的用户输入"，不是"服务端知不知道这个 invocation"。
 */
function hasServerTurn(run: CurrentRunView | null, key: string): boolean {
  if (!key.startsWith('local-')) return false;
  const invocationId = key.slice('local-'.length);
  if (run?.invocation_id !== invocationId) return false;
  return (run.user_turns?.length ?? 0) > 0;
}

/**
 * 应用一条 delta。
 *
 * `epoch` 与本地不一致时**不做增量合并**——跨 epoch 的 seq 没有意义，唯一正确的
 * 反应是丢弃并等新 snapshot。调用方（realtime）已经会重订阅，这里只标记过期。
 */
export function applyDelta(
  state: ChatState,
  epoch: string,
  seq: number,
  delta: RuntimeDelta,
): ChatState {
  if (state.epoch !== null && state.epoch !== epoch) {
    return { ...state, stale: true };
  }

  let next: ChatState = { ...state, epoch, seq, pendingSend: false };

  if (delta.reset_messages === true) {
    // 服务端 `retry`：丢弃本地推测的流式内容，保留已确认的整块历史。
    next = {
      ...next,
      streams: {},
      progress: {},
      blocks: {},
      order: [],
      stale: false,
      optimistic: [],
    };
  }

  next = applyUpserts(next, delta.message_upserts ?? []);
  next = applyAppends(next, delta.message_appends ?? []);
  next = applyProgressAppends(next, delta.progress_appends ?? []);

  if (delta.user_turn_upserts !== undefined && delta.user_turn_upserts.length > 0) {
    /**
     服务端广播了用户轮次。这一帧里**没有 invocation_id**（协议形状如此），所以覆盖
     判断只有"正文一样"这一条路可走——见 `serverEchoes` 的注释。认出来了就顺手把本地
     那条收起来，否则屏幕上同一句话会画两个气泡。
     */
    next = {
      ...next,
      liveUserTurns: mergeUserTurns(next.liveUserTurns, delta.user_turn_upserts),
      ...coverOptimistic(next, null, delta.user_turn_upserts),
    };
  }

  if (delta.current_run_view !== undefined) {
    const run = delta.current_run_view;
    const runBlocks: Record<string, UIMessage> = {};
    const runOrder: number[] = [];
    for (const message of run?.messages ?? []) {
      runBlocks[String(message.id)] = message;
      runOrder.push(message.id);
    }
    /**
     与 `applySnapshot` 同一条判据（`representedInHistory`）：这一轮已经在历史里画出来了
     就不再收进 `blocks`——否则重连拿回的终态 run 视图会在历史后面再画一遍同一轮。
     历史里还没有它时照收（重连窗口不许清屏）。
     */
    const represented =
      run !== null &&
      run !== undefined &&
      representedInHistory(
        next.history,
        run.turn_id ?? null,
        isRunActive(run.status),
        Object.keys(runBlocks),
      );
    /**
     与 `applySnapshot` **同一套覆盖判断**（`coverOptimistic`）。

     少了它会出现界面上最难看的一种错：服务端把自己的回显放进 `liveUserTurns` 的同时，
     本地那条乐观消息还在 `optimistic` 里——`turnsForDisplay` 现在两份都画，屏幕上
     就是同一句话两个气泡。判据不是"服务端有没有给轮次"（那是旧版本清早了的错：
     run 跑到 admitting 时 user_turns 还是 null），而是"给的是不是**这一条**"。
     */
    next = {
      ...next,
      blocks: represented ? {} : runBlocks,
      order: represented ? [] : runOrder,
      runId: run?.run_id ?? null,
      runStatus: run?.status ?? null,
      runError: run?.error ?? null,
      running: isRunActive(run?.status),
      runTurnId: run?.turn_id ?? next.runTurnId,
      liveUserTurns: run?.user_turns ?? next.liveUserTurns,
      ...coverOptimistic(next, run, run?.user_turns),
    };
  } else if (delta.run !== undefined && delta.run !== null) {
    const run = delta.run;
    next = {
      ...next,
      runId: run.run_id ?? next.runId,
      runStatus: run.status ?? next.runStatus,
      runError: run.error ?? null,
      runLeaseExpiresAt: run.owner_lease_expires_at ?? next.runLeaseExpiresAt,
      running: isRunActive(run.status),
    };
  }

  return withDecisions(next);
}

function mergeUserTurns(existing: UITurn[], incoming: UITurn[]): UITurn[] {
  const byId = new Map<string, UITurn>();
  for (const turn of existing) byId.set(turn.turn_id, turn);
  for (const turn of incoming) byId.set(turn.turn_id, turn);
  return [...byId.values()];
}

/**
 * 用 REST 历史覆盖已完成轮次。活跃 run 的内容由 snapshot/delta 维护。
 *
 * ⚠️ 必须同时清掉**活跃 run 的快照**，否则屏幕上会出现两份：历史里合并好的那一条，
 * 加上 live 视图里还没收起来的另一份。
 *
 * ⚠️ 但**清的条件是"这一轮已经在历史里画出来了"**（`representedInHistory`），不是
 * "历史到了就清"。这个函数在"打开会话"和"run 刚结束"两个时机被调用，而这两处都可能撞上
 * "屏幕上的内容历史里还没有"：
 *
 * - **重连窗口**：run 刚结束、REST 历史还没到轮次屏障（上游要到屏障才落盘），这一轮不在
 *   返回的页里。无条件清掉 = 屏幕上**唯一那份回答消失**，用户看到整段对话少一条；
 * - **正在跑的那一轮**：历史里同样没有它（`docs/research/verified-behaviour.md` §1）。
 *   清掉的话，打开一个正在跑的会话、历史比快照先回来时，流式正文会闪没。
 *
 * ⚠️ 另外**本地那条乐观消息不能无条件清**（本轮修的第二处）：判据与 snapshot/delta
 * 同一套——**历史里真的出现了这一句**才让位（`coverOptimistic`）。实测
 * （`tools/pending-echo-probe.mjs`，部署实例）：发出去之后、这一轮还没落盘的时候拉一次
 * 历史，本地那条如果被清掉，屏幕上就**一句话都没有**了。
 */
export function applyHistory(state: ChatState, turns: UITurn[]): ChatState {
  const rendered = renderTurns(turns, {});
  /**
   历史里已经有当前这一轮 → 活跃缓冲可以让位（常态：run 结束 → 拉历史 → 收摊）。
   历史里没有它 → 一块都不许清：那正是"run 刚结束、历史还没刷回来"的重连窗口。
   */
  const represented = representedInHistory(
    rendered,
    state.runTurnId,
    isRunActive(state.runStatus),
    Object.keys(state.blocks),
  );
  return {
    ...state,
    history: rendered,
    // 权威历史到了：本地乐观那条**只在被覆盖时**收起来。
    ...coverOptimistic(state, null, turns),
    ...(represented ? { liveUserTurns: [], blocks: {}, order: [], streams: {}, progress: {} } : {}),
    pendingSend: false,
    // 这是**最新**那一页：往回翻的起点跟着它重算（上一轮的"到底"结论不能带过来）。
    olderCursor: olderCursorOf(turns),
    olderExhausted: false,
    olderError: null,
  };
}

/**
 * 往前接一页更老的历史（`before_message_id` 那一页）。
 *
 * 与 `applyHistory` 的区别是**它什么都不清**：整页刷新代表"屏幕上的内容由服务端重讲一遍"，
 * 所以活跃 run 的缓冲要收起来；而往前翻页只是往上补老内容，正在跑的那一轮（`blocks` /
 * `streams` / `liveUserTurns` / 待发状态）必须原样留着——清掉的话用户翻一次历史就看到
 * 回复闪断。
 *
 * 覆盖与去重的判据：
 *
 * - 服务端的页首会**延伸到轮次边界**（`extendToUITurnHead`），所以边界那一轮会与上一页
 *   重叠 → 按 `turn_id` 合并（`mergeTurns`），已有的版本优先，不产生重复行；
 * - 排序看 `turn_position`（不可变序号），不看到达顺序——所以往上接的老轮次会自己排到
 *   前面去。
 * - 空页 = 服务端明确说"没有更早的了"；一整页全是已经加载过的内容也当到底（防原地打转，
 *   详见 `historyPage.ts`）。
 */
export function prependHistory(state: ChatState, turns: UITurn[]): ChatState {
  const page = renderTurns(turns, {});
  const existingKeys = state.history.map((turn) => turn.key);
  if (page.length === 0 || !pageBringsNewTurns(existingKeys, turns)) {
    return { ...state, olderCursor: null, olderExhausted: true, olderError: null };
  }
  return {
    ...state,
    history: mergeTurns(page, state.history),
    olderCursor: olderCursorOf(turns),
    olderExhausted: false,
    olderError: null,
  };
}

/**
 * 往前翻页失败。
 *
 * **游标留着**：失败不等于"没有更早的了"——把它当成到底，用户就再也翻不到旧内容了
 * （而那正是本轮要修的东西）。界面照实说一句，用户可以再试。
 */
export function olderHistoryFailed(state: ChatState, errorKey: string): ChatState {
  return { ...state, olderError: errorKey };
}

// ---------------------------------------------------------------- 本地动作

/** 本地乐观插入一条用户消息。服务端确认后会被替换。 */
export function appendOptimisticUserMessage(
  state: ChatState,
  text: string,
  invocationId: string,
): ChatState {
  const key = `local-${invocationId}`;
  const message: RenderMessage = {
    key,
    role: 'user',
    blocks: [{ kind: 'text', key: `${key}:text`, text, streaming: false }],
  };
  return {
    ...state,
    pendingSend: true,
    pendingInvocationId: invocationId,
    sendFailure: null,
    optimistic: [
      ...state.optimistic,
      { key, position: Number.MAX_SAFE_INTEGER, user: message, active: true },
    ],
  };
}

/**
 * 服务端拒了这一次提交（`run_rejected`）。
 *
 * **不撤那条乐观消息**：用户的这句话要一直看得见（"我发的话一直看得见"），区别只是
 * 它从"等确认"变成"没发出去 + 可以重试"。撤掉的话用户回来只看到空屏、草稿也没了，
 * 那句话就真的丢了。
 *
 * 只有 `invocation_id` 对得上才认——否则一次误发的 rejection 会把别的一条标成失败。
 */
export function rejectPendingSend(
  state: ChatState,
  invocationId: string,
  failure: { code?: string; message?: string },
): ChatState {
  if (invocationId === '' || state.pendingInvocationId !== invocationId) return state;
  const sendFailure: SendFailure = {
    invocationId,
    code: failure.code ?? '',
    message: failure.message ?? '',
  };
  return { ...state, pendingSend: false, sendFailure };
}

/** 发送失败：撤掉乐观消息，让界面回到能重试的状态。 */
export function dropOptimistic(state: ChatState, invocationId: string): ChatState {
  const key = `local-${invocationId}`;
  return {
    ...state,
    pendingSend: false,
    pendingInvocationId: null,
    sendFailure: null,
    optimistic: state.optimistic.filter((turn) => turn.key !== key),
  };
}

/** 审批已回应：本地立刻清掉，不等服务端回执（回执失败会由 snapshot 纠正）。 */
export function clearApproval(state: ChatState): ChatState {
  return { ...state, approval: null };
}

export function clearUserInput(state: ChatState): ChatState {
  return { ...state, userInput: null };
}

export function markStale(state: ChatState, stale: boolean): ChatState {
  return { ...state, stale };
}

/**
 * owner 的租约是否已过期——也就是"这个 run 已经没人管了"。
 *
 * ## 为什么必须有这个判断
 *
 * 实测（`tools/orphan-run-probe.mjs`）：run **正常失败**时投影会给出 `errored`，
 * 重订阅也能拿到终态。但 owner 进程死掉时（上游偶发，见
 * `docs/research/verified-behaviour.md`），投影会**永远停在 `running`**：
 * 不报错、不收敛、也不再有任何帧。
 *
 * 没有这个判断，界面就是永远转圈——用户唯一的出路是杀进程，而且不知道原因。
 * 租约是服务端给的（`owner_lease_expires_at`），所以这个判断不依赖我们猜。
 *
 * @param now 当前时间，便于测试注入。
 */
export function isRunAbandoned(state: ChatState, now: number = Date.now()): boolean {
  if (!state.running) return false;
  if (state.runLeaseExpiresAt === null) return false;
  const expiry = Date.parse(state.runLeaseExpiresAt);
  if (Number.isNaN(expiry)) return false;
  return expiry < now;
}

/**
 * 把"owner 已消失"落成终态。
 *
 * 状态变成 `errored` 并附可读原因，界面就能显示失败、用户就能重试或继续输入——
 * 而不是对着一个转不完的圈。之后如果服务端补发了真实终态帧，`applyDelta` 会照常
 * 覆盖它（那时以服务端为准）。
 */
export function settleAbandonedRun(state: ChatState, now: number = Date.now()): ChatState {
  if (!isRunAbandoned(state, now)) return state;
  return {
    ...state,
    running: false,
    runStatus: 'errored',
    runError: 'error.runAbandoned',
  };
}

/** 重连/切换会话时重置实时部分，保留历史。 */
export function resetLive(state: ChatState): ChatState {
  return {
    ...initialChatState,
    history: state.history,
    optimistic: state.optimistic,
  };
}

// ---------------------------------------------------------------- 给 UI 的合并视图

/**
 只有流式缓冲、还没有整块消息的块（流式中的文字与思考就是这样）。

 key 用 `m<id>`——**和整块消息到达后 `blocksFromMessage` 给出的 key 一样**。不能让它
 从 `s<id>` 变成 `m<id>`：原生列表把 key 当**行的身份**（`TranscriptRow.ID.block`），
 身份一变就会被当成"旧行删除 + 新行插入"，那一行的展开状态会丢、高度会重算，
 屏幕上看就是闪一下。
 */
function streamOnlyBlocks(key: string, stream: StreamMap[string] | undefined): RenderBlock[] {
  if (stream === undefined || stream.content === '') return [];
  return [{ kind: stream.type, key: `m${key}`, text: stream.content, streaming: true }];
}

/** 活跃 run 的助手侧渲染消息；没有内容时返回 null。 */
function liveAssistantMessage(state: ChatState): RenderMessage | null {
  const blocks: RenderBlock[] = [];
  /**
   严格按照 `order` 渲染，而 `order` 是**两条通道合起来**的到达顺序：upsert 与 append
   谁先把一个 id 带进来，谁就定下它的位置（见 `applyAppends`）。所以流式中的文字不会
   被挤到工具行下面，与终态（整轮重发一遍）的顺序也一致。
   */
  for (const id of state.order) {
    const key = String(id);
    const message = state.blocks[key];
    if (message === undefined) {
      blocks.push(...streamOnlyBlocks(key, state.streams[key]));
      continue;
    }
    blocks.push(...blocksFromMessage(message, state.streams[key]));
  }
  // 兜底：缓冲里出现了没登记过顺序的 id（两条通道都会登记，正常到不了这里）。
  for (const [key, stream] of Object.entries(state.streams)) {
    if (state.order.includes(Number(key))) continue;
    blocks.push(...streamOnlyBlocks(key, stream));
  }
  if (blocks.length === 0) return null;
  return { key: '__live__', role: 'assistant', blocks };
}

/**
 * 展示用轮次。
 *
 * 顺序：已完成历史 → 当前轮的用户输入 → 当前轮的助手输出。
 *
 * ⚠️ 两个曾经踩过的坑，都在这个函数的顺序上：
 *
 * 1. **本地乐观消息必须排在助手输出之前。** 早期版本把它 push 到最后，结果屏幕上是
 *    "助手回复在上、用户提问在下"——顺序反了，看起来像模型抢答。
 *
 * 2. **run 期间服务端不一定给 `user_turns`。** 实测（`tools/turn-probe.mjs`）：
 *    run 跑到 `admitting` 时 `current_run_view.user_turns` 是 `null`，权威的用户轮次
 *    要等 REST 历史才有。所以当 `liveUserTurns` 为空时，**乐观消息就是这一轮的用户
 *    输入**，不能当成"多余的东西"丢掉。
 *
 * 3. **权威的那一份出现时，本地那份不是"被顶掉"，而是"两件东西同时在"**（本轮修的
 *    这一条）。之前的写法是二选一（`liveUserTurns.length > 0 ? liveUser : optimistic`），
 *    于是只要会话里已经有一条带 `user_turns` 的轮次（比如上一轮、或一个 steer 轮次），
 *    刚发出去、服务端还没回显的那句话就**从屏幕上消失**——输入框已经清空，屏幕上什么
 *    都没有，用户完全无法判断话到底出去没有（`docs/research/e2e-suite.md` §4.3 的现场）。
 *
 *    正确的规则是**"这条被覆盖了没有"**，不是"服务端有没有给过用户轮次"：本地那条要留到
 *    覆盖它的权威轮次出现为止。覆盖判断在 reducer 里做（`hasServerTurn` 比 invocation_id），
 *    走到这里时 `optimistic` 里剩下的就是**还没被覆盖的**那些，所以两份都要画。
 */
export function turnsForDisplay(state: ChatState): RenderTurn[] {
  const result = state.history.slice();

  // 当前轮的用户输入：服务端权威的（如果有）+ 本地还没被覆盖的那几条。
  const liveUser =
    state.liveUserTurns.length > 0 ? renderTurns(state.liveUserTurns, state.streams) : [];
  /**
   位置只是给"多条同类轮次"定序用的（原生列表按数组顺序渲染，不看这个值）：

   - 权威用户轮次 `MAX-3`
   - 本地待确认那条 `MAX-2`（**排在权威之后**：它是更晚的那一句）
   - 活跃助手输出 `MAX-1`

   三条互不相同，所以不会出现"同一位置的两个轮次谁先谁后看运气"。
   */
  const userInputs: RenderTurn[] = [
    ...liveUser.map((turn) => ({ ...turn, position: Number.MAX_SAFE_INTEGER - 3 })),
    ...state.optimistic.map((turn) => ({ ...turn, position: Number.MAX_SAFE_INTEGER - 2 })),
  ];
  for (const turn of userInputs) {
    /**
     同一个 turn 只允许出现一次。

     ⚠️ 这是修掉的一个真问题：REST 历史与实时投影**可能同时带着同一轮**——历史里是
     落盘的那一条，实时里是 `current_run_view.user_turns`（steer 轮次是被持久化**并且**
     当作用户轮次广播的，见上游 `PublishQueueUserTurns`）。两条路都走
     `userTurnToMessage`，所以**连块 key 都一样**（`<turn_id>:text`）。

     重复的后果不是"多一条气泡"这种小事：原生列表把 (轮次, 消息, 角色, 块, 类型)
     当作行的身份，**重复身份直接让整份载荷解码失败**（`TranscriptRow.decode` 抛出
     "Duplicate block identity"，那条断言是有意留着的、还有测试钉住）。于是列表保留
     上一帧——用户看到的是**整条对话停住不动**，屏幕为空时更是一句
     "Messages could not be displayed."。

     合并而不是跳过：这条轮次已经在历史里了，就更新它（实时那份更近），位置仍用
     历史给的顺序——它本来就在那个位置上。
     */
    const index = result.findIndex((candidate) => candidate.key === turn.key);
    const existing = index === -1 ? undefined : result[index];
    if (existing === undefined) {
      result.push(turn);
      continue;
    }
    // 复制而不是就地改：`state.history` 里的对象是状态的一部分，不能在这里被写。
    result[index] = { ...existing, user: turn.user ?? existing.user };
  }

  const assistant = liveAssistantMessage(state);
  if (assistant !== null) {
    result.push({
      key: '__live__',
      position: Number.MAX_SAFE_INTEGER - 1,
      assistant: { ...assistant, turnKey: state.runId ?? undefined },
      active: state.running,
    });
  }

  return result;
}

/** 一条轮次是否含任何可渲染内容。用于过滤空轮次，避免出现空气泡。 */
export function hasContent(turn: RenderTurn): boolean {
  return (turn.user?.blocks.length ?? 0) > 0 || (turn.assistant?.blocks.length ?? 0) > 0;
}
