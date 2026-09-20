/**
 * 新建 bot 的进度页。
 *
 * ## 为什么是轮询而不是 SSE
 *
 * 桌面端走 SSE（`useBotCreateStream`），因为浏览器里一条长连接很自然。iOS 这边用
 * `POST /bots`（不带 `wait_for_ready`）拿到 `creating`，再轮询 `GET /bots/{id}` 到 `ready`：
 * 少一条需要维护的长连接，代价是拉镜像那几十秒里看到的阶段没有逐层字节百分比
 * （桌面端有）。**这是有意的降级**，写在这里免得下一轮以为是漏做了。
 *
 * ## "建成了但设置失败"不算创建失败
 *
 * 与桌面端同一条纪律：bot 记录建出来了就是建出来了。所以这一页只有两种结论——
 * 就绪、或者"还没就绪/失败"。失败时给重试（重新轮询，不是重新创建）。
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  createTimedOut,
  phaseFor,
  pollDelayMs,
  type CreatePhase,
} from '../features/bots/create.ts';
import { useSession } from '../features/session/store.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { GROUP_INSET, radius, spacing, typography } from '../lib/theme/tokens.ts';
import { usePalette } from '../lib/theme/context.tsx';

export function BotCreateProgressScreen({ botId }: { botId: string }) {
  const palette = usePalette();
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, refreshBots } = useSession();

  const [phase, setPhase] = useState<CreatePhase>({ phase: 'creating', polls: 0 });
  const [status, setStatus] = useState('creating');
  const cancelled = useRef(false);

  const poll = useCallback(async () => {
    if (state.client === null || botId === '') return;
    const started = Date.now();
    let polls = 0;
    while (!cancelled.current) {
      try {
        const bot = await state.client.getBot(botId);
        setStatus(bot.status);
        const next = phaseFor(bot.status, polls);
        setPhase(next);
        if (next.phase !== 'creating') return;
      } catch {
        // 单次失败不算失败：网络抖一下很正常，继续轮询（超时兜底）。
        setPhase({ phase: 'creating', polls });
      }
      if (createTimedOut(Date.now() - started)) {
        setPhase({ phase: 'failed', reason: 'timeout' });
        return;
      }
      polls += 1;
      await new Promise((resolve) => setTimeout(resolve, pollDelayMs(polls)));
    }
  }, [botId, state.client]);

  useEffect(() => {
    cancelled.current = false;
    void poll();
    return () => {
      cancelled.current = true;
    };
  }, [poll]);

  /** 就绪后刷新 bot 列表——新 bot 要出现在切换器里。 */
  const onDone = useCallback(() => {
    void refreshBots();
    // iOS 没有桌面端的"bot 详情页"，所以落点是**会话页**（本仓库有意的偏离，见 README）。
    router.replace('/');
  }, [refreshBots, router]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      contentContainerStyle={{
        // 标题自己画，所以要自己让开顶部安全区：这是 push 进来的页，没有原生导航栏兜着。
        // 不写 `insets.top` 的话标题会压在状态栏上（第一版就是这样，被验收截图抓到）。
        paddingTop: insets.top + spacing.xl,
        paddingBottom: insets.bottom + spacing.xxl,
        paddingHorizontal: GROUP_INSET,
        gap: spacing.md,
      }}
    >
      <View style={{ alignItems: 'center', gap: spacing.sm }}>
        {phase.phase === 'creating' ? <ActivityIndicator color={palette.accent} /> : null}
        <Text style={[typography.title3, { color: palette.label, textAlign: 'center' }]}>
          {t('bots.create.progress.title')}
        </Text>
      </View>

      <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
        <StageLine label={t('bots.create.line.record')} state={RECORD_STATE[status] ?? 'waiting'} />
        <StageLine label={t('bots.create.line.workspace')} state={WORKSPACE_STATE[phase.phase]} />
        <StageLine label={t('bots.create.line.ready')} state={READY_STATE[phase.phase]} />
      </View>

      {phase.phase === 'failed' ? (
        <>
          <Text style={[typography.footnote, { color: palette.destructive }]}>
            {phase.reason === 'timeout'
              ? t('bots.create.failed.timeout')
              : t('bots.create.failed.other')}
          </Text>
          <Pressable
            testID="bot-create-retry"
            accessibilityRole="button"
            onPress={() => {
              setPhase({ phase: 'creating', polls: 0 });
              void poll();
            }}
            style={({ pressed }) => ({
              minHeight: 48,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.md,
              backgroundColor: pressed ? palette.field : palette.card,
            })}
          >
            <Text style={[typography.body, { color: palette.accent }]}>{t('common.retry')}</Text>
          </Pressable>
        </>
      ) : null}

      {phase.phase === 'ready' ? (
        <Pressable
          testID="bot-create-done"
          accessibilityRole="button"
          onPress={onDone}
          style={({ pressed }) => ({
            minHeight: 48,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radius.md,
            backgroundColor: pressed ? palette.field : palette.card,
          })}
        >
          <Text style={[typography.body, { color: palette.accent }]}>{t('common.done')}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function StageLine({
  label,
  state,
}: {
  label: string;
  state: 'waiting' | 'active' | 'done' | 'failed';
}) {
  const palette = usePalette();
  const glyph = STAGE_GLYPH[state];
  const color = palette[STAGE_COLOR[state]];
  return (
    <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
      <Text style={[typography.body, { color, width: 18 }]}>{glyph}</Text>
      <Text style={[typography.body, { color: palette.label, flex: 1 }]}>{label}</Text>
    </View>
  );
}

/** 路由组件：参数从 URL 来（这一页可以被深链回来，虽然正常路径是 push）。 */
export function BotCreateProgressRoute() {
  const params = useLocalSearchParams<{ botId?: string }>();
  return <BotCreateProgressScreen botId={typeof params.botId === 'string' ? params.botId : ''} />;
}

/** 阶段 → 三种行的状态。封闭集合一律查表，不写链式三元（AGENTS.md）。 */
const RECORD_STATE: Record<string, 'waiting' | 'done'> = {
  creating: 'done',
  ready: 'done',
};

const WORKSPACE_STATE: Record<CreatePhase['phase'], 'waiting' | 'active' | 'done' | 'failed'> = {
  creating: 'active',
  ready: 'done',
  failed: 'failed',
};

const READY_STATE: Record<CreatePhase['phase'], 'waiting' | 'done'> = {
  creating: 'waiting',
  ready: 'done',
  failed: 'waiting',
};

const STAGE_GLYPH: Record<'waiting' | 'active' | 'done' | 'failed', string> = {
  waiting: '·',
  active: '…',
  done: '✓',
  failed: '✕',
};

const STAGE_COLOR: Record<
  'waiting' | 'active' | 'done' | 'failed',
  'tertiaryLabel' | 'label' | 'success' | 'destructive'
> = {
  waiting: 'tertiaryLabel',
  active: 'label',
  done: 'success',
  failed: 'destructive',
};
