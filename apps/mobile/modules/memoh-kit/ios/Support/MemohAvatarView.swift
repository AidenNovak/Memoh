import SwiftUI
import UIKit

/// 头像视图：画法与 RN `ui/BotAvatar.tsx` 三种情况一一对应（计划见 `MemohAvatarPlan`）。
///
/// 远程加载失败退回吉祥物，并在连接重新 open 时最多重试一次（语义与
/// `features/bots/avatar.ts` 的 retry 判据一致）。设置卡片（38pt）与 bot 设置页头
/// （44pt）共用这一份，只改尺寸。
struct MemohAvatarView: View {
  let avatar: MemohAvatarPlan
  var size: CGFloat = 38

  @State private var remoteFailed = false
  @State private var retriedOnOpen = false
  @State private var attempt = 0

  var body: some View {
    Group {
      switch avatar.kind {
      case .remote: remote
      case .builtin: builtin
      case .mark: mark
      }
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: size * 0.29, style: .continuous))
    .accessibilityHidden(true)
    .onChange(of: avatar.uri) {
      remoteFailed = false
      retriedOnOpen = false
      attempt = 0
    }
    .onChange(of: avatar.connectionOpen) { _, isOpen in
      guard isOpen, remoteFailed, !retriedOnOpen else { return }
      remoteFailed = false
      retriedOnOpen = true
      attempt += 1
    }
  }

  @ViewBuilder private var remote: some View {
    if let raw = avatar.uri, let url = URL(string: raw), !remoteFailed {
      AsyncImage(url: url) { phase in
        if let image = phase.image {
          image.resizable().scaledToFill()
        } else if phase.error != nil {
          Color.clear.onAppear { remoteFailed = true }
        } else {
          // 还在加载：中性底。先亮出吉祥物再换成真头像会看起来像“头像变来变去”。
          Color(uiColor: UIColor { MemohPalette.inset($0) })
        }
      }
      .id(attempt)
    } else {
      mark
    }
  }

  private var builtin: some View {
    ZStack {
      Color(uiColor: UIColor { MemohPalette.accentSoft($0) })
      Image(systemName: avatar.symbol ?? "sparkles")
        .font(.system(size: size * 0.55))
        .foregroundStyle(Color(uiColor: UIColor { MemohPalette.accent($0) }))
    }
  }

  @ViewBuilder private var mark: some View {
    if let image = MemohAssets.image(named: "brand-mark") {
      Image(uiImage: image).resizable().scaledToFill()
    } else {
      // 图片资源缺失时也不画空方块：退回一枚系统图形，至少它是个明确的东西。
      ZStack {
        Color(uiColor: UIColor { MemohPalette.inset($0) })
        Image(systemName: "sparkles")
          .font(.system(size: size * 0.55))
          .foregroundStyle(.secondary)
      }
    }
  }
}
