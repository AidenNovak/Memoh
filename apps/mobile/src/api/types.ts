/**
 * Memoh 协议类型。
 *
 * 真源：`spec/swagger.json`（REST）与 Go 实现（WebSocket 与 UI 视图模型），见
 * `docs/research/memoh-api.md`。这里只声明 iOS 用得到的部分，并且**刻意手写**——
 * 官方 `@memohai/sdk` 的 SSE helper 依赖 RN 上没有的 `TextDecoderStream`，
 * 我们不把它当运行时依赖。
 *
 * 命名约定（重要）：Memoh 的 REST JSON 大部分是 snake_case，**唯一例外**是
 * `GET /container/fs/list`（camelCase 的 `modTime` / `isDir`），见 `FileEntry`。
 *
 * 视图模型的权威定义在 `internal/agent/view/uimessage.go` —— 形状是**扁平的**，
 * 不是嵌套的 blocks 数组，这跟直觉不符，改之前先回去读那个文件。
 */

// ---------------------------------------------------------------- 账号

export type UserRole = 'admin' | 'member' | string;

export interface LoginResponse {
  access_token: string;
  token_type: string;
  /** ISO8601。默认签发 168h。没有 refresh token，过期即重登。 */
  expires_at: string;
  user_id: string;
  role: UserRole;
  display_name: string;
  username: string;
  timezone: string;
}

/**
 * `/auth/refresh` 只回这三样——`user_id` / `role` / `display_name` / `timezone`
 * 是登录独有的，别指望刷新能拿到，所以登录时必须把 profile 落盘。
 */
export interface RefreshResponse {
  access_token: string;
  token_type: string;
  expires_at: string;
}

export interface Account {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  display_name: string;
  avatar_url: string;
  timezone: string;
  is_active: boolean;
  principal_is_active: boolean;
  membership_is_active: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  joined_at: string;
  membership_updated_at: string;
  last_login_at: string;
  title_model_id: string;
}

// ---------------------------------------------------------------- Bot

export interface Bot {
  id: string;
  name: string;
  display_name: string;
  /**
   * 头像 URL。**可能不存在**：服务端是 `omitempty`（没有头像时连这个 key 都没有）。
   *
   * 这里已经炸过一次：`bot.avatar_url.trim()` 直接把整屏弄红。读的时候一律走
   * `features/bots/avatar.ts` 的归一化（先收 `unknown` 再判类型），别在协议字段上
   * 直接 `.trim()` / `.toLowerCase()`。
   */
  avatar_url?: string;
  owner_user_id: string;
  status: string;
  /**
   * 执行时区（IANA 名字）。**可能整个不存在**：服务端字段是 `omitempty`，而"没设过"
   * 就是 NULL——实测清空之后 `GET /bots/{id}` 的响应里连这个 key 都没有。
   * 读的时候一律走 `features/bots/timezones.ts` 的 `normalizeTimezone` /
   * `effectiveTimezone`，别写 `bot.timezone !== ''` 这种判断（undefined 会溜过去）。
   */
  timezone?: string;
  is_active: boolean;
  check_state: string;
  check_issue_count: number;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
  /**
   * 关键：`workspace_exec` / `manage` 是能不能连 WebSocket 的门槛。
   * 只有 `chat` 的成员看不到实时流，只能拉 REST 历史。
   *
   * `omitempty`：没有权限时服务端**不发这个 key**，不是发一个空数组。判能力走
   * `canOpenRealtime()`（它按空数组兜底），别自己直接 `.includes(...)`。
   */
  current_user_permissions?: string[];
}

/**
 * 建 bot 的请求体（对齐桌面端 `pages/bots/new.vue` 的提交形状）。
 *
 * `wait_for_ready` 不在这个类型里：iOS 走"先创建、再轮询"那条路，不请求服务端同步等待
 * （理由见 `client.createBot`）。
 */
export interface BotCreateRequest {
  /** URL 名：`^[a-z0-9][a-z0-9-]{1,62}$`，且不能是保留字（服务端判）。 */
  name: string;
  display_name: string;
  avatar_url?: string;
  timezone?: string;
  is_active?: boolean;
  /** 访问档位：`allow_all` / `private_only` / `group_only` / `group_and_thread_only` / `deny_all`。 */
  acl_preset?: string;
}

export interface ListBotsResponse {
  items: Bot[];
}

/** 能否开实时通道。UI 用这个决定走流式还是只读回放。 */
export function canOpenRealtime(bot: Bot): boolean {
  const permissions = bot.current_user_permissions ?? [];
  return permissions.includes('workspace_exec') || permissions.includes('manage');
}

// ---------------------------------------------------------------- 会话

/**
 * 一个会话（`GET /bots/{bot_id}/sessions` / `GET .../sessions/{id}`）。
 *
 * ⚠️ **可选的那些字段不是"以防万一"**：它们逐个对着服务端 fork 的 Go 结构体核对过
 * （`internal/chat/thread/service.go` 的 `session.Thread`），带 `omitempty` 的字段在
 * 值为零时**整个 key 都不出现**。写成必填 `string` 等于告诉编译器"它一定在"，
 * 于是 `undefined` 会一路溜到 `.trim()` / `.join()` 里——`avatar_url` 已经这样炸过
 * 一次（见 `features/bots/avatar.ts` 的记录）。
 *
 * 缺字段时**不要**自己拼兜底字符串（那会渲染出 `" · chat"` 这种开头空段）：
 * 会话行的副标题走 `features/session/sourceLabel.ts` 的 `sessionSourceParts()`。
 */
export interface Session {
  id: string;
  bot_id: string;
  title: string;
  type: string;
  /** `omitempty` —— 这台部署实测一个都不返回。 */
  channel_type?: string;
  created_at: string;
  updated_at: string;
  /** `omitempty`。 */
  created_by_user_id?: string;
  /** `omitempty`（子会话才有）。 */
  parent_session_id?: string;
  /** `omitempty`。 */
  preferred_chat_model_id?: string;
  /** `omitempty`。 */
  preferred_external_model_id?: string;
  /** `omitempty`。 */
  preferred_reasoning_effort?: string;
  /** `omitempty`。 */
  model_preference_revision?: string;
  runtime_type: string;
  /** `omitempty`。 */
  runtime_metadata?: Record<string, unknown>;
  /** `omitempty`。 */
  metadata?: Record<string, unknown>;
  /** `omitempty`（外部 agent 会话才有）。 */
  bot_agent_id?: string;
  /** `omitempty`。 */
  workdir_id?: string;
  /** `omitempty`。 */
  route_conversation_type?: string;
  /** `omitempty`。 */
  route_id?: string;
  /** `omitempty`。 */
  route_metadata?: Record<string, unknown>;
  session_mode: string;
}

export interface ListSessionsResponse {
  items: Session[];
  /** 空串 = 到底了，不要再去请求空页。 */
  next_cursor: string;
}

// ---------------------------------------------------------------- 消息（扁平视图模型）

/**
 * 内容块类型。**只有这 6 种**——没有"文件改动"专有类型，diff 卡片要从 `tool`
 * 类型的 `input` / `output` 推导。
 */
export type UIMessageType = 'text' | 'reasoning' | 'tool' | 'attachments' | 'error' | 'notice';

export interface UIAttachment {
  id?: string;
  type: string;
  path?: string;
  url?: string;
  name?: string;
  mime?: string;
  size?: number;
  content_hash?: string;
  bot_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * agent 给出的审批选项，**逐字来自 agent**。客户端为每个 option 渲染一个动作，
 * 并用被选中的 option id 作答。
 */
export interface UIToolApprovalOption {
  id: string;
  name?: string;
  kind?: string;
}

export interface UIToolApproval {
  approval_id: string;
  short_id?: number;
  status: string;
  decision_reason?: string;
  can_approve?: boolean;
  options?: UIToolApprovalOption[];
  selected_option_id?: string;
}

/** agent 主动提问。走的是和审批同一套决策机制。 */
export interface UIQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface UIQuestion {
  id: string;
  text: string;
  kind: string;
  options?: UIQuestionOption[];
  allow_custom?: boolean;
  custom_exclusive?: boolean;
  required?: boolean;
  placeholder?: string;
}

export interface UIAnswer {
  question_id: string;
  question: string;
  selected?: UIQuestionOption[];
  custom_text?: string;
  text?: string;
  skipped?: boolean;
}

export interface UIUserInput {
  user_input_id: string;
  short_id?: number;
  status: string;
  questions?: UIQuestion[];
  answers?: UIAnswer[];
  can_respond?: boolean;
}

export interface UIExecutionLocation {
  kind: string;
  name: string;
}

export interface UIReasoningTiming {
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
}

/** 一条助手侧的输出块。注意是**扁平**的，没有嵌套 blocks。 */
export interface UIMessage {
  id: number;
  type: UIMessageType;
  content?: string;
  /** 工具名（`tool` 类型）。 */
  name?: string;
  input?: unknown;
  output?: unknown;
  tool_call_id?: string;
  /** 工具是否还在跑。比解析 content 可靠。 */
  running?: boolean;
  /** 工具进度流（`progress_appends` 累积到这里）。 */
  progress?: unknown[];
  approval?: UIToolApproval;
  execution_location?: UIExecutionLocation;
  user_input?: UIUserInput;
  attachments?: UIAttachment[];
  reasoning_timing?: UIReasoningTiming;
  code?: string;
  /** notice 块的机器可读参数（不要解析 content 来拿这些）。 */
  args?: Record<string, string>;
}

/**
 * 一轮对话。
 *
 * `role: 'user'` 的轮次用 `text` + `attachments`；
 * `role: 'assistant'` 的轮次用 `messages[]`。
 * `turn_position` 是准入时预留的不可变序号，用它排序，**不要**用时间戳或文本推。
 */
export interface UITurn {
  turn_id: string;
  turn_position?: number;
  role: 'user' | 'assistant' | 'system';
  kind?: string;
  messages?: UIMessage[];
  text?: string;
  user_message_kind?: string;
  attachments?: UIAttachment[];
  timestamp?: string;
  platform?: string;
  sender_display_name?: string;
  sender_avatar_url?: string;
  sender_user_id?: string;
  /**
   * 这一轮**第一条消息**的行 id（服务端 `omitempty`：可能没有）。
   *
   * 用途只有一个：向前翻页的游标（`before_message_id`）。服务端 `extendToUITurnHead`
   * 保证每一页都从轮次边界开始，所以拿这一页最老那一轮的 `id` 再往前要，就是老老实实
   * 地翻页——见 `features/chat/historyPage.ts`。
   */
  id?: string;
}

export interface UIMessageListResponse {
  items: UITurn[];
}

// ---------------------------------------------------------------- 工作区文件

/** `GET /container/fs/list` 的条目。这里是 **camelCase**，全仓唯一例外。 */
export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modTime: string;
  mode?: string;
}

export interface ListFilesResponse {
  items?: FileEntry[];
  entries?: FileEntry[];
}

// ---------------------------------------------------------------- 用量

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  cost?: number;
  [key: string]: unknown;
}

/** 建会话接口返回的形状在 swagger 里是空的，这里做一次显式窄化。 */
export function createdSessionId(response: unknown): string | null {
  if (response === null || typeof response !== 'object') return null;
  const record = response as Record<string, unknown>;
  if (typeof record.id === 'string') return record.id;
  if (typeof record.session_id === 'string') return record.session_id;
  return null;
}

// ---------------------------------------------------------------- 模型

/**
 * 一个可用的模型。
 *
 * 注意 `enable`：**导入或新建的模型默认是 disabled**。不显式启用的话 run 会在
 * 解析阶段失败（"chat model ... is disabled"），而那个错误看起来像模型不可用，
 * 不像配置没生效。
 */
/**
 bot 的运行时检查（`GET /bots/{id}/checks`）。

 这就是切换器里"N 项检查未通过"的**原文**。**字段都不是给人看的**：`summary` 是服务端的
 测试口吻句子（"Initialization finished."），`detail` 里是 `runtime_id=…` 这种内部标识符
 （只有 manage 权限才给），`title_key` 是给有文案表的客户端用的 key，`status` 是
 `ok`/`warn`/`error`/`unknown` 枚举。屏幕上该长什么样、哪些进"技术细节"，由
 `features/bots/checks.ts` 决定（真机截图那一轮把这三样直接摊上了设置页，见那里的注释）。
 */
export interface BotCheck {
  id: string;
  type: string;
  title_key?: string;
  subtitle?: string;
  status: string;
  summary: string;
  detail?: string;
  /** 探针附带的原始读数（`container_id` / `image` / `status` / `latency_ms` / `model_id` / `role`…）。 */
  metadata?: Record<string, unknown>;
}

/**
 bot 的设置（`GET /bots/{id}/settings`）。

 只列这一屏真会读写的字段——服务端那份 `SettingsSettings` 有三十多个（压缩、记忆、TTS、
  overlay、tool-approval 策略……），那些是"坐在电脑前配一次"的东西。
 */
export interface BotSettings {
  chat_model_id?: string;
  reasoning_effort?: string;
  language?: string;
  display_enabled?: boolean;
  timezone?: string;
}

/**
 模型目录里的一条（`GET /models`）。

 `reasoning` 是**服务端算好的**能力对象（`internal/handlers/models.go` 的 `withReasoning`：
 它要看 provider 的 client type，客户端算不出来）。所以界面一律读它，不要自己从
 `config.compatibilities` 之类的地方推——那正是上游修过的那个 bug：web 的 picker 与协议
 各推一份，推出来的结论不一致。
 */
export interface ModelReasoning {
  supported: boolean;
  can_disable?: boolean;
  efforts?: string[];
  default_effort?: string;
}

export interface ModelSummary {
  id: string;
  model_id: string;
  name: string;
  provider_id: string;
  type?: string;
  enable?: boolean;
  config?: Record<string, unknown>;
  reasoning?: ModelReasoning;
}

/**
 技能目录里的一条（`GET /bots/{bot_id}/skills/catalog`）。

 形状来自服务端（`internal/skills/catalog.go` 的 `SafeCatalogItem`）：`state` 是
 `effective` 之类，只有"运行时可用"的才会出现在这里——所以客户端不需要再筛一遍。
 */
export interface SkillSummary {
  name: string;
  display_name?: string;
  description: string;
  source_kind?: string;
  state?: string;
}

/**
 bot 的容器（`GET /bots/{bot_id}/container`）。

 `task_running` 与 `status` 是两个不同的东西：容器在跑不等于**这一轮任务**在跑。
 桌面端两个都显示，所以这里也分开。
 */
export interface ContainerStatus {
  container_id?: string;
  image?: string;
  status?: string;
  task_running?: boolean;
  namespace?: string;
  container_path?: string;
}

/** 资源用量（`GET /bots/{bot_id}/container/metrics`）。字段可选：后端支持度不一。 */
export interface ContainerMetrics {
  supported?: boolean;
  backend?: string;
  metrics?: {
    cpu?: { usage_percent?: number };
    memory?: { usage_bytes?: number };
    storage?: { used_bytes?: number };
  };
  resource_limits?: {
    cpu?: { limit?: number };
    memory?: { limit_bytes?: number };
    storage?: { limit_bytes?: number };
  };
}

/**
 桌面能力探针（`GET /bots/{bot_id}/container/display`）。

 这些字段的**含义差别很大**，别再压成一个布尔：`enabled` 是"这个 bot 开了桌面吗"、
 `available` 是"容器里真有桌面环境吗"、`running` 是"画面正在推吗"、`transport` 是
 "怎么推"。把它们合并显示过一次就会说错话（"桌面不可用"可能是任何一个原因）。
 */
export interface DisplayCapability {
  enabled?: boolean;
  available?: boolean;
  running?: boolean;
  transport?: string;
  encoder?: string;
  encoder_available?: boolean;
  desktop_available?: boolean;
  browser_available?: boolean;
  toolkit_available?: boolean;
  a11y_available?: boolean;
  prepare_supported?: boolean;
  unavailable_reason?: string;
}

/** provider（`GET /providers`）。只取模型选择器分组要用的两三个字段。 */
export interface ProviderSummary {
  id: string;
  name: string;
  client_type?: string;
  enable?: boolean;
}
