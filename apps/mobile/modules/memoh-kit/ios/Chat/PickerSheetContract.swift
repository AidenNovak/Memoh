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
/// 模块 9A3b 又长了两种布局，都是**同一张 sheet**（不另开 presenter，见 spec §1）：
///
/// - `info`：只读信息面板（会话信息 / 机器面板）。行画成 `label + value`；
///   `kind: progress` 的那一行画成"标签 + 百分比 + 一条用量条"；**`valueJson` 非空的行是
///   动作行**（RN 明确给了载荷 = 这一行是要按的，例如"立即压缩"、"看截图"），只有它是可点的。
/// - `form`：表单（cron 选择器）。行按 `kind` 分四种：`radio`（同列表行）/ `stepper`
///   （`−` 值 `+`）/ `weekday`（可点的日期格）/ `text`（受控输入）。
///
/// 表单里每一个**具体的按键**（`+` / `−` / 某一格）都带自己的 `valueJson`：原生只回"按了
/// 哪一颗"，**不替 RN 算方向、更不改载荷里的字段**——判据（7 种模式、步进环回、多选）
/// 全在 RN 的 `features/schedule/cronPicker.ts`。
///
/// 全字段 `decodeIfPresent ?? 默认`：缺字段 = 那一块不画，而不是整张 sheet 解不出来。
/// 只有 `Foundation`——这一份要能单独 `swiftc -typecheck`（先例见 `ChatSheetsContract.swift`）。
struct PickerSheetModel: Decodable, Equatable {
  /// 一行。`id` 同时是验收用的标识后缀（`picker-row-<id>`）与 `ForEach` 的身份，
  /// 所以**必须组内唯一**——重复 id 会让 SwiftUI 认错行。
  struct Row: Decodable, Equatable, Identifiable {
    /// 日期格（`weekday` 行专用）。`id` 是 RN 给的那一天的标识（`"1"`…），原生原样回传。
    struct Chip: Decodable, Equatable, Identifiable {
      let id: String
      /// 格子上的字（RN 翻好：`周一` / `1` / `Jan`——原生不知道"周一"叫什么）。
      let label: String
      let selected: Bool
      /// 这一格被按下时回给 RN 的**不透明载荷**（原生不构造、不解析）。
      let valueJson: String

      init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        selected = try c.decodeIfPresent(Bool.self, forKey: .selected) ?? false
        valueJson = try c.decodeIfPresent(String.self, forKey: .valueJson) ?? ""
      }

      private enum CodingKeys: String, CodingKey { case id, label, selected, valueJson }
    }

    let id: String
    /// 主文案（RN 已翻好）。
    let label: String
    /// 副文案（次级灰）；空串不画。
    let detail: String
    /// SF Symbol 名。**兜底用**：`avatar` 为 nil 时，list 布局画在行首、grid 布局画在格子里；
    /// `avatar` 非 nil 时它是死字段（真头像已经说了这件事）；空串 = 连兜底都没有，不画。
    let symbol: String
    /**
     行首 / 格子里的头像计划（RN 归一化后下发，画法见 `Support/MemohAvatarView.swift`）。

     `nil` = 这一行没有头像（老模型没这个字段、或 RN 判它不该有）——**按 `symbol` 画**，
     也就是改动前的样子，不会变成空白方块。
     */
    let avatar: MemohAvatarPlan?
    let selected: Bool
    /// **不透明字符串**：RN 自己序列化的结果（例如 `{"modelId":"k3","reasoningEffort":null}`），
    /// 选中时原样回给 RN。原生不 parse 它，也不拿它比较。
    let valueJson: String
    /// 不可选（RN 判好：例如 `check_state === 'issue'` 的 agent 行）。原生只画灰态、不响应点击。
    let disabled: Bool
    /// 按下**不关** sheet（RN 判好）：例如"显示更多"、切换运行目标这类"点了还要继续选"的行。
    /// 这些行按下后由 RN 更新模型再下发，sheet 留在台上；结算与否由 RN 用 `pickerDismiss` 说了算。
    let staysOpen: Bool

    /**
     行形态（`form` 布局才用得上，`list` / `grid` 忽略它）：

     | kind | 画什么 | 按一下回什么 |
     | --- | --- | --- |
     | `""` / `radio` | 与现在的列表行一样（可选、带勾） | `select` + 这一行的 `valueJson` |
     | `stepper` | `−` `value` `+` 三件套 | `select` + **那一颗键自己的**载荷 |
     | `weekday` | `chips` 那些可点的格子（换行排） | `select` + 那一格的载荷 |
     | `text` | 受控输入框 | `input` + 文本 |
     | `progress` | 只读的进度行（`info` 布局里） | 不可点 |

     未知值一律按 `""` 画（画成一行普通列表行，比画成一片空白好）。
     */
    let kind: String
    /// `info` 行的右侧值 / `stepper` 的当前显示值（RN 已经补好零：`09`）/ `progress` 的 0…1 比例。
    let value: String
    /// 等宽显示（`info` 行里同时允许长按选中复制——表达式与机器名要能复制走）。
    let mono: Bool
    /// 语气：`""`（中性）/ `destructive` / `success` / `warning`。**RN 判好**，原生只选字色。
    let tone: String
    /**
     `stepper` 的 `−` / `+` 各自的不透明载荷。

     为什么是两份而不是一份 + 原生算方向：`valueJson` 这条约定是"RN 序列化、原生原样回传"，
     原生一旦去改它里面的 `delta` 就等于**解析业务载荷**了（见文件头）。两份载荷让方向也留在
     RN 那边：`{"action":"step","field":"hour","delta":-1}` / `…"delta":1`。
     */
    let downValueJson: String
    let upValueJson: String
    /// `weekday` 行的日期格。
    let chips: [Chip]

    /// 只读的进度行（`info` 布局里画成"标签 + 百分比 + 一条条"）。
    var isProgress: Bool { kind == "progress" }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
      label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
      detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
      symbol = try c.decodeIfPresent(String.self, forKey: .symbol) ?? ""
      // `try?` 而不是直接 `try`：头像是一行上的**附加件**，它自己的载荷坏了（缺 `kind` 之类）
      // 只该让这一行退回 `symbol`，不该让整张 sheet 解不出来（文件头那条"缺字段 = 那一块不画"）。
      avatar = try? c.decodeIfPresent(MemohAvatarPlan.self, forKey: .avatar)
      selected = try c.decodeIfPresent(Bool.self, forKey: .selected) ?? false
      valueJson = try c.decodeIfPresent(String.self, forKey: .valueJson) ?? ""
      disabled = try c.decodeIfPresent(Bool.self, forKey: .disabled) ?? false
      staysOpen = try c.decodeIfPresent(Bool.self, forKey: .staysOpen) ?? false
      kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
      value = try c.decodeIfPresent(String.self, forKey: .value) ?? ""
      mono = try c.decodeIfPresent(Bool.self, forKey: .mono) ?? false
      tone = try c.decodeIfPresent(String.self, forKey: .tone) ?? ""
      downValueJson = try c.decodeIfPresent(String.self, forKey: .downValueJson) ?? ""
      upValueJson = try c.decodeIfPresent(String.self, forKey: .upValueJson) ?? ""
      chips = try c.decodeIfPresent([Chip].self, forKey: .chips) ?? []
    }

    private enum CodingKeys: String, CodingKey {
      case id, label, detail, symbol, avatar, selected, valueJson, disabled, staysOpen
      case kind, value, mono, tone, downValueJson, upValueJson, chips
    }
  }

  /// 一个分组。`header` 走系统 `Section` 标题；`icon` 非空时在标题左边画一颗单色厂商标。
  struct Section: Decodable, Equatable, Identifiable {
    let id: String
    /// 分组小标题；空串 = 不画标题（RN 拿不到 provider 名字时就是平铺的一组）。
    let header: String
    /// 分组标题左侧的图标名（`MemohAssets.image(named:)` 的键，例如 `anthropic`）。
    let icon: String
    /**
     分组脚注；空串 = 不画。

     `info` 面板靠它承载"为什么这一格是空的"那类说明（会话信息的"没有窗口所以不给百分比"、
     机器面板的"读不到用量"、cron 的"五段式"），与 RN 版的分组 footer 是同一个位置。
     */
    let footer: String
    /**
     `list`（默认）| `grid` | `info`（只读信息面板）| `form`（表单）。

     未知值一律按 `list` 画（同 `isGrid` 那条理由：画成列表是退让，画成空白是故障）。
     */
    let layout: String
    let rows: [Row]

    /// 网格布局：只有 RN 明确说 `grid` 才是，未知值一律按列表画（画错成网格比画成列表难看得多）。
    var isGrid: Bool { layout == "grid" }

    /// 只读信息面板：行渲染成 `label + value`（`kind: progress` 是用量行）。**只有 `valueJson`
    /// 非空的那种行可点**——那是动作行，见 `NativePickerSheet.swift` 的 `infoRow`。
    var isInfo: Bool { layout == "info" }

    /// 表单：行按各自的 `kind` 画（radio / stepper / weekday / text）。
    var isForm: Bool { layout == "form" }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
      header = try c.decodeIfPresent(String.self, forKey: .header) ?? ""
      icon = try c.decodeIfPresent(String.self, forKey: .icon) ?? ""
      footer = try c.decodeIfPresent(String.self, forKey: .footer) ?? ""
      layout = try c.decodeIfPresent(String.self, forKey: .layout) ?? "list"
      rows = try c.decodeIfPresent([Row].self, forKey: .rows) ?? []
    }

    private enum CodingKeys: String, CodingKey { case id, header, icon, footer, layout, rows }
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

  /// 有东西要画吗？没有行又没有 `emptyLabel` 时（纯输入表单）内容区整块不占位。
  ///
  /// 带脚注的分组也算"有东西"：`info` 面板里"技能一个都没用过"就是一条只有标题与脚注的分组。
  var hasRows: Bool { sections.contains { !$0.rows.isEmpty || !$0.footer.isEmpty } }

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
