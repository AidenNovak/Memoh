/**
 * Debug 索引页（仅开发构建）。
 *
 * 产品屏幕上只暴露可操作的状态，内部的东西都收在这里。目前它主要指向
 * **场景台**——那才是这个项目里最有用的一页：用真实组件渲染固定帧序列，
 * 不依赖登录、服务端或网络。
 *
 * 为什么值得单独一层：设计迭代需要能反复看同一个状态。每次都连真服务端跑一轮
 * 既慢又不可复现（模型回复每次都不一样），而设计问题往往就藏在那些固定状态里
 * ——空态、错误态、长内容、审批缺选项。
 */
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SCENES } from '../features/verify/scenes.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';

export function DebugScreen() {
  const palette = usePalette();
  const { spacing, typography, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      contentContainerStyle={{ padding: spacing.lg, paddingTop: insets.top + spacing.lg }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={() => router.back()}
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <Text style={[typography.body, { color: '#007AFF' }]}>‹ Back</Text>
      </Pressable>

      <Text style={[typography.title2, { color: palette.label, marginBottom: spacing.xs }]}>
        Debug
      </Text>
      <Text
        style={[typography.footnote, { color: palette.secondaryLabel, marginBottom: spacing.lg }]}
      >
        只有开发构建里可达。这些页面不参与生产逻辑。
      </Text>

      <Pressable
        accessibilityRole="button"
        onPress={() => router.push('/debug/scene')}
        style={({ pressed }) => [
          styles.card,
          {
            backgroundColor: pressed ? palette.field : palette.card,
            borderRadius: radius.md,
            padding: spacing.lg,
          },
        ]}
      >
        <Text style={[typography.headline, { color: palette.label }]}>Scenes</Text>
        <Text style={[typography.footnote, { color: palette.secondaryLabel, marginTop: 2 }]}>
          {SCENES.length} 个固定场景：工具状态、思考分层、审批（有/无选项）、失败、长会话、
          断连、附件。用真实组件渲染，不依赖登录与服务端。
        </Text>
        <Text style={[typography.body, { color: palette.tertiaryLabel, marginTop: spacing.sm }]}>
          ›
        </Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        testID="debug-push"
        onPress={() => router.push('/debug/notifications')}
        style={({ pressed }) => [
          styles.card,
          {
            backgroundColor: pressed ? palette.field : palette.card,
            borderRadius: radius.md,
            padding: spacing.lg,
            marginTop: spacing.md,
          },
        ]}
      >
        <Text style={[typography.headline, { color: palette.label }]}>Push</Text>
        <Text style={[typography.footnote, { color: palette.secondaryLabel, marginTop: 2 }]}>
          推送链路的运行时状态：授权、分类、前台判定、冷启动点击、token 形态、注册失败原因。
          这些在产品界面上不出现（它们不该出现），所以只有这里能看。
        </Text>
        <Text style={[typography.body, { color: palette.tertiaryLabel, marginTop: spacing.sm }]}>
          ›
        </Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: 64,
  },
});
