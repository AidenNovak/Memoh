import ExpoModulesCore
import SwiftUI
import UIKit

/// 通知页的视图模型（RN → 原生）。
///
/// **投递政策不在这里**：三行事件、每行的文案与打扰力度全部由 RN 从
/// `features/notifications/policy.ts`（`NOTIFICATION_EVENTS` / `EVENT_COPY` /
/// `interruptionLevelFor`）算好后下发。原生只画，`enable` 只在授权状态是
/// `notDetermined` 时非 nil——那是 RN `ensurePermission` 的结论，原生不自己判断。
struct NotificationsPageModel: Decodable, Equatable {
  struct Enable: Decodable, Equatable {
    let header: String
    let row: String
    let footer: String
  }

  struct Event: Decodable, Equatable {
    /// 与 `policy.ts` 的 `NotificationEvent` 同一套字面量。
    let id: String
    /// SF Symbol 名（取自 `EVENT_COPY` 的 icon）。
    let symbol: String
    let title: String
    let subtitle: String
    /// 打扰力度的显示名（标准 / 时效性）。
    let value: String
  }

  let title: String
  let backLabel: String
  /// 空 = 不显示"开启通知"那一组（已经问过或已有授权）。
  let enable: Enable?
  let eventsHeader: String
  let events: [Event]
  let eventsFooter: String
  let systemHeader: String
  let systemRow: String
  let systemFooter: String

  static func decode(_ json: String) throws -> NotificationsPageModel {
    try JSONDecoder().decode(NotificationsPageModel.self, from: Data(json.utf8))
  }
}

/// 通知页的桥接状态。
@MainActor
private final class NotificationsPageStore: ObservableObject {
  @Published var model: NotificationsPageModel?
  @Published var mode = "system"

  var onRequestPermission: () -> Void = {}
  var onBack: () -> Void = {}

  var title: String { model?.title ?? "" }
  var backLabel: String { model?.backLabel ?? "" }
  var colorScheme: ColorScheme? { MemohAppearanceMode.colorScheme(mode) }
  var formBackground: Color { MemohAppearanceMode.formBackground(mode) }

  /// 直接打开本 App 的 iOS 设置页。
  ///
  /// HIG *Managing notifications* 要求 App 给出"去哪儿改"的路径；权限、横幅、声音、
  /// 专注模式都归系统管，App 自己改不了，所以这里只能把用户送过去。失败也不提示：
  /// 这个动作的失败形态只有"系统设置没打开"，再弹一个错误框只是多一次打扰。
  func openSystemSettings() {
    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
    UIApplication.shared.open(url, options: [:], completionHandler: nil)
  }
}

/// 一行可点、带 chevron 的行（≥44pt 触控目标）。
private struct NotificationsRow: View {
  let title: String
  let identifier: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        Text(title)
        Spacer(minLength: 8)
        Image(systemName: "chevron.forward")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(.tertiary)
          .accessibilityHidden(true)
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier(identifier)
  }
}

/// 投递政策行：图标 + 标题 + 说明 + 打扰力度。
///
/// **不是开关**（真正的开关只有 iOS 系统权限）：行本身不可点，右侧写的是这件事会以什么
/// 力度打扰。读屏读成一句完整的话（标题 + 说明 + 力度）。
private struct EventPolicyRow: View {
  let event: NotificationsPageModel.Event

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: event.symbol)
        .font(.body)
        .foregroundStyle(.secondary)
        .frame(width: 22)
      VStack(alignment: .leading, spacing: 2) {
        Text(event.title)
          .fixedSize(horizontal: false, vertical: true)
        Text(event.subtitle)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        if dynamicTypeSize.isAccessibilitySize {
          Text(event.value)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      if !dynamicTypeSize.isAccessibilitySize {
        Spacer(minLength: 8)
        Text(event.value)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .frame(minHeight: 44)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("notifications-event-\(event.id)")
  }
}

/// 通知页（从设置 push 进来）。
private struct NotificationsPageView: View {
  @ObservedObject var store: NotificationsPageStore

  var body: some View {
    NavigationStack {
      Form {
        if let model = store.model {
          enableSection(model.enable)
          Section {
            ForEach(model.events, id: \.id) { event in
              EventPolicyRow(event: event)
            }
          } header: {
            Text(model.eventsHeader)
          } footer: {
            Text(model.eventsFooter)
          }
          Section {
            NotificationsRow(
              title: model.systemRow,
              identifier: "notifications-system-settings"
            ) {
              store.openSystemSettings()
            }
          } header: {
            Text(model.systemHeader)
          } footer: {
            Text(model.systemFooter)
          }
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
          .accessibilityIdentifier("notifications-back")
          .accessibilityLabel(store.backLabel)
        }
      }
    }
    .preferredColorScheme(store.colorScheme)
  }

  @ViewBuilder
  private func enableSection(_ enable: NotificationsPageModel.Enable?) -> some View {
    // 只在"还没被问过"时出现：被拒之后系统不会再弹框，这一行留着只会缠人
    // （冷却与封顶仍归 RN 的 `policy.permissionActionFor` 管）。
    if let enable {
      Section {
        NotificationsRow(title: enable.row, identifier: "notifications-enable") {
          store.onRequestPermission()
        }
      } header: {
        Text(enable.header)
      } footer: {
        Text(enable.footer)
      }
    }
  }
}

/// 通知页的 Expo 宿主。
///
/// 原生拥有可见 UI 与直接交互（权限请求、系统设置跳转、返回）；RN 只留路由、授权状态
/// 与文案。权限请求只上报"用户点了"这件事——请求本身与请求史仍由 RN 的
/// `features/notifications/bridge.ts` 执行。
final class NativeNotificationsView: ExpoView {
  let onRequestPermission = EventDispatcher()
  let onBack = EventDispatcher()

  private let store: NotificationsPageStore
  private let host: MemohSwiftUIHost<NotificationsPageView>

  required init(appContext: AppContext? = nil) {
    let store = NotificationsPageStore()
    self.store = store
    host = MemohSwiftUIHost(rootView: NotificationsPageView(store: store))
    super.init(appContext: appContext)
    store.onRequestPermission = { [weak self] in self?.onRequestPermission([:]) }
    store.onBack = { [weak self] in self?.onBack([:]) }
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

  /// 解析失败就不动界面：宁可停在上一份模型上，也不要画一个半截的列表。
  func setViewModelJSON(_ value: String) {
    guard let decoded = try? NotificationsPageModel.decode(value) else { return }
    store.model = decoded
  }
}
