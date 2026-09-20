import ExpoModulesCore

public final class MemohKitModule: Module, @unchecked Sendable {
  public func definition() -> ModuleDefinition {
    Name("MemohKit")

    // 推送链路的事件出口。判据（什么时候打扰、前台弹不弹、徽标是什么语义）全在
    // `src/features/notifications/policy.ts`；这里只把系统给的东西报上去。
    Events(
      "onNotificationPresented",
      "onNotificationOpened",
      "onRemoteToken",
      "onRemoteRegistrationFailed"
    )

    OnCreate {
      // 代理在 AppDelegate subscriber 里已经装过（冷启动必须更早）；这里再装一次是
      // 幂等的兜底，并接上事件出口。
      MemohNotifications.shared.install()
      MemohNotifications.shared.attach { [weak self] name, payload in
        self?.sendEvent(name, payload)
      }
    }

    // MARK: - Authentication and Keychain

    // These methods keep the temporary RN session/cache bridge small while native code owns the
    // actual Keychain item. The JSON shape is validated on both sides of the bridge.
    AsyncFunction("authLoadSession") { () throws -> String? in
      try AuthKeychain.shared.loadJSON()
    }

    AsyncFunction("authSaveSession") { (json: String) throws in
      try AuthKeychain.shared.save(json: json)
    }

    AsyncFunction("authClearSession") {
      try AuthKeychain.shared.clear()
    }

    // MARK: - 推送（薄壳，每个函数只有一句；解析与映射在 NotificationContract）

    AsyncFunction("notificationsAuthorizationStatus") { () async -> String in
      await MemohNotifications.shared.authorizationStatus().rawValue
    }

    AsyncFunction("notificationsRequestAuthorization") { (options: [String]) async -> String in
      let requested = NotificationContract.authorizationOptions(named: options)
      return await MemohNotifications.shared.requestAuthorization(options: requested).rawValue
    }

    // 必须在主线程：`UIApplication.registerForRemoteNotifications()` 是 UI 侧的调用。
    // `runOnQueue` 是接在闭包**之后**的修饰（返回的仍是 definition）。
    AsyncFunction("notificationsRegisterForRemoteNotifications") {
      MemohNotifications.shared.registerForRemoteNotifications()
    }.runOnQueue(.main)

    AsyncFunction("notificationsRegisterCategories") { (json: String) in
      MemohNotifications.shared.registerCategories(NotificationContract.categories(fromJSON: json))
    }

    AsyncFunction("notificationsResolvePresentation") { (json: String) in
      guard let resolution = NotificationContract.presentationResolution(fromJSON: json) else {
        // 解析不出来就不猜：没答复等于"不呈现"，这与前台判据一致。
        return
      }
      MemohNotifications.shared.resolvePresentation(
        requestId: resolution.requestId,
        options: resolution.options
      )
    }

    AsyncFunction("notificationsSetBadgeCount") { (count: Int) async in
      await MemohNotifications.shared.setBadgeCount(count)
    }

    AsyncFunction("notificationsTakePendingOpen") { () -> [String: Any]? in
      MemohNotifications.shared.takePendingOpen()
    }

    View(NativeAppearanceView.self) {
      Events("onModeChange", "onBack")
      Prop("mode") { (view: NativeAppearanceView, value: String) in
        view.setMode(value)
      }
      Prop("title") { (view: NativeAppearanceView, value: String) in
        view.setTitle(value)
      }
      Prop("sectionTitle") { (view: NativeAppearanceView, value: String) in
        view.setSectionTitle(value)
      }
      Prop("backLabel") { (view: NativeAppearanceView, value: String) in
        view.setBackLabel(value)
      }
      Prop("systemLabel") { (view: NativeAppearanceView, value: String) in
        view.setSystemLabel(value)
      }
      Prop("lightLabel") { (view: NativeAppearanceView, value: String) in
        view.setLightLabel(value)
      }
      Prop("darkLabel") { (view: NativeAppearanceView, value: String) in
        view.setDarkLabel(value)
      }
      Prop("trueBlackLabel") { (view: NativeAppearanceView, value: String) in
        view.setTrueBlackLabel(value)
      }
      Prop("trueBlackFooter") { (view: NativeAppearanceView, value: String) in
        view.setTrueBlackFooter(value)
      }
    }

    View(NativeSettingsView.self) {
      Events(
        "onOpenAgentSwitcher",
        "onOpenBotSettings",
        "onOpenAppearance",
        "onSelectLocale",
        "onOpenNotifications",
        "onSignOut"
      )
      Prop("mode") { (view: NativeSettingsView, value: String) in
        view.setMode(value)
      }
      Prop("viewModelJson") { (view: NativeSettingsView, value: String) in
        view.setViewModelJSON(value)
      }
    }

    View(NativeNotificationsView.self) {
      Events("onRequestPermission", "onBack")
      Prop("mode") { (view: NativeNotificationsView, value: String) in
        view.setMode(value)
      }
      Prop("viewModelJson") { (view: NativeNotificationsView, value: String) in
        view.setViewModelJSON(value)
      }
    }

    View(NativeLoginView.self) {
      Events("onSignedIn")
      Prop("mode") { (view: NativeLoginView, value: String) in
        view.setMode(value)
      }
      Prop("viewModelJson") { (view: NativeLoginView, value: String) in
        view.setViewModelJSON(value)
      }
    }

    View(NativeMessageList.self) {
      Events("onReachTop", "onErrorAction", "onMessageCopied")
      Prop("turnsJson") { (view: NativeMessageList, value: String) in
        view.setTurnsJSON(value)
      }
      Prop("errorActionEnabled") { (view: NativeMessageList, value: Bool) in
        view.errorActionEnabled = value
      }
      Prop("emptyTitle") { (view: NativeMessageList, value: String) in
        view.emptyTitle = value
      }
      Prop("emptyBody") { (view: NativeMessageList, value: String) in
        view.emptyBody = value
      }
    }
  }
}
