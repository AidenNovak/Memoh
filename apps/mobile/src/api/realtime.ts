/**
 * Memoh 实时通道客户端。
 *
 * 一条 bot 一条 WebSocket。这个类负责三件正确性要求很高的事，每一件都有对应的
 * 服务端行为做依据（见 `docs/research/memoh-api.md` §2.2）：
 *
 * 1. **订阅才能收到正文**。发消息的连接只会收到 `run_accepted` 和错误帧；文本、
 *    思考、工具增量全部走 `runtime_delta`，只发给 `runtime_subscribe` 过该会话的
 *    连接。所以「连上 → 订阅 → 等 snapshot → 再发消息」是硬顺序。
 *
 * 2. **epoch/seq 必须校验**。epoch 变了 seq 从 0 重来；`seq <= 本地` 是重复帧，
 *    丢弃；`seq != 本地 + 1` 是空洞，重订阅要 snapshot。服务端明确不做增量补齐
 *    （"在客户端位置和现在之间合成增量等于伪造历史"），所以 cursor 只是礼貌，
 *    真正的恢复手段是重新拿 snapshot。
 *
 * 3. **服务端不发心跳**。NAT 和运营商会在无数据 30s–5min 内静默掐断长连，而
 *    仓库 nginx 对这条路径的 `proxy_read_timeout` 是 300s。所以客户端必须自己
 *    保活：周期重发幂等的 `runtime_subscribe`，既续命又顺带纠正状态。
 *
 * ## 弱网（这一节是踩出来的，别删）
 *
 * 弱网下的毛病有个共同特征：**它们在界面上什么都不留下**。旧内容是"看起来正常"的
 * 样子，用户只能等。这些都是对着固定服务端（`verification/fixture/netlab.mjs` 的
 * 故障场景）实测出来的，每条都对应下面的一处实现：
 *
 * - **握手成功后就断**（网关接受又掐掉）：一看到 `open` 就把退避清零 → 每秒重连
 *   一次、永不增长。15s 实测 14 次。→ 退避只在"活够 `STABLE_CONNECTION_MS`"后清零。
 * - **黑洞连接**（NAT 静默丢包，没有 TCP close）：一直 `open`，心跳没人理，界面永远
 *   不更新。→ 心跳即探针，回音没回来就判死链、重连。
 * - **建连没有任何回调**：永远停在 `connecting`，而且此后所有发送都被静默排队。
 *   → 建连超时。
 * - **空洞持续存在**：一条 delta 一次重订阅 → 4s 内订阅 38 次，把服务端打爆。
 *   → 重新订阅节流。
 * - **重连后先发消息再订阅**：违反协议硬顺序，这一轮跑的正文可能一帧都收不到。
 *   → 先订阅、后补发。
 * - **401 和超时被当成一回事**：token 没了也照样每秒重试。→ `judgeClose` 分类，
 *   凭据问题**绝不重试**，并把状态说成"登录已过期"。
 */
import type {
  ClientFrame,
  RuntimeCursor,
  RuntimeDelta,
  RuntimeSnapshotPayload,
  ServerFrame,
} from './protocol.ts';
import { frameType } from './protocol.ts';
import { uuid } from '../lib/uuid.ts';
import type { UIAttachment } from './types.ts';
import {
  CONNECT_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  LIVENESS_GRACE_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  RESUBSCRIBE_COOLDOWN_MS,
  STABLE_CONNECTION_MS,
  isStableConnection,
  judgeClose,
  judgeDelta,
  judgeSnapshot,
  nextAttempt,
  reconnectDelay,
  shouldResubscribe,
} from './cursor.ts';

/** 单条帧的长度上限（防御性）：异常大的帧直接丢掉，不要让 JS 被撑爆。 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * 连接状态。
 *
 * `unauthorized` 单独一档：**它和"断了"是两件事**。断了自己会回来，凭据没了等到
 * 天亮也不会——界面必须让用户去重新登录，而不是让他盯着"正在重连"。
 */
export type ConnectionState =
  'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'unauthorized';

export interface SessionSnapshot {
  /** 这条投影属于哪个会话。没有它，调用方无法把帧归到某个会话上。 */
  sessionId: string;
  epoch: string;
  seq: number;
  snapshot: RuntimeSnapshotPayload;
}

export interface SessionDelta {
  sessionId: string;
  epoch: string;
  seq: number;
  delta: RuntimeDelta;
}

/**
 * 每个会话的订阅状态。`epoch` / `seq` 是**一对**，跨 epoch 比较 seq 没有意义。
 */
interface Subscription {
  epoch: string | null;
  seq: number;
}

export interface RealtimeListener {
  onStateChange?: (state: ConnectionState) => void;
  /** 权威状态。收到它就应丢弃本地对该会话的推测，按 snapshot 重建。 */
  onSnapshot?: (snapshot: SessionSnapshot) => void;
  onDelta?: (delta: SessionDelta) => void;
  /** 视图已过期（缓冲溢出或 seq 空洞）。上层应展示"刷新中"而不是假装还连着。 */
  onGap?: (sessionId: string, reason: string) => void;
  /** 控制类回执：abort / 审批 / 回答的结果。 */
  onControlAck?: (event: ServerFrame) => void;
  /** 服务端建好了会话（首发时没带 session_id 的情况）。 */
  onSessionCreated?: (sessionId: string, event: ServerFrame) => void;
  /** run 被接受：这是唯一引入 run_id 的地方，abort 需要它。 */
  onRunAccepted?: (event: ServerFrame) => void;
  onRunRejected?: (event: ServerFrame) => void;
  /** 其他未归类的帧（命令结果、错误等）。 */
  onOther?: (event: ServerFrame) => void;
  /** 连接层错误，仅用于日志/诊断。 */
  onError?: (error: Error) => void;
  /**
   还有几帧没送出去（掉线期间发的）。
   
   界面要能回答"我刚才那句到底发出去了没有"——`sendMessage` 一返回就清输入框、加
   乐观回显，掉线时那条帧其实还躺在 outbox 里，不说出来就是谎报成功。
   */
  onPendingChange?: (count: number) => void;
}

/**
 * 时间参数。生产用默认值；测试注入小值，好让"40s 才发现死链"这种事在
 * 100ms 内验完（不然这些用例只能靠等，没人会跑）。
 */
export interface RealtimeTiming {
  connectTimeoutMs: number;
  heartbeatMs: number;
  livenessGraceMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  stableConnectionMs: number;
  resubscribeCooldownMs: number;
}

export const DEFAULT_TIMING: RealtimeTiming = {
  connectTimeoutMs: CONNECT_TIMEOUT_MS,
  heartbeatMs: HEARTBEAT_INTERVAL_MS,
  livenessGraceMs: LIVENESS_GRACE_MS,
  baseDelayMs: RECONNECT_BASE_MS,
  maxDelayMs: RECONNECT_MAX_MS,
  stableConnectionMs: STABLE_CONNECTION_MS,
  resubscribeCooldownMs: RESUBSCRIBE_COOLDOWN_MS,
};

export interface RealtimeOptions {
  /**
   * HTTP base URL，形如 `https://memoh.example.com`。
   *
   * **不要在这里传一个完整的 ws:// 地址**——路径由这个类自己拼（`/bots/{botId}/web/ws`）。
   * 让调用方拼路径是个反复出错的点：漏掉 bot 段就会连到根路径拿 404，而且看起来
   * 像是"连接不稳"而不是"地址写错了"。
   */
  baseUrl: string;
  /** 这条连接服务的 bot。 */
  botId: string;
  /** 每次建连时调用，拿最新 token（不要缓存到闭包外）。 */
  getToken: () => string | null;
  listener: RealtimeListener;
  /**
   * 建 WebSocket 的方式。默认用运行时的全局 `WebSocket`（iOS 上就是 RN 的实现，
   * 它支持 `{ headers }` 第三参数）。抽出来是为了让 Node 下的集成测试能注入一个
   * 支持 header 的实现（Node 内置的 WebSocket 不支持），而不是在源码里做环境判断。
   */
  createSocket?: SocketFactory;
  /** 时间参数（测试注入小值）。 */
  timing?: Partial<RealtimeTiming>;
  /**
   * "这条网络现在通不通"的轻量探测，用于退避期间提前发现**网络恢复**。
   *
   * 为什么不用 NetInfo：`@react-native-community/netinfo` 不在依赖里，加它要动原生
   * 依赖（prebuild + pod install + 重新构建），而这里要的只有一个问题——"现在能不能
   * 连上这台机器"。一次 HEAD 请求就能回答，任何 HTTP 响应（哪怕是 401/404）都说明
   * 网络通了，只有"连不出去"才算不通。
   *
   * 默认实现就是那个 HEAD；测试注入假的。
   */
  probe?: () => Promise<boolean>;
  /** 探测节奏（只在退避等待期间用）。 */
  probeIntervalMs?: number;
  /**
   * "凭据是不是被服务端拒了"（401）。
   *
   * 建连失败且**从来没有连上过**的时候问一次。`true` = 凭据没了 → 停止重连、
   * 状态说成 `unauthorized`。见 `client.ts` 的 `probeAuth`：这是把"超时"和"401"
   * 分开的权威依据（close 事件里的 reason 只是平台给的提示，不一定带状态码）。
   */
  probeAuth?: () => Promise<boolean>;
}

/** 建一条已带上鉴权的 WebSocket。抛出即视为建连失败，会走重连。 */
export type SocketFactory = (url: string, token: string) => WebSocket;

/** HTTP base URL → WebSocket origin。 */
function toWebSocketOrigin(baseUrl: string): string {
  if (baseUrl.startsWith('https://')) return `wss://${baseUrl.slice('https://'.length)}`;
  if (baseUrl.startsWith('http://')) return `ws://${baseUrl.slice('http://'.length)}`;
  return baseUrl;
}

/**
 * 拼出这条连接要连的完整地址。
 *
 * 单独成一个导出的纯函数是为了能被测：漏掉 bot 段会导致 404，而现象看起来像
 * "连接不稳"（一直重连），排查成本很高。
 */
export function realtimeUrl(baseUrl: string, botId: string): string {
  const origin = toWebSocketOrigin(baseUrl).replace(/\/+$/, '');
  return `${origin}/bots/${encodeURIComponent(botId)}/web/ws`;
}

/**
 * 默认的建连方式：用运行时的全局 `WebSocket`。
 *
 * 在 iOS 上这就是 React Native 的实现，它接受第三个 options 参数（`{ headers }`）——
 * 原生客户端走 `Authorization`，不用 `?token=`（那条是给浏览器的妥协，因为浏览器
 * 的 WebSocket 设不了 header）。
 *
 * 类型上需要显式声明这个构造签名：RN 支持它，但 DOM 的 `WebSocket` 类型定义不认。
 */
const defaultSocketFactory: SocketFactory = (url, token) => {
  const WebSocketWithOptions = WebSocket as unknown as new (
    url: string,
    protocols: string | string[] | undefined,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  return new WebSocketWithOptions(url, undefined, {
    headers: { Authorization: `Bearer ${token}` },
  });
};

/** 客户端生成的幂等键。没有 crypto.randomUUID 的运行时用降级实现。 */

export class MemohRealtime {
  private readonly wsUrl: string;
  private readonly createSocket: SocketFactory;
  private readonly getToken: () => string | null;
  private readonly listener: RealtimeListener;
  private readonly timing: RealtimeTiming;
  private readonly probe: () => Promise<boolean>;
  private readonly probeIntervalMs: number;
  private readonly probeAuth: (() => Promise<boolean>) | null;
  /** 已经确认凭据被拒：此后**不再自动重连**（只有用户点重试或重新登录）。 */
  private credentialsRejected = false;
  private authProbeInFlight = false;

  private socket: WebSocket | null = null;
  private state: ConnectionState = 'idle';
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 建连超时（见 `CONNECT_TIMEOUT_MS`）。 */
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 心跳探针的回音期限（见 `LIVENESS_GRACE_MS`）。 */
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  /** 退避期间的网络探测定时器。 */
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 上一次可达性探测的结果（用来识别"网络刚回来"这个跳变）。 */
  private lastProbeReachable: boolean | null = null;
  /** 这条 socket 是什么时候打开的（用来判定"稳定"）。 */
  private openedAt: number | null = null;
  /** 最后收到帧的时刻。探针回音靠它判定。 */
  private lastInboundAt = 0;
  /** 每个会话上次重新订阅的时刻（节流用）。 */
  private readonly lastResubscribeAt = new Map<string, number>();
  /** 被节流推迟的那次重新订阅。 */
  private readonly resubscribeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly subscriptions = new Map<string, Subscription>();
  /** 掉线期间发出的帧先入队，连上后按序补发。 */
  private outbox: ClientFrame[] = [];
  private disposed = false;

  constructor(options: RealtimeOptions) {
    this.wsUrl = realtimeUrl(options.baseUrl, options.botId);
    this.getToken = options.getToken;
    this.listener = options.listener;
    this.createSocket = options.createSocket ?? defaultSocketFactory;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    // HEAD 到本机 base URL：任何 HTTP 响应都说明"网络是通的"，只有真连不出去才 false。
    this.probe =
      options.probe ??
      (async () => {
        try {
          await fetch(options.baseUrl, { method: 'HEAD' });
          return true;
        } catch {
          return false;
        }
      });
    this.probeIntervalMs = options.probeIntervalMs ?? 3_000;
    this.probeAuth = options.probeAuth ?? null;
  }

  /** 实际会连的地址。诊断用。 */
  get url(): string {
    return this.wsUrl;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  /** 当前已知的订阅游标，用于诊断与重连时带上。 */
  cursorFor(sessionId: string): RuntimeCursor | undefined {
    const sub = this.subscriptions.get(sessionId);
    if (!sub?.epoch) return undefined;
    return { epoch: sub.epoch, seq: sub.seq };
  }

  connect(): void {
    if (this.disposed) return;
    if (this.state === 'connecting' || this.state === 'open') return;
    // 凭据问题要用户去重新登录，自动连接只会再撞一次 401。
    if (this.state === 'unauthorized') return;
    /**
     已经排好了一次重连就不要抢跑。

     之前这里对 `reconnecting` 是放行的，于是任何一次 `send()`（比如掉线期间点发送）
     都会立刻建一条新连接：**退避计划被无声丢弃**，而且那条已经排队的定时器还在——
     到点又建一条，前一条成了没人管的野连接（实测：一次发送之后服务端看到 3 条连接，
     其中一条被漏掉）。要"现在就试"是明确的意图，走 `retryNow()`；`connect()` 只负责
     "确保正在连"。
     */
    if (this.reconnectTimer !== null) return;
    this.openSocket();
  }

  /**
   * 立刻重连（不走退避）。
   *
   * 两个调用点：回到前台（长连大概率已经被掐）、用户点"重试"。乐观地换一条新连接
   * 比等退避划算——真正的可用性只有连上才知道。
   */
  retryNow(): void {
    if (this.disposed) return;
    this.clearTimers();
    this.attempt = 0;
    this.openedAt = null;
    this.dropSocket();
    if (this.state === 'unauthorized') this.setState('idle');
    // 用户手动重试 = 他也许刚重新登录过，再给一次机会。
    this.credentialsRejected = false;
    this.openSocket();
  }

  disconnect(): void {
    this.clearTimers();
    this.openedAt = null;
    this.dropSocket();
    this.setState('closed');
  }

  /** 彻底释放。之后 connect() 也不会重连。 */
  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.subscriptions.clear();
    this.lastResubscribeAt.clear();
    for (const timer of this.resubscribeTimers.values()) clearTimeout(timer);
    this.resubscribeTimers.clear();
    this.outbox = [];
    this.notifyPending();
  }

  // ------------------------------------------------------------ 出站

  /**
   * 订阅会话。幂等：重复调用会替换旧订阅并让服务端重发 snapshot——这既是恢复
   * 手段，也是心跳手段。
   */
  subscribe(sessionId: string, options: { useCursor?: boolean } = {}): void {
    const cursor = options.useCursor === false ? undefined : this.cursorFor(sessionId);
    this.send({ type: 'runtime_subscribe', session_id: sessionId, cursor });
  }

  unsubscribe(sessionId: string): void {
    this.subscriptions.delete(sessionId);
    this.lastResubscribeAt.delete(sessionId);
    this.cancelResubscribe(sessionId);
    this.send({ type: 'runtime_unsubscribe', session_id: sessionId });
  }

  /**
   * 发一条消息。返回 `invocation_id`——它是"意图"的幂等键，重发同一个不会产生
   * 第二轮（服务端会回 `duplicate: true` 的 `run_accepted`）。
   *
   * ⚠️ 返回 `invocation_id` **不代表已经送达**。掉线时它进 outbox，连上后补发；
   * 想界面别撒谎的话，用 `connectionState` 把"还没送出去"说出来（见
   * `ui/ConnectionBadge.tsx`）。重发同一个 id 是幂等的，所以补发是安全的。
   */
  sendMessage(params: {
    sessionId?: string;
    text: string;
    attachments?: UIAttachment[];
    modelId?: string;
    reasoningEffort?: string;
    workspaceTargetId?: string;
    /**
     这一轮要激活的技能名（`/skill-name prompt` 那种）。

     注意正文**保持原样**（含 `/name`）：服务端自己的分类器就是从文本解析技能的
     （`internal/slash` 的 `DecisionSkillIntent`）。这个字段是额外的元数据，桌面端也带。
     */
    requestedSkills?: string[];
    invocationId?: string;
  }): string {
    const invocationId = params.invocationId ?? uuid();
    this.send({
      type: 'message',
      invocation_id: invocationId,
      session_id: params.sessionId,
      text: params.text,
      attachments: params.attachments,
      model_id: params.modelId,
      reasoning_effort: params.reasoningEffort,
      workspace_target_id: params.workspaceTargetId,
      requested_skills: params.requestedSkills,
    });
    return invocationId;
  }

  /** 还有没有没送出去的帧（界面据此说"等待网络"）。 */
  get pendingCount(): number {
    return this.outbox.length;
  }

  /** 中断一个 run。需要服务端给的 `run_id`。 */
  abort(sessionId: string, runId: string, controlId?: string): string {
    const id = controlId ?? uuid();
    this.send({ type: 'abort', run_id: runId, session_id: sessionId, control_id: id });
    return id;
  }

  /**
   * 回应工具审批。
   *
   * ⚠️ `decision_id` 必须是原始 `approval_id`；`option_id` 必填——只做
   * approve/reject 两个写死的按钮会让用户永远选不到 agent 定义的 session/always
   * 作用域。
   */
  respondToApproval(params: {
    sessionId: string;
    runId: string;
    approvalId: string;
    /** agent 定义的选项 id；agent 没给选项时省略，改用 `decision`。 */
    optionId?: string;
    decision?: 'approve' | 'reject';
    reason?: string;
    controlId?: string;
  }): string {
    const controlId = params.controlId ?? uuid();
    this.send({
      type: 'tool_approval_response',
      run_id: params.runId,
      session_id: params.sessionId,
      decision_id: params.approvalId,
      control_id: controlId,
      decision: params.decision,
      option_id: params.optionId,
      reason: params.reason,
    });
    return controlId;
  }

  /** 回应 agent 的提问。走的是和审批同一套机制；漏掉它 run 会永久卡住。 */
  respondToUserInput(params: {
    sessionId: string;
    runId: string;
    decisionId: string;
    answers?: unknown;
    /** 取消整次提问（不回答）。服务端接受 `canceled` + `reason`。 */
    canceled?: boolean;
    reason?: string;
    controlId?: string;
  }): string {
    const controlId = params.controlId ?? uuid();
    this.send({
      type: 'user_input_response',
      run_id: params.runId,
      session_id: params.sessionId,
      decision_id: params.decisionId,
      control_id: controlId,
      // 回答与取消是同一帧的两个可选部分（服务端同一套解析）。
      // 只发 `answers` 而不显式给 `canceled` 时，"取消"会被理解成一次空提交，
      // run 就继续等一个永远不来的答案。
      answers: params.answers,
      canceled: params.canceled === true,
      reason: params.reason,
    });
    return controlId;
  }

  newControlId(): string {
    return uuid();
  }

  // ------------------------------------------------------------ 连接生命周期

  private openSocket(): void {
    if (this.credentialsRejected) return; // 凭据没了，自动重连没有意义
    // 建连是**唯一入口**：进来先收掉已经在排队的重连与探测。不收的话，别的路径
    // （`send` → `connect`、前台恢复、探测提前重连）也会走到这里，于是定时器到点
    // 再建一条，两条连接并存、前一条没人管。
    this.clearReconnectTimer();
    this.stopProbe();
    const token = this.getToken();
    if (!token) {
      this.setState('closed');
      this.listener.onError?.(new Error('no token'));
      return;
    }

    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = this.createSocket(this.wsUrl, token);
    } catch (error) {
      this.listener.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    this.armConnectTimeout(socket);

    socket.onopen = () => {
      this.clearConnectTimeout();
      this.openedAt = Date.now();
      this.lastInboundAt = Date.now();
      this.setState('open');
      /**
       协议硬顺序：**先订阅，再发消息**。

       顺序反了不会报错，只会让这一轮跑的正文一帧都收不到——因为正文只发给订阅了
       这个会话的连接（`runtime_delta`），而补发的那条 `message` 会立刻起一轮新的
       run。之前的实现是 `flushOutbox()` 在前，补发的消息比订阅先出队。
       */
      for (const sessionId of this.subscriptions.keys()) this.subscribe(sessionId);
      this.flushOutbox();
      this.startHeartbeat();
    };

    socket.onmessage = (event: WebSocketMessageEvent) => {
      this.lastInboundAt = Date.now();
      this.handleRawFrame(event.data);
    };

    socket.onerror = (event: unknown) => {
      const message =
        typeof event === 'object' && event !== null && 'message' in event
          ? String((event as { message: unknown }).message)
          : 'websocket error';
      this.listener.onError?.(new Error(message));
    };

    socket.onclose = (event: unknown) => {
      if (this.socket === socket) this.socket = null;
      this.clearConnectTimeout();
      this.stopHeartbeat();
      if (this.disposed) return;

      /**
       401/403 与"网断了"必须分开。RN 把原生失败原因放在 close 事件的 `reason`
       上（error 事件本身没有 message），所以这里能读到状态码——读不到就照旧重试。
       */
      const close = (event ?? {}) as { code?: number; reason?: string };
      const verdict = judgeClose({ code: close.code, reason: close.reason });
      if (verdict.action === 'stop') {
        this.setState(verdict.kind === 'auth' ? 'unauthorized' : 'closed');
        this.listener.onError?.(
          new Error(
            verdict.kind === 'auth'
              ? `凭据已失效，不再重连：${verdict.detail}`
              : `服务端不再接受这条连接，不再重连：${verdict.detail}`,
          ),
        );
        return;
      }

      // 这一条**从来没连上过**：问一次"是不是凭据被拒了"。连上过又断的不用问——
      // 那种情况凭据显然是好的（刚刚才用同一份 token 连上）。
      if (this.openedAt === null) void this.checkCredentials();
      this.scheduleReconnect();
    };
  }

  /**
   建连失败时的凭据检查（见 `probeAuth`）。

   调用点只在 socket **从未打开过**的时候问，而且同时在飞的只留一条：握手被 401 拒掉
   时状态机这边看到的就是"一次没升成 101 的失败"，和断网长得一样——区别只能从外面问。
   问出"凭据被拒"就停掉自动重连（用户去重新登录，或者点重试再走一次）。
   */
  private async checkCredentials(): Promise<void> {
    if (this.probeAuth === null || this.credentialsRejected || this.authProbeInFlight) return;
    this.authProbeInFlight = true;
    let rejected = false;
    try {
      rejected = await this.probeAuth();
    } catch {
      rejected = false;
    }
    this.authProbeInFlight = false;
    if (this.disposed || !rejected) return;
    this.credentialsRejected = true;
    this.clearTimers();
    this.dropSocket();
    this.setState('unauthorized');
    this.listener.onError?.(new Error('凭据已失效（401）：停止自动重连'));
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.setState('reconnecting');
    // 只有"活够久"的连接才允许把退避清零，否则握手后立刻断会变成每秒重连。
    const stable = isStableConnection(this.openedAt, Date.now(), this.timing.stableConnectionMs);
    this.attempt = nextAttempt(this.attempt, stable);
    this.openedAt = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = reconnectDelay(
      this.attempt,
      Math.random,
      this.timing.baseDelayMs,
      this.timing.maxDelayMs,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
    // 退避越久，网络恢复时的等待越难受（用户刚从电梯里出来）。所以在等待期间轻量
    // 探测一次可达性：通了就立刻重连，不再等满这一轮。
    this.startProbe();
  }

  /**
   退避期间的网络探测。

   **只有在"网络刚回来"这个瞬间才提前重连**，而不是"探测通了就提前重连"。

   区别很重要，两个都是实测过的形状：
   - 用户从电梯里出来：探测一直是 false（请求发不出去），恢复的那一刻变成 true。
     这时不该让他把已经涨到十几秒的退避等完——那正是用户最想摔手机的十几秒。
   - 服务端的 WS 坏了但主机还在（网关接受后立刻断）：探测**从头到尾都是 true**。
     这种情况下每 3s 就用探测把退避打断，等于把退避整个取消掉——那正是要防的重连风暴。
     没有"从不通到通"这个跳变，就老老实实按退避等。

   RN 侧没有 NetInfo 可用（不在依赖里，加它要动原生依赖），所以用可达性探测代替事件。
   */
  private startProbe(): void {
    this.stopProbe();
    const tick = async () => {
      this.probeTimer = null;
      if (this.disposed || this.reconnectTimer === null) return;
      let reachable = false;
      try {
        reachable = await this.probe();
      } catch {
        reachable = false;
      }
      if (this.disposed || this.reconnectTimer === null) return;
      const cameBack = reachable && this.lastProbeReachable === false;
      this.lastProbeReachable = reachable;
      if (cameBack) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.openSocket();
        return;
      }
      this.probeTimer = setTimeout(() => void tick(), this.probeIntervalMs);
    };
    this.probeTimer = setTimeout(() => void tick(), this.probeIntervalMs);
  }

  private stopProbe(): void {
    if (this.probeTimer !== null) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    // 探测结果只在一次退避里有效："上一次还是不通"这个记忆跨重连留着会误判。
    this.lastProbeReachable = null;
  }

  /**
   建连超时。
   
   没有它的话，"连不出去但也收不到任何回调"的网络会让状态永远停在 `connecting`
   （实测 15s 无任何事件），而 `connect()` 见到 connecting 就返回，于是此后所有
   发送都被静默排队——用户以为发出去了。
   */
  private armConnectTimeout(socket: WebSocket): void {
    this.clearConnectTimeout();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.socket !== socket) return;
      if (this.state === 'open') return;
      this.listener.onError?.(new Error(`建连超时（${this.timing.connectTimeoutMs}ms）`));
      this.dropSocket();
      this.scheduleReconnect();
    }, this.timing.connectTimeoutMs);
  }

  private clearConnectTimeout(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.beat(), this.timing.heartbeatMs);
  }

  /**
   心跳 + 死链判定。
   
   服务端不发 ping，但**重发订阅一定会换回一个 snapshot**，所以"探针发出去、回音
   没回来"就是一个可靠的死链判据。没有这个判据的话，NAT 静默丢包会让客户端永远
   停在 `open` 上（实测 40s：订阅发了 2 次，收到的帧 0 个，状态一直是 open，界面
   看起来一切正常）。
   
   没有订阅时无法探测（协议里没有一个无副作用、能换回响应的帧可用），这种情况下
   不做判定——不去猜一条没有可观测行为的链路死没死。
   */
  private beat(): void {
    const sessions = [...this.subscriptions.keys()];
    if (sessions.length === 0) return;
    /**
     探针只有 socket **真的 OPEN** 时才发得出去——`send()` 见到非 OPEN 就只记账/排队
     （见它的实现）。没发出去的探针不会有回音，拿它判死链等于给一条**还没连上**的链路
     判死刑：重连窗口里心跳恰好落在"旧 socket 已丢、新 socket 还在 CONNECTING"之间时，
     `livenessGraceMs` 之后这一判就会掐掉一条可能马上就通的连接。

     真机上的代价不是测试红，是**慢网重连被反复掐死**；在 `ws` 上还会顺带炸出
     未捕获异常（`close()` 一个 CONNECTING 的 socket）。2026-09-18 实测。
     */
    const socket = this.socket;
    if (socket === null || socket.readyState !== 1) return;
    const probeAt = Date.now();
    for (const sessionId of sessions) this.subscribe(sessionId);
    // 已经在等回音了就别把期限往后推——推一次就等于永远不判（每次心跳都重置期限，
    // 死链就永远发现不了）。
    if (this.livenessTimer !== null) return;
    /**
     回音期限只等 `livenessGraceMs`（默认 10s），**不是**再等一个完整心跳周期。

     探针就是一次 `runtime_subscribe`，服务端的回答（snapshot）是同一轮请求-响应里的
     事——十秒还没回来就是不会回来了。所以"发现死链"的总代价是
     `heartbeatMs + livenessGraceMs`（默认 30 + 10 = 40s）；之前写成"再等一个心跳周期"
     是 70s，白等半分钟。
     */
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = null;
      if (this.disposed || this.socket === null) return;
      if (this.lastInboundAt >= probeAt) return; // 有回音，链路活着
      this.declareDeadLink();
    }, this.timing.livenessGraceMs);
  }

  /**
   判死链：换一条连接。
   
   这里主动换而不是等 close——黑洞链路上 `close()` 的关闭帧也发不出去，等它回来
   可能就是几十秒。换之前先把旧 socket 的事件摘掉，免得它的 onclose 再排一次重连
   （那会让两条重连叠在一起）。
   */
  private declareDeadLink(): void {
    this.listener.onError?.(new Error('心跳没有回音：判定链路已死，重连'));
    this.dropSocket();
    // 这条链路刚才还是活的（连过、有订阅），从最轻的退避重新开始。
    this.openedAt = null;
    this.scheduleReconnect();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.stopLivenessTimer();
  }

  private stopLivenessTimer(): void {
    if (this.livenessTimer !== null) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  /**
   摘掉事件再关：旧 socket 的任何回调都不该再影响状态机。

   ⚠️ **`onerror` 是唯一的例外，它不能摘成 `null`**：socket 若还在 CONNECTING，
   `ws` 会在**下一个 tick 异步 emit `'error'`**（"WebSocket was closed before the
   connection was established"，`abortHandshake` 走 `process.nextTick`）——摘掉监听器
   就等于把它变成未捕获异常，而下面那个 `try/catch` 抓不到它（不是同步抛的）。
   留一个空函数：这条 socket 已经没人听了，它报什么都与我们无关。
   建连超时那条路（`armConnectTimeout`）同样会在 CONNECTING 上 close，所以这不是
   死链判定独有的情形。
   */
  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = () => {};
    try {
      socket.close();
    } catch {
      // 已经关了。
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    this.stopProbe();
    this.clearConnectTimeout();
    this.clearReconnectTimer();
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.listener.onStateChange?.(next);
  }

  private send(frame: ClientFrame): void {
    if (frame.type === 'runtime_subscribe') {
      // 先记账再发送：掉线期间订阅意图不能丢，否则重连时不知道该订阅谁。
      const existing = this.subscriptions.get(frame.session_id) ?? { epoch: null, seq: 0 };
      this.subscriptions.set(frame.session_id, existing);
    }

    const socket = this.socket;
    const open = socket !== null && socket.readyState === 1; // WebSocket.OPEN
    if (!open) {
      // 订阅/退订是状态同步，重连后会自动重放；其余控制帧必须补发。
      if (frame.type !== 'runtime_subscribe' && frame.type !== 'runtime_unsubscribe') {
        this.outbox.push(frame);
        this.notifyPending();
      }
      this.connect();
      return;
    }

    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      this.outbox.push(frame);
      this.notifyPending();
      this.listener.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** 出队一处、通知一处，跨三处 status 更新（send / flushOutbox / dispose）。 */
  private notifyPending(): void {
    this.listener.onPendingChange?.(this.outbox.length);
  }

  private flushOutbox(): void {
    const pending = this.outbox;
    this.outbox = [];
    this.notifyPending();
    for (const frame of pending) {
      const socket = this.socket;
      if (!socket || socket.readyState !== 1) {
        this.outbox.push(frame);
        continue;
      }
      try {
        socket.send(JSON.stringify(frame));
      } catch {
        this.outbox.push(frame);
      }
    }
    this.notifyPending();
  }

  // ------------------------------------------------------------ 入站

  private handleRawFrame(data: unknown): void {
    // RN 的 WebSocket 只在字符串/binary 之间有区别；二进制不是本协议的形态。
    if (typeof data !== 'string') {
      if (data instanceof ArrayBuffer) {
        if (data.byteLength > MAX_FRAME_BYTES) return;
        this.handleFrameJson(new TextDecoder().decode(data));
      }
      return;
    }
    if (data.length > MAX_FRAME_BYTES) return;
    this.handleFrameJson(data);
  }

  private handleFrameJson(text: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(text) as ServerFrame;
    } catch {
      // 坏帧不该杀掉连接；服务端偶尔会插入非 JSON 的调试输出。
      return;
    }

    const type = frameType(frame);
    switch (type) {
      case 'runtime_snapshot':
        this.handleSnapshot(frame as never);
        return;
      case 'runtime_delta':
        this.handleDelta(frame as never);
        return;
      case 'runtime_dropped':
        this.handleDropped(frame as never);
        return;
      case 'control_ack':
        this.listener.onControlAck?.(frame);
        return;
      case 'session_created': {
        const sessionId = (frame as { session_id?: unknown }).session_id;
        if (typeof sessionId === 'string') {
          this.subscriptions.set(sessionId, { epoch: null, seq: 0 });
          this.listener.onSessionCreated?.(sessionId, frame);
        }
        return;
      }
      case 'run_accepted':
        this.listener.onRunAccepted?.(frame);
        return;
      case 'run_rejected':
        this.listener.onRunRejected?.(frame);
        return;
      default:
        this.listener.onOther?.(frame);
    }
  }

  private handleSnapshot(frame: {
    session_id?: string;
    epoch?: string;
    seq?: number;
    snapshot?: Record<string, unknown>;
  }): void {
    const sessionId = frame.session_id;
    const epoch = frame.epoch;
    const seq = frame.seq;
    if (typeof sessionId !== 'string' || typeof epoch !== 'string' || typeof seq !== 'number')
      return;

    // snapshot 是权威状态，直接覆盖本地游标——不存在"比本地旧"的合法情况。
    this.subscriptions.set(sessionId, judgeSnapshot({ epoch, seq }));
    this.listener.onSnapshot?.({
      sessionId,
      epoch,
      seq,
      // 服务端在真实帧里保证了 snapshot 的形状；这里给一个空的兜底，让"字段缺失"
      // 表现为空状态而不是崩溃。
      snapshot: (frame.snapshot ?? {
        bot_id: '',
        session_id: sessionId,
        epoch,
        seq,
      }) as unknown as RuntimeSnapshotPayload,
    });
  }

  private handleDelta(frame: {
    session_id?: string;
    epoch?: string;
    seq?: number;
    delta?: Record<string, unknown>;
  }): void {
    const sessionId = frame.session_id;
    const epoch = frame.epoch;
    const seq = frame.seq;
    const delta = frame.delta;
    if (
      typeof sessionId !== 'string' ||
      typeof epoch !== 'string' ||
      typeof seq !== 'number' ||
      delta === undefined
    ) {
      return;
    }

    const current = this.subscriptions.get(sessionId) ?? { epoch: null, seq: 0 };
    const verdict = judgeDelta(current, { epoch, seq });

    switch (verdict.action) {
      case 'drop':
        return; // 重复帧。
      case 'resubscribe':
        // 服务端不做增量补齐，唯一诚实的恢复手段是重新拿 snapshot。
        this.resubscribe(sessionId, verdict.reason);
        return;
      case 'apply':
        this.subscriptions.set(sessionId, verdict.cursor);
        this.listener.onDelta?.({ sessionId, epoch, seq, delta: delta as RuntimeDelta });
        return;
    }
  }

  private handleDropped(frame: { session_id?: string; message?: string }): void {
    const sessionId = frame.session_id;
    if (typeof sessionId !== 'string') return;
    const message = typeof frame.message === 'string' ? frame.message : 'runtime subscription gap';
    this.resubscribe(sessionId, message);
  }

  /**
   空洞之后的恢复：先告诉界面"这段可能不全"，再重新订阅要 snapshot。
   
   两件事都必须做，而且顺序不能反：
   
   - **要说话**：`onGap` 让界面把状态说成"刷新中"。不说的话用户看到的是一段
     看起来连续、其实中间缺了的对话——这正是"伪造历史"在界面上的样子。
   - **要节流**：服务端如果持续处于"snapshot 与 delta 对不上"的状态，一条 delta 一次
     重订阅就是订阅风暴（实测 4s 内 38 次）。冷却期内只排一次，到点再发。
   */
  private resubscribe(sessionId: string, reason: string): void {
    this.listener.onGap?.(sessionId, reason);
    const now = Date.now();
    if (
      shouldResubscribe(
        this.lastResubscribeAt.get(sessionId) ?? null,
        now,
        this.timing.resubscribeCooldownMs,
      )
    ) {
      this.lastResubscribeAt.set(sessionId, now);
      this.subscribe(sessionId, { useCursor: false });
      return;
    }
    if (this.resubscribeTimers.has(sessionId)) return;
    const wait = Math.max(
      0,
      this.timing.resubscribeCooldownMs - (now - (this.lastResubscribeAt.get(sessionId) ?? now)),
    );
    const timer = setTimeout(() => {
      this.resubscribeTimers.delete(sessionId);
      this.lastResubscribeAt.set(sessionId, Date.now());
      this.subscribe(sessionId, { useCursor: false });
    }, wait);
    this.resubscribeTimers.set(sessionId, timer);
  }

  private cancelResubscribe(sessionId: string): void {
    const timer = this.resubscribeTimers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.resubscribeTimers.delete(sessionId);
  }
}
