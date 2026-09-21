import Foundation

/// 一页引导。
struct OnboardingPageModel: Decodable, Equatable, Identifiable {
  /// 稳定 id：原生用它认「动效集中的那一页」（`EMPHASIS_PAGE`），也用它做分页器的滚动目标。
  let id: String
  /// SF Symbol 名，RN 从 `ONBOARDING_PAGES` **原样**给。原生不查表——查表就多一份会漂的名单。
  let symbol: String
  let title: String
  let body: String
}

/// 首启引导的契约（RN → 原生）。
///
/// 内容全由 RN 算好：页序、符号、文案（i18n 在 RN）、三个按钮标签。原生不认识 i18n，
/// 也不认识路由——它只画这一份模型，并把「跳过 / 开始使用」回成一个 `onDone` 事件。
///
/// ## `progressFormat` 为什么是模板而不是成品（本模块唯一一处契约调整）
///
/// 分页器的读屏标签要念出**当前页**（"第 2 页，共 3 页"），而当前页是**原生**在翻页时
/// 才知道的：RN 送不下一个会自己变的字符串。所以契约送模板 + 总页数，由原生把
/// `{{current}}` / `{{total}}` 换掉（`progressLabel(page:)`）。
///
/// 占位符沿用**项目自己的 i18n 语法**（`lib/i18n` 的 `{{name}}`），不另造一套 `%1$d`：
/// 文案的真源是 `locales/*.json`，`onboarding.progress` 的值就是
/// `"第 {{current}} 页，共 {{total}} 页"`。RN 侧把这条文案**原样**下发（不插值、不做字符串
/// 手术），原生只做一次机械替换——两边都不需要认识第二种模板语法。
struct OnboardingModel: Decodable, Equatable {
  let pages: [OnboardingPageModel]
  /// 右上角「跳过」。最后一页不画它（那时主按钮就是「开始使用」）。
  let skipLabel: String
  let nextLabel: String
  let startLabel: String
  /// 读屏模板，含 `{{current}}` / `{{total}}`。
  let progressFormat: String
  /// 总页数。与 `pages` **同源**（RN 两处都取 `ONBOARDING_PAGES.length`），
  /// 原生拿它替换 `{{total}}`，不再自己数一遍。
  let pageCount: Int

  static func decode(_ json: String) throws -> OnboardingModel {
    let model = try JSONDecoder().decode(OnboardingModel.self, from: Data(json.utf8))
    // 空页表是契约违约（分页器一页都没有、页码点一个都不画）。宁可整屏停在底色上，
    // 也不要画一个"有按钮、没内容"的引导。
    guard !model.pages.isEmpty else {
      throw DecodingError.dataCorrupted(
        DecodingError.Context(
          codingPath: [],
          debugDescription: "onboarding pages is empty"
        )
      )
    }
    return model
  }

  /// 第 `page` 页（0 起）的读屏标签。
  func progressLabel(page: Int) -> String {
    progressFormat
      .replacingOccurrences(of: "{{current}}", with: String(page + 1))
      .replacingOccurrences(of: "{{total}}", with: String(pageCount))
  }
}
