/**
 * 输入区（模型胶囊 + 输入框 + 发送/停止键）。
 *
 * ## 形态照 iOS 消息类 App
 *
 * 一行**分离的两件东西**：左边一个可增高的输入胶囊，右边一个 34pt 圆形按钮。两者之间 8pt。
 *
 * 为什么不把按钮放进胶囊里：那是 Web 聊天框的样子（一个框里塞输入和按钮）。iOS 上输入框
 * 和动作按钮是分开的两个控件，按钮的圆是**正圆**而不是圆角方块。视觉评审把"输入区"列为
 * 最容易失分的地方之一，主要就是这两点。
 *
 * 生成中时按钮**在同一个位置**变成停止：用户的心智模型是"那个位置现在能停"，在别处冒出
 * 一个红色胶囊既不像系统控件也遮挡内容。形状不变、只换字形，所以中途不会闪。
 *
 * ## 按钮此刻是什么，不在这个文件里判
 *
 * `view`（`features/chat/composer.ts` 的 `composerView`）一次给齐：能不能点、点下去是
 * 发送/排队/停止、字形、读屏念哪句。分四处算就会出现"字形是停止、标签是发送"这种错位
 * ——那正是判据 A6/B2 要拦的东西。
 *
 * ## 为什么 agent 提问时**隐藏输入区**
 *
 * 提问是"当前待办"，与 composer 争同一个位置只会让人不知道该用哪个（上游 Web 也是表单
 * 接管 composer）。注意隐藏的只是**输入行**：模型胶囊留着（它是"这一轮想用哪个"的读数，
 * 与"现在要回什么"不冲突），这与改前的行为一致。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ComposerView } from '../features/chat/composer.ts';
import { useT } from '../lib/i18n/useT.ts';
import { PRESS_OPACITY, radius, radiusStyle } from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';

export function ChatComposer({
  draft,
  view,
  modelLabel,
  sendErrorKey,
  inputVisible,
  onChangeDraft,
  onSend,
  onStop,
  onOpenModelPicker,
}: {
  draft: string;
  /** 按钮此刻是什么（见文件头）。 */
  view: ComposerView;
  /** 胶囊上写什么（`features/chat/copy.ts` 的 `modelPillLabel`）。 */
  modelLabel: string;
  /** 发送失败的提示（i18n key）；`null` = 没有。见下面为什么必须说话。 */
  sendErrorKey: string | null;
  /** agent 提问期间把输入行收起来（见文件头）。 */
  inputVisible: boolean;
  /** 用户一动键盘就是在重试，所以清除失败提示也归调用方做（与改前一致）。 */
  onChangeDraft: (next: string) => void;
  onSend: () => void;
  onStop: () => void;
  onOpenModelPicker: () => void;
}) {
  const palette = usePalette();
  const { spacing, typography } = useTheme();
  const insets = useSafeAreaInsets();
  const t = useT();

  return (
    <>
      {/*
        模型胶囊：composer 上方一行，右侧对齐的小胶囊。
        **桌面端同一处**也是这个位置（输入框上方那颗胶囊），点开是模型选择器。
        只读显示 + 可点，不占用输入行——输入行是用户的领地（胶囊塞进去会挤走输入宽度）。
      */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'flex-start',
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.sm,
        }}
      >
        <Pressable
          testID="composer-model"
          accessibilityRole="button"
          // 标签里带上**当前值**：只念"选择模型"的话，VoiceOver 用户听不出现在用的是什么。
          accessibilityLabel={`${t('chat.model.a11y')}, ${modelLabel}`}
          // 胶囊只有 32pt 高（长名字也不该撑成一整块），命中区用 hitSlop 补到 44。
          hitSlop={6}
          onPress={onOpenModelPicker}
          style={({ pressed }) => [
            styles.modelPill,
            {
              backgroundColor: pressed ? palette.field : palette.card,
              borderColor: palette.separator,
            },
          ]}
        >
          <Text style={[typography.caption, { color: palette.secondaryLabel }]} numberOfLines={1}>
            {modelLabel}
          </Text>
        </Pressable>
      </View>

      {inputVisible ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-end',
            paddingHorizontal: spacing.lg,
            paddingBottom: insets.bottom + spacing.sm,
            paddingTop: spacing.sm,
            gap: spacing.sm,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: palette.separator,
            backgroundColor: palette.card,
          }}
        >
          {sendErrorKey === null ? null : (
            /* 就地一行，不是错误卡片：这里离输入框只有一行，而且用户接着就能再按发送
               ——它就是"下一步"，不需要再挂一个按钮（规则 R19）。 */
            <Text
              testID="chat-send-error"
              accessibilityLiveRegion="none"
              style={[typography.caption, { color: palette.destructive }]}
            >
              {t(sendErrorKey)}
            </Text>
          )}
          <TextInput
            value={draft}
            onChangeText={onChangeDraft}
            placeholder={t('chat.placeholder')}
            placeholderTextColor={palette.placeholder}
            multiline
            style={[
              typography.body,
              {
                flex: 1,
                color: palette.label,
                backgroundColor: palette.field,
                // 半高圆角：34pt 高时是胶囊，长高了自然变成圆角矩形。
                ...radiusStyle(radius.lg),
                paddingHorizontal: spacing.md,
                // 上下对称的内边距。给单边额外 padding 会让多行时的首行偏移。
                paddingVertical: spacing.sm,
                // 34pt 起步（与按钮同高），最多约 5 行。
                maxHeight: 120,
                minHeight: 34,
              },
            ]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(view.labelKey)}
            disabled={!view.canSend}
            onPress={view.action === 'stop' ? onStop : onSend}
            /* 全 App 最常按的一颗按钮，视觉上是 34pt 正圆（iOS 消息类 App 的比例，不改），
               但**命中区补到 44pt**：它是唯一一个此前没有 hitSlop 的控件
               （返回键 32+12、模型胶囊 32+6、新建按钮 32+8 都够 44）。
               视觉尺寸不变、命中区 34+5×2 = 44 —— 44 是 iOS HIG 的下限，
               低于它误触率会明显上升，而且这条路径没有别的兜底。 */
            hitSlop={5}
            style={({ pressed }) => [
              styles.send,
              {
                backgroundColor: view.canSend ? palette.accent : palette.field,
                opacity: pressed ? PRESS_OPACITY.button : 1,
              },
            ]}
          >
            <Text
              style={[
                typography.subhead,
                {
                  fontWeight: '600',
                  color: view.canSend ? palette.onAccent : palette.tertiaryLabel,
                },
              ]}
            >
              {/* 形状不变、只换字形：同一个位置，中途不会闪（既有评审结论）。 */}
              {view.glyph}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  modelPill: {
    // 胶囊：32pt 高、横向 12pt 内边距，正好够写下一个模型名（HIG 的最小触控目标是 44，
    // 但这里的 hitSlop 补上——见上面的 hitSlop）。
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
  },
  send: {
    // 34pt 正圆，与输入框起始高度对齐——iOS 消息类 App 的比例。
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
