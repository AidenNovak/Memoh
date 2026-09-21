import { NativeOnboardingScreen } from './NativeOnboardingScreen.tsx';

/**
 * Route-owned thin wrapper; the visible onboarding is native on iOS.
 *
 * 判据（为什么它是"启动页"而不是 sheet、三条动效、大字号兜底）在原生侧
 * `modules/memoh-kit/ios/Onboarding/NativeOnboardingView.swift` 的文件头里。
 */
export function OnboardingScreen({ onDone }: { onDone: () => void }) {
  return <NativeOnboardingScreen onDone={onDone} />;
}
