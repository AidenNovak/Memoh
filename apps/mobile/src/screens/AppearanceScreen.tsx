/**
 * 外观页的 RN 薄桥：原生持有 UI，RN 暂持路由、主题状态与本地化文案。
 * 原生把 `oled` 显示为 Dark + True black；开关关闭时回到普通 `dark`。
 */
import { NativeAppearanceView } from '@memoh-ios/kit';
import { useRouter } from 'expo-router';
import React, { useCallback } from 'react';

import type { AppearanceMode } from '../lib/theme/index.ts';
import { useT } from '../lib/i18n/useT.ts';
import { useTheme } from '../lib/theme/context.tsx';

const LABEL_KEY: Record<AppearanceMode, string> = {
  system: 'settings.appearance.system',
  light: 'settings.appearance.light',
  dark: 'settings.appearance.dark',
  oled: 'settings.appearance.oled',
};

/** 某个模式的名字 key。设置主页那行的"当前值"也用它（两处必须一致）。 */
export function appearanceLabelKey(mode: AppearanceMode): string {
  return LABEL_KEY[mode];
}

const VALID_MODES = new Set<string>(['system', 'light', 'dark', 'oled']);

export function AppearanceScreen() {
  const t = useT();
  const router = useRouter();
  const { mode, setMode } = useTheme();

  // 桥两侧都校验事件值，避免未知原生载荷污染主题状态。
  const handleModeChange = useCallback(
    (event: { nativeEvent: { mode?: string } }) => {
      const next = event.nativeEvent.mode;
      if (next !== undefined && VALID_MODES.has(next)) {
        setMode(next as AppearanceMode);
      }
    },
    [setMode],
  );

  // 深链直达 / 状态恢复成栈底时没有上一页，兜底回落到设置主页。
  const handleBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  }, [router]);

  return (
    <NativeAppearanceView
      style={{ flex: 1 }}
      mode={mode}
      title={t('settings.appearance')}
      sectionTitle={t('settings.appearance.mode')}
      backLabel={t('common.back')}
      systemLabel={t(LABEL_KEY.system)}
      lightLabel={t(LABEL_KEY.light)}
      darkLabel={t(LABEL_KEY.dark)}
      trueBlackLabel={t(LABEL_KEY.oled)}
      trueBlackFooter={t('settings.appearance.oled.footer')}
      onModeChange={handleModeChange}
      onBack={handleBack}
    />
  );
}
