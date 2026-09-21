import ExpoModulesCore
import SwiftUI
import UIKit

struct NativeFilesModel: Decodable, Equatable {
  struct Breadcrumb: Decodable, Equatable, Identifiable {
    let label: String
    let path: String
    let current: Bool
    var id: String { path }
  }

  struct Entry: Decodable, Equatable, Identifiable {
    let name: String
    let path: String
    let subtitle: String
    let symbol: String
    let accessibilityLabel: String
    let isDir: Bool
    var id: String { path.isEmpty ? name : path }
  }

  let status: String
  let title: String
  let loadingLabel: String
  let emptyLabel: String
  let permissionTitle: String
  let permissionBody: String
  let invalidTitle: String
  let invalidBody: String
  let errorTitle: String
  let errorBody: String
  let retryLabel: String
  let upLabel: String
  let moreLabel: String
  let footer: String
  let openLabel: String
  let copyPathLabel: String
  let downloadLabel: String
  let breadcrumbs: [Breadcrumb]
  let entries: [Entry]
  let hiddenCount: Int
  let retryEnabled: Bool
  let parentPath: String?

  static func decode(_ json: String) throws -> NativeFilesModel {
    try JSONDecoder().decode(NativeFilesModel.self, from: Data(json.utf8))
  }
}

@MainActor
private final class NativeFilesStore: ObservableObject {
  @Published var model: NativeFilesModel?
  @Published var mode = "system"

  var onOpen: (String, Bool) -> Void = { _, _ in }
  var onNavigate: (String) -> Void = { _ in }
  var onRefresh: () -> Void = {}
  var onLoadMore: () -> Void = {}
  var onAction: (String, String) -> Void = { _, _ in }

  var colorScheme: ColorScheme? { MemohAppearanceMode.colorScheme(mode) }
  var background: Color { MemohAppearanceMode.formBackground(mode) }

  func setModelJSON(_ value: String) {
    guard let decoded = try? NativeFilesModel.decode(value) else { return }
    model = decoded
  }
}

private struct NativeFilesPage: View {
  @ObservedObject var store: NativeFilesStore

  var body: some View {
    Group {
      if let model = store.model {
        List {
          breadcrumbSection(model)
          contentSection(model)
          footerSection(model)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(store.background)
        .refreshable { store.onRefresh() }
      } else {
        ProgressView()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(store.background)
          .accessibilityLabel(Text("Loading"))
      }
    }
    .preferredColorScheme(store.colorScheme)
  }

  @ViewBuilder
  private func breadcrumbSection(_ model: NativeFilesModel) -> some View {
    if !model.breadcrumbs.isEmpty {
      Section {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 4) {
            ForEach(model.breadcrumbs) { crumb in
              if crumb.current {
                Text(crumb.label).font(.subheadline.weight(.semibold))
              } else {
                Button(crumb.label) { store.onNavigate(crumb.path) }
                  .buttonStyle(.plain)
                  .foregroundStyle(.tint)
                  .accessibilityHint(Text("Open folder"))
              }
              if crumb.id != model.breadcrumbs.last?.id {
                Image(systemName: "chevron.forward")
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(.tertiary)
                  .accessibilityHidden(true)
              }
            }
          }
          .frame(minHeight: 44, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("files-breadcrumbs")
      }
    }
  }

  @ViewBuilder
  private func contentSection(_ model: NativeFilesModel) -> some View {
    switch model.status {
    case "permission":
      message(title: model.permissionTitle, body: model.permissionBody)
    case "invalid":
      message(title: model.invalidTitle, body: model.invalidBody)
    case "loading", "idle":
      Section { ProgressView(model.loadingLabel).frame(maxWidth: .infinity, minHeight: 100) }
    case "error":
      message(
        title: model.errorTitle,
        body: model.errorBody,
        action: model.parentPath == nil
          ? (model.retryEnabled ? (model.retryLabel, { store.onRefresh() }) : nil)
          : (model.upLabel, { store.onNavigate(model.parentPath ?? "") })
      )
    case "empty":
      message(title: model.emptyLabel, body: nil)
    default:
      Section {
        ForEach(model.entries) { entry in
          Button { store.onOpen(entry.path, entry.isDir) } label: {
            FileEntryRow(entry: entry)
          }
          .buttonStyle(.plain)
          .contextMenu {
            Button(model.openLabel) { store.onAction(entry.path, "open") }
            Button(model.copyPathLabel) { store.onAction(entry.path, "copyPath") }
            Button(model.downloadLabel) { store.onAction(entry.path, "download") }
          }
          .accessibilityElement(children: .combine)
          .accessibilityLabel(Text(entry.accessibilityLabel))
          .accessibilityIdentifier("files-row-(entry.name)")
        }
      }
    }
  }

  @ViewBuilder
  private func message(
    title: String,
    body: String?,
    action: (String, () -> Void)? = nil
  ) -> some View {
    Section {
      VStack(alignment: .leading, spacing: 8) {
        Text(title).font(.headline)
        if let body, !body.isEmpty {
          Text(body).font(.footnote).foregroundStyle(.secondary)
        }
        if let action {
          Button(action.0, action: action.1)
            .frame(minHeight: 44, alignment: .leading)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 8)
    }
  }

  @ViewBuilder
  private func footerSection(_ model: NativeFilesModel) -> some View {
    if model.hiddenCount > 0 {
      Section {
        Button(model.moreLabel) { store.onLoadMore() }
          .frame(maxWidth: .infinity, minHeight: 44)
          .accessibilityIdentifier("files-load-more")
      }
    }
    Section {
      Text(model.footer)
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
        .multilineTextAlignment(.center)
    }
  }
}

private struct FileEntryRow: View {
  let entry: NativeFilesModel.Entry

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: entry.symbol)
        .font(.body)
        .foregroundStyle(.tint)
        .frame(width: 28, height: 28)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        Text(entry.name).lineLimit(1)
        Text(entry.subtitle)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      Spacer(minLength: 8)
      Image(systemName: "chevron.forward")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.tertiary)
        .accessibilityHidden(true)
    }
    .frame(minHeight: 56)
    .contentShape(Rectangle())
  }
}

final class NativeFilesView: ExpoView {
  let onOpen = EventDispatcher()
  let onNavigate = EventDispatcher()
  let onRefresh = EventDispatcher()
  let onLoadMore = EventDispatcher()
  let onAction = EventDispatcher()

  private let store: NativeFilesStore
  private let host: UIHostingController<NativeFilesPage>

  required init(appContext: AppContext? = nil) {
    let store = NativeFilesStore()
    self.store = store
    host = UIHostingController(rootView: NativeFilesPage(store: store))
    super.init(appContext: appContext)
    host.view.backgroundColor = .clear
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    store.onOpen = { [weak self] path, isDir in self?.onOpen(["path": path, "isDir": isDir]) }
    store.onNavigate = { [weak self] path in self?.onNavigate(["path": path]) }
    store.onRefresh = { [weak self] in self?.onRefresh([:]) }
    store.onLoadMore = { [weak self] in self?.onLoadMore([:]) }
    store.onAction = { [weak self] path, action in self?.onAction(["path": path, "action": action]) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    host.view.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil, let parent = nearestViewController() else { detachHost(); return }
    guard host.parent !== parent || host.view.superview !== self else { return }
    detachHost()
    parent.addChild(host)
    addSubview(host.view)
    host.didMove(toParent: parent)
    host.view.frame = bounds
  }

  func setMode(_ value: String) { store.mode = MemohAppearanceMode.normalized(value) }
  func setViewModelJSON(_ value: String) { store.setModelJSON(value) }

  private func detachHost() {
    guard host.parent != nil || host.view.superview != nil else { return }
    host.willMove(toParent: nil)
    host.view.removeFromSuperview()
    host.removeFromParent()
  }

  private func nearestViewController() -> UIViewController? {
    var responder: UIResponder? = self
    while let next = responder?.next {
      if let controller = next as? UIViewController { return controller }
      responder = next
    }
    return window?.rootViewController
  }
}

struct NativeFilePreviewModel: Decodable, Equatable {
  struct Breadcrumb: Decodable, Equatable, Identifiable {
    let label: String
    let path: String
    let current: Bool
    var id: String { path }
  }

  let status: String
  let loadingLabel: String
  let title: String
  let body: String
  let retryLabel: String
  let downloadLabel: String
  let truncatedLabel: String
  let imageURI: String?
  let imageHeaders: [String: String]
  let imageMeta: String
  let lines: [String]
  let retryEnabled: Bool
  let breadcrumbs: [Breadcrumb]

  static func decode(_ json: String) throws -> NativeFilePreviewModel {
    try JSONDecoder().decode(NativeFilePreviewModel.self, from: Data(json.utf8))
  }
}

@MainActor
private final class NativeFilePreviewStore: ObservableObject {
  @Published var model: NativeFilePreviewModel?
  @Published var mode = "system"
  var onRetry: () -> Void = {}
  var onDownload: () -> Void = {}
  var onNavigate: (String) -> Void = { _ in }

  var colorScheme: ColorScheme? { MemohAppearanceMode.colorScheme(mode) }
  var background: Color { MemohAppearanceMode.formBackground(mode) }

  func setModelJSON(_ value: String) {
    guard let decoded = try? NativeFilePreviewModel.decode(value) else { return }
    model = decoded
  }
}

private struct NativeFilePreviewPage: View {
  @ObservedObject var store: NativeFilePreviewStore

  var body: some View {
    ScrollView {
      if let model = store.model {
        VStack(alignment: .leading, spacing: 12) {
          breadcrumbs(model)
          content(model)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      } else {
        ProgressView()
          .frame(maxWidth: .infinity, minHeight: 140)
      }
    }
    .background(store.background)
    .preferredColorScheme(store.colorScheme)
  }

  @ViewBuilder
  private func breadcrumbs(_ model: NativeFilePreviewModel) -> some View {
    if !model.breadcrumbs.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 4) {
          ForEach(model.breadcrumbs) { crumb in
            if crumb.current {
              Text(crumb.label).font(.subheadline.weight(.semibold))
            } else {
              Button(crumb.label) { store.onNavigate(crumb.path) }
                .buttonStyle(.plain)
                .foregroundStyle(.tint)
            }
            if crumb.id != model.breadcrumbs.last?.id {
              Image(systemName: "chevron.forward")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
            }
          }
        }
        .frame(minHeight: 44)
      }
    }
  }

  @ViewBuilder
  private func content(_ model: NativeFilePreviewModel) -> some View {
    switch model.status {
    case "text":
      VStack(alignment: .leading, spacing: 0) {
        ScrollView(.horizontal, showsIndicators: true) {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(model.lines.enumerated()), id: \.offset) { index, line in
              HStack(alignment: .top, spacing: 8) {
                Text(String(index + 1))
                  .font(.system(.footnote, design: .monospaced))
                  .foregroundStyle(.tertiary)
                  .frame(width: 44, alignment: .trailing)
                Text(line.isEmpty ? " " : line)
                  .font(.system(.footnote, design: .monospaced))
                  .fixedSize(horizontal: true, vertical: false)
              }
              .frame(minHeight: 22, alignment: .top)
            }
          }
          .padding(.vertical, 12)
        }
        if !model.truncatedLabel.isEmpty {
          Text(model.truncatedLabel)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.bottom, 12)
        }
      }
      .background(Color(uiColor: .secondarySystemGroupedBackground))
      .clipShape(RoundedRectangle(cornerRadius: 8))
    case "image":
      VStack(alignment: .leading, spacing: 8) {
        NativeRemoteImage(urlString: model.imageURI ?? "", headers: model.imageHeaders)
          .frame(maxWidth: .infinity, minHeight: 240, maxHeight: 420)
          .background(Color(uiColor: .secondarySystemGroupedBackground))
          .clipShape(RoundedRectangle(cornerRadius: 8))
          .accessibilityLabel(Text(model.title))
        Text(model.imageMeta).font(.footnote).foregroundStyle(.secondary)
      }
    case "loading":
      ProgressView(model.loadingLabel).frame(maxWidth: .infinity, minHeight: 120)
    default:
      VStack(alignment: .leading, spacing: 8) {
        Text(model.title).font(.headline)
        if !model.body.isEmpty { Text(model.body).font(.footnote).foregroundStyle(.secondary) }
        if model.status == "error" && model.retryEnabled {
          Button(model.retryLabel) { store.onRetry() }.frame(minHeight: 44, alignment: .leading)
        }
        if ["binary", "tooLarge", "imageError"].contains(model.status) {
          Button(model.downloadLabel) { store.onDownload() }.frame(minHeight: 44, alignment: .leading)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(16)
      .background(Color(uiColor: .secondarySystemGroupedBackground))
      .clipShape(RoundedRectangle(cornerRadius: 8))
    }
  }
}

private struct NativeRemoteImage: View {
  let urlString: String
  let headers: [String: String]
  @State private var image: UIImage?

  var body: some View {
    Group {
      if let image { Image(uiImage: image).resizable().scaledToFit() }
      else { ProgressView() }
    }
    .task(id: urlString) {
      guard let url = URL(string: urlString) else { return }
      var request = URLRequest(url: url)
      headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }
      do {
        let (data, _) = try await URLSession.shared.data(for: request)
        if let decoded = UIImage(data: data) { image = decoded }
      } catch { }
    }
  }
}

final class NativeFilePreviewView: ExpoView {
  let onRetry = EventDispatcher()
  let onDownload = EventDispatcher()
  let onNavigate = EventDispatcher()

  private let store: NativeFilePreviewStore
  private let host: UIHostingController<NativeFilePreviewPage>

  required init(appContext: AppContext? = nil) {
    let store = NativeFilePreviewStore()
    self.store = store
    host = UIHostingController(rootView: NativeFilePreviewPage(store: store))
    super.init(appContext: appContext)
    host.view.backgroundColor = .clear
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    store.onRetry = { [weak self] in self?.onRetry([:]) }
    store.onDownload = { [weak self] in self?.onDownload([:]) }
    store.onNavigate = { [weak self] path in self?.onNavigate(["path": path]) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    host.view.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil, let parent = nearestViewController() else { detachHost(); return }
    guard host.parent !== parent || host.view.superview !== self else { return }
    detachHost()
    parent.addChild(host)
    addSubview(host.view)
    host.didMove(toParent: parent)
    host.view.frame = bounds
  }

  func setMode(_ value: String) { store.mode = MemohAppearanceMode.normalized(value) }
  func setViewModelJSON(_ value: String) { store.setModelJSON(value) }

  private func detachHost() {
    guard host.parent != nil || host.view.superview != nil else { return }
    host.willMove(toParent: nil)
    host.view.removeFromSuperview()
    host.removeFromParent()
  }

  private func nearestViewController() -> UIViewController? {
    var responder: UIResponder? = self
    while let next = responder?.next {
      if let controller = next as? UIViewController { return controller }
      responder = next
    }
    return window?.rootViewController
  }
}
