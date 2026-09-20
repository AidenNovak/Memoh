import ExpoModulesCore
import UIKit

/// 启动期挂钩。
///
/// ## 为什么需要它，而不是只靠模块的 `OnCreate`
///
/// `UNUserNotificationCenterDelegate` 的文档把时序写死了：**"The delegate must be set
/// before the application returns from `application:didFinishLaunchingWithOptions:`"**。
/// 冷启动时用户点通知那一下，系统只交给那一刻已在位的代理。而模块的 `OnCreate` 发生在
/// JS 运行时起来之后——比启动返回晚，靠它就等于**丢掉冷启动那次点击**，那正好是审批
/// 推送最要紧的一次。
///
/// `ExpoAppDelegate` 会把 `didFinishLaunchingWithOptions` / `didRegister…` /
/// `didFailToRegister…` 转发给注册的 subscriber（`ExpoAppDelegateSubscriberManager`），
/// 所以这里的挂钩是 Expo 官方支持的那条路，不是绕过它。
///
/// ## 设备 token 从这里出去
///
/// `application:didRegisterForRemoteNotificationsWithDeviceToken:` 只有 AppDelegate
/// 收得到。**token 不进日志**（它能直接向这台设备投递），只走事件出口交给 JS。
public final class MemohNotificationsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    MemohNotifications.shared.install()
    // false = 不接管启动，让 Expo 与其他 subscriber 照常处理。
    return false
  }

  public func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    MemohNotifications.shared.handleDeviceToken(deviceToken)
  }

  public func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: any Error
  ) {
    MemohNotifications.shared.handleRegistrationFailure(error.localizedDescription)
  }
}
