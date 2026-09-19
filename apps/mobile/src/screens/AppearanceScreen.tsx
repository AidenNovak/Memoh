/**
 * 外观子页（从设置 push 进来）。
 *
 * ## 为什么外观要有自己的一页
 *
 * 上一版把四个选项平铺在设置主页上：`System / Light / Dark / True black`。问题不在行数，
 * 在**它们的地位不一样**：
 *
 * - `System / Light / Dark` 是三选一的**明暗模式**；
 * - `True black` 是"暗色时用纯黑"的**一个修饰**。
 *
 * 四项并列时，用户会以为选 `True black` 就是"进真黑模式"（于是明暗自动失效），而实际它该
 * 和明暗模式共存。所以这一页把它拆成两个问题：**先选明暗（三选一）**，再问**暗色要不要用纯黑
 * （开关）**。这也是 iOS 自己的做法：「显示与亮度」是一页，里面既有选择行也有开关。
 *
 * ## 实现上不新增状态
 *
 * 主题层现在的取值是 `system | light | dark | oled`（一个四值枚举，`theme/tokens.ts`）。
 * 这一页**不**去把它拆成"三值 + 布尔"——那要动调色、持久化和所有读 `mode` 的地方，收益只是
 * 好看。这里把 `oled` **投影**成开关：开关开着 ⇔ `mode === 'oled'`，三选一的选中项把 `oled`
 * 归到 `Dark`（选了真黑的人点的"暗色"意思是"留在暗色"，不是"退出真黑"）。
 */
import React from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AppearanceMode } from '../lib/theme/index.ts';
import { useT } from '../lib/i18n/useT.ts';
import { GROUP_INSET, spacing, typography } from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';
import { BackButton } from '../ui/BackButton.tsx';
import { Group, Row } from '../ui/GroupedList.tsx';

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

/** 三选一：真黑不是这里的一项，它是下面的开关。 */
const MODES: AppearanceMode[] = ['system', 'light', 'dark'];

export function AppearanceScreen() {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  const { mode, setMode } = useTheme();

  const trueBlack = mode === 'oled';
  const selection: AppearanceMode = mode === 'oled' ? 'dark' : mode;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      // 标题自己画，所以顶部安全区也要自己让开：这是 push 进来的页，没有导航栏兜着
      // （不写 `insets.top` 的话标题会压在状态栏上——第一版就是这样）。
      contentContainerStyle={{
        paddingTop: insets.top + spacing.sm,
        paddingBottom: insets.bottom + spacing.xxl,
        paddingHorizontal: GROUP_INSET,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          paddingHorizontal: GROUP_INSET,
          marginBottom: spacing.md,
        }}
      >
        <BackButton testID="appearance-back" fallback="/settings" />
        <Text style={[typography.title2, { color: palette.label, flex: 1 }]}>
          {t('settings.appearance')}
        </Text>
      </View>

      <Group header={t('settings.appearance.mode')}>
        {MODES.map((option, index) => (
          <Row
            key={option}
            testID={`appearance-${option}`}
            title={t(LABEL_KEY[option])}
            selected={selection === option}
            last={index === MODES.length - 1}
            onPress={() => setMode(option)}
          />
        ))}
      </Group>

      <Group footer={t('settings.appearance.oled.footer')}>
        <Row
          testID="appearance-true-black"
          title={t('settings.appearance.oled')}
          last
          accessory={
            <Switch
              testID="appearance-true-black-switch"
              accessibilityLabel={t('settings.appearance.oled')}
              value={trueBlack}
              // 打开真黑 = 进暗色 + 纯黑；关掉 = 回到普通暗色。
              // 在"亮色/跟随系统"下打开也会切到暗色——这是开关自己的承诺，不是意外。
              onValueChange={(on) => setMode(on ? 'oled' : 'dark')}
            />
          }
        />
      </Group>
    </ScrollView>
  );
}
