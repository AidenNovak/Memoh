import Foundation
import SwiftUI
import UIKit

/// Hub 顶层件的视图模型（RN → 原生）。Files / Schedule 两个视图共用这一份
///（Sessions 早在模块 4 就有自己的等价物，本文件不回去动它）。
///
/// ## 为什么单开一份而不是让两个视图各画一遍
///
/// 这一屏的三个视图（会话 / 文件 / 定时）共用同一套顶层件：大标题、视图切换、agent 行、
/// 连接状态、新建会话。它们在 RN 侧本来就是 `SessionsHubScreen` 的一个壳。壳原生化之后，
/// 如果 Files 与 Schedule 各自抄一份，两边的选项文案、选中态、无障碍标识就会各走各的，
/// 而"同一个东西在两个视图里长得不一样"正是这次迁移要消灭的问题。
///
/// ## 为什么不 import ExpoModulesCore
///
/// 与 `ChatSheets` 同一个理由：契约与画法只依赖 SwiftUI/UIKit，事件用回调注入。
/// 这样它能在本机用 `swiftc -typecheck` 独立检查（见 `tools/typecheck-kit.sh`），
/// 不必等一次完整 Xcode 构建；也让它不被 Expo 的事件系统绑住。
///
/// ## 字段全为必填（`connection` 除外）
///
/// RN 是权威：文案、选中态、`viewPickerVisible` 的判据（`hubViews.count > 1`）都由 RN 算好。
/// 原生**不做判断**（不自己数 `views.count`、不自己挑选中项），否则判据就有两份实现。
/// 少字段 = 桥契约破了：解码失败时保留上一份模型（见各 store 的 `setModelJSON`），
/// 宁可停在旧画面上，也不画一个猜出来的壳。
struct HubChromeModel: Decodable, Equatable {
  /// 视图切换的一个选项。`id` 是 RN 的 `HubView`（`sessions | files | schedule`）。
  struct ViewOption: Decodable, Equatable, Identifiable {
    let id: String
    let label: String
    /// SF Symbol 名（RN 查好表下发，原生不查表）。
    let symbol: String
    let selected: Bool
  }

  /// agent 行的一个选项。`id == "__new__"` 是"新建 agent"入口（判据在 RN）。
  struct BotOption: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
    /// 空串 = 不显示次级行。
    let statusLabel: String
    let selected: Bool
  }

  /// 连接状态行。`nil` = 一切正常，不画这一行。
  struct Connection: Decodable, Equatable {
    let label: String
    /// 空串 = 没有第二行（例如只读档的提示）。
    let pendingLabel: String
    /// 无障碍提示（点这一行会发生什么）。
    let retryHint: String
  }

  /// 当前视图名（大标题）。
  let title: String
  /// `hubViews.count > 1` 才 true；false 时整个分段控件不画（只有一个视图时它没有意义）。
  let viewPickerVisible: Bool
  let views: [ViewOption]
  let bots: [BotOption]
  let viewMenuLabel: String
  let botMenuLabel: String
  let newBotLabel: String
  let newSessionLabel: String
  let showNewSession: Bool
  /// 与 RN `connectionModel` 一致：只读 / 未连接 / 有待发时非 nil。
  let connection: Connection?

  static func decode(_ json: String) throws -> HubChromeModel {
    try JSONDecoder().decode(Self.self, from: Data(json.utf8))
  }
}

/// 视图切换（List 里的第一个 Section，分段控件）。
///
/// 形态与 `NativeSessionsView` 的 `viewPicker` 逐行一致：同一屏的三个视图共用同一行，
/// 两边画得不一样就会在切视图时"跳"一下。选中态变化只上报 id，不自己改模型——
/// 模型是 RN 下发的，等它回来再画（切视图本身会换掉整份模型）。
struct HubChromePicker: View {
  let model: HubChromeModel
  let onSelectView: (String) -> Void

  var body: some View {
    if model.viewPickerVisible {
      Section {
        Picker(model.viewMenuLabel, selection: Binding(
          get: { model.views.first(where: \.selected)?.id ?? model.views.first?.id ?? "" },
          set: { onSelectView($0) }
        )) {
          ForEach(model.views) { view in
            Label(view.label, systemImage: view.symbol).tag(view.id)
          }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("hub-view-picker")
      }
    }
  }
}

/// 连接状态行：`connection` 非 nil 时占一行，整行可点 → 重试。
///
/// 画法与 `NativeSessionsView` 的 `connectionSection` 一致（警告图标 + 主文案 + 可选次级行）。
/// 整行是按钮而不是只有右边一颗"重试"：这一行在屏幕上只有一个意思——"这里出问题了，
/// 点一下重来"；多一颗小按钮只会多一个更小的命中区。
struct HubChromeConnectionRow: View {
  let model: HubChromeModel
  let onRetry: () -> Void

  var body: some View {
    if let connection = model.connection {
      Section {
        Button(action: onRetry) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
              .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
              Text(connection.label)
              if !connection.pendingLabel.isEmpty {
                Text(connection.pendingLabel).font(.footnote).foregroundStyle(.secondary)
              }
            }
          }
          .frame(minHeight: 44, alignment: .leading)
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text(connection.retryHint))
        .accessibilityIdentifier("hub-connection")
      }
    }
  }
}

/// agent 菜单（toolbar leading 用）。
///
/// 与 `NativeSessionsView` 的 `botMenu` 同一个形态，只多一处：label 印出**当前 agent 名**。
/// 这一屏的壳原生化之后，"现在是谁"只在这一颗菜单上有；只画一个人形图标的话，用户得点开
/// 才知道当前是哪个 agent（Sessions 那边由它自己的壳负责，本文件不回去改它）。
///
/// 末尾固定一条"新建 agent"（`__new__`）——判据与文案都由 RN 给，原生只转发 id。
struct HubChromeBotMenu: View {
  let model: HubChromeModel
  let onSelectBot: (String) -> Void

  var body: some View {
    if !model.bots.isEmpty {
      Menu {
        ForEach(model.bots) { bot in
          Button {
            onSelectBot(bot.id)
          } label: {
            Label(bot.name, systemImage: bot.selected ? "checkmark" : "person")
          }
          .accessibilityHint(Text(bot.statusLabel))
        }
        Button(model.newBotLabel) { onSelectBot("__new__") }
      } label: {
        // 纯图标，与 Sessions 的 botMenu 一致（同一屏三个视图的 chrome 要长得一样）。
        Image(systemName: "person.crop.circle")
      }
      .accessibilityLabel(Text(model.botMenuLabel))
      .accessibilityIdentifier("hub-bot-menu")
    }
  }
}

/// 新建会话（toolbar trailing 用）。
///
/// `showNewSession == false` 时整颗不画（判据在 RN：例如只读档不给这个入口）。
/// 图标与 Sessions 的 `square.and.pencil` 一致；标识 `hub-new-session` 与 Schedule 自带的
/// `schedule-new` 区分开——两者在同一根 toolbar 上共存。
struct HubChromeNewSessionButton: View {
  let model: HubChromeModel
  let onNewSession: () -> Void

  var body: some View {
    if model.showNewSession {
      Button(action: onNewSession) {
        Image(systemName: "square.and.pencil")
      }
      .accessibilityLabel(Text(model.newSessionLabel))
      .accessibilityIdentifier("hub-new-session")
    }
  }
}
