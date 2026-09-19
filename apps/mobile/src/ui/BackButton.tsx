/**
 * push 页面的返回入口。
 *
 * ## 为什么必须自己画一个
 *
 * 这个项目的路由 `headerShown: false`（标题由各屏自己画，见 `AGENTS.md`），所以**原生导航栏
 * 那个返回箭头不存在**。于是三个 push 目标页（外观 / bot 设置 / 新建 bot / 定时编辑）都只剩
 * iOS 的边缘侧滑手势可退——不知道这个手势的人就卡在页面上了（本轮按"用户会怎么用"过一遍时
 * 明确记下这一条：屏幕上没有任何地方告诉他可以退回去）。
 *
 * 形态取 iOS 的通用语言：标题行左侧一个 `‹`，44pt 触控目标，命中区再放宽一点。
 * 文案不进标题（标题已经很长，再塞"返回"会把标题挤没）；VoiceOver 用 `common.back` 念。
 *
 * ## 没有上一页时
 *
 * 这四种页面都能**被深链直达**（也能在状态恢复后成为栈底）。那时 `back()` 会抛
 * `The action 'GO_BACK' was not handled by any navigator`——本轮的验收脚本就这样抓到过一次
 * （保存成功后界面弹出红色报错，而保存其实成功了）。所以这里统一兜底：能回就回，
 * 回不去就 `replace` 到调用方给的那个**合理的落点**。
 */
import { useRouter, type Href } from 'expo-router';
import React from 'react';
import { Pressable, Text } from 'react-native';

import { useT } from '../lib/i18n/useT.ts';
import { PRESS_OPACITY, typography } from '../lib/theme/tokens.ts';
import { usePalette } from '../lib/theme/context.tsx';

export function BackButton({
  fallback,
  testID = 'back-button',
  guard,
}: {
  /** 没有上一页时去哪儿（必须是这一屏的"上一站"）。 */
  fallback: Href;
  testID?: string;
  /**
   离开前的最后一道闸。返回 `false` = "这一下不让走"（例如这一页有未保存的改动，
   由调用方去弹一个"保存 / 不保存 / 留下"）。

   为什么要留这个口子：`headerShown: false` 之后返回只有这一颗按钮可点，而"点了就走"
   在某些页面上等于**把用户的改动静默丢掉**（bot 设置页就是，见那里的文件头）。
   该不该拦只有那一屏知道，所以闸门放在调用方。
   */
  guard?: () => boolean;
}) {
  const palette = usePalette();
  const t = useT();
  const router = useRouter();

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={t('common.back')}
      hitSlop={12}
      onPress={() => {
        if (guard !== undefined && !guard()) return;
        if (router.canGoBack()) router.back();
        else router.replace(fallback);
      }}
      style={({ pressed }) => ({
        // 44pt 是 HIG 的下限；`‹` 本身很窄，所以宽度给足、靠左对齐。
        minWidth: 44,
        minHeight: 44,
        alignItems: 'flex-start',
        justifyContent: 'center',
        opacity: pressed ? PRESS_OPACITY.control : 1,
      })}
    >
      <Text style={[typography.title3, { color: palette.accent }]}>‹</Text>
    </Pressable>
  );
}
