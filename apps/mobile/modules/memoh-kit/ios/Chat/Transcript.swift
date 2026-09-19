import Foundation

// Mirrors src/models/chat.ts. Transport messages must never enter this boundary.
enum BlockKind: String, Decodable, CaseIterable, Sendable {
  case text, reasoning, tool, error, notice, attachments
}

struct TranscriptBlock: Decodable, Hashable, Sendable {
  let kind: BlockKind
  let key: String
  let text: String?
  let streaming: Bool?
  let durationMs: Double?
  let name: String?
  let title: String?
  let status: String?
  let error: String?
  let location: String?
  let code: String?
  let input: ToolInput?
  /** 工具的输出。只用来读诊断（见 `ToolResultDiagnosis`），不当正文渲染。 */
  let output: ToolInput?
  let items: [Attachment]?

  struct Attachment: Decodable, Hashable, Sendable {
    let key: String
    let name: String
    let mime: String?
    let url: String?
    let size: Double?
    let isImage: Bool

    var symbolName: String {
      if isImage || mime?.hasPrefix("image/") == true { return "photo" }
      if mime?.hasPrefix("audio/") == true { return "waveform" }
      if mime?.hasPrefix("video/") == true { return "film" }
      return "doc"
    }

    var formattedSize: String? {
      guard let size, size.isFinite, size >= 0, size < Double(Int64.max) else { return nil }
      return ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
    }
  }

  var toolState: ToolState { ToolState(rawValue: status ?? "") ?? .unknown }
}

enum ToolState: String, CaseIterable, Sendable {
  case running, done, failed, unknown

  var titleKey: String {
    switch self {
    case .running: return "Running"
    case .done: return "Done"
    case .failed: return "Failed"
    case .unknown: return "Unknown"
    }
  }

  var symbolName: String {
    switch self {
    case .running: return "hourglass"
    case .done: return "checkmark.circle.fill"
    case .failed: return "exclamationmark.triangle.fill"
    case .unknown: return "questionmark.circle"
    }
  }
}

// RenderBlock.input is unknown JSON, not necessarily a command dictionary.
// Keep it typed/Sendable so input-only streaming changes also reconfigure the cell.
//
// `Hashable`（由编译器合成）是给"主线程只比 Int"那条路用的：见 `TranscriptPayload`
// 与 `NativeMessageList.apply`。合成的实现与 `Equatable` 逐字段对齐——**同源**，
// 不会出现"相等判断说变了、指纹说没变"这种两套真相。
indirect enum ToolInput: Codable, Hashable, Sendable {
  case object([String: ToolInput]), array([ToolInput]), string(String)
  case number(Double), bool(Bool), null

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() { self = .null }
    else if let value = try? container.decode(Bool.self) { self = .bool(value) }
    else if let value = try? container.decode(String.self) { self = .string(value) }
    else if let value = try? container.decode(Double.self) { self = .number(value) }
    else if let value = try? container.decode([String: ToolInput].self) { self = .object(value) }
    else { self = .array(try container.decode([ToolInput].self)) }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .object(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .bool(let value): try container.encode(value)
    case .null: try container.encodeNil()
    }
  }

  /// 给用户看的入参摘要。
  ///
  /// **不直接吐 JSON**：`{"command" : "pytest -q"}` 是给机器看的语法，花括号、引号、
  /// 冒号前的空格都在消耗注意力却零信息量。用户要的是"agent 到底执行了什么"。
  ///
  /// 规则：扁平对象渲染成 `key: value` 每行一条，顺序按 key 排序（同一份入参每次
  /// 渲染都一样，截图可比）；嵌套或数组退回紧凑 JSON——那种情况不多，也不该由半
  /// 吊子的人肉格式化去猜。
  var preview: String {
    let text: String
    if case .string(let value) = self {
      text = value
    } else if case .object(let fields) = self, !fields.isEmpty,
              fields.values.allSatisfy(\.isScalar) {
      // `!fields.isEmpty` 这个条件不能省：空对象的"所有值都是标量"是**真空成立**的，
      // 于是 `{}` 会被摊平成零行 → 预览变成空字符串 → 卡片上看起来像没有入参。
      // 测试逮住了这个（`testToolInputShapesAndInputOnlyUpdates`）。
      text = fields.keys.sorted().map { key in
        "\(key): \(fields[key]?.scalarText ?? "")"
      }.joined(separator: "\n")
    } else {
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
      guard let data = try? encoder.encode(self) else { return "" }
      text = String(decoding: data, as: UTF8.self)
    }
    let prefix = String(text.prefix(MessageListMetrics.inputCharacterLimit))
    return text.count > MessageListMetrics.inputCharacterLimit ? prefix + "…" : prefix
  }

  /// 标量（字符串/数字/布尔）——只有这种才值得摊平成 `key: value`。
  var isScalar: Bool {
    switch self {
    case .string, .number, .bool: return true
    case .object, .array, .null: return false
    }
  }

  /**
   把扁平对象摊平成 `(key, value)` 条目，供 cell 做**键值分层**渲染
   （key 用次要色、value 用正文色，对应上游 `tool-call-detail-generic.vue` 的
   `flex` 行）。

   与 `preview`（整段字符串）互补：预览给无障碍，条目给视觉。过滤空值
   （上游 filter 掉 `undefined/null/''`）。嵌套或数组没有条目——那种情况
   交给 `preview` 的紧凑 JSON。
   */
  var entries: [(key: String, value: String)] {
    if case .object(let fields) = self, !fields.isEmpty,
       fields.values.allSatisfy(\.isScalar) {
      return fields.keys.sorted().compactMap { key in
        guard let value = fields[key]?.scalarText, !value.isEmpty else { return nil }
        return (key, value)
      }
    }
    return []
  }

  var scalarText: String {
    switch self {
    case .string(let value): return value
    case .number(let value): return value.rounded() == value ? String(Int(value)) : String(value)
    case .bool(let value): return value ? "true" : "false"
    case .object, .array, .null: return ""
    }
  }

  /** 按键取名，用于在未知形状的 JSON 里找字段。 */
  func field(_ key: String) -> ToolInput? {
    if case .object(let fields) = self { return fields[key] }
    return nil
  }
}

/**
 工具结果的诊断信息。
 
 ## 为什么要读 output 才知道工具出没出错
 
 传输层的 `UIMessage` **只有 `running: Bool`**，没有 `is_error` / `status` 字段
 （`internal/agent/view/uimessage.go:58`）。所以"这个工具失败了"这件事在协议层面
 不存在——服务端只告诉你"跑完了"。
 
 上游 Web 客户端是从 output **内部**读的
 （`apps/web/src/pages/home/components/tool-result-error.ts`）：
 
 ```
 result.isError === true || result.structuredContent.isError === true
 ```
 
 注意 `exit_code !== 0` **不算失败**——上游只用它显示退出码。这个区分很重要：
 agent 在虚拟机里试错、跑一个非零退出的命令是正常的干活过程。
 
 ## 读到之后怎么用
 
 **只用来显示诊断文字，不给标题着色。** 上游把理由写在了
 `tool-call-inline.vue:225`：「非零退出码（包括 -1）或工具 isError 不等于用户任务
 失败。标题保持中性色……诊断留在展开详情中。」一次工具失败 ≠ 这一步失败 ≠ 任务失败。
 */
struct ToolResultDiagnosis: Equatable {
  let isError: Bool
  let text: String?

  static let none = ToolResultDiagnosis(isError: false, text: nil)

  /** 从 output 的任意 JSON 形状里读出诊断。读不出就返回 `.none`，绝不猜。 */
  static func read(_ output: ToolInput?) -> ToolResultDiagnosis {
    guard let output else { return .none }
    let structured = output.field("structuredContent") ?? output
    let isError = structured.field("isError")?.scalarText == "true"
    // 错误正文可能是 `content` 字符串、`content[].text`、或 `stderr`。
    let text = firstText(in: structured.field("content"))
      ?? firstText(in: structured.field("stderr"))
    return ToolResultDiagnosis(isError: isError, text: text)
  }

  private static func firstText(in value: ToolInput?) -> String? {
    guard let value else { return nil }
    if case .string(let text) = value {
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : trimmed
    }
    if case .array(let items) = value {
      let texts = items.compactMap { item -> String? in
        item.field("text")?.scalarText ?? (item.isScalar ? item.scalarText : nil)
      }.filter { !$0.isEmpty }
      return texts.isEmpty ? nil : texts.joined(separator: "\n")
    }
    return nil
  }
}

/**
 用户能对一条**回合级错误块**做什么。
 
 与 `src/features/errors/present.ts` 的 `ErrorRecovery` 同构（少一个 `signin`：凭据失效
 走 HTTP 401，由连接/登录那条路处理，不会以错误块的形式落进消息流）。
 */
enum ErrorBlockRecovery: Equatable, Sendable {
  /** 同一件事再来一次**可能**会成功（传输层那一档）。 */
  case retry
  /** 重试没有意义——界面**不要**给按钮，见 R19/R20。 */
  case none
}

/**
 一条错误块在屏幕上该说什么、该给什么动作（判据见
 `docs/research/ios-error-and-feedback.md` 的 R43–R48）。
 
 ## 为什么判据必须住在这一层（而不是写在 cell 里）
 
 它是**纯函数**：输入是服务端给的两个字符串（`code`、`text`），输出是"标题 / 原因 /
 可展开的细节 / 能不能重试"。这样同一份判断能被 hosted 测试和 `pnpm test:swift` 的
 纯逻辑测试同时钉住，而 cell 只剩下"把四个字段摆上去"。
 
 ## 和 JS 侧那一份判据的关系
 
 `features/errors/present.ts` 判的是 `ApiError`（有 HTTP status），这里判的是消息流里的
 错误块（**没有 status，只有 `code`**）。所以两边的**输入不同、结论必须一致**：那一份
 文档（§3.1）按 status 分的档，这里按 code 回推同一档：

 | `present.ts` 的档 | 这里的 witness | 结论 |
 | --- | --- | --- |
 | 网络不可达 / 超时 / 429 | `channel.runtime_unavailable`、`agent.response_timeout`、`queue_admission_overloaded` | 给动作 |
 | 5xx 但**没有** code | 块里 `code` 为空 | 给动作（见下面 `recovery(for:)` 的说明） |
 | 5xx **带** code（服务端知道原因） | 其余任何类型化 code | 不给动作 |
 | 403 / 404 / 业务拒绝 | `tool_approval.forbidden`、`bot_agent.not_found`、`context.budget_unsatisfied` … | 不给动作 |
 */
struct ErrorBlockPresentation: Equatable, Sendable {
  /** "发生了什么"。**永远**由我们给（服务端原文不当标题，R26）。 */
  let title: String
  /** "为什么"。类型化 `code` + 非空 message 时是服务端原文，否则是我们自己的兜底句。 */
  let reason: String
  /** 类型化 `code`：技术细节，默认**收起**（R47）。`nil` = 没有可展开的东西。 */
  let detail: String?
  let recovery: ErrorBlockRecovery

  var showsAction: Bool { recovery == .retry }

  /**
   重试**白名单**（R19/R45）：只列"这次没成功、下次可能成功"的传输层那一档。
   
   出处：上游 `internal/apperror/error.go` 里每个 code 的 `HTTPStatus` 与它自己的
   `Detail` 文案。命中的三类——
   
   - `agent.response_timeout`（504，"did not respond in time. Please try again."）
   - `agent.response_interrupted`（502，"was interrupted. Please try again."）
   - `queue_admission_overloaded`（429）/ `queue_admission_unavailable`（503）
   - `channel.runtime_unavailable`（503，"could not be reached"）/ `workspace.unreachable`（503）
   - `acp.operation_failed`（500，"Please try again."）
   
   **不**在名单里的一律不给动作：写进 history 的错误码大多不是"等一会儿就好"
   （`compaction.model_unavailable` 要你去配模型、`context.protected_overflow` 要你
   压缩上下文、`bot_agent.not_found` 是对象没了）。名单是白名单而不是黑名单，
   是因为**新 code 的默认答案必须是"不给"**——给错动作的代价是用户去做一件我们
   已知不会成的事（R19），而少给一次动作只是少一次方便。
   
   ✅ 可测：`pnpm test:swift` 的 `testErrorBlockRetryWhitelist`。
   */
  static let retryableCodes: Set<String> = [
    "agent.response_timeout",
    "agent.response_interrupted",
    "queue_admission_overloaded",
    "queue_admission_unavailable",
    "channel.runtime_unavailable",
    "workspace.unreachable",
    "acp.operation_failed",
  ]

  /**
   没有 `code` 时给动作（对应 §3.1 的"无 code 5xx"一行）。
   
   ⚠️ 这一档是**有意**的选择，不是漏判：服务端当前版本只在**类型化 code 存在**时才写
   错误块（`internal/agent/view/uimessage_convert.go` 的 `code != ""` 守卫），所以
   "没有 code 的错误块"意味着**我们认不出这条错误的种类**。认不出时，"再来一次"是
   唯一可执行、且不谎称知道原因的下一步（给重试 = 让用户做一件可能有用的事；不给 =
   用户连一个能做的动作都没有，而这一轮已经死了）。
   `present.ts` 用 HTTP status 分辨这一档，那里有 status；这里没有，所以按服务端
   当前不会出现的形状处理，且**必须**在有 status 的地方按 status 重判。
   */
  static func recovery(for code: String?) -> ErrorBlockRecovery {
    guard let code, !code.isEmpty else { return .retry }
    return retryableCodes.contains(code) ? .retry : .none
  }

  /**
   `code` + `text` → 一个错误块的四件东西。
   
   - **标题**：我们自己的话（R15 点名 `"Error"` 是反例；这里的标题说"发生了什么"）。
   - **原因**：只有**类型化 code + 非空 message** 才把服务端原文原样上屏（R23/R25）。
     其余（无 code、或 code 在但 message 空）用我们自己的兜底句——**不是**把
     开发者文案倒在屏幕上。
   - **细节**：类型化 code 本身。它不当正文（R23），但默认收起地留着，因为自托管
     部署的运维就是用户本人，他要拿这个标识去查自己的日志（§8）。
   */
  static func read(code: String?, text: String?) -> Self {
    let typed = typedCode(code)
    return Self(
      title: MemohStrings.text("This step failed"),
      reason: reason(typedCode: typed, text: text),
      detail: typed,
      recovery: recovery(for: typed))
  }

  /** 类型化 code = 去掉空白后非空。空字符串与 nil 是同一件事（服务端没给）。 */
  static func typedCode(_ code: String?) -> String? {
    guard let code else { return nil }
    let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private static func reason(typedCode: String?, text: String?) -> String {
    if typedCode != nil {
      let serverText = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      if !serverText.isEmpty { return serverText }
    }
    return MemohStrings.text("The server didn't say why")
  }
}

// Presentation state belongs to the list, never to a recycled cell or the transport.
struct ReasoningExpansionState {
  private var expanded = Set<TranscriptRow.ID>()

  func isExpanded(_ id: TranscriptRow.ID) -> Bool { expanded.contains(id) }

  mutating func toggle(_ id: TranscriptRow.ID) {
    guard id.kind == .reasoning else { return }
    if !expanded.insert(id).inserted { expanded.remove(id) }
  }

  mutating func retain(_ ids: [TranscriptRow.ID]) { expanded.formIntersection(ids) }
}

/// 工具卡展开状态的容器：与 reasoning 同一套纯用户驱动、跨刷新持久化语义。
struct ToolExpansionState {
  private var expanded = Set<TranscriptRow.ID>()

  func isExpanded(_ id: TranscriptRow.ID) -> Bool { expanded.contains(id) }

  mutating func toggle(_ id: TranscriptRow.ID) {
    guard id.kind == .tool else { return }
    if !expanded.insert(id).inserted { expanded.remove(id) }
  }

  mutating func retain(_ ids: [TranscriptRow.ID]) { expanded.formIntersection(ids) }
}

/**
 错误块"展开细节"的状态容器（默认收起 = 空集）。
 
 ## 两处刻意与 reasoning / tool 不同，都有实测依据（2026-09-16，模拟器）
 
 1. **按块 key（`id.block`）记，不按整条行身份**：同一块错误在 REST 历史与实时投影里的
    `turn` / `message` 可能不一样（块 key 一样，都是 `m<message id>`）。按整条身份记，
    用户刚点开的细节会在刷新后对不上。
 2. **没有 `retain`**：另外两个在每次 apply 时按"当前在屏幕上的 ids"取交集，把不在了的
    状态丢掉；这一档**不能这么做**——实测同一份转录在实时投影与 REST 历史之间会短暂缺块，
    于是"展开 → 看到错误码"在几秒后又变回收起（flow 里断言通过、读屏树里却是收起的，
    两处是同一台设备上的同一个屏幕）。用户点开技术细节是一次**显式动作**，宁可多留一个
    块 key（每个会话几十个字符），也不让它在一次刷新里自己合上。
 
 代价：状态跟着这个列表实例活（切换会话会重建列表，`key={sessionId}`），同一个块 key
 出现在两行上时会一起展开——块 key 全转录唯一，这条路走不通。
 */
struct ErrorExpansionState {
  private var expanded = Set<String>()

  func isExpanded(_ id: TranscriptRow.ID) -> Bool { expanded.contains(id.block) }

  mutating func toggle(_ id: TranscriptRow.ID) {
    guard id.kind == .error else { return }
    if !expanded.insert(id.block).inserted { expanded.remove(id.block) }
  }
}

/**
 表面的语义名（不依赖 UIKit，才能在没有 UIKit 的环境里断言）。
 
 具体对应哪个颜色由 UI 层决定（见 `MessageCells`）：浅色与深色下需要不同的取值，
 那是 UI 的事；"这两者必须是不同的东西"是政策的事，政策放在这里。
 */
enum SurfaceToken: Equatable, Sendable {
  /** 用户说的话：实心。 */
  case secondary
  /** agent 的机器活动：容器。 */
  case tertiary
}

// Foundation-only policy shared by production layout and non-hosted XCTest.
enum MessageListMetrics {
  static let blockSpacing: Double = 16
  /**
   活动行（工具/思考）相对正文的左内缩。

   列表 section inset 已是 16，正文从 16 开始；活动行再内缩 8 → 相对屏幕
   24pt，对齐 lody-ios 的 `ChatCell.leading`（tool/thought = 24）。层级：
   正文贴左是结论，活动内缩是过程。
   */
  static let activityInset: Double = 8
  static let inputCharacterLimit = 600
  static let inputLineLimit = 5

  /**
   列表底部的**常驻余量**（pt）：回底按钮与复制确认都浮在这块里，正文永远滚得进它之上。

   它解决的是"`↓ Back to bottom` 压在正文上"。判据不是"按钮做得更透一点"，而是
   **内容区里没有按钮的位置**——贴底时最后一行停在按钮停放带之上（真机几何：改前最后一行
   的底 y=703 落在按钮的 y 686..730 里，改后 y=651，与按钮顶留 35pt）。

   放在 `MessageListMetrics` 而不是 `NativeMessageList` 里有两个原因：它是**政策**
   （"按钮不许压正文"），不是那个视图的实现细节；而且 `NativeMessageList.swift` 因为
   `import ExpoModulesCore` 不进测试 bundle，断言写在那边整份 hosted 测试根本编不过
   （2026-09-17 实测：`cannot find 'NativeMessageList' in scope`）。

   Debug 下 `-MemohLegacyBottomOverlay 1` 把它当 0 用，产"改前"那张图。
   */
  static let bottomReserve: Double = 52
  /**
   余量的下限：回底按钮自己就有 44pt 触控高度，再留 8pt 间隙。
   取小了会退回"按钮压住正文"——所以它是一条能被断言的不变式，不是随手写的数字。
   */
  static let bottomReserveMinimum: Double = 44 + 8

  /**
   两种表面的分工，**必须不同**。

   - `userSurface`：用户说的一句话。实心，因为"你说的话"是实体。
   - `activitySurface`：agent 干活的过程（工具、思考）。容器，装着机器活动。

   为什么专门提出来：这两个曾经是同一种灰（都取 `.secondarySystemBackground`），
   实测在一张工具场景截图里那一种灰占了 49% 的像素——整屏一片同色，没有层级。
   把它们放到一个地方命名，是为了让"两者不同"成为一件能被断言的事，
   而不是散落在两个文件里、下次改动时又撞回一起。
   */
  static let userSurface = SurfaceToken.secondary
  static let activitySurface = SurfaceToken.tertiary

  /**
   标题是否只是把入参又说了一遍。

   上游的 `title` 经常就是整条命令，而 `input` 里又有 `command: 同一条命令`，
   于是卡片上同一句话出现两次。标题只在**补充**信息时才有价值。
   */
  static func toolTitleRepeatsInput(title: String?, inputPreview: String?) -> Bool {
    guard let title, !title.isEmpty, let inputPreview, !inputPreview.isEmpty else { return false }
    return inputPreview.range(of: title, options: .caseInsensitive) != nil
  }

  /**
   工具卡片的标题要不要显示。

   四件不同的事各自能让它消失，分开列出来是因为它们**原因不同**，将来要改的时候
   得知道是哪一条在起作用：

   - 没有标题（服务端没给）；
   - 标题就是工具名（那它没有新增信息，工具名已经在上面了）；
   - 没有入参可看时……**不影响**标题 —— 这时标题是唯一的信息来源，必须留着；
   - 标题的文字已经包含在入参里（同一条命令写两遍）。
   */
  static func showsToolTitle(title: String?, name: String?, inputPreview: String?) -> Bool {
    guard let title, !title.isEmpty else { return false }
    if title == name { return false }
    return !toolTitleRepeatsInput(title: title, inputPreview: inputPreview)
  }

  /**
   工具卡片要不要显示状态词。
   
   **只在需要说明的时候出现**：运行中（用户正等着）、失败（服务端明确说这条出错了）。
   完成与未知都不贴标签。
   
   理由：全部工具都会完成，给每一个都贴 "Done" 等于一屏里重复十几次同一句话，
   那是噪声不是信息。上游也是这么做的（`tool-call-inline.vue` 的
   `showPendingLabel` 就是 `title.pending`——只在未完成时显示）。
   
   而且它消掉了一个真实出现过的矛盾：曾出现"卡片写着 Done、下一行红字说
   Module not found"，两轮视觉评审都判定为"状态与内容打架"。"跑完了"和
   "输出里有错误"本来就是两件事，硬贴一个 Done 等于替用户下结论。
   */
  static func showsToolStatus(_ state: ToolState) -> Bool {
    switch state {
    case .running, .failed: return true
    case .done, .unknown: return false
    }
  }

  /**
   工具卡片要不要显示左边的图标。
   
   只有两件事值得一个图标：**正在跑**（用户要等着）和**服务端说这条出错了**。
   完成态没有图标——上游那一行根本没有状态图标，而我原来给完成贴的对勾在断言
   "这次调用成功了"，与"不能从一次工具调用推导成败"（第 15 条）相冲。
   三份视觉评审都把"灰色对勾 + 红色报错"读成矛盾，说明图标不该说话。
   
   ⚠️ 调用方还要再排除 running：那个状态由 spinner 表达，再来一个静态图标就是
   两个东西说同一句话（`ToolMessageCell.configure` 里做这个排除）。
   */
  static func showsToolIcon(_ state: ToolState) -> Bool {
    state == .failed
  }

  /**
   状态行文案。
   
   执行位置不在这里——它挂在标题行上（`exec · workspace`），因为它是"这个工具在
   哪儿跑"的修饰。状态行只回答"现在怎么样"。
   */
  static func toolStatusText(state: ToolState) -> String? {
    guard showsToolStatus(state) else { return nil }
    return MemohStrings.text(state.titleKey)
  }

  static func reasoningLineLimit(expanded: Bool) -> Int { expanded ? 0 : 3 }

  static func userWidthFraction(accessibilitySize: Bool) -> Double { accessibilitySize ? 0.94 : 0.78 }

  static func bottomOffset(contentHeight: Double, viewportHeight: Double,
                           topInset: Double, bottomInset: Double) -> Double {
    max(-topInset, contentHeight - viewportHeight + bottomInset)
  }

  static func anchoredOffset(itemTop: Double, distance: Double,
                             topInset: Double, bottomOffset: Double) -> Double {
    min(max(itemTop - distance, -topInset), bottomOffset)
  }

  static func isNearBottom(offset: Double, bottomOffset: Double) -> Bool {
    bottomOffset - offset <= 24
  }

  static func canRestoreAnchor(capturedRevision: Int, currentRevision: Int, isInteracting: Bool) -> Bool {
    !isInteracting && capturedRevision == currentRevision
  }
}

/**
 折叠态的"思考了 N 秒"。

 ## 为什么要有它

 服务端把思考耗时放在 `reasoning_timing.duration_ms` 里（`src/api/types.ts` 的
 `UIReasoningTiming`，reducer 已经把它挂到 reasoning 块上），但在这一轮之前**没有上屏**：
 用户看折叠的思考盒子时，只能看到"这里想过"和预览的三行，看不出想了多久——而"想了 3 秒"
 和"想了 90 秒"对"要不要展开看"完全是两种判断。

 ## 判据（可断言）

 - 有 `duration_ms` 且 ≥ 1 秒 → 显示**整秒**（四舍五入）；
 - **没有 / 不是正数 / 不到 1 秒 → 什么都不显示**。不显示比显示"0 秒"诚实：不到一秒的思考
   不值得占一个字的位置，而"0 秒"读起来像我们没测到；
 - 单位与语序走本地化（`MemohStrings`），所以英文是 `Thought for 3 seconds`、中文是
   `思考了 3 秒`，不是把数字拼进一句中文再翻译。

 ## 为什么是 Foundation-only 的纯函数

 它是**政策**（什么时候该说、说到什么精度），不是画法。放在 `Transcript.swift` 才能进
 构建机上那套纯逻辑测试（`MessageListTests.swift` 的 `MessageListLogicTests`），
 不必为了一句文案起模拟器。
 */
enum ReasoningDuration {
  /** 秒数；不到 1 秒或拿不到时长时是 `nil`（调用方据此不显示）。 */
  static func seconds(fromMilliseconds milliseconds: Double?) -> Int? {
    guard let milliseconds, milliseconds.isFinite, milliseconds >= 1000 else { return nil }
    return Int((milliseconds / 1000).rounded())
  }

  /** 本地化后的"思考了 N 秒"；没有可信时长时是 `nil`。 */
  static func label(milliseconds: Double?) -> String? {
    guard let seconds = seconds(fromMilliseconds: milliseconds) else { return nil }
    // 单数单独一条：英文 "1 seconds" 是明显的语法错，而中文两条一样（本地化表里照写）。
    if seconds == 1 { return MemohStrings.text("Thought for 1 second") }
    return String(format: MemohStrings.text("Thought for %lld seconds"), Int64(seconds))
  }
}

extension TranscriptBlock {
  /**
   思考块折叠态的标题：`Reasoning · 思考了 3 秒`。

   时长**并进标题**而不是另起一行：折叠态本来就只有三行预览，"想过多久"是这一行的属性，
   不是新的一段内容；而且展开之后它仍然该看得见（用户展开是为了读过程，不是因为不知道想了多久）。
   没有可信时长时就是标题本身——一个字符都不多加。
   */
  var reasoningHeading: String {
    let title = MemohStrings.text("Reasoning")
    guard let duration = ReasoningDuration.label(milliseconds: durationMs) else { return title }
    return "\(title) · \(duration)"
  }
}

struct TranscriptMessage: Decodable, Sendable {
  let key: String
  let role: String
  let blocks: [TranscriptBlock]
}

struct TranscriptTurn: Decodable, Sendable {
  let key: String
  let position: Double
  let user: TranscriptMessage?
  let assistant: TranscriptMessage?
  let active: Bool
}

struct TranscriptRow: Hashable, Sendable {
  struct ID: Hashable, Sendable {
    let turn: String
    let message: String
    let role: String
    let block: String
    let kind: BlockKind
  }
  let id: ID
  let block: TranscriptBlock

  static func decode(_ json: String) throws -> [Self] {
    let turns = try JSONDecoder().decode([TranscriptTurn].self, from: Data(json.utf8))
    var rows: [Self] = []
    var seen = Set<ID>()
    // The incoming order is authoritative. Never sort by text, timestamps or content size.
    for turn in turns {
      for message in [turn.user, turn.assistant].compactMap({ $0 }) {
        for block in message.blocks {
          let id = ID(turn: turn.key, message: message.key, role: message.role,
                      block: block.key, kind: block.kind)
          guard seen.insert(id).inserted else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Duplicate block identity"))
          }
          rows.append(Self(id: id, block: block))
        }
      }
    }
    return rows
  }
}

// Native-only projection. Keep the decoded/bridged TranscriptRow contract untouched.
// A group's first block owns its identity; appending a tool changes content, not identity.
enum TranscriptDisplayRow: Hashable, Sendable {
  case block(TranscriptRow)
  case tools(ToolActivityGroup)

  var first: TranscriptRow {
    switch self {
    case .block(let row): return row
    case .tools(let group): return group.first
    }
  }

  var id: TranscriptRow.ID { first.id }

  static func grouped(_ rows: [TranscriptRow]) -> [Self] {
    var result: [Self] = []
    var pending: ToolActivityGroup?
    for row in rows {
      guard shows(row) else { continue }
      if row.block.kind == .tool {
        if let first = pending?.first,
           first.id.turn == row.id.turn, first.id.message == row.id.message,
           first.id.role == row.id.role {
          pending?.append(row)
        } else {
          if let pending { result.append(.tools(pending)) }
          pending = ToolActivityGroup(row)
        }
      } else {
        if let pending { result.append(.tools(pending)) }
        pending = nil
        result.append(.block(row))
      }
    }
    if let pending { result.append(.tools(pending)) }
    return result
  }

  /**
   这一行值不值得占屏幕。

   **判据：没有内容的文本块不产生渲染行。** 见 aiden 2026-09-17 的截图与要求——
   "有的模型不返回 thinking，界面可能因此空着一个盒子"。

   为什么判在**这一层**（而不是让 cell 画一个空盒子）：一个空块既不该有高度，也不该有
   背景、边框和"展开思考"按钮。cell 里能做的只是"把内容藏起来"，那留下一块 28pt 的
   空壳（卡片的内边距还在）——屏幕上就是"有个盒子但什么都没有"，正是要消掉的东西。
   在这里去掉行，它连一次高度计算都不参与。

   只过滤**空白内容**（`\n`、空格、零宽字符），不做别的判断：附件、工具、错误、提示
   即使文字为空也各有各的可看之处，一律保留。
   */
  static func shows(_ row: TranscriptRow) -> Bool {
    switch row.block.kind {
    case .text, .reasoning:
      return (row.block.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    default:
      return true
    }
  }
}

/**
 一次解码的**全部**产物：渲染行 + 每行的内容指纹。

 ## 为什么指纹要在这里算

 `NativeMessageList.apply` 原来用 `rows[id] != next[id]` 决定"哪些行要 reconfigure"——
 `TranscriptBlock` 里挂着 `input` / `output` 两棵递归 JSON 树，于是这一步是
 **主线程上 O(整份转录)**，而它每个 delta 都要跑一次（列表 30fps 节流）。

 指纹跟着解码一起在 `Task.detached` 里算好，主线程就只剩 `Int` 的相等比较。
 这不是"换了套判断"，而是**同一套相等语义的见证**：`Hashable` 由编译器按字段合成，
 与 `Equatable` 逐字段同源（见 `ToolInput` / `TranscriptBlock` 的声明）。

 代价说清楚：**哈希有碰撞**（64 位）。碰撞的后果是"这一行该刷新却没刷"，
 而不是崩。理论概率 2⁻⁶⁴ 量级；真要绝对正确就得在主线程上比内容，那正是这里要拿掉的东西。
 */
struct TranscriptPayload: Sendable {
  let rows: [TranscriptDisplayRow]
  let hashes: [TranscriptRow.ID: Int]

  static func decode(_ json: String) throws -> Self {
    let rows = TranscriptDisplayRow.grouped(try TranscriptRow.decode(json))
    var hashes: [TranscriptRow.ID: Int] = [:]
    hashes.reserveCapacity(rows.count)
    for row in rows { hashes[row.id] = row.hashValue }
    return Self(rows: rows, hashes: hashes)
  }
}

/**
 diffable 快照要 `reconfigureItems` 的那些行——**只比 `Int`**。

 单独拎出来是因为它的语义值得被钉住（`pnpm test:swift` 在构建机上跑，不需要 UIKit）：

 - "内容变了"由指纹回答，不是由主线程上的深比较回答；
 - **首次出现的行不算 changed**（它会被 `insert`，不需要 reconfigure）——
   这与改前的 `rows[$0] != nil` 前置条件逐字一致；
 - 展开状态变更（`expansionUpdates`）即使内容没变也要 reconfigure。
 */
enum TranscriptDiff {
  static func changedIDs(ids: [TranscriptRow.ID],
                         previous: [TranscriptRow.ID: Int],
                         next: [TranscriptRow.ID: Int],
                         expansionUpdates: Set<TranscriptRow.ID> = []) -> [TranscriptRow.ID] {
    ids.filter { previous[$0] != nil && (previous[$0] != next[$0] || expansionUpdates.contains($0)) }
  }
}

enum ToolActivityCategory: CaseIterable, Sendable {
  case read, edit, execute, network, other

  static func classify(_ name: String?) -> Self {
    let name = (name ?? "").lowercased()
    // Ordered rules make overlapping names deterministic; never inspect commands/output.
    let rules: [(Self, [String])] = [
      (.read, ["read", "list", "search"]),
      (.edit, ["write", "edit", "patch", "apply"]),
      (.execute, ["exec", "bash", "shell", "command", "terminal"]),
      (.network, ["fetch", "web", "http"]),
    ]
    return rules.first { rule in rule.1.contains { name.contains($0) } }?.0 ?? .other
  }

  var titleKey: String {
    switch self {
    case .read: return "Read files"
    case .edit: return "Edited files"
    case .execute: return "Ran commands"
    case .network: return "Fetched from the web"
    case .other: return "Used tools"
    }
  }

  var symbolName: String {
    switch self {
    case .read: return "doc.text.magnifyingglass"
    case .edit: return "square.and.pencil"
    case .execute: return "terminal"
    case .network: return "globe"
    case .other: return "wrench.and.screwdriver"
    }
  }
}

struct ToolActivityGroup: Hashable, Sendable {
  // Preserve every original input/output for future details and accessibility.
  let first: TranscriptRow
  private(set) var rows: [TranscriptRow]

  init(_ first: TranscriptRow) {
    precondition(first.block.kind == .tool)
    self.first = first
    rows = [first]
  }

  fileprivate mutating func append(_ row: TranscriptRow) { rows.append(row) }

  var categories: [ToolActivityCategory] {
    var result: [ToolActivityCategory] = []
    for row in rows {
      let category = ToolActivityCategory.classify(row.block.name)
      if !result.contains(category) { result.append(category) }
    }
    return result
  }

  var text: String {
    categories.prefix(3).map { MemohStrings.text($0.titleKey) }
      .joined(separator: MemohStrings.text(", "))
  }

  var symbolName: String {
    let categories = categories
    return categories.count == 1 ? categories[0].symbolName : ToolActivityCategory.other.symbolName
  }

  var showsSpinner: Bool { rows.contains { $0.block.toolState == .running } }

  // One neutral policy for every state, including isError. A tool result is not a run verdict.
  enum Foreground: Sendable { case secondary }
  var foreground: Foreground { .secondary }

  /**
   有没有可以展开的详情（对应上游 `expandable`：有 detail 组件 / 显式
   expandable / 结果 isError 时为真）。运行中不可展开——参数可能还在流，
   展开内容会跳。

   不伪造：只有服务端真给了 input 条目、诊断正文或 error 才算有详情。
   */
  var expandable: Bool {
    guard !showsSpinner else { return false }
    return rows.contains { row in
      let block = row.block
      if block.input?.entries.isEmpty == false { return true }
      if let error = block.error, !error.isEmpty { return true }
      if let text = ToolResultDiagnosis.read(block.output).text, !text.isEmpty { return true }
      return false
    }
  }

  var accessibilityDescriptions: [String] {
    rows.map { row in
      let block = row.block
      let name = block.name?.isEmpty == false ? block.name! : MemohStrings.text("Tool")
      let diagnosis = ToolResultDiagnosis.read(block.output)
      return [name, block.location, block.title, block.input?.preview, diagnosis.text ?? block.error]
        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ". ")
    }
  }
}
