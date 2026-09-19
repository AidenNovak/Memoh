import Foundation

private final class MemohBundleMarker {}

enum MemohStrings {
  static let bundle: Bundle = {
    let owner = Bundle(for: MemohBundleMarker.self)
    guard let url = owner.url(forResource: "MemohKitStrings", withExtension: "bundle"),
          let bundle = Bundle(url: url) else { return owner }
    return bundle
  }()

  static func text(_ key: String) -> String {
    NSLocalizedString(key, bundle: bundle, comment: "")
  }
}
