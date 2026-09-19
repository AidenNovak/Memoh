import XCTest
#if canImport(MemohKit)
@testable import MemohKit
#endif
#if canImport(UIKit)
import UIKit

/// Run in an iOS hosted XCTest target linked to MemohKit/ExpoModulesCore.
/// These tests use the production view, no account, network, or test renderer.
@MainActor
final class MessageListTests: XCTestCase {
  func testToolAndAttachmentReconfigurationClearsOldContent() throws {
    let tool = ToolMessageCell(frame: .zero)
    let failed = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"tool","kind":"tool","name":"exec","status":"failed","input":{"command":"pytest"},"error":"Permission denied"}]"#)).first)
    tool.configure(failed)
    // 聚合行只显示活动措辞；原始名字、入参与诊断留在无障碍内容里。
    XCTAssertEqual(tool.heading.text, MemohStrings.text("Ran commands"))
    // 有详情（这里是 error）的可展开工具，无障碍值表达**展开态**而非状态词。
    XCTAssertEqual(tool.accessibilityValue, MemohStrings.text("Collapsed"))
    XCTAssertNotNil(tool.symbol.image)
    XCTAssertTrue(tool.accessibilityLabel?.contains("pytest") == true)
    XCTAssertTrue(tool.accessibilityLabel?.contains("Permission denied") == true)
    let done = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"tool","kind":"tool","name":"exec","status":"done"}]"#)).first)
    tool.configure(done)
    // 无详情、非运行的块不贴任何词（完成不宣布，见 R2 评审 §2b）。
    XCTAssertNil(tool.accessibilityValue, "完成态不贴状态词")
    XCTAssertFalse(tool.symbol.isHidden, "类型图标不是成功标记，完成时仍保留")
    XCTAssertFalse(tool.accessibilityLabel?.contains("Permission denied") == true)
    XCTAssertFalse(tool.accessibilityLabel?.contains("pytest") == true)

    let attachments = AttachmentsMessageCell(frame: .zero)
    let files = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"files","kind":"attachments","items":[{"key":"a","name":"a.png","size":1024,"isImage":true},{"key":"b","name":"b.txt","isImage":false}]}]"#)).first)
    attachments.configure(files)
    let fileStack = try XCTUnwrap(attachments.stack.arrangedSubviews.last as? UIStackView)
    XCTAssertEqual(fileStack.arrangedSubviews.count, 2)
    attachments.configure(files)
    XCTAssertEqual(fileStack.arrangedSubviews.count, 2)
    attachments.prepareForReuse()
    XCTAssertEqual(fileStack.arrangedSubviews.count, 0)
  }

  func testReasoningCellReuseAndAccessibleDisclosure() throws {
    let row = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"thought","kind":"reasoning","text":"A long thought","streaming":true}]"#)).first)
    let cell = ReasoningMessageCell(frame: CGRect(x: 0, y: 0, width: 358, height: 200))
    var state = ReasoningExpansionState()
    state.toggle(row.id)
    cell.configure(row, expanded: state.isExpanded(row.id))
    XCTAssertEqual(cell.body.numberOfLines, 0)
    XCTAssertEqual(cell.accessibilityIdentifier, "message-block-thought")
    XCTAssertTrue(cell.isAccessibilityElement)
    XCTAssertEqual(cell.accessibilityCustomActions?.count, 1)
    var toggles = 0
    cell.onToggle = { toggles += 1 }
    cell.disclosure.sendActions(for: .touchUpInside)
    XCTAssertEqual(toggles, 1)
    cell.prepareForReuse()
    XCTAssertNil(cell.onToggle)
    XCTAssertNil(cell.accessibilityCustomActions)
    XCTAssertEqual(cell.body.numberOfLines, 3)
    cell.configure(row, expanded: state.isExpanded(row.id))
    XCTAssertEqual(cell.body.numberOfLines, 0)
    state.toggle(row.id)
    cell.configure(row, expanded: state.isExpanded(row.id))
    XCTAssertEqual(cell.body.numberOfLines, 3)
  }

  /**
   错误块：标题来自**我们的判据**，服务端原文只在"类型化 code + 非空 message"时才上屏。
   
   这是 R15（不写 `"Error"`）与 R23/R25（开发者文案不许倒给用户）在 UIKit 这一层的钉子。
   */
  func testErrorCellTakesItsTitleFromUsAndItsReasonOnlyFromTypedServerText() throws {
    let typed = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"e","kind":"error","text":"Another client changed this task.","code":"session_runtime.invocation_conflict"}]"#)).first)
    let cell = ErrorMessageCell(frame: CGRect(x: 0, y: 0, width: 358, height: 220))
    cell.configure(typed, expanded: false, actionEnabled: true)

    // 标题说"发生了什么"，不是 "Error"（HIG 点名的反例）。
    XCTAssertEqual(cell.heading.text, MemohStrings.text("This step failed"))
    XCTAssertNotEqual(cell.heading.text, "Error")
    XCTAssertNotNil(cell.symbol.image)
    // 类型化 code + 非空 message → 原文当补充说明；它当的是**补充说明**不是标题。
    XCTAssertEqual(cell.body.text, "Another client changed this task.")
    // 技术标识默认**收起**，但确实存在（不是丢了）。
    XCTAssertTrue(cell.detailStack.isHidden)
    XCTAssertEqual(cell.disclosure.isHidden, false)
    XCTAssertEqual(cell.accessibilityValue, MemohStrings.text("Collapsed"))
    // 业务拒绝 / 写入冲突这一档**不给动作**——服务端已经说了为什么（R19/R20）。
    XCTAssertTrue(cell.action.isHidden)
    XCTAssertEqual(cell.accessibilityCustomActions?.count, 1)
    // 验收用的 id：卡片整句话的标签里含 "Try again"/"Expand details" 这样的字样，
    // 所以 flow 必须按 **id** 点，按文字会先匹配到卡片本身。
    XCTAssertEqual(cell.disclosure.accessibilityIdentifier, "message-error-details")
    XCTAssertEqual(cell.action.accessibilityIdentifier, "message-error-action")
    // 读屏：一整句落在**同一个节点**上（R30/R48）。
    let label = try XCTUnwrap(cell.accessibilityLabel)
    XCTAssertTrue(label.contains(MemohStrings.text("This step failed")))
    XCTAssertTrue(label.contains("Another client changed this task."))
    // 收起时**念不到**那个错误码：读到的和看到的是同一件事（细节还没展开）。
    XCTAssertFalse(label.contains("Error code"))
    XCTAssertFalse(label.contains("session_runtime.invocation_conflict"))
    XCTAssertFalse(label.contains(MemohStrings.text("Try again")))
    XCTAssertTrue(cell.isAccessibilityElement)

    // 没有 code：开发者原文**一个字都不上屏**，标题照旧，细节无从展开。
    let untyped = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"e2","kind":"error","text":"pq: relation \"users\" does not exist"}]"#)).first)
    cell.configure(untyped, expanded: false, actionEnabled: true)
    XCTAssertEqual(cell.body.text, MemohStrings.text("The server didn't say why"))
    XCTAssertFalse(try XCTUnwrap(cell.body.text).contains("pq:"))
    XCTAssertTrue(cell.disclosure.isHidden)
    XCTAssertNil(cell.accessibilityValue)
    let untypedLabel = try XCTUnwrap(cell.accessibilityLabel)
    XCTAssertFalse(untypedLabel.contains("pq:"))
    XCTAssertFalse(untypedLabel.contains("Error code"))
    // 认不出原因的那一档给动作（§3.1 的"无 code"一行）。
    XCTAssertFalse(cell.action.isHidden)
    XCTAssertTrue(untypedLabel.contains(MemohStrings.text("Try again")))
  }

  /** 动作：只在重试白名单上、**且宿主真的接上了**才出现（R19/R45）。 */
  func testErrorCellOffersAnActionOnlyWhenItIsBothUsefulAndWired() throws {
    let retryable = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"e","kind":"error","text":"The model did not respond in time. Please try again.","code":"agent.response_timeout"}]"#)).first)
    let cell = ErrorMessageCell(frame: CGRect(x: 0, y: 0, width: 358, height: 260))
    var actions = 0
    cell.onAction = { actions += 1 }

    // 宿主没接上（例如只回放本地帧的场景台）：按钮不显示——点了没反应比不给更糟。
    cell.configure(retryable, expanded: false, actionEnabled: false)
    XCTAssertTrue(cell.action.isHidden)
    XCTAssertFalse(cell.accessibilityActivate())
    XCTAssertEqual(actions, 0)

    cell.configure(retryable, expanded: false, actionEnabled: true)
    XCTAssertFalse(cell.action.isHidden)
    XCTAssertEqual(cell.action.title(for: .normal), nil)  // 标题在 configuration 里，不在 title
    XCTAssertEqual(cell.action.configuration?.title, MemohStrings.text("Try again"))
    XCTAssertEqual(cell.accessibilityCustomActions?.count, 2)
    // 触控目标 ≥44pt（Accessibility §Mobility，R49）。
    cell.frame = CGRect(x: 0, y: 0, width: 358, height: 260)
    cell.layoutIfNeeded()
    XCTAssertGreaterThanOrEqual(cell.action.bounds.height, 44)
    XCTAssertGreaterThanOrEqual(cell.disclosure.bounds.height, 44)
    // 贴左、不撑满：动作是"这一块里能做的事"，不是这一屏的主按钮。
    XCTAssertLessThan(cell.action.bounds.width, cell.bounds.width - 40)
    XCTAssertLessThan(cell.action.frame.minX, cell.bounds.midX)
    // 按钮点得动，且真的报给宿主。
    cell.action.sendActions(for: .touchUpInside)
    XCTAssertEqual(actions, 1)
    // 双击整块也做这件事（标签里已经念过它）。
    XCTAssertTrue(cell.accessibilityActivate())
    XCTAssertEqual(actions, 2)
  }

  /** 细节：默认收起，展开后才出现在屏幕上；展开态本身也是读屏能拿到的状态。 */
  func testErrorCellDetailsStayCollapsedUntilAskedAndSurviveReuse() throws {
    let row = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"e","kind":"error","text":"Read only","code":"fs.readonly"}]"#)).first)
    let cell = ErrorMessageCell(frame: CGRect(x: 0, y: 0, width: 358, height: 220))
    var toggles = 0
    cell.onToggle = { toggles += 1 }
    cell.configure(row, expanded: false, actionEnabled: true)
    XCTAssertEqual(cell.accessibilityIdentifier, "message-block-e")
    XCTAssertTrue(cell.detailStack.isHidden)
    // 箭头点得动；状态由 list 管，cell 只报告。
    cell.disclosure.sendActions(for: .touchUpInside)
    XCTAssertEqual(toggles, 1)
    cell.configure(row, expanded: true, actionEnabled: true)
    XCTAssertFalse(cell.detailStack.isHidden)
    XCTAssertEqual(cell.accessibilityValue, MemohStrings.text("Expanded"))
    XCTAssertEqual(cell.accessibilityHint, MemohStrings.text("Collapse details"))
    // 展开之后，那一整句里才带上技术细节（读到的和看到的同步）。
    XCTAssertTrue(try XCTUnwrap(cell.accessibilityLabel).contains("Error code: fs.readonly"))
    // 复用：一条错误换成一个没有 code 的错误，**旧的技术细节不许留在屏幕上**。
    let untyped = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"e3","kind":"error","text":"boom"}]"#)).first)
    cell.prepareForReuse()
    XCTAssertNil(cell.onToggle)
    XCTAssertNil(cell.onAction)
    XCTAssertNil(cell.accessibilityLabel)
    XCTAssertNil(cell.accessibilityCustomActions)
    XCTAssertEqual(cell.accessibilityValue, nil)
    cell.configure(untyped, expanded: true, actionEnabled: true)
    XCTAssertTrue(cell.detailStack.isHidden)
    XCTAssertTrue(cell.disclosure.isHidden)
    XCTAssertFalse(try XCTUnwrap(cell.accessibilityLabel).contains("fs.readonly"))
  }

  /**
   列表这一层：动作真的报上去，且报的是**哪一条错误块**（原生不执行动作，RN 才认识会话）。
   */
  func testListDispatchesTheErrorActionForTheBlockThatWasTapped() async throws {
    #if canImport(MemohKit)
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    let controller = UIViewController()
    window.rootViewController = controller
    let list = NativeMessageList(appContext: nil)
    list.frame = window.bounds
    controller.view.addSubview(list)
    window.isHidden = false
    defer { window.isHidden = true }
    var dispatched: [[String: Any]] = []
    list.onErrorAction.onEventSent = { dispatched.append($0) }

    list.setTurnsJSON(try fixture(0..<1, suffix: " ok"))
    try await settle()
    // 形状照**生产**的两条投影：用户那句话在历史轮次里（`scene-turn`），错误块在实时那条
    // 合成的 `__live__` 里。这就是 2026-09-16 让"重试"点了没反应的那个形状——按轮次 key 找
    // 用户正文，两边都找不到。
    list.setTurnsJSON(
      """
      [{"key":"scene-turn","position":0,"active":false,
        "user":{"key":"scene-turn","role":"user",
                "blocks":[{"key":"scene-turn:text","kind":"text","text":"把 config.toml 里的超时改成 30 秒"}]}},
       {"key":"__live__","position":9007199254740990,"active":true,
        "assistant":{"key":"__live__","role":"assistant",
                     "blocks":[{"key":"e","kind":"error","text":"The model did not respond in time. Please try again.","code":"agent.response_timeout"}]}}]
      """)
    try await settle()
    list.layoutIfNeeded()
    let collection = try XCTUnwrap(list.subviews.compactMap { $0 as? UICollectionView }.first)
    // 宿主没接上动作时按钮不显示。
    XCTAssertFalse(list.errorActionEnabled)
    var errorCell = try XCTUnwrap(collection.visibleCells.compactMap { $0 as? ErrorMessageCell }.first)
    XCTAssertTrue(errorCell.action.isHidden)

    list.errorActionEnabled = true
    try await settle()
    list.layoutIfNeeded()
    errorCell = try XCTUnwrap(collection.visibleCells.compactMap { $0 as? ErrorMessageCell }.first)
    XCTAssertFalse(errorCell.action.isHidden)
    errorCell.action.sendActions(for: .touchUpInside)
    XCTAssertEqual(dispatched.count, 1)
    XCTAssertEqual(dispatched.first?["turn"] as? String, "__live__")
    XCTAssertEqual(dispatched.first?["block"] as? String, "e")
    // **正文跟着一起报上去**：RN 侧的 turns 是另一份投影，只报轮次的话它可能找不着
    //（实测过一次：点下去界面毫无反应、服务端也没收到帧）。
    XCTAssertEqual(dispatched.first?["text"] as? String, "把 config.toml 里的超时改成 30 秒")
    #endif
  }

  private func fixture(_ indices: Range<Int>, suffix: String = "") throws -> String {
    let turns: [[String: Any]] = indices.map { index in
      ["key": "turn-\(index)", "position": index, "active": false,
       "assistant": ["key": "message-\(index)", "role": "assistant", "blocks": [
        ["key": "block-\(index)", "kind": "text", "text": "Message \(index) " + (index == indices.upperBound - 1 ? suffix : ""),
         "streaming": !suffix.isEmpty],
       ]]]
    }
    return String(decoding: try JSONSerialization.data(withJSONObject: turns), as: UTF8.self)
  }

  private func settle() async throws {
    // Bounded wait; assertions below fail if the expected scene never arrived.
    try await Task.sleep(for: .milliseconds(250))
  }

  func testStableIdentityAndAuthoritativeOrder() throws {
    let old = try TranscriptRow.decode(fixture(0..<3))
    let grown = try TranscriptRow.decode(fixture(0..<3, suffix: "More text"))
    XCTAssertEqual(old.map(\.id), grown.map(\.id))
    XCTAssertNotEqual(old.last, grown.last)
    let prepended = try TranscriptRow.decode(fixture(-2..<3))
    XCTAssertEqual(Array(prepended.suffix(3)).map(\.id), old.map(\.id))
    XCTAssertThrowsError(try TranscriptRow.decode("not JSON"))
    let one = try fixture(0..<1)
    let duplicate = "[" + one.dropFirst().dropLast() + "," + one.dropFirst().dropLast() + "]"
    XCTAssertThrowsError(try TranscriptRow.decode(duplicate))
  }

  func testStreamingFollowReadingAnchorAndReturnButton() async throws {
    // 依赖 NativeMessageList（ExpoView，import ExpoModulesCore）：只有链接了
    // MemohKit/ExpoModulesCore 的 hosted target 才能编译这条（见文件头注释）。
    #if canImport(MemohKit)
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    let controller = UIViewController()
    window.rootViewController = controller
    let list = NativeMessageList(appContext: nil)
    list.frame = window.bounds
    controller.view.addSubview(list)
    window.isHidden = false
    defer { window.isHidden = true }
    list.setTurnsJSON(try fixture(0..<1000))
    try await settle()
    list.layoutIfNeeded()
    let collection = try XCTUnwrap(list.subviews.compactMap { $0 as? UICollectionView }.first)
    XCTAssertEqual(collection.numberOfItems(inSection: 0), 1000)
    XCTAssertLessThan(collection.visibleCells.count, 1000)

    list.setTurnsJSON(try fixture(0..<1001))
    try await settle()
    let bottom = collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom
    XCTAssertEqual(collection.contentOffset.y, bottom, accuracy: 2)

    let streamedText = String(repeating: "Streaming line\n", count: 20)
    list.setTurnsJSON(try fixture(0..<1001, suffix: streamedText))
    try await settle()
    XCTAssertEqual(collection.numberOfItems(inSection: 0), 1001)
    XCTAssertTrue(collection.visibleCells.contains { $0.accessibilityLabel?.contains(streamedText) == true })
    XCTAssertEqual(collection.contentOffset.y,
                   collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom,
                   accuracy: 2)

    // Inject only the gesture boundary; data source, cells, and layout are production code.
    list.scrollViewWillBeginDragging(collection)
    collection.contentOffset.y = 300
    collection.layoutIfNeeded()
    let anchorPath = try XCTUnwrap(collection.indexPathsForVisibleItems.sorted().first)
    let anchorCell = try XCTUnwrap(collection.cellForItem(at: anchorPath))
    let anchorID = anchorCell.accessibilityIdentifier
    let distance = try XCTUnwrap(collection.layoutAttributesForItem(at: anchorPath)).frame.minY - collection.contentOffset.y
    list.setTurnsJSON(try fixture(-5..<1002))
    try await settle()
    let restored = try XCTUnwrap(collection.visibleCells.first { $0.accessibilityIdentifier == anchorID })
    XCTAssertEqual(restored.frame.minY - collection.contentOffset.y, distance, accuracy: 2)
    let button = try XCTUnwrap(list.subviews.compactMap { $0 as? UIButton }.first)
    XCTAssertFalse(button.isHidden)
    XCTAssertGreaterThanOrEqual(button.bounds.height, 44)
    button.sendActions(for: .touchUpInside)
    XCTAssertTrue(button.isHidden)
    XCTAssertEqual(collection.contentOffset.y,
                   collection.contentSize.height - collection.bounds.height + collection.adjustedContentInset.bottom,
                   accuracy: 2)

    list.setTurnsJSON("invalid")
    try await settle()
    XCTAssertEqual(collection.numberOfItems(inSection: 0), 1007)
    list.setTurnsJSON("[]")
    try await settle()
    XCTAssertEqual(collection.numberOfItems(inSection: 0), 0)
    #endif
  }

  /**
   两种表面必须**真的**映射到不同的颜色。

   政策层的断言（两者是不同的枚举值）在 `MessageListLogicTests` 里；这里验证实现
   没有在转换那一步又把它们填回同一个。实测这里曾经就是同一个灰：一张工具场景截图
   里那种灰占了 49% 的像素，整屏没有层级——所以这条不是形式主义。
   */
  func testActivitySurfaceDiffersFromUserBubble() {
    let traits = UITraitCollection()
    let user = MessageBlockCell.color(for: MessageListMetrics.userSurface, traits: traits)
    let activity = MessageBlockCell.color(for: MessageListMetrics.activitySurface, traits: traits)
    XCTAssertNotEqual(user, activity, "两种表面映射到了同一种颜色——层级会在真实屏幕上消失")
    XCTAssertGreaterThan(user.cgColor.alpha, 0.9, "用户气泡必须是实心的：用户说的话是实体")
  }

  /// 活动措辞保持不变；运行状态由行尾 spinner 与 VoiceOver value 表达。
  func testToolHeaderNamesToolAndStatesStatusBeside() throws {
    let row = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"tool","kind":"tool","name":"exec","status":"running","location":"workspace"}]"#)).first)
    let cell = ToolMessageCell(frame: .zero)
    cell.configure(row)
    XCTAssertEqual(cell.heading.text, MemohStrings.text("Ran commands"))
    XCTAssertEqual(cell.accessibilityValue, MemohStrings.text("Running"))
    XCTAssertTrue(cell.accessibilityLabel?.contains("exec. workspace") == true)
    XCTAssertTrue(cell.spinner.isAnimating, "执行中要有活的指示，静止图标会被读成卡住")
    XCTAssertFalse(cell.symbol.isHidden, "前导图标表达活动类型，不重复表达运行状态")
    XCTAssertEqual(cell.heading.font, UIFont.preferredFont(forTextStyle: .footnote))
    XCTAssertTrue(cell.heading.adjustsFontForContentSizeCategory)
    XCTAssertEqual(cell.stack.layer.borderWidth, 0)
    XCTAssertEqual(cell.stack.backgroundColor, .clear)
    XCTAssertTrue(cell.isAccessibilityElement)
    XCTAssertEqual(cell.accessibilityIdentifier, "message-block-tool")
    XCTAssertNil(cell.accessibilityCustomActions)
    XCTAssertFalse(cell.accessibilityTraits.contains(.button))

    // 完成后仍是相同的类型图标与措辞，只停 spinner。
    let finished = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"tool","kind":"tool","name":"exec","status":"done","location":"workspace"}]"#)).first)
    cell.configure(finished)
    XCTAssertNil(cell.accessibilityValue, "完成态不贴状态词")
    XCTAssertFalse(cell.symbol.isHidden)
    XCTAssertFalse(cell.spinner.isAnimating, "跑完了要停掉 spinner，不能留着空转")
    XCTAssertEqual(cell.heading.text, MemohStrings.text("Ran commands"))
    cell.configure(row)
    cell.prepareForReuse()
    XCTAssertFalse(cell.spinner.isAnimating)
    XCTAssertNil(cell.accessibilityLabel)
    XCTAssertNil(cell.accessibilityIdentifier)
  }

  func testGroupedToolErrorsKeepNeutralRenderingAndAllAccessibleNames() throws {
    let rows = try TranscriptRow.decode(MessageListLogicTests.transcript(MessageListLogicTests.chatToolsBlocks))
    let group = try XCTUnwrap(MessageListLogicTests.toolGroups(rows).first)
    let cell = ToolMessageCell(frame: .zero)
    cell.configure(group)
    let text = cell.heading.text
    let icon = cell.symbol.image
    // 状态色用 Memoh 品牌次标签色（暖灰 #6A6965），不是系统 .secondaryLabel——
    // 这是品牌对齐后的设计决策（tokens.ts 与 MemohPalette.swift 两端一致）。
    let expected = MemohPalette.secondaryLabel(cell.traitCollection)
    XCTAssertEqual(cell.heading.textColor, expected)
    XCTAssertEqual(cell.symbol.tintColor, expected)
    XCTAssertEqual(cell.spinner.color, expected)
    XCTAssertTrue(cell.spinner.isAnimating)
    XCTAssertTrue(cell.body.isHidden)
    XCTAssertEqual(cell.accessibilityIdentifier, "message-block-m10")
    XCTAssertEqual(cell.accessibilityLabel?.components(separatedBy: "exec").count, 3)
    XCTAssertTrue(cell.accessibilityLabel?.contains("fs_write") == true)
    let clean = MessageListLogicTests.chatToolsBlocks.replacingOccurrences(of: "\"isError\":true", with: "\"isError\":false")
    let cleanRows = try TranscriptRow.decode(MessageListLogicTests.transcript(clean))
    cell.configure(try XCTUnwrap(MessageListLogicTests.toolGroups(cleanRows).first))
    XCTAssertEqual(cell.heading.text, text)
    XCTAssertEqual(cell.symbol.image, icon)
    XCTAssertEqual(cell.heading.textColor, expected)
    XCTAssertEqual(cell.symbol.tintColor, expected)
    XCTAssertEqual(cell.spinner.color, expected)
  }

  func testActivityRowsIndentUnderFullWidthText() throws {
    // R2 第 2 项：正文（结论）贴左，工具/思考活动行（过程）内缩——从属关系
    // 靠缩进表达（对齐 lody-ios ChatCell.leading：tool/thought = 24 相对屏幕）。
    let textCell = TextMessageCell(frame: .zero)
    XCTAssertEqual(textCell.leadingInset, 0, "正文不缩进")
    let toolCell = ToolMessageCell(frame: .zero)
    XCTAssertEqual(toolCell.leadingInset, MessageListMetrics.activityInset, "工具活动行缩进")
    let reasoningCell = ReasoningMessageCell(frame: .zero)
    XCTAssertEqual(reasoningCell.leadingInset, MessageListMetrics.activityInset, "思考活动行缩进")
    // 展开详情容器跟随活动行缩进（在同一列内下钻，不另起一列）。
    let rows = try TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"a","kind":"tool","name":"exec","status":"done","input":{"command":"pytest"}}]"#))
    let group = try XCTUnwrap(MessageListLogicTests.toolGroups(rows).first)
    toolCell.frame = CGRect(x: 0, y: 0, width: 390, height: 240)
    toolCell.configure(group, expanded: true)
    toolCell.layoutIfNeeded()
    XCTAssertEqual(toolCell.stack.frame.minX, MessageListMetrics.activityInset, "活动行相对正文内缩")
    // detailStack.frame 是相对 stack 的坐标；换算到 contentView 再比。
    let detailX = toolCell.contentView.convert(toolCell.detailStack.frame.origin, from: toolCell.stack).x
    XCTAssertEqual(detailX, toolCell.stack.frame.minX, "详情容器与活动行同列（跟随缩进）")
  }

  func testToolCardExpansionLayersInputAndKeepsNeutralHeading() throws {
    // 输入条目：key 次要色 / value 正文色（R2 第 3 项）；失败诊断用危险红；
    // 标题保持中性，不因 isError 染色；耗时只在服务端给了才显示。
    let blocks = #"[{"key":"a","kind":"tool","name":"exec","status":"done","location":"workspace","durationMs":1500,"input":{"command":"pytest -q","cwd":"/tmp"}},{"key":"b","kind":"tool","name":"fs_read","status":"done","input":{"path":"a.txt"},"output":{"isError":true,"content":[{"type":"text","text":"Permission denied"}]}}]"#
    let rows = try TranscriptRow.decode(MessageListLogicTests.transcript(blocks))
    let group = try XCTUnwrap(MessageListLogicTests.toolGroups(rows).first)
    XCTAssertTrue(group.expandable, "有输入条目 + 失败诊断，应该可展开")
    let cell = ToolMessageCell(frame: .zero)
    cell.configure(group, expanded: true)
    XCTAssertFalse(cell.detailStack.isHidden, "展开后详情容器必须可见")
    XCTAssertFalse(cell.disclosure.isHidden, "可展开的工具必须有箭头")
    // 标题与箭头都保持中性（失败不染色）。
    let expected = MemohPalette.secondaryLabel(cell.traitCollection)
    XCTAssertEqual(cell.heading.textColor, expected)
    // 详情内容：成员块里应能找到输入条目（key muted / value fg）与红色诊断。
    let memberBlocks = cell.detailStack.arrangedSubviews.compactMap { $0 as? UIStackView }
    XCTAssertEqual(memberBlocks.count, 2, "两个成员各一个块")
    // 输入行是横向 stack（key/value 两个 label），要递归一层才能拿到。
    let allLabels = memberBlocks.flatMap { block in
      block.arrangedSubviews.flatMap { view -> [UILabel] in
        if let row = view as? UIStackView {
          return row.arrangedSubviews.compactMap { $0 as? UILabel }
        }
        return [view].compactMap { $0 as? UILabel }
      }
    }
    let keyLabels = allLabels.filter { $0.text == "command" || $0.text == "cwd" || $0.text == "path" }
    XCTAssertEqual(keyLabels.count, 3, "输入条目的 key 应该渲染出来")
    for key in keyLabels {
      XCTAssertEqual(key.textColor, expected, "key 用次要色")
    }
    let redDiagnosis = allLabels.filter { $0.text?.contains("Permission denied") == true }
    XCTAssertEqual(redDiagnosis.count, 1, "失败诊断要渲染出来")
    XCTAssertEqual(redDiagnosis[0].textColor, MemohPalette.destructive(cell.traitCollection), "诊断用危险红")
    XCTAssertTrue(allLabels.contains { $0.text?.contains("1.5s") == true }, "服务端给了耗时就要显示")
    // 折叠后详情收起、箭头仍在（可再展开）。
    cell.configure(group, expanded: false)
    XCTAssertTrue(cell.detailStack.isHidden)
    XCTAssertFalse(cell.disclosure.isHidden)
  }

  func testToolCardDisclosureTogglesAndExposesVoiceOverAction() throws {
    let blocks = #"[{"key":"a","kind":"tool","name":"exec","status":"done","input":{"command":"pytest"}},{"key":"b","kind":"tool","name":"fs_read","status":"done","input":{"path":"a.txt"}}]"#
    let rows = try TranscriptRow.decode(MessageListLogicTests.transcript(blocks))
    let group = try XCTUnwrap(MessageListLogicTests.toolGroups(rows).first)
    let cell = ToolMessageCell(frame: .zero)
    cell.configure(group)
    XCTAssertEqual(cell.accessibilityCustomActions?.count, 1, "可展开的工具要暴露 custom action")
    var toggles = 0
    cell.onToggle = { toggles += 1 }
    cell.disclosure.sendActions(for: .touchUpInside)
    XCTAssertEqual(toggles, 1, "点箭头要触发 onToggle")
    cell.prepareForReuse()
    XCTAssertNil(cell.onToggle)
    XCTAssertNil(cell.accessibilityCustomActions)
  }

  func testToolCardNotExpandableWhileRunning() throws {
    let blocks = #"[{"key":"a","kind":"tool","name":"exec","status":"running","input":{"command":"pytest"}}]"#
    let rows = try TranscriptRow.decode(MessageListLogicTests.transcript(blocks))
    let group = try XCTUnwrap(MessageListLogicTests.toolGroups(rows).first)
    XCTAssertFalse(group.expandable, "运行中不可展开——参数可能还在流")
    let cell = ToolMessageCell(frame: .zero)
    cell.configure(group, expanded: true)
    XCTAssertTrue(cell.disclosure.isHidden, "运行中不显示箭头")
    XCTAssertTrue(cell.detailStack.isHidden, "运行中不渲染详情")
  }

  func testToolExpansionStateTogglesAndRetains() {
    let id = TranscriptRow.ID(turn: "t", message: "m", role: "user", block: "b", kind: .tool)
    var state = ToolExpansionState()
    XCTAssertFalse(state.isExpanded(id))
    state.toggle(id)
    XCTAssertTrue(state.isExpanded(id), "toggle 之后应该展开")
    state.toggle(id)
    XCTAssertFalse(state.isExpanded(id), "再 toggle 应该收起")
    state.toggle(id)
    state.retain([TranscriptRow.ID(turn: "t", message: "m", role: "user", block: "gone", kind: .tool)])
    XCTAssertFalse(state.isExpanded(id), "retain 只保留现存 id")
  }

  func testToolInputEntriesExposeFlatScalarPairs() throws {
    // entries 只摊平标量对象；嵌套/数组退回空（视觉分层只服务真正可读的键值）。
    let flat = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"t","kind":"tool","name":"exec","input":{"command":"pytest -q","cwd":"/tmp","flag":true}}]"#)).first)
    let entries = try XCTUnwrap(flat.block.input?.entries)
    XCTAssertEqual(entries.map(\.key), ["command", "cwd", "flag"], "按 key 排序")
    XCTAssertEqual(entries.map(\.value), ["pytest -q", "/tmp", "true"])
    let nested = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"t","kind":"tool","name":"exec","input":{"command":{"shell":"bash","args":["-c","pwd"]}}}]"#)).first)
    XCTAssertTrue(nested.block.input?.entries.isEmpty == true, "嵌套对象不摊平")
  }

  func testListGroupsToolsAndRefreshesWhenNonFirstToolFinishes() async throws {
    // 同 testStreamingFollowReadingAnchorAndReturnButton：依赖 NativeMessageList。
    #if canImport(MemohKit)
    let list = NativeMessageList(appContext: nil)
    list.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    let blocks = #"[{"key":"a","kind":"tool","name":"exec","status":"done"},{"key":"b","kind":"tool","name":"fs_read","status":"running"}]"#
    list.setTurnsJSON(MessageListLogicTests.transcript(blocks))
    try await settle()
    list.layoutIfNeeded()
    let collection = try XCTUnwrap(list.subviews.compactMap { $0 as? UICollectionView }.first)
    XCTAssertEqual(collection.numberOfItems(inSection: 0), 1)
    let cell = try XCTUnwrap(collection.cellForItem(at: IndexPath(item: 0, section: 0)) as? ToolMessageCell)
    XCTAssertEqual(cell.accessibilityIdentifier, "message-block-a")
    XCTAssertTrue(cell.spinner.isAnimating)
    let text = cell.heading.text
    list.setTurnsJSON(MessageListLogicTests.transcript(blocks.replacingOccurrences(of: "running", with: "done")))
    try await settle()
    XCTAssertEqual(collection.numberOfItems(inSection: 0), 1)
    let updated = try XCTUnwrap(collection.cellForItem(at: IndexPath(item: 0, section: 0)) as? ToolMessageCell)
    XCTAssertEqual(updated.accessibilityIdentifier, "message-block-a")
    XCTAssertEqual(updated.heading.text, text)
    XCTAssertFalse(updated.spinner.isAnimating)
    #endif
  }

  // MARK: - Markdown 渲染（UIKit 这一层：块视图、复制、无障碍）

  /// 正文 cell 把 Markdown 画成**多个块视图**，而不是一段原文。
  func testTextCellRendersMarkdownBlocksAndCopyableText() throws {
    let row = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      ##"[{"key":"m1","kind":"text","text":"# Title\n\nHello **bold** and [RFC](https://example.com/rfc).\n\n```\ncode line\n```\n\n---"}]"##)).first)
    let cell = TextMessageCell(frame: CGRect(x: 0, y: 0, width: 358, height: 600))
    cell.configure(row)
    // 标题 / 段落 / 代码 / 分隔线 = 4 块（不是一整段文字）。
    XCTAssertEqual(cell.renderedBlockCount, 4)
    XCTAssertTrue(cell.renderedBlockViews[0] is MarkdownTextBlockView)
    XCTAssertTrue(cell.renderedBlockViews[2] is MarkdownCodeBlockView)
    XCTAssertTrue(cell.renderedBlockViews[3] is MarkdownRuleView)
    // 标题真的更大：H1 用的是 title2 那一档（Dynamic Type 下跟着长）。
    let heading = try XCTUnwrap((cell.renderedBlockViews[0] as? MarkdownTextBlockView)?.label.attributedText)
    let headingFont = try XCTUnwrap(heading.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
    XCTAssertGreaterThan(headingFont.pointSize, UIFont.preferredFont(forTextStyle: .body).pointSize)
    // 代码块是等宽的，且长行不折（`byClipping` + 横向滚动）。
    let code = try XCTUnwrap((cell.renderedBlockViews[2] as? MarkdownCodeBlockView))
    XCTAssertEqual(code.accessibilityIdentifier, "markdown-code-block")

    // 可复制：复制的是渲染后的纯文本。
    var copied: String?
    cell.onCopy = { copied = $0 }
    XCTAssertNotNil(cell.accessibilityCustomActions?.first { $0.name == MemohStrings.text("Copy") },
                    "读屏要有复制动作")
    XCTAssertTrue(cell.copyMessage())
    let text = try XCTUnwrap(copied)
    XCTAssertTrue(text.contains("Title"))
    XCTAssertTrue(text.contains("Hello bold and RFC"))
    XCTAssertTrue(text.contains("code line"))
    for marker in ["**", "#", "`"] {
      XCTAssertFalse(text.contains(marker), "复制文本里不该有 \(marker)")
    }
    // 读屏：句子，不是符号。
    XCTAssertTrue(cell.accessibilityLabel?.contains("Hello bold and RFC") == true)
    XCTAssertFalse(cell.accessibilityLabel?.contains("**") == true)
  }

  /// 流式：追加时**前面的块视图被复用**（不是每来一个 token 重建整条消息）。
  func testTextCellReusesBlocksWhileStreaming() throws {
    let first = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      ##"[{"key":"m1","kind":"text","streaming":true,"text":"# Title\n\nA **bo"}]"##)).first)
    let cell = TextMessageCell(frame: CGRect(x: 0, y: 0, width: 358, height: 600))
    cell.configure(first)
    let before = cell.renderedBlockViews
    XCTAssertEqual(before.count, 2)
    // 半截的 `**bo` 不许闪成 `**bo`：屏幕上应该是粗体的 `bo`。
    XCTAssertFalse(cell.renderedPlainText?.contains("**") == true)

    let second = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      ##"[{"key":"m1","kind":"text","streaming":true,"text":"# Title\n\nA **bold** word"}]"##)).first)
    cell.configure(second)
    XCTAssertEqual(cell.renderedBlockCount, 2)
    XCTAssertTrue(cell.renderedBlockViews[0] === before[0], "标题块整块没变，必须复用")
    XCTAssertTrue(cell.renderedBlockViews[1] === before[1], "同一个段落块原地更新，不重建")
    XCTAssertFalse(cell.renderedPlainText?.contains("**") == true)
  }

  /**
   最大辅助字号（AX XXXL）下**块视图不被裁切**。

   ## 为什么这条要用"量高度"而不是"看截图"

   中文在 AX XXXL 下一行只放得下七八个字，标题能折成两三行。差 2pt 的裁切在截图上看
   只是"字的底部被切平"——肉眼看不出是排版错了还是字体本身如此（2026-09-17 真机截图上
   就出现过：段落最后一行与行内代码 `TCP/IP` 的底部被切平）。

   所以这里走**与列表同一条路**：先问 cell 要它在 358pt 宽下的自适应高度（collection view
   就是这么问的），再把 cell 摆成那个高度，然后逐个块视图断言"标签的 frame 高度 ≥ 它的
   文字在该宽度下需要的高度"。高度算小了，这条就红。

   同一份样例在默认字号下也跑一遍（`testMarkdownBlocksAreNotClippedAtDefaultSize`）——
   两条一起才说明"不是只有大字号才不裁"。
   */
  func testMarkdownBlocksAreNotClippedAtAccessibilityXXXL() throws {
    try assertMarkdownBlocksAreNotClipped(
      contentSize: .accessibilityExtraExtraExtraLarge, width: 358, label: "AX XXXL")
  }

  /// 默认字号下的同一条判据（对照组）。
  func testMarkdownBlocksAreNotClippedAtDefaultSize() throws {
    try assertMarkdownBlocksAreNotClipped(contentSize: .large, width: 358, label: "默认字号")
  }

  private func assertMarkdownBlocksAreNotClipped(
    contentSize: UIContentSizeCategory, width: CGFloat, label: String
  ) throws {
    let row = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      ##"[{"key":"m1","kind":"text","text":"# A History of the Internet\n\n## Precursors and the Problem of Time-Sharing\n\n互联网的前身是 **ARPANET**，由美国国防部高级研究计划局于 1969 年建立，最初只连接了少数几所大学和研究机构，采用*分组交换*技术传输数据。1983 年，ARPANET 正式启用 `TCP/IP` 协议，这被广泛认为是现代互联网诞生的标志。\n\n几个关键里程碑：\n\n- 1969 年：ARPANET 首批节点上线\n- 1971 年：电子邮件发明\n- 1991 年：万维网发布\n\n```python\nimport urllib.request\nresponse = urllib.request.urlopen(\"https://example.com\")\nprint(response.status)\n```\n\n---\n\n更多规范可以参考 [RFC 标准文档](https://example.com/rfc)。"}]"##)).first)

    let cell = TextMessageCell(frame: .zero)
    cell.traitOverrides.preferredContentSizeCategory = contentSize
    cell.configure(row)
    // 与 collection view 同一条路：先问它在这个宽度下要多高。
    let fitting = cell.systemLayoutSizeFitting(
      CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
      withHorizontalFittingPriority: .required,
      verticalFittingPriority: .fittingSizeLevel)
    cell.bounds = CGRect(x: 0, y: 0, width: width, height: fitting.height)
    cell.layoutIfNeeded()

    XCTAssertGreaterThan(cell.renderedBlockCount, 3, "\(label)：样例该解析出多个块")
    for (index, view) in cell.renderedBlockViews.enumerated() {
      if let text = view as? MarkdownTextBlockView {
        let needed = text.label.sizeThatFits(
          CGSize(width: text.label.bounds.width, height: .greatestFiniteMagnitude)).height
        XCTAssertGreaterThanOrEqual(
          text.label.bounds.height + 0.5, needed,
          "\(label)：第 \(index) 块的高度装不下它的文字（\(text.label.bounds.height) < \(needed)）——字会被切掉")
        XCTAssertGreaterThan(text.label.bounds.width, 0, "\(label)：第 \(index) 块的宽度是 0")
      }
      if let code = view as? MarkdownCodeBlockView {
        // 代码块：行**不折**（内容比框宽是设计），但垂直方向必须装得下所有行。
        let scroll = try XCTUnwrap(code.subviews.compactMap { $0 as? UIScrollView }.first,
                                   "\(label)：代码块里该有一个横向滚动视图")
        XCTAssertGreaterThanOrEqual(
          scroll.bounds.height + 0.5, scroll.contentSize.height,
          "\(label)：代码块高度装不下全部行——后面的行会被切掉")
        XCTAssertGreaterThan(
          scroll.contentSize.width, scroll.bounds.width,
          "\(label)：样例里的代码行长于框宽，内容宽必须更大，否则横向滚不起来")
      }
    }
  }

  /// 没有思考内容时**整套 UI 都不出现**（不空占位、不留空盒子）。
  func testReasoningCellDrawsNothingWithoutContent() throws {
    let cell = ReasoningMessageCell(frame: CGRect(x: 0, y: 0, width: 358, height: 200))
    let blank = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"m1","kind":"reasoning","text":" \n "}]"#)).first)
    cell.configure(blank, expanded: false)
    XCTAssertTrue(cell.header.isHidden)
    XCTAssertTrue(cell.body.isHidden)
    XCTAssertTrue(cell.disclosure.isHidden)
    XCTAssertNil(cell.accessibilityLabel)
    XCTAssertNil(cell.accessibilityCustomActions)

    // 有内容才出现：标题说"这里是模型的思考"，折叠是预览、展开是全文。
    let filled = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"m1","kind":"reasoning","text":"先看磁盘再决定","streaming":true}]"#)).first)
    cell.configure(filled, expanded: false)
    XCTAssertFalse(cell.header.isHidden)
    XCTAssertEqual(cell.heading.text, MemohStrings.text("Reasoning"))
    XCTAssertEqual(cell.body.numberOfLines, 3)
    XCTAssertEqual(cell.disclosure.configuration?.title, MemohStrings.text("Expand reasoning"))
    cell.configure(filled, expanded: true)
    XCTAssertEqual(cell.body.numberOfLines, 0)
    XCTAssertEqual(cell.disclosure.configuration?.title, MemohStrings.text("Collapse reasoning"))

    // 时长已知：并进标题（折叠态也看得见"想了多久"）。判据在 MessageListLogicTests，
    // 这里钉的是**cell 真的用了它**（换了实现、忘了接线时这条会红）。
    let timed = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"m1","kind":"reasoning","text":"先看磁盘再决定","durationMs":3200}]"#)).first)
    cell.configure(timed, expanded: false)
    let expectedDuration = String(format: MemohStrings.text("Thought for %lld seconds"), Int64(3))
    XCTAssertEqual(cell.heading.text, "\(MemohStrings.text("Reasoning")) · \(expectedDuration)")
    XCTAssertEqual(cell.body.numberOfLines, 3, "折叠态的三行预览不受标题影响")
  }

  /**
   回底按钮与复制确认住在列表底部的**常驻余量**里——它们压不到正文。

   几何证据在真机截图上（同一份内容、只差 `-MemohLegacyBottomOverlay 1` 这一个开关：
   改前最后一行的底 y=703 落在按钮的 y 686..730 里，改后 y=651、与按钮顶留 35pt）；
   这里钉住那条不变式：余量不小于按钮高度 + 间隙。

   断言对象是 `MessageListMetrics`（Foundation-only 政策）而**不是** `NativeMessageList`：
   后者 `import ExpoModulesCore`、不进测试 bundle，写它整份 hosted 测试编不过。
   */
  func testBottomReserveKeepsOverlaysOffTheContent() {
    XCTAssertGreaterThanOrEqual(
      MessageListMetrics.bottomReserve, MessageListMetrics.bottomReserveMinimum,
      "余量小于按钮高度 + 间隙——回底按钮会重新压住正文")
  }
}
#endif

// No UIKit, Expo, window, account, or simulator required. Compile alongside Transcript.swift.
final class MessageListLogicTests: XCTestCase {
  /**
   链接白名单：只有 http / https / mailto 能被打开（半截 URL 不上色成可点）。

   **这一条原来住在 `#if canImport(UIKit)` 那一段里**（2026-09-18 搬出来）：判据本身全是字符串
   （scheme 白名单 + "半截 URL"那两个 case），与 UIKit 无关，住在那边意味着**只有装了 Xcode 的
   hosted 测试跑得到**。搬到 `MarkdownLinkPolicy`（Foundation-only）+ 这个 suite 之后，
   `pnpm test:swift` 在 `vultr-sg` 的 Linux 容器里也会跑它。
   */
  func testOnlySafeLinkDestinationsAreOpenable() {
    XCTAssertNotNil(MarkdownLinkPolicy.openableURL("https://example.com/a"))
    XCTAssertNotNil(MarkdownLinkPolicy.openableURL("mailto:someone@example.com"))
    XCTAssertNil(MarkdownLinkPolicy.openableURL("javascript:alert(1)"))
    XCTAssertNil(MarkdownLinkPolicy.openableURL("file:///etc/passwd"))
    XCTAssertNil(MarkdownLinkPolicy.openableURL("shortcuts://run-shortcut?name=x"))
    XCTAssertNil(MarkdownLinkPolicy.openableURL("https://"), "半截 URL（流式中间态）不该可点")
  }

  // chat-tools after the TS reducer: running -> status, execution_location -> location.
  static let chatToolsBlocks = #"[{"key":"m10","kind":"tool","name":"exec","title":"pytest -q tests/reports","status":"running","location":"workspace","input":{"command":"pytest -q tests/reports"}},{"key":"m11","kind":"tool","name":"fs_write","title":"fs_write","status":"done","input":{"path":"/data/reports/chart-1.png"},"output":"wrote 240 KB"},{"key":"m12","kind":"tool","name":"exec","title":"npm run build","status":"done","input":{"command":"npm run build"},"output":{"isError":true,"content":[{"type":"text","text":"Module not found: @scope/missing"}]}}]"#

  static func toolGroups(_ rows: [TranscriptRow]) -> [ToolActivityGroup] {
    TranscriptDisplayRow.grouped(rows).compactMap {
      if case .tools(let group) = $0 { return group }
      return nil
    }
  }

  func testConsecutiveToolsGroupAndEveryOtherKindBreaksTheGroup() throws {
    let tools = try TranscriptRow.decode(Self.transcript(Self.chatToolsBlocks))
    let grouped = TranscriptDisplayRow.grouped(tools)
    XCTAssertEqual(grouped.count, 1)
    XCTAssertEqual(Self.toolGroups(tools).first?.rows, tools)
    XCTAssertEqual(grouped.first?.id, tools.first?.id)
    XCTAssertEqual(Self.toolGroups([tools[0]]).first?.rows, [tools[0]])
    XCTAssertTrue(TranscriptDisplayRow.grouped([]).isEmpty)
    for kind in BlockKind.allCases where kind != .tool {
      let separator = try XCTUnwrap(TranscriptRow.decode(Self.transcript(
        #"[{"key":"break","kind":"\#(kind.rawValue)","text":"Interlude"}]"#)).first)
      let result = TranscriptDisplayRow.grouped([tools[0], separator, tools[1], tools[2]])
      XCTAssertEqual(result.count, 3)
      XCTAssertEqual(result[1], .block(separator), "非工具渲染行必须原样保留")
      XCTAssertEqual(Self.toolGroups([tools[0], separator, tools[1], tools[2]]).map(\.rows.count), [1, 2])
    }
  }

  func testGroupsNeverCrossTurnMessageOrRoleBoundaries() throws {
    let blocks = #"[{"key":"t","kind":"tool","name":"exec"}]"#
    let first = try XCTUnwrap(TranscriptRow.decode(Self.transcript(blocks)).first)
    let otherTurn = try XCTUnwrap(TranscriptRow.decode(Self.transcript(blocks, turn: "other")).first)
    let otherMessage = try XCTUnwrap(TranscriptRow.decode(Self.transcript(blocks, message: "other")).first)
    let otherRole = TranscriptRow(id: .init(turn: first.id.turn, message: first.id.message,
      role: "system", block: "other", kind: .tool), block: first.block)
    for other in [otherTurn, otherMessage, otherRole] {
      XCTAssertEqual(TranscriptDisplayRow.grouped([first, other]).count, 2)
    }
  }

  func testToolActivityCategoryMappingAndFallback() {
    let cases: [(ToolActivityCategory, [String])] = [
      (.read, ["read", "fs_read", "list_files", "search", "ReadFile", "web_search"]),
      (.edit, ["write", "fs_write", "edit", "apply_patch", "patch", "apply"]),
      (.execute, ["exec", "execute", "bash", "shell", "run_command", "terminal"]),
      (.network, ["fetch", "web", "http_get", "HTTP"]),
      (.other, ["custom_action", "git_commit", "", "computer"]),
    ]
    for (category, names) in cases {
      for name in names { XCTAssertEqual(ToolActivityCategory.classify(name), category, name) }
    }
    XCTAssertEqual(ToolActivityCategory.classify(nil), .other)
    XCTAssertEqual(ToolActivityCategory.allCases.map(\.symbolName), [
      "doc.text.magnifyingglass", "square.and.pencil", "terminal", "globe", "wrench.and.screwdriver",
    ])
    XCTAssertEqual(ToolActivityCategory.allCases.map(\.titleKey), [
      "Read files", "Edited files", "Ran commands", "Fetched from the web", "Used tools",
    ])
  }

  func testMixedActivityWordingDeduplicatesAndCapsAtThreeInFirstSeenOrder() throws {
    let names = ["exec", "fs_read", "bash", "fs_write", "fetch", "custom"]
    let blocks = names.enumerated().map { index, name in
      #"{"key":"\#(index)","kind":"tool","name":"\#(name)"}"#
    }.joined(separator: ",")
    let rows = try TranscriptRow.decode(Self.transcript("[" + blocks + "]"))
    let group = try XCTUnwrap(Self.toolGroups(rows).first)
    XCTAssertEqual(group.categories, [.execute, .read, .edit, .network, .other])
    XCTAssertEqual(group.text, ["Ran commands", "Read files", "Edited files"]
      .map { MemohStrings.text($0) }.joined(separator: MemohStrings.text(", ")))
    XCTAssertEqual(group.symbolName, "wrench.and.screwdriver")
    XCTAssertEqual(group.text, Self.toolGroups(rows).first?.text)
    let singleCategory = try XCTUnwrap(Self.toolGroups([rows[0], rows[2]]).first)
    XCTAssertEqual(singleCategory.text, MemohStrings.text("Ran commands"))
    XCTAssertEqual(singleCategory.symbolName, "terminal")
    XCTAssertEqual(group.rows, rows, "三类上限只影响摘要，不能截掉原始工具")
  }

  func testActivitySpinnerReflectsAnyMemberWithoutChangingWording() throws {
    let blocks = #"[{"key":"a","kind":"tool","name":"exec","status":"done"},{"key":"b","kind":"tool","name":"exec","status":"running"}]"#
    let running = try XCTUnwrap(Self.toolGroups(TranscriptRow.decode(Self.transcript(blocks))).first)
    XCTAssertTrue(running.showsSpinner)
    for status in ["done", "failed", "unknown"] {
      let stopped = try XCTUnwrap(Self.toolGroups(TranscriptRow.decode(Self.transcript(
        blocks.replacingOccurrences(of: "running", with: status)))).first)
      XCTAssertFalse(stopped.showsSpinner)
      XCTAssertEqual(stopped.text, running.text)
      XCTAssertEqual(stopped.symbolName, running.symbolName)
      XCTAssertEqual(stopped.foreground, running.foreground)
      XCTAssertEqual(stopped.first.id, running.first.id)
      XCTAssertNotEqual(stopped, running, "非首个工具状态变更必须触发 diffable reconfigure")
    }
  }

  func testActivityErrorsRemainNeutralAndPreserveOriginalDetails() throws {
    let rows = try TranscriptRow.decode(Self.transcript(Self.chatToolsBlocks))
    let group = try XCTUnwrap(Self.toolGroups(rows).first)
    XCTAssertTrue(ToolResultDiagnosis.read(rows[2].block.output).isError)
    XCTAssertEqual(group.text, ["Ran commands", "Edited files"].map { MemohStrings.text($0) }
      .joined(separator: MemohStrings.text(", ")))
    XCTAssertEqual(group.foreground, .secondary)
    XCTAssertTrue(group.showsSpinner)
    XCTAssertEqual(group.accessibilityDescriptions.count, 3)
    for (description, name) in zip(group.accessibilityDescriptions, ["exec", "fs_write", "exec"]) {
      XCTAssertTrue(description.hasPrefix(name))
    }
    XCTAssertTrue(group.accessibilityDescriptions[2].contains("Module not found"))
    for output in [#"{"isError":false}"#, #"{"structuredContent":{"isError":true}}"#] {
      let updated = try TranscriptRow.decode(Self.transcript(
        #"[{"key":"m12","kind":"tool","name":"exec","status":"done","output":\#(output)}]"#))
      let changed = try XCTUnwrap(Self.toolGroups([rows[0], rows[1], updated[0]]).first)
      XCTAssertEqual(changed.text, group.text)
      XCTAssertEqual(changed.foreground, group.foreground)
      XCTAssertEqual(changed.symbolName, group.symbolName)
      XCTAssertNotEqual(changed, group, "仅 output 变更也必须保留并刷新")
    }
  }

  func testAppendingToolsRetainsIdentityAndOriginalInputUpdates() throws {
    let rows = try TranscriptRow.decode(Self.transcript(Self.chatToolsBlocks))
    let one = try XCTUnwrap(TranscriptDisplayRow.grouped([rows[0]]).first)
    let all = try XCTUnwrap(TranscriptDisplayRow.grouped(rows).first)
    XCTAssertEqual(one.id, all.id)
    XCTAssertNotEqual(one, all)
    let changedRows = try TranscriptRow.decode(Self.transcript(
      Self.chatToolsBlocks.replacingOccurrences(of: "npm run build", with: "npm test")))
    let changed = try XCTUnwrap(TranscriptDisplayRow.grouped(changedRows).first)
    XCTAssertEqual(changed.id, all.id)
    XCTAssertNotEqual(changed, all)
  }

  static func transcript(_ blocks: String, turn: String = "turn", message: String = "message") -> String {
    """
    [{"key":"\(turn)","position":0,"active":false,
      "assistant":{"key":"\(message)","role":"assistant","blocks":\(blocks)}}]
    """
  }

  func testToolStateMapping() throws {
    let expected: [(String?, ToolState, String, String)] = [
      ("running", .running, "Running", "hourglass"),
      ("done", .done, "Done", "checkmark.circle.fill"),
      ("failed", .failed, "Failed", "exclamationmark.triangle.fill"),
      ("unknown", .unknown, "Unknown", "questionmark.circle"),
      ("future-state", .unknown, "Unknown", "questionmark.circle"),
      (nil, .unknown, "Unknown", "questionmark.circle"),
    ]
    for (status, state, title, symbol) in expected {
      let field = status.map { #", "status":"\#($0)""# } ?? ""
      let row = try XCTUnwrap(TranscriptRow.decode(Self.transcript(
        #"[{"key":"tool","kind":"tool"\#(field)}]"#)).first)
      XCTAssertEqual(row.block.toolState, state)
      XCTAssertEqual(row.block.toolState.titleKey, title)
      XCTAssertEqual(row.block.toolState.symbolName, symbol)
    }
    XCTAssertEqual(Set(ToolState.allCases.map(\.symbolName)).count, 4)
  }

  /**
   层级不是靠感觉，靠可以断言的规则。这是**实测踩出来的**
   （`verification/ui/tools/measure_surfaces.py` 量的真实截图），不是审美偏好。

   这里只断言**政策**：两种表面必须是不同的东西。它们各自映射到什么颜色是 UI 层
   的事，由 UIKit 宿主测试 `testActivitySurfaceDiffersFromUserBubble` 保证——
   那个断言需要 UIKit，所以放在另一半。
   */
  func testHierarchySeparatesUserBubblesFromAgentActivity() {
    XCTAssertNotEqual(MessageListMetrics.userSurface, MessageListMetrics.activitySurface,
                      "用户气泡与 agent 活动卡片必须是不同的表面，否则屏幕上没有层级")
  }

  /**
   工具诊断：从 output 内部读，与上游 `tool-result-error.ts` 同一套判据。

   为什么必须从 output 读：协议里工具块**只有 `running: Bool`**，没有 is_error /
   status 字段（`internal/agent/view/uimessage.go:58`）。"这个工具出错了"在传输层
   不存在，只有输出内容里才有线索。
   */
  func testToolResultDiagnosisReadsUpstreamShape() throws {
    let block = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"tool","kind":"tool","name":"exec","status":"done","output":{"isError":true,"content":[{"type":"text","text":"Module not found"}]}}]"#)).first)
    let diagnosis = ToolResultDiagnosis.read(block.block.output)
    XCTAssertTrue(diagnosis.isError)
    XCTAssertEqual(diagnosis.text, "Module not found")

    // structuredContent 包一层也要能读到（上游也认这种）。
    let nested = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"tool","kind":"tool","output":{"structuredContent":{"isError":true,"content":[{"type":"text","text":"ENOENT"}]}}}]"#)).first)
    XCTAssertEqual(ToolResultDiagnosis.read(nested.block.output).text, "ENOENT")

    // 正常输出：不是错误，不该冒出诊断文字。
    let ok = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"tool","kind":"tool","output":{"content":[{"type":"text","text":"ok"}]}}]"#)).first)
    let okDiagnosis = ToolResultDiagnosis.read(ok.block.output)
    XCTAssertFalse(okDiagnosis.isError)

    // 没有 output（还在跑、或服务端没给）：什么都不猜。
    let none = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"tool","kind":"tool","running":true}]"#)).first)
    XCTAssertEqual(ToolResultDiagnosis.read(none.block.output), .none)
    XCTAssertEqual(ToolResultDiagnosis.read(nil), .none)

    // **非零退出码不算失败**——上游只用它显示退出码。这条最容易写反。
    let exitCode = try XCTUnwrap(TranscriptRow.decode(MessageListLogicTests.transcript(
      #"[{"key":"tool","kind":"tool","output":{"exit_code":1,"stdout":"compiling..."}}]"#)).first)
    XCTAssertFalse(ToolResultDiagnosis.read(exitCode.block.output).isError,
                   "exit_code != 0 不等于工具失败：agent 试错是正常干活过程")
  }

  /**
   状态词只在需要说明的时候出现。
   
   曾出现"卡片写 Done、下一行红字说 Module not found"，两轮视觉评审都判为矛盾。
   根因是我们给"完成"也贴了标签——而完成是常态，全部工具都会完成。
   */
  func testToolStatusLabelOnlyWhenItExplainsSomething() {
    XCTAssertTrue(MessageListMetrics.showsToolStatus(.running), "用户正等着，必须说明在跑")
    XCTAssertTrue(MessageListMetrics.showsToolStatus(.failed), "服务端明确说这条出错了")
    XCTAssertFalse(MessageListMetrics.showsToolStatus(.done), "完成是常态，对勾足够")
    XCTAssertFalse(MessageListMetrics.showsToolStatus(.unknown), "不知道就不多说一句")

    // 只有 running 才把执行位置带上（那时它依附于一个存在的状态词）。
    XCTAssertEqual(MessageListMetrics.toolStatusText(state: .running), "Running")
    XCTAssertEqual(MessageListMetrics.toolStatusText(state: .failed), "Failed")
    XCTAssertNil(MessageListMetrics.toolStatusText(state: .done), "完成态不贴状态词")
    XCTAssertNil(MessageListMetrics.toolStatusText(state: .unknown))

    // 图标同理：只有需要用户注意的两种状态才配一个图标。
    // 完成态没有图标——三份视觉评审都把"灰色对勾 + 红色报错"读成矛盾。
    XCTAssertTrue(MessageListMetrics.showsToolIcon(.failed), "服务端说这条出错了，要一个警告图标")
    // running **不给静态图标**：那个状态已经由 spinner 表达，再来一个图标就是
    // 两个东西说同一句话（视觉评审："spinner 旁边还挂了一个沙漏，语义重复"）。
    XCTAssertFalse(MessageListMetrics.showsToolIcon(.running),
                   "进行中由 spinner 表达，不要再叠一个静态图标")
    XCTAssertFalse(MessageListMetrics.showsToolIcon(.done), "对勾在断言「成功了」，而上游说不能这样推导")
    XCTAssertFalse(MessageListMetrics.showsToolIcon(.unknown))
  }

  /**
   工具组能不能展开——**这条判据原来只在 hosted（`#if canImport(UIKit)`）里验**。

   `expandable` 是 `ToolActivityGroup` 的**纯策略**（`Chat/Transcript.swift`，Foundation-only）：
   运行中一律不可展开（参数还在流，展开内容会跳），完成之后只有服务端真给了 input 条目 /
   error / 诊断正文才算"有详情"（不伪造）。住在 UIKit 段的那些断言验的是 disclosure 控件，
   而这条策略本身不需要 UIKit ⇒ 搬到这里，`pnpm test:swift` 在 Linux 容器里就能跑
   （2026-09-18 自查"本机能验 vs 需 Xcode"时发现）。
   */
  func testToolGroupExpandabilityFollowsThePolicy() throws {
    func group(_ blocks: String) throws -> ToolActivityGroup {
      let rows = try TranscriptRow.decode(Self.transcript(blocks))
      return try XCTUnwrap(Self.toolGroups(rows).first)
    }

    // 运行中：**即使已经有 input 也不可展开**——参数可能还在流。
    let running = try group(
      #"[{"key":"m1","kind":"tool","name":"exec","title":"pytest -q","status":"running","input":{"command":"pytest -q"}}]"#)
    XCTAssertTrue(running.showsSpinner)
    XCTAssertFalse(running.expandable, "运行中不可展开：参数还在流，展开内容会跳")

    // 完成 + 有 input 条目 ⇒ 可展开。
    let withInput = try group(
      #"[{"key":"m1","kind":"tool","name":"exec","title":"pytest -q","status":"done","input":{"command":"pytest -q"},"output":"ok"}]"#)
    XCTAssertTrue(withInput.expandable)

    // 完成 + 什么详情都没有 ⇒ **不伪造**（上游"有 detail 组件才算 expandable"那一档）。
    let bare = try group(#"[{"key":"m1","kind":"tool","name":"exec","title":"pytest -q","status":"done"}]"#)
    XCTAssertFalse(bare.expandable, "没有 input / error / 诊断正文时不假装有详情")

    // 失败 + error ⇒ 也算详情（isError 那一档）。
    let failed = try group(
      #"[{"key":"m1","kind":"tool","name":"exec","title":"pytest -q","status":"failed","error":"boom"}]"#)
    XCTAssertTrue(failed.expandable)

    // 完成 + output 里带诊断正文 ⇒ 同样算详情（`ToolResultDiagnosis.read` 那条路）。
    let diagnosed = try group(
      #"[{"key":"m1","kind":"tool","name":"exec","title":"npm run build","status":"done","input":{"command":"npm run build"},"output":{"isError":true,"content":[{"type":"text","text":"Module not found"}]}}]"#)
    XCTAssertTrue(diagnosed.expandable)
  }

  /** 工具标题的显示规则：同一句话不该在卡片上出现两次。 */
  func testToolTitleVisibility() {
    // 标题 === 入参里的命令 → 不显示。
    XCTAssertFalse(MessageListMetrics.showsToolTitle(
      title: "pytest -q", name: "exec", inputPreview: "command: pytest -q"))
    XCTAssertFalse(MessageListMetrics.showsToolTitle(
      title: "RM -RF /tmp", name: "exec", inputPreview: "command: rm -rf /tmp"),
      "重复判定应当忽略大小写")
    // 标题就是工具名 → 不显示（上面已经有了）。
    XCTAssertFalse(MessageListMetrics.showsToolTitle(
      title: "exec", name: "exec", inputPreview: nil))
    // 没有标题 → 不显示。
    XCTAssertFalse(MessageListMetrics.showsToolTitle(title: nil, name: "exec", inputPreview: "command: ls"))
    XCTAssertFalse(MessageListMetrics.showsToolTitle(title: "", name: "exec", inputPreview: "command: ls"))
    // 标题是摘要、入参是具体命令 → 显示（它补充了信息）。
    XCTAssertTrue(MessageListMetrics.showsToolTitle(
      title: "Running the test suite", name: "exec", inputPreview: "command: pytest -q"))
    // **没有入参时标题是唯一的信息来源，必须显示**——这是最容易写反的一条。
    XCTAssertTrue(MessageListMetrics.showsToolTitle(
      title: "pytest -q", name: "exec", inputPreview: nil))
  }

  func testToolInputShapesAndInputOnlyUpdates() throws {
    let inputs = [
      #"{"command":"pytest -q tests/reports","cwd":"/data","flags":[true,2,null]}"#,
      #""echo hello""#, #"["one",false,3]"#, "42", "false", "{}", "[]", "null",
    ]
    for input in inputs {
      let row = try XCTUnwrap(TranscriptRow.decode(Self.transcript(
        #"[{"key":"tool","kind":"tool","input":\#(input)}]"#)).first)
      if input == "null" { XCTAssertNil(row.block.input) }
      else { XCTAssertFalse(try XCTUnwrap(row.block.input).preview.isEmpty) }
    }
    let first = try XCTUnwrap(TranscriptRow.decode(Self.transcript(
      #"[{"key":"tool","kind":"tool","input":{"command":"pwd"}}]"#)).first)
    let second = try XCTUnwrap(TranscriptRow.decode(Self.transcript(
      #"[{"key":"tool","kind":"tool","input":{"command":"ls"}}]"#)).first)
    XCTAssertEqual(first.id, second.id)
    XCTAssertNotEqual(first, second)
    XCTAssertTrue(try XCTUnwrap(first.block.input).preview.contains("pwd"))
    XCTAssertEqual(ToolInput.string("echo hello").preview, "echo hello")
    let long = ToolInput.string(String(repeating: "界", count: 900)).preview
    XCTAssertEqual(long.count, MessageListMetrics.inputCharacterLimit + 1)
    XCTAssertTrue(long.hasSuffix("…"))
    XCTAssertEqual(ToolInput.object(["z": .bool(true), "a": .number(1)]).preview,
                   ToolInput.object(["a": .number(1), "z": .bool(true)]).preview)
  }

  func testReasoningStateSurvivesStreamingAndUsesFullIdentity() throws {
    let blocks = #"[{"key":"thought","kind":"reasoning","text":"First","streaming":true}]"#
    let first = try XCTUnwrap(TranscriptRow.decode(Self.transcript(blocks)).first)
    let grown = try XCTUnwrap(TranscriptRow.decode(Self.transcript(
      blocks.replacingOccurrences(of: "First", with: "First and more"))).first)
    let other = try XCTUnwrap(TranscriptRow.decode(Self.transcript(blocks, turn: "other")).first)
    var state = ReasoningExpansionState()
    XCTAssertFalse(state.isExpanded(first.id))
    state.toggle(first.id)
    XCTAssertTrue(state.isExpanded(grown.id))
    XCTAssertFalse(state.isExpanded(other.id))
    state.retain([grown.id, other.id])
    XCTAssertTrue(state.isExpanded(first.id))
    state.toggle(first.id)
    XCTAssertFalse(state.isExpanded(first.id))
    state.toggle(first.id)
    state.retain([other.id])
    XCTAssertFalse(state.isExpanded(first.id))
    state.toggle(other.id)
    state.retain([])
    XCTAssertFalse(state.isExpanded(other.id))
  }

  func testAttachmentsCountTypesAndSizes() throws {
    let row = try XCTUnwrap(TranscriptRow.decode(Self.transcript(
      #"[{"key":"files","kind":"attachments","items":[{"key":"a","name":"chart.png","mime":"image/png","size":240000,"isImage":true},{"key":"b","name":"notes.txt","size":0,"isImage":false},{"key":"c","name":"clip.mp4","mime":"video/mp4","isImage":false}]}]"#)).first)
    let items = try XCTUnwrap(row.block.items)
    XCTAssertEqual(items.count, 3)
    XCTAssertEqual(items.map(\.name), ["chart.png", "notes.txt", "clip.mp4"])
    XCTAssertEqual(items.map(\.symbolName), ["photo", "doc", "film"])
    XCTAssertNotNil(items[0].formattedSize)
    XCTAssertNotNil(items[1].formattedSize)
    XCTAssertNil(items[2].formattedSize)
    let empty = try XCTUnwrap(TranscriptRow.decode(Self.transcript(
      #"[{"key":"files","kind":"attachments","items":[]}]"#)).first)
    XCTAssertEqual(empty.block.items?.count, 0)
    for size in [-1.0, Double.infinity, Double.nan, Double(Int64.max)] {
      let item = TranscriptBlock.Attachment(key: "bad", name: "bad", mime: nil, url: nil, size: size, isImage: false)
      XCTAssertNil(item.formattedSize)
    }
  }

  func testErrorCodeAndNoticeRemainDistinct() throws {
    let rows = try TranscriptRow.decode(Self.transcript(
      #"[{"key":"e","kind":"error","text":"Read only","code":"fs.readonly"},{"key":"n","kind":"notice","text":"Restored"}]"#))
    XCTAssertEqual(rows[0].block.kind, .error)
    XCTAssertEqual(rows[0].block.code, "fs.readonly")
    XCTAssertEqual(rows[1].block.kind, .notice)
    XCTAssertNil(rows[1].block.code)
  }

  /**
   错误块的判据（`docs/research/ios-error-and-feedback.md` §10，规则 R44–R47）。
   
   这一条跑在**没有 UIKit** 的地方（`pnpm test:swift`，Linux），所以它钉的是"说什么 /
   给不给动作"这件事本身，与 cell 怎么摆无关。
   */
  func testErrorBlockJudgesTitleReasonDetailAndRetry() {
    // 标题永远是**我们自己的话**：HIG 点名的反例 `"Error"` 不许出现（R15/R44）。
    let refused = ErrorBlockPresentation.read(
      code: "compaction.model_unavailable",
      text: "This deployment has no compaction model.")
    XCTAssertEqual(refused.title, MemohStrings.text("This step failed"))
    XCTAssertNotEqual(refused.title, "Error")
    // 类型化 code + 非空 message → 服务端原文当**补充说明**（R24/R26）。
    XCTAssertEqual(refused.reason, "This deployment has no compaction model.")
    XCTAssertEqual(refused.detail, "compaction.model_unavailable")
    // "这件事现在做不了"（要用户去配模型）：给原因，**不给**重试（R19/R20/R45）。
    XCTAssertEqual(refused.recovery, .none)
    XCTAssertFalse(refused.showsAction)

    // 传输层那一档（超时 / 429 / 网络 / 网关）才配重试。
    for code in ["agent.response_timeout", "agent.response_interrupted",
                 "queue_admission_overloaded", "channel.runtime_unavailable",
                 "workspace.unreachable", "acp.operation_failed"] {
      XCTAssertTrue(ErrorBlockPresentation.read(code: code, text: "…").showsAction, code)
    }

    // 白名单**之外**的类型化 5xx 一样不给动作：服务端已经说了为什么，再发一次还是被拒。
    for code in ["session_runtime.invocation_conflict", "context.protected_overflow",
                 "tool_approval.forbidden", "bot_agent.not_found"] {
      XCTAssertFalse(ErrorBlockPresentation.read(code: code, text: "…").showsAction, code)
    }

    // 没有 code：服务端给开发者看的原文**一个字都不上屏**，改用我们的兜底句（R23/R25）。
    let untyped = ErrorBlockPresentation.read(code: nil,
                                             text: #"pq: relation "users" does not exist"#)
    XCTAssertEqual(untyped.reason, MemohStrings.text("The server didn't say why"))
    XCTAssertFalse(untyped.reason.contains("pq:"))
    XCTAssertNil(untyped.detail)
    // 认不出种类时才给动作（§3.1 的"无 code"一档）。
    XCTAssertTrue(untyped.showsAction)

    // 空白 code 与 nil 是同一件事；code 在但 message 空 → 同样走兜底句。
    XCTAssertNil(ErrorBlockPresentation.read(code: "   ", text: "boom").detail)
    XCTAssertEqual(ErrorBlockPresentation.read(code: "agent.response_timeout", text: " \n ").reason,
                   MemohStrings.text("The server didn't say why"))
    // code 去掉首尾空白后**原样**保留（不改成小写、不加前缀）。
    XCTAssertEqual(ErrorBlockPresentation.read(code: " fs.readonly ", text: "x").detail, "fs.readonly")
  }

  func testErrorExpansionStateFollowsTheBlockNotTheRowIdentity() throws {
    let error = try XCTUnwrap(TranscriptRow.decode(
      Self.transcript(#"[{"key":"e","kind":"error","text":"boom","code":"fs.readonly"}]"#)).first)
    let text = try XCTUnwrap(TranscriptRow.decode(
      Self.transcript(#"[{"key":"t","kind":"text","text":"hi"}]"#)).first)
    var state = ErrorExpansionState()
    // 默认**收起**（R47）。
    XCTAssertFalse(state.isExpanded(error.id))
    state.toggle(error.id)
    XCTAssertTrue(state.isExpanded(error.id))
    // 只有错误块受它管：别的块调不动它。
    state.toggle(text.id)
    XCTAssertFalse(state.isExpanded(text.id))
    // 同一个块、但**行身份变了**（REST 历史与实时投影的 turn/message 可能不同）时，
    // 展开状态必须跟着块走——否则用户刚点开的细节会在一次刷新后自己合上。
    let sameBlockOtherIdentity = TranscriptRow.ID(
      turn: "another-turn", message: "another-message", role: error.id.role,
      block: error.id.block, kind: .error)
    XCTAssertTrue(state.isExpanded(sameBlockOtherIdentity))
    // 它**不**按当前行集合收敛（没有 `retain`）：实测那份集合会短暂缺块，收敛就会把
    // 用户点开的细节抹掉。所以这里只验"再点一次才收起"。
    state.toggle(sameBlockOtherIdentity)
    XCTAssertFalse(state.isExpanded(error.id))
  }

  func testLayoutPolicyAndScrollClamping() {
    XCTAssertEqual(MessageListMetrics.reasoningLineLimit(expanded: false), 3)
    XCTAssertEqual(MessageListMetrics.reasoningLineLimit(expanded: true), 0)
    XCTAssertEqual(MessageListMetrics.inputLineLimit, 5)
    XCTAssertEqual(MessageListMetrics.blockSpacing, 16)
    XCTAssertEqual(MessageListMetrics.userWidthFraction(accessibilitySize: false), 0.78)
    XCTAssertEqual(MessageListMetrics.userWidthFraction(accessibilitySize: true), 0.94)
    XCTAssertEqual(MessageListMetrics.bottomOffset(contentHeight: 100, viewportHeight: 800, topInset: 20, bottomInset: 34), -20)
    XCTAssertEqual(MessageListMetrics.bottomOffset(contentHeight: 1000, viewportHeight: 800, topInset: 20, bottomInset: 34), 234)
    // A history prepend of 200 keeps the same row at the same on-screen distance.
    XCTAssertEqual(MessageListMetrics.anchoredOffset(itemTop: 600, distance: 100, topInset: 20, bottomOffset: 1000), 500)
    XCTAssertEqual(MessageListMetrics.anchoredOffset(itemTop: 800, distance: 100, topInset: 20, bottomOffset: 1000), 700)
    XCTAssertEqual(MessageListMetrics.anchoredOffset(itemTop: 0, distance: 100, topInset: 20, bottomOffset: 1000), -20)
    XCTAssertEqual(MessageListMetrics.anchoredOffset(itemTop: 1200, distance: 0, topInset: 20, bottomOffset: 1000), 1000)
    XCTAssertFalse(MessageListMetrics.isNearBottom(offset: 975, bottomOffset: 1000))
    XCTAssertTrue(MessageListMetrics.isNearBottom(offset: 976, bottomOffset: 1000))
    XCTAssertTrue(MessageListMetrics.isNearBottom(offset: 1020, bottomOffset: 1000))
    XCTAssertTrue(MessageListMetrics.canRestoreAnchor(capturedRevision: 1, currentRevision: 1, isInteracting: false))
    XCTAssertFalse(MessageListMetrics.canRestoreAnchor(capturedRevision: 1, currentRevision: 2, isInteracting: false))
    XCTAssertFalse(MessageListMetrics.canRestoreAnchor(capturedRevision: 1, currentRevision: 1, isInteracting: true))
    XCTAssertFalse(MessageListMetrics.canRestoreAnchor(capturedRevision: 1, currentRevision: 2, isInteracting: true))
  }

  /**
   内容指纹（`TranscriptPayload` / `TranscriptDiff`）：主线程从"逐行深比较 JSON 树"
   降到"比 Int"，这一条钉住**降级之后语义没变**。

   两件事各测一面：
   1. 指纹**认得出每一处内容变化**（正文、状态、嵌套入参、输出、附件、工具组里的成员）
      ——漏了哪一处，界面就会"该刷新时不刷新"；
   2. 变更集合的口径与改前的深比较逐字一致：同一个 id 首次出现不算 changed（它走 insert），
      内容一样就不 reconfigure，展开状态变更必须 reconfigure。
   */
  func testContentHashWitnessesEveryContentChange() throws {
    let base = try TranscriptPayload.decode(Self.transcript(
      #"[{"key":"m1","kind":"tool","name":"exec","title":"pytest","status":"running","input":{"command":"pytest -q","nested":{"a":[1,2]}},"output":{"isError":false},"items":[{"key":"a","name":"a.png","size":10,"isImage":true}]}]"#))
    let same = try TranscriptPayload.decode(Self.transcript(
      #"[{"key":"m1","kind":"tool","name":"exec","title":"pytest","status":"running","input":{"command":"pytest -q","nested":{"a":[1,2]}},"output":{"isError":false},"items":[{"key":"a","name":"a.png","size":10,"isImage":true}]}]"#))
    let id = try XCTUnwrap(base.rows.first?.id)
    XCTAssertEqual(base.hashes[id], same.hashes[id], "逐字相同的载荷必须得到同一个指纹")
    XCTAssertEqual(base.rows, same.rows)

    // 每一处内容变化都要被指纹看见。改的是**同一个字段的旧值与新值**，不是别的字段。
    let variants: [(String, String)] = [
      ("正文", #""status":"running""# + #","text":"A""#),
      ("状态", #""status":"done""#),
      ("标题", #""status":"running","title":"npm""#),
      ("嵌套入参", #""status":"running","input":{"nested":{"a":[1,3]}}"#),
      ("标量入参", #""status":"running","input":{"command":"pytest -x"}"#),
      ("输出", #""status":"running","output":{"isError":true}"#),
      ("附件", #""status":"running","items":[{"key":"a","name":"a.png","size":11,"isImage":true}]"#),
      ("工具名", #""status":"running","name":"fs_read""#),
      ("位置", #""status":"running","location":"workspace""#),
      ("错误码", #""status":"running","code":"agent.response_timeout""#),
      ("思考/正文标记", #""status":"running","streaming":true"#),
      ("时长", #""status":"running","durationMs":1200"#),
    ]
    for (label, replacement) in variants {
      let changed = try TranscriptPayload.decode(Self.transcript(
        ##"[{"key":"m1","kind":"tool","name":"exec","title":"pytest","## + replacement + "}]"))
      XCTAssertNotEqual(base.hashes[id], changed.hashes[id], "\(label) 变了但指纹没变")
      XCTAssertNotEqual(base.rows, changed.rows, "\(label) 变了但相等判断说没变")
    }

    // 工具组：多一个成员、或成员状态变了，组这一行的指纹必须变（组是原生合并出来的行）。
    let one = try TranscriptPayload.decode(Self.transcript(
      #"[{"key":"t1","kind":"tool","name":"exec"},{"key":"t2","kind":"tool","name":"fs_read"}]"#))
    let two = try TranscriptPayload.decode(Self.transcript(
      #"[{"key":"t1","kind":"tool","name":"exec"},{"key":"t2","kind":"tool","name":"fs_read"},{"key":"t3","kind":"tool","name":"fs_write"}]"#))
    let groupId = try XCTUnwrap(one.rows.first?.id)
    XCTAssertEqual(one.rows.count, 1, "连续工具必须合成一行")
    XCTAssertNotEqual(one.hashes[groupId], two.hashes[groupId], "组里多了一个成员，指纹必须变")
  }

  func testChangedSetKeepsTheOldDeepCompareSemantics() throws {
    let json = Self.transcript(#"[{"key":"m1","kind":"text","text":"第一句"},{"key":"m2","kind":"text","text":"第二句"}]"#)
    let first = try TranscriptPayload.decode(json)
    let ids = first.rows.map(\.id)

    // 首次出现：走 insert，不是 reconfigure（改前的前提条件就是 `rows[$0] != nil`）。
    XCTAssertEqual(TranscriptDiff.changedIDs(ids: ids, previous: [:], next: first.hashes), [])

    // 逐字相同的第二份载荷（对象是新的）：改前靠深比较说"没变"，现在靠指纹。
    let second = try TranscriptPayload.decode(json)
    XCTAssertEqual(TranscriptDiff.changedIDs(ids: ids, previous: first.hashes, next: second.hashes), [])

    // 只有第二行变了：只有它进 changed。
    let updated = try TranscriptPayload.decode(
      Self.transcript(#"[{"key":"m1","kind":"text","text":"第一句"},{"key":"m2","kind":"text","text":"第二句改"}]"#))
    XCTAssertEqual(TranscriptDiff.changedIDs(ids: ids, previous: first.hashes, next: updated.hashes),
                   [ids[1]])

    // 展开状态变更：内容一模一样也要 reconfigure。
    XCTAssertEqual(TranscriptDiff.changedIDs(ids: ids, previous: first.hashes, next: second.hashes,
                                             expansionUpdates: [ids[0]]), [ids[0]])

    // 少了一行（末行被移除）：剩下的行不算 changed。
    let shorter = try TranscriptPayload.decode(Self.transcript(#"[{"key":"m1","kind":"text","text":"第一句"}]"#))
    XCTAssertEqual(TranscriptDiff.changedIDs(ids: [ids[0]], previous: first.hashes,
                                             next: shorter.hashes), [])
  }

  // MARK: - Markdown（渲染管线）

  /// 一份"什么都写到了"的样例：标题 / 段落 / 列表 / 引用 / 围栏代码 / 链接 / 分隔线 / 粗斜删。
  static let markdownSample = """
  # A History of the Internet

  The **internet** began as a *research* project, `ARPA` paid for it.

  ## Precursors and the Problem of Time-Sharing

  - Batch processing wasted time
  - Time-sharing solved it

  > Nobody predicted the web.

  ```python
  print("hello")
  ```

  See [RFC 1](https://example.com/rfc1) and ~~obsolete~~ notes.
  """

  /**
   用户看得见的文本里**绝不允许**出现 Markdown 语法符号。

   这是"流式中间态不闪原始符号"那条硬要求，断言方式是**对每一个前缀**都成立：模型一个
   字符一个字符地写，中间态就是这些前缀。查的是 `renderedText`——渲染层真正送上屏的
   那些 span，而不是中间数据结构。
   */
  func testStreamingPrefixesNeverShowRawMarkdown() {
    let characters = Array(Self.markdownSample)
    for length in 0...characters.count {
      let prefix = String(characters[0..<length])
      let document = MarkdownDocument.parse(prefix, tolerantLastLine: true)
      let rendered = document.renderedText
      for marker in ["**", "~~", "`", "#"] {
        XCTAssertFalse(rendered.contains(marker),
                       "第 \(length) 个字符处露出了 \(marker)：\(rendered.debugDescription)")
      }
      for line in rendered.split(separator: "\n", omittingEmptySubsequences: false) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        XCTAssertFalse(trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("> "),
                       "第 \(length) 个字符处露出了块级标记：\(rendered.debugDescription)")
      }
    }
  }

  /**
   流式结束后**不再容忍**：没配对的定界符按字面画。

   为什么这条不能省：容忍是为了"别在最需要读的时候闪符号"，但如果连终态都吞，
   用户就永远看不到模型真的写了 `**`。容忍的范围必须能被说清楚——
   只在最后一行、只在这条消息还在流的时候。
   */
  func testFinishedMessagesKeepUnpairedDelimitersLiteral() {
    let streaming = MarkdownDocument.parse("A **bold start", tolerantLastLine: true)
    XCTAssertEqual(streaming.renderedText, "A bold start")
    XCTAssertTrue(streaming.blocks.first?.spans.contains { $0.style.contains(.bold) } == true)

    let finished = MarkdownDocument.parse("A **bold start", tolerantLastLine: false)
    XCTAssertEqual(finished.renderedText, "A **bold start")
    XCTAssertEqual(finished.blocks.first?.spans.count, 1)
  }

  /**
   增量：追加一个字符**不许**重解析整条消息。
   */
  func testIncrementalParsingOnlyReparsesTheTail() throws {
    let characters = Array(Self.markdownSample)
    var document = MarkdownDocument.parse("")
    var worst = 0
    var worstLength = 0
    var total = 0
    for length in 0...characters.count {
      let prefix = String(characters[0..<length])
      document = document.updated(with: prefix, tolerantLastLine: true)
      total += document.parsedCharacters
      if document.parsedCharacters > worst {
        worst = document.parsedCharacters
        worstLength = length
      }
      // 增量与全量必须**得到同一棵树**：省下来的不能是正确性。
      XCTAssertEqual(document.blocks, MarkdownDocument.parse(prefix, tolerantLastLine: true).blocks)
    }
    // 全量重解析一遍的总量是 O(n²/2)≈13 万字符；增量只重解析最后一个块。
    XCTAssertLessThan(worst, 200, "最坏一次重解析了 \(worst) 个字符（发生在第 \(worstLength) 个字符处）")
    XCTAssertLessThan(total, characters.count * 80, "总共重解析了 \(total) 个字符")
    // 尾部之外的所有块都被复用：复用的判据是"前面那些块一个字都没重读"。
    XCTAssertGreaterThan(document.reusedBlocks, document.blocks.count - 2)
    XCTAssertGreaterThanOrEqual(document.blocks.count, 8)
  }

  /**
   支持清单（做没做，一条一条钉住）。**没做的部分**见 `docs/CHAT-RENDERING.md`：
   表格不做布局、按等宽块兜底。
   */
  func testMarkdownBlocksCoverTheSupportedSet() {
    let document = MarkdownDocument.parse(Self.markdownSample)
    let kinds = document.blocks.map(\.kind)
    XCTAssertTrue(kinds.contains(.heading(level: 1)))
    XCTAssertTrue(kinds.contains(.heading(level: 2)))
    XCTAssertTrue(kinds.contains(.paragraph))
    XCTAssertEqual(kinds.filter { $0 == .bullet(depth: 0) }.count, 2)
    XCTAssertTrue(kinds.contains(.quote(depth: 0)))
    XCTAssertTrue(kinds.contains(.code(language: "python")))
    XCTAssertFalse(kinds.contains(.rule), "样例里没有分隔线，这条断言的是不误判")

    // 行内：粗体 / 斜体 / 行内代码 / 删除线 / 链接（含裸 URL）。
    let styles = document.blocks.flatMap(\.spans).map(\.style)
    XCTAssertTrue(styles.contains(.bold))
    XCTAssertTrue(styles.contains(.italic))
    XCTAssertTrue(styles.contains(.code))
    XCTAssertTrue(styles.contains(.strikethrough))
    XCTAssertTrue(styles.contains(.link))
    XCTAssertTrue(document.links.contains { $0.destination == "https://example.com/rfc1" })

    // 有序列表 / 分隔线 / 行内代码里的 `*` 不当强调。
    let ordered = MarkdownDocument.parse("1. first\n2. second")
    XCTAssertEqual(ordered.blocks.map(\.kind), [.ordered(index: 1, depth: 0), .ordered(index: 2, depth: 0)])
    let rule = MarkdownDocument.parse("a\n\n---\n\nb")
    XCTAssertTrue(rule.blocks.contains(.init(kind: .rule, spans: [], lines: [], lineRange: 2..<3)))
    let underscores = MarkdownDocument.parse("call snake_case_name and 2*3 here", tolerantLastLine: false)
    XCTAssertEqual(underscores.renderedText, "call snake_case_name and 2*3 here")
  }

  /// 表格：**不做布局**，按等宽块兜底（原样保留管道，列还是对齐的）。
  func testTablesFallBackToAMonospaceBlock() {
    let document = MarkdownDocument.parse("| Name | Year |\n| --- | --- |\n| ARPANET | 1969 |")
    XCTAssertEqual(document.blocks.count, 1)
    XCTAssertEqual(document.blocks.first?.kind, .table)
    XCTAssertEqual(document.blocks.first?.lines.count, 3)
    XCTAssertEqual(document.renderedText, "| Name | Year |\n| --- | --- |\n| ARPANET | 1969 |")
    // 半截的表格行（还没有第二根管子）不该先闪出来。
    XCTAssertEqual(MarkdownDocument.parse("| Name", tolerantLastLine: true).renderedText, "")
  }

  /**
   复制出来的是**渲染后的纯文本**：能读的话，不是带 `**` 的源码。
   */
  func testPlainTextIsWhatTheReaderCopies() {
    let document = MarkdownDocument.parse(Self.markdownSample)
    let copied = document.plainText
    XCTAssertTrue(copied.contains("A History of the Internet"))
    XCTAssertTrue(copied.contains("• Batch processing wasted time"))
    XCTAssertTrue(copied.contains("> Nobody predicted the web."))
    XCTAssertTrue(copied.contains("print(\"hello\")"))
    XCTAssertTrue(copied.contains("---") == false)
    for marker in ["**", "~~", "#", "`"] {
      XCTAssertFalse(copied.contains(marker), "复制文本里不该有 \(marker)")
    }
    XCTAssertFalse(copied.contains("https://example.com/rfc1"))
    XCTAssertTrue(document.links.contains { $0.text == "RFC 1" })
  }

  /**
   读屏读出来是**句子**：不念 `#`、`•`、`|`、`---` 这些排版符号。
   */
  func testAccessibilityTextIsSentencesNotSymbols() {
    let spoken = MarkdownDocument.parse(Self.markdownSample).accessibilityText
    XCTAssertTrue(spoken.contains("A History of the Internet"))
    XCTAssertTrue(spoken.contains("Batch processing wasted time"))
    for marker in ["#", "•", "**", "`", "> ", "---"] {
      XCTAssertFalse(spoken.contains(marker), "读屏文本里不该有 \(marker)")
    }
    let rule = MarkdownDocument.parse("a\n\n---\n\nb")
    XCTAssertEqual(rule.accessibilityText, "a. b")
  }

  // MARK: - thinking 的各种形状

  /**
   三种形状一次说清：**没有 thinking**、**有 thinking 且流式**、**thinking 迟到**。

   判据只有一条：**没有内容的思考块不产生渲染行**（不空占位、不留空盒子）。有内容时
   才出现，并且位置按到达顺序（迟到的思考不插队）。
   */
  func testThinkingShapesDecideWhetherARowExists() throws {
    // 1) 没有 thinking 字段：模型只回正文 —— 一行思考都不该有。
    let plain = try TranscriptPayload.decode(Self.transcript(
      #"[{"key":"m1","kind":"text","text":"答案在这里"}]"#))
    XCTAssertEqual(plain.rows.count, 1)
    XCTAssertEqual(plain.rows.first?.first.block.kind, .text)

    // 2) 有 thinking 且流式：空帧（只有换行/空格）不该出现；有字才出现。
    let empty = try TranscriptPayload.decode(Self.transcript(
      #"[{"key":"m1","kind":"reasoning","text":"\n  ","streaming":true}]"#))
    XCTAssertTrue(empty.rows.isEmpty, "空的思考帧不该占一行")
    let streaming = try TranscriptPayload.decode(Self.transcript(
      #"[{"key":"m1","kind":"reasoning","text":"先看磁盘","streaming":true}]"#))
    XCTAssertEqual(streaming.rows.count, 1)
    XCTAssertEqual(streaming.rows.first?.first.block.kind, .reasoning)

    // 3) thinking 迟到：先只有正文，后补上思考 —— 出现，且按到达顺序排在正文之后。
    let textFirst = try TranscriptPayload.decode(Self.transcript(
      #"[{"key":"m1","kind":"text","text":"答案"},{"key":"m2","kind":"reasoning","text":"其实先想了这个"}]"#))
    XCTAssertEqual(textFirst.rows.map { $0.first.block.kind }, [.text, .reasoning])
    XCTAssertEqual(textFirst.rows.last?.first.block.text, "其实先想了这个")

    // provider 侧写法的共同点：都是"喂给我们的一个字段"，没有内容就是没有。
    for blank in ["", " ", "\\n", "\\t\\n ", "\\u00a0"] {
      let json = Self.transcript(#"[{"key":"m1","kind":"reasoning","text":"\#(blank)"}]"#)
      XCTAssertTrue(try TranscriptPayload.decode(json).rows.isEmpty,
                    "空白思考文本 \(blank.debugDescription) 不该产生行")
    }
  }

  /// 空白正文同样不占行（空块在任何角色下都没有可看之处）。
  func testBlankTextBlocksDoNotProduceRows() throws {
    let payload = try TranscriptPayload.decode(Self.transcript(
      #"[{"key":"m1","kind":"text","text":" \n "},{"key":"m2","kind":"tool","name":"exec"}]"#))
    XCTAssertEqual(payload.rows.map { $0.first.block.kind }, [.tool])
    XCTAssertTrue(TranscriptDisplayRow.shows(
      try XCTUnwrap(TranscriptRow.decode(Self.transcript(
        #"[{"key":"m1","kind":"reasoning","text":"\n\n"}]"#)).first)) == false)
  }

  // MARK: - 折叠思考的"思考了 N 秒"

  /**
   判据：**有可信时长才说，说到整秒；没有 / 不到 1 秒就一个字都不加**。

   时长来自服务端的 `reasoning_timing.duration_ms`（reducer 已经挂到 reasoning 块上）。
   这里钉的是"什么时候显示、显示成什么"，不是"画在哪"——所以它跑在构建机上。

   ⚠️ 断言里的英文是**本地化表的键**（Linux 上没有 bundle，`MemohStrings.text` 回退成
   键本身）。这不是"只测了英文"：中文那条值在 `zh-Hans.lproj/Localizable.strings` 里，
   真机上按系统语言取；这里要断的是"数字与单复数走的是哪两条 key"。
   */
  func testReasoningDurationLabelOnlyWhenKnown() throws {
    // 没有时长 / 不可信：不显示（"0 秒"读起来像我们没测到，比不说更糟）。
    for missing in [nil, 0, -5, 999] as [Double?] {
      XCTAssertNil(ReasoningDuration.label(milliseconds: missing),
                   "duration=\(String(describing: missing)) 不该显示时长")
    }
    XCTAssertNil(ReasoningDuration.label(milliseconds: Double.nan))
    XCTAssertNil(ReasoningDuration.label(milliseconds: Double.infinity))

    // 有：整秒（四舍五入），单数走单独一条 key。
    XCTAssertEqual(ReasoningDuration.label(milliseconds: 1000), "Thought for 1 second")
    XCTAssertEqual(ReasoningDuration.label(milliseconds: 3200), "Thought for 3 seconds")
    XCTAssertEqual(ReasoningDuration.label(milliseconds: 1500), "Thought for 2 seconds")
    XCTAssertEqual(ReasoningDuration.label(milliseconds: 90_000), "Thought for 90 seconds")

    // 标题：没有时长就是一个字符都不多加；有就并进标题（折叠态也看得见）。
    let plain = try XCTUnwrap(TranscriptRow.decode(Self.transcript(
      #"[{"key":"m1","kind":"reasoning","text":"先看磁盘"}]"#)).first)
    XCTAssertEqual(plain.block.reasoningHeading, "Reasoning")
    let timed = try XCTUnwrap(TranscriptRow.decode(Self.transcript(
      #"[{"key":"m1","kind":"reasoning","text":"先看磁盘","durationMs":3200}]"#)).first)
    XCTAssertEqual(timed.block.reasoningHeading, "Reasoning · Thought for 3 seconds")
    XCTAssertEqual(timed.block.durationMs, 3200, "durationMs 必须真的从载荷里解出来")
  }
}

#if !canImport(UIKit)
// swiftc Transcript.swift MessageListTests.swift -o message-list-tests && ./message-list-tests
@main
enum MessageListTestRunner {
  static func main() {
    XCTMain([testCase([
      ("testConsecutiveToolsGroupAndEveryOtherKindBreaksTheGroup", MessageListLogicTests.testConsecutiveToolsGroupAndEveryOtherKindBreaksTheGroup),
      ("testGroupsNeverCrossTurnMessageOrRoleBoundaries", MessageListLogicTests.testGroupsNeverCrossTurnMessageOrRoleBoundaries),
      ("testToolActivityCategoryMappingAndFallback", MessageListLogicTests.testToolActivityCategoryMappingAndFallback),
      ("testMixedActivityWordingDeduplicatesAndCapsAtThreeInFirstSeenOrder", MessageListLogicTests.testMixedActivityWordingDeduplicatesAndCapsAtThreeInFirstSeenOrder),
      ("testActivitySpinnerReflectsAnyMemberWithoutChangingWording", MessageListLogicTests.testActivitySpinnerReflectsAnyMemberWithoutChangingWording),
      ("testActivityErrorsRemainNeutralAndPreserveOriginalDetails", MessageListLogicTests.testActivityErrorsRemainNeutralAndPreserveOriginalDetails),
      ("testAppendingToolsRetainsIdentityAndOriginalInputUpdates", MessageListLogicTests.testAppendingToolsRetainsIdentityAndOriginalInputUpdates),
      ("testToolStateMapping", MessageListLogicTests.testToolStateMapping),
      ("testHierarchySeparatesUserBubblesFromAgentActivity", MessageListLogicTests.testHierarchySeparatesUserBubblesFromAgentActivity),
      ("testToolTitleVisibility", MessageListLogicTests.testToolTitleVisibility),
      ("testToolStatusLabelOnlyWhenItExplainsSomething", MessageListLogicTests.testToolStatusLabelOnlyWhenItExplainsSomething),
      // 工具组的可展开策略（`Transcript.swift` 的 `expandable`）。**这条原来只在 hosted
      // 里验**（disclosure 控件那段），而策略本身是 Foundation-only（2026-09-18 自查发现）。
      ("testToolGroupExpandabilityFollowsThePolicy", MessageListLogicTests.testToolGroupExpandabilityFollowsThePolicy),
      ("testToolResultDiagnosisReadsUpstreamShape", MessageListLogicTests.testToolResultDiagnosisReadsUpstreamShape),
      ("testToolInputShapesAndInputOnlyUpdates", MessageListLogicTests.testToolInputShapesAndInputOnlyUpdates),
      ("testReasoningStateSurvivesStreamingAndUsesFullIdentity", MessageListLogicTests.testReasoningStateSurvivesStreamingAndUsesFullIdentity),
      ("testAttachmentsCountTypesAndSizes", MessageListLogicTests.testAttachmentsCountTypesAndSizes),
      ("testErrorCodeAndNoticeRemainDistinct", MessageListLogicTests.testErrorCodeAndNoticeRemainDistinct),
      ("testErrorBlockJudgesTitleReasonDetailAndRetry", MessageListLogicTests.testErrorBlockJudgesTitleReasonDetailAndRetry),
      ("testErrorExpansionStateFollowsTheBlockNotTheRowIdentity", MessageListLogicTests.testErrorExpansionStateFollowsTheBlockNotTheRowIdentity),
      ("testLayoutPolicyAndScrollClamping", MessageListLogicTests.testLayoutPolicyAndScrollClamping),
      ("testContentHashWitnessesEveryContentChange", MessageListLogicTests.testContentHashWitnessesEveryContentChange),
      ("testChangedSetKeepsTheOldDeepCompareSemantics", MessageListLogicTests.testChangedSetKeepsTheOldDeepCompareSemantics),
      // Markdown 渲染管线（Chat/Markdown.swift）。**流式不闪符号**与**增量解析**是本轮的
      // 主体判据，跑在构建机上、不需要 UIKit。
      ("testStreamingPrefixesNeverShowRawMarkdown", MessageListLogicTests.testStreamingPrefixesNeverShowRawMarkdown),
      ("testFinishedMessagesKeepUnpairedDelimitersLiteral", MessageListLogicTests.testFinishedMessagesKeepUnpairedDelimitersLiteral),
      ("testIncrementalParsingOnlyReparsesTheTail", MessageListLogicTests.testIncrementalParsingOnlyReparsesTheTail),
      ("testMarkdownBlocksCoverTheSupportedSet", MessageListLogicTests.testMarkdownBlocksCoverTheSupportedSet),
      ("testTablesFallBackToAMonospaceBlock", MessageListLogicTests.testTablesFallBackToAMonospaceBlock),
      ("testPlainTextIsWhatTheReaderCopies", MessageListLogicTests.testPlainTextIsWhatTheReaderCopies),
      ("testAccessibilityTextIsSentencesNotSymbols", MessageListLogicTests.testAccessibilityTextIsSentencesNotSymbols),
      ("testThinkingShapesDecideWhetherARowExists", MessageListLogicTests.testThinkingShapesDecideWhetherARowExists),
      ("testBlankTextBlocksDoNotProduceRows", MessageListLogicTests.testBlankTextBlocksDoNotProduceRows),
      ("testReasoningDurationLabelOnlyWhenKnown", MessageListLogicTests.testReasoningDurationLabelOnlyWhenKnown),
      // 链接白名单（Chat/Markdown.swift 的 `MarkdownLinkPolicy`）。**这一条原来在
      // `#if canImport(UIKit)` 那一段里**（2026-09-18 搬出来）：判据全是字符串，与 UIKit
      // 无关，搬到这边之后不必等装了 Xcode 的 hosted 测试就能跑。
      ("testOnlySafeLinkDestinationsAreOpenable", MessageListLogicTests.testOnlySafeLinkDestinationsAreOpenable),
    ]), testCase([
      // 通知契约层（Notifications/NotificationContract.swift）。同一台构建机上跑，
      // 不需要 UIKit：这一层错了的形态都不崩，只是"推送来了点不进去"。
      ("testHexTokenIsLowercaseAndZeroPadded", NotificationContractTests.testHexTokenIsLowercaseAndZeroPadded),
      ("testPermissionStatusFollowsAppleRawValues", NotificationContractTests.testPermissionStatusFollowsAppleRawValues),
      ("testAuthorizationOptionNamesMapToClosedSet", NotificationContractTests.testAuthorizationOptionNamesMapToClosedSet),
      ("testAllowAndRejectActionsAreRecognized", NotificationContractTests.testAllowAndRejectActionsAreRecognized),
      ("testUnknownActionIdentifierFallsBackToOpened", NotificationContractTests.testUnknownActionIdentifierFallsBackToOpened),
      ("testOpenRequestCarriesSessionAndApproval", NotificationContractTests.testOpenRequestCarriesSessionAndApproval),
      ("testOpenRequestWithoutSessionIsRefused", NotificationContractTests.testOpenRequestWithoutSessionIsRefused),
      ("testEmptyApprovalIdIsTreatedAsAbsent", NotificationContractTests.testEmptyApprovalIdIsTreatedAsAbsent),
      ("testNumericUserInfoValuesAreCoerced", NotificationContractTests.testNumericUserInfoValuesAreCoerced),
      ("testUnknownEventNameIsDroppedNotGuessed", NotificationContractTests.testUnknownEventNameIsDroppedNotGuessed),
      ("testPresentationOptionsDropUnknownNames", NotificationContractTests.testPresentationOptionsDropUnknownNames),
      ("testPresentationResolutionParsesRequestIdAndOptions", NotificationContractTests.testPresentationResolutionParsesRequestIdAndOptions),
      ("testPresentationResolutionWithoutRequestIdIsRefused", NotificationContractTests.testPresentationResolutionWithoutRequestIdIsRefused),
      ("testCategoriesParseActionsAndLocalizedTitles", NotificationContractTests.testCategoriesParseActionsAndLocalizedTitles),
      ("testMalformedCategoryEntriesAreDropped", NotificationContractTests.testMalformedCategoryEntriesAreDropped),
      ("testCategoriesRefuseNonJSON", NotificationContractTests.testCategoriesRefuseNonJSON),
      ("testJsonStringSerializesDeliveredDescriptions", NotificationContractTests.testJsonStringSerializesDeliveredDescriptions),
    ])])
  }
}
#endif
