/**
 * 对话页的表头（标题 + 副标题 + 三个入口）。
 *
 * ## 为什么把它从 `ChatScreen` 拆出来
 *
 * 它是一块**只有输入、没有状态**的界面：进来的是"标题写什么、副标题写什么、
 * 哪几个入口要出现"，出去的是三个回调。留在屏幕里的时候，它和会话加载、路由同步、
 * 审批出席混在同一个函数体里（评审 D2 点名的那个 ~700 行单函数），改一处得读一屏。
 *
 * ## 为什么不用"一条白底 + 一条生硬分隔线"把屏幕切成两块色
 *
 * 副标题承担状态传达（谁 · 在干什么），这样生成中就不必在内容区再挂一个胶囊。
 * 标题**可点**（设计基线里"标题可点 = 会话信息"）：iOS 上这是常规做法——导航栏标题
 * 承载上下文，而不是另设一个按钮。
 *
 * ## 三个入口的位置
 *
 * - 返回：复用 `BackButton`，统一 44pt 命中区、读屏语义与深链栈底兜底；
 * - 机器（显示器图标）："bot 那台机器"，桌面端顶栏 New panel 里的 Desktop 用的是同一个符号；
 * - 会话信息（带轴的柱状图）："这里有这次会话的读数"。
 *
 * 机器放在会话信息左边：会话信息是"这次对话"的读数，机器是"那个环境"的状态，
 * 两件事分开摆，别合成一个入口。两个图标都用 `accessibilityElementsHidden` +
 * `importantForAccessibility="no-hide-descendants"`——外层 `Pressable` 的
 * `accessibilityLabel` 才是读屏要念的那一句，图标自己不该再报一次。
 */
import { SymbolView } from 'expo-symbols';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '../lib/i18n/useT.ts';
import { PRESS_OPACITY } from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';
import { BackButton } from './BackButton.tsx';

export function ChatHeader({
  title,
  subtitle,
  stale,
  showMachine,
  showInfo,
  onOpenInfo,
  onOpenMachine,
}: {
  /** 会话名（新会话时是"新会话"）。写死成"会话"会让所有会话长得一样。 */
  title: string;
  /** 谁在说话 · 现在在干什么（`features/chat/copy.ts` 的 `headerSubtitle`）。 */
  subtitle: string;
  /** 视图可能已过期：标题行右侧再补一句"刷新中"。 */
  stale: boolean;
  showMachine: boolean;
  showInfo: boolean;
  onOpenInfo: () => void;
  onOpenMachine: () => void;
}) {
  const palette = usePalette();
  const { spacing, typography } = useTheme();
  const insets = useSafeAreaInsets();
  const t = useT();

  return (
    <View
      style={{
        paddingTop: insets.top,
        paddingBottom: spacing.sm,
        paddingHorizontal: spacing.lg,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: palette.separator,
        backgroundColor: palette.card,
      }}
    >
      <BackButton testID="chat-back" fallback="/" />
      {/* 标题即入口：点它看会话信息（设计基线里"标题可点=会话信息"）。 */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('sessionInfo.open')}
        accessibilityHint={t('sessionInfo.title')}
        onPress={onOpenInfo}
        style={({ pressed }) => ({ flex: 1, opacity: pressed ? PRESS_OPACITY.control : 1 })}
      >
        <Text style={[typography.headline, { color: palette.label }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[typography.caption, { color: palette.secondaryLabel }]} numberOfLines={1}>
          {subtitle}
        </Text>
      </Pressable>
      {stale ? (
        <Text style={[typography.caption, { color: palette.warning }]}>{t('chat.gap')}</Text>
      ) : null}
      {/*
        会话信息的**可见入口**。

        标题可点是个"知道了才会用"的入口——实测反馈：没人会为了看用量去点会话名。
        所以这里补一个带轴的柱状图：系统里"这里有读数"的通用符号，一眼能认，44pt 触控目标。
        标题仍然可点（多一条路不冲突），但入口不再只剩那一条。

        不用 ⓘ：ⓘ 在导航栏里被读成"关于本 App"，谁也猜不到点开是这一屏的用量面板；
        也不用表盘/仪表（gauge、speedometer）：表盘意味着环里有个刻度读数，而这台
        部署没有 context window，环只能一直空着——那是骗人。
        桌面端同一个入口是 24px 的上下文环（session-info-ring.vue），这里等
        服务端给出上下文窗口之后再对齐成环。
      */}
      {showMachine ? (
        <Pressable
          testID="machine-button"
          accessibilityRole="button"
          accessibilityLabel={t('machine.open')}
          onPress={onOpenMachine}
          hitSlop={12}
          style={({ pressed }) => [
            styles.headerAction,
            { opacity: pressed ? PRESS_OPACITY.control : 1 },
          ]}
        >
          <SymbolView
            name="display"
            size={22}
            tintColor={palette.accent}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        </Pressable>
      ) : null}
      {showInfo ? (
        <Pressable
          testID="session-info-button"
          accessibilityRole="button"
          accessibilityLabel={t('sessionInfo.open')}
          onPress={onOpenInfo}
          hitSlop={12}
          style={({ pressed }) => [
            styles.headerAction,
            { opacity: pressed ? PRESS_OPACITY.control : 1 },
          ]}
        >
          <SymbolView
            name="chart.bar.xaxis"
            size={22}
            tintColor={palette.accent}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  headerAction: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
