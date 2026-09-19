/**
 * 「机器」浮窗：bot 那台容器现在是什么样。
 *
 * ## 为什么是一张 sheet（浮窗）而不是一页
 *
 * 它是**看**的东西，不是"走进去"的地方：用户一边看对话，一边想知道机器还在不在跑、
 * 桌面上有什么。所以用 `present()` 开一张半屏 sheet（原生浮窗形态，侧滑可关），
 * 而不是 push 一页把人从对话里带走——上游自己在窄屏也是这么退的（它那条"agent 用 GUI 工具
 * 就自动开右侧桌面"在移动宽度被主动关掉，理由写在源码注释里：会把用户反复从对话里拽走）。
 *
 * ## 为什么没有"连接桌面"按钮
 *
 * 桌面端的实时画面是 **WebRTC**（H.264/VP8），而服务端**只发 host candidate、没有
 * STUN/TURN**，媒体走 UDP。本客户端没有接原生 WebRTC，所以现在给一个"连接"按钮只会得到
 * 一个必然失败的按钮。这一屏给的是：
 *
 * - 桌面的**状态**（开了吗 / 容器里装了吗 / 画面在推吗，三个是不同的问题）；
 * - 一条**真能看到屏幕**的路：agent 用 GUI 工具截的图会落在工作区的
 *   `.memoh/screenshots/`，用已有的文件视图就能看（那里有图片预览）。
 *
 * 实时桌面要不要做，是产品决策（要引原生 WebRTC + 部署方得让 UDP 直连），写在
 * `docs/2026-09-15-desktop-and-chat-parity.md` 里。
 */
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ContainerMetrics, ContainerStatus, DisplayCapability } from '../api/types.ts';
import {
  desktopVerdict,
  machineRows,
  metricsRows,
  SCREENSHOT_DIRECTORY,
  type Row,
} from '../features/machine/panel.ts';
import { useSession } from '../features/session/store.tsx';
import { definePage, usePageRuntime } from '../lib/presentation/page.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { GROUP_INSET, radius, spacing, typography } from '../lib/theme/tokens.ts';
import { usePalette } from '../lib/theme/context.tsx';

export interface MachinePanelParams {
  botId: string;
}

type Verdict = 'available' | 'idle' | 'not-enabled' | 'not-installed' | 'unknown';

const VERDICT_KEY: Record<Verdict, string> = {
  available: 'machine.desktop.available',
  idle: 'machine.desktop.idle',
  'not-enabled': 'machine.desktop.notEnabled',
  'not-installed': 'machine.desktop.notInstalled',
  unknown: 'machine.desktop.unknown',
};

const VERDICT_TINT: Record<Verdict, 'success' | 'warning' | 'tertiaryLabel'> = {
  available: 'success',
  idle: 'tertiaryLabel',
  'not-enabled': 'tertiaryLabel',
  'not-installed': 'warning',
  unknown: 'tertiaryLabel',
};

function MachinePanelView() {
  const palette = usePalette();
  const t = useT();
  const router = useRouter();
  const { state } = useSession();
  const runtime = usePageRuntime<MachinePanelParams>();
  const botId = runtime.params.botId;

  const [container, setContainer] = useState<ContainerStatus | null>(null);
  const [metrics, setMetrics] = useState<ContainerMetrics | null>(null);
  const [display, setDisplay] = useState<DisplayCapability | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const client = state.client;
    if (client === null || botId === '') return;
    let cancelled = false;
    void (async () => {
      // 三个只读端点并行拿：它们互不依赖，串行只会让浮窗慢三倍。
      const results = await Promise.allSettled([
        client.getContainer(botId),
        client.getContainerMetrics(botId),
        client.getDisplay(botId),
      ]);
      if (cancelled) return;
      if (results[0].status === 'fulfilled') setContainer(results[0].value);
      if (results[1].status === 'fulfilled') setMetrics(results[1].value);
      if (results[2].status === 'fulfilled') setDisplay(results[2].value);
      // **只有三个都失败**才算这一屏失败：容器读到了、用量读不到，仍然是有用的信息。
      if (results.every((result) => result.status === 'rejected')) setFailed(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [botId, state.client]);

  const verdict = useMemo(() => desktopVerdict(display), [display]);
  const machine = useMemo(() => machineRows(container), [container]);
  const usage = useMemo(() => metricsRows(metrics), [metrics]);
  const loading = container === null && metrics === null && display === null && !failed;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      contentContainerStyle={{ paddingTop: spacing.md, paddingBottom: spacing.xl }}
    >
      <Text
        style={[
          typography.title2,
          { color: palette.label, paddingHorizontal: GROUP_INSET, marginBottom: spacing.md },
        ]}
      >
        {t('machine.title')}
      </Text>

      {loading ? (
        <View style={{ padding: spacing.xl, alignItems: 'center' }}>
          <ActivityIndicator color={palette.secondaryLabel} />
        </View>
      ) : null}

      {failed ? (
        <Text
          style={[
            typography.footnote,
            {
              color: palette.destructive,
              paddingHorizontal: GROUP_INSET,
              marginBottom: spacing.md,
            },
          ]}
        >
          {t('machine.failed')}
        </Text>
      ) : null}

      {machine.length === 0 ? null : (
        <Group header={t('machine.group.machine')}>
          {machine.map((row, index) => (
            <InfoRow
              key={row.label}
              row={row}
              last={index === machine.length - 1}
              testID={`machine-${row.label}`}
            />
          ))}
        </Group>
      )}

      {display === null ? null : (
        <Group header={t('machine.group.desktop')} footer={t('machine.desktop.footer')}>
          <View
            testID="machine-desktop-verdict"
            style={{
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.md,
              gap: 4,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: palette[VERDICT_TINT[verdict.verdict]],
                }}
              />
              <Text style={[typography.body, { color: palette.label }]}>
                {t(VERDICT_KEY[verdict.verdict])}
              </Text>
            </View>
            {/*
              这里**不显示**服务端的 `unavailable_reason`，也不显示 `transport`：
              前者是没有类型化 code 的英文原文（R45），后者是 `webrtc` 这种协议名，
              两者对用户都不是信息。四种处境各有自己的结论句（见 `desktopVerdict`）。
            */}
          </View>

          {/*
            能看到屏幕的**那条路**：agent 截图会落进工作区，用文件视图看（那里有图片预览）。
            它不是"实时画面"，所以文案说清是"截图"，不说"桌面"。
          */}
          <Pressable
            testID="machine-open-screenshots"
            accessibilityRole="button"
            onPress={() => router.push(`/files/${SCREENSHOT_DIRECTORY}`)}
            style={({ pressed }) => ({
              minHeight: 44,
              justifyContent: 'center',
              paddingHorizontal: spacing.lg,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: palette.separator,
              backgroundColor: pressed ? palette.field : 'transparent',
            })}
          >
            <Text style={[typography.body, { color: palette.accent }]}>
              {t('machine.openScreenshots')}
            </Text>
          </Pressable>
        </Group>
      )}

      {usage.length === 0 ? null : (
        <Group header={t('machine.group.usage')}>
          {usage.map((row, index) => (
            <InfoRow key={row.label} row={row} last={index === usage.length - 1} />
          ))}
        </Group>
      )}

      {metrics !== null && metrics.supported === false ? (
        <Text
          style={[
            typography.footnote,
            { color: palette.secondaryLabel, paddingHorizontal: GROUP_INSET },
          ]}
        >
          {t('machine.usage.unsupported')}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function InfoRow({ row, last, testID }: { row: Row; last: boolean; testID?: string }) {
  const palette = usePalette();
  const t = useT();
  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: 44,
        paddingHorizontal: spacing.lg,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: palette.separator,
      }}
    >
      <Text style={[typography.body, { color: palette.label, flex: 1 }]} numberOfLines={1}>
        {t(row.label)}
      </Text>
      <Text style={[typography.body, { color: palette.secondaryLabel }]} numberOfLines={1}>
        {/* 行值有两种：我们自己的文案 key（要查表），和服务端给的原文（原样显示）。 */}
        {row.valueKind === 'key' ? t(row.value) : row.value}
      </Text>
    </View>
  );
}

function Group({
  header,
  footer,
  children,
}: {
  header: string;
  footer?: string;
  children: React.ReactNode;
}) {
  const palette = usePalette();
  return (
    <View style={{ marginBottom: spacing.lg }}>
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
        {header}
      </Text>
      <View
        style={{
          backgroundColor: palette.card,
          marginHorizontal: GROUP_INSET,
          borderRadius: radius.md,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
      {footer === undefined ? null : (
        <Text
          style={[
            typography.footnote,
            { color: palette.tertiaryLabel, paddingHorizontal: GROUP_INSET, marginTop: spacing.xs },
          ]}
        >
          {footer}
        </Text>
      )}
    </View>
  );
}

export const MachinePanelSheet = definePage<MachinePanelParams>({
  id: 'machinePanel',
  title: 'Machine',
  Component: MachinePanelView,
  parseRouteParams: (params) => ({ botId: String(params.botId ?? '') }),
  presentation: {
    dismissible: true,
    detents: [0.5, 1],
    initialDetent: 0,
    grabber: true,
    headerShown: false,
  },
});
