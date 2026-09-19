/**
 * 会话页的三视图切换器（会话 / 文件 / 定时）。
 *
 * ## 为什么要有它
 *
 * 底部只有两个 tab（§7.1 裁决）。定时与文件**不是"另一件事"**，而是同一个 agent 的
 * 另外两种看法——桌面端本来就是 Chat / Files / Schedule 三视图互斥。把它们塞进底部
 * 会让"这个 App 有几个地方"变成一个错误的心理模型；放在这一屏做视图切换才是同构的。
 *
 * ## 两种形态，默认图标按钮
 *
 * - `buttons`（默认）：三个图标互斥，装在 `field` 底的胶囊里。当前视图名由**大标题**
 *   承担，所以这里不需要再写一遍文字——省一行高度，也和桌面端顶部那排同构。
 * - `segmented`：整行分段控件，每段带文字。更显眼、一眼看出有三个视图，代价是多占一行。
 *   设计稿里两种都画了（`docs/design/ios-mockup.html` 的工具条可实时切），默认给哪种
 *   是产品选择：**默认图标按钮**，因为它省下来的那行正好是大标题要用的。
 *
 * 两种形态共用同一份状态与同一个无障碍模型（radiogroup 语义），所以切换形态不影响
 * 行为，只是排布不同。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { SFSymbol } from 'sf-symbols-typescript';

import { useT } from '../lib/i18n/useT.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';

export type HubView = 'sessions' | 'files' | 'schedule';

export const HUB_VIEWS: readonly HubView[] = ['sessions', 'files', 'schedule'];

/**
 * 每个视图的图标。选中态用 `.fill`：**图标按钮这一排没有文字**，如果选中态只靠颜色，
 * 色觉障碍用户看不出当前在哪个视图——填充与描边是那条退路。
 */
const ICONS: Record<HubView, { default: SFSymbol; selected: SFSymbol }> = {
  sessions: {
    default: 'bubble.left.and.bubble.right',
    selected: 'bubble.left.and.bubble.right.fill',
  },
  files: { default: 'folder', selected: 'folder.fill' },
  schedule: { default: 'clock', selected: 'clock.fill' },
};

interface Props {
  value: HubView;
  onChange: (next: HubView) => void;
  variant?: 'buttons' | 'segmented';
}

export function ViewSwitcher({ value, onChange, variant = 'buttons' }: Props) {
  const palette = usePalette();
  const { spacing, typography } = useTheme();
  const t = useT();

  const labelOf = (view: HubView) => t(`hub.view.${view}`);

  if (variant === 'segmented') {
    return (
      <View
        accessibilityRole="radiogroup"
        style={[
          styles.segmentedTrack,
          {
            backgroundColor: palette.field,
            borderRadius: 9,
            padding: 2,
            marginHorizontal: spacing.lg,
          },
        ]}
      >
        {HUB_VIEWS.map((view) => {
          const active = view === value;
          return (
            <Pressable
              key={view}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={labelOf(view)}
              onPress={() => onChange(view)}
              style={{
                flex: 1,
                minHeight: 32,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 7,
                backgroundColor: active ? palette.card : 'transparent',
              }}
            >
              <Text
                style={[
                  typography.footnote,
                  {
                    color: active ? palette.label : palette.secondaryLabel,
                    fontWeight: active ? '600' : '400',
                  },
                ]}
              >
                {labelOf(view)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    );
  }

  return (
    <View
      accessibilityRole="radiogroup"
      style={[
        styles.buttonsTrack,
        { backgroundColor: palette.field, borderRadius: 11, padding: 2 },
      ]}
    >
      {HUB_VIEWS.map((view) => {
        const active = view === value;
        return (
          <Pressable
            key={view}
            testID={`hub-view-${view}`}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            // 只写无障碍标签、不渲染文字：这三个图标对看得见的人是"当前视图"，对读屏的
            // 人是"会话视图"——两种表述都要有。
            accessibilityLabel={labelOf(view)}
            onPress={() => onChange(view)}
            hitSlop={4}
            style={{
              width: 40,
              height: 30,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 9,
              backgroundColor: active ? palette.card : 'transparent',
              // 选中项的"凸起"用一道极轻的阴影，不是描边：描边在这种 30pt 高的小块上
              // 会显脏（和工具条上的其它胶囊打架）。
              shadowColor: '#000',
              shadowOpacity: active ? 0.12 : 0,
              shadowRadius: 2,
              shadowOffset: { width: 0, height: 1 },
            }}
          >
            <SymbolView
              name={active ? ICONS[view].selected : ICONS[view].default}
              size={18}
              tintColor={active ? palette.accent : palette.secondaryLabel}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // `flexShrink: 0`：这三个图标是这一屏唯一的视图入口，辅助字号再大也不许被挤掉。
  buttonsTrack: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  segmentedTrack: { flexDirection: 'row', alignItems: 'center' },
});
