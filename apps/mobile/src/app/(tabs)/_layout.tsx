/**
 * 底部两个 tab：会话 / 设置。
 *
 * ## 为什么是两个而不是三个（2026-09-15 裁决）
 *
 * 见 `docs/research/memoh-design-baseline.md` §7.1。要点：定时与文件**不是"另一件事"**，
 * 而是某个 agent 的另外两种看法；它们收进「会话」页做视图切换。第二个 tab 直接就是
 * bot settings，不再先 push 一层详情页。
 *
 * ## 为什么用 NativeTabs 而不是自绘 tab bar
 *
 * 这是 iOS 26 的原生底部栏：滚动最小化、软边缘、无障碍分组、Dynamic Type、选中态反馈
 * 都由系统给。自绘版本要自己追这些行为，追到最后还是个"看起来像但不是"的控件。
 * 仓库此前零 tab bar 代码，所以没有历史形态要迁就。
 *
 * 标签用 `home.title` / `settings.title` 两个既有键，不另开 `tabs.*`：同一个词在两处
 * 出现（tab 标签与大标题）时，分成两个键就会在改文案时漏掉一处。
 */
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import React from 'react';

import { useT } from '../../lib/i18n/useT.ts';
import { usePalette } from '../../lib/theme/context.tsx';

export default function TabsLayout() {
  const palette = usePalette();
  const t = useT();

  return (
    <NativeTabs
      iconColor={{ default: palette.secondaryLabel, selected: palette.accent }}
      backgroundColor={palette.card}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon
          sf={{
            default: 'bubble.left.and.bubble.right',
            selected: 'bubble.left.and.bubble.right.fill',
          }}
        />
        <NativeTabs.Trigger.Label>{t('home.title')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf={{ default: 'gearshape', selected: 'gearshape.fill' }} />
        <NativeTabs.Trigger.Label>{t('settings.title')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
