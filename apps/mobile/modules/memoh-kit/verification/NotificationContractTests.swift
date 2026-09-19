import XCTest

/// 通知契约层（`Notifications/NotificationContract.swift`）的**纯逻辑**测试。
///
/// 跑在构建机上（`pnpm test:swift` → vultr-sg 的 swift:6.2-noble），不需要 UIKit、
/// 不需要模拟器、不需要凭据：这一层的输入输出全是字典与字符串，所以能被秒级钉住。
///
/// 为什么值得单独一组：这一层错了的形态**都不会崩**——hex 小写错一位、审批 id 从
/// `""` 变成"有值"、认不出的动作被丢掉——表现是"推送来了但点不进去"或"注册成功却
/// 收不到推送"，现场几乎查不出来。
final class NotificationContractTests: XCTestCase {
  // MARK: - device token

  func testHexTokenIsLowercaseAndZeroPadded() {
    XCTAssertEqual(NotificationContract.hexToken(Data([0x00, 0x0f, 0xff, 0xa0])), "000fffa0")
    XCTAssertEqual(NotificationContract.hexToken(Data()), "")
  }

  // MARK: - 授权状态

  func testPermissionStatusFollowsAppleRawValues() {
    XCTAssertEqual(NotificationContract.permissionStatus(code: 0), .notDetermined)
    XCTAssertEqual(NotificationContract.permissionStatus(code: 1), .denied)
    XCTAssertEqual(NotificationContract.permissionStatus(code: 2), .authorized)
    XCTAssertEqual(NotificationContract.permissionStatus(code: 3), .provisional)
    XCTAssertEqual(NotificationContract.permissionStatus(code: 4), .ephemeral)
    // 认不出来的一律当"还没定"：最坏多走一次请求（有封顶与冷却），
    // 比误判成"已授权"然后静默什么都不做要好。
    XCTAssertEqual(NotificationContract.permissionStatus(code: 99), .notDetermined)
  }

  func testAuthorizationOptionNamesMapToClosedSet() {
    let options = NotificationContract.authorizationOptions(
      named: ["alert", "badge", "provisional", "criticalAlert", ""]
    )
    XCTAssertEqual(options, [.alert, .badge, .provisional])
  }

  // MARK: - 点击 → 打开请求

  func testAllowAndRejectActionsAreRecognized() {
    XCTAssertEqual(
      NotificationContract.action(forActionIdentifier: NotificationContract.allowActionIdentifier),
      .allow
    )
    XCTAssertEqual(
      NotificationContract.action(forActionIdentifier: NotificationContract.rejectActionIdentifier),
      .reject
    )
  }

  func testUnknownActionIdentifierFallsBackToOpened() {
    // 用户点的是通知本身（系统给的动作标识符不是我们注册的任何一个）。
    XCTAssertEqual(
      NotificationContract.action(
        forActionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier"
      ),
      .opened
    )
    XCTAssertEqual(NotificationContract.action(forActionIdentifier: ""), .opened)
  }

  func testOpenRequestCarriesSessionAndApproval() {
    let request = NotificationContract.openRequest(
      actionIdentifier: NotificationContract.allowActionIdentifier,
      userInfo: [
        "sessionId": "fixture-session-untitled",
        "approvalId": "scene-approval-2",
        "event": "approval_waiting",
        "aps": ["category": "approval"],
      ]
    )
    XCTAssertEqual(request?.sessionId, "fixture-session-untitled")
    XCTAssertEqual(request?.approvalId, "scene-approval-2")
    XCTAssertEqual(request?.action, .allow)
    XCTAssertEqual(request?.event, .approvalWaiting)
    XCTAssertEqual(request?.jsonObject["approvalId"] as? String, "scene-approval-2")
  }

  func testOpenRequestWithoutSessionIsRefused() {
    // 没有 sessionId 就不知道该去哪个会话——硬跳一个空会话比不跳更糟。
    XCTAssertNil(
      NotificationContract.openRequest(
        actionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier",
        userInfo: ["approvalId": "x"]
      )
    )
    XCTAssertNil(
      NotificationContract.openRequest(
        actionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier",
        userInfo: ["sessionId": ""]
      )
    )
  }

  func testEmptyApprovalIdIsTreatedAsAbsent() {
    // 跑完/失败类通知没有审批 id；服务端给空串和给缺字段必须是同一个意思，
    // 否则 JS 会去等一个永远不会出现的审批。
    let request = NotificationContract.openRequest(
      actionIdentifier: "x",
      userInfo: ["sessionId": "s1", "approvalId": ""]
    )
    XCTAssertEqual(request?.sessionId, "s1")
    XCTAssertNil(request?.approvalId)
    XCTAssertNil(request?.jsonObject["approvalId"])
  }

  func testNumericUserInfoValuesAreCoerced() {
    // 负载过了 APNs / simctl / JSON 三趟，数值也可能出现；把它整条丢掉是最差的选择。
    let request = NotificationContract.openRequest(
      actionIdentifier: NotificationContract.rejectActionIdentifier,
      userInfo: ["sessionId": NSNumber(value: 42), "event": "run_failed"]
    )
    XCTAssertEqual(request?.sessionId, "42")
    XCTAssertEqual(request?.action, .reject)
    XCTAssertEqual(request?.event, .runFailed)
  }

  func testUnknownEventNameIsDroppedNotGuessed() {
    let request = NotificationContract.openRequest(
      actionIdentifier: "x",
      userInfo: ["sessionId": "s1", "event": "something_new"]
    )
    XCTAssertNil(request?.event)
  }

  // MARK: - 前台呈现

  func testPresentationOptionsDropUnknownNames() {
    let options = NotificationContract.presentationOptions(named: ["banner", "sound", "vibrate"])
    XCTAssertEqual(options, [.banner, .sound])
    // 空集合 = 不呈现。这正是 policy 对前台事件的判定（drop / in_app 都不弹横幅）。
    XCTAssertTrue(NotificationContract.presentationOptions(named: []).isEmpty)
  }

  func testPresentationResolutionParsesRequestIdAndOptions() {
    let resolution = NotificationContract.presentationResolution(
      fromJSON: #"{"requestId":"r1","options":["list"]}"#
    )
    XCTAssertEqual(resolution?.requestId, "r1")
    XCTAssertEqual(resolution?.options, [.list])
  }

  func testPresentationResolutionWithoutRequestIdIsRefused() {
    // 没有 requestId 就无法对应到某个挂着的 completion handler；猜一个等于把
    // 别的通知的呈现方式改掉。
    XCTAssertNil(NotificationContract.presentationResolution(fromJSON: #"{"options":["banner"]}"#))
    XCTAssertNil(NotificationContract.presentationResolution(fromJSON: "not json"))
    XCTAssertNil(NotificationContract.presentationResolution(fromJSON: "[]"))
  }

  // MARK: - 分类

  func testCategoriesParseActionsAndLocalizedTitles() {
    let specs = NotificationContract.categories(
      fromJSON: #"""
      [{"id":"approval","actions":[{"id":"memoh.approval.allow","title":"允许"},{"id":"memoh.approval.reject","title":"拒绝"}]},
       {"id":"run","actions":[]}]
      """#
    )
    XCTAssertEqual(specs.count, 2)
    XCTAssertEqual(specs[0].id, "approval")
    XCTAssertEqual(specs[0].actions.map(\.id), [
      NotificationContract.allowActionIdentifier,
      NotificationContract.rejectActionIdentifier,
    ])
    // 动作标题来自 JS 的 i18n（通知里也要是用户看得懂的语言）。
    XCTAssertEqual(specs[0].actions.first?.title, "允许")
    XCTAssertTrue(specs[1].actions.isEmpty)
  }

  func testMalformedCategoryEntriesAreDropped() {
    let specs = NotificationContract.categories(
      fromJSON: #"""
      [{"id":"","actions":[]},
       {"id":"approval","actions":[{"id":"a"},{"title":"无 id"},{"id":"b","title":""}]},
       {"actions":[]}]
      """#
    )
    XCTAssertEqual(specs.count, 1)
    // 只有 id 与 title 都齐全的动作才是可点的动作。
    XCTAssertTrue(specs[0].actions.isEmpty)
  }

  func testCategoriesRefuseNonJSON() {
    XCTAssertTrue(NotificationContract.categories(fromJSON: "").isEmpty)
    XCTAssertTrue(NotificationContract.categories(fromJSON: "{}").isEmpty)
  }

  // MARK: - 交给 JS 的形状

  func testJsonStringSerializesDeliveredDescriptions() {
    let json = NotificationContract.jsonString(from: [
      ["identifier": "n1", "sessionId": "s1"],
      ["identifier": "n2", "sessionId": "s2"],
    ])
    let parsed = NotificationContract.jsonArray(fromJSON: json)
    XCTAssertEqual(parsed?.count, 2)
    XCTAssertEqual(parsed?.first?["sessionId"] as? String, "s1")
  }
}
