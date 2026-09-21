import Foundation

/// 工具审批 sheet 的视图模型（RN → 原生）。
///
/// 审批是移动端最重要的一块界面：run 停在 `waiting_decision` 上，不回应就永远不继续。
/// 选项**来自 agent 自己定义的权限选项**（`allow_once` / `allow_always` / `reject_once` /
/// `reject_always`），不是写死的两颗按钮——所以原生这里不认识"允许/拒绝"，只按 `tone`
/// 画按钮、把点到的 `id` 回上去。
///
/// 文案、选项、语气、拒绝那一步的标签全部由 RN 算好下发（`features/chat/approval.ts`）；
/// 原生只画 + 回事件，不认识 i18n、路由与服务端协议。
struct ApprovalSheetModel: Decodable, Equatable {
  /// 一个权限选项。`tone` 只决定按钮样式：`allow | reject | neutral`。
  struct Option: Decodable, Equatable, Identifiable {
    let id: String
    /// 已解析过的按钮文案（RN 会把 `approval.*` 这类 i18n key 先翻好）。
    let label: String
    let tone: String

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decode(String.self, forKey: .id)
      label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
      tone = try c.decodeIfPresent(String.self, forKey: .tone) ?? ""
    }

    private enum CodingKeys: String, CodingKey { case id, label, tone }
  }

  let title: String
  let subtitle: String
  /// 空串 = 不画工具块（RN 判好：拿不到工具名的审批只给选项）。
  let toolName: String
  /// RN `formatInput` 格式化好的纯文本（`key: value` 每行一条，已按 2000 字截断）。
  let toolInput: String
  let options: [Option]
  let rejectReasonLabel: String
  let rejectReasonPlaceholder: String
  let rejectConfirmLabel: String
  let cancelLabel: String

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
    subtitle = try c.decodeIfPresent(String.self, forKey: .subtitle) ?? ""
    toolName = try c.decodeIfPresent(String.self, forKey: .toolName) ?? ""
    toolInput = try c.decodeIfPresent(String.self, forKey: .toolInput) ?? ""
    options = try c.decodeIfPresent([Option].self, forKey: .options) ?? []
    rejectReasonLabel = try c.decodeIfPresent(String.self, forKey: .rejectReasonLabel) ?? ""
    rejectReasonPlaceholder = try c.decodeIfPresent(String.self, forKey: .rejectReasonPlaceholder) ?? ""
    rejectConfirmLabel = try c.decodeIfPresent(String.self, forKey: .rejectConfirmLabel) ?? ""
    cancelLabel = try c.decodeIfPresent(String.self, forKey: .cancelLabel) ?? ""
  }

  private enum CodingKeys: String, CodingKey {
    case title, subtitle, toolName, toolInput, options
    case rejectReasonLabel, rejectReasonPlaceholder, rejectConfirmLabel, cancelLabel
  }

  static func decode(_ json: String) throws -> ApprovalSheetModel {
    try JSONDecoder().decode(Self.self, from: Data(json.utf8))
  }
}

/// agent 提问表单（`ask_user`）的视图模型（RN → 原生）。
///
/// 与审批同一类东西（run 在等用户），所以形态一致：底部 sheet、不可滑掉、必须回应。
/// 内容不同：这里画的是 agent 给的问题与选项。
///
/// **"能不能提交""答案长什么样"全在 RN**（`features/chat/userInput.ts`）：把校验写在
/// 视图里，出错的代价是服务端拒收 + run 卡住，而那种错误在界面上看不出来。原生只画
/// 草稿、把交互回成事件。
struct UserInputSheetModel: Decodable, Equatable {
  struct Option: Decodable, Equatable, Identifiable {
    let id: String
    let label: String
    let description: String

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decode(String.self, forKey: .id)
      label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
      description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
    }

    private enum CodingKeys: String, CodingKey { case id, label, description }
  }

  struct Question: Decodable, Equatable, Identifiable {
    let id: String
    let text: String
    let required: Bool
    /// `single_select | multi_select | text`；只决定画选项行还是输入框。
    let kind: String
    let options: [Option]
    /// 允许"其他"。单问题表单由 RN 折进底部输入框（那时 `footerInput` 为真）。
    let allowCustom: Bool
    let placeholder: String

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decode(String.self, forKey: .id)
      text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
      required = try c.decodeIfPresent(Bool.self, forKey: .required) ?? false
      kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
      options = try c.decodeIfPresent([Option].self, forKey: .options) ?? []
      allowCustom = try c.decodeIfPresent(Bool.self, forKey: .allowCustom) ?? false
      placeholder = try c.decodeIfPresent(String.self, forKey: .placeholder) ?? ""
    }

    private enum CodingKeys: String, CodingKey {
      case id, text, required, kind, options, allowCustom, placeholder
    }
  }

  /// 一道题的草稿。原生**不判断**它合不合法，只按它画选中态。
  ///
  /// 只有一个 `text`：RN 已经把"自定义文本"与"文本题答案"归到同一个字段（单选用底部
  /// 输入框时无需先点 Other，两种情形的值本就是二选一），原生不分辨它们。
  struct Draft: Decodable, Equatable {
    let optionIds: [String]
    let customSelected: Bool
    let text: String

    /// 没答过的题：RN 只下发答过的草稿。
    static let empty = Draft(optionIds: [], customSelected: false, text: "")

    init(optionIds: [String], customSelected: Bool, text: String) {
      self.optionIds = optionIds
      self.customSelected = customSelected
      self.text = text
    }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      optionIds = try c.decodeIfPresent([String].self, forKey: .optionIds) ?? []
      customSelected = try c.decodeIfPresent(Bool.self, forKey: .customSelected) ?? false
      text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
    }

    private enum CodingKeys: String, CodingKey { case optionIds, customSelected, text }
  }

  let title: String
  let subtitle: String
  let questions: [Question]
  /// 按题 id 索引的草稿；缺省 = 这道题还没答过。
  let drafts: [String: Draft]
  /// 单问题且 RN 判好该用底部输入框（文本题、或允许自定义的单选）。
  let footerInput: Bool
  let footerPlaceholder: String
  /// 由 RN 算好（`buildAnswers`）；原生只按它画提交键的可用态。
  let canSubmit: Bool
  let submitLabel: String
  let cancelLabel: String
  let otherLabel: String
  let requiredLabel: String

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
    subtitle = try c.decodeIfPresent(String.self, forKey: .subtitle) ?? ""
    questions = try c.decodeIfPresent([Question].self, forKey: .questions) ?? []
    drafts = try c.decodeIfPresent([String: Draft].self, forKey: .drafts) ?? [:]
    footerInput = try c.decodeIfPresent(Bool.self, forKey: .footerInput) ?? false
    footerPlaceholder = try c.decodeIfPresent(String.self, forKey: .footerPlaceholder) ?? ""
    canSubmit = try c.decodeIfPresent(Bool.self, forKey: .canSubmit) ?? false
    submitLabel = try c.decodeIfPresent(String.self, forKey: .submitLabel) ?? ""
    cancelLabel = try c.decodeIfPresent(String.self, forKey: .cancelLabel) ?? ""
    otherLabel = try c.decodeIfPresent(String.self, forKey: .otherLabel) ?? ""
    requiredLabel = try c.decodeIfPresent(String.self, forKey: .requiredLabel) ?? ""
  }

  private enum CodingKeys: String, CodingKey {
    case title, subtitle, questions, drafts, footerInput, footerPlaceholder
    case canSubmit, submitLabel, cancelLabel, otherLabel, requiredLabel
  }

  static func decode(_ json: String) throws -> UserInputSheetModel {
    try JSONDecoder().decode(Self.self, from: Data(json.utf8))
  }

  /// 某道题的草稿（没答过就是空草稿）。
  func draft(_ questionId: String) -> Draft {
    drafts[questionId] ?? .empty
  }
}
