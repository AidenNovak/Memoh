import SwiftUI
import UIKit

/// 把一个 SwiftUI 页挂进 RN 视图树的挂载器。
///
/// 三个原生页（外观 / 设置 / 通知）共用同一段生命周期：建 hosting controller、按 bounds
/// 布局、在 `didMoveToWindow` 时挂到最近的父 view controller 上。`ExpoView` 是 UIView
/// 子类、`required init(appContext:)` 只能在子类里跑，基类没法泛型化，所以这段抽成助手、
/// 由各宿主转调，避免三份各写一遍再各自漂移。
@MainActor
final class MemohSwiftUIHost<Content: View> {
  private let controller: UIHostingController<Content>

  init(rootView: Content) {
    controller = UIHostingController(rootView: rootView)
    controller.view.backgroundColor = .clear
    controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
  }

  /// 主题模式由 RN 下发；这里只覆盖有明确档位的界面样式。
  func setInterfaceStyle(_ style: UIUserInterfaceStyle) {
    controller.overrideUserInterfaceStyle = style
  }

  func layout(in bounds: CGRect) {
    controller.view.frame = bounds
  }

  /// 视图进/出窗口时调用：挂上或摘掉 hosting controller。
  func updateAttachment(on owner: UIView) {
    guard owner.window != nil, let parent = Self.nearestViewController(from: owner) else {
      detach()
      return
    }
    guard controller.parent !== parent || controller.view.superview !== owner else { return }

    detach()
    parent.addChild(controller)
    owner.addSubview(controller.view)
    controller.didMove(toParent: parent)
    controller.view.frame = owner.bounds
  }

  private func detach() {
    guard controller.parent != nil || controller.view.superview != nil else { return }
    controller.willMove(toParent: nil)
    controller.view.removeFromSuperview()
    controller.removeFromParent()
  }

  private static func nearestViewController(from owner: UIView) -> UIViewController? {
    var responder: UIResponder? = owner
    while let next = responder?.next {
      if let controller = next as? UIViewController { return contentController(from: controller) }
      responder = next
    }
    let root = owner.window?.rootViewController
    return contentController(from: root?.presentedViewController ?? root)
  }

  private static func contentController(from controller: UIViewController?) -> UIViewController? {
    if let navigation = controller as? UINavigationController {
      return contentController(from: navigation.visibleViewController) ?? navigation
    }
    if let tabs = controller as? UITabBarController {
      return contentController(from: tabs.selectedViewController) ?? tabs
    }
    return controller
  }
}
