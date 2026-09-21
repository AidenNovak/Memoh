import Foundation

/// 头像计划（RN → 原生）。
///
/// 与 RN `features/bots/avatar.ts` 的 `AvatarPlan` 一一对应，由 RN 归一化后下发：
/// 远程图 / 内置头像（SF Symbol + 品牌淡底）/ 吉祥物。原生**不会**为 `memoh:` 这类
/// 内部标识发请求（RN 已经把它翻成内置头像或吉祥物）。
struct MemohAvatarPlan: Decodable, Equatable {
  enum Kind: String, Decodable { case mark, builtin, remote }

  let kind: Kind
  /// `builtin` 时的 SF Symbol 名。由 RN 的内置头像表给出，原生**不复制**那张表。
  let symbol: String?
  /// `remote` 时的图片地址。
  let uri: String?
  /// RN 实时连接恢复时变为 true；远程头像失败后据此最多重试一次。
  let connectionOpen: Bool
}
