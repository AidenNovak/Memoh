#if DEBUG
import Foundation
import QuartzCore
import UIKit

/**
 逐帧几何探针（**仅 Debug 构建**）。

 ## 它测什么、不测什么（口径必须跟着数字走）

 - **测**：主线程 run loop 的**帧投递**节奏（`CADisplayLink` 回调间隔），以及消息列表在
   每一帧上的**几何**：`contentOffset`、`contentSize`、视口高度、距底距离、首条可见行的
   身份与它顶边在**屏幕坐标**上的位置、是否在跟随底部、是否正在手势/惯性中。
 - **不测**：GPU 真正呈现的帧率、cell 的绘制成本、离屏渲染。名字写的是
   "main-run-loop delivery"，不是 "FPS"——和 Lody 探针头部的限定语同一件事。
 - **不测**：机器负载。负载是**宿主**的属性，由宿主脚本记（`tools/frame-probe/measure.py`）。

 ## 为什么需要它（而不是 Instruments）

 本机实测（macOS 26.6 / Xcode 26.6）：

 - `xcrun xctrace record --attach <pid>`（不带 `--device`）对模拟器进程直接报
   `Cannot find process for provided pid`；
 - 带上 `--device <sim-udid>` 后能 attach，但 **Animation Hitches 模板报
   `[Error] Hitches is not supported on this platform.`**（宿主是 macOS，该 instrument
   要真机 iOS）；
 - `Time Profiler` attach 同一个模拟器进程**不按 `--time-limit` 收尾**（4s 的窗口跑了
   6 分钟仍不结束）。

 也就是说：**在这台机器上，模拟器里拿不到官方的 hitch 数字**。于是用这个探针作为等价
 手段，并**用已知会掉帧的对照证明它有效**（`MemohFrameProbeStallMs`，见下）。

 ## 怎么开、怎么配

 用启动参数（`simctl launch <udid> <bundle> -Key Value` 会进 `NSArgumentDomain`）：

 | 键                       | 含义                                                        |
 | ------------------------ | ----------------------------------------------------------- |
 | `MemohFrameProbe`        | `1` 打开。不开时本文件的每一处都早返回，开销为零            |
 | `MemohFrameProbeName`    | 输出名，落到 `Documents/frame-probe-<name>.jsonl`            |
 | `MemohFrameProbeStallMs` | **已知掉帧对照**：每帧采样前在主线程忙等这么多毫秒           |

 ## 输出

 JSONL，一行一个对象，`k` 区分两种：

 - `k:"f"` 帧样本：`t dt nom off ch bh gap n fv fvy fo di tr fn`
 - `k:"e"` 事件：`ev` + 各自字段（`start` / `apply` / `pin` / `anchor` / `reachTop` /
   `returnToBottom` / `stop` / `stall`）

 写入是**缓冲 + 每 0.5 秒落一次盘**：一帧一行地写文件本身就会制造掉帧，探针不能变成
 被测对象。
 */
struct MessageListProbeMetrics {
  let offsetY: Double
  let contentHeight: Double
  let viewportHeight: Double
  /// 视口底边与内容底边的距离（0 = 正好贴底）。
  let gap: Double
  /// 首条可见行在快照里的序号；没有可见行时 `-1`。
  let firstVisibleIndex: Int
  /// 首条可见行顶边在**屏幕坐标**上的 y（`frame.minY - contentOffset.y`）。
  let firstVisibleTop: Double
  let rows: Int
  let following: Bool
  let dragging: Bool
  let decelerating: Bool
  let tracking: Bool
}

/**
 逐帧几何探针的落地实现。

 `@unchecked Sendable` 是**有依据的**，不是随手贴的：这个类里每一处可变状态（显示链接、
 缓冲、配置）都只在**主线程**上被碰——`CADisplayLink` 加在主 run loop 的 `.common` 模式上，
 三个写入方（`attach` / `recordApply` / `recordOffsetChange`）分别来自 `init`（UI 队列）、
 `source.apply` 的完成闭包（主队列）与列表的手势回调（主队列）。所以这里没有跨线程共享。
 与 `MemohNotifications` 用同一套写法。
 */
final class MessageListFrameProbe: @unchecked Sendable {
  static let shared = MessageListFrameProbe()

  static let enabledKey = "MemohFrameProbe"
  static let nameKey = "MemohFrameProbeName"
  private static let stallKey = "MemohFrameProbeStallMs"
  private static let deepCompareKey = "MemohFrameProbeDeepCompare"
  static let legacyOverlayKey = "MemohLegacyBottomOverlay"

  static var isEnabled: Bool {
    UserDefaults.standard.integer(forKey: enabledKey) != 0
  }

  /**
   **量测对照开关**：把 `apply` 的"变更集合"换回**逐行深比较**那条老路。

   为什么留着一条老路径：这次改动的靶子就是 `apply` 同步段里那次深比较。要证明"改完真的
   更便宜"，唯一能归因的做法是**同一个二进制、同一台机器、同一个场景**下把两条路各跑一遍——
   在两个 build 之间做对比，会插进别人的改动与另一个负载窗口，那个差不能归因到这一行。

   `NativeMessageList.changedSet` 读它。默认关，只有探针开着并且显式传
   `-MemohFrameProbeDeepCompare 1`（宿主侧 `measure.py --deep-compare`）才生效；
   Release 构建里没有这个文件，也就没有这条路径。
   */
  static var deepCompareEnabled: Bool {
    UserDefaults.standard.integer(forKey: deepCompareKey) != 0
  }

  /**
   **量测对照开关**：关掉列表底部常驻余量，复现"回底按钮压在正文上"的旧形态。

   与 `deepCompareEnabled` 同一个理由：改前/改后要能**在同一个二进制**上各截一张图，
   否则两张图之间隔着另一个 build 与另一段负载窗口，那个差不能归因到这一行。

   只影响一个数字（`contentInset.bottom`）与按钮的不透明底。宿主侧用启动参数
   `-MemohLegacyBottomOverlay 1` 打开（`xcrun simctl launch … -- -MemohLegacyBottomOverlay 1`）。
   Release 构建里没有这个文件，也就没有这条路径。
   */
  static var legacyBottomOverlay: Bool {
    UserDefaults.standard.integer(forKey: legacyOverlayKey) != 0
  }

  static let plainTextRenderingKey = "MemohPlainTextRendering"

  /**
   **量测对照开关**：正文回到改动前的形态——不解析 Markdown，原样把源文本铺进一个标签。

   留着它是为了能截出"改前"那张图（`# A History of the Internet` 原样上屏），
   而**不用**回退到另一个 commit：那张图是 aiden 提出这一轮问题的原始证据，
   在同一个二进制上复现它，才谈得上"改了什么"。

   宿主侧用启动参数 `-MemohPlainTextRendering 1` 打开。Release 里没有这个文件。
   */
  static var plainTextRendering: Bool {
    UserDefaults.standard.integer(forKey: plainTextRenderingKey) != 0
  }

  private var link: CADisplayLink?
  private var metrics: (() -> MessageListProbeMetrics)?
  private var lines: [String] = []
  /**
   计数（只加，不改几何判据）：列表**被重新布局/被要求失效**了几次。

   `lay` = `MessageCollectionView.layoutSubviews` 被调用的次数；
   `inv` = 显式向 collection 的 layout 请求失效的次数（`invalidateLayout()`）；
   `upd` = `updateProperties()` 的调用次数（系统只在 iOS 26 那条路上会调）。

   都是**累计值**，写进每一行帧样本与事件里；宿主侧按"两次 `apply` 事件之间涨了多少"
   算每次更新触发了多少次，避免帧与事件的先后顺序影响读数。
   */
  private var layoutPasses = 0
  private var invalidations = 0
  private var propertyUpdates = 0
  private var edgeStateReported = false
  private var lastFlush: CFTimeInterval = 0
  private var origin: CFTimeInterval = 0
  private var previous: CFTimeInterval = 0
  private var stall: CFTimeInterval = 0
  private var running = false
  private let handle: FileHandle?
  let path: URL

  private init() {
    let name = UserDefaults.standard.string(forKey: Self.nameKey) ?? "default"
    let safe = name.replacingOccurrences(of: "/", with: "_")
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    path = documents.appendingPathComponent("frame-probe-\(safe).jsonl")
    FileManager.default.createFile(atPath: path.path, contents: nil)
    handle = try? FileHandle(forWritingTo: path)
    stall = Double(UserDefaults.standard.integer(forKey: Self.stallKey)) / 1000.0
    if Self.isEnabled {
      // 上一轮的残留会让"这一轮有多少样本"没法解释，所以每次启动都从空文件开始。
      try? handle?.truncate(atOffset: 0)
    }
  }

  /// 视图建好之后调一次。`metrics` 每帧被调，必须是常数时间的只读取值。
  func attach(collection: UICollectionView, metrics: @escaping () -> MessageListProbeMetrics) {
    guard Self.isEnabled, !running else { return }
    running = true
    self.metrics = metrics
    origin = CACurrentMediaTime()
    previous = origin
    lastFlush = origin
    let displayLink = CADisplayLink(target: self, selector: #selector(tick(_:)))
    // `.common`：默认模式下拖动/惯性期间 display link 会停，恰好把最该量的那段丢掉。
    displayLink.add(to: .main, forMode: .common)
    link = displayLink
    var extra = [
      "stallMs": number(stall * 1000, 2),
      "scale": number(UIScreen.main.scale, 2),
      "maxFps": String(UIScreen.main.maximumFramesPerSecond),
      "boldText": UIAccessibility.isBoldTextEnabled ? "1" : "0",
      "reduceMotion": UIAccessibility.isReduceMotionEnabled ? "1" : "0",
      "bounds": number(collection.bounds.width, 1) + "x" + number(collection.bounds.height, 1),
      // 探针时间的原点（Unix 秒）。宿主侧靠它把自己的时钟（手势、负载采样）对齐到 `t` 上，
      // 否则"哪一段是流式窗口"只能靠猜。
      "wall": number(Date().timeIntervalSince1970, 3),
    ]
    if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
      extra["app"] = version
    }
    recordEvent("start", extra: extra)
  }

  @objc private func tick(_ displayLink: CADisplayLink) {
    let now = CACurrentMediaTime()
    if stall > 0 {
      // 已知会掉帧的对照：主线程忙等到超过本帧预算，用来验证"检测器真的会响"。
      let deadline = now + stall
      while CACurrentMediaTime() < deadline {}
      recordEvent("stall", extra: ["ms": number(stall * 1000, 2)])
    }
    let dt = now - previous
    previous = now
    guard let metrics else { return }
    let m = metrics()
    guard m.rows >= 0 else {
      // 宿主视图没了（Metro 热重载、页面被替换、App 重启）。**继续采样只会产出噪声**：
      // 全零的几何看起来像"稳如磐石"，会伪装成通过。所以记一条事件就停。
      recordEvent("host_gone", extra: ["reason": "attached_list_deallocated"])
      stop()
      return
    }
    var line = "{\"k\":\"f\""
    line += ",\"t\":" + number(now - origin, 5)
    line += ",\"dt\":" + number(dt, 5)
    line += ",\"nom\":" + number(displayLink.targetTimestamp - displayLink.timestamp, 5)
    line += ",\"off\":" + number(m.offsetY, 2)
    line += ",\"ch\":" + number(m.contentHeight, 2)
    line += ",\"bh\":" + number(m.viewportHeight, 2)
    line += ",\"gap\":" + number(m.gap, 2)
    line += ",\"n\":" + String(m.rows)
    line += ",\"fv\":" + String(m.firstVisibleIndex)
    line += ",\"fvy\":" + number(m.firstVisibleTop, 2)
    line += ",\"fo\":" + (m.following ? "1" : "0")
    line += ",\"di\":" + (m.decelerating ? "1" : "0")
    line += ",\"tr\":" + (m.tracking ? "1" : "0")
    line += ",\"fn\":" + (m.dragging ? "1" : "0")
    line += ",\"lay\":" + String(layoutPasses)
    line += ",\"inv\":" + String(invalidations)
    line += ",\"upd\":" + String(propertyUpdates)
    line += "}"
    lines.append(line)
    if now - lastFlush > 0.5 { flush() }
  }

  /**
   `apply` 之后的几何快照 + **这一次的花费**。

   `added` / `chg` 让宿主侧能把"真的在追加"和"只是重排"分开；`applyMs` / `decodeMs`
   让"每个 token 要重算整份转录"这句话有数字（口径见宿主脚本 `measure.py` 的
   `append_cost_stats`）：

   - `applyMs`：`apply` 的**同步段**——建行表 + 算变更集合（改前是逐行深比较整棵 JSON 树）
     + 组装快照。不含 diffable 自己的 diff 与布局（那些在下一步的 runloop 上）。
   - `decodeMs`：后台解码任务的往返（JSON 解码 + 分组），从排队到取回。
     展开态重放那种没有解码的 apply 记 0。
   */
  func recordApply(rows: Int, added: Int, changed: Int, offsetY: Double, contentHeight: Double,
                   gap: Double, applyMs: Double = 0, decodeMs: Double = 0) {
    guard Self.isEnabled else { return }
    recordEvent("apply", extra: [
      "n": String(rows), "added": String(added), "chg": String(changed),
      "off": number(offsetY, 2), "ch": number(contentHeight, 2), "gap": number(gap, 2),
      "ms": number(applyMs, 3), "dec": number(decodeMs, 3),
    ])
  }

  func recordOffsetChange(_ event: String, from: Double, to: Double, distance: Double? = nil) {
    guard Self.isEnabled else { return }
    var extra = ["from": number(from, 2), "to": number(to, 2)]
    if let distance { extra["dist"] = number(distance, 2) }
    recordEvent(event, extra: extra)
  }

  // MARK: - 计数（只加；不读几何、不改判据）

  /// 列表被重新布局一次。调用方：`MessageCollectionView.layoutSubviews`。
  func recordLayoutPass() {
    guard Self.isEnabled else { return }
    layoutPasses += 1
  }


  /// 向 collection 的 layout 显式请求一次失效。调用方：所有 `invalidateLayout()` 的位置。
  func recordInvalidation() {
    guard Self.isEnabled else { return }
    invalidations += 1
  }

  /// 系统调了一次 `updateProperties()`。
  func recordPropertyUpdate() {
    guard Self.isEnabled else { return }
    propertyUpdates += 1
  }

  /**
   一次性记录滚动边缘效果（`UIScrollEdgeEffect`，iOS 26）的**实际状态**。

   为什么要记它：`UIScrollEdgeEffect.isHidden` 的默认值是 `false`，也就是"系统默认就开着"，
   但"属性没被隐藏"不等于"真的画出来了"。所以除 style/hidden 之外，还把 collection 的子视图
   类名记一份——系统自己装的那层边缘效果视图会出现在这里（那是"真的装了"的直接证据）。
   只在第一次 `apply` 之后记一次，不进帧循环。
   */
  func recordEdgeState(_ scrollView: UIScrollView) {
    guard Self.isEnabled, !edgeStateReported else { return }
    edgeStateReported = true
    let top = scrollView.topEdgeEffect
    let bottom = scrollView.bottomEdgeEffect
    recordEvent("edge_effect", extra: [
      "top_style": Self.styleName(top.style),
      "top_hidden": top.isHidden ? "1" : "0",
      "bottom_style": Self.styleName(bottom.style),
      "bottom_hidden": bottom.isHidden ? "1" : "0",
      "subviews": scrollView.subviews.map { NSStringFromClass(type(of: $0)) }.joined(separator: ","),
    ])
  }

  private static func styleName(_ style: UIScrollEdgeEffect.Style) -> String {
    if style === UIScrollEdgeEffect.Style.soft { return "soft" }
    if style === UIScrollEdgeEffect.Style.hard { return "hard" }
    if style === UIScrollEdgeEffect.Style.automatic { return "automatic" }
    return "other"
  }

  func recordEvent(_ name: String, extra: [String: String] = [:]) {
    guard Self.isEnabled else { return }
    var fields: [String] = []
    for key in extra.keys.sorted() {
      let value = extra[key] ?? ""
      fields.append("\"" + key + "\":" + quote(value))
    }
    var line = "{\"k\":\"e\""
    line += ",\"t\":" + number(CACurrentMediaTime() - origin, 5)
    line += ",\"ev\":\"" + name + "\""
    for field in fields { line += "," + field }
    line += ",\"lay\":" + String(layoutPasses)
    line += ",\"inv\":" + String(invalidations)
    line += ",\"upd\":" + String(propertyUpdates)
    line += "}"
    append(line)
  }

  func stop() {
    guard running else { return }
    recordEvent("stop")
    link?.invalidate()
    link = nil
    running = false
    flush()
  }

  private func number(_ value: Double, _ digits: Int) -> String {
    String(format: "%.\(digits)f", value)
  }

  /** 数值字段不加引号，其余加引号——宿主侧只按 JSON 解，不猜。 */
  private func quote(_ value: String) -> String {
    let cleaned = value.replacingOccurrences(of: "\"", with: "")
    if Double(cleaned) != nil { return cleaned }
    return "\"" + cleaned + "\""
  }

  private func append(_ line: String) {
    lines.append(line)
  }

  private func flush() {
    guard let handle, !lines.isEmpty else { return }
    lastFlush = CACurrentMediaTime()
    let payload = (lines.joined(separator: "\n") + "\n").data(using: .utf8) ?? Data()
    lines.removeAll(keepingCapacity: true)
    try? handle.write(contentsOf: payload)
  }
}
#endif
