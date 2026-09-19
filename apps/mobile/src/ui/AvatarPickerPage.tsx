/**
 * 头像选择器（bot 设置里那一行点开的原生 sheet）——**挑是主路径，打字是次路径**。
 *
 * ## 它改的是哪一件事
 *
 * 改前"换头像"只有一条路：在设置页那一行里**手打一个图片网址**（占位符 `https://…`）。
 * 那等于要求用户先自己拥有一个可公开访问的图片地址——这是把我们的实现细节当成了用户的前提。
 * 成熟应用在这一步给的是**可挑的一组**（Mail / 通讯录 / Reminders 都如此），打字只是最后那个
 * "我另有图"的出口。所以这一页：
 *
 * | 位置 | 是什么 | 代价 |
 * | --- | --- | --- |
 * | 上面那张网格 | 内置头像 + 「默认」 | 一眼能认出、不打字、离线可用 |
 * | 下面那个分组 | 自定义图片网址（**能力保留**） | 仍要自己有一个地址——所以它降级成次要那条 |
 *
 * 网址这条路**没有删**：自托管用户接自己的对象存储是真实需求。改的只是**它在门口的位置**。
 *
 * ## 值从哪来、到哪去
 *
 * 这一页只回一个字符串（`avatarUrl`），落库形态完全由 `features/bots/avatarPresets.ts` 决定：
 * 挑内置 → `memoh:avatar/<slug>`；挑默认 → 空串（回到吉祥物）；自定义 → 用户打的那个网址。
 * 三种值都走同一条差分保存（`features/bots/settings.ts` 的 `patchFrom`），服务端形状照旧
 * ——没有新端点、没有新字段。好处与代价写在 `avatarPresets.ts` 的文件头与
 * `docs/research/settings-tradeoffs-memoh.md` §8。
 *
 * ## 为什么点一下就关（与 `LanguagePickerSheet` 一致）
 *
 * 它是"挑一个"的瞬时流程，不是一页内容：挑完立刻关、结果回给调用方当草稿（还没保存，
 * 用户改主意只要不点保存就什么都没发生）。自定义网址那一组例外——打字要时间，所以它
 * 由键盘的"完成"或下面那行"用这个图片"来提交。
 */
import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { avatarFor } from '../features/bots/avatar.ts';
import {
  BUILTIN_AVATARS,
  builtinAvatarToken,
  isBuiltinAvatar,
  type BuiltinAvatar,
} from '../features/bots/avatarPresets.ts';
import { definePage, usePageRuntime } from '../lib/presentation/page.tsx';
import { useT } from '../lib/i18n/useT.ts';
import {
  GROUP_INSET,
  MIN_TOUCH_TARGET,
  PRESS_OPACITY,
  radius,
  radiusStyle,
  spacing,
  typography,
} from '../lib/theme/tokens.ts';
import { usePalette } from '../lib/theme/context.tsx';
import { BotAvatar } from './BotAvatar.tsx';
import { Group, Row } from './GroupedList.tsx';

export interface AvatarPickerParams {
  /** 当前草稿值（空串 = 默认吉祥物；`memoh:avatar/<slug>` = 内置；其余 = 自定义网址）。 */
  avatarUrl: string;
}

export interface AvatarPickerResult {
  avatarUrl: string;
}

/** 格子边长。48 的图 + 两侧各 8 的内边距（选中环画在那圈内边距里）。 */
const TILE = 64;

function AvatarPickerPresentedView() {
  const palette = usePalette();
  const t = useT();
  const runtime = usePageRuntime<AvatarPickerParams, AvatarPickerResult>();
  const current = runtime.params.avatarUrl;

  /**
   自定义网址那一栏的初值：**当前值就是网址**时才填进去。

   内置标识不能回填进这个输入框——它长得像个 scheme，用户会以为要照着它改；而且那样
   打开选择器时看起来像"我选的是自定义"，与他实际挑的那一枚对不上。
   */
  const [custom, setCustom] = useState(current !== '' && !isBuiltinAvatar(current) ? current : '');

  const plan = avatarFor({ avatar_url: current });
  const selectedSlug = plan.kind === 'builtin' ? plan.slug : null;
  /** 当前值是空串 = 选的是"默认"。 */
  const defaultSelected = plan.kind === 'mark';

  const pickDefault = useCallback(() => {
    runtime.finish({ avatarUrl: '' });
  }, [runtime]);

  const pickBuiltin = useCallback(
    (preset: BuiltinAvatar) => {
      runtime.finish({ avatarUrl: builtinAvatarToken(preset) });
    },
    [runtime],
  );

  /**
   提交自定义网址。**不校验格式**：服务端本来就不校验（`strings.TrimSpace` 直接进库），
   而在这里做一套只有我们认的校验，只会把"我们的桶地址"挡在外面。画不出来时
   `BotAvatar` 已经会退回吉祥物（那条判据有测试），所以坏值不会变成空白方块。
   */
  const applyCustom = useCallback(() => {
    runtime.finish({ avatarUrl: custom.trim() });
  }, [custom, runtime]);

  const hasCustom = custom.trim() !== '';

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      contentContainerStyle={{ paddingTop: spacing.md, paddingBottom: spacing.xl }}
      // 边打字边点：不设它的话第一次点击只会收键盘，看起来像"点了没反应"。
      keyboardShouldPersistTaps="handled"
    >
      <Group header={t('avatar.builtin.group')}>
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            paddingHorizontal: GROUP_INSET,
            paddingVertical: spacing.md,
            rowGap: spacing.md,
          }}
        >
          {/* 「默认」排第一个：它是"我什么都不挑"的那个选项，也是现在不加任何东西时的样子。 */}
          <AvatarTile
            testID="avatar-option-default"
            label={t('avatar.default')}
            avatarUrl=""
            selected={defaultSelected}
            onPress={pickDefault}
          />
          {BUILTIN_AVATARS.map((preset) => (
            <AvatarTile
              key={preset.slug}
              testID={`avatar-option-${preset.slug}`}
              label={t(preset.nameKey)}
              avatarUrl={builtinAvatarToken(preset)}
              selected={selectedSlug === preset.slug}
              onPress={() => pickBuiltin(preset)}
            />
          ))}
        </View>
      </Group>

      {/*
        自定义网址：**能力保留、位置降级**。它自己一栏、在网格下面——进得来是刻意的，
        但不必先经过它。脚注说清"什么时候需要它"，而不是解释什么是 URL。
      */}
      <Group header={t('avatar.custom.group')} footer={t('avatar.custom.hint')}>
        <Row
          testID="avatar-custom-url"
          title={t('avatar.custom')}
          last={!hasCustom}
          accessory={
            <TextInput
              testID="avatar-custom-input"
              value={custom}
              onChangeText={setCustom}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="done"
              // 键盘上的"完成"就等于提交：这一步只有一个字段，不该逼用户再找一个按钮。
              onSubmitEditing={applyCustom}
              placeholder={t('avatar.custom.placeholder')}
              placeholderTextColor={palette.tertiaryLabel}
              accessibilityLabel={t('avatar.custom')}
              style={[
                typography.body,
                {
                  color: palette.label,
                  minWidth: 120,
                  maxWidth: '60%',
                  textAlign: 'right',
                },
              ]}
            />
          }
        />
        {/* 空的时候不画这一行：它只在"有东西可提交"时才是一个动作。 */}
        {hasCustom ? (
          <Row
            testID="avatar-custom-apply"
            title={t('avatar.custom.apply')}
            last
            onPress={applyCustom}
          />
        ) : null}
      </Group>
    </ScrollView>
  );
}

/**
 一个头像格子。

 画的是**真组件**（`BotAvatar`）而不是自己拼一遍：选择器里看到的必须就是列表里、页头那个
 位置将要画出来的样子——自己拼一份就多了一处会漂的重复（哪天头像的画法改了，选择器里
 还是旧样子）。

 选中态用**一圈品牌色描边**（不是勾）：这些头像本身是彩色的方块图形，叠一个勾会脏；
 描边是 iOS 选图那套语言，而且不遮住图形本身。
 */
function AvatarTile({
  testID,
  label,
  avatarUrl,
  selected,
  onPress,
}: {
  testID: string;
  label: string;
  avatarUrl: string;
  selected: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      // 读屏要能说出"现在选的是这个"（否则听一遍整页也不知道当前值在哪一项）。
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        width: TILE,
        alignItems: 'center',
        gap: spacing.xs,
        // 触控目标下限：图形 48 + 内边距 + 下面那行名字，整体高于 44。
        minHeight: MIN_TOUCH_TARGET,
      }}
    >
      {({ pressed }) => (
        <>
          <View
            style={[
              {
                padding: 5,
                borderWidth: 2,
                borderColor: selected ? palette.accent : 'transparent',
                opacity: pressed ? PRESS_OPACITY.control : 1,
              },
              radiusStyle(radius.md + 5),
            ]}
          >
            <BotAvatar bot={{ avatar_url: avatarUrl }} size={48} />
          </View>
          <Text
            numberOfLines={1}
            style={[typography.caption, { color: palette.secondaryLabel }]}
            // 名字只是这一格的说明；读屏的元素是上面那个按钮，名字已经进了它的标签。
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

export const AvatarPickerSheet = definePage<AvatarPickerParams, AvatarPickerResult>({
  id: 'avatarPicker',
  title: 'Avatar',
  Component: AvatarPickerPresentedView,
  parseRouteParams: (params) => ({ avatarUrl: String(params.avatarUrl ?? '') }),
  presentation: {
    dismissible: true,
    detents: [0.7, 1],
    initialDetent: 0,
    grabber: true,
    headerShown: false,
  },
});
