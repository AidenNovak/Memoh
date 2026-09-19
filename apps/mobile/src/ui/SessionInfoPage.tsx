/**
 * 会话信息面板（对应桌面端的 session-info panel）。
 *
 * ## 它回答什么
 *
 * "这个会话到哪儿了"：消息数、上下文用了多少、cache 命中了多少、**这次用过的技能**。
 * 桌面端把这些放在导航栏的一个环里，点开是面板；移动端按设计基线做在**聊天头部**（标题可点）。
 *
 * ## 一条硬规则：不编数
 *
 * 这台部署的服务端**不给上下文窗口**（实测 `GET …/status` 只回 `used_tokens`，
 * 模型配置里也没有 `context_window`）。所以这里**不显示百分比**——没有分母的
 * 百分比是编出来的，而它恰恰会被当成"还有多少余量"的决策依据。
 *
 * 有窗口时（上游较新的部署会给）自动显示进度条与百分比；没窗口时只报绝对值，
 * 并在页脚说明为什么没有比例。宁可少显示一格，也不要给一个假的分母。
 *
 * ## 为什么用系统分组行
 *
 * 形态照 iOS 设置页：`GroupedList` 的分组卡片 + 发丝线。AGENTS.md 要求"系统有
 * 现成的就用现成的"，而且这类"读数值"的界面本来就不该有自绘的图表腔调。
 *
 * ## 分成两半（与审批页同一套）
 *
 * `SessionInfoView` 是纯展示（场景台渲染它），`SessionInfoPage` 是出席页面：
 * 数据从 store 按 `params.sessionId` 取，自己拉一次最新状态，关闭交给契约。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../lib/i18n/useT.ts';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SessionStatus } from '../models/chat.ts';
import {
  formatPercent,
  formatTokenCount,
  sessionInfoView,
  type SessionInfoView as SessionInfoViewData,
} from '../features/session/sessionInfo.ts';
import { useSession } from '../features/session/store.tsx';
import {
  compactFailureOf,
  compactOutcomeOf,
  compactSummaryText,
  type CompactOutcome,
} from '../features/session/compaction.ts';

import { Group, Row } from './GroupedList.tsx';
import { ErrorNotice } from './ErrorNotice.tsx';
import {
  canRetry,
  presentError,
  reasonKeyOf,
  type ErrorPresentation,
} from '../features/errors/present.ts';
import { definePage, usePageRuntime } from '../lib/presentation/index.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';

export interface SessionInfoParams {
  sessionId: string;
}

/**
 纯展示：一份状态 + 取数中/失败的两个标志 + 可选的"立即压缩"动作。
 *
 压缩那一块**由调用方驱动**（它是写操作，要拿着 client 与 botId），这里只负责画：
 按钮在三态下分别是"可点 / 转圈 / 出结果"。这样这个视图仍然是纯展示，能在 `scenes` 里
 单独渲染出来看三种样子。
 */
export function SessionInfoView({
  status,
  loading,
  error,
  onRetry,
  onClose,
  compact,
}: {
  status: SessionStatus | null;
  loading: boolean;
  /**
    读不到会话状态时的**原因**（不是一个拼好的字符串）。

    存呈现对象而不是字符串：这一块要不要给"重试"由错误的性质决定
    （没网/超时/5xx 才给），而不是由写这一屏的人当时的心情决定。
   */
  error: ErrorPresentation | null;
  /** 只有能重试时调用方才会给。 */
  onRetry?: () => void;
  onClose: () => void;
  compact?: {
    busy: boolean;
    outcome: CompactOutcome | null;
    onPress: () => void;
  };
}) {
  const palette = usePalette();
  const { spacing, typography } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const t = useT();

  /**
   * 内容区能用多高。
   *
   * 必须**按可用空间算**而不是写死一个数：写死的话（之前是 460）在窗口给到
   * `context_window` 时行数变多，最后一行会被面板边缘从中间裁掉——看起来像坏了，
   * 而用户未必知道能滚。
   */
  const contentMaxHeight = Math.max(240, windowHeight * 0.85 - (insets.bottom + 120));

  const view = sessionInfoView(status);
  const hasAny = status !== null;
  const compactOutcome = compact?.outcome ?? null;
  const compactText = compactOutcome === null ? null : compactTextOf(compactOutcome, t);

  return (
    /**
     * ⚠️ **整个面板只有一个子视图（这一个 ScrollView）。**
     *
     * formSheet 对子视图数量有约束（react-native-screens 会在控制台警告
     * "FormSheet with ScrollView expects at most 2 subviews"），多出来的那一个会让
     * **无障碍命中框错位**——按钮看得见，但点它落到空处（实测：Maestro 能读到 "Close"
     * 这个标签、点下去却什么都不发生；换成按坐标点也一样，因为框本身是歪的）。
     * 所以标题行放进滚动内容里，而不是和 ScrollView 并列。
     */
    <ScrollView
      testID="session-info-sheet"
      style={{ maxHeight: contentMaxHeight }}
      contentContainerStyle={{
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
        paddingBottom: insets.bottom + spacing.md,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          marginBottom: spacing.sm,
        }}
      >
        <Text style={[typography.title3, { color: palette.label, flex: 1 }]}>
          {t('sessionInfo.title')}
        </Text>
        <Pressable
          testID="session-info-close"
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
          onPress={onClose}
          hitSlop={12}
          style={{
            minWidth: 44,
            minHeight: 44,
            alignItems: 'flex-end',
            justifyContent: 'center',
          }}
        >
          <Text style={[typography.body, { color: palette.accent }]}>{t('common.close')}</Text>
        </Pressable>
      </View>

      {error === null ? null : (
        <View style={{ marginBottom: spacing.md }}>
          <ErrorNotice
            testID="session-info-error"
            title={t('sessionInfo.loadFailed')}
            reason={t(reasonKeyOf(error))}
            action={
              onRetry === undefined ? undefined : { label: t('common.retry'), onPress: onRetry }
            }
          />
        </View>
      )}

      {!hasAny && loading ? (
        <Text style={[typography.footnote, { color: palette.secondaryLabel }]}>
          {t('sessionInfo.loading')}
        </Text>
      ) : null}

      {hasAny ? (
        <Group header={t('sessionInfo.group.context')}>
          {/* 有窗口才有比例。没有分母时这一行不出现——不是显示 0%。 */}
          {view.contextPercent === null ? null : <ContextBar view={view} />}
          <Row
            title={t('sessionInfo.usedTokens')}
            value={formatTokenCount(view.usedTokens)}
            last={view.contextWindow === null}
          />
          {view.contextWindow === null ? null : (
            <Row
              title={t('sessionInfo.window')}
              value={formatTokenCount(view.contextWindow)}
              last={view.autoCompactTokens === null}
            />
          )}
          {view.autoCompactTokens === null ? null : (
            <Row
              title={t('sessionInfo.autoCompact')}
              value={formatTokenCount(view.autoCompactTokens)}
              last={compact === undefined}
            />
          )}
          {/*
              立即压缩：桌面端会话信息面板里就有这一项，iOS 之前只是显示用量、没有任何动作。
              它放在**上下文**这一组里（它作用的对象就是上下文），而不是另开一组。
              busy 时按钮换成转圈：服务端是同步跑完才回，没有进度可报。
            */}
          {compact === undefined ? null : (
            <Pressable
              testID="session-info-compact"
              accessibilityRole="button"
              accessibilityState={{ busy: compact.busy, disabled: compact.busy }}
              disabled={compact.busy}
              onPress={compact.onPress}
              style={({ pressed }) => ({
                minHeight: 44,
                justifyContent: 'center',
                paddingHorizontal: spacing.lg,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: palette.separator,
                backgroundColor: pressed ? palette.field : 'transparent',
              })}
            >
              {compact.busy ? (
                <ActivityIndicator color={palette.secondaryLabel} />
              ) : (
                <Text style={[typography.body, { color: palette.accent }]}>
                  {t('sessionInfo.compact')}
                </Text>
              )}
            </Pressable>
          )}
        </Group>
      ) : null}

      {compactText === null ? null : (
        <Text
          style={[
            typography.footnote,
            {
              color:
                compactOutcome !== null && compactOutcome.kind !== 'ok'
                  ? palette.secondaryLabel
                  : palette.label,
            },
          ]}
        >
          {compactText}
        </Text>
      )}

      {hasAny ? (
        <Group
          header={t('sessionInfo.group.session')}
          footer={view.contextWindow === null ? t('sessionInfo.noWindowFooter') : undefined}
        >
          <Row title={t('sessionInfo.messages')} value={formatTokenCount(view.messageCount)} last />
        </Group>
      ) : null}

      {hasAny ? (
        <Group header={t('sessionInfo.group.cache')}>
          <Row title={t('sessionInfo.hitRate')} value={formatPercent(view.cacheHitRate)} />
          <Row title={t('sessionInfo.cacheRead')} value={formatTokenCount(view.cacheReadTokens)} />
          <Row
            title={t('sessionInfo.input')}
            value={formatTokenCount(view.totalInputTokens)}
            last
          />
        </Group>
      ) : null}

      {/*
          用过的技能：桌面端会话信息面板的最后一块（`session-info-panel.vue` 的 Skills
          段：有名字就逐个列，没有就写一句"此会话未使用任何 Skill"）。这一份列表**不折叠**
          ——一个会话里用过的技能通常就两三个，折叠起来反而要多点一下。
        */}
      {hasAny ? (
        <Group
          header={t('sessionInfo.group.skills')}
          footer={view.skills.length === 0 ? t('sessionInfo.skills.empty') : undefined}
        >
          {view.skills.map((name, index) => (
            <Row
              key={name}
              testID={`session-skill-${name}`}
              title={name}
              last={index === view.skills.length - 1}
            />
          ))}
        </Group>
      ) : null}
    </ScrollView>
  );
}

/**
 * 出席页面。
 *
 * 一进来就拉一次 `/status`——面板里的数字必须是"现在的"，不能是进会话时那一份。
 * 拉失败且**手里没有数**时才报错：已经有数的情况下，一次刷新失败不该把面板变成一片红
 * （那会把"有数据但没刷新上"说成"读不到"）。
 */
function SessionInfoPresentedView() {
  const runtime = usePageRuntime<SessionInfoParams>();
  const { sessionId } = runtime.params;
  const { sessionStatusFor, refreshSessionStatus, state: sessionState, currentBot } = useSession();
  const [state, setState] = useState<{ loading: boolean; failed: boolean }>({
    loading: true,
    failed: false,
  });
  /** 上一次读取失败的原因（给呈现用）。 */
  const [failure, setFailure] = useState<ErrorPresentation | null>(null);
  /** 重试计数：换一个值就重跑下面那个 effect，走的是与首次完全相同的一条路。 */
  const [attempt, setAttempt] = useState(0);
  /** 手动压缩：busy + 结论。它是写操作，所以状态留在这一层（视图只管画）。 */
  const [compact, setCompact] = useState<{ busy: boolean; outcome: CompactOutcome | null }>({
    busy: false,
    outcome: null,
  });

  const runCompact = useCallback(() => {
    const client = sessionState.client;
    const botId = currentBot?.id;
    if (client === null || botId === undefined || compact.busy) return;
    setCompact({ busy: true, outcome: null });
    void (async () => {
      try {
        const result = await client.compactSession(botId, sessionId);
        setCompact({ busy: false, outcome: compactOutcomeOf(result) });
        // 压缩真的动了上下文，所以面板上的数字必须**重新拉**——不拉的话用户看到的还是
        // 压缩前那一份，会以为刚才那一按什么都没发生。
        await refreshSessionStatus(sessionId).catch(() => undefined);
      } catch (caught) {
        setCompact({ busy: false, outcome: compactFailureOf(caught) });
      }
    })();
  }, [compact.busy, currentBot?.id, refreshSessionStatus, sessionId, sessionState.client]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refreshSessionStatus(sessionId);
        if (cancelled) return;
        setState({ loading: false, failed: false });
        setFailure(null);
      } catch (caught) {
        if (cancelled) return;
        // 读不到**不能画成"没有数据"**：那会让用户以为这个会话没有上下文这把账。
        // 原因与动作都交给 `presentError`（能不能重试不由这一屏定）。
        setState({ loading: false, failed: true });
        setFailure(presentError(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, refreshSessionStatus, sessionId]);

  const reload = useCallback(() => {
    setState({ loading: true, failed: false });
    setFailure(null);
    setAttempt((n) => n + 1);
  }, []);

  const status = sessionStatusFor(sessionId);

  // 真路由（`?info=1` 的深链路径）也走同一个视图；出席时关闭交给契约。
  const onClose = () => runtime.cancel();

  return (
    <SessionInfoView
      status={status}
      loading={state.loading}
      error={state.failed && status === null ? failure : null}
      onRetry={failure !== null && canRetry(failure) ? reload : undefined}
      onClose={onClose}
      // 只有拿得到 client 与 botId 时才给这个动作（深链直接进来、会话还没落地的情形）。
      compact={
        sessionState.client === null || currentBot === null
          ? undefined
          : { busy: compact.busy, outcome: compact.outcome, onPress: runCompact }
      }
    />
  );
}

/**
 * 上下文用量条。
 *
 * 只在**有窗口**时渲染（调用点已经保证）。轨道用系统分组底色、进度用品牌色：
 * 这是"用量"不是"警告"，不到阈值不用红黄——上游也是这个态度。
 */
function ContextBar({ view }: { view: SessionInfoViewData }) {
  const palette = usePalette();
  const { spacing, radius, typography } = useTheme();
  const t = useT();
  const percent = view.contextPercent ?? 0;

  return (
    <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
        <Text style={[typography.subhead, { color: palette.label, flex: 1 }]}>
          {t('sessionInfo.contextUsage')}
        </Text>
        <Text style={[typography.subhead, { color: palette.secondaryLabel }]}>
          {formatPercent(percent)}
        </Text>
      </View>
      <View
        style={{
          height: 6,
          marginTop: spacing.sm,
          borderRadius: radius.sm,
          backgroundColor: palette.field,
          overflow: 'hidden',
        }}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(percent) }}
      >
        <View
          style={{
            width: `${percent}%`,
            height: '100%',
            backgroundColor: palette.accent,
          }}
        />
      </View>
    </View>
  );
}

/**
 * 会话信息页。
 *
 * `detents: 'fitToContents'`：这是只读的数值面板，让它贴着内容高度最自然——半屏会把
 * cache 那一组切掉一半，全屏又太空。内容真的比屏幕高时才进入滚动（视图里有 maxHeight）。
 */
export const SessionInfoPage = definePage<SessionInfoParams>({
  id: 'sessionInfo',
  title: 'Session info',
  Component: SessionInfoPresentedView,
  parseRouteParams: (params) => ({ sessionId: String(params.sessionId ?? '') }),
  presentation: {
    dismissible: true,
    detents: [0.5, 1],
    initialDetent: 0,
    grabber: true,
    headerShown: false,
  },
});

/** 压缩结果那一行。文案 key 由纯逻辑给（见 `features/session/compaction.ts`）。 */
/** `useT()` 的返回类型：直接取自它自己，别手写一个形状（手写的迟早对不上）。 */
type Translate = ReturnType<typeof useT>;

function compactTextOf(outcome: CompactOutcome, t: Translate): string {
  const line = compactSummaryText(outcome);
  if (line === null) return '';
  // `unavailable` 带着服务端写的原因（哪个模型不可用），原样附在后面——那是唯一能
  // 告诉用户"该怎么办"的信息。
  if (outcome.kind === 'unavailable' && outcome.reason !== '') {
    return `${t(line.key)}${outcome.reason}`;
  }
  return line.values === undefined ? t(line.key) : t(line.key, line.values);
}
