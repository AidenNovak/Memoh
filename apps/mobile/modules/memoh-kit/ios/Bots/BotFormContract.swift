import Foundation

/// bot 设置 / 新建 / 新建进度三屏共用的表单视图模型（RN → 原生）。
///
/// 三屏在 RN 侧本是同一族"分组表单 + 底部动作"（见 `screens/BotSettingsScreen.tsx`
/// 等）。原生这一份只做**渲染与回事件**：分组、行序、文案、可用性、危险确认的全部判据
/// 都在 RN（`features/bots/*`）算好后以下发，原生不认识 bot、i18n 和路由。
///
/// 行用 `kind` 区分形态（`text / toggle / nav / radio / info / button / glyph`），
/// 行与组的全部可选字段带默认值，RN 只填用到的，JSON 保持小。
struct BotFormModel: Decodable, Equatable {
  /// 返回拦截与危险操作的确认框文案；`nil` = 不拦。
  struct Confirm: Decodable, Equatable {
    let title: String
    let body: String
    /// 破坏性确认键（Discard / Delete）。
    let confirmLabel: String
    /// 中性第三键（Save and leave）；空串 = 没有这一键。
    let saveLabel: String
    let cancelLabel: String
  }

  struct Row: Decodable, Equatable, Identifiable {
    /// 行 id，同时作为 accessibilityIdentifier（RN 用原 testID 值）。
    let id: String
    let kind: String
    var label: String
    /// `text` 的当前值 / `nav` 的右侧值 / `info` 的正文。
    var value: String
    /// 标题下的次级说明（名字可用性提示、检查项的下一步）。
    var hint: String
    var placeholder: String
    /// 事件字段键（text / toggle / radio 用）。
    var key: String
    /// `toggle` 的当前值。
    var on: Bool
    /// `radio` 的选中态。
    var selected: Bool
    /// 行尾 spinner（名称查重中）。
    var busy: Bool
    var destructive: Bool
    var disabled: Bool
    /// `glyph` 的状态符号（✓ ⚠ ✕ ·），与 RN `CHECK_GLYPH` / 阶段行同一套字面量。
    var glyph: String
    /// 语气：`ok | warn | bad | muted`，映射语义色（颜色只是第二遍强化）。
    var tone: String
    /// 等宽正文（技术细节原文），可选中复制。
    var mono: Bool
    /// `nav` / `button` 的动作 id。
    var action: String

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decode(String.self, forKey: .id)
      kind = try c.decode(String.self, forKey: .kind)
      label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
      value = try c.decodeIfPresent(String.self, forKey: .value) ?? ""
      hint = try c.decodeIfPresent(String.self, forKey: .hint) ?? ""
      placeholder = try c.decodeIfPresent(String.self, forKey: .placeholder) ?? ""
      key = try c.decodeIfPresent(String.self, forKey: .key) ?? ""
      on = try c.decodeIfPresent(Bool.self, forKey: .on) ?? false
      selected = try c.decodeIfPresent(Bool.self, forKey: .selected) ?? false
      busy = try c.decodeIfPresent(Bool.self, forKey: .busy) ?? false
      destructive = try c.decodeIfPresent(Bool.self, forKey: .destructive) ?? false
      disabled = try c.decodeIfPresent(Bool.self, forKey: .disabled) ?? false
      glyph = try c.decodeIfPresent(String.self, forKey: .glyph) ?? ""
      tone = try c.decodeIfPresent(String.self, forKey: .tone) ?? ""
      mono = try c.decodeIfPresent(Bool.self, forKey: .mono) ?? false
      action = try c.decodeIfPresent(String.self, forKey: .action) ?? ""
    }

    private enum CodingKeys: String, CodingKey {
      case id, kind, label, value, hint, placeholder, key, on, selected, busy
      case destructive, disabled, glyph, tone, mono, action
    }
  }

  struct Section: Decodable, Equatable, Identifiable {
    let id: String
    var header: String
    var footer: String
    /// 危险组：组头标红（与 RN `Group tone="danger"` 一致）。
    var danger: Bool
    let rows: [Row]

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decode(String.self, forKey: .id)
      header = try c.decodeIfPresent(String.self, forKey: .header) ?? ""
      footer = try c.decodeIfPresent(String.self, forKey: .footer) ?? ""
      danger = try c.decodeIfPresent(Bool.self, forKey: .danger) ?? false
      rows = try c.decode([Row].self, forKey: .rows)
    }

    private enum CodingKeys: String, CodingKey { case id, header, footer, danger, rows }
  }

  /// `loading | error | ready`。
  let status: String
  var title: String
  /// 页头次级行（bot 的 URL 名）；空串不显示。
  var subtitle: String
  /// 页头头像；`nil` = 没有页头块（新建/进度页）。
  var avatar: MemohAvatarPlan?
  /// 标题上的居中 spinner（创建进度页）。
  var spinner: Bool
  /// 整页错误态（status == error）；内联保存错误走普通 section。
  var errorTitle: String
  var errorBody: String
  var errorCanRetry: Bool
  var retryLabel: String
  var sections: [Section]
  /// 底部吸附保存条；visible 时才画。
  var saveBarVisible: Bool
  var saveBarLabel: String
  /// 空串 = 只画提示文字不画按钮（"已保存"状态）。
  var saveBarButton: String
  var saveBarBusy: Bool
  /// 返回拦截（未保存改动）；nil = 直接回。
  var backGuard: Confirm?
  /// `button` 行 action == "delete" 时弹的确认框；nil = 直接发事件。
  var deleteConfirm: Confirm?
  /// 是否画左上角返回键（进度页没有）。
  var showBack: Bool

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    status = try c.decode(String.self, forKey: .status)
    title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
    subtitle = try c.decodeIfPresent(String.self, forKey: .subtitle) ?? ""
    avatar = try c.decodeIfPresent(MemohAvatarPlan.self, forKey: .avatar)
    spinner = try c.decodeIfPresent(Bool.self, forKey: .spinner) ?? false
    errorTitle = try c.decodeIfPresent(String.self, forKey: .errorTitle) ?? ""
    errorBody = try c.decodeIfPresent(String.self, forKey: .errorBody) ?? ""
    errorCanRetry = try c.decodeIfPresent(Bool.self, forKey: .errorCanRetry) ?? false
    retryLabel = try c.decodeIfPresent(String.self, forKey: .retryLabel) ?? ""
    sections = try c.decodeIfPresent([Section].self, forKey: .sections) ?? []
    saveBarVisible = try c.decodeIfPresent(Bool.self, forKey: .saveBarVisible) ?? false
    saveBarLabel = try c.decodeIfPresent(String.self, forKey: .saveBarLabel) ?? ""
    saveBarButton = try c.decodeIfPresent(String.self, forKey: .saveBarButton) ?? ""
    saveBarBusy = try c.decodeIfPresent(Bool.self, forKey: .saveBarBusy) ?? false
    backGuard = try c.decodeIfPresent(Confirm.self, forKey: .backGuard)
    deleteConfirm = try c.decodeIfPresent(Confirm.self, forKey: .deleteConfirm)
    showBack = try c.decodeIfPresent(Bool.self, forKey: .showBack) ?? true
  }

  private enum CodingKeys: String, CodingKey {
    case status, title, subtitle, avatar, spinner
    case errorTitle, errorBody, errorCanRetry, retryLabel, sections
    case saveBarVisible, saveBarLabel, saveBarButton, saveBarBusy
    case backGuard, deleteConfirm, showBack
  }

  static func decode(_ json: String) throws -> BotFormModel {
    try JSONDecoder().decode(Self.self, from: Data(json.utf8))
  }
}
