import ExpoModulesCore
import SwiftUI
import UIKit

/// 外观页的桥接状态。取值与上报只认 `system | light | dark | oled`。
@MainActor
private final class AppearanceStore: ObservableObject {
  static let validModes: Set<String> = ["system", "light", "dark", "oled"]

  @Published var mode = "system"
  @Published var title = ""
  @Published var sectionTitle = ""
  @Published var backLabel = ""
  @Published var systemLabel = ""
  @Published var lightLabel = ""
  @Published var darkLabel = ""
  @Published var trueBlackLabel = ""
  @Published var trueBlackFooter = ""

  var onSelectMode: (String) -> Void = { _ in }
  var onToggleTrueBlack: (Bool) -> Void = { _ in }
  var onBack: () -> Void = {}

  var colorScheme: ColorScheme? {
    switch mode {
    case "light": .light
    case "dark", "oled": .dark
    default: nil
    }
  }

  var formBackground: Color {
    switch mode {
    case "oled": .black
    case "light": Color(uiColor: MemohPalette.background(.init(userInterfaceStyle: .light)))
    case "dark": Color(uiColor: MemohPalette.background(.init(userInterfaceStyle: .dark)))
    default: Color(uiColor: UIColor { MemohPalette.background($0) })
    }
  }

  func setMode(_ value: String) {
    mode = Self.validModes.contains(value) ? value : "system"
  }
}

/// `oled` 投影为 Dark 选中 + 真黑开启；权威状态仍由 RN `ThemeProvider` 持有。
private struct AppearanceFormView: View {
  @ObservedObject var store: AppearanceStore

  private var selection: String {
    store.mode == "oled" ? "dark" : store.mode
  }

  var body: some View {
    NavigationStack {
      Form {
        Section(store.sectionTitle) {
          Picker(
            selection: Binding(
              get: { selection },
              set: { store.onSelectMode($0) }
            ),
            label: EmptyView()
          ) {
            Text(store.systemLabel)
              .tag("system")
              .accessibilityIdentifier("appearance-system")
            Text(store.lightLabel)
              .tag("light")
              .accessibilityIdentifier("appearance-light")
            Text(store.darkLabel)
              .tag("dark")
              .accessibilityIdentifier("appearance-dark")
          }
          .pickerStyle(.inline)
          .labelsHidden()
        }
        Section {
          LabeledContent(store.trueBlackLabel) {
            Toggle(
              isOn: Binding(
                get: { store.mode == "oled" },
                set: { store.onToggleTrueBlack($0) }
              )
            ) {
              EmptyView()
            }
            .accessibilityIdentifier("appearance-true-black-switch")
          }
          .accessibilityElement(children: .contain)
          .accessibilityIdentifier("appearance-true-black")
        } footer: {
          Text(store.trueBlackFooter)
        }
      }
      .scrollContentBackground(.hidden)
      .background(store.formBackground)
      .navigationTitle(store.title)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button(action: store.onBack) {
            Image(systemName: "chevron.left")
          }
          .accessibilityIdentifier("appearance-back")
          .accessibilityLabel(store.backLabel)
        }
      }
    }
    .preferredColorScheme(store.colorScheme)
  }
}

/// 外观设置页的 Expo 宿主。
///
/// 原生拥有全部可见 UI 与交互（含返回按钮）；RN 只留路由、主题状态与文案。
/// 模式变化经 `onModeChange` 上报（载荷 `mode`，只会是四个合法值之一），
/// 由 RN 校验后交给 `setMode`。
final class NativeAppearanceView: ExpoView {
  let onModeChange = EventDispatcher()
  let onBack = EventDispatcher()

  private let store: AppearanceStore
  private let host: UIHostingController<AppearanceFormView>

  required init(appContext: AppContext? = nil) {
    let store = AppearanceStore()
    self.store = store
    host = UIHostingController(rootView: AppearanceFormView(store: store))
    super.init(appContext: appContext)
    store.onSelectMode = { [weak self] mode in
      // Picker 只会给出三个 tag 之一，但这里仍按契约再过一遍，保证出口干净。
      guard AppearanceStore.validModes.contains(mode) else { return }
      self?.onModeChange(["mode": mode])
    }
    store.onToggleTrueBlack = { [weak self] on in
      self?.onModeChange(["mode": on ? "oled" : "dark"])
    }
    store.onBack = { [weak self] in
      self?.onBack([:])
    }
    host.view.backgroundColor = .clear
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    host.view.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()

    guard window != nil, let parent = nearestViewController() else {
      detachHost()
      return
    }
    guard host.parent !== parent || host.view.superview !== self else { return }

    detachHost()
    parent.addChild(host)
    addSubview(host.view)
    host.didMove(toParent: parent)
    host.view.frame = bounds
  }

  private func detachHost() {
    guard host.parent != nil || host.view.superview != nil else { return }
    host.willMove(toParent: nil)
    host.view.removeFromSuperview()
    host.removeFromParent()
  }

  private func nearestViewController() -> UIViewController? {
    var responder: UIResponder? = self
    while let next = responder?.next {
      if let controller = next as? UIViewController { return contentController(from: controller) }
      responder = next
    }
    let root = window?.rootViewController
    return contentController(from: root?.presentedViewController ?? root)
  }

  private func contentController(from controller: UIViewController?) -> UIViewController? {
    if let navigation = controller as? UINavigationController {
      return contentController(from: navigation.visibleViewController) ?? navigation
    }
    if let tabs = controller as? UITabBarController {
      return contentController(from: tabs.selectedViewController) ?? tabs
    }
    return controller
  }

  // Expo view props are delivered on the UI queue; the store is @MainActor.
  func setMode(_ value: String) {
    store.setMode(value)
    switch store.mode {
    case "light": host.overrideUserInterfaceStyle = .light
    case "dark", "oled": host.overrideUserInterfaceStyle = .dark
    default: host.overrideUserInterfaceStyle = .unspecified
    }
  }
  func setTitle(_ value: String) { store.title = value }
  func setSectionTitle(_ value: String) { store.sectionTitle = value }
  func setBackLabel(_ value: String) { store.backLabel = value }
  func setSystemLabel(_ value: String) { store.systemLabel = value }
  func setLightLabel(_ value: String) { store.lightLabel = value }
  func setDarkLabel(_ value: String) { store.darkLabel = value }
  func setTrueBlackLabel(_ value: String) { store.trueBlackLabel = value }
  func setTrueBlackFooter(_ value: String) { store.trueBlackFooter = value }
}
