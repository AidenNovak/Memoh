/**
 * 登录闸门的**渲染**那一半。
 *
 * 逻辑在 `features/auth/useAuthGate.ts`；这里只把三态画成屏幕。分开的理由是
 * AGENTS.md 的分层：`features` 不得 import `screens`，而"没凭据就画登录页"
 * 这句话非 import 屏幕不可——那就让屏幕层自己说。
 */
import React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { useAuthGate } from '../features/auth/useAuthGate.ts';
import type { SessionSeed } from '../features/session/store.tsx';
import { usePalette } from '../lib/theme/context.tsx';
import { LoginScreen } from './LoginScreen.tsx';
import { OnboardingScreen } from './OnboardingScreen.tsx';

interface GateProps {
  children: (seed: SessionSeed) => React.ReactNode;
}

export function AuthGateScreen({ children }: GateProps) {
  const palette = usePalette();
  const { phase, seed, showOnboarding, noticeKey, onSignedIn, onOnboardingDone } = useAuthGate();

  if (phase === 'checking') {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          // 用 `background` 而不是 `groupedBackground`：这一屏夹在启动屏（`app.config.ts`
          // 里就是 `background` 的色值）和首启引导（也是 `background`）之间，同色才不跳。
          backgroundColor: palette.background,
        }}
      >
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  if (showOnboarding) {
    return <OnboardingScreen onDone={onOnboardingDone} />;
  }

  if (phase === 'signedOut' || seed === null) {
    // 传 key 而不是译文：登录页自己决定怎么把"发生了什么"讲出来，并且要读屏念一次
    // （见 `LoginScreen` 的 `noticeKey`）。
    return <LoginScreen onSignedIn={onSignedIn} noticeKey={noticeKey} />;
  }

  return <>{children(seed)}</>;
}
