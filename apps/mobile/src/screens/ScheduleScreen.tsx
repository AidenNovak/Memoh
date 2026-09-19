/**
 * 定时视图（「会话」tab 的三视图之一）。
 *
 * ## 这一屏要回答的三个问题（§7.6）
 *
 * "它下次什么时候跑"、"上一次跑成没成"、"现在是开的还是关的"。所以每行是
 * **名字 + 副标题（下次 / 最近一次）+ 就地开关**，而不是一张只读卡片：
 * 启停是这个列表最高频的动作，它不该需要点进去。
 *
 * ## 不画大标题
 *
 * 大标题由会话页外壳提供（当前视图名）。这一屏只管内容与底部那两条：计数脚注 + 新建。
 */
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, View } from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '../lib/i18n/useT.ts';
import {
  GROUP_INSET,
  TAB_BAR_CLEARANCE,
  radius,
  spacing,
  typography,
} from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';
import { useSession } from '../features/session/store.tsx';
import { Group, Row } from '../ui/GroupedList.tsx';
import { lastRunLabelKey, nextRunLabel, safeTimezone } from '../features/schedule/describe.ts';
import { timezoneLine } from '../features/bots/timezones.ts';
import { scheduleSubtitleParts } from '../features/schedule/subtitle.ts';
import { useSchedules } from '../features/schedule/useSchedule.ts';
import { canRetry, reasonKeyOf } from '../features/errors/present.ts';
import { ErrorNotice } from '../ui/ErrorNotice.tsx';

export function ScheduleScreen() {
  const palette = usePalette();
  const { typography: type } = useTheme();
  const t = useT();
  const router = useRouter();
  const { state, currentBot } = useSession();
  const insets = useSafeAreaInsets();

  const botId = currentBot?.id ?? null;
  // 时区按任务所属 bot 算：服务端按那个时区执行，界面按本地时区显示就会差几小时。
  const timezone = safeTimezone(currentBot?.timezone);
  /** 底部那一行"按哪个时区算"（继承时要说明是部署默认，见 `features/bots/timezones.ts`）。 */
  const line = timezoneLine(currentBot?.timezone);
  const { data, loading, error, errorKind, lastBySchedule, reload, toggleEnabled } = useSchedules(
    state.client,
    botId,
  );

  /**
   回到这一屏就重拉一次。

   为什么要有这一步：编辑页保存成功后是 `router.back()` 回来的，而这一屏**不会**因此重新
   挂载（它一直在 tab 栈里）。少了这次重拉，用户新建完一条任务、回到列表——**列表里没有它**。
   那是"我明明保存了"的典型现场（本轮验收就是在这条路上抓到的：固定服务端收到了 POST、
   列表里却没有那一条）。
   */
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const rows = useMemo(() => {
    const now = new Date();
    return (data ?? []).map((schedule) => {
      const parts = scheduleSubtitleParts(schedule, lastBySchedule[schedule.id], timezone, now);
      const next = nextRunLabel(parts.nextAt, now, timezone);
      const segments: string[] = [];
      if (!schedule.enabled) {
        segments.push(t('schedule.disabled'));
      } else if (next.kind === 'unknown') {
        // 算不出来就说算不出来——给一个猜的时间比不给更糟。
        segments.push(t('schedule.next.unknown'));
      } else {
        segments.push(t('schedule.next.at', { day: dayLabel(next, t), time: next.time }));
      }
      const lastKey = lastRunLabelKey(parts.last);
      if (lastKey !== null) segments.push(t(lastKey));
      return { schedule, subtitle: segments.join(' · ') };
    });
  }, [data, lastBySchedule, t, timezone]);

  const enabledCount = (data ?? []).filter((item) => item.enabled).length;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      // 底部要让开**悬浮的 tab 栏**：iOS 26 的 tab 栏浮在内容之上，内容自己不留
      // 这一段就会被压住（最大辅助字号下实测到计数脚注被遮）。
      contentContainerStyle={{
        // **内缩写在容器上，不写在每个子节点上**。
        //
        // 以前只有子节点各自写（时区行、脚注、新建按钮），直接子节点里的 `<Group>`
        // 没写——于是最大字号下任务卡片通栏到屏幕边缘（左 0.0pt，圆角被屏幕切掉），
        // 而同一屏别的元素都是 16pt。分组卡片的内缩是这一屏**唯一的分组语言**，
        // 漏一处就等于那一处不再是"一张卡片"。写在容器上就不会再漏：新加的子节点
        // 自动对齐（设置页、文件页就是这么写的）。
        paddingHorizontal: GROUP_INSET,
        paddingTop: spacing.md,
        paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
      }}
    >
      {error === null ? null : (
        /* 标题分两种：**拉列表失败**和**拨开关失败**不是一件事。以前两者共用
           "定时任务没拉到"，于是一次开关没改成功会让用户以为整个列表都坏了。 */
        <View style={{ marginBottom: spacing.lg }}>
          <ErrorNotice
            testID="schedule-error"
            title={t(errorKind === 'toggle' ? 'schedule.toggle.failed' : 'schedule.error.title')}
            reason={t(reasonKeyOf(error))}
            action={
              /* 只有"拉列表"才可能靠重试解决；开关失败用户手上就有那个开关，
                 再挂一个重试只是把同一个动作说两遍。判据仍是错误性质（`canRetry`）。 */
              errorKind === 'list' && canRetry(error)
                ? { label: t('schedule.retry'), onPress: () => void reload() }
                : undefined
            }
          />
        </View>
      )}

      {loading && data === null ? (
        <View style={{ paddingTop: spacing.xxl, alignItems: 'center' }}>
          <ActivityIndicator color={palette.secondaryLabel} />
        </View>
      ) : null}

      {(data ?? []).length === 0 && !loading && error === null ? (
        <View style={{ paddingTop: spacing.xxl }}>
          <Text style={[type.headline, { color: palette.label, marginBottom: spacing.xs }]}>
            {t('schedule.empty.title')}
          </Text>
          <Text style={[type.subhead, { color: palette.secondaryLabel }]}>
            {t('schedule.empty.body')}
          </Text>
        </View>
      ) : null}

      {(data ?? []).length > 0 ? (
        <Group header={t('schedule.group')}>
          {rows.map(({ schedule, subtitle }, index) => (
            <Row
              key={schedule.id}
              testID={`schedule-row-${schedule.id}`}
              title={schedule.name === '' ? t('schedule.untitled') : schedule.name}
              subtitle={subtitle}
              last={index === rows.length - 1}
              onPress={() => router.push(`/schedule/edit?scheduleId=${schedule.id}`)}
              accessory={
                <Switch
                  testID={`schedule-switch-${schedule.id}`}
                  value={schedule.enabled}
                  onValueChange={(next) => void toggleEnabled(schedule, next)}
                />
              }
            />
          ))}
        </Group>
      ) : null}

      {/*
        **按哪个时区算** —— 这一行是裁决里点名要的（"定时相关界面必须有一行显示生效时区"）。
        上面每一行的"下次 09:00"都只在这个时区里成立；不写出来，用户没法判断它跟自己的
        09:00 是不是同一个。服务端读不到/没设时说的是**部署默认**（本部署 UTC），
        不是"本机时区"——后者会差几小时而且看不出来（见 `features/schedule/describe.ts`）。
      */}
      {currentBot === null ? null : (
        <Text
          testID="schedule-timezone"
          style={[
            typography.footnote,
            {
              color: palette.secondaryLabel,
              marginBottom: spacing.md,
            },
          ]}
        >
          {t(line.key, line.values)}
        </Text>
      )}

      {(data ?? []).length > 0 ? (
        <Text
          style={[
            typography.footnote,
            {
              color: palette.secondaryLabel,
              marginBottom: spacing.md,
            },
          ]}
        >
          {t('schedule.footer', { count: rows.length, enabled: enabledCount })}
        </Text>
      ) : null}

      <Pressable
        testID="schedule-new"
        accessibilityRole="button"
        onPress={() => router.push('/schedule/edit')}
        style={({ pressed }) => ({
          minHeight: 48,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? palette.field : palette.card,
          borderRadius: radius.md,
        })}
      >
        <Text style={[type.body, { color: palette.accent }]}>{t('schedule.new')}</Text>
      </Pressable>
    </ScrollView>
  );
}

/** 日期词：封闭集合用字典映射（AGENTS.md 禁止链式三元）。 */
const DAY_KEY: Record<'today' | 'tomorrow' | 'dayAfter', string> = {
  today: 'schedule.day.today',
  tomorrow: 'schedule.day.tomorrow',
  dayAfter: 'schedule.day.dayAfter',
};

function dayLabel(
  label: {
    kind: 'at';
    day: 'today' | 'tomorrow' | 'dayAfter' | 'date';
    time: string;
    date: string;
  },
  t: (key: string) => string,
): string {
  if (label.day === 'date') return label.date;
  return t(DAY_KEY[label.day]);
}
