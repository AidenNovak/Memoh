import UIKit

private final class MemohAssetsMarker {}

/// 原生侧要用到的 App 图片。
///
/// 目前只有一枚：品牌吉祥物（`assets/images/brand-mark.png` 的副本，见
/// `Support/Resources/Assets/`）。原生视图拿不到 Metro 打包的 RN 资源，而设置页 agent
/// 卡片上的头像必须与 RN 的 `BotAvatar` 走**同一枚图形**——两端各画一个东西正是那个
/// "这里一枚、那里一个灰方块"的老问题。取不到资源时调用方要能退回系统图形，不许画空方块。
enum MemohAssets {
  static let bundle: Bundle = {
    let owner = Bundle(for: MemohAssetsMarker.self)
    guard let url = owner.url(forResource: "MemohKitAssets", withExtension: "bundle"),
          let bundle = Bundle(url: url) else { return owner }
    return bundle
  }()

  static func image(named name: String) -> UIImage? {
    let candidate = name as NSString
    let resource = candidate.deletingPathExtension
    let fileExtension = candidate.pathExtension.isEmpty ? "png" : candidate.pathExtension
    guard let url = bundle.url(forResource: resource, withExtension: fileExtension) else { return nil }
    // CocoaPods packages this as a loose PNG; avoid probing for an asset catalog that is not present.
    return UIImage(contentsOfFile: url.path)
  }
}
