import ExpoModulesCore
import SwiftUI
import UIKit

// MARK: - 常量（全部照 `screens/OnboardingScreen.tsx` 取，不要自己发明）

/// 品牌标记直径（原 RN `MARK_SIZE`）。登录页是 64pt——这里是主角，大一号。
private let MARK_SIZE: CGFloat = 96
/// 文案列宽（原 RN `TEXT_COLUMN`）：一屏宽减去边距后一行能塞 60 多个字符，读起来太长；
/// 收窄到 320pt 更像印刷品的栏宽。
private let TEXT_COLUMN: CGFloat = 320
/// 页码点：非当前页是 6pt 圆点，当前页是 18pt 胶囊（原 RN `DOT_SIZE` / `DOT_ACTIVE_WIDTH`）。
private let DOT_SIZE: CGFloat = 6
private let DOT_ACTIVE_WIDTH: CGFloat = 18
/// 内容入场的上浮距离（原 RN `features/onboarding/motion.ts` 的 `REVEAL_DISTANCE`）。
private let REVEAL_DISTANCE: CGFloat = 14
/// 动效集中的那一页（原 RN `EMPHASIS_PAGE`）：三页里只有「在外面也能批」是别人替代不了的能力。
private let EMPHASIS_PAGE = "approval"
/// 按压反馈的两档（`tokens.ts` 的 `PRESS_OPACITY`）：行内小控件 0.6、独立成块的按钮 0.85。
private let PRESS_CONTROL: Double = 0.6
private let PRESS_BUTTON: Double = 0.85

/// 设计基线里唯一那条曲线：easeOutExpo `cubic-bezier(0.16, 1, 0.3, 1)`。
/// 三处动效（入场 500ms / 上浮 400ms / 弹 160+260ms）都用它，只是时长不同。
private func easeOutExpo(_ duration: TimeInterval) -> Animation {
  .timingCurve(0.16, 1, 0.3, 1, duration: duration)
}

/// 辅助字号下位移归零的门槛。
///
/// 原 RN 的判据是 `fontScale >= 2`（`motion.ts` 的 `LARGE_FONT_SCALE`）：大字号下行高很大，
/// 14pt 的上浮读出来不是"上浮"而是"晃"。SwiftUI 的字号是**档位**而不是倍数，`accessibility2`
/// 是 1.95、`accessibility3` 是 2.35——取第一个 ≥ 2 的档位，与原判据同一条线（不是更宽松的
/// `isAccessibilitySize`，那会从 1.64 就砍掉位移）。
private func revealDistance(_ size: DynamicTypeSize) -> CGFloat {
  size >= DynamicTypeSize.accessibility3 ? 0 : REVEAL_DISTANCE
}

/// 本屏用到的品牌色。**值一律走 `MemohPalette`**，视图里不自造色值。
private enum OnboardingColor {
  static var label: Color { Color(uiColor: UIColor { MemohPalette.label($0) }) }
  static var secondary: Color { Color(uiColor: UIColor { MemohPalette.secondaryLabel($0) }) }
  static var accent: Color { Color(uiColor: UIColor { MemohPalette.accent($0) }) }
  static var onAccent: Color { Color(uiColor: UIColor { MemohPalette.onAccent($0) }) }

  /// 页码点的 idle 色 = RN `tertiaryLabel`。`MemohPalette` 没有这一档（与 `ChatSheets` 同一处理）：
  /// 用系统的分层灰——同一个语义，也不在视图里自造一个色值。
  static var tertiary: Color { Color(uiColor: .tertiaryLabel) }
}

/// 按压反馈。
///
/// 偏差：原 RN 的主按钮按下是**换底色**（`palette.accentPressed`），而 `MemohPalette` 没有这一档，
/// 本模块也不许动 `Support/`。原生改用「独立成块」那一档的透明度——按压反馈仍然只有两档，
/// 且没有在视图里复制一份色值（色值的真源是 `tools/oklch.py` → `tokens.ts` / `MemohPalette`，
/// 在这里再抄一份比两档透明度更糟）。
private struct OnboardingPressStyle: ButtonStyle {
  let pressedOpacity: Double

  func makeBody(configuration: Configuration) -> some View {
    configuration.label.opacity(configuration.isPressed ? pressedOpacity : 1)
  }
}

/// 首启引导的桥接状态。
///
/// 内容全部由 RN 算好下发（`OnboardingModel`）：页序、符号、文案、三个按钮标签。
/// 这里只存它、存主题模式，并把「跳过 / 开始使用」回成一个事件。
@MainActor
private final class OnboardingStore: ObservableObject {
  @Published var model: OnboardingModel?
  @Published var mode = "system"

  var onDone: () -> Void = {}

  var colorScheme: ColorScheme? { MemohAppearanceMode.colorScheme(mode) }

  /// 底色：`palette.background` 在四个模式下的同一个值。
  ///
  /// 不能直接用 `MemohPalette.background`：`oled` 那一档 RN 的 `palette.background` 是**纯黑**
  /// （`tokens.ts` 的 `oled` 覆写），而 `MemohPalette.background` 给的是 `#060606`。
  /// `formBackground` 已经把这四种模式收成一处（设置页、bot 表单用的是它）。
  var background: Color { MemohAppearanceMode.formBackground(mode) }

  /// 解析失败就不动界面：宁可停在上一份有效模型上，也不要把冷启动第一屏闪成空白。
  func setModelJSON(_ value: String) {
    guard let decoded = try? OnboardingModel.decode(value) else { return }
    model = decoded
  }
}

/// 分页器一次上报的两个量：**连续**偏移 + 容器宽。
///
/// 合成一个 `Equatable` 值是因为 `onScrollGeometryChange` 按值判等：分成两次注册会多一遍
/// 布局遍历，而且两个量本来就是同一次布局的结果。
private struct PagerGeometry: Equatable {
  var offsetX: CGFloat
  var width: CGFloat
}

/// 一个页码点——它的宽度与颜色**跟着手指连续变化**。
///
/// 原实现（RN `PageDot`）是一条三段线性插值：输入 `[(i-1)·w, i·w, (i+1)·w]`、
/// 输出 `[idle, active, idle]`、`extrapolate: 'clamp'`。三段线性 + 首尾钉住，数学上等价于
/// 下面这条"离本页越远越回到 idle"的进度，所以这里写成进度、不再构造插值器——
/// **数值照原实现取**：6pt → 18pt、`tertiaryLabel` → `accent`。
///
/// 为什么不用 `withAnimation` 做一个 200ms 补间：那要等手势结束才开始动，与手指脱节，还会
/// 多一条"我松手了但界面还在动"的尾巴。HIG 把"让动画直接跟着人的手势走"列为减少动效的
/// 做法之一——所以这一条**不需要**额外的 Reduce Motion 分支：点永远在手指所在的位置上。
private struct PageDot: View {
  let index: Int
  /// 一页的宽度（= 分页器容器宽）。
  let pageWidth: CGFloat
  /// 分页器当前的水平偏移（pt）。
  let scrollX: CGFloat

  /// 0 = 完全 idle，1 = 完全 active。
  ///
  /// 容器宽还没量到的第一帧按"第 0 页是当前页"画：宁可少一次插值，也不要有一帧三个点全是灰的
  /// （那看起来像"这一屏没有当前页"）。
  private var progress: CGFloat {
    guard pageWidth > 0 else { return index == 0 ? 1 : 0 }
    let distance = abs(scrollX - CGFloat(index) * pageWidth) / pageWidth
    return min(max(1 - distance, 0), 1)
  }

  var body: some View {
    Capsule()
      // 颜色按进度混合：RN 的插值就是分量线性混合（sRGB），`.device` 是最接近的那一档
      // （`.perceptual` 会在中途偏暗，观感与原实现不一致）。
      .fill(OnboardingColor.tertiary.mix(with: OnboardingColor.accent, by: Double(progress), in: .device))
      .frame(width: DOT_SIZE + (DOT_ACTIVE_WIDTH - DOT_SIZE) * progress, height: DOT_SIZE)
  }
}

/// 一页。
///
/// `active` 由父级的**连续**滚动偏移算出（不是"翻完才变"）：内容在上滑过程中就淡入，
/// 手一停它已经在位了。Reduce Motion 时不动，直接切换。
private struct OnboardingPageContent: View {
  let page: OnboardingPageModel
  let active: Bool

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  /// 挂载后置 true，让**首帧**也走一次淡入。
  ///
  /// 只由 `active` 驱动的 `.animation` 在首帧没有"变化"，第一页会直接以终态出现——原 RN 的
  /// `reveal` 初值是 0、靠 effect 推到 1，所以第一页也是淡进来的。
  @State private var mounted = false
  /// 符号的一次"弹"（只有 `EMPHASIS_PAGE` 会用到）。
  @State private var emphasis: CGFloat = 1
  /// 每次"成为当前页"加一；`.task(id:)` 据此重开一次弹，并自动取消上一次。
  @State private var popToken = 0

  private var reveal: CGFloat { active && mounted ? 1 : 0 }

  var body: some View {
    VStack(spacing: 8) {
      symbol
      Text(page.title)
        .font(.title2.bold())
        .foregroundStyle(OnboardingColor.label)
        .multilineTextAlignment(.center)
        .frame(maxWidth: TEXT_COLUMN)
        .accessibilityAddTraits(.isHeader)
      Text(page.body)
        .font(.subheadline)
        .foregroundStyle(OnboardingColor.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: TEXT_COLUMN)
    }
    .padding(.horizontal, 24)
    // 页宽 = 容器宽（原 RN 把窗口宽作为 `width` 传给每一页）；`maxHeight: .infinity` 让三页等高，
    // 各自的内容在这块空间里居中——与原 RN 的 `justifyContent: 'center'` 同一条。
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .containerRelativeFrame(.horizontal)
    .opacity(reveal)
    .offset(y: revealDistance(dynamicTypeSize) * (1 - reveal))
    .animation(reduceMotion ? nil : easeOutExpo(0.4), value: reveal)
    .accessibilityIdentifier("onboarding-page-\(page.id)")
    .onAppear { mounted = true }
    .onChange(of: active) { _, isActive in
      guard isActive else { return }
      popToken += 1
    }
    .task(id: popToken) {
      // `popToken == 0` 是挂载那一次：原 RN 的 effect 在挂载时就会跑，所以如果第一页正好是
      // 动效页，它同样弹一下。
      guard page.id == EMPHASIS_PAGE, active, !reduceMotion else { return }
      emphasis = 1
      withAnimation(easeOutExpo(0.16)) { emphasis = 1.12 }
      try? await Task.sleep(for: .milliseconds(160))
      withAnimation(easeOutExpo(0.26)) { emphasis = 1 }
    }
  }

  /// SF Symbol 而不是自绘图形：系统符号自带 Dynamic Type、明暗与粗细适配，也没有
  /// "我们自己画了一个 iOS 图标"那种拼缝。符号名由 RN 的 `SFSymbol` 类型保证（写错在 tsc 就红），
  /// 原生不再查表、也不再兜一层。
  private var symbol: some View {
    Image(systemName: page.symbol)
      .font(.system(size: 40))
      .foregroundStyle(OnboardingColor.accent)
      .frame(width: 44, height: 44)
      .padding(.bottom, 4)
      .scaleEffect(emphasis)
      .accessibilityHidden(true)
  }
}

/// 首启引导（三屏）。
///
/// 原实现是 `screens/OnboardingScreen.tsx`（532 行 RN），判据（为什么它是"启动页"而不是一个
/// sheet、三条动效、大字号兜底）都写在那个文件头里。这里逐条搬到 SwiftUI，RN 侧只剩薄桥。
///
/// ## 动效三件套（与原实现一一对应）
///
/// 1. **品牌标记入场**：缩放 0.92 → 1 + 透明度 0 → 1，easeOutExpo 500ms；
/// 2. **每页内容随翻页淡入上浮**：14pt → 0 + 透明度 0 → 1，easeOutExpo 400ms，由**连续**
///    滚动偏移算出的当前页驱动——不是等手势停下才出现；
/// 3. **标记待机呼吸**：scale 1 ↔ 1.03，单程 1.3s（一个来回 2.6s）无限循环。它**有终点**：
///    用户一旦自己翻页，"这一屏还活着"的信号就该收掉（原 `shouldBreathe`：`page === 0` 才跑）。
///
/// 另有一条**不是动画**的连续变化：页码点的宽度与颜色由滚动偏移插值（见 `PageDot`）。
///
/// ## Reduce Motion：与 RN 的差别
///
/// 打开时三条动效全部退化为**直接呈现**（无入场、无呼吸、无上浮、无弹），翻页也不动画。
///
/// 差别在"系统查询还没回来"的那一小段：RN 的 `useReducedMotionPreference` 是**三态**
/// （`unknown | reduce | allow`），系统查询是异步的，`unknown` 时**也不播**（宁可首帧静一下，
/// 也不要给一个明确要求减少动效的人播一次他不要的动画）。而 SwiftUI 的
/// `@Environment(\.accessibilityReduceMotion)` 是**同步已知**的布尔值，没有中间态。
/// 所以原生只会更严格：要减少动效的人从第一帧起就没有动效，不会出现 RN 那个"先动一下再收住"
/// 的窗口。
///
/// ## 大字号（Dynamic Type）
///
/// 正文放到辅助字号时「标记 + 分页」这一组比屏幕还高，而横向分页器的溢出是**裁掉**的
/// （`accessibility-extra-large` 下正文第 5 行会压在页码点上）。所以中段套一层纵向 ScrollView：
/// 放得下就还是居中一屏，放不下就能滚。**CTA 与「跳过」留在滚动区之外**，任何字号下都够得着。
///
/// ## 安全区
///
/// 与原实现同一条：`insets.top` 之下 8pt 放「跳过」，`insets.bottom` 之上 16pt 放主按钮，
/// 底色铺满整屏（`ignoresSafeArea`）。冷启动从启动屏长出来，不跳色。
private struct OnboardingScreenView: View {
  let model: OnboardingModel
  let onDone: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// 入场进度 0 → 1；标记的缩放与透明度都由它插值。
  @State private var entrance: CGFloat = 0
  /// 待机呼吸的相位（false = 1.0，true = 1.03）。
  @State private var breathing = false
  /// 分页器当前的水平偏移（pt）。**它不是"第几页"，而是手指现在到哪儿了**——页码点靠它连续变化。
  @State private var scrollX: CGFloat = 0
  /// 一页的宽度（= 分页器容器宽）。页码点的插值区间按它算。
  @State private var pageWidth: CGFloat = 0
  /// 分页器停稳后落在哪一页（`scrollPosition` 的绑定）；主按钮靠它推进。
  @State private var pageID: String?

  private var lastIndex: Int { model.pages.count - 1 }

  /// 当前页：连续偏移四舍五入（原 RN `Math.round(offsetX / width)` 的同一条），所以翻页过一半
  /// 内容就开始淡入，而不是等手势停下。
  private var activeIndex: Int {
    guard pageWidth > 0 else { return 0 }
    return min(max(Int((scrollX / pageWidth).rounded()), 0), lastIndex)
  }

  private var activePageID: String { model.pages[activeIndex].id }
  private var isLastPage: Bool { activeIndex == lastIndex }
  private var advanceLabel: String { isLastPage ? model.startLabel : model.nextLabel }

  /// 入场：0.92 → 1（原 RN 的 `appear` 插值）。
  private var entranceScale: CGFloat { 0.92 + 0.08 * entrance }
  /// 呼吸：1 ↔ 1.03（原 RN 的 `idle` 插值）。两者相乘——原 RN 也是 `Animated.multiply(appear, idle)`。
  private var breathScale: CGFloat { breathing ? 1.03 : 1 }

  var body: some View {
    GeometryReader { geometry in
      VStack(spacing: 0) {
        skipRow(topInset: geometry.safeAreaInsets.top)
        bodyRegion
        bottomBlock(bottomInset: geometry.safeAreaInsets.bottom)
      }
    }
    .onAppear {
      startEntrance()
      syncBreathing()
    }
    // 翻页是呼吸的终点；Reduce Motion 被切换时也重新判一次。
    .onChange(of: activeIndex) { _, _ in syncBreathing() }
    .onChange(of: reduceMotion) { _, _ in syncBreathing() }
  }

  /// 「跳过」行。
  ///
  /// 高度**写死**成一条 44pt 的行：最后一页不画「跳过」时，标记不该跟着跳一下（原实现的注释）。
  /// 行本身在 `insets.top` 之下 8pt（原实现 `insets.top + spacing.sm`）。
  @ViewBuilder
  private func skipRow(topInset: CGFloat) -> some View {
    HStack(spacing: 0) {
      Spacer(minLength: 0)
      if !isLastPage {
        Button(action: onDone) {
          Text(model.skipLabel)
            .font(.subheadline)
            .foregroundStyle(OnboardingColor.accent)
            // 命中区 ≥44pt（原 RN 是 `hitSlop: 12`；宽度也要够——「跳过」/「Skip」本身不足 44pt）。
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(OnboardingPressStyle(pressedOpacity: PRESS_CONTROL))
        .accessibilityIdentifier("onboarding-skip")
        .accessibilityLabel(Text(model.skipLabel))
      }
    }
    .frame(height: 44, alignment: .bottom)
    .padding(.horizontal, 16)
    .padding(.top, topInset + 8)
  }

  /// 「标记 + 分页」是一整组，垂直居中；外面这层纵向 ScrollView 是辅助字号下的兜底。
  ///
  /// 为什么不做成"标记钉在最上面、内容填满剩下的空间"：那是一屏 874pt 的 iPhone 上会得到
  /// 两片大空白，看起来像排版没做完。整组居中之后，上下的留白是**一份**，读起来是有意的留白。
  private var bodyRegion: some View {
    GeometryReader { region in
      ScrollView(.vertical) {
        VStack(spacing: 20) {
          mark
          pager
        }
        .frame(maxWidth: .infinity)
        // 放得下就还是居中一屏（原 RN 的 `contentContainerStyle: { flexGrow: 1, justifyContent: 'center' }`），
        // 放不下就能滚。`region` 是这一段的**实际**高度，所以居中不会差一个安全区。
        .frame(minHeight: region.size.height, alignment: .center)
      }
      // 内容放得下时它不该像一张可以扯动的纸（原 RN `bounces={false}`）。
      .scrollBounceBehavior(.basedOnSize)
      .accessibilityIdentifier("onboarding-body")
    }
  }

  /// 品牌标记。
  ///
  /// 资产取不到时退回系统图形 `sparkles`（同 `MemohAvatarView` 的纪律：**不许空方块**）。
  /// 入场（缩放 0.92 → 1 + 淡入）与待机呼吸（×1.03）在这里相乘。
  ///
  /// 不设 `accessibilityHidden`：它是一张没有标签的装饰图（VoiceOver 不会停在它上面），
  /// 而验收脚本按 `onboarding-mark` 找它——藏起来就等于从无障碍树里消失，脚本就找不到了。
  private var mark: some View {
    Group {
      if let image = MemohAssets.image(named: "brand-mark") {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
      } else {
        Image(systemName: "sparkles")
          .font(.system(size: 56))
          .foregroundStyle(OnboardingColor.accent)
      }
    }
    .frame(width: MARK_SIZE, height: MARK_SIZE)
    .scaleEffect(entranceScale * breathScale)
    .opacity(entrance)
    .accessibilityIdentifier("onboarding-mark")
  }

  /// 横向分页器。
  ///
  /// 两个滚动量分工与原 RN 一致：`scrollPosition(id:)` 是"停稳后落在哪一页"（主按钮推进靠它），
  /// 而**页码点与每页的淡入**靠 `onScrollGeometryChange` 给的**连续** `contentOffset.x`
  /// （原 RN 是 `onScroll` 给连续值、`page` 状态给整数页）。
  private var pager: some View {
    ScrollView(.horizontal) {
      HStack(spacing: 0) {
        ForEach(model.pages) { page in
          OnboardingPageContent(page: page, active: page.id == activePageID)
        }
      }
      .scrollTargetLayout()
    }
    .scrollIndicators(.hidden)
    .scrollTargetBehavior(.paging)
    .scrollPosition(id: $pageID)
    .onScrollGeometryChange(for: PagerGeometry.self) { geometry in
      PagerGeometry(offsetX: geometry.contentOffset.x, width: geometry.containerSize.width)
    } action: { _, latest in
      scrollX = latest.offsetX
      pageWidth = latest.width
    }
    // 分页器整体念一句"第几页，共几页"（原 RN 把这条标签挂在分页器上）。
    // 只给容器加标签、**不**合并子元素：每页的标题与正文仍是独立的读屏元素（原实现也没有
    // `accessibilityElementsHidden`，内容才是主角）。
    .accessibilityIdentifier("onboarding-pager")
    .accessibilityLabel(Text(model.progressLabel(page: activeIndex)))
  }

  /// 页码点 + 主按钮。
  ///
  /// 两块都在纵向滚动区**之外**（同原实现）：任何字号下都够得着。整块跟着入场淡入
  /// （原 RN 也给这一层挂了 `opacity: entrance`）。
  @ViewBuilder
  private func bottomBlock(bottomInset: CGFloat) -> some View {
    VStack(spacing: 16) {
      dots
      advanceButton
    }
    .padding(.horizontal, 16)
    .padding(.bottom, bottomInset + 16)
    .opacity(entrance)
  }

  /// 页码点：只表达"这是第几屏"，不给它无障碍标签——内容本身是标题，念一遍"第 2 页，共 3 页"
  /// 是噪音（原实现整组 `accessibilityElementsHidden`）。
  private var dots: some View {
    HStack(spacing: 8) {
      ForEach(model.pages.indices, id: \.self) { index in
        PageDot(index: index, pageWidth: pageWidth, scrollX: scrollX)
      }
    }
    .accessibilityHidden(true)
  }

  /// 主按钮：品牌色胶囊、`onAccent` 字、最小高 50pt（原 RN `styles.advance` 的高度照抄）。
  ///
  /// 最后一页文案换成「开始使用」，按下去与「跳过」发**同一个**事件（原实现两者都调 `onDone`）。
  private var advanceButton: some View {
    Button(action: advance) {
      Text(advanceLabel)
        .font(.headline)
        .foregroundStyle(OnboardingColor.onAccent)
        .frame(maxWidth: .infinity, minHeight: 50)
        .background(OnboardingColor.accent, in: Capsule())
        .contentShape(Capsule())
    }
    .buttonStyle(OnboardingPressStyle(pressedOpacity: PRESS_BUTTON))
    .accessibilityIdentifier("onboarding-advance")
    // 标签就是它自己的文案：读屏念"继续"而不是"按钮"（原 RN 的 accessibilityLabel）。
    .accessibilityLabel(Text(advanceLabel))
  }

  private func advance() {
    // 推进看**停稳**的那一页（`pageID`）而不是连续偏移：连点两下时连续偏移还在路上，
    // 用它会算回同一页，按钮看起来"没反应"。
    let current = model.pages.firstIndex { $0.id == pageID } ?? activeIndex
    guard current < lastIndex else {
      onDone()
      return
    }
    let next = model.pages[current + 1].id
    if reduceMotion {
      pageID = next
      return
    }
    // 原 RN 的 `goTo` 用的是平台滚动动画（没给曲线）；原生用设计基线那条唯一的曲线，时长与
    // 内容上浮一致。
    withAnimation(easeOutExpo(0.4)) { pageID = next }
  }

  /// 入场：0.92 → 1 + 淡入，easeOutExpo 500ms（原 RN 的第一条动效）。Reduce Motion 时直接到终态。
  private func startEntrance() {
    guard !reduceMotion else {
      entrance = 1
      return
    }
    withAnimation(easeOutExpo(0.5)) { entrance = 1 }
  }

  /// 呼吸的起停。
  ///
  /// 只有"这一屏还静止着"（第 0 页）且不要求减少动效时才跑；用户一开始翻页就收掉。
  private func syncBreathing() {
    let wanted = !reduceMotion && activeIndex == 0
    guard wanted != breathing else { return }
    guard wanted else {
      // 收掉：不带动画地回到 1.0（原实现是 `loop.stop()`，会停在半路上；收干净更好看）。
      withAnimation(nil) { breathing = false }
      return
    }
    withAnimation(.easeInOut(duration: 1.3).repeatForever(autoreverses: true)) { breathing = true }
  }
}

/// 模型还没到之前只画底色——与启动屏同色，冷启动不跳色，也不画半截界面。
private struct OnboardingRootView: View {
  @ObservedObject var store: OnboardingStore

  var body: some View {
    content
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(store.background.ignoresSafeArea())
      .preferredColorScheme(store.colorScheme)
  }

  @ViewBuilder private var content: some View {
    if let model = store.model {
      OnboardingScreenView(model: model, onDone: store.onDone)
    } else {
      Color.clear
    }
  }
}

/// 首启引导的 Expo 宿主。
///
/// 原生拥有全部可见 UI 与直接交互（分页、跳过、主按钮）；RN 只留路由、主题模式与文案。
/// 「跳过」与最后一页的主按钮都只发 `onDone`——下一步去哪由 RN 决定（原实现两者都调它）。
final class NativeOnboardingView: ExpoView {
  let onDone = EventDispatcher()

  private let store: OnboardingStore
  private let host: MemohSwiftUIHost<OnboardingRootView>

  required init(appContext: AppContext? = nil) {
    let store = OnboardingStore()
    self.store = store
    host = MemohSwiftUIHost(rootView: OnboardingRootView(store: store))
    super.init(appContext: appContext)
    store.onDone = { [weak self] in self?.onDone([:]) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    host.layout(in: bounds)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    host.updateAttachment(on: self)
  }

  // Expo view props are delivered on the UI queue; the store is @MainActor.
  func setMode(_ value: String) {
    store.mode = MemohAppearanceMode.normalized(value)
    switch store.mode {
    case "light": host.setInterfaceStyle(.light)
    case "dark", "oled": host.setInterfaceStyle(.dark)
    default: host.setInterfaceStyle(.unspecified)
    }
  }

  /// 解析失败就不动界面（`OnboardingStore.setModelJSON`）：宁可停在上一份有效模型上，
  /// 也不要画一个半截的引导。
  ///
  /// 名字与其它原生视图一致（`setModelJSON`）：模块注册那一侧按同一个写法读，两处差一个
  /// 大小写就会在编译期变成一句"failed to produce diagnostic"（实测踩过）。
  func setModelJSON(_ value: String) {
    store.setModelJSON(value)
  }
}
