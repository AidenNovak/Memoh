import Foundation

/// 通知的**契约层**：只依赖 Foundation 的纯逻辑。
///
/// ## 为什么单独一层
///
/// 真正碰 `UNUserNotificationCenter` 的那一半负责系统集成；而"从负载里读什么、用户点了
/// 哪个动作、回什么给 JS"这些判断保持在这一层，避免和系统 API 耦合。
///
/// ## 这一层不做策略判断
///
/// **什么时候可以打扰、前台弹不弹**由 `apps/mobile/src/features/notifications/policy.ts`
/// 说了算（判据来自 HIG）。原生只执行它给的结果：这里出现的函数
/// 全是"解析 / 编码 / 映射"，没有一个函数会自己决定"该不该发"。
enum NotificationContract {
  // MARK: - 与服务端定死的键（见 docs/research/push-contract.md）

  /// 自定义负载里带会话 id 的键。
  static let sessionIdKey = "sessionId"
  /// 审批类通知带审批 id 的键（否则冷启动只能到会话，到不了那一次审批）。
  static let approvalIdKey = "approvalId"
  /// 事件名（与 `policy.ts` 的 `NotificationEvent` 同一套字面量）。
  static let eventKey = "event"
  /// 接收者 id。JS 用它阻止换号后的旧通知操作当前账号。
  static let recipientUserIdKey = "recipientUserId"

  /// 审批分类。与 `policy.ts` 的 `payloadFor(...).category` 必须一致。
  static let approvalCategory = "approval"
  /// 跑完 / 失败共用分类（没有动作）。
  static let runCategory = "run"

  /// 审批通知上那两个动作的标识符。**改这里等于改契约**：服务端负载里
  /// `aps.category` 指向分类，动作由客户端注册，两边靠分类名对齐。
  static let allowActionIdentifier = "memoh.approval.allow"
  static let rejectActionIdentifier = "memoh.approval.reject"

  /// 前台呈现等 JS 答复的期限。
  ///
  /// 过期就按"不打扰"处理（见 `MemohNotifications`）。这在策略上是安全的：policy 对
  /// **所有前台事件**的判定只有 `drop` 与 `in_app` 两种，两者都不弹横幅。
  static let presentationDeadline: TimeInterval = 1.5

  // MARK: - 枚举（与 JS 侧字面量一一对应）

  /// 与 iOS `UNAuthorizationStatus` 五态对应，字面量与 `policy.ts` 的
  /// `AuthorizationStatus` 相同（`ephemeral` 是 App Clips 专用，一并映射，
  /// 因为把它漏掉会变成 `notDetermined` —— 那会让 policy 以为还能请求权限）。
  enum PermissionStatus: String, CaseIterable, Sendable {
    case notDetermined
    case denied
    case authorized
    case provisional
    case ephemeral
  }

  /// 会打扰用户的事件。与 `policy.ts` 的封闭集合一致。
  enum EventKind: String, CaseIterable, Sendable {
    case approvalWaiting = "approval_waiting"
    case runFinished = "run_finished"
    case runFailed = "run_failed"
  }

  /// 前台呈现的选项名。原生只把它们翻成 `UNNotificationPresentationOptions`。
  enum PresentationOption: String, CaseIterable, Sendable {
    case banner
    case list
    case sound
    case badge
  }

  /// 用户以什么方式进了 App。契约要求：点动作与点通知都必须带 `sessionId`。
  enum OpenAction: String, Sendable {
    /// 点了通知本体：到会话，不做决定。
    case opened
    /// 点了"允许"。
    case allow
    /// 点了"拒绝"。
    case reject
  }

  // MARK: - 结构

  /// 一次"用户点了通知"的意图。`approvalId` 可空：非审批类事件没有它。
  struct OpenRequest: Equatable, Sendable {
    let sessionId: String
    let approvalId: String?
    let action: OpenAction
    /// 事件名（可空：负载可能没带，或来自另一版服务端）。
    let event: EventKind?
    /// 服务端声明的接收者；旧服务端未携带时为空。
    let recipientUserId: String?

    /// 交给 JS 的形状（跨桥只传扁平字典）。
    var jsonObject: [String: Any] {
      var object: [String: Any] = [
        "sessionId": sessionId,
        "action": action.rawValue,
      ]
      if let approvalId { object["approvalId"] = approvalId }
      if let event { object["event"] = event.rawValue }
      if let recipientUserId { object["recipientUserId"] = recipientUserId }
      return object
    }
  }

  /// 一个分类 + 它的动作。分类由 JS 注册（动作标题是本地化文案，JS 才有 i18n）。
  struct CategorySpec: Equatable, Sendable {
    struct ActionSpec: Equatable, Sendable {
      let id: String
      let title: String
    }
    let id: String
    let actions: [ActionSpec]
  }

  /// JS 对"前台要不要弹"的答复。
  struct PresentationResolution: Equatable, Sendable {
    let requestId: String
    let options: Set<PresentationOption>
  }

  // MARK: - 解析

  /// 动作标识符 → 意图。认不出来的动作（系统自己的 `UNNotificationDefaultActionIdentifier`、
  /// `UNNotificationDismissActionIdentifier`）一律当"点了通知本体"。
  ///
  /// 为什么"认不出来"要兜到 `opened` 而不是丢弃：用户确实点了这个通知，把他扔在原地
  /// 比带他进会话更糟。真正需要丢弃的是**没有 sessionId** 的那些（`openRequest` 返回 nil）。
  static func action(forActionIdentifier identifier: String) -> OpenAction {
    switch identifier {
    case allowActionIdentifier: return .allow
    case rejectActionIdentifier: return .reject
    default: return .opened
    }
  }

  /// 负载 + 动作标识符 → 打开请求。**没有 `sessionId` 就没有请求**：没有它我们不知道
  /// 该去哪个会话，硬跳一个空会话比不跳更糟。
  static func openRequest(
    actionIdentifier: String,
    userInfo: [AnyHashable: Any]
  ) -> OpenRequest? {
    guard let sessionId = text(userInfo[sessionIdKey]), sessionId.isEmpty == false else {
      return nil
    }
    return OpenRequest(
      sessionId: sessionId,
      approvalId: text(userInfo[approvalIdKey]).flatMap { $0.isEmpty ? nil : $0 },
      action: action(forActionIdentifier: actionIdentifier),
      event: text(userInfo[eventKey]).flatMap(EventKind.init(rawValue:)),
      recipientUserId: text(userInfo[recipientUserIdKey]).flatMap { $0.isEmpty ? nil : $0 }
    )
  }

  /// 负载里的值转成非空字符串。
  ///
  /// 负载经 APNs / `simctl push` / JSON 三趟，数值 id 或 `NSNumber` 都可能出现，
  /// 所以这里容忍 `NSNumber`——把它当字符串处理比让整个请求消失好。
  static func text(_ value: Any?) -> String? {
    if let string = value as? String { return string }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
  }

  /// device token → hex。
  ///
  /// 上游（APNs 与 `UIApplication`）给的是 `Data`，服务端要的是 hex 字符串；这一步
  /// 放在纯逻辑里是因为它**只在这里**被算一次，算错的表现是"注册成功但收不到推送"，
  /// 极难在现场发现。大写不是选择：APNs 官方示例用的是小写 hex。
  static func hexToken(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }

  // MARK: - 呈现

  /// JS 给来的选项名 → 集合。认不出来的名字**丢掉**（宁可不弹，也不要拿一个没被
  /// policy 批准过的行为去弹）。
  static func presentationOptions(named names: [String]) -> Set<PresentationOption> {
    var options: Set<PresentationOption> = []
    for name in names {
      guard let option = PresentationOption(rawValue: name) else { continue }
      options.insert(option)
    }
    return options
  }

  /// JS 的呈现答复 `{requestId, options}`。
  static func presentationResolution(fromJSON json: String) -> PresentationResolution? {
    guard let object = jsonObject(fromJSON: json) else { return nil }
    guard let requestId = text(object["requestId"]), requestId.isEmpty == false else { return nil }
    let names = (object["options"] as? [Any])?.compactMap { text($0) } ?? []
    return PresentationResolution(requestId: requestId, options: presentationOptions(named: names))
  }

  /// JS 注册分类用的 `[{id, actions: [{id, title}]}]`。
  static func categories(fromJSON json: String) -> [CategorySpec] {
    guard let list = jsonArray(fromJSON: json) else { return [] }
    return list.compactMap { entry in
      guard let id = text(entry["id"]), id.isEmpty == false else { return nil }
      let actions = (entry["actions"] as? [Any] ?? []).compactMap { raw -> CategorySpec.ActionSpec? in
        guard let action = raw as? [String: Any] else { return nil }
        guard let actionId = text(action["id"]), actionId.isEmpty == false else { return nil }
        guard let title = text(action["title"]), title.isEmpty == false else { return nil }
        return CategorySpec.ActionSpec(id: actionId, title: title)
      }
      return CategorySpec(id: id, actions: actions)
    }
  }

  /// `UNAuthorizationStatus` 的原始值表。Apple 定死：0 = notDetermined、1 = denied、
  /// 2 = authorized、3 = provisional、4 = ephemeral。
  ///
  /// 数字统一放在这一层。映射反了的形态不是崩溃，而是
  /// **"用户明明拒绝了，App 还在请求权限"**——那种 bug 只在别人手机上出现。
  static func permissionStatus(code: Int) -> PermissionStatus {
    switch code {
    case 1: return .denied
    case 2: return .authorized
    case 3: return .provisional
    case 4: return .ephemeral
    // 认不出来的状态当"还没定"：最坏结果是按判据再走一次请求（而请求本身有封顶与冷却），
    // 比误当成"已授权"然后静默地什么都不做要好。
    default: return .notDetermined
    }
  }

  /// 请求授权时认识的选项名（与 `UNAuthorizationOptions` 对应）。  ///
  /// `provisional` 是"静默试探"：系统直接给，但不弹横幅、不进锁屏，只落在通知中心
  /// 历史里并让用户事后裁决。它是**我们对"iOS 权限框不能拆分"的答案**，所以必须
  /// 能被 JS 显式选中，而不是我们替它决定。
  enum AuthorizationOption: String, CaseIterable, Sendable {
    case alert
    case sound
    case badge
    case provisional
  }

  static func authorizationOptions(named names: [String]) -> Set<AuthorizationOption> {
    var options: Set<AuthorizationOption> = []
    for name in names {
      guard let option = AuthorizationOption(rawValue: name) else { continue }
      options.insert(option)
    }
    return options
  }

  // MARK: - JSON 助手

  static func jsonObject(fromJSON json: String) -> [String: Any]? {
    guard let data = json.data(using: .utf8) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  static func jsonArray(fromJSON json: String) -> [[String: Any]]? {
    guard let data = json.data(using: .utf8) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
  }

}
