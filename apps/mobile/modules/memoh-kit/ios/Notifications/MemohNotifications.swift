import Dispatch
import Foundation
import Synchronization
import UIKit
import UserNotifications

/// `UNUserNotificationCenter` 的桥：**JS 说了算，这里只执行**。
///
/// ## 职责边界（这条比实现重要）
///
/// 这个类型不判断"该不该打扰用户"，只做三件事：
///
/// 1. 把系统给的东西**翻译**成扁平字典（谁点了什么、负载里有什么）交给 JS；
/// 2. 等 JS 用 `policy.ts` 的判据给出答复，再把答复**照原样**翻回系统 API；
/// 3. 系统 API 只有原生能做的那部分（设代理、注册分类、注册远程通知、设徽标）。
///
/// 所以这里没有"如果前台就不弹"这类判断——那在 `src/features/notifications/policy.ts`
/// 里，并且被测试钉着。桥上再抄一份判据，等于判据层白做。
///
/// ## 两个时序陷阱（都在真机上才现形）
///
/// - **冷启动点通知**：Apple 明确要求代理必须在 `didFinishLaunchingWithOptions`
///   返回**之前**就位，否则那次点击根本不会交给我们。所以代理在
///   `MemohNotificationsAppDelegateSubscriber` 里装，而不是等模块创建
///   （模块创建晚于启动）。晚到的答复/点击另有缓冲，见 `pendingOpen`。
/// - **前台呈现**：`willPresent` 的 completion handler 必须被调用，否则系统按"不呈现"
///   处理并留下一次悬挂。JS 没在期限内答复时我们主动收尾（`presentationDeadline`）。
final class MemohNotifications: NSObject, UNUserNotificationCenterDelegate, Sendable {
  static let shared = MemohNotifications()

  /// 事件出口的类型（`MemohKitModule` 接上来的那一段）。
  private typealias Emitter = @Sendable (String, [String: Any]) -> Void

  /**
   系统给的两个东西**不是 `Sendable`**：事件字典是 `[String: Any]`（`Any` 不 Sendable），
   `willPresent` 的 completion handler 在 Apple 的签名里也没有 `@Sendable`。

   `Mutex.withLock` 的参数是 `inout sending`，把 task-isolated 的这类值直接带进去**编不过**
   （真构建实测：`'inout sending' parameter cannot be task-isolated`）。所以它们各自进一个小盒子，
   盒子显式声明 Sendable。

   这是**收窄**，不是"继续整个类 `@unchecked`"：以前那个 `@unchecked Sendable` 盖住的是这个类里
   **所有**可变状态；现在盖住的只有这三处**本来就不 Sendable**的值。"谁在等答复"那张表、
   冷启动缓冲的读写顺序、三份状态的一致性，全都在 `Mutex` 后面由编译器守。
   */
  private struct UncheckedBox<Value>: @unchecked Sendable {
    let value: Value
  }

  /**
   上面三份状态（事件出口 / 等答复的 completion handler / 冷启动的点击缓冲）**收进一份、
   放在 `Mutex` 后面**。

   为什么不是"换一把更快的锁"：收益不是性能，而是**"三份状态被同一把锁保护"从纪律变成
   编译期约束**。以前它们是三个平级属性，任何一处都能在锁外读或写（漏锁不会报错，只在
   真机上偶发）；现在它们只存在于 `State` 里，唯一的入口是 `state.withLock`——漏了锁就编不过，
   也**不可能**出现"改了两份、第三份还是旧的"这种中间态。

   `Mutex` 是 `~Copyable` 且不跨 `await` 持有：`withLock` 里不许有 `await`。这里三处都是
   纯内存读写，没有 `await`。
   */
  private struct State {
    /// 事件出口。由 `MemohKitModule` 在创建时接上（弱持有模块，避免循环）。
    var emitter: UncheckedBox<Emitter>?
    /// 等 JS 答复前台呈现的 completion handler，按 requestId 索引。
    var pendingPresentations: [String: UncheckedBox<(UNNotificationPresentationOptions) -> Void>] = [:]
    /// 冷启动时 JS 还没接上事件出口，点击先落在这里，等 JS 起来取走。
    var pendingOpen: UncheckedBox<[String: Any]>?
  }

  /// 唯一的可变状态入口。**类本身是 `Sendable` 而不是 `@unchecked Sendable`**：每一处共享状态
  /// 都在 `Mutex` 后面，编译器替我们守这条线。
  private let state = Mutex(State())

  // MARK: - 生命周期

  /// 装代理。**必须在 `didFinishLaunchingWithOptions` 返回前调用**（见类型注释）。
  func install() {
    if Thread.isMainThread {
      UNUserNotificationCenter.current().delegate = self
    } else {
      DispatchQueue.main.async { [self] in
        UNUserNotificationCenter.current().delegate = self
      }
    }
  }

  /// 接上事件出口。模块重建（JS 重载）时会重新接一次。
  func attach(emitter: @escaping @Sendable (String, [String: Any]) -> Void) {
    state.withLock { $0.emitter = UncheckedBox(value: emitter) }
  }

  // MARK: - 权限（执行 JS 的决定）

  /// 当前授权状态。JS 拿它喂 `permissionActionFor`，所以字面量必须与 policy 一致。
  func authorizationStatus() async -> NotificationContract.PermissionStatus {
    await withCheckedContinuation { continuation in
      UNUserNotificationCenter.current().getNotificationSettings { settings in
        // 在闭包内就把 `UNAuthorizationStatus` 收敛成我们自己的枚举：非 Sendable 的
        // `UNNotificationSettings` 不跨并发边界。
        continuation.resume(returning: Self.status(from: settings.authorizationStatus))
      }
    }
  }

  /// 请求授权。带上 `provisional` 就是"静默试探"那条路。
  func requestAuthorization(
    options: Set<NotificationContract.AuthorizationOption>
  ) async -> NotificationContract.PermissionStatus {
    _ = try? await UNUserNotificationCenter.current()
      .requestAuthorization(options: Self.flags(for: options))
    return await authorizationStatus()
  }

  /// 向 APNs 注册。**模拟器上会失败**（`didFailToRegister`），那不是 bug：
  /// 桥把错误报给 JS，由 JS 决定只记不发。
  func registerForRemoteNotifications() {
    if Thread.isMainThread {
      MainActor.assumeIsolated { UIApplication.shared.registerForRemoteNotifications() }
    } else {
      DispatchQueue.main.async {
        MainActor.assumeIsolated { UIApplication.shared.registerForRemoteNotifications() }
      }
    }
  }

  // MARK: - 分类与徽标

  /// 注册通知分类（审批那两个动作就在这儿）。分类名由 JS 给（与 `payloadFor` 同源），
  /// 动作标题也是 JS 给的——标题要本地化，而 i18n 在 JS 那边。
  func registerCategories(_ specs: [NotificationContract.CategorySpec]) {
    let categories = specs.map { spec -> UNNotificationCategory in
      let actions = spec.actions.map { action -> UNNotificationAction in
        // `.foreground`：这两个动作必须把 App 带到前台。理由不是省事——决定要经
        // App 那条实时连接发出去，且用户应当看见自己回答的是哪一次审批；后台静默
        // 提交会变成"点了没反应"。
        UNNotificationAction(
          identifier: action.id,
          title: action.title,
          options: [.foreground]
        )
      }
      return UNNotificationCategory(
        identifier: spec.id,
        actions: actions,
        intentIdentifiers: [],
        options: []
      )
    }
    UNUserNotificationCenter.current().setNotificationCategories(Set(categories))
  }

  /// 设徽标。语义 = 待审批数（由 `policy.badgeCountFor` 算好传进来）——
  /// **0 会清掉通知中心里本 App 的全部通知**，这正是"处理完了"该有的样子。
  func setBadgeCount(_ count: Int) async {
    await withCheckedContinuation { continuation in
      UNUserNotificationCenter.current().setBadgeCount(count) { _ in
        continuation.resume()
      }
    }
  }

  /// 通知中心里本 App 还留着的通知（冷启动/不崩降级的查证路径）。
  func delivered() async -> String {    await withCheckedContinuation { continuation in
      UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
        let described: [[String: Any]] = notifications.map { notification in
          let content = notification.request.content
          let userInfo = content.userInfo
          return [
            "identifier": notification.request.identifier,
            "category": content.categoryIdentifier,
            "threadId": content.threadIdentifier,
            "title": content.title,
            "body": content.body,
            "sessionId": NotificationContract.text(userInfo[NotificationContract.sessionIdKey]) ?? "",
            "approvalId": NotificationContract.text(userInfo[NotificationContract.approvalIdKey]) ?? "",
            "event": NotificationContract.text(userInfo[NotificationContract.eventKey]) ?? "",
          ]
        }
        continuation.resume(returning: NotificationContract.jsonString(from: described))
      }
    }
  }

  /// **系统那边**记着的分类（注册成功了没有的唯一可查证据）。
  ///
  /// 为什么要读回来：分类注册是"写出去就没有回执"的调用，而它没生效的表现是**通知照旧
  /// 到达、只是没有动作按钮**——验收时会以为"手势不对"，其实是分类压根没匹配上。
  /// 读回来的这一份是 debug 页显示的那份（`getNotificationCategories`）。
  func registeredCategories() async -> String {
    await withCheckedContinuation { continuation in
      UNUserNotificationCenter.current().getNotificationCategories { categories in
        let described: [[String: Any]] = categories.map { category in
          [
            "id": category.identifier,
            "actions": category.actions.map { action in
              ["id": action.identifier, "title": action.title]
            },
          ]
        }
        continuation.resume(returning: NotificationContract.jsonString(from: described))
      }
    }
  }

  /// 拿到 device token（hex）后交给 JS 去上报。
  ///
  /// 这里只做"Data → hex"这一件事（`NotificationContract.hexToken` 有测试钉着）；
  /// **谁该拿到 token、换号要不要先解绑**是 `features/notifications/registration.ts`
  /// 的契约，不在原生。
  func handleDeviceToken(_ data: Data) {
    emit("onRemoteToken", ["token": NotificationContract.hexToken(data)])
  }

  /// 注册失败（模拟器、无凭据、App ID 没开 Push 都会走到这里）。
  ///
  /// 报给 JS 而不是自己吞掉：失败的原因是"这台机器拿不到 token"，而**要不要告诉用户、
  /// 要不要重试**属于上层判断。原样带上系统给的那句话，别改写。
  func handleRegistrationFailure(_ message: String) {
    emit("onRemoteRegistrationFailed", ["message": message])
  }

  /// 冷启动那次点击。取走即清空（只送一次，避免每轮启动都重跳一次旧会话）。
  func takePendingOpen() -> [String: Any]? {
    // 盒子的取出与拆开分两步：跨 `sending` 边界的只有那个 Sendable 盒子。
    let boxed: UncheckedBox<[String: Any]>? = state.withLock { state in
      let pending = state.pendingOpen
      state.pendingOpen = nil
      return pending
    }
    return boxed?.value
  }

  /// JS 对前台呈现的答复。`requestId` 认不出来就丢掉——多半是 JS 答复晚于期限
  /// （那时我们已经按"不打扰"收尾过）。
  func resolvePresentation(requestId: String, options: Set<NotificationContract.PresentationOption>) {
    // 取出即从表里删掉，**在锁外**调用系统给的 handler：handler 里不许再碰我们的状态。
    let handler = state.withLock { $0.pendingPresentations.removeValue(forKey: requestId) }
    handler?.value(Self.flags(for: options))
  }

  // MARK: - UNUserNotificationCenterDelegate

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let content = notification.request.content
    let userInfo = content.userInfo
    let requestId = UUID().uuidString

    state.withLock { $0.pendingPresentations[requestId] = UncheckedBox(value: completionHandler) }

    emit("onNotificationPresented", [
      "requestId": requestId,
      "title": content.title,
      "body": content.body,
      "category": content.categoryIdentifier,
      "threadId": content.threadIdentifier,
      "sessionId": NotificationContract.text(userInfo[NotificationContract.sessionIdKey]) ?? "",
      "approvalId": NotificationContract.text(userInfo[NotificationContract.approvalIdKey]) ?? "",
      "event": NotificationContract.text(userInfo[NotificationContract.eventKey]) ?? "",
    ])

    // JS 没答复（比如 JS 线程正忙或已卸载）时的兜底：不呈现。
    // 这与 policy 对**所有前台事件**的判定一致——前台只有 drop / in_app 两种结果，
    // 两者都不弹横幅，所以兜底不会和判据打架。
    DispatchQueue.main.asyncAfter(deadline: .now() + NotificationContract.presentationDeadline) {
      [weak self] in
      self?.resolvePresentation(requestId: requestId, options: [])
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo
    if let request = NotificationContract.openRequest(
      actionIdentifier: response.actionIdentifier,
      userInfo: userInfo
    ) {
      deliver(request.jsonObject)
    }
    completionHandler()
  }

  // MARK: - 事件出口

  private func emit(_ name: String, _ payload: [String: Any]) {
    let emitter = state.withLock { $0.emitter }
    emitter?.value(name, payload)
  }

  /// 点击先试事件出口；JS 还没起来（冷启动）就落进缓冲等它来取。
  private func deliver(_ payload: [String: Any]) {
    // 先装箱：这样"看出口接没接上"和"要不要缓冲"能留在**同一把锁**里（与改动前的语义一致），
    // 而跨锁边界的是那个 Sendable 盒子，不是 `[String: Any]`。
    let boxed = UncheckedBox(value: payload)
    let emitter = state.withLock { state -> UncheckedBox<Emitter>? in
      if state.emitter == nil {
        state.pendingOpen = boxed
        return nil
      }
      return state.emitter
    }
    emitter?.value("onNotificationOpened", payload)
  }

  // MARK: - 映射（闭集合用字典，不叠条件）

  /// Apple 的 `UNAuthorizationStatus` 原始值表。数字在这里，判断在 `NotificationContract`
  /// （那边能在 Linux 上跑测试，这里不行）。
  static func status(from status: UNAuthorizationStatus) -> NotificationContract.PermissionStatus {
    NotificationContract.permissionStatus(code: status.rawValue)
  }

  static func flags(
    for options: Set<NotificationContract.AuthorizationOption>
  ) -> UNAuthorizationOptions {
    var flags: UNAuthorizationOptions = []
    for option in options {
      switch option {
      case .alert: flags.insert(.alert)
      case .sound: flags.insert(.sound)
      case .badge: flags.insert(.badge)
      case .provisional: flags.insert(.provisional)
      }
    }
    return flags
  }

  static func flags(
    for options: Set<NotificationContract.PresentationOption>
  ) -> UNNotificationPresentationOptions {
    var flags: UNNotificationPresentationOptions = []
    for option in options {
      switch option {
      case .banner: flags.insert(.banner)
      case .list: flags.insert(.list)
      case .sound: flags.insert(.sound)
      case .badge: flags.insert(.badge)
      }
    }
    return flags
  }
}
