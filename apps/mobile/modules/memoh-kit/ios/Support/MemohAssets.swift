import UIKit

private final class MemohAssetsMarker {}

/// 原生侧要用到的 App 图片。
///
/// 品牌吉祥物与登录页供应商图标都是 `assets/images/` 的逐字节副本。原生视图拿不到
/// Metro 打包的 RN 资源，两端必须画同一份资产。取不到资源时调用方要能退回系统图形，
/// 不许画空方块。
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
