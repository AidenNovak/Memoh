/**
 * 模型与思考强度选择器（composer 上那颗胶囊点开的原生 sheet）。
 *
 * ## 形态照桌面端，但只搬能搬的
 *
 * 桌面端是一颗胶囊 → 弹出带**搜索框**的对话框，按 provider 分组、当前项打勾，对话框底部
 * 一行 `Reasoning → Off`（当前模型不支持思考时置灰）。
 *
 * 这里逐条对应：
 *
 * | 桌面端 | 这里 |
 * | --- | --- |
 * | 搜索框 | 同一个（模型多了没搜索就是个只能滚的列表） |
 * | 按 provider 分组 | 同（拿不到 provider 名字就平铺，不拿 uuid 当标题） |
 * | provider 图标 | 分组标题左侧一颗**单色**厂商标（`ui/ProviderIcon.tsx`）：与标题同色、跟旁边的
 *   系统图标重量相当；认不出的厂商（自托管用户接任何家）给一颗中性 glyph，**不留白** |
 * | 当前项打勾 | 同 |
 * | `Reasoning → 档位` | 同，但**只在模型真支持思考时**出现 |
 * | 每个模型显示"能力标签" | **不搬**：那些 `compatibilities` 标签（tool-call 之类）是配置期才关心的东西 |
 *
 * ## 强度为什么单独一段
 *
 * 强度是"这个模型的思考档位"，不是"另一个模型"。混进同一张列表里，用户会把它当成一个
 * 可选的模型。桌面端也把它放在列表**下方**、单独一行。
 *
 * ## 数据从哪来
 *
 * `GET /models` + `GET /providers`，两者都在打开这一页时拉（不是启动时）——模型目录会变，
 * 而用户一天可能只改一次。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { ModelSummary, ProviderSummary } from '../api/types.ts';
import {
  DEFAULT_CHOICE,
  effortChoices,
  effortLabelKey,
  filterSections,
  findModel,
  sectionsFrom,
  type ComposerChoice,
  type ModelSection,
} from '../features/chat/models.ts';
import { useSession } from '../features/session/store.tsx';
import { definePage, usePageRuntime } from '../lib/presentation/page.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { GROUP_INSET, MIN_TOUCH_TARGET, radius, spacing, typography } from '../lib/theme/tokens.ts';
import { usePalette } from '../lib/theme/context.tsx';
import { ProviderIcon } from './ProviderIcon.tsx';
import {
  canRetry,
  presentError,
  reasonKeyOf,
  type ErrorPresentation,
} from '../features/errors/present.ts';
import { ErrorNotice } from './ErrorNotice.tsx';

/** 打开时带进来的当前选择；选完返回新的选择。取消 = `cancelled`（调用方不动现状）。 */
export type ModelPickerParams = ComposerChoice;

function ModelPickerPresentedView() {
  const palette = usePalette();
  const t = useT();
  const { state } = useSession();
  // 参数与 finish 都从运行时来：`Component` 不接 props（见 page.tsx 的契约）。
  const runtime = usePageRuntime<ModelPickerParams, ComposerChoice>();

  const [sections, setSections] = useState<ModelSection[] | null>(null);
  const [query, setQuery] = useState('');
  const [choice, setChoice] = useState<ComposerChoice>(runtime.params ?? DEFAULT_CHOICE);
  /**
    拉不到目录时的**原因**（不只是"失败了"一个布尔）。

    这个选择器是一页"只能用列表"的界面——列表为空就等于这一页没有内容，所以失败必须
    说清：是服务端没有模型（400/无内容），还是连不上（等一下可能就好）。前者重试没有用，
    后者重试是对的。判据在 `features/errors/present.ts`。
   */
  const [failure, setFailure] = useState<ErrorPresentation | null>(null);
  // 每次重试都换一个 token 来触发 effect；用它比"手动调一遍"可靠：重试走的是和首次
  // 完全相同的那条路（同样会重新拉 provider、同样会清掉上一次的失败）。
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (state.client === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const [modelsPayload, providersPayload] = await Promise.all([
          state.client?.listModels(),
          // provider 名字是"锦上添花"：拿不到就平铺，**不能让整页因此失败**。
          state.client?.listProviders().catch(() => [] as ProviderSummary[]),
        ]);
        if (cancelled) return;
        const models: ModelSummary[] = Array.isArray(modelsPayload)
          ? modelsPayload
          : (modelsPayload?.items ?? []);
        const providers: ProviderSummary[] = Array.isArray(providersPayload)
          ? providersPayload
          : (providersPayload?.providers ?? []);
        setSections(sectionsFrom(models, providers));
        setFailure(null);
      } catch (caught) {
        if (cancelled) return;
        setFailure(presentError(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.client, attempt]);

  const visible = useMemo(
    () => (sections === null ? null : filterSections(sections, query)),
    [sections, query],
  );

  const current = useMemo(
    () => (sections === null ? null : findModel(sections, choice.modelId ?? '')),
    [choice.modelId, sections],
  );

  const pick = useCallback(
    (modelId: string | null) => {
      if (modelId === null) {
        setChoice(DEFAULT_CHOICE);
        runtime.finish(DEFAULT_CHOICE);
        return;
      }
      const model = sections === null ? null : findModel(sections, modelId);
      const next: ComposerChoice = {
        modelId,
        // 换模型时强度跟着该模型的默认值——上回那个档位属于上一个模型，跟过来是错的。
        reasoningEffort:
          model?.supportsReasoning === true
            ? model.defaultEffort === ''
              ? null
              : model.defaultEffort
            : null,
      };
      setChoice(next);
      runtime.finish(next);
    },
    [runtime, sections],
  );

  const setEffort = useCallback(
    (effort: string | null) => {
      const next = { modelId: choice.modelId, reasoningEffort: effort };
      setChoice(next);
      runtime.finish(next);
    },
    [choice.modelId, runtime],
  );

  const efforts = effortChoices(current);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      contentContainerStyle={{ paddingTop: spacing.md, paddingBottom: spacing.xl }}
      keyboardShouldPersistTaps="handled"
    >
      <TextInput
        testID="model-search"
        value={query}
        onChangeText={setQuery}
        placeholder={t('chat.model.search')}
        placeholderTextColor={palette.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          typography.body,
          {
            marginHorizontal: GROUP_INSET,
            marginBottom: spacing.md,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            minHeight: MIN_TOUCH_TARGET,
            color: palette.label,
            backgroundColor: palette.field,
            borderRadius: radius.md,
          },
        ]}
      />

      {sections === null ? (
        <View style={{ paddingHorizontal: GROUP_INSET, paddingTop: spacing.xl }}>
          {failure === null ? (
            <View style={{ alignItems: 'center' }}>
              <ActivityIndicator color={palette.secondaryLabel} />
            </View>
          ) : (
            <ErrorNotice
              testID="model-picker-error"
              title={t('chat.model.failed')}
              reason={t(reasonKeyOf(failure))}
              action={
                canRetry(failure)
                  ? { label: t('common.retry'), onPress: () => setAttempt((n) => n + 1) }
                  : undefined
              }
            />
          )}
        </View>
      ) : (
        <>
          {/* 「跟随服务端默认」也是一项：用户改过之后必须能改回来，
              否则一旦选过就再也回不到"让服务端决定"。 */}
          <Text
            style={[
              typography.footnote,
              {
                color: palette.secondaryLabel,
                paddingHorizontal: GROUP_INSET,
                marginBottom: spacing.xs,
              },
            ]}
          >
            {t('chat.model.default.group')}
          </Text>
          <View
            style={[styles.card, { backgroundColor: palette.card, marginHorizontal: GROUP_INSET }]}
          >
            <PickerRow
              testID="model-row-default"
              title={t('chat.model.default')}
              subtitle={t('chat.model.default.hint')}
              selected={choice.modelId === null}
              last
              onPress={() => pick(null)}
            />
          </View>

          {(visible ?? []).map((section, sectionIndex) => (
            <View key={section.title ?? `flat-${sectionIndex}`}>
              {section.title === null ? null : (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    // 厂商图标与标题**同一行**：分组标题旁边那颗图标属于这个标题，
                    // 单独一行会变成"标题上面有个东西"。
                    gap: spacing.xs,
                    paddingHorizontal: GROUP_INSET,
                    marginTop: spacing.lg,
                    marginBottom: spacing.xs,
                  }}
                >
                  <ProviderIcon name={section.title} />
                  <Text
                    style={[typography.footnote, { color: palette.secondaryLabel, flexShrink: 1 }]}
                  >
                    {section.title}
                  </Text>
                </View>
              )}
              <View
                style={[
                  styles.card,
                  {
                    backgroundColor: palette.card,
                    marginHorizontal: GROUP_INSET,
                    marginTop: section.title === null ? spacing.lg : 0,
                  },
                ]}
              >
                {section.models.map((model, index) => (
                  <PickerRow
                    key={model.modelId}
                    testID={`model-row-${model.modelId}`}
                    title={model.name}
                    subtitle={
                      model.supportsReasoning ? t('chat.model.reasoning.supported') : model.modelId
                    }
                    selected={choice.modelId === model.modelId}
                    last={index === section.models.length - 1}
                    onPress={() => pick(model.modelId)}
                  />
                ))}
              </View>
            </View>
          ))}

          {/* 强度段：只有当前模型支持思考时才出现。 */}
          {efforts.length === 0 ? null : (
            <>
              <Text
                style={[
                  typography.footnote,
                  {
                    color: palette.secondaryLabel,
                    paddingHorizontal: GROUP_INSET,
                    marginTop: spacing.lg,
                    marginBottom: spacing.xs,
                  },
                ]}
              >
                {t('chat.model.reasoning')}
              </Text>
              <View
                style={[
                  styles.card,
                  { backgroundColor: palette.card, marginHorizontal: GROUP_INSET },
                ]}
              >
                {efforts.map((effort, index) => {
                  const key = effortLabelKey(effort);
                  return (
                    <PickerRow
                      key={effort}
                      testID={`effort-row-${effort}`}
                      title={key === null ? effort : t(key)}
                      selected={(choice.reasoningEffort ?? '') === effort}
                      last={index === efforts.length - 1}
                      onPress={() => setEffort(effort)}
                    />
                  );
                })}
              </View>
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

function PickerRow({
  title,
  subtitle,
  selected,
  last,
  testID,
  onPress,
}: {
  title: string;
  subtitle?: string;
  selected: boolean;
  last: boolean;
  testID: string;
  onPress: () => void;
}) {
  const palette = usePalette();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: MIN_TOUCH_TARGET,
        paddingHorizontal: spacing.lg,
        paddingVertical: 10,
        gap: 1,
        backgroundColor: pressed ? palette.field : 'transparent',
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: palette.separator,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Text style={[typography.body, { color: palette.label, flex: 1 }]} numberOfLines={1}>
          {title}
        </Text>
        {selected ? <Text style={[typography.body, { color: palette.accent }]}>✓</Text> : null}
      </View>
      {subtitle === undefined ? null : (
        <Text style={[typography.footnote, { color: palette.tertiaryLabel }]} numberOfLines={1}>
          {subtitle}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.md, overflow: 'hidden' },
});

export const ModelPickerSheet = definePage<ModelPickerParams, ComposerChoice>({
  id: 'modelPicker',
  title: 'Model',
  Component: ModelPickerPresentedView,
  // 真路由（深链）时参数只可能来自 URL；这里没有可深链的场景，所以给一份"跟随默认"。
  parseRouteParams: () => DEFAULT_CHOICE,
  presentation: {
    dismissible: true,
    // 半屏起（模型多了可以往上拉），顶上有抓手——它是"挑一个"的瞬时流程，不是一页内容。
    detents: [0.5, 1],
    initialDetent: 0,
    grabber: true,
    headerShown: false,
  },
});
