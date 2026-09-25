import Foundation

/// Memoh 协议模型的 Codable 镜像（`apps/mobile/src/api/types.ts` + `models/chat.ts`）。
///
/// ## 两条铁律
///
/// 1. **可选性与 TS 的 `?` 严格一致**。TS 写 `avatar_url?: string`，这里就必须是
///    `String?`：服务端那份 Go 结构体带 `omitempty`，值为零时**整个 key 都不出现**，
///    写成非可选等于告诉解码器"它一定在"，于是 `undefined` 会一路溜进 `.trim()` ——
///    `bot.avatar_url` 已经这样炸过一次（整屏红）。反过来，TS 的非可选字段这里也不许
///    放宽成可选：那会让"服务端漏发必填字段"这件事静默通过，比崩溃更难查。
/// 2. **线上字段名照抄 snake_case**，用 `CodingKeys` 映射到 lowerCamelCase。
///    **全仓唯一例外**是 `FileEntry`（camelCase 的 `isDir` / `modTime`），见那一节。
///
/// `JSONDecoder` 用默认配置（手写 CodingKeys）：`.convertFromSnakeCase` 在
/// `tool_call_id` / `user_input_id` / `bot_agent_id` 这类名字上不可靠，未知键默认忽略
/// （与 TS 一致——TS 那边多出来的键就是静静躺在对象里，没人读）。
///
/// 数值类型的选择规则：**服务端保证是整数的**（计数、字节、毫秒、序号、size）用 `Int`，
/// **可能是小数的**（比率、百分比、配额上限、金额）用 `Double`。JSON 没有 int/double 之分，
/// `JSONDecoder` 也接受 `1.0` 解成 `Int`，但 `1.5` 会失败——所以这条规则只在"真的可能是
/// 小数"的地方用 `Double`。

// MARK: - 账号

/// `POST /auth/login` 的响应（swagger `LoginResponse`）。
///
/// 注意这里**没有 refresh token**：`/auth/refresh` 只回 token 三件套，`user_id` /
/// `role` / `display_name` / `timezone` 是登录独有的，所以登录时必须把 profile 一起落盘。
public struct LoginResponse: Codable, Equatable, Sendable {
  public let accessToken: String
  public let tokenType: String
  /// ISO8601，默认签发 168h。
  public let expiresAt: String
  public let userId: String
  /// TS 是 `'admin' | 'member' | string` —— 联合里带了 `string` 等于不枚举，
  /// 所以这里也是裸 `String`（硬做成枚举反而会因服务端加角色而解码失败）。
  public let role: String
  public let displayName: String
  public let username: String
  public let timezone: String

  enum CodingKeys: String, CodingKey {
    case accessToken = "access_token"
    case tokenType = "token_type"
    case expiresAt = "expires_at"
    case userId = "user_id"
    case displayName = "display_name"
    case role
    case username
    case timezone
  }
}

/// `POST /auth/refresh` 的响应。只有这三样，别指望刷新能拿到 profile。
public struct RefreshResponse: Codable, Equatable, Sendable {
  public let accessToken: String
  public let tokenType: String
  public let expiresAt: String

  enum CodingKeys: String, CodingKey {
    case accessToken = "access_token"
    case tokenType = "token_type"
    case expiresAt = "expires_at"
  }
}

/// `GET /users/me`（swagger `Account`）。
///
/// 字段基本都是非可选（TS 那边没有 `?`，所以这里也不放宽——服务端漏发任何一个都该当场炸）。
///
/// **两个例外，`avatarURL` 与 `titleModelID` 是可选**：真响应 `tools/api-fixtures/raw/me.json`
/// 里这两个键**根本不存在**（spec 里也有它们，但都没进 `required`），而 TS 的类型把它们写成
/// 了必填——照抄成非可选就会在这份真响应上整次解码失败，正是 `avatar_url` 那一类。
/// 这条改动有第三方对照：`tools/check-api-models.py` 把这两处报成"非可选，但真响应里没有
/// 这个键"，`tools/api-parity-live.sh` 的 `me` 行也复现。**TS 的类型写错了，不是我们的选择。**
public struct Account: Codable, Equatable, Sendable {
  public let id: String
  public let username: String
  public let email: String
  public let role: String
  public let displayName: String
  /// 见类型注释：真响应里没有这个键，所以必须可选。
  public let avatarURL: String?
  public let timezone: String
  public let isActive: Bool
  public let principalIsActive: Bool
  public let membershipIsActive: Bool
  public let metadata: [String: MemohJSONValue]
  public let createdAt: String
  public let updatedAt: String
  public let joinedAt: String
  public let membershipUpdatedAt: String
  public let lastLoginAt: String
  /// 见类型注释：真响应里没有这个键，所以必须可选。
  public let titleModelID: String?

  enum CodingKeys: String, CodingKey {
    case id
    case username
    case email
    case role
    case displayName = "display_name"
    case avatarURL = "avatar_url"
    case timezone
    case isActive = "is_active"
    case principalIsActive = "principal_is_active"
    case membershipIsActive = "membership_is_active"
    case metadata
    case createdAt = "created_at"
    case updatedAt = "updated_at"
    case joinedAt = "joined_at"
    case membershipUpdatedAt = "membership_updated_at"
    case lastLoginAt = "last_login_at"
    case titleModelID = "title_model_id"
  }
}

// MARK: - Bot

/// 一个 bot（`GET /bots`、`GET /bots/{id}`，swagger `Bot`）。
///
/// `avatar_url` 与 `timezone` 是**服务端 `omitempty`**：没有头像 / 没设过时区时连这个 key
/// 都不存在（实测清空时区之后响应里就没有 `timezone`）。读的时候一律走归一化再判，
/// 别在协议字段上直接 `.trim()`。
///
/// `current_user_permissions` 同样是 `omitempty`：没有权限时服务端**不发这个 key**，
/// 不是发空数组。所以"能不能开实时通道"那种判据要按空数组兜底（那是 9B-3 的事，
/// 这一层只保证 `nil` 与 `[]` 不会被混成一个意思）。
public struct Bot: Codable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let displayName: String
  public let avatarURL: String?
  public let ownerUserId: String
  public let status: String
  public let timezone: String?
  public let isActive: Bool
  public let checkState: String
  public let checkIssueCount: Int
  public let createdAt: String
  public let updatedAt: String
  public let metadata: [String: MemohJSONValue]?
  public let currentUserPermissions: [String]?

  enum CodingKeys: String, CodingKey {
    case id
    case name
    case displayName = "display_name"
    case avatarURL = "avatar_url"
    case ownerUserId = "owner_user_id"
    case status
    case timezone
    case isActive = "is_active"
    case checkState = "check_state"
    case checkIssueCount = "check_issue_count"
    case createdAt = "created_at"
    case updatedAt = "updated_at"
    case metadata
    case currentUserPermissions = "current_user_permissions"
  }
}

/// 建 bot 的请求体（对齐桌面端 `pages/bots/new.vue` 的提交形状）。
///
/// `wait_for_ready` **不在这个类型里**：iOS 走"先创建、再轮询"，不请求服务端同步等待
/// （理由见 `MemohAPIClient.createBot`）。
public struct BotCreateRequest: Codable, Equatable, Sendable {
  /// URL 名：`^[a-z0-9][a-z0-9-]{1,62}$`，且不能是保留字（服务端判）。
  public let name: String
  public let displayName: String
  public let avatarURL: String?
  public let timezone: String?
  public let isActive: Bool?
  /// 访问档位：`allow_all` / `private_only` / `group_only` / `group_and_thread_only` / `deny_all`。
  public let aclPreset: String?

  public init(
    name: String,
    displayName: String,
    avatarURL: String? = nil,
    timezone: String? = nil,
    isActive: Bool? = nil,
    aclPreset: String? = nil
  ) {
    self.name = name
    self.displayName = displayName
    self.avatarURL = avatarURL
    self.timezone = timezone
    self.isActive = isActive
    self.aclPreset = aclPreset
  }

  enum CodingKeys: String, CodingKey {
    case name
    case displayName = "display_name"
    case avatarURL = "avatar_url"
    case timezone
    case isActive = "is_active"
    case aclPreset = "acl_preset"
  }
}

/// 改 bot 本体的请求体（`PUT /bots/{id}`）。
///
/// 服务端那边是 `Pointer` 语义（`*string` / `*bool`）：**没发的字段保持原样**。
/// 所以这里的可选性不是为了容错，而是"这一条到底发不发"的开关——一次把全量字段回传
/// 会让"另一个客户端刚改过的字段"被覆盖掉。
public struct BotUpdateRequest: Codable, Equatable, Sendable {
  public let displayName: String?
  public let avatarURL: String?
  public let timezone: String?
  public let isActive: Bool?

  public init(
    displayName: String? = nil,
    avatarURL: String? = nil,
    timezone: String? = nil,
    isActive: Bool? = nil
  ) {
    self.displayName = displayName
    self.avatarURL = avatarURL
    self.timezone = timezone
    self.isActive = isActive
  }

  enum CodingKeys: String, CodingKey {
    case displayName = "display_name"
    case avatarURL = "avatar_url"
    case timezone
    case isActive = "is_active"
  }
}

public struct ListBotsResponse: Codable, Equatable, Sendable {
  public let items: [Bot]
}

// MARK: - 会话

/// 一个会话（`GET /bots/{bot_id}/sessions` / `GET .../sessions/{id}`）。
///
/// 那些可选字段**不是"以防万一"**：它们逐个对着服务端 fork 的 Go 结构体核对过
/// （`internal/chat/thread/service.go` 的 `session.Thread`），带 `omitempty` 的字段
/// 在值为零时整个 key 都不出现。缺字段时**不要**自己拼兜底字符串（那会渲染出
/// `" · chat"` 这种开头空段）。
public struct Session: Codable, Equatable, Sendable {
  public let id: String
  public let botId: String
  public let title: String
  public let type: String
  /// `omitempty` —— 这台部署实测一个都不返回。
  public let channelType: String?
  public let createdAt: String
  public let updatedAt: String
  /// `omitempty`。
  public let createdByUserId: String?
  /// `omitempty`（子会话才有）。
  public let parentSessionId: String?
  /// `omitempty`。
  public let preferredChatModelId: String?
  /// `omitempty`。
  public let preferredExternalModelId: String?
  /// `omitempty`。
  public let preferredReasoningEffort: String?
  /// `omitempty`。
  public let modelPreferenceRevision: String?
  public let runtimeType: String
  /// `omitempty`。
  public let runtimeMetadata: [String: MemohJSONValue]?
  /// `omitempty`。
  public let metadata: [String: MemohJSONValue]?
  /// `omitempty`（外部 agent 会话才有）。
  public let botAgentId: String?
  /// `omitempty`。
  public let workdirId: String?
  /// `omitempty`。
  public let routeConversationType: String?
  /// `omitempty`。
  public let routeId: String?
  /// `omitempty`。
  public let routeMetadata: [String: MemohJSONValue]?
  public let sessionMode: String

  enum CodingKeys: String, CodingKey {
    case id
    case botId = "bot_id"
    case title
    case type
    case channelType = "channel_type"
    case createdAt = "created_at"
    case updatedAt = "updated_at"
    case createdByUserId = "created_by_user_id"
    case parentSessionId = "parent_session_id"
    case preferredChatModelId = "preferred_chat_model_id"
    case preferredExternalModelId = "preferred_external_model_id"
    case preferredReasoningEffort = "preferred_reasoning_effort"
    case modelPreferenceRevision = "model_preference_revision"
    case runtimeType = "runtime_type"
    case runtimeMetadata = "runtime_metadata"
    case metadata
    case botAgentId = "bot_agent_id"
    case workdirId = "workdir_id"
    case routeConversationType = "route_conversation_type"
    case routeId = "route_id"
    case routeMetadata = "route_metadata"
    case sessionMode = "session_mode"
  }
}

public struct ListSessionsResponse: Codable, Equatable, Sendable {
  public let items: [Session]
  /// 空串 = 到底了，不要再去请求空页。
  public let nextCursor: String

  enum CodingKeys: String, CodingKey {
    case items
    case nextCursor = "next_cursor"
  }
}

/// `GET .../status` 的响应（`models/chat.ts` 的 `SessionStatus`）。
///
/// 字段全部可选：**部署版本决定给多少**。这台部署（memohai/server 8/30 镜像）实测只给
/// `used_tokens`；上游较新的版本还会给 `context_window`、`budget_plan` 与 `compaction`。
/// 界面要能在两种形状下都说得对——尤其**没有窗口时不能说"用了百分之多少"**。
public struct SessionStatus: Codable, Equatable, Sendable {
  public struct BudgetPlan: Codable, Equatable, Sendable {
    public let window: Int?
    public let outputReserve: Int?

    enum CodingKeys: String, CodingKey {
      case window
      case outputReserve = "output_reserve"
    }
  }

  public struct Compaction: Codable, Equatable, Sendable {
    public let enabled: Bool?
    public let autoTokens: Int?

    enum CodingKeys: String, CodingKey {
      case enabled
      case autoTokens = "auto_tokens"
    }
  }

  public struct ContextUsage: Codable, Equatable, Sendable {
    public let usedTokens: Int?
    public let contextWindow: Int?
    public let budgetPlan: BudgetPlan?
    public let compaction: Compaction?

    enum CodingKeys: String, CodingKey {
      case usedTokens = "used_tokens"
      case contextWindow = "context_window"
      case budgetPlan = "budget_plan"
      case compaction
    }
  }

  public struct CacheStats: Codable, Equatable, Sendable {
    public let cacheReadTokens: Int?
    public let totalInputTokens: Int?
    public let cacheHitRate: Double?

    enum CodingKeys: String, CodingKey {
      case cacheReadTokens = "cache_read_tokens"
      case totalInputTokens = "total_input_tokens"
      case cacheHitRate = "cache_hit_rate"
    }
  }

  public let messageCount: Int?
  public let contextUsage: ContextUsage?
  public let cacheStats: CacheStats?
  /// 这次会话**用过的技能名**。形状是**字符串数组**
  /// （`HandlersSessionInfoResponse.skills?: Array<string>`），不是对象——之前
  /// 这里写成 `{id, name}[]` 是猜的。
  public let skills: [String]?

  enum CodingKeys: String, CodingKey {
    case messageCount = "message_count"
    case contextUsage = "context_usage"
    case cacheStats = "cache_stats"
    case skills
  }
}

/// 会话队列里的一条待发消息（`models/chat.ts` 的 `QueueItem`）——**规范化后的形状**，
/// 不是线上形状（线上见 `RawQueueItem`）。
public struct QueueItem: Codable, Equatable, Sendable {
  public let itemId: String
  public let text: String
  /// 服务端给的权威顺序。
  public let position: Int
  /// `accepted` = 排队中，`claimed` = agent 正在取用；其余是终态、不再显示。
  public let status: String
  public let kind: MemohQueueItemKind

  public init(itemId: String, text: String, position: Int, status: String, kind: MemohQueueItemKind) {
    self.itemId = itemId
    self.text = text
    self.position = position
    self.status = status
    self.kind = kind
  }
}

/// 队列的两条通道。`kind` **由它所在的那个数组决定**，不是服务端字段——所以这里
/// 不需要 `unknown(String)` 兜底（TS 那边也是本地构造的字面量联合，不是解出来的）。
public enum MemohQueueItemKind: String, Codable, Equatable, Sendable {
  case followUp = "follow-up"
  case steer
}

/// 队列项的**线上形状**（snake_case、字段可缺）。照抄 TS 的 `RawQueueItem`：
/// 界面不直接碰它，转成 `QueueItem` 再渲染，免得服务端加字段就漏出来。
public struct RawQueueItem: Codable, Equatable, Sendable {
  public let itemId: String?
  public let text: String?
  public let position: Int?
  public let status: String?

  enum CodingKeys: String, CodingKey {
    case itemId = "item_id"
    case text
    case position
    case status
  }
}

/// `GET .../queue` 的**规范化结果**（TS `getSessionQueue` 的返回值）。
public struct SessionQueue: Codable, Equatable, Sendable {
  public let followUp: [QueueItem]
  public let steer: [QueueItem]
  /// `steer_supported === true` 的严格结果：`"true"` / `1` / 缺失都是 `false`。
  public let steerSupported: Bool

  public init(followUp: [QueueItem], steer: [QueueItem], steerSupported: Bool) {
    self.followUp = followUp
    self.steer = steer
    self.steerSupported = steerSupported
  }
}

// MARK: - 消息（扁平视图模型）

/// 内容块类型。TS 是 6 个字面量的联合，但**服务端加新类型不许炸**：未知值落到
/// `.unknown(raw)` 而不是解码失败（TS 那边未知值也会一路透到 UI，只是走进 default 分支）。
/// 用裸 `String` 则丢掉穷尽性——`switch` 不再提醒你漏了哪一支。
public enum UIMessageType: Codable, Equatable, Sendable {
  case text
  case reasoning
  case tool
  case attachments
  case error
  case notice
  case unknown(String)

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    switch raw {
    case "text": self = .text
    case "reasoning": self = .reasoning
    case "tool": self = .tool
    case "attachments": self = .attachments
    case "error": self = .error
    case "notice": self = .notice
    default: self = .unknown(raw)
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public var rawValue: String {
    switch self {
    case .text: return "text"
    case .reasoning: return "reasoning"
    case .tool: return "tool"
    case .attachments: return "attachments"
    case .error: return "error"
    case .notice: return "notice"
    case let .unknown(raw): return raw
    }
  }
}

public struct UIAttachment: Codable, Equatable, Sendable {
  public let id: String?
  public let type: String
  public let path: String?
  public let url: String?
  public let name: String?
  public let mime: String?
  public let size: Int?
  public let contentHash: String?
  public let botId: String?
  public let metadata: [String: MemohJSONValue]?

  enum CodingKeys: String, CodingKey {
    case id
    case type
    case path
    case url
    case name
    case mime
    case size
    case contentHash = "content_hash"
    case botId = "bot_id"
    case metadata
  }
}

/// agent 给出的审批选项，**逐字来自 agent**。客户端为每个 option 渲染一个动作，
/// 并用被选中的 option id 作答。
public struct UIToolApprovalOption: Codable, Equatable, Sendable {
  public let id: String
  public let name: String?
  public let kind: String?
}

public struct UIToolApproval: Codable, Equatable, Sendable {
  public let approvalId: String
  public let shortId: Int?
  public let status: String
  public let decisionReason: String?
  public let canApprove: Bool?
  /// **可能整个不存在**：agent 没定义权限选项时服务端只回
  /// `{approval_id, short_id, status, can_approve}`。界面要能回退到"批准 / 拒绝"，
  /// 否则会变成一个没有任何按钮的审批框（9B-3 的事，这里只保证 `nil` 与 `[]` 分得开）。
  public let options: [UIToolApprovalOption]?
  public let selectedOptionId: String?

  enum CodingKeys: String, CodingKey {
    case approvalId = "approval_id"
    case shortId = "short_id"
    case status
    case decisionReason = "decision_reason"
    case canApprove = "can_approve"
    case options
    case selectedOptionId = "selected_option_id"
  }
}

/// agent 主动提问。走的是和审批同一套决策机制。
public struct UIQuestionOption: Codable, Equatable, Sendable {
  public let id: String
  public let label: String
  public let description: String?
}

public struct UIQuestion: Codable, Equatable, Sendable {
  public let id: String
  public let text: String
  public let kind: String
  public let options: [UIQuestionOption]?
  public let allowCustom: Bool?
  /// 自定义答案与选中项互斥（ACP 可显式声明）。缺省 `false`：多选时自定义文本与已选项
  /// **并存**（服务端 `applySetText` 的注释写了这个例外）。
  public let customExclusive: Bool?
  public let required: Bool?
  public let placeholder: String?

  enum CodingKeys: String, CodingKey {
    case id
    case text
    case kind
    case options
    case allowCustom = "allow_custom"
    case customExclusive = "custom_exclusive"
    case required
    case placeholder
  }
}

public struct UIAnswer: Codable, Equatable, Sendable {
  public let questionId: String
  public let question: String
  public let selected: [UIQuestionOption]?
  public let customText: String?
  public let text: String?
  public let skipped: Bool?

  enum CodingKeys: String, CodingKey {
    case questionId = "question_id"
    case question
    case selected
    case customText = "custom_text"
    case text
    case skipped
  }
}

public struct UIUserInput: Codable, Equatable, Sendable {
  public let userInputId: String
  public let shortId: Int?
  public let status: String
  public let questions: [UIQuestion]?
  public let answers: [UIAnswer]?
  public let canRespond: Bool?

  enum CodingKeys: String, CodingKey {
    case userInputId = "user_input_id"
    case shortId = "short_id"
    case status
    case questions
    case answers
    case canRespond = "can_respond"
  }
}

public struct UIExecutionLocation: Codable, Equatable, Sendable {
  public let kind: String
  public let name: String
}

public struct UIReasoningTiming: Codable, Equatable, Sendable {
  public let startedAt: String?
  public let finishedAt: String?
  public let durationMs: Int?

  enum CodingKeys: String, CodingKey {
    case startedAt = "started_at"
    case finishedAt = "finished_at"
    case durationMs = "duration_ms"
  }
}

/// 一条助手侧的输出块。**形状是扁平的**，没有嵌套 blocks——权威定义在
/// `internal/agent/view/uimessage.go`，改之前先回去读那个文件。
public struct UIMessage: Codable, Equatable, Sendable {
  public let id: Int
  public let type: UIMessageType
  public let content: String?
  /// 工具名（`tool` 类型）。
  public let name: String?
  /// `unknown` → 动态值：这个字段的形状随工具而变，服务端不保证。
  public let input: MemohJSONValue?
  public let output: MemohJSONValue?
  public let toolCallId: String?
  /// 工具是否还在跑。比解析 content 可靠。
  public let running: Bool?
  /// 工具进度流（`progress_appends` 累积到这里）。
  public let progress: [MemohJSONValue]?
  public let approval: UIToolApproval?
  public let executionLocation: UIExecutionLocation?
  public let userInput: UIUserInput?
  public let attachments: [UIAttachment]?
  public let reasoningTiming: UIReasoningTiming?
  public let code: String?
  /// notice 块的机器可读参数（不要解析 content 来拿这些）。
  public let args: [String: String]?

  enum CodingKeys: String, CodingKey {
    case id
    case type
    case content
    case name
    case input
    case output
    case toolCallId = "tool_call_id"
    case running
    case progress
    case approval
    case executionLocation = "execution_location"
    case userInput = "user_input"
    case attachments
    case reasoningTiming = "reasoning_timing"
    case code
    case args
  }
}

/// 一轮对话的说话人。同上：未知角色落到 `.unknown` 而不是解码失败。
public enum UITurnRole: Codable, Equatable, Sendable {
  case user
  case assistant
  case system
  case unknown(String)

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    switch raw {
    case "user": self = .user
    case "assistant": self = .assistant
    case "system": self = .system
    default: self = .unknown(raw)
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public var rawValue: String {
    switch self {
    case .user: return "user"
    case .assistant: return "assistant"
    case .system: return "system"
    case let .unknown(raw): return raw
    }
  }
}

/// 一轮对话。
///
/// `role: user` 的轮次用 `text` + `attachments`；`role: assistant` 的轮次用 `messages[]`。
/// `turn_position` 是准入时预留的不可变序号，用它排序，**不要**用时间戳或文本推。
public struct UITurn: Codable, Equatable, Sendable {
  public let turnId: String
  public let turnPosition: Int?
  public let role: UITurnRole
  public let kind: String?
  public let messages: [UIMessage]?
  public let text: String?
  public let userMessageKind: String?
  public let attachments: [UIAttachment]?
  public let timestamp: String?
  public let platform: String?
  public let senderDisplayName: String?
  public let senderAvatarUrl: String?
  public let senderUserId: String?
  /// 这一轮**第一条消息**的行 id（服务端 `omitempty`：可能没有）。
  ///
  /// 用途只有一个：向前翻页的游标（`before_message_id`）。服务端 `extendToUITurnHead`
  /// 保证每一页都从轮次边界开始，所以拿这一页最老那一轮的 `id` 再往前要就是老老实实翻页。
  public let id: String?

  enum CodingKeys: String, CodingKey {
    case turnId = "turn_id"
    case turnPosition = "turn_position"
    case role
    case kind
    case messages
    case text
    case userMessageKind = "user_message_kind"
    case attachments
    case timestamp
    case platform
    case senderDisplayName = "sender_display_name"
    case senderAvatarUrl = "sender_avatar_url"
    case senderUserId = "sender_user_id"
    case id
  }
}

public struct UIMessageListResponse: Codable, Equatable, Sendable {
  public let items: [UITurn]
}

// MARK: - 工作区文件

/// `GET /container/fs/list` 的条目。**这里是 camelCase（`isDir` / `modTime`），
/// 全仓唯一例外，照抄**——所以这个类型故意不写 `CodingKeys`。
public struct FileEntry: Codable, Equatable, Sendable {
  public let name: String
  public let path: String
  public let isDir: Bool
  public let size: Int
  public let modTime: String
  public let mode: String?
}

public struct ListFilesResponse: Codable, Equatable, Sendable {
  public let items: [FileEntry]?
  public let entries: [FileEntry]?
}

// MARK: - 用量

/// `GET /bots/{id}/token-usage` 的形状。TS 那个接口带 `[key: string]: unknown` 索引签名，
/// 也就是"除这几个之外还可能有任意键"——这里把未知键原样收进 `extra` 并在编码时摊回顶层：
/// 丢掉它们等于丢信息（那正是"直通端点"的规范化必须与 raw 一致的前提）。
public struct TokenUsage: Codable, Equatable, Sendable {
  public let inputTokens: Int?
  public let outputTokens: Int?
  public let totalTokens: Int?
  public let cachedTokens: Int?
  public let cost: Double?
  public let extra: [String: MemohJSONValue]

  private enum CodingKeys: String, CodingKey {
    case inputTokens = "input_tokens"
    case outputTokens = "output_tokens"
    case totalTokens = "total_tokens"
    case cachedTokens = "cached_tokens"
    case cost
  }

  /// 收未知键要一个"任意字符串"的 CodingKey。
  private struct AnyKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }

    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
  }

  public init(from decoder: Decoder) throws {
    let known = try decoder.container(keyedBy: CodingKeys.self)
    inputTokens = try known.decodeIfPresent(Int.self, forKey: .inputTokens)
    outputTokens = try known.decodeIfPresent(Int.self, forKey: .outputTokens)
    totalTokens = try known.decodeIfPresent(Int.self, forKey: .totalTokens)
    cachedTokens = try known.decodeIfPresent(Int.self, forKey: .cachedTokens)
    cost = try known.decodeIfPresent(Double.self, forKey: .cost)

    let all = try decoder.container(keyedBy: AnyKey.self)
    var rest: [String: MemohJSONValue] = [:]
    for key in all.allKeys where CodingKeys(stringValue: key.stringValue) == nil {
      rest[key.stringValue] = try all.decode(MemohJSONValue.self, forKey: key)
    }
    extra = rest
  }

  public func encode(to encoder: Encoder) throws {
    var known = encoder.container(keyedBy: CodingKeys.self)
    try known.encodeIfPresent(inputTokens, forKey: .inputTokens)
    try known.encodeIfPresent(outputTokens, forKey: .outputTokens)
    try known.encodeIfPresent(totalTokens, forKey: .totalTokens)
    try known.encodeIfPresent(cachedTokens, forKey: .cachedTokens)
    try known.encodeIfPresent(cost, forKey: .cost)

    var all = encoder.container(keyedBy: AnyKey.self)
    for (name, value) in extra {
      if let key = AnyKey(stringValue: name) { try all.encode(value, forKey: key) }
    }
  }
}

/// `POST /bots/{id}/sessions` 的响应在 swagger 里是**空的**，这里做一次显式窄化
/// （照抄 TS 的 `createdSessionId`）：`id` 优先，其次 `session_id`，都不是字符串就是 `nil`。
///
/// 为什么不用"取第一个像 id 的字符串"那种猜法：上游换字段名时，这条窄化是唯一会
/// 当场失败的地方，猜法会让它静默返回一个错的值。
public func createdSessionId(_ response: MemohJSONValue?) -> String? {
  guard case let .object(fields)? = response else { return nil }
  if case let .string(value)? = fields["id"] { return value }
  if case let .string(value)? = fields["session_id"] { return value }
  return nil
}

// MARK: - 模型目录

/// 模型目录里的一条（`GET /models`）。
///
/// `reasoning` 是**服务端算好的**能力对象（`internal/handlers/models.go` 的 `withReasoning`：
/// 它要看 provider 的 client type，客户端算不出来），所以界面一律读它，别自己从
/// `config.compatibilities` 之类的地方推。
///
/// `enable` 也值得记住：**导入或新建的模型默认是 disabled**，不显式启用的话 run 会在
/// 解析阶段失败（"chat model ... is disabled"），而那个错误看起来像模型不可用。
public struct ModelReasoning: Codable, Equatable, Sendable {
  public let supported: Bool
  public let canDisable: Bool?
  public let efforts: [String]?
  public let defaultEffort: String?

  enum CodingKeys: String, CodingKey {
    case supported
    case canDisable = "can_disable"
    case efforts
    case defaultEffort = "default_effort"
  }
}

public struct ModelSummary: Codable, Equatable, Sendable {
  public let id: String
  public let modelId: String
  public let name: String
  public let providerId: String
  public let type: String?
  public let enable: Bool?
  public let config: [String: MemohJSONValue]?
  public let reasoning: ModelReasoning?

  enum CodingKeys: String, CodingKey {
    case id
    case modelId = "model_id"
    case name
    case providerId = "provider_id"
    case type
    case enable
    case config
    case reasoning
  }
}

/// `GET /models` 的两种形状：`{items?: [...]}`（上游）或**裸数组**（本部署实测过）。
///
/// **不拍平**：拍平会丢掉"服务端到底发了哪种"，而 UI 的"取不到就平铺"判据依赖它
/// （见 `features/chat/models.ts` 的 `sectionsFrom`）——拍平之后"没有 provider 名字"
/// 与"服务端本来就没分组"就分不出来了。
public enum ModelListResponse: Codable, Equatable, Sendable {
  case wrapped([ModelSummary])
  case bare([ModelSummary])

  public init(from decoder: Decoder) throws {
    if let bare = try? decoder.singleValueContainer().decode([ModelSummary].self) {
      self = .bare(bare)
      return
    }
    let wrapped = try decoder.container(keyedBy: WrapperKey.self)
    self = .wrapped(try wrapped.decodeIfPresent([ModelSummary].self, forKey: .items) ?? [])
  }

  public func encode(to encoder: Encoder) throws {
    switch self {
    case let .bare(items):
      var container = encoder.singleValueContainer()
      try container.encode(items)
    case let .wrapped(items):
      var container = encoder.container(keyedBy: WrapperKey.self)
      try container.encode(items, forKey: .items)
    }
  }

  /// `{items: [...]}` 那一支的键。
  private enum WrapperKey: String, CodingKey {
    case items
  }
}

/// provider（`GET /providers`）。只取模型选择器分组要用的两三个字段——
/// `GET /models` 只给 `provider_id`，把一串 uuid 当分组标题等于没有分组。
public struct ProviderSummary: Codable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let clientType: String?
  public let enable: Bool?

  enum CodingKeys: String, CodingKey {
    case id
    case name
    case clientType = "client_type"
    case enable
  }
}

/// `GET /providers` 的两种形状，与 `ModelListResponse` 同一套理由（不拍平）。
public enum ProviderListResponse: Codable, Equatable, Sendable {
  case wrapped([ProviderSummary])
  case bare([ProviderSummary])

  public init(from decoder: Decoder) throws {
    if let bare = try? decoder.singleValueContainer().decode([ProviderSummary].self) {
      self = .bare(bare)
      return
    }
    let wrapped = try decoder.container(keyedBy: WrapperKey.self)
    self = .wrapped(try wrapped.decodeIfPresent([ProviderSummary].self, forKey: .providers) ?? [])
  }

  public func encode(to encoder: Encoder) throws {
    switch self {
    case let .bare(items):
      var container = encoder.singleValueContainer()
      try container.encode(items)
    case let .wrapped(items):
      var container = encoder.container(keyedBy: WrapperKey.self)
      try container.encode(items, forKey: .providers)
    }
  }

  private enum WrapperKey: String, CodingKey {
    case providers
  }
}

/// 技能目录里的一条（`GET /bots/{bot_id}/skills/catalog`）。
///
/// 形状来自服务端（`internal/skills/catalog.go` 的 `SafeCatalogItem`）：`state` 是
/// `effective` 之类，只有"运行时可用"的才会出现在这里——客户端不需要再筛一遍。
public struct SkillSummary: Codable, Equatable, Sendable {
  public let name: String
  public let displayName: String?
  public let description: String
  public let sourceKind: String?
  public let state: String?

  enum CodingKeys: String, CodingKey {
    case name
    case displayName = "display_name"
    case description
    case sourceKind = "source_kind"
    case state
  }
}

// MARK: - 容器 / 桌面

/// bot 的容器（`GET /bots/{bot_id}/container`）。
///
/// `task_running`（这一轮任务在不在跑）与 `status`（容器在不在跑）**是两件事**，
/// 界面别把它们说成同一句。
public struct ContainerStatus: Codable, Equatable, Sendable {
  public let containerId: String?
  public let image: String?
  public let status: String?
  public let taskRunning: Bool?
  public let namespace: String?
  public let containerPath: String?

  enum CodingKeys: String, CodingKey {
    case containerId = "container_id"
    case image
    case status
    case taskRunning = "task_running"
    case namespace
    case containerPath = "container_path"
  }
}

/// 资源用量（`GET /bots/{bot_id}/container/metrics`）。字段可选：后端支持度不一
/// （`supported: false` 时界面该说"读不到"，不是"0%"）。
public struct ContainerMetrics: Codable, Equatable, Sendable {
  public struct CPU: Codable, Equatable, Sendable {
    public let usagePercent: Double?

    enum CodingKeys: String, CodingKey {
      case usagePercent = "usage_percent"
    }
  }

  public struct Memory: Codable, Equatable, Sendable {
    public let usageBytes: Int?

    enum CodingKeys: String, CodingKey {
      case usageBytes = "usage_bytes"
    }
  }

  public struct Storage: Codable, Equatable, Sendable {
    public let usedBytes: Int?

    enum CodingKeys: String, CodingKey {
      case usedBytes = "used_bytes"
    }
  }

  public struct Sample: Codable, Equatable, Sendable {
    public let cpu: CPU?
    public let memory: Memory?
    public let storage: Storage?
  }

  public struct LimitCPU: Codable, Equatable, Sendable {
    public let limit: Double?
  }

  public struct LimitMemory: Codable, Equatable, Sendable {
    public let limitBytes: Int?

    enum CodingKeys: String, CodingKey {
      case limitBytes = "limit_bytes"
    }
  }

  public struct LimitStorage: Codable, Equatable, Sendable {
    public let limitBytes: Int?

    enum CodingKeys: String, CodingKey {
      case limitBytes = "limit_bytes"
    }
  }

  public struct Limits: Codable, Equatable, Sendable {
    public let cpu: LimitCPU?
    public let memory: LimitMemory?
    public let storage: LimitStorage?
  }

  public let supported: Bool?
  public let backend: String?
  public let metrics: Sample?
  public let resourceLimits: Limits?

  enum CodingKeys: String, CodingKey {
    case supported
    case backend
    case metrics
    case resourceLimits = "resource_limits"
  }
}

/// 桌面能力探针（`GET /bots/{bot_id}/container/display`）。
///
/// 这些字段的**含义差别很大**，别再压成一个布尔：`enabled` 是"这个 bot 开了桌面吗"、
/// `available` 是"容器里真有桌面环境吗"、`running` 是"画面正在推吗"、`transport` 是
/// "怎么推"。合并显示过一次就会说错话（"桌面不可用"可能是任何一个原因）。
public struct DisplayCapability: Codable, Equatable, Sendable {
  public let enabled: Bool?
  public let available: Bool?
  public let running: Bool?
  public let transport: String?
  public let encoder: String?
  public let encoderAvailable: Bool?
  public let desktopAvailable: Bool?
  public let browserAvailable: Bool?
  public let toolkitAvailable: Bool?
  public let a11yAvailable: Bool?
  public let prepareSupported: Bool?
  public let unavailableReason: String?

  enum CodingKeys: String, CodingKey {
    case enabled
    case available
    case running
    case transport
    case encoder
    case encoderAvailable = "encoder_available"
    case desktopAvailable = "desktop_available"
    case browserAvailable = "browser_available"
    case toolkitAvailable = "toolkit_available"
    case a11yAvailable = "a11y_available"
    case prepareSupported = "prepare_supported"
    case unavailableReason = "unavailable_reason"
  }
}

// MARK: - Bot 检查 / 设置

/// bot 的运行时检查（`GET /bots/{id}/checks`）——切换器里"N 项检查未通过"的**原文**。
///
/// **字段都不是给人看的**：`summary` 是服务端的测试口吻句子（"Initialization finished."），
/// `detail` 里是 `runtime_id=…` 这种内部标识符（只有 manage 权限才给），`title_key` 是给
/// 有文案表的客户端用的 key，`status` 是 `ok`/`warn`/`error`/`unknown` 枚举。屏幕上该长
/// 什么样由 `features/bots/checks.ts` 决定（那是 9B-3 的事）。
public struct BotCheck: Codable, Equatable, Sendable {
  public let id: String
  public let type: String
  public let titleKey: String?
  public let subtitle: String?
  public let status: String
  public let summary: String
  public let detail: String?
  /// 探针附带的原始读数（`container_id` / `image` / `status` / `latency_ms` / `model_id` / `role`…）。
  public let metadata: [String: MemohJSONValue]?

  enum CodingKeys: String, CodingKey {
    case id
    case type
    case titleKey = "title_key"
    case subtitle
    case status
    case summary
    case detail
    case metadata
  }
}

/// bot 的设置（`GET /bots/{id}/settings`）。
///
/// 只列这一屏真会读写的字段——服务端那份 `SettingsSettings` 有三十多个（压缩、记忆、TTS、
/// overlay、tool-approval 策略……），那些是"坐在电脑前配一次"的东西。
///
/// 参考字段（`chat_model_id` 之类）是**指针语义**：不传 = 保持，传 `""` = 清空。
public struct BotSettings: Codable, Equatable, Sendable {
  public let chatModelId: String?
  public let reasoningEffort: String?
  public let language: String?
  public let displayEnabled: Bool?
  public let timezone: String?

  enum CodingKeys: String, CodingKey {
    case chatModelId = "chat_model_id"
    case reasoningEffort = "reasoning_effort"
    case language
    case displayEnabled = "display_enabled"
    case timezone
  }
}

// MARK: - 内联响应的具名化

// TS 那边下面这几个是**内联类型**（`Promise<{ items?: BotCheck[] }>` 之类），
// Swift 里没法内联声明返回类型，所以给它们起了名字。字段与可选性逐字照抄。

/// `GET /bots/{id}/checks` 的响应。
public struct BotChecksResponse: Codable, Equatable, Sendable {
  public let items: [BotCheck]?
}

/// `GET /bots/{id}/skills/catalog` 的响应。
public struct SkillCatalogResponse: Codable, Equatable, Sendable {
  public let skills: [SkillSummary]?
}

/// `GET /bots/name-availability` 的响应。
///
/// `reason` 的取值：`available` / `taken` / `invalid` / `reserved`——界面四态就是这么来的，
/// 别把它压成一个布尔（"被占用"和"保留字"给用户的下一步动作不同）。
///
/// **`reason` 必须可选**：可用时服务端只发 `{"available": true}`——`reason` 整个键不存在
/// （真响应见 `tools/api-fixtures/raw/name-availability-available.json`）。TS 的类型把它写成
/// 必填，照抄成非可选会在这份响应上解码失败；`tools/check-api-models.py` 与
/// `tools/api-parity-live.sh` 的 `name-avail-available` 行都指着这一条。
/// 读的时候把 `nil` 当 `available`（那正是服务端的意思），别当"未知"。
public struct BotNameAvailability: Codable, Equatable, Sendable {
  public let available: Bool
  public let reason: String?
}

/// `POST .../compact` 的响应。失败时服务端用**类型化错误码**回答
/// （如 `compaction_model_unavailable`）——那不是"失败"，是"这台部署现在没有能用来做
/// 压缩的模型"，所以它落在 `MemohAPIError.code` 上，而不是这里。
public struct CompactSessionResponse: Codable, Equatable, Sendable {
  public let status: String?
  public let summary: String?
  public let messageCount: Int?

  enum CodingKeys: String, CodingKey {
    case status
    case summary
    case messageCount = "message_count"
  }
}

/// `POST .../fork` 的响应。新会话的 id 与标题。
public struct ForkSessionResponse: Codable, Equatable, Sendable {
  public let id: String?
  public let title: String?
}
