/**
 * composer 里的斜杠菜单（`/`）。
 *
 * ## 形态：一张内联的候选列表，不是弹窗
 *
 * 桌面端是一个浮在内容之上的 listbox。iOS 上把它做成**输入区上方的一张内联卡片**：
 * 菜单和输入框在同一个视觉块里，手指不用离开键盘区（弹出居中对话框会遮住对话、还要多一次
 * 关闭动作）。列表最多显示几条，超出的可以滚。
 *
 * ## 为什么不是"按了 `/` 就替换输入框内容"
 *
 * 草稿始终是用户自己的文本。菜单只是**建议**：
 *
 * - 选内置动作（`/new`、`/model`）→ 立刻执行，草稿清掉；
 * - 选技能 → 把 `/name ` 填进草稿，光标等用户写参数（技能是要带 prompt 的）。
 *
 * 这样用户可以先打 `/sk` 把范围缩小，也可以直接 `/<skill> 正文` 一把打完再发送——两条路
 * 都不需要"菜单必须先关掉"。
 *
 * ## 技能清单拉不到时，菜单里要说出来
 *
 * 拉不到清单不等于"这台 bot 没有技能"（规则 R41）。以前两种情况一个样：菜单里只剩
 * `/new`、`/model`，用户以为自己的技能没了。现在失败时在菜单**底部**加一句我们自己的话
 * （发生了什么 + 为什么 + 下一步），仍然不打断输入。
 *
 * 它**不进 alert**：用户正在打字，这里离输入框一行，而且它不阻塞任何事——技能本来也可以
 * 直接手打 `/name 正文` 发出去（规则 R1/R3）。
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { SlashItem } from '../features/chat/slash.ts';
import { canRetry, reasonKeyOf, type ErrorPresentation } from '../features/errors/present.ts';
import { useT } from '../lib/i18n/useT.ts';
import { MIN_TOUCH_TARGET, radius, spacing, typography } from '../lib/theme/tokens.ts';
import { usePalette } from '../lib/theme/context.tsx';
import { ErrorNotice } from './ErrorNotice.tsx';

export function SlashMenu({
  items,
  onPick,
  skillsFailure,
  onRetrySkills,
}: {
  items: SlashItem[];
  onPick: (item: SlashItem) => void;
  /** 技能清单拉不到时的呈现。`null` = 拉到了（或还没开始拉）——那就不该多说什么。 */
  skillsFailure?: ErrorPresentation | null;
  /** 只有能重试时才给（`canRetry`）。 */
  onRetrySkills?: () => void;
}) {
  const palette = usePalette();
  const t = useT();

  const failure = skillsFailure ?? null;
  // 清单拉不到、且内置动作也没匹配到任何东西时，菜单本来会整块消失——那样用户连
  // "没拉到"都看不到。所以有错误时这一块必须留着。
  if (items.length === 0 && failure === null) return null;

  return (
    <View
      testID="slash-menu"
      style={{
        marginHorizontal: spacing.lg,
        marginBottom: spacing.sm,
        backgroundColor: palette.card,
        borderColor: palette.separator,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: radius.md,
        overflow: 'hidden',
      }}
    >
      <ScrollView style={{ maxHeight: 220 }} keyboardShouldPersistTaps="always">
        {items.map((item, index) => {
          const hint = item.descriptionIsKey ? t(item.description) : item.description;
          return (
            <Pressable
              key={`${item.kind}-${item.name}`}
              testID={`slash-item-${item.name}`}
              accessibilityRole="button"
              accessibilityLabel={`${item.label}, ${hint}`}
              onPress={() => onPick(item)}
              style={({ pressed }) => ({
                minHeight: MIN_TOUCH_TARGET,
                justifyContent: 'center',
                paddingHorizontal: spacing.md,
                paddingVertical: 8,
                gap: 1,
                backgroundColor: pressed ? palette.field : 'transparent',
                borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                borderTopColor: palette.separator,
              })}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Text style={[typography.callout, { color: palette.label }]} numberOfLines={1}>
                  {item.label}
                </Text>
                {item.kind === 'skill' ? null : (
                  <Text style={[typography.caption, { color: palette.tertiaryLabel }]}>
                    {t('chat.slash.builtin.badge')}
                  </Text>
                )}
              </View>
              {hint === '' ? null : (
                <Text
                  style={[typography.footnote, { color: palette.secondaryLabel }]}
                  numberOfLines={2}
                >
                  {hint}
                </Text>
              )}
            </Pressable>
          );
        })}
      </ScrollView>

      {failure === null ? null : (
        /* 菜单底部：说清"清单没拉到 + 为什么 + 能做什么"。`canRetry` 是唯一的判据——
           凭据失效/没权限时这一块只有一句解释，没有可点的东西（规则 R19/R21）。 */
        <View
          style={{
            padding: spacing.md,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: palette.separator,
          }}
        >
          <ErrorNotice
            testID="slash-skills-error"
            title={t('chat.slash.skillsFailed')}
            reason={t(reasonKeyOf(failure))}
            action={
              onRetrySkills === undefined || !canRetry(failure)
                ? undefined
                : { label: t('common.retry'), onPress: onRetrySkills }
            }
          />
        </View>
      )}
    </View>
  );
}
