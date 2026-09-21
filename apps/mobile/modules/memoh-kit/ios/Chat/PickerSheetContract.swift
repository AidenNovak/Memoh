import Foundation

/// 通用选择器 sheet 的视图模型（RN → 原生）。
///
/// 7 个 RN 选择器页（模型 / 头像 / 运行目标 / 时区 / agent 切换 / 语言 / 会话重命名）本来是
/// 7 份长得几乎一样的 `ScrollView + 分组卡片 + 行`。它们的差别全在**数据**上：分组怎么切、
/// 行上写什么字、点了之后回什么值。所以这里只留一份"分组 + 行"的通用形状，7 个页面各自
/// 组装 JSON 下发。
///
/// **原生不认识业务语义**：一行是"模型"还是"时区"它不知道，`label` / `detail` 是 RN 翻好、
/// 拼好的文案，`valueJson` 是**不透明字符串**——原生原样回传，不解析、不比较、不构造
/// （形状与含义由 RN 定，见 spec §0 铁律）。
///
/// 全字段 `decodeIfPresent ?? 默认`：缺字段 = 那一块不画，而不是整张 sheet 解不出来。
/// 只有 `Foundation`——这一份要能单独 `swiftc -typecheck`（先例见 `ChatSheetsContract.swift`）。
struct PickerSheetModel: Decodable, Equatable {
  /// 一行。`id` 同时是验收用的标识后缀（`picker-row-<id>`）与 `ForEach` 的身份，
  /// 所以**必须组内唯一**——重复 id 会让 SwiftUI 认错行。
  struct Row: Decodable, Equatable, Identifiable {
    let id: String
    /// 主文案（RN 已翻好）。
    let label: String
    /// 副文案（次级灰）；空串不画。
    let detail: String
    /// SF Symbol 名。list 布局里画在行首，grid 布局里是格子里的那颗符号；空串 = 不画。
    let symbol: String
    let selected: Bool
    /// **不透明字符串**：RN 自己序列化的结果（例如 `{"modelId":"k3","reasoningEffort":null}`），
    /// 选中时原样回给 RN。原生不 parse 它，也不拿它比较。
    let valueJson: String
    /// 不可选（RN 判好：例如 `check_state === 'issue'` 的 agent 行）。原生只画灰态、不响应点击。
    let disabled: Bool
    /// 按下**不关** sheet（RN 判好）：例如"显示更多"、切换运行目标这类"点了还要继续选"的行。
    /// 这些行按下后由 RN 更新模型再下发，sheet 留在台上；结算与否由 RN 用 `pickerDismiss` 说了算。
    let staysOpen: Bool

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
      label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
      detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
      symbol = try c.decodeIfPresent(String.self, forKey: .symbol) ?? ""
      selected = try c.decodeIfPresent(Bool.self, forKey: .selected) ?? false
      valueJson = try c.decodeIfPresent(String.self, forKey: .valueJson) ?? ""
      disabled = try c.decodeIfPresent(Bool.self, forKey: .disabled) ?? false
      staysOpen = try c.decodeIfPresent(Bool.self, forKey: .staysOpen) ?? false
    }

    private enum CodingKeys: String, CodingKey {
      case id, label, detail, symbol, selected, valueJson, disabled, staysOpen
    }
  }

  /// 一个分组。`header` 走系统 `Section` 标题；`icon` 非空时在标题左边画一颗单色厂商标。
  struct Section: Decodable, Equatable, Identifiable {
    let id: String
    /// 分组小标题；空串 = 不画标题（RN 拿不到 provider 名字时就是平铺的一组）。
    let header: String
    /// 分组标题左侧的图标名（`MemohAssets.image(named:)` 的键，例如 `anthropic`）。
    let icon: String
    /// `list`（默认）| `grid`。grid 是头像选择器那种方形符号块网格。
    let layout: String
    let rows: [Row]

    /// 网格布局：只有 RN 明确说 `grid` 才是，未知值一律按列表画（画错成网格比画成列表难看得多）。
    var isGrid: Bool { layout == "grid" }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
      header = try c.decodeIfPresent(String.self, forKey: .header) ?? ""
      icon = try c.decodeIfPresent(String.self, forKey: .icon) ?? ""
      layout = try c.decodeIfPresent(String.self, forKey: .layout) ?? "list"
      rows = try c.decodeIfPresent([Row].self, forKey: .rows) ?? []
    }

    private enum CodingKeys: String, CodingKey { case id, header, icon, layout, rows }
  }

  /// 底部单字段表单（会话重命名、头像自定义网址）。缺省/`null` = 不画底部输入区。
  struct Input: Decodable, Equatable {
    let label: String
    let placeholder: String
    /// 受控值：**由 RN 持有**，每次击键回一个 `input` 事件、RN 过滤后重发模型。
    let value: String
    let submitLabel: String

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
      placeholder = try c.decodeIfPresent(String.self, forKey: .placeholder) ?? ""
      value = try c.decodeIfPresent(String.self, forKey: .value) ?? ""
      submitLabel = try c.decodeIfPresent(String.self, forKey: .submitLabel) ?? ""
    }

    private enum CodingKeys: String, CodingKey { case label, placeholder, value, submitLabel }
  }

  let title: String
  /// 非空才画搜索框（它同时是"这一页能不能搜"的开关）。
  let searchPlaceholder: String
  /// 搜索框的标识。RN 给原名（模型选择器是 `model-search`，时区是 `timezone-search`……）；
  /// 空串 = 不设标识（不是所有选择器都有搜索框）。
  let searchTestID: String
  let sections: [Section]
  let input: Input?
  /// 列表为空时那一句话；空串 = 空态不画字（会话重命名就没有列表）。
  let emptyLabel: String
  let loadingLabel: String
  /// `ready | loading | error`。加载/失败由 RN 判，原生只画。
  let status: String
  let errorTitle: String
  let errorBody: String
  /// 非空才画重试键（能不能重试是 RN 的判据，见 `features/errors/present.ts`）。
  let retryLabel: String

  /// 有一行要画吗？没有行又没有 `emptyLabel` 时（纯输入表单）内容区整块不占位。
  var hasRows: Bool { sections.contains { !$0.rows.isEmpty } }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
    searchPlaceholder = try c.decodeIfPresent(String.self, forKey: .searchPlaceholder) ?? ""
    searchTestID = try c.decodeIfPresent(String.self, forKey: .searchTestID) ?? ""
    sections = try c.decodeIfPresent([Section].self, forKey: .sections) ?? []
    input = try c.decodeIfPresent(Input.self, forKey: .input)
    emptyLabel = try c.decodeIfPresent(String.self, forKey: .emptyLabel) ?? ""
    loadingLabel = try c.decodeIfPresent(String.self, forKey: .loadingLabel) ?? ""
    // 缺省按 ready：只有 RN 明说加载/失败才画那两态，否则一份"只有行"的模型也该正常显示。
    status = try c.decodeIfPresent(String.self, forKey: .status) ?? "ready"
    errorTitle = try c.decodeIfPresent(String.self, forKey: .errorTitle) ?? ""
    errorBody = try c.decodeIfPresent(String.self, forKey: .errorBody) ?? ""
    retryLabel = try c.decodeIfPresent(String.self, forKey: .retryLabel) ?? ""
  }

  private enum CodingKeys: String, CodingKey {
    case title, searchPlaceholder, searchTestID, sections, input
    case emptyLabel, loadingLabel, status, errorTitle, errorBody, retryLabel
  }

  static func decode(_ json: String) throws -> PickerSheetModel {
    try JSONDecoder().decode(Self.self, from: Data(json.utf8))
  }
}
