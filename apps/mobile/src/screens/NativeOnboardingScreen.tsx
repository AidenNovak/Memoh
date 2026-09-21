import { NativeOnboardingView, type NativeOnboardingModel } from '@memoh-ios/kit';
import React, { useMemo } from 'react';
import { View } from 'react-native';

import { ONBOARDING_PAGES } from '../features/onboarding/pages.ts';
import { useT } from '../lib/i18n/useT.ts';
import { useTheme } from '../lib/theme/context.tsx';

/**
 * 首启引导（原生）。
 *
 * 这一屏的全部可见 UI 与交互（分页、跳过、主按钮、三条动效、Reduce Motion、Dynamic Type
 * 兜底）都在原生；这里只做一件事：把 `ONBOARDING_PAGES` + 文案组装成契约 JSON 下发，
 * 并把原生回来的 `onDone` 交给路由（`AuthGateScreen`）。
 *
 * ## `progressFormat` 为什么送模板
 *
 * `onboarding.progress`（"第 {{current}} 页，共 {{total}} 页"）是给读屏念**当前页**的，
 * 而当前页在原生侧翻页时才变——RN 无法知道，也送不下一个会自己变的字符串。所以这里把
 * **模板原文**下发（`t()` 不带参数时返回模板，不插值），由原生替换 `{{current}}` /
 * `{{total}}`。占位符沿用项目自己的 i18n 语法，不在 RN 侧做 `{{…}}` → `%1$d` 这类字符串
 * 手术：文案的真源是 `locales/*.json`，两边都照它写。
 */
export function NativeOnboardingScreen({ onDone }: { onDone: () => void }) {
  const t = useT();
  const { mode } = useTheme();

  const model = useMemo<NativeOnboardingModel>(
    () => ({
      pages: ONBOARDING_PAGES.map((page) => ({
        id: page.id,
        // 符号名原样过桥：原生不查表。`SFSymbol` 这个类型保证它不是空串（写错在 tsc 就红）。
        symbol: page.symbol,
        title: t(page.titleKey),
        body: t(page.bodyKey),
      })),
      skipLabel: t('onboarding.skip'),
      nextLabel: t('onboarding.next'),
      startLabel: t('onboarding.start'),
      progressFormat: t('onboarding.progress'),
      pageCount: ONBOARDING_PAGES.length,
    }),
    [t],
  );

  return (
    <View style={{ flex: 1 }}>
      <NativeOnboardingView
        style={{ flex: 1 }}
        mode={mode}
        modelJson={JSON.stringify(model)}
        onDone={onDone}
      />
    </View>
  );
}
