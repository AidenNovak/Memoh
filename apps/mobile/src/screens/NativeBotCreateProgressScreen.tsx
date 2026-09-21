/**
 * 新建 bot 进度页的 RN 薄桥（模块 7）。
 *
 * 原生只画三行阶段与重试/完成按钮；轮询（`GET /bots/{id}` 到 `ready`，超时兜底）、
 * 阶段判据（`features/bots/create.ts`）与就绪后的路由都留在 RN——与原 RN 版同一套语义，
 * 未改判据（为什么是轮询而不是 SSE、为什么"设置失败不算创建失败"见原文件头）。
 */
import { NativeBotFormView, type NativeBotFormModel } from '@memoh-ios/kit';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import {
  createTimedOut,
  phaseFor,
  pollDelayMs,
  type CreatePhase,
} from '../features/bots/create.ts';
import { useSession } from '../features/session/store.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { useTheme } from '../lib/theme/context.tsx';

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

const STAGE_TONE: Record<'waiting' | 'active' | 'done' | 'failed', string> = {
  waiting: 'muted',
  active: 'label',
  done: 'ok',
  failed: 'bad',
};

export function NativeBotCreateProgressScreen({ botId }: { botId: string }) {
  const t = useT();
  const router = useRouter();
  const { mode } = useTheme();
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

  /** 就绪后刷新 bot 列表——新 bot 要出现在切换器里。落点是会话页（本仓库有意的偏离）。 */
  const onDone = useCallback(() => {
    void refreshBots();
    router.replace('/');
  }, [refreshBots, router]);

  const model = useMemo<NativeBotFormModel>(() => {
    const stageRow = (
      id: string,
      label: string,
      stageState: 'waiting' | 'active' | 'done' | 'failed',
    ) => ({
      id,
      kind: 'glyph' as const,
      label,
      glyph: STAGE_GLYPH[stageState],
      tone: STAGE_TONE[stageState],
    });
    const sections: NativeBotFormModel['sections'] = [
      {
        id: 'stages',
        rows: [
          stageRow(
            'bot-create-line-record',
            t('bots.create.line.record'),
            RECORD_STATE[status] ?? 'waiting',
          ),
          stageRow(
            'bot-create-line-workspace',
            t('bots.create.line.workspace'),
            WORKSPACE_STATE[phase.phase],
          ),
          stageRow('bot-create-line-ready', t('bots.create.line.ready'), READY_STATE[phase.phase]),
        ],
      },
    ];
    if (phase.phase === 'failed') {
      sections.push({
        id: 'failed',
        rows: [
          {
            id: 'bot-create-failed',
            kind: 'info',
            value:
              phase.reason === 'timeout'
                ? t('bots.create.failed.timeout')
                : t('bots.create.failed.other'),
          },
          { id: 'bot-create-retry', kind: 'button', label: t('common.retry'), action: 'retry' },
        ],
      });
    }
    if (phase.phase === 'ready') {
      sections.push({
        id: 'done',
        rows: [{ id: 'bot-create-done', kind: 'button', label: t('common.done'), action: 'done' }],
      });
    }
    return {
      status: 'ready',
      title: t('bots.create.progress.title'),
      spinner: phase.phase === 'creating',
      showBack: false,
      sections,
    };
  }, [phase, status, t]);

  return (
    <View style={{ flex: 1 }}>
      <NativeBotFormView
        style={{ flex: 1 }}
        mode={mode}
        modelJson={JSON.stringify(model)}
        onAction={(event) => {
          const action = event.nativeEvent.action;
          if (action === 'retry') {
            setPhase({ phase: 'creating', polls: 0 });
            void poll();
          } else if (action === 'done') onDone();
        }}
      />
    </View>
  );
}

/** 路由组件：参数从 URL 来（这一页可以被深链回来，虽然正常路径是 push）。 */
export function NativeBotCreateProgressRoute() {
  const params = useLocalSearchParams<{ botId?: string }>();
  return (
    <NativeBotCreateProgressScreen botId={typeof params.botId === 'string' ? params.botId : ''} />
  );
}
