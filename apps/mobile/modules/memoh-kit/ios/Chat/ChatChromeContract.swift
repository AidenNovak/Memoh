import Foundation

/// Chat 顶栏（返回 / 标题 / 机器 / 信息）与 notices 横条的视图模型（RN → 原生）。
///
/// 分工与 `BotFormContract` 同一套：文案、可用性（要不要画机器键、有没有横条、哪一条能点）
/// 全部由 RN 算好后以下发，原生只画 + 回事件。原生不认识会话、bot、i18n 与路由，所以这一份
/// 里没有一处"该不该显示"的判断——空串即不画，缺键即默认。
///
/// 为什么与 `SettingsContract` 分开：这一份服务的是**嵌进** Chat 屏幕的两条条带（不是整屏），
/// 字段只跟着这两块走。
struct ChatChromeModel: Decodable, Equatable {
  /// 一条横条（连接状态、run 失败、历史没拉到、复制成功…）。
  ///
  /// 位置与秩序（哪几条、谁在上）归 RN 的 `ChatNotices`；这里只画一条的样子。
  struct Notice: Decodable, Equatable, Identifiable {
    /// 回事件时带上去的 id（RN 用它决定重试哪一条）。
    let id: String
    /// `info | error`：只影响主行颜色，不改变布局。
    let tone: String
    let text: String
    /// 次级说明（服务端给的原文）；空串不画。
    let detail: String
    /// 空串 = 整行不可点；非空（`retryOlder` / `reconnect`）时整行是按钮。
    let action: String
    /// 可点行尾的动作文案；空串不画。
    let actionLabel: String
    /// 读屏整句（主行 + 说明 + 动作）；空串退回主行。
    let a11y: String

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decode(String.self, forKey: .id)
      tone = try c.decodeIfPresent(String.self, forKey: .tone) ?? "info"
      text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
      detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
      action = try c.decodeIfPresent(String.self, forKey: .action) ?? ""
      actionLabel = try c.decodeIfPresent(String.self, forKey: .actionLabel) ?? ""
      a11y = try c.decodeIfPresent(String.self, forKey: .a11y) ?? ""
    }

    private enum CodingKeys: String, CodingKey {
      case id, tone, text, detail, action, actionLabel, a11y
    }
  }

  let title: String
  /// 标题下那行（bot 名 · 正在生成…）；空串不画。
  let subtitle: String
  /// 历史有断档时的提示（warning 色）；空串不占位。
  let staleLabel: String
  /// 标题按钮的读屏标签（会话名 + 这是会话信息入口）。
  let titleA11y: String
  /// 标题按钮的读屏提示。
  let titleHint: String
  let backLabel: String
  let showMachine: Bool
  let machineLabel: String
  let showInfo: Bool
  let infoLabel: String
  let notices: [Notice]

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
    subtitle = try c.decodeIfPresent(String.self, forKey: .subtitle) ?? ""
    staleLabel = try c.decodeIfPresent(String.self, forKey: .staleLabel) ?? ""
    titleA11y = try c.decodeIfPresent(String.self, forKey: .titleA11y) ?? ""
    titleHint = try c.decodeIfPresent(String.self, forKey: .titleHint) ?? ""
    backLabel = try c.decodeIfPresent(String.self, forKey: .backLabel) ?? ""
    showMachine = try c.decodeIfPresent(Bool.self, forKey: .showMachine) ?? false
    machineLabel = try c.decodeIfPresent(String.self, forKey: .machineLabel) ?? ""
    showInfo = try c.decodeIfPresent(Bool.self, forKey: .showInfo) ?? false
    infoLabel = try c.decodeIfPresent(String.self, forKey: .infoLabel) ?? ""
    notices = try c.decodeIfPresent([Notice].self, forKey: .notices) ?? []
  }

  private enum CodingKeys: String, CodingKey {
    case title, subtitle, staleLabel, titleA11y, titleHint, backLabel
    case showMachine, machineLabel, showInfo, infoLabel, notices
  }

  static func decode(_ json: String) throws -> ChatChromeModel {
    try JSONDecoder().decode(Self.self, from: Data(json.utf8))
  }
}

/// Chat 输入区那一叠条带（队列 / 待发 / 斜杠菜单 / 模型胶囊 / 输入行）的视图模型（RN → 原生）。
///
/// 与 chrome 同一套分工：形态、文案、可点性全部由 RN 算好。这里只画 + 回事件。
///
/// 为什么队列 / 待发 / 斜杠三块**整块可缺省**（而不是给空数组）：它们各自是"这一屏现在没有
/// 这件事"的状态，缺省即整块不画；给空数组就得靠原生再判一次"空数组算不算没有"，
/// 那条判据在 RN 侧已经有了（`QueueStrip` / `SlashMenu` 的提前返回）。
struct ChatBarModel: Decodable, Equatable {
  /// 一条排着的话（运行中补的话）。
  struct QueueItem: Decodable, Equatable, Identifiable {
    let id: String
    /// 语义标签（"插队" / "接着发"）——现在会被看到还是这轮跑完才轮到，是两件事。
    let kindLabel: String
    let text: String
    /// 只有能提成 steer 的那一条才有；判据在 RN（服务端说不支持就整块没有）。
    let canSteer: Bool
    let steerLabel: String
    let removeLabel: String

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decode(String.self, forKey: .id)
      kindLabel = try c.decodeIfPresent(String.self, forKey: .kindLabel) ?? ""
      text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
      canSteer = try c.decodeIfPresent(Bool.self, forKey: .canSteer) ?? false
      steerLabel = try c.decodeIfPresent(String.self, forKey: .steerLabel) ?? ""
      removeLabel = try c.decodeIfPresent(String.self, forKey: .removeLabel) ?? ""
    }

    private enum CodingKeys: String, CodingKey {
      case id, kindLabel, text, canSteer, steerLabel, removeLabel
    }
  }

  struct Queue: Decodable, Equatable {
    let items: [QueueItem]
    /// "还有 N 条没摊开"那一行；空串不画。
    let hiddenLabel: String
    /// 队列写失败的那一行；空串不画。
    let error: String

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      items = try c.decodeIfPresent([QueueItem].self, forKey: .items) ?? []
      hiddenLabel = try c.decodeIfPresent(String.self, forKey: .hiddenLabel) ?? ""
      error = try c.decodeIfPresent(String.self, forKey: .error) ?? ""
    }

    private enum CodingKeys: String, CodingKey { case items, hiddenLabel, error }
  }

  /// 刚发出去、服务端还没回显的那一句现在在哪儿。
  struct Pending: Decodable, Equatable {
    let text: String
    /// 失败原因（服务端原文）；空串不画。
    let reason: String
    /// `retry | reconnect`；空串 = 没有可点的动作（等同步，不重发）。
    let action: String
    let actionLabel: String
    /// 两个动作的效果不同，读屏只念标签会让人以为它们是一回事。
    let actionHint: String
    /// `info | error`：发送失败（phase == failed）时主行与动作都改 destructive。
    let tone: String

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
      reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? ""
      action = try c.decodeIfPresent(String.self, forKey: .action) ?? ""
      actionLabel = try c.decodeIfPresent(String.self, forKey: .actionLabel) ?? ""
      actionHint = try c.decodeIfPresent(String.self, forKey: .actionHint) ?? ""
      tone = try c.decodeIfPresent(String.self, forKey: .tone) ?? "info"
    }

    private enum CodingKeys: String, CodingKey {
      case text, reason, action, actionLabel, actionHint, tone
    }
  }

  /// 斜杠菜单里的一项（内置动作或技能）。
  struct SlashItem: Decodable, Equatable, Identifiable {
    let id: String
    /// 插入 / 执行用的名字（不含 `/`）。缺省时从 `id` 里取（见 `pickName`）。
    let name: String
    /// 主文案（含 `/`）。
    let label: String
    /// 副文案；空串不画（技能没有说明时就是这样）。
    let description: String

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decode(String.self, forKey: .id)
      name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
      label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
      description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
    }

    private enum CodingKeys: String, CodingKey { case id, name, label, description }

    /// 选中后回给 RN 的名字（`onSlashPick` 的 `name`）。
    ///
    /// RN 侧的 `SlashItem` 有 `name` 这个字段，但下发的 JSON 只保证有 `id`
    /// （形状是 `skill:<name>` / `builtin:<name>`）。名字是**这一条要执行的东西**，
    /// 缺了它点下去会静默无事发生，所以缺省时按同一个前缀约定从 `id` 里取回；
    /// `id` 本来就没带前缀（下发的就是名字）时原样用它。
    var pickName: String {
      guard name.isEmpty else { return name }
      guard let colon = id.firstIndex(of: ":") else { return id }
      return String(id[id.index(after: colon)...])
    }
  }

  struct Slash: Decodable, Equatable {
    let items: [SlashItem]
    /// 技能清单没拉到时的标题；空串 = 没有这一块。
    let failureTitle: String
    let failureBody: String
    let retryLabel: String

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      items = try c.decodeIfPresent([SlashItem].self, forKey: .items) ?? []
      failureTitle = try c.decodeIfPresent(String.self, forKey: .failureTitle) ?? ""
      failureBody = try c.decodeIfPresent(String.self, forKey: .failureBody) ?? ""
      retryLabel = try c.decodeIfPresent(String.self, forKey: .retryLabel) ?? ""
    }

    private enum CodingKeys: String, CodingKey { case items, failureTitle, failureBody, retryLabel }
  }

  /// 三块都可以整个缺省（或为 null）：缺省 = 那一块不画。
  let queue: Queue?
  let pending: Pending?
  let slash: Slash?
  let pillLabel: String
  let pillA11y: String
  /// agent 提问期间输入行收起来，但胶囊留着（它是"这一轮想用哪个"的读数）。
  let inputVisible: Bool
  let draft: String
  let placeholder: String
  let sendError: String
  let canSend: Bool
  /// `↑`（发送 / 排队）或 `■`（停止）——RN 已用 `composerView` 判好，原生不猜。
  let buttonGlyph: String
  let buttonA11y: String

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    queue = try c.decodeIfPresent(Queue.self, forKey: .queue)
    pending = try c.decodeIfPresent(Pending.self, forKey: .pending)
    slash = try c.decodeIfPresent(Slash.self, forKey: .slash)
    pillLabel = try c.decodeIfPresent(String.self, forKey: .pillLabel) ?? ""
    pillA11y = try c.decodeIfPresent(String.self, forKey: .pillA11y) ?? ""
    inputVisible = try c.decodeIfPresent(Bool.self, forKey: .inputVisible) ?? false
    draft = try c.decodeIfPresent(String.self, forKey: .draft) ?? ""
    placeholder = try c.decodeIfPresent(String.self, forKey: .placeholder) ?? ""
    sendError = try c.decodeIfPresent(String.self, forKey: .sendError) ?? ""
    canSend = try c.decodeIfPresent(Bool.self, forKey: .canSend) ?? false
    buttonGlyph = try c.decodeIfPresent(String.self, forKey: .buttonGlyph) ?? ""
    buttonA11y = try c.decodeIfPresent(String.self, forKey: .buttonA11y) ?? ""
  }

  private enum CodingKeys: String, CodingKey {
    case queue, pending, slash, pillLabel, pillA11y, inputVisible, draft
    case placeholder, sendError, canSend, buttonGlyph, buttonA11y
  }

  static func decode(_ json: String) throws -> ChatBarModel {
    try JSONDecoder().decode(Self.self, from: Data(json.utf8))
  }
}
