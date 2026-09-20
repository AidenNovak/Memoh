/**
 * 应用级会话状态。
 *
 * 这一层把三样东西接起来：
 *   - REST（`MemohClient`）——列表、历史、账号
 *   - 实时通道（`MemohRealtime`）——一条 bot 一条 WebSocket
 *   - 聊天归约器（`features/chat/reducer`）——纯状态变换
 *
 * 刻意**不**引入状态库：需要共享的东西就这么多，useReducer 够用。参考项目的
 * AGENTS.md 也是这条规矩（"add state libraries only when needed"）。
 *
 * 一个刻意的设计：**当前打开的会话 id 放在 state 里，不放 ref**。实时回调如果靠
 * ref 读，会出现"回调到了但 UI 不知道该更新谁"的竞态；放 state 里，所有订阅都在
 * 同一个渲染周期内拿到一致的值。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { AppState as RNAppState } from 'react-native';

import { ApiError, MemohClient } from '../../api/client.ts';
import { MemohRealtime, type ConnectionState } from '../../api/realtime.ts';
import { canOpenRealtime, type Bot, type Session as MemohSession } from '../../api/types.ts';
import { presentError, type ErrorPresentation } from '../errors/present.ts';
import type { QueueItem, SessionStatus } from '../../models/chat.ts';
import { uuid } from '../../lib/uuid.ts';
import { sessionSourceFromApi } from './sourceLabel.ts';
import { prependSession, uniqueSessions } from './sessionList.ts';
import { SESSION_PAGE_LIMIT, appendSessionPage, cursorFromResponse } from './paging.ts';
import { QueueSubmissionGate, visibleQueueItems, type QueueSupport } from '../chat/queue.ts';
import { approvalResponseFor } from '../chat/approval.ts';
import { closeSessionCache, clearedSessionMaps } from '../chat/streamScheduler.ts';
import {
  isRunActive,
  settleAbandonedRun,
  appendOptimisticUserMessage,
  applyDelta,
  applyHistory,
  applySnapshot,
  clearApproval,
  clearUserInput,
  dropOptimistic,
  initialChatState,
  markStale,
  olderHistoryFailed,
  prependHistory,
  rejectPendingSend,
  type ChatState,
} from './reducer-exports.ts';
import { CANCEL_REASON } from '../chat/userInput.ts';
import {
  coordinatorView,
  createSessionCoordinator,
  type SessionCoordinator,
} from './coordinator.ts';
import { HISTORY_PAGE_LIMIT } from '../chat/historyPage.ts';

/**
 * 会话在列表里的摘要。
 *
 * `title` **可能是空字符串**：服务端允许没有标题（新会话、从 IM 频道建的会话等）。
 * 之前这里用 `id.slice(0,8)` 兜底，结果界面上出现 "fixture-a3f2…" 这种 id 片段——
 * 对用户毫无意义，而且看起来像没做完。
 *
 * 现在保持原样（可能为空），显示时用 `sessionDisplayTitle()`，它走 i18n。
 * 放在渲染层而不是这里的原因：语言可以切换，本地化字符串不该固化进数据。
 */
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  /**
   * 副标题用的来源标记。
   *
   * 会话列表接口**不返回最后一条消息**，所以不能伪造"消息预览"——那会让用户以为
   * 那是真实内容。这里只展示服务端确实给了的字段（来源通道 / 会话类型），
   * 它对"这个会话是从哪来的"这个问题也是有信息量的。
   */
  source: string;
  /**
   * 服务端给的**会话类型**原文（`chat` / `schedule` / …）。
   *
   * `source` 是给人看的一行字（"telegram · chat"），拿它去判类型是在解析展示文案；
   * 而类型决定**哪些动作真的能做**（分叉只有 `chat` 能做，实测非 chat 回 409），
   * 所以原始值要单独留着。见 `features/session/actions.ts`。
   */
  type: string | undefined;
}

interface UiState {
  phase: 'signedOut' | 'ready';
  client: MemohClient | null;
  bots: Bot[];
  currentBotId: string | null;
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  /**
   * 会话列表**取数的**错误（区别于 `error`：那个是入队/删除这类动作失败）。
   *
   * 为什么要单独一个：列表拉失败而列表恰好是空的时候，界面会去渲染空态
   * "还没有会话"——那是一句假话，用户会以为数据被删了。失败必须能说出来。
   */
  sessionsError: ErrorPresentation | null;
  /**
   * bot 列表的错误。
   *
   * 为什么它也要单独一个：连不上服务端时**第一个失败的其实是 /bots**，而会话列表在
   * 拿不到 bot 时根本不发请求（没有 botId），于是界面停在"空列表"上——用户看到的就是
   * "还没有会话"（2026-09-15 离线实测：屏幕上正是这句）。两条路都得能把失败说出来。
   */
  botsError: ErrorPresentation | null;
  /**
   * bot 列表正在拉。
   *
   * 为什么也要单独一个：`bots === [] && botsError === null` 有两种含义——"这台服务器上
   * 一个 agent 都没有"（真的空）与"还没拉到"。**空态是结论，不能拿来当加载态用**：
   * 界面上那句话会被读屏念出来，用户会以为自己的 agent 没了（规则 R41）。
   */
  botsLoading: boolean;
  /** sessionId → 聊天状态。 */
  chats: Record<string, ChatState>;
  /**
   会话列表的**下一页游标**（`null` = 已经到底，或还没拉到第一页）。

   有它才谈得上"超过 50 个会话"的账号能往下看：没有游标时尾部什么都不说（那才是诚实的
   ——真的没有更早了）。
   */
  sessionsCursor: string | null;
  /** 正在拉更早的那一页。 */
  sessionsMoreLoading: boolean;
  /** 拉更早那一页的失败原因（i18n key）。`null` = 没有失败过。 */
  sessionsMoreError: string | null;
  /** sessionId → 待发队列（服务端持有的 follow-up / steer）。 */
  queues: Record<string, QueueView>;
  /** sessionId → 会话信息（消息数 / 上下文用量 / cache）。 */
  sessionStatus: Record<string, SessionStatus>;
  currentSessionId: string | null;
  connection: ConnectionState;
  /**
   还有几条消息在 outbox 里等网络（掉线期间点的发送）。

   单独一个字段而不是从 realtime 现读：界面要在**掉线状态下点发送**的那一刻就变，
   而那一刻连接状态并没有变化——靠"连接状态变了再读一次"是读不到的。
   */
  pendingSends: number;
  error: string | null;
}

/**
 * 一个会话的待发队列视图。
 *
 * `steerSupported` 来自服务端：不是所有运行形态都能被"插话"。宁可不给入口，
 * 也不要给一个必然失败的按钮。`error` 是入队/删除失败的一句话——队列失败必须
 * 说出来，用户以为排上了而实际没有是最坏的情况。
 */
export interface QueueView {
  items: QueueItem[];
  steerSupported: boolean;
  /**
   * 服务端有没有队列端点。`unknown` = 还没探测。
   *
   * 这个字段不是"锦上添花"：实测部署版本对 `/queue` 一律 404，而桌面端在同一个
   * 部署上也没有队列功能。探测到 `no` 之后，运行中的发送按钮回到"停止"语义
   * （与桌面端一致），而不是给一个必然失败的入口。
   */
  support: QueueSupport;
  error: string | null;
}

const EMPTY_QUEUE: QueueView = {
  items: [],
  steerSupported: false,
  support: 'unknown',
  error: null,
};

/**
 * 一次提交的结果。调用方据 `sent` / `queued` 清草稿，其余都把草稿留着——
 * 用户写的话不能因为一次失败就丢掉。
 */
export type SubmitResult = 'sent' | 'queued' | 'failed' | 'busy' | 'unavailable';

type Action =
  | { type: 'signedOut' }
  | { type: 'ready'; client: MemohClient }
  | { type: 'botsLoading' }
  | { type: 'bots'; bots: Bot[] }
  | { type: 'selectBot'; botId: string }
  | { type: 'sessionsLoading' }
  /**
   `cursor` 省略 = **不动**当前游标（列表内容只是被补了一条标题之类的局部写入）；
   给 `null` = 明确"没有下一页"。两者必须分得开，否则 `ensureSessionInList` 会把
   分页能力一次抹掉。
   */
  | { type: 'sessions'; sessions: SessionSummary[]; cursor?: string | null }
  | { type: 'sessionsPage'; sessions: SessionSummary[]; cursor: string | null }
  | { type: 'sessionsMoreLoading' }
  | { type: 'sessionsMoreError'; error: string }
  | { type: 'sessionsError'; error: ErrorPresentation }
  | { type: 'botsError'; error: ErrorPresentation }
  | { type: 'openSession'; sessionId: string }
  /**
   * 关会话**必须带预期 id**：reducer 只在它仍是当前会话时才清理——旧屏幕迟到的
   * unmount 不能把用户新打开的会话清掉。
   */
  | { type: 'closeSession'; sessionId: string }
  | { type: 'chat'; sessionId: string; update: (chat: ChatState) => ChatState }
  | { type: 'queue'; sessionId: string; view: QueueView }
  | { type: 'sessionStatus'; sessionId: string; status: SessionStatus }
  | { type: 'connection'; state: ConnectionState }
  | { type: 'pending'; count: number }
  | { type: 'error'; message: string | null };

const initialState: UiState = {
  phase: 'signedOut',
  client: null,
  bots: [],
  currentBotId: null,
  sessions: [],
  sessionsLoading: false,
  sessionsError: null,
  botsError: null,
  botsLoading: false,
  chats: {},
  queues: {},
  sessionStatus: {},
  currentSessionId: null,
  connection: 'idle',
  pendingSends: 0,
  error: null,
  sessionsCursor: null,
  sessionsMoreLoading: false,
  sessionsMoreError: null,
};

function reducer(state: UiState, action: Action): UiState {
  switch (action.type) {
    case 'signedOut':
      return initialState;
    case 'ready':
      return { ...state, phase: 'ready', client: action.client, error: null };
    case 'botsLoading':
      // 与 `sessionsLoading` 同一条纪律：重试时**不清错误**——错误行要一直在，
      // 直到真的成功。否则点重试的那一瞬间界面会闪回"还没有 agent"。
      return { ...state, botsLoading: true };
    case 'botsError':
      return { ...state, botsError: action.error, botsLoading: false };
    case 'bots': {
      const current = state.currentBotId;
      const stillThere = current !== null && action.bots.some((bot) => bot.id === current);
      return {
        ...state,
        bots: action.bots,
        botsError: null,
        botsLoading: false,
        currentBotId: stillThere ? current : (action.bots[0]?.id ?? null),
      };
    }
    case 'selectBot':
      return {
        ...state,
        currentBotId: action.botId,
        sessions: [],
        // 换 bot = 换一份列表：分页状态必须跟着清，否则会拿着 A 的游标去拉 B 的第二页。
        sessionsCursor: null,
        sessionsMoreLoading: false,
        sessionsMoreError: null,
        currentSessionId: null,
        // 三份按会话索引的缓存整个属于旧 bot：留着只会越攒越多。
        ...clearedSessionMaps<ChatState, QueueView, SessionStatus>(),
      };
    case 'sessionsLoading':
      // 重试时不清错误：错误行要一直在，直到真的成功——否则点重试的那一瞬间
      // 界面会先闪回空态，看起来像"数据没了"。
      // 这一屏要重拉第一页，所以上一轮的"还有下一页"也一起清掉（游标由响应重给）。
      return { ...state, sessionsLoading: true, sessionsMoreError: null };
    case 'sessions': {
      /**
       * 入口去重。
       *
       * 列表状态永远是"整表替换"，所以这里是唯一能保证「同一会话不出现两次」的地方。
       * 重复 key 的用户可见后果见 `features/session/sessionList.ts`。
       */
      return {
        ...state,
        sessions: uniqueSessions(action.sessions),
        sessionsLoading: false,
        sessionsError: null,
        ...(action.cursor === undefined ? {} : { sessionsCursor: action.cursor }),
      };
    }
    case 'sessionsPage': {
      // 下一页**接在**后面：整表替换会把用户已经翻到的内容扔掉（而他正看着那一屏）。
      const merged = appendSessionPage(state.sessions, action.sessions);
      return {
        ...state,
        sessions: merged,
        sessionsCursor: action.cursor,
        sessionsMoreLoading: false,
        sessionsMoreError: null,
        sessionsError: null,
      };
    }
    case 'sessionsMoreLoading':
      return { ...state, sessionsMoreLoading: true, sessionsMoreError: null };
    case 'sessionsMoreError':
      return { ...state, sessionsMoreLoading: false, sessionsMoreError: action.error };
    case 'sessionsError':
      return { ...state, sessionsError: action.error, sessionsLoading: false };
    case 'openSession':
      return {
        ...state,
        currentSessionId: action.sessionId,
        chats: { ...state.chats, [action.sessionId]: initialChatState },
      };
    case 'closeSession': {
      // 只在"要关的还是当前会话"时清，并把该 id 在三份缓存里的条目一起删掉
      // （只增不清会让长会话的整份转录永远留在内存里）。
      const released = closeSessionCache(state.currentSessionId, action.sessionId, state);
      if (released === null) return state;
      return { ...state, ...released };
    }
    case 'chat': {
      const current = state.chats[action.sessionId] ?? initialChatState;
      return { ...state, chats: { ...state.chats, [action.sessionId]: action.update(current) } };
    }
    case 'queue':
      return { ...state, queues: { ...state.queues, [action.sessionId]: action.view } };
    case 'sessionStatus':
      return {
        ...state,
        sessionStatus: { ...state.sessionStatus, [action.sessionId]: action.status },
      };
    case 'connection':
      return { ...state, connection: action.state };
    case 'pending':
      return { ...state, pendingSends: action.count };
    case 'error':
      return { ...state, error: action.message };
    default:
      return state;
  }
}

/**
 * 把各种错误翻译成能给用户看的 key 或一句话。
 *
 * 判断本身已经搬到 `features/errors/present.ts`（纯函数、可直测）。这里保留这个薄壳是
 * 因为调用方（store 自己、文件取数）只需要"一个字符串"，而**屏**需要的是"标题 + 原因 +
 * 能不能重试"三件——后者用 `presentError()`。
 */
export function describeError(error: unknown): string {
  return presentError(error).key;
}

/**
 发一条消息时可以带上的 composer 选择。
 *
 **两个字段都是可选的，不传就完全等于以前的行为**（跟随服务端默认）——这一点是刻意的：
 模型选择是新加的功能，不该改变"没选过模型"的用户发出去的那条消息。
 *
 走的是协议里本来就有的通路：WebSocket `message` 的 `model_id` / `reasoning_effort`
 （桌面端也是"每条消息都带 model_id"，不是只在会话创建时带一次）。
 */
export interface SubmitOptions {
  modelId?: string;
  reasoningEffort?: string;
  /** 斜杠技能名（`/skill-name prompt` 那种）；正文原样带上，服务端自己解析。 */
  requestedSkills?: string[];
}

interface SessionContextValue {
  state: UiState;
  currentBot: Bot | null;
  realtimeEnabled: boolean;
  selectBot: (botId: string) => void;
  refreshBots: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  /**
   会话列表**往下一屏**再拉一页（游标分页）。

   存在的理由：`limit: 50` 之上的旧会话此前在界面上直接消失，界面上还一个字都不说。
   屏幕层的触底/按钮都调它；没有下一页时它是空操作。
   */
  loadMoreSessions: () => Promise<void>;
  openSession: (sessionId: string) => void;
  /**
   * 关会话并释放它的缓存条目。**必须带预期 id**（路由实际指向的那个稳定 id）：
   * 只有它仍是当前会话时才真的清理，防止旧屏幕延迟 unmount 把新打开的会话清掉。
   * `/chat/new` 的空/合成 id 不会匹配任何真实会话（调用方应直接跳过）。
   */
  closeSession: (expectedSessionId: string) => void;
  chatFor: (sessionId: string) => ChatState;
  /**
   * 提交一句话。**运行中会入队**（follow-up），空闲时才真的开一轮——这是
   * "agent 还在跑，我再补一句"的落点（上游同一个按钮的同一套语义）。
   *
   * 返回结果而不是 invocation_id：入队是异步的，调用方必须知道到底排上了没有，
   * 才能决定要不要清草稿。
   */
  submit: (text: string, options?: SubmitOptions) => Promise<SubmitResult>;
  /** 某个会话的待发队列（没有就是空队列）。 */
  queueFor: (sessionId: string) => QueueView;
  /**
   往前翻一页会话历史（`before_message_id`）。

   原生列表一直在报"滚到顶了"（`NativeMessageList` 的 `onReachTop`），以前 JS 侧没人接，
   于是长会话的第 101 轮往前**永远看不到**。没有更早的、或者上一次还在飞，都是空操作。
   */
  loadOlderHistory: (sessionId: string) => Promise<void>;
  /** 某个会话的信息（消息数 / 上下文用量 / cache）。null = 还没取到。 */
  sessionStatusFor: (sessionId: string) => SessionStatus | null;
  /**
   主动刷一次会话信息（打开面板前调）。
   失败会抛错——面板要能告诉用户"这次没读到"，而不是弹出一个空面板。
   */
  refreshSessionStatus: (sessionId: string) => Promise<void>;
  /** 删掉一条队列项（用户改主意）。 */
  removeQueueItem: (item: QueueItem) => Promise<void>;
  /** 把 follow-up 提成 steer（别等它跑完，现在就告诉它）。 */
  promoteQueueItem: (item: QueueItem) => Promise<void>;
  /**
   立刻重连（不走退避）。

   界面上的"重连"用它：用户可以自己拍一下，不用猜还要等多久。
   **它不会重发任何东西**——重发是 `submit`（界面上的"重试"）的事，两者分开。
   */
  retryConnection: () => void;
  /**
   撤掉那条被服务端拒掉的乐观消息（重发前调用，避免同一句话出现两个气泡）。
   没有"被拒"的发送时是空操作。
   */
  discardFailedSend: (sessionId: string) => void;
  abort: () => void;
  /**
   回应审批。

   `reason` 只有"拒绝并写了理由"时才有（桌面端 `rejectReasonPlaceholder` 那一栏）。
   帧参数由 `features/chat/approval.ts` 拼：空理由不出现在帧里。
   */
  respondApproval: (optionId: string, sessionId?: string, reason?: string) => void;
  /** 回应 agent 的提问：给答案，或显式取消（两者都会发出 `user_input_response`）。 */
  respondUserInput: (
    payload?: { answers?: unknown; canceled?: boolean },
    sessionId?: string,
  ) => void;
  dismissError: () => void;
  signOut: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 连接状态单独一份 context（见 `SessionProvider` 里的说明）。

 默认值 `'idle'` = "没在 provider 里"：读它的组件（头像是唯一一个）在 provider 之外
 也能渲染，不会因为少一层 provider 就崩——它们只是永远拿不到"网络回来了"这个事件。
 */
const ConnectionContext = createContext<ConnectionState>('idle');

export interface SessionSeed {
  client: MemohClient;
  /**
   * 会话结束（用户按了"退出登录"）的出口，由登录闸门提供。
   *
   * 为什么不在这里自己 `clearSession()`：**回到登录页**是闸门的状态（`phase`），
   * 不是 store 的状态。以前设置页自己清凭据 + 调 `signOut()`，闸门什么都不知道，
   * 于是退出之后落在空壳界面上而不是登录页。清凭据与回登录页现在只有一处实现
   * （`features/auth/sessionLoss.ts`），两条起因（401 / 手动退出）共用它。
   *
   * 登录页会先构造只含 client 的 `SessionSeed`；缺省时就是"没人接这个动作"，
   * 而不是抛异常（那会变成一次崩，比行为不对更难查）。
   */
  endSession?: () => void;
}

export function SessionProvider({
  children,
  seed,
}: {
  children: React.ReactNode;
  seed: SessionSeed;
}) {
  const [state, dispatch] = useReducer(reducer, initialState, (base) => ({
    ...base,
    phase: 'ready' as const,
    client: seed.client,
  }));

  const realtimeRef = useRef<MemohRealtime | null>(null);
  const stateRef = useRef(state);
  /**
   会话列表"下一屏"与历史"更早一页"的在飞标记。

   它们防的是同一类事：滚动到底/滚到顶会连着触发好几次事件，而每个请求都是异步的——
   没有这个标记，一次滑动能打出三四个同样的请求（服务端白干，列表还可能接重复页）。
   用 ref 而不是 state：这不是要渲染的东西，只是"别重复发"。
   */
  const sessionsMoreInFlight = useRef(false);
  /** 在飞的那一页属于哪个会话（不是布尔：换会话后不该继续挡着新会话的翻页）。 */
  const olderHistoryInFlight = useRef<string | null>(null);
  /** 一个 provider 一个闸门：它记的是"这个界面有没有手势在飞"。 */
  const gate = useRef(new QueueSubmissionGate(() => uuid())).current;
  stateRef.current = state;

  const currentBot = useMemo(
    () => state.bots.find((bot) => bot.id === state.currentBotId) ?? null,
    [state.bots, state.currentBotId],
  );
  const realtimeEnabled = currentBot !== null && canOpenRealtime(currentBot);

  // ------------------------------------------------------------ REST

  const refreshBots = useCallback(async () => {
    const { client } = stateRef.current;
    if (client === null) return;
    dispatch({ type: 'botsLoading' });
    try {
      const response = await client.listBots();
      dispatch({ type: 'bots', bots: response.items ?? [] });
    } catch (error) {
      dispatch({ type: 'botsError', error: presentError(error) });
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    const { client, currentBotId } = stateRef.current;
    if (client === null || currentBotId === null) return;
    dispatch({ type: 'sessionsLoading' });
    try {
      const response = await client.listSessions(currentBotId, { limit: SESSION_PAGE_LIMIT });
      const sessions: SessionSummary[] = (response.items ?? []).map((item: MemohSession) => ({
        id: item.id,
        title: item.title,
        updatedAt: item.updated_at,
        // 副标题的拼法只有一处（sourceLabel.ts 的 sessionSourceFromApi）：这台部署
        // 服务端不返回 channel_type，字符串字段可能整个缺失，自己拼就会渲染出
        // " · chat"（开头一个空段）。
        source: sessionSourceFromApi(item),
        // 类型原文另存一份：它决定"哪些动作真的能做"（分叉只有 chat 能做）。
        type: item.type,
      }));
      dispatch({
        type: 'sessions',
        sessions,
        // 服务端说"还有下一页"就给游标。空串 = 到底（**不是**"再请求一次空页"）。
        cursor: cursorFromResponse(response.next_cursor),
      });
    } catch (error) {
      dispatch({ type: 'sessionsError', error: presentError(error) });
    }
  }, []);

  /**
   往下列表再拉一页（`cursor` 分页）。

   为什么必须有它：`limit: 50` 之上的会话此前**在界面上直接消失**，而且一个字都不说
   ——超过 50 个会话的账号会以为旧会话被删了（评审 A2）。界面侧同时会如实写出"只显示
   最近 N 个"（见 `HomeScreen` 的尾部行）。

   与 `refreshSessions` 的分工：那个是整表替换（最新一页），这个是**接在后面**。
   两者都只由 store 发起，屏幕不直接碰 client。
   */
  const loadMoreSessions = useCallback(async () => {
    const { client, currentBotId, sessionsCursor } = stateRef.current;
    if (client === null || currentBotId === null || sessionsCursor === null) return;
    // 上一次还没回来就别再发（滚动到底会连着触发好几次）。
    if (sessionsMoreInFlight.current) return;
    sessionsMoreInFlight.current = true;
    dispatch({ type: 'sessionsMoreLoading' });
    try {
      const response = await client.listSessions(currentBotId, {
        limit: SESSION_PAGE_LIMIT,
        cursor: sessionsCursor,
      });
      // 这一页是**基于那个游标**的：期间若发生过整表刷新（切 bot、下拉刷新、run 结束），
      // 游标已经变了，这一页就过期了——接上去只会把旧会话插到新列表里。
      if (stateRef.current.sessionsCursor !== sessionsCursor) return;
      const page: SessionSummary[] = (response.items ?? []).map((item: MemohSession) => ({
        id: item.id,
        title: item.title,
        updatedAt: item.updated_at,
        source: sessionSourceFromApi(item),
        type: item.type,
      }));
      dispatch({
        type: 'sessionsPage',
        sessions: page,
        cursor: cursorFromResponse(response.next_cursor),
      });
    } catch (error) {
      // 静默失败会被读成"没有更早的会话"（正是本轮要修的那句话）。说一句，游标留着。
      dispatch({ type: 'sessionsMoreError', error: describeError(error) });
    } finally {
      sessionsMoreInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refreshBots();
  }, [refreshBots]);

  useEffect(() => {
    if (state.currentBotId !== null) void refreshSessions();
  }, [state.currentBotId, refreshSessions]);

  // ------------------------------------------------------------ 实时通道

  useEffect(() => {
    if (state.client === null || currentBot === null || !canOpenRealtime(currentBot)) return;
    const client = state.client;

    const realtime = new MemohRealtime({
      baseUrl: client.url,
      botId: currentBot.id,
      getToken: () => client.token(),
      // 握手失败时"超时"还是"凭据没了"——只能靠一个有明确语义的端点问出来。
      probeAuth: () => client.probeAuth(),
      listener: {
        onStateChange: (connection) => {
          dispatch({ type: 'connection', state: connection });
          /**
           连接离开 `open` 的那一刻，当前会话的内容就已经不再更新了。

           必须在这里说话，而且**不能等 onGap**：掉线本身不产生 gap 事件（gap 只在
           seq 对不上或服务端明说 drop 时才有），实测"断线→重连→拿到新 snapshot"
           整个过程 gap 事件 0 次。不说话的话，用户对着的是一屏看起来正常、其实停在
           几秒前的内容——而且是"正在生成"的样子。`applySnapshot` 会把 stale 清掉，
           所以连上并拿到权威状态后它自己会消失。
           */
          if (connection === 'open') return;
          const sessionId = stateRef.current.currentSessionId;
          if (sessionId === null) return;
          dispatch({ type: 'chat', sessionId, update: (chat) => markStale(chat, true) });
        },
        onSnapshot: (frame) => {
          // 只应用当前正在看的那个会话。多会话订阅时服务端会把每个会话的帧都发过来，
          // 不筛就会串台。帧自带 sessionId，不必靠时序猜。
          const current = stateRef.current.currentSessionId;
          if (current === null || frame.sessionId !== current) return;
          dispatch({
            type: 'chat',
            sessionId: current,
            update: (chat) => applySnapshot(chat, frame.snapshot),
          });
        },
        onDelta: (frame) => {
          const current = stateRef.current.currentSessionId;
          if (current === null || frame.sessionId !== current) return;
          dispatch({
            type: 'chat',
            sessionId: current,
            update: (chat) => applyDelta(chat, frame.epoch, frame.seq, frame.delta),
          });
        },
        onGap: () => {
          const sessionId = stateRef.current.currentSessionId;
          if (sessionId === null) return;
          // 视图可能已过期——UI 要展示"刷新中"，不要假装还连着。
          dispatch({ type: 'chat', sessionId, update: (chat) => markStale(chat, true) });
        },
        onSessionCreated: (sessionId) => {
          dispatch({ type: 'openSession', sessionId });
        },
        /**
         服务端**明确拒了**这一次提交。

         以前这一帧直接掉在地上（listener 里没有这一档）：界面上那条乐观消息永远停在
         "等确认"，用户不知道它到底有没有被受理。协议里 `run_rejected` 带着
         `invocation_id` 与稳定 `code`（"客户端据此决定能否原样重试"），所以这里把它交给
         那条消息自己——只有 id 对得上才标（一次误发的 rejection 不该牵连别的消息）。
         **不撤那条消息**：见 `reducer.ts` 的 `rejectPendingSend`。
         */
        onRunRejected: (frame) => {
          const current = stateRef.current.currentSessionId;
          // listener 给的是联合类型（`ServerFrame`），这一档的字段在 `RunRejectedEvent` 里；
          // 这里按缺省宽容地取，缺字段就当"没有这一次拒绝"，不猜。
          const rejection = frame as { invocation_id?: unknown; code?: unknown; message?: unknown };
          const invocationId =
            typeof rejection.invocation_id === 'string' ? rejection.invocation_id : '';
          if (current === null || invocationId === '') return;
          dispatch({
            type: 'chat',
            sessionId: current,
            update: (chat) =>
              rejectPendingSend(chat, invocationId, {
                code: typeof rejection.code === 'string' ? rejection.code : '',
                message: typeof rejection.message === 'string' ? rejection.message : '',
              }),
          });
        },
        onPendingChange: (count) => dispatch({ type: 'pending', count }),
      },
    });

    realtimeRef.current = realtime;
    realtime.connect();

    return () => {
      realtime.dispose();
      realtimeRef.current = null;
    };
  }, [state.client, currentBot]);

  // 从后台回前台：长连接大概率已经被掐（服务端不发心跳），直接换一条新的。
  // 走 `retryNow` 而不是 disconnect+connect：后者会先把状态说成"已断开"（界面闪一下
  // 假的坏消息），而且会把退避次数留着，前台恢复时反而更慢。
  useEffect(() => {
    const subscription = RNAppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      realtimeRef.current?.retryNow();
    });
    return () => subscription.remove();
  }, []);

  /** 界面上的"重试"：用户拍一下就走，不等退避。 */
  const retryConnection = useCallback(() => {
    realtimeRef.current?.retryNow();
  }, []);

  /**
   把本地那条**已被服务端拒掉**的乐观消息撤掉。

   重发之前必须先撤：否则屏幕上会同时留着"失败的那条"和"重发的那条"（同一个句子两个
   气泡）。只有"服务端明确拒了"这一种状态允许走这条路——未确认时就撤等于把用户说的话
   弄丢（那正是本轮要修的东西，见 `features/chat/pending.ts`）。
   */
  const discardFailedSend = useCallback((sessionId: string) => {
    dispatch({
      type: 'chat',
      sessionId,
      update: (chat) => {
        const invocationId = chat.pendingInvocationId;
        if (invocationId === null || chat.sendFailure === null) return chat;
        return dropOptimistic(chat, invocationId);
      },
    });
  }, []);

  /**
   刷新一个会话的队列（服务端持有，客户端只读）。

   失败不弹错：读队列失败不代表用户的操作失败，界面回到"没有待发项"就够了；
   真正需要说的是**写**失败（入队/删除），那在各自的调用点报。
   */
  const refreshQueue = useCallback(async (sessionId: string) => {
    const { client, currentBotId, queues } = stateRef.current;
    if (client === null || currentBotId === null) return;
    // 已经探测出服务端没有队列端点，就别再打了（否则每个会话都要白跑一次 404）。
    if (queues[sessionId]?.support === 'no') return;
    try {
      const result = await client.getSessionQueue(currentBotId, sessionId);
      dispatch({
        type: 'queue',
        sessionId,
        view: {
          items: visibleQueueItems([...result.followUp, ...result.steer]),
          steerSupported: result.steerSupported,
          support: 'yes',
          error: null,
        },
      });
    } catch (error) {
      // 404 = 这个服务端版本没有队列端点。那是**能力结论**，不是故障：
      // 记下来，界面据此回到"运行中=停止"的语义（与桌面端一致），也不再重试。
      if (error instanceof ApiError && error.status === 404) {
        dispatch({
          type: 'queue',
          sessionId,
          view: { ...(queues[sessionId] ?? EMPTY_QUEUE), items: [], support: 'no', error: null },
        });
        return;
      }
      // 其余错误是暂时的：保持现状（清空会让用户以为排队的东西丢了）。
    }
  }, []);

  /**
   拉一次会话信息。

   失败时**把错误抛给调用者**，因为它该被两种人区别对待：

     - 后台刷新（进会话、每轮 run 结束）：静默。它不影响任何操作，读不到就是面板
       里少几行；而且这台部署的 /status 是有的（实测 200），真失败多半是暂时的
       网络抖动，下次会再试。调用点用 `.catch(() => {})` 吞掉。
     - 用户点开面板：要说话。否则面板弹出来是**空的、且永远不解释为什么空**——
       用户以为功能坏了，而其实只是这一次请求没成功。

   抛错但**不动已存的值**：清掉会让面板突然空掉，比留着上一次的数更像故障。
   */
  const refreshSessionStatus = useCallback(async (sessionId: string) => {
    const { client, currentBotId } = stateRef.current;
    if (client === null || currentBotId === null) return;
    const status = await client.getSessionStatus(currentBotId, sessionId);
    dispatch({ type: 'sessionStatus', sessionId, status });
  }, []);

  const sessionStatusFor = useCallback(
    (sessionId: string): SessionStatus | null => stateRef.current.sessionStatus[sessionId] ?? null,
    [],
  );

  const queueFailure = useCallback((sessionId: string, error: unknown) => {
    dispatch({
      type: 'queue',
      sessionId,
      view: {
        ...(stateRef.current.queues[sessionId] ?? EMPTY_QUEUE),
        error: describeError(error),
      },
    });
  }, []);

  /**
   * 拉一次会话历史。
   *
   * 打开会话时要拉，**run 结束后也要拉**——因为运行期间服务端不一定给用户轮次
   * （实测 `current_run_view.user_turns` 可能是 null），只有 REST 历史才是权威且完整的。
   * 不刷新的话，屏幕上会一直挂着本地乐观版本，rebuild 之后顺序或内容可能与服务端不一致。
   */
  const refreshHistory = useCallback(async (sessionId: string) => {
    const { client, currentBotId } = stateRef.current;
    if (client === null || currentBotId === null) return;
    try {
      const response = await client.listMessages(currentBotId, sessionId, {
        limit: HISTORY_PAGE_LIMIT,
      });
      dispatch({
        type: 'chat',
        sessionId,
        update: (chat) => applyHistory(chat, response.items ?? []),
      });
    } catch (error) {
      dispatch({ type: 'error', message: describeError(error) });
    }
  }, []);

  /**
   往前翻一页历史（原生列表报"滚到顶了"时调）。

   为什么以前做不到：`/messages` 的 `limit` 上限就是 100，而客户端只拉这一页就再也不拉
   ——超过 100 轮的长会话，第 101 轮往前在 App 里**永远看不到**（评审 A2）。

   三条纪律：

   1. **没有游标就别发**（`olderExhausted` / `olderCursor === null`）：服务端没有
      `has_more`，"到底"的唯一判据是返回空页，判过一次就够了；
   2. **同一时刻只发一个**：`onReachTop` 会连着触发，重复请求会拿到同一页；
   3. 失败**不动游标**，只记一句原因（`olderHistoryFailed`）——把失败当成"到底"，
      用户就再也翻不到旧内容了。
   */
  const loadOlderHistory = useCallback(async (sessionId: string) => {
    const { client, currentBotId, chats } = stateRef.current;
    if (client === null || currentBotId === null) return;
    const chat = chats[sessionId];
    if (chat === undefined) return;
    const cursor = chat.olderCursor;
    if (chat.olderExhausted || cursor === null) return;
    if (olderHistoryInFlight.current === sessionId) return;
    olderHistoryInFlight.current = sessionId;
    try {
      const response = await client.listMessages(currentBotId, sessionId, {
        limit: HISTORY_PAGE_LIMIT,
        beforeMessageId: cursor,
      });
      dispatch({
        type: 'chat',
        sessionId,
        update: (state) => prependHistory(state, response.items ?? []),
      });
    } catch (error) {
      dispatch({
        type: 'chat',
        sessionId,
        update: (state) => olderHistoryFailed(state, describeError(error)),
      });
    } finally {
      if (olderHistoryInFlight.current === sessionId) olderHistoryInFlight.current = null;
    }
  }, []);

  /**
   * 确保当前会话有标题可显示。
   *
   * 列表是分页的，当前会话不一定在里面（从通知进来、切过 bot、或列表还没加载完）。
   * 拿不到就单独查一次——标题退化成占位文案时，所有会话长得一样，用户认不出自己在哪。
   */
  const ensureSessionInList = useCallback(async (sessionId: string) => {
    const { client, currentBotId, sessions } = stateRef.current;
    if (client === null || currentBotId === null) return;
    if (sessions.some((session) => session.id === sessionId)) return;
    try {
      const session = await client.getSession(currentBotId, sessionId);
      const summary: SessionSummary = {
        id: session.id,
        title: session.title,
        updatedAt: session.updated_at,
        // ⚠️ 这里原来自己拼了一遍，于是" · chat"那个 bug 又长了一遍（走的就是这条路：
        // 新会话发完第一句 / 从通知进来）。副标题的规则只有 sourceLabel.ts 那一份。
        source: sessionSourceFromApi(session),
        type: session.type,
      };
      /**
       * 重新判断一次再写。
       *
       * 上面那次判断发生在 `await` **之前**，而这里是 `await` 之后——中间那段时间里
       * 这个会话可能已经被写进列表了（同一会话的并发补标题、或一次刚落地的整表刷新）。
       * 不重新判断就会把同一个会话写两份，UI 上就是那条重复 key 横幅（见
       * `features/session/sessionList.ts` 的实测记录）。
       *
       * `prependSession` 在已经存在时返回原数组，所以这里顺手省掉一次无意义的 dispatch。
       */
      const next = prependSession(stateRef.current.sessions, summary);
      if (next === stateRef.current.sessions) return;
      dispatch({ type: 'sessions', sessions: next });
    } catch {
      // 查不到就继续用占位标题——不为了一个标题把整页弄成错误态。
    }
  }, []);

  // 打开会话：补标题 + 拉历史 + 订阅实时。
  //
  // ⚠️ 这个 effect 在开发构建里**同一依赖下会被调用两次**（实测：`同client=true
  // 同session=true 同回调=true 第2次`）。所以它做的每件事都必须是幂等的：
  // `ensureSessionInList` 的写入要重新判断（见那里的注释）、`subscribe` 是可重复的
  // 幂等命令、其余三个都是纯读。别在这里放"只能发生一次"的动作——它会发生两次。
  //
  // 依赖的是两个具体值而不是整个 state：在 effect 外解构出来，依赖数组才能说真话。
  const { client: openSessionClient, currentSessionId: openSessionId } = state;
  useEffect(() => {
    if (openSessionClient === null || openSessionId === null) return;
    void ensureSessionInList(openSessionId);
    void refreshHistory(openSessionId);
    // 队列与会话信息都是服务端持有的：换会话必须重新拉，不能用上一个会话的残留。
    void refreshQueue(openSessionId);
    void refreshSessionStatus(openSessionId).catch(() => {});
    realtimeRef.current?.subscribe(openSessionId);
  }, [
    openSessionClient,
    openSessionId,
    refreshHistory,
    ensureSessionInList,
    refreshQueue,
    refreshSessionStatus,
  ]);

  /**
   轮询与边沿检测都在 `features/session/coordinator.ts`（纯 TS、依赖注入、有行为测试）。

   这里只装配**宿主端口**：现读一份状态、打那几个请求、把孤儿 run 收尾。逻辑（多久跳一次、
   什么时候该跳、边沿只触发一次、卸载要清干净）归协调层——`prevRunningRef` 那份记忆也一起
   搬了进去，它跟"这条边沿"本来就是同一件事。
  */
  const coordinator = useRef<SessionCoordinator | null>(null);

  // 装上两个定时器：队列兜底轮询（10s）+ 孤儿 run 巡检（15s）。卸载必须 stop()，
  // 否则这个界面没了之后还在打服务端。
  useEffect(() => {
    const instance = createSessionCoordinator({
      host: {
        // 每次现读：定时器回调里的闭包永远是挂载那一刻的值，不能拿它当状态。
        view: () =>
          coordinatorView({
            currentSessionId: stateRef.current.currentSessionId,
            chats: stateRef.current.chats,
            queues: stateRef.current.queues,
          }),
        refreshQueue: (sessionId) => void refreshQueue(sessionId),
        refreshHistory: (sessionId) => void refreshHistory(sessionId),
        // 后台刷新：读不到就少几行，不该弹错（与重构前一致）。
        refreshSessionStatus: (sessionId) => void refreshSessionStatus(sessionId).catch(() => {}),
        settleAbandonedRun: (sessionId) =>
          dispatch({ type: 'chat', sessionId, update: (current) => settleAbandonedRun(current) }),
      },
    });
    coordinator.current = instance;
    instance.start();
    return () => {
      instance.stop();
      coordinator.current = null;
    };
  }, [refreshQueue, refreshHistory, refreshSessionStatus]);

  // run 从跑着变成结束 → 历史现在是权威的，拉一次覆盖本地推测。
  // 边沿的判据（含"只触发一次"）在协调层；这里只在 chats / 当前会话变化时喂它一次。
  useEffect(() => {
    coordinator.current?.observeRunState();
  }, [state.chats, state.currentSessionId]);

  // ------------------------------------------------------------ 动作

  const selectBot = useCallback((botId: string) => dispatch({ type: 'selectBot', botId }), []);
  const openSession = useCallback(
    (sessionId: string) => dispatch({ type: 'openSession', sessionId }),
    [],
  );
  const closeSession = useCallback((expectedSessionId: string) => {
    // 迟到 unmount 护栏：要关的已经不是当前会话，就什么都不做（连退订都不做）。
    if (stateRef.current.currentSessionId !== expectedSessionId) return;
    realtimeRef.current?.unsubscribe(expectedSessionId);
    dispatch({ type: 'closeSession', sessionId: expectedSessionId });
  }, []);

  const chatFor = useCallback(
    (sessionId: string): ChatState => state.chats[sessionId] ?? initialChatState,
    [state.chats],
  );

  const submit = useCallback(
    async (text: string, options?: SubmitOptions): Promise<SubmitResult> => {
      const { currentSessionId, chats, client, currentBotId, queues } = stateRef.current;
      const realtime = realtimeRef.current;
      const trimmed = text.trim();
      if (trimmed === '') return 'unavailable';

      /**
       * **还没有会话 id** = 用户在"新建会话"页发了第一句。
       *
       * 这不是错误状态：协议就是这么设计的——`session_id` 留空，服务端建好会话并在
       * `session_created` 里告知（`internal/handlers/local_channel.go:2246`，文档
       * `docs/research/memoh-api.md` 的 3.1 节）。
       *
       * 之前这里直接 `return 'unavailable'`，于是 `/chat/new` 上点发送**什么都不会
       * 发生、也不给任何提示**——输入框里的字还在、界面看着一切正常，用户只会以为
       * App 坏了。`ChatScreen.onSend` 只处理成功分支，所以连个报错都没有。
       */
      const sessionId = currentSessionId ?? '';
      const chat = chats[sessionId];
      const running = chat !== undefined && isRunActive(chat.runStatus);

      // 空闲：正常开一轮（走实时通道）。会话 id 为空时服务端会建一个。
      if (!running) {
        if (realtime === null) return 'unavailable';
        const invocationId = realtime.sendMessage({
          sessionId: currentSessionId ?? undefined,
          text: trimmed,
          // 选过的模型/强度随消息带；没选过就是 undefined，服务端用它的默认。
          modelId: options?.modelId,
          reasoningEffort: options?.reasoningEffort,
          requestedSkills: options?.requestedSkills,
        });
        if (currentSessionId !== null) {
          dispatch({
            type: 'chat',
            sessionId: currentSessionId,
            update: (state) => appendOptimisticUserMessage(state, trimmed, invocationId),
          });
          // 开了新一轮，队列里可能还有上一轮排下的东西——刷一次看服务端怎么算的。
          void refreshQueue(currentSessionId);
        }
        // 新会话那一句不走乐观回显：此刻还没有 id 可以把消息挂上去。等
        // `session_created` 到了、历史拉回来，这句话自然就出现在对话里——
        // 这也正是服务端权威的那份内容，不需要本地先猜一个。
        return 'sent';
      }

      // 运行中：入队（follow-up）。这句话会在这一轮跑完后被执行。
      //
      // 这一段要求**已有会话**：没有 id 的新会话不可能"正在跑"（它的第一轮还没发出去）。
      // 显式判断而不是非空断言——真出现这种组合时应该老实地报无法入队，而不是崩。
      if (client === null || currentBotId === null || currentSessionId === null) {
        return 'unavailable';
      }
      const submission = gate.begin({
        sessionId: currentSessionId,
        mode: 'follow-up',
        text: trimmed,
      });
      // 上一个手势还在飞：直接拒绝。同一次双击不能入两条。
      if (submission === null) return 'busy';
      try {
        await client.enqueueFollowUp(
          currentBotId,
          currentSessionId,
          trimmed,
          submission.invocationId,
        );
        gate.succeed(submission);
        dispatch({
          type: 'queue',
          sessionId: currentSessionId,
          view: { ...(queues[currentSessionId] ?? EMPTY_QUEUE), support: 'yes', error: null },
        });
        // 乐观放一条进去，等服务端列表回来再对齐（否则用户会以为没排上而再点一次）。
        dispatch({
          type: 'queue',
          sessionId: currentSessionId,
          view: {
            items: [
              ...(queues[currentSessionId]?.items ?? []),
              {
                itemId: `local-${submission.invocationId}`,
                text: trimmed,
                position: Number.MAX_SAFE_INTEGER,
                status: 'accepted',
                kind: 'follow-up' as const,
              },
            ],
            steerSupported: queues[currentSessionId]?.steerSupported ?? false,
            support: 'yes',
            error: null,
          },
        });
        void refreshQueue(currentSessionId);
        return 'queued';
      } catch (error) {
        gate.fail(submission);
        queueFailure(currentSessionId, error);
        return 'failed';
      }
    },
    [gate, queueFailure, refreshQueue],
  );

  const removeQueueItem = useCallback(
    async (item: QueueItem) => {
      const { currentSessionId, client, currentBotId } = stateRef.current;
      if (client === null || currentBotId === null || currentSessionId === null) return;
      try {
        await client.deleteQueueItem(currentBotId, currentSessionId, item.kind, item.itemId);
        await refreshQueue(currentSessionId);
      } catch (error) {
        queueFailure(currentSessionId, error);
      }
    },
    [queueFailure, refreshQueue],
  );

  const promoteQueueItem = useCallback(
    async (item: QueueItem) => {
      const { currentSessionId, client, currentBotId } = stateRef.current;
      if (client === null || currentBotId === null || currentSessionId === null) return;
      try {
        await client.promoteQueueItem(currentBotId, currentSessionId, item.itemId);
        await refreshQueue(currentSessionId);
      } catch (error) {
        queueFailure(currentSessionId, error);
      }
    },
    [queueFailure, refreshQueue],
  );

  const queueFor = useCallback(
    (sessionId: string): QueueView => stateRef.current.queues[sessionId] ?? EMPTY_QUEUE,
    [],
  );

  const abort = useCallback(() => {
    const { currentSessionId, chats } = stateRef.current;
    const realtime = realtimeRef.current;
    if (realtime === null || currentSessionId === null) return;
    const runId = chats[currentSessionId]?.runId;
    if (runId == null) return;
    realtime.abort(currentSessionId, runId);
  }, []);

  /**
   * 回应一次工具审批。
   *
   * `sessionId` 可省：不传就用当前会话（老调用点）。传它是因为审批页现在是一张独立
   * 的 sheet，它记得自己属于哪个会话——用户在看这张 sheet 时切过会话的话，
   * "当前会话"已经不是它了。
   */
  const respondApproval = useCallback((optionId: string, sessionId?: string, reason?: string) => {
    const { currentSessionId, chats } = stateRef.current;
    const realtime = realtimeRef.current;
    const target = sessionId ?? currentSessionId;
    if (realtime === null || target === null) return;
    const chat = chats[target];
    const approval = chat?.approval;
    const runId = chat?.runId;
    if (approval == null || runId == null) return;

    // 帧参数在纯逻辑里拼：兜底动作不能把假 id 回传（服务端匹配不到），而**空理由不能
    // 变成一个空字段**（那会被当成"一条空理由"记进上下文）。
    realtime.respondToApproval({
      sessionId: target,
      runId,
      approvalId: approval.approvalId,
      ...approvalResponseFor(optionId, reason ?? ''),
    });
    dispatch({ type: 'chat', sessionId: target, update: clearApproval });
  }, []);

  /**
   * 回应 agent 的提问（`ask_user`）。
   *
   * 两种结束方式：给答案，或显式取消。**两种都必须发帧出去**——run 停在
   * `waiting_decision` 上，不发它就永远不继续（用户看到的是"卡住了"）。
   * 取消要带 `canceled`，否则服务端会当成一次空提交（见 realtime 的注释）。
   */
  const respondUserInput = useCallback(
    (payload: { answers?: unknown; canceled?: boolean } = {}, sessionId?: string) => {
      const { currentSessionId, chats } = stateRef.current;
      const realtime = realtimeRef.current;
      const target = sessionId ?? currentSessionId;
      if (realtime === null || target === null) return;
      const chat = chats[target];
      const pending = chat?.userInput;
      const runId = chat?.runId;
      if (pending == null || runId == null) return;
      realtime.respondToUserInput({
        sessionId: target,
        runId,
        decisionId: pending.userInputId,
        answers: payload.answers,
        canceled: payload.canceled === true,
        reason: payload.canceled === true ? CANCEL_REASON : undefined,
      });
      // 乐观清掉：否则表单继续挂在屏幕上，用户会以为没生效而重复点。
      dispatch({ type: 'chat', sessionId: target, update: clearUserInput });
    },
    [],
  );

  // 解构出来再依赖：依赖数组里的 `seed.endSession` 会让 exhaustive-deps 要求整个 seed。
  const endSession = seed.endSession;

  /**
   * 用户按了"退出登录"。
   *
   * 这里只做**本 store 之内**的事（掐掉实时连接、把会话状态归零）；清凭据与"回登录页"
   * 交给闸门那个唯一出口（`seed.endSession`）——它们不是 store 的状态，见 `SessionSeed`。
   * 顺序上先本地归零再叫闸门：闸门那一步是异步的（要删 Keychain），先做能让界面立刻
   * 不再显示任何会话内容，而不是等一个 IO 回来。
   */
  const signOut = useCallback(() => {
    realtimeRef.current?.dispose();
    realtimeRef.current = null;
    dispatch({ type: 'signedOut' });
    endSession?.();
  }, [endSession]);

  const dismissError = useCallback(() => dispatch({ type: 'error', message: null }), []);

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      currentBot,
      realtimeEnabled,
      selectBot,
      refreshBots,
      refreshSessions,
      loadMoreSessions,
      openSession,
      closeSession,
      chatFor,
      submit,
      queueFor,
      loadOlderHistory,
      sessionStatusFor,
      refreshSessionStatus,
      removeQueueItem,
      promoteQueueItem,
      retryConnection,
      discardFailedSend,
      abort,
      respondApproval,
      respondUserInput,
      dismissError,
      signOut,
    }),
    [
      state,
      currentBot,
      realtimeEnabled,
      selectBot,
      refreshBots,
      refreshSessions,
      loadMoreSessions,
      openSession,
      closeSession,
      chatFor,
      submit,
      queueFor,
      loadOlderHistory,
      sessionStatusFor,
      refreshSessionStatus,
      removeQueueItem,
      promoteQueueItem,
      retryConnection,
      discardFailedSend,
      abort,
      respondApproval,
      respondUserInput,
      dismissError,
      signOut,
    ],
  );

  return (
    <SessionContext.Provider value={value}>
      {/*
        只装**连接状态**的一份窄 context。

        为什么值得单独一份：`useSession()` 的 value 每次 delta 都是新对象，读它的组件
        每个 delta 都会重渲染；而"网络回来了没有"是头像重试那类小部件唯一关心的东西，
        它变化的频率是分钟级。让它们读窄的这一份，就别为了一个字符串把整个 store 的
        重渲染面再扩大一圈（§2.4 那条"拆 context"的最小一片，H 条的其余部分仍未做）。

        value 是字符串，`Object.is` 相等时 React 会在 Provider 上停下来，不会往下传。
      */}
      <ConnectionContext.Provider value={state.connection}>{children}</ConnectionContext.Provider>
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession 必须在 SessionProvider 内使用');
  return value;
}

/** 只订阅连接状态。组件用它时，别的状态变化不会带着它一起重渲染。 */
export function useConnectionState(): ConnectionState {
  return useContext(ConnectionContext);
}
