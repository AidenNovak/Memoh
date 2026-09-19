/**
 * Memoh REST 客户端。
 *
 * 只用 fetch + 手写类型，不引入官方 SDK（它的 SSE helper 依赖 RN 上没有的
 * `TextDecoderStream`）。
 *
 * 鉴权模型（务必记住）：**没有 refresh token**。`/auth/refresh` 必须带未过期的
 * Bearer 才能续期；一旦过期只能重新登录。所以任意 401 都当成"会话结束"处理，
 * 通知上层清凭据回登录页——不要指望按 exp 判断就够，服务端每次请求还会查一次
 * 账号状态（停用/删除会立刻 401，即使 token 未过期）。
 */
import type { QueueItem, SessionStatus } from '../models/chat.ts';
import type {
  Bot,
  BotCheck,
  BotCreateRequest,
  BotSettings,
  ContainerMetrics,
  ContainerStatus,
  DisplayCapability,
  Account,
  ModelSummary,
  ProviderSummary,
  SkillSummary,
  Session,
  ListBotsResponse,
  ListSessionsResponse,
  LoginResponse,
  RefreshResponse,
  UIMessageListResponse,
} from './types.ts';

/**
 * 队列项的线上形状（snake_case、字段可缺）。转成 `QueueItem` 再由界面渲染——
 * 界面不直接碰线上形状，免得服务端加字段就漏出来。
 */
interface RawQueueItem {
  item_id?: string;
  text?: string;
  position?: number;
  status?: string;
}

function toQueueItem(raw: RawQueueItem, kind: 'follow-up' | 'steer'): QueueItem {
  return {
    itemId: raw.item_id ?? '',
    text: raw.text ?? '',
    position: raw.position ?? 0,
    status: raw.status ?? '',
    kind,
  };
}

/** 所有 REST 调用的上限。见 `send` 里的注释。 */
const TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** 401 = 凭据失效，调用方应清凭据回登录页。 */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

export type UnauthorizedHandler = () => void;

export interface ClientOptions {
  /** 形如 `https://memoh.example.com`，末尾斜杠会被去掉。 */
  baseUrl: string;
  /** 返回当前 token；由调用方负责从 Keychain 取。 */
  getToken: () => string | null;
  /** 收到 401 时调用，用于清凭据并跳登录。 */
  onUnauthorized?: UnauthorizedHandler;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** 把网络层异常与 HTTP 错误统一成 ApiError。 */
async function toApiError(response: Response): Promise<ApiError> {
  let message = `HTTP ${response.status}`;
  let code: string | undefined;
  try {
    const body = (await response.json()) as { message?: unknown; code?: unknown; error?: unknown };
    if (typeof body.message === 'string' && body.message !== '') message = body.message;
    else if (typeof body.error === 'string' && body.error !== '') message = body.error;
    if (typeof body.code === 'string') code = body.code;
  } catch {
    // 非 JSON 响应体（例如网关的 HTML 错误页）保持默认 message。
  }
  return new ApiError(response.status, message, code);
}

export class MemohClient {
  private readonly baseUrl: string;
  private readonly getToken: () => string | null;
  private readonly onUnauthorized?: UnauthorizedHandler;

  constructor(options: ClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.getToken = options.getToken;
    this.onUnauthorized = options.onUnauthorized;
  }

  get url(): string {
    return this.baseUrl;
  }

  /** 每次建连都要拿最新 token；不要在调用方缓存。 */
  token(): string | null {
    return this.getToken();
  }

  /** 把相对路径拼成绝对 URL。WebSocket 也用它。 */
  resolve(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  /**
   * 打任意端点。给工具脚本与尚未成型的接口用。
   *
   * 有语义的接口都应该在上面有具名方法——`request` 是逃生舱，不是主路。
   * 用它的时候顺手想一下"这个是不是该有个具名方法"。
   */
  request<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    return this.send<T>(method, path, { body });
  }

  /** GET /bots/{botId}/settings —— bot 的运行时配置（模型、审批策略等）。 */
  getSettings(botId: string): Promise<Record<string, unknown>> {
    return this.send<Record<string, unknown>>('GET', `/bots/${botId}/settings`);
  }

  updateSettings(botId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.send<Record<string, unknown>>('PUT', `/bots/${botId}/settings`, { body });
  }

  // -------------------------------------------------------------- 会话信息

  /**
   * `GET /bots/{botId}/sessions/{sessionId}/status` —— 会话的消息数、上下文用量与
   * cache 统计。
   *
   * 返回形状**按部署实测**（不是照上游类型抄）：这台部署只给 `used_tokens`，
   * 没有 `context_window` / `budget_plan` / `compaction`。类型里把那些写成可选，
   * 界面据此决定要不要显示百分比——**没有窗口就不算百分比**，算出来是编的。
   */
  getSessionStatus(botId: string, sessionId: string): Promise<SessionStatus> {
    return this.send<SessionStatus>('GET', `/bots/${botId}/sessions/${sessionId}/status`);
  }

  /**
   * 凭据还有效吗？
   *
   * 只问一件事："服务端是不是明确说了 401"。返回 `true` = 凭据没了（要重新登录）。
   *
   * 为什么要它：WebSocket 握手失败时，**超时和 401 在客户端看起来一模一样**
   * （都是一次没有升成 101 的失败），而两者的处置完全相反——超时要重试，401 重试
   * 到天亮也没用。RN 把原生失败原因放在 close 事件的 `reason` 上，但那串文本是
   * 平台细节（不同实现给的内容不一样），不能当作唯一依据。所以再问一次这个
   * 有明确语义的 REST 端点：
   *
   * - 走到这里本身**没有副作用之外的意图**：401 会按既有契约触发 `onUnauthorized`
   *   （清凭据回登录页），这正是我们想要的收敛点；
   * - 网络断了的时候这次请求自己也会失败，返回 `false`——"问不出来"不等于"凭据坏了"，
   *   宁可多试几次。
   */
  async probeAuth(): Promise<boolean> {
    try {
      await this.send('GET', '/users/me');
      return false;
    } catch (error) {
      return error instanceof ApiError && error.isUnauthorized;
    }
  }

  // -------------------------------------------------------------- 会话队列

  /**
   * `GET /bots/{botId}/sessions/{sessionId}/queue` —— 两条队列一起拿。
   *
   * `steer_supported` 决定界面要不要给"插话"选项：不是所有运行形态都能被插话
   * （服务端 `SteerSupported`）。宁可不给这个入口，也不要给了却必然失败。
   */
  async getSessionQueue(
    botId: string,
    sessionId: string,
  ): Promise<{ followUp: QueueItem[]; steer: QueueItem[]; steerSupported: boolean }> {
    const raw = await this.send<{
      follow_up?: RawQueueItem[];
      steer?: RawQueueItem[];
      steer_supported?: boolean;
    }>('GET', `/bots/${botId}/sessions/${sessionId}/queue`);
    return {
      followUp: (raw.follow_up ?? []).map((item) => toQueueItem(item, 'follow-up')),
      steer: (raw.steer ?? []).map((item) => toQueueItem(item, 'steer')),
      steerSupported: raw.steer_supported === true,
    };
  }

  /**
   * `POST .../follow-up-queue` —— 这一轮跑完再跑（运行中发送的默认落点）。
   *
   * `invocationId` 是**幂等身份**：同一个发送手势重试必须带同一个 id，否则服务端
   * 会入两条（见 `features/chat/queue.ts` 的闸门说明）。
   */
  enqueueFollowUp(
    botId: string,
    sessionId: string,
    text: string,
    invocationId: string,
  ): Promise<RawQueueItem> {
    return this.send<RawQueueItem>('POST', `/bots/${botId}/sessions/${sessionId}/follow-up-queue`, {
      body: { invocation_id: invocationId, text },
    });
  }

  /** `POST .../steer-queue` —— 插进正在跑的那一轮，agent 立刻看到。 */
  enqueueSteer(
    botId: string,
    sessionId: string,
    text: string,
    invocationId: string,
  ): Promise<RawQueueItem> {
    return this.send<RawQueueItem>('POST', `/bots/${botId}/sessions/${sessionId}/steer-queue`, {
      body: { invocation_id: invocationId, text },
    });
  }

  /** 删掉一条还没被取用的队列项。 */
  deleteQueueItem(
    botId: string,
    sessionId: string,
    kind: 'follow-up' | 'steer',
    itemId: string,
  ): Promise<unknown> {
    const segment = kind === 'steer' ? 'steer-queue' : 'follow-up-queue';
    return this.send<unknown>(
      'DELETE',
      `/bots/${botId}/sessions/${sessionId}/${segment}/${encodeURIComponent(itemId)}`,
    );
  }

  /** 把一条 follow-up 提成 steer（"别等它跑完，现在就告诉它"）。 */
  promoteQueueItem(botId: string, sessionId: string, itemId: string): Promise<RawQueueItem> {
    return this.send<RawQueueItem>(
      'POST',
      `/bots/${botId}/sessions/${sessionId}/follow-up-queue/${encodeURIComponent(itemId)}/steer`,
    );
  }

  /**
   * `authenticated: false` 只给 `/auth/login` 用——那是唯一公开的鉴权入口。
   */
  private async send<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      authenticated?: boolean;
    } = {},
  ): Promise<T> {
    const { body, query, authenticated = true } = options;
    const url = new URL(this.resolve(path));
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticated) {
      const token = this.getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    /**
     * 超时。
     *
     * 没有它的话，一个半死不活的连接（弱网、服务端卡住）会让界面**永远转圈**——
     * 用户唯一的出路是杀掉 App。15 秒是"比任何正常请求都长，但短到用户还愿意等"
     * 的那个数；超时抛的 `code: 'timeout'` 让界面能说"服务器没响应"而不是"没有网络"。
     */
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new ApiError(0, `request timed out after ${TIMEOUT_MS}ms`, 'timeout');
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new ApiError(0, detail);
    }

    clearTimeout(timer);

    if (!response.ok) {
      const apiError = await toApiError(response);
      if (apiError.isUnauthorized && authenticated) this.onUnauthorized?.();
      throw apiError;
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (text === '') return undefined as T;
    return JSON.parse(text) as T;
  }

  // -------------------------------------------------------------- 认证

  /** 唯一公开入口。成功后应把返回的 profile 落盘（refresh 不再返回这些字段）。 */
  login(username: string, password: string): Promise<LoginResponse> {
    return this.send<LoginResponse>('POST', '/auth/login', {
      body: { username, password },
      authenticated: false,
    });
  }

  /** 需要当前 token 仍然有效。过期就救不回来了。 */
  refresh(): Promise<RefreshResponse> {
    return this.send<RefreshResponse>('POST', '/auth/refresh');
  }

  me(): Promise<Account> {
    return this.send<Account>('GET', '/users/me');
  }

  // -------------------------------------------------------------- Bot

  listBots(): Promise<ListBotsResponse> {
    return this.send<ListBotsResponse>('GET', '/bots');
  }

  /**
   * 建一个 bot。
   *
   * ⚠️ **不要带 `wait_for_ready: true`**：服务端那条路会同步跑完整个容器生命周期
   * （拉镜像 → 建工作区 → 就绪）才回响应，且服务端自己没有超时——任何一跳先超时都会
   * 让客户端以为失败，而服务端其实还在建。所以这里发普通 JSON（拿 201 + `status: creating`），
   * 再由调用方轮询到 `ready`（见 `features/bots/create.ts`）。
   *
   * 另外注意路由：`POST /bots` 与 `GET /bots/name-availability` 都挂在 `/bots` 下，
   * 但服务端的匹配是**精确**的，不会把 `name-availability` 当成 bot id。
   */
  createBot(body: BotCreateRequest): Promise<Bot> {
    return this.send<Bot>('POST', '/bots', { body });
  }

  /**
   * 改 bot 的**本体**（`PUT /bots/{id}`）：显示名、头像、时区、启用状态。
   *
   * 只发要改的字段——服务端那边是 `Pointer` 语义（`*string` / `*bool`），没发的字段保持原样。
   * 一次把全量字段回传会让"另一个客户端刚改过的字段"被覆盖掉。
   */
  updateBot(
    botId: string,
    body: { display_name?: string; avatar_url?: string; timezone?: string; is_active?: boolean },
  ): Promise<Bot> {
    return this.send<Bot>('PUT', `/bots/${encodeURIComponent(botId)}`, { body });
  }

  /**
   * bot 的设置（`GET /bots/{id}/settings`）。
   *
   * 与 bot 本体分开：本体是身份（名字、头像），这里是行为（默认模型、语言、桌面开关）。
   */
  getBotSettings(botId: string): Promise<BotSettings> {
    return this.send<BotSettings>('GET', `/bots/${encodeURIComponent(botId)}/settings`);
  }

  /**
   * 改设置（`POST /bots/{id}/settings`）。
   *
   * 参考字段（`chat_model_id` 之类）是**指针语义**：不传 = 保持，传 `""` = 清空。
   * 所以这里也尽量只发改过的字段（见 `features/bots/settings.ts`）。
   */
  updateBotSettings(botId: string, body: Record<string, unknown>): Promise<BotSettings> {
    return this.send<BotSettings>('POST', `/bots/${encodeURIComponent(botId)}/settings`, { body });
  }

  /**
  手动压缩上下文（**同步**执行）。
   *
  服务端返回 `{status, summary?, message_count}`；失败时用**类型化错误码**回答
  （如 `compaction_model_unavailable`）——那不是"失败"，是"这台部署现在没有能用来做压缩的
  模型"。文案分档见 `features/session/compaction.ts`。
   *
  它真的会调一次模型把上下文写成摘要，所以调用方要给 loading，成功后**重拉一次会话状态**
  （否则面板上还是压缩前的数字）。
   */
  compactSession(
    botId: string,
    sessionId: string,
  ): Promise<{ status?: string; summary?: string; message_count?: number }> {
    return this.send<{ status?: string; summary?: string; message_count?: number }>(
      'POST',
      `/bots/${encodeURIComponent(botId)}/sessions/${encodeURIComponent(sessionId)}/compact`,
    );
  }

  /** bot 的运行时检查（"N 项未通过"的原文）。 */
  listBotChecks(botId: string): Promise<{ items?: BotCheck[] }> {
    return this.send<{ items?: BotCheck[] }>('GET', `/bots/${encodeURIComponent(botId)}/checks`);
  }

  /** 单个 bot。新建后的进度轮询靠它。 */
  getBot(botId: string): Promise<Bot> {
    return this.send<Bot>('GET', `/bots/${encodeURIComponent(botId)}`);
  }

  /**
   * 名字可用性。表单里 400ms 防抖调它。
   *
   * `reason` 的取值：`available` / `taken` / `invalid` / `reserved`——界面四态就是这么来的，
   * 别把它压成一个布尔（"被占用"和"保留字"给用户的下一步动作不同）。
   */
  checkBotNameAvailability(
    name: string,
    excludeBotId?: string,
  ): Promise<{ available: boolean; reason: string }> {
    return this.send<{ available: boolean; reason: string }>('GET', '/bots/name-availability', {
      query: { name, exclude_bot_id: excludeBotId },
    });
  }

  deleteBot(botId: string): Promise<unknown> {
    return this.send<unknown>('DELETE', `/bots/${encodeURIComponent(botId)}`);
  }

  // -------------------------------------------------------------- 会话

  listSessions(
    botId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<ListSessionsResponse> {
    return this.send<ListSessionsResponse>('GET', `/bots/${botId}/sessions`, {
      query: { limit: options.limit, cursor: options.cursor },
    });
  }

  /**
   * 单个会话的详情。
   *
   * 会话列表是分页的（默认 50 条），所以"当前会话不在已加载的那一页里"是常态——
   * 从通知、深链或另一个 bot 切进来时都会这样。直接拿列表去查标题会查不到，
   * 标题就退化成占位文案，用户看不出自己在哪个会话里。
   */
  getSession(botId: string, sessionId: string): Promise<Session> {
    return this.send<Session>('GET', `/bots/${botId}/sessions/${sessionId}`);
  }

  /**
   * 列模型。用于「这个 bot 能用哪些模型」以及测试跨模型家族的行为差异。
   */
  listModels(): Promise<{ items?: ModelSummary[] } | ModelSummary[]> {
    return this.send<{ items?: ModelSummary[] } | ModelSummary[]>('GET', '/models');
  }

  /**
   * bot 的容器（只读）。
   *
   * `status`（容器在不在跑）与 `task_running`（这一轮任务在不在跑）**是两件事**，
   * 界面别把它们说成同一句。
   */
  getContainer(botId: string): Promise<ContainerStatus> {
    return this.send<ContainerStatus>('GET', `/bots/${encodeURIComponent(botId)}/container`);
  }

  /** 资源用量。后端可能说 `supported: false`——那时界面该说"读不到"，不是"0%"。 */
  getContainerMetrics(botId: string): Promise<ContainerMetrics> {
    return this.send<ContainerMetrics>(
      'GET',
      `/bots/${encodeURIComponent(botId)}/container/metrics`,
    );
  }

  /**
   * 桌面能力探针。
   *
   * 注意它**只说能力**，不代表能连上：画面是 WebRTC，媒体走 UDP，而本项目的 iOS 客户端
   * 还没有接原生 WebRTC（见 `features/machine/panel.ts` 的说明）。所以这个探针的用途是
   * "告诉用户这台机器的桌面是什么状态"，不是"点这里就能看画面"。
   */
  getDisplay(botId: string): Promise<DisplayCapability> {
    return this.send<DisplayCapability>(
      'GET',
      `/bots/${encodeURIComponent(botId)}/container/display`,
    );
  }

  /**
   * 某个 bot 的**运行时可用**技能清单（斜杠菜单用）。
   *
   * 只列"能在这轮对话里激活"的技能——服务端已经筛过了（`state: effective`），
   * 客户端不要再按自己的理解过滤一遍。
   */
  listSkills(botId: string): Promise<{ skills?: SkillSummary[] }> {
    return this.send<{ skills?: SkillSummary[] }>(
      'GET',
      `/bots/${encodeURIComponent(botId)}/skills/catalog`,
    );
  }

  /**
   * 列 provider。
   *
   * 只为一个目的：模型选择器按 provider 分组时要有**名字**。`GET /models` 只给
   * `provider_id`，把一串 uuid 当分组标题等于没有分组。取不到就退回一组平铺（见
   * `features/chat/models.ts` 的 `sectionsFrom`），不拿 provider_id 冒充名字。
   */
  listProviders(): Promise<{ providers?: ProviderSummary[] } | ProviderSummary[]> {
    return this.send<{ providers?: ProviderSummary[] } | ProviderSummary[]>('GET', '/providers');
  }

  createSession(botId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.send<unknown>('POST', `/bots/${botId}/sessions`, { body });
  }

  /**
   * 改会话（`PATCH /bots/{bot_id}/sessions/{session_id}`）。
   *
   * 目前只用来**重命名**（`{title}`）。这条路在部署实例上实测过：2026-09-16，
   * `{"title": 原值}` → 200，回来的会话对象里 `title` 就是发过去的那个（`tools/` 里的
   * 探针脚本，见 `docs/research/verified-behaviour.md` 的做法）。
   */
  updateSession(botId: string, sessionId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.send<unknown>('PATCH', `/bots/${botId}/sessions/${sessionId}`, { body });
  }

  /**
   * 从一个助手轮次分叉出新会话（`POST /bots/{bot_id}/sessions/{session_id}/fork`）。
   *
   * `turn_id` 必须是**助手轮次**的 id（不是消息 id）：服务端按它找到那一轮，
   * 把这一轮连同之前的消息复制到新会话里（`internal/chat/thread/service.go` 的
   * `ForkFromAssistantTurn`）。`title` 省略时服务端用 `<源标题> fork`。
   *
   * **不是所有会话都能分叉**：非 `chat` 类型（定时任务会话等）服务端回 409
   * `only chat sessions can be forked`。所以调用方要先判类型，别给一个必然失败的入口。
   *
   * 实测（2026-09-16，部署实例 8/30 镜像）：对一个 chat 会话的真助手轮次 POST → **201**，
   * 新会话里带着那一轮的两条消息（探针跑完把新会话删掉了）。
   */
  forkSession(
    botId: string,
    sessionId: string,
    body: { turn_id: string; title?: string },
  ): Promise<{ id?: string; title?: string }> {
    return this.send<{ id?: string; title?: string }>(
      'POST',
      `/bots/${encodeURIComponent(botId)}/sessions/${encodeURIComponent(sessionId)}/fork`,
      { body },
    );
  }

  deleteSession(botId: string, sessionId: string): Promise<void> {
    return this.send<void>('DELETE', `/bots/${botId}/sessions/${sessionId}`);
  }

  /**
   * 会话历史。注意这是**轮次**（UITurn）列表，不是扁平消息列表。
   * `before_message_id` 用于向前翻页。
   */
  listMessages(
    botId: string,
    sessionId: string,
    options: { limit?: number; beforeMessageId?: string | number } = {},
  ): Promise<UIMessageListResponse> {
    return this.send<UIMessageListResponse>('GET', `/bots/${botId}/messages`, {
      query: {
        session_id: sessionId,
        limit: options.limit,
        before_message_id: options.beforeMessageId,
      },
    });
  }

  /** 会话上下文用量 / 缓存命中 / 技能列表。**不是**运行状态。 */
  sessionStatus(botId: string, sessionId: string): Promise<Record<string, unknown>> {
    return this.send<Record<string, unknown>>('GET', `/bots/${botId}/sessions/${sessionId}/status`);
  }

  // -------------------------------------------------------------- 用量

  tokenUsage(botId: string): Promise<Record<string, unknown>> {
    return this.send<Record<string, unknown>>('GET', `/bots/${botId}/token-usage`);
  }

  // -------------------------------------------------------------- 工作区文件

  /** ⚠️ 这个端点的 JSON 是 camelCase（`modTime` / `isDir`），全仓唯一例外。 */
  listFiles(botId: string, path: string): Promise<Record<string, unknown>> {
    return this.send<Record<string, unknown>>('GET', `/bots/${botId}/container/fs/list`, {
      query: { path },
    });
  }

  /** ⚠️ 无大小限制，且二进制会有损。只用于小文本预览。 */
  readFile(botId: string, path: string): Promise<Record<string, unknown>> {
    return this.send<Record<string, unknown>>('GET', `/bots/${botId}/container/fs/read`, {
      query: { path },
    });
  }

  /**
   * 单个路径的 stat。
   *
   * **404 是"这个文件不存在"的唯一可靠信号**（服务端不返回别的形状），所以调用方要把
   * `ApiError.status === 404` 当作"不存在"而不是"网络坏了"。
   */
  statFile(botId: string, path: string): Promise<Record<string, unknown>> {
    return this.send<Record<string, unknown>>('GET', `/bots/${botId}/container/fs`, {
      query: { path },
    });
  }

  /**
   * 下载用的绝对地址与请求头。
   *
   * `fs/download` 返回**原始字节**（目录会现打一个 tar.gz），走不了 `send` 的 JSON 通道，
   * 而且**没有大小上限**——必须流式落盘，绝不能先 `await res.text()`。这里只把地址和
   * 鉴权头拼出来交给原生侧，避免 token 在各处乱传。
   */
  downloadTarget(botId: string, path: string): { url: string; headers: Record<string, string> } {
    const url = new URL(this.resolve(`/bots/${botId}/container/fs/download`));
    url.searchParams.set('path', path);
    const token = this.getToken();
    return {
      url: url.toString(),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
  }

  // -------------------------------------------------------------- 定时任务

  listSchedules(botId: string): Promise<Record<string, unknown>> {
    return this.send<Record<string, unknown>>('GET', `/bots/${botId}/schedule`);
  }

  getSchedule(botId: string, scheduleId: string): Promise<Record<string, unknown>> {
    return this.send<Record<string, unknown>>(
      'GET',
      `/bots/${botId}/schedule/${encodeURIComponent(scheduleId)}`,
    );
  }

  /** 新建。返回 201，服务端补全 id 与时间戳后把整条还回来。 */
  createSchedule(botId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.send<Record<string, unknown>>('POST', `/bots/${botId}/schedule`, { body });
  }

  /**
   * 改一条。
   *
   * ⚠️ 这是 **patch** 语义（省略的字段=不改），但 `execution` 是**整块替换**：只改其中
   * 一项也要先 GET 到整块再 PUT 回去，否则其余几项会被清空。
   * ⚠️ `max_calls` 要"取消上限"必须显式发 `null`，省略它等于"不改"。
   */
  updateSchedule(
    botId: string,
    scheduleId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.send<Record<string, unknown>>(
      'PUT',
      `/bots/${botId}/schedule/${encodeURIComponent(scheduleId)}`,
      { body },
    );
  }

  deleteSchedule(botId: string, scheduleId: string): Promise<unknown> {
    return this.send<unknown>(
      'DELETE',
      `/bots/${botId}/schedule/${encodeURIComponent(scheduleId)}`,
    );
  }

  /**
   * 跨任务的执行日志（一次调用拿全，别再按任务 N 次请求）。
   *
   * 列表行要的"最近一次结果"只能从这里取——任务本身**没有** `next_run` / `last_run` 字段。
   */
  listScheduleLogs(
    botId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.send<Record<string, unknown>>('GET', `/bots/${botId}/schedule/logs`, {
      query: { limit: options.limit, offset: options.offset },
    });
  }
}
