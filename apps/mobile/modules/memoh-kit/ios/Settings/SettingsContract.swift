import Foundation

/// 设置页的视图模型（RN → 原生）。
///
/// 内容全部由 RN 算好：名字/状态/副标题走 `features/bots/*` 的既有 helper，文案走
/// `lib/i18n`，头像走 `features/bots/avatar.ts` 的归一化计划。原生**不认识 bot、不认识
/// i18n、也不认识路由**——它只画这一份模型，并把点击回成事件。
///
/// 复杂的部分（语言选项、头像计划）以 JSON 字符串过桥（`AGENTS.md`：复杂数组走 JSON）。
struct SettingsViewModel: Decodable, Equatable {
  struct Avatar: Decodable, Equatable {
    enum Kind: String, Decodable { case mark, builtin, remote }

    let kind: Kind
    /// `builtin` 时的 SF Symbol 名。由 RN 的内置头像表给出，原生**不复制**那张表。
    let symbol: String?
    /// `remote` 时的图片地址。**不会**是 `memoh:` 这类内部标识——RN 已经归一化过，
    /// 原生不会为一个假地址发请求。
    let uri: String?
    /// RN 实时连接恢复时变为 true；远程头像失败后据此最多重试一次。
    let connectionOpen: Bool
  }

  struct Agent: Decodable, Equatable {
    let header: String
    let name: String
    /// 状态徽章文案；空串 = 不显示徽章（认不出状态时就是这样）。
    let statusLabel: String
    /// `success | warning | muted`，与 RN `STATUS_COLOR_KEY` 同一套字面量。
    let statusColor: String
    /// 时区 / 待审批条数，RN 已用 ` · ` 连好；空串 = 不显示副标题。
    let subtitle: String
    /// VoiceOver 提示（"这是个按钮，按了能换"）。
    let hint: String
    let avatar: Avatar
  }

  struct Appearance: Decodable, Equatable {
    let header: String
    let title: String
    let value: String
  }

  struct Language: Decodable, Equatable {
    struct Option: Decodable, Equatable {
      let id: String
      /// 语言名一律用**它自己的语言**写（English / 简体中文），RN 那边就是这么给的。
      let label: String
      let selected: Bool
    }

    let header: String
    let options: [Option]
  }

  struct Notifications: Decodable, Equatable {
    let title: String
    let footer: String
  }

  struct Account: Decodable, Equatable {
    let header: String
    /// 空串 = 不显示身份行（Keychain 里没有 profile 时）。
    let name: String
    let role: String
    let signOutTitle: String
    let signOutMessage: String
    let cancelLabel: String
  }

  struct About: Decodable, Equatable {
    let header: String
    let versionLabel: String
    /// 空串 = 不显示版本行（`expoConfig.version` 取不到时）。
    let versionValue: String
    let serverLabel: String
    let serverValue: String
  }

  let title: String
  let agent: Agent
  /// 有 `manage` 权限才有这一行（判据在 RN `features/bots/permissions.ts`）；
  /// `nil` = 不渲染，而不是渲染一个灰掉的入口。
  let botSettingsTitle: String?
  let appearance: Appearance
  let language: Language
  let notifications: Notifications
  let account: Account
  let about: About

  static func decode(_ json: String) throws -> SettingsViewModel {
    try JSONDecoder().decode(SettingsViewModel.self, from: Data(json.utf8))
  }
}
