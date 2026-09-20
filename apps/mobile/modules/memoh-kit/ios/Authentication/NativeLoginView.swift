import ExpoModulesCore
import SwiftUI
import UIKit

struct LoginPageModel: Decodable, Equatable {
  struct Cloud: Decodable, Equatable {
    let title: String
    let subtitle: String
    let github: String
    let google: String
    let divider: String
    let emailPlaceholder: String
    let emailContinue: String
    let emailInvalid: String
    let unavailable: String
  }

  struct SelfHosted: Decodable, Equatable {
    let title: String
    let subtitle: String
    let section: String
    let enter: String
    let back: String
    let done: String
    let server: String
    let serverChange: String
    let serverPlaceholder: String
    let serverHint: String
    let username: String
    let password: String
    let submit: String
    let submitting: String
  }

  struct Errors: Decodable, Equatable {
    let serverEmpty: String
    let serverInvalid: String
    let usernameRequired: String
    let passwordRequired: String
    let notMemoh: String
    let invalidCredentials: String
    let unreachable: String
    let failed: String
  }

  let cloud: Cloud
  let selfHosted: SelfHosted
  let errors: Errors
  /// A localized one-shot session-loss explanation. Empty means a normal signed-out launch.
  let notice: String

  static func decode(_ json: String) throws -> LoginPageModel {
    try JSONDecoder().decode(LoginPageModel.self, from: Data(json.utf8))
  }
}

@MainActor
private final class LoginPageStore: ObservableObject {
  enum Page { case cloud, selfHosted }
  enum ErrorKind {
    case notice
    case serverEmpty
    case serverInvalid
    case usernameRequired
    case passwordRequired
    case notMemoh
    case invalidCredentials
    case unreachable
    case failed
  }

  @Published var model: LoginPageModel?
  @Published var mode = "system"
  @Published var page: Page = .cloud
  @Published var email = ""
  @Published var server: String = {
    #if DEBUG
    return "http://127.0.0.1:18080"
    #else
    return "https://memoh.yetodawn.com"
    #endif
  }()
  @Published var username = ""
  @Published var password = ""
  @Published var editingServer = false
  @Published var cloudNotice = false
  @Published var errorKind: ErrorKind?
  @Published var busy = false

  var onSignedIn: (AuthSession) -> Void = { _ in }

  private let service = MemohAuthService()
  private let keychain = AuthKeychain.shared
  private var signInTask: Task<Void, Never>?
  private var initialModelApplied = false
  private var emailWasInvalid = false

  var colorScheme: ColorScheme? { MemohAppearanceMode.colorScheme(mode) }
  var emailValid: Bool { AuthServerContract.isValidEmail(email) }
  var showEmailError: Bool {
    !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !emailValid
  }
  var serverSummary: String { AuthServerContract.displayHost(server) }
  var canSubmit: Bool {
    !busy && (try? AuthServerContract.normalize(server)) != nil
      && !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !password.isEmpty
  }

  var errorText: String? {
    guard let model, let errorKind else { return nil }
    switch errorKind {
    case .notice: return model.notice
    case .serverEmpty: return model.errors.serverEmpty
    case .serverInvalid: return model.errors.serverInvalid
    case .usernameRequired: return model.errors.usernameRequired
    case .passwordRequired: return model.errors.passwordRequired
    case .notMemoh: return model.errors.notMemoh
    case .invalidCredentials: return model.errors.invalidCredentials
    case .unreachable: return model.errors.unreachable
    case .failed: return model.errors.failed
    }
  }

  func setModel(_ value: LoginPageModel) {
    model = value
    guard !initialModelApplied else { return }
    initialModelApplied = true
    if !value.notice.isEmpty {
      page = .selfHosted
      setError(.notice)
    }
  }

  func setEmail(_ value: String) {
    email = value
    let hasContent = !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let invalid = hasContent && !AuthServerContract.isValidEmail(value)
    if invalid && !emailWasInvalid, let message = model?.cloud.emailInvalid {
      announce(message)
    }
    emailWasInvalid = invalid
  }

  func showCloudUnavailable() {
    guard let message = model?.cloud.unavailable else { return }
    cloudNotice = true
    announce(message)
  }

  func openSelfHosted() {
    page = .selfHosted
    cloudNotice = false
  }

  func openCloud() {
    page = .cloud
    errorKind = nil
  }

  func submit() {
    guard !busy else { return }
    let normalized: NormalizedAuthServer
    do {
      normalized = try AuthServerContract.normalize(server)
    } catch ServerInputProblem.empty {
      editingServer = true
      setError(.serverEmpty)
      return
    } catch {
      editingServer = true
      setError(.serverInvalid)
      return
    }

    let trimmedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedUsername.isEmpty else {
      setError(.usernameRequired)
      return
    }
    guard !password.isEmpty else {
      setError(.passwordRequired)
      return
    }

    busy = true
    errorKind = nil
    let submittedPassword = password
    signInTask?.cancel()
    signInTask = Task { [weak self] in
      guard let self else { return }
      defer { busy = false }
      do {
        let session = try await service.authenticate(
          server: normalized,
          username: trimmedUsername,
          password: submittedPassword
        )
        try Task.checkCancellation()
        try keychain.save(session: session)
        onSignedIn(session)
      } catch is CancellationError {
        return
      } catch let error as MemohAuthError {
        switch error {
        case .notMemoh:
          editingServer = true
          setError(.notMemoh)
        case .invalidCredentials:
          setError(.invalidCredentials)
        case .unreachable:
          editingServer = true
          setError(.unreachable)
        case .failed:
          setError(.failed)
        }
      } catch {
        setError(.failed)
      }
    }
  }

  private func setError(_ kind: ErrorKind) {
    errorKind = kind
    if let message = errorText, !message.isEmpty { announce(message) }
  }

  private func announce(_ message: String) {
    UIAccessibility.post(notification: .announcement, argument: message)
  }
}

private enum LoginField: Hashable { case email, username, password, server }

private struct LoginPageView: View {
  @ObservedObject var store: LoginPageStore
  @FocusState private var focusedField: LoginField?
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\.colorScheme) private var systemColorScheme

  private var traits: UITraitCollection {
    let scheme = store.colorScheme ?? systemColorScheme
    return UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light)
  }

  private var background: Color {
    store.mode == "oled" ? .black : Color(uiColor: MemohPalette.background(traits))
  }

  private var card: Color { Color(uiColor: MemohPalette.card(traits)) }
  private var label: Color { Color(uiColor: MemohPalette.label(traits)) }
  private var secondary: Color { Color(uiColor: MemohPalette.secondaryLabel(traits)) }
  private var separator: Color { Color(uiColor: MemohPalette.separator(traits)) }
  private var accent: Color { Color(uiColor: MemohPalette.accent(traits)) }
  private var destructive: Color { Color(uiColor: MemohPalette.destructive(traits)) }

  var body: some View {
    GeometryReader { geometry in
      ScrollView {
        VStack(spacing: 0) {
          if let model = store.model {
            brand
            Text(store.page == .cloud ? model.cloud.title : model.selfHosted.title)
              .font(.largeTitle.bold())
              .foregroundStyle(label)
              .multilineTextAlignment(.center)
              .fixedSize(horizontal: false, vertical: true)
              .padding(.bottom, 8)
            Text(store.page == .cloud ? model.cloud.subtitle : model.selfHosted.subtitle)
              .font(.subheadline)
              .foregroundStyle(secondary)
              .multilineTextAlignment(.center)
              .fixedSize(horizontal: false, vertical: true)
              .padding(.bottom, 32)

            if store.page == .cloud {
              cloudPage(model)
            } else {
              selfHostedPage(model)
            }
          }
        }
        .frame(maxWidth: 480)
        .frame(maxWidth: .infinity)
        .frame(minHeight: geometry.size.height, alignment: .center)
        .padding(.horizontal, 24)
        .padding(.vertical, 32)
      }
      .scrollDismissesKeyboard(.interactively)
      .overlay(alignment: .top) {
        background
          .frame(height: geometry.safeAreaInsets.top)
          .ignoresSafeArea(edges: .top)
          .allowsHitTesting(false)
      }
    }
    .background(background.ignoresSafeArea())
    .preferredColorScheme(store.colorScheme)
  }

  @ViewBuilder
  private var brand: some View {
    if let image = MemohAssets.image(named: "brand-mark.png") {
      Image(uiImage: image)
        .resizable()
        .scaledToFit()
        .frame(width: 64, height: 64)
        .accessibilityHidden(true)
        .padding(.bottom, 32)
    } else {
      Image(systemName: "sparkles")
        .font(.system(size: 44))
        .foregroundStyle(accent)
        .accessibilityHidden(true)
        .padding(.bottom, 32)
    }
  }

  @ViewBuilder
  private func cloudPage(_ model: LoginPageModel) -> some View {
    nativeCloudButton(
      title: model.cloud.github,
      asset: "github-mark.png",
      template: true,
      identifier: "login-cloud-github"
    )
    nativeCloudButton(
      title: model.cloud.google,
      asset: "google-mark-color.png",
      template: false,
      identifier: "login-cloud-google"
    )

    HStack(spacing: 12) {
      Rectangle().fill(separator).frame(height: 0.5)
      Text(model.cloud.divider).font(.footnote).foregroundStyle(secondary)
      Rectangle().fill(separator).frame(height: 0.5)
    }
    .padding(.vertical, 8)

    TextField(
      model.cloud.emailPlaceholder,
      text: Binding(get: { store.email }, set: store.setEmail)
    )
    .focused($focusedField, equals: .email)
    .textContentType(.emailAddress)
    .keyboardType(.emailAddress)
    .textInputAutocapitalization(.never)
    .autocorrectionDisabled()
    .submitLabel(.continue)
    .onSubmit {
      if store.emailValid { store.showCloudUnavailable() }
    }
    .font(.body)
    .padding(.horizontal, 16)
    .frame(minHeight: 48)
    .background(card, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(separator, lineWidth: 0.5))
    .accessibilityIdentifier("login-cloud-email-input")

    if store.showEmailError {
      Text(model.cloud.emailInvalid)
        .font(.footnote)
        .foregroundStyle(destructive)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 4)
        .accessibilityIdentifier("login-cloud-email-error")
    }

    Button(action: store.showCloudUnavailable) {
      Text(model.cloud.emailContinue)
        .frame(maxWidth: .infinity, minHeight: 50)
    }
    .buttonStyle(.borderedProminent)
    .buttonBorderShape(.roundedRectangle(radius: 10))
    .tint(accent)
    .controlSize(.large)
    .disabled(!store.emailValid)
    .accessibilityIdentifier("login-cloud-email-continue")
    .padding(.top, 12)

    if store.cloudNotice {
      Text(model.cloud.unavailable)
        .font(.footnote)
        .foregroundStyle(secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 12)
        .accessibilityIdentifier("login-cloud-notice")
    }

    Text(model.selfHosted.section)
      .font(.footnote)
      .foregroundStyle(secondary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.top, 32)
      .padding(.horizontal, 8)

    Button(action: store.openSelfHosted) {
      HStack(spacing: 8) {
        Text(model.selfHosted.enter).foregroundStyle(label)
        Spacer(minLength: 8)
        Image(systemName: "chevron.forward")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(.tertiary)
          .accessibilityHidden(true)
      }
      .padding(.horizontal, 16)
      .frame(minHeight: 48)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .background(card, in: RoundedRectangle(cornerRadius: 10))
    .accessibilityIdentifier("login-selfhosted-toggle")
    .padding(.top, 4)
  }

  @ViewBuilder
  private func selfHostedPage(_ model: LoginPageModel) -> some View {
    Button(action: store.openCloud) {
      Label(model.selfHosted.back, systemImage: "chevron.backward")
        .frame(minHeight: 44)
    }
    .buttonStyle(.plain)
    .foregroundStyle(accent)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityIdentifier("login-selfhosted-back")
    .disabled(store.busy)

    VStack(spacing: 0) {
      formField(label: model.selfHosted.username) {
        TextField(model.selfHosted.username, text: $store.username)
          .focused($focusedField, equals: .username)
          .textContentType(.username)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .submitLabel(.next)
          .onSubmit { focusedField = .password }
          .accessibilityIdentifier("login-username-input")
      }
      Divider().padding(.leading, dynamicTypeSize.isAccessibilitySize ? 0 : 104)
      formField(label: model.selfHosted.password) {
        SecureField(model.selfHosted.password, text: $store.password)
          .focused($focusedField, equals: .password)
          .textContentType(.password)
          .submitLabel(.go)
          .onSubmit(store.submit)
          .accessibilityIdentifier("login-password-input")
      }
    }
    .background(card, in: RoundedRectangle(cornerRadius: 10))
    .padding(.top, 8)

    Button {
      store.editingServer.toggle()
      if store.editingServer { focusedField = .server }
    } label: {
      HStack(spacing: 8) {
        Text(model.selfHosted.server).foregroundStyle(secondary)
        Text(store.serverSummary).foregroundStyle(label).lineLimit(1)
        Spacer(minLength: 4)
        Text(store.editingServer ? model.selfHosted.done : model.selfHosted.serverChange)
          .foregroundStyle(accent)
      }
      .font(.footnote)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier(store.editingServer ? "login-server-change" : "login-server-summary")
    .disabled(store.busy)
    .padding(.top, 16)

    if store.editingServer {
      formField(label: model.selfHosted.server) {
        TextField(model.selfHosted.serverPlaceholder, text: $store.server)
          .focused($focusedField, equals: .server)
          .textContentType(.URL)
          .keyboardType(.URL)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .submitLabel(.done)
          .onSubmit { store.editingServer = false }
          .accessibilityIdentifier("login-server-input")
      }
      .background(card, in: RoundedRectangle(cornerRadius: 10))
    }

    Text(model.selfHosted.serverHint)
      .font(.footnote)
      .foregroundStyle(secondary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.horizontal, 8)
      .padding(.top, 4)

    if let error = store.errorText, !error.isEmpty {
      Text(error)
        .font(.footnote)
        .foregroundStyle(destructive)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 12)
        .accessibilityIdentifier("login-error")
    }

    Button(action: store.submit) {
      Group {
        if store.busy {
          ProgressView().tint(.white)
        } else {
          Text(model.selfHosted.submit).font(.headline)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 50)
    }
    .buttonStyle(.borderedProminent)
    .buttonBorderShape(.capsule)
    .tint(accent)
    .disabled(!store.canSubmit)
    .accessibilityLabel(store.busy ? model.selfHosted.submitting : model.selfHosted.submit)
    .accessibilityIdentifier("login-submit")
    .padding(.top, 32)
  }

  private func nativeCloudButton(
    title: String,
    asset: String,
    template: Bool,
    identifier: String
  ) -> some View {
    Button(action: store.showCloudUnavailable) {
      HStack(spacing: 8) {
        if let image = MemohAssets.image(named: asset) {
          Image(uiImage: image)
            .renderingMode(template ? .template : .original)
            .resizable()
            .scaledToFit()
            .frame(width: 20, height: 20)
            .foregroundStyle(label)
            .accessibilityHidden(true)
        }
        Text(title).font(.headline).foregroundStyle(label)
      }
      .frame(maxWidth: .infinity, minHeight: 48)
    }
    .buttonStyle(.plain)
    .background(card, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(separator, lineWidth: 0.5))
    .accessibilityIdentifier(identifier)
    .padding(.bottom, 12)
  }

  private func formField<Content: View>(
    label title: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    Group {
      if dynamicTypeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 4) {
          Text(title).font(.body).foregroundStyle(label)
          content().font(.body).frame(minHeight: 44)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
      } else {
        HStack(spacing: 16) {
          Text(title).font(.body).foregroundStyle(label).frame(width: 88, alignment: .leading)
          content().font(.body).frame(minHeight: 44)
        }
        .padding(.horizontal, 16)
      }
    }
  }
}

/// Expo host for the native login page. No credential or password is sent through its props.
final class NativeLoginView: ExpoView {
  let onSignedIn = EventDispatcher()

  private let store: LoginPageStore
  private let host: MemohSwiftUIHost<LoginPageView>

  required init(appContext: AppContext? = nil) {
    let store = LoginPageStore()
    self.store = store
    host = MemohSwiftUIHost(rootView: LoginPageView(store: store))
    super.init(appContext: appContext)
    store.onSignedIn = { [weak self] session in
      guard let json = try? session.json() else { return }
      self?.onSignedIn(["sessionJson": json])
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    host.layout(in: bounds)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    host.updateAttachment(on: self)
  }

  func setMode(_ value: String) {
    store.mode = MemohAppearanceMode.normalized(value)
    switch store.mode {
    case "light": host.setInterfaceStyle(.light)
    case "dark", "oled": host.setInterfaceStyle(.dark)
    default: host.setInterfaceStyle(.unspecified)
    }
  }

  func setViewModelJSON(_ value: String) {
    guard let model = try? LoginPageModel.decode(value) else { return }
    store.setModel(model)
  }
}
