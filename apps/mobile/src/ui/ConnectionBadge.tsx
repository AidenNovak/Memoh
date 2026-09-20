/**
 * 连接状态指示。
 *
 * ## 只在**不正常**的时候出现
 *
 * 移动网络下"连不上"是常态而不是异常，所以它必须是**可操作的**而不是一个红点：
 * 断了就说断了，重连中就说重连中。
 *
 * 但**连上了就不说话**。之前它在正常连接时也会显示一个绿点加 "Online"，
 * 而顶部的 bot 切换器上已经有一个绿点（那是 bot 的 `is_active`）——两个绿点、
 * 两种含义并排，视觉评审一眼就问"哪个才是在线"。
 *
 * iOS 的惯例是：正常状态不需要被宣布（系统不会告诉你"电量正常"）。
 * 所以这里只在连接有问题时渲染。
 *
 * ## 三件弱网下必须说清的事
 *
 * 1. **"连接中"和"正在重连"不是一件事**：前者是第一次连、用户在等它开始；后者是
 *    已经断过、用户在等它回来。两句话都在，用户才知道自己该不该等。
 * 2. **"登录已过期"也不能说成"正在重连"**：那条路等到天亮也不会好，只有重新登录
 *    能解决。把它混进重连里，用户就只能干等（这是 `ConnectionState` 单开一档的原因）。
 * 3. **还有几条没发出去**要说出来：掉线期间点发送，界面（乐观回显 + 清空输入框）
 *    看起来和成功一模一样，但其实那一帧还在 outbox 里等网络。不说的话，"我发了"
 *    就成了一句谎话。
 *
 * 整条是可点的（44pt）：弱网下"现在再试一次"是用户最想做的事，让他自己拍一下，
 * 比让他猜还要等多久好。
 *
 * 不做的事：不自己偷偷重试后假装没事。用户需要知道屏幕上看到的是不是最新的。
 *
 * ## 播报：只播终态
 *
 * "重连中 ↔ 已连上"在弱网下每几秒翻一次，每次播报会把读屏用户淹掉——那是噪音不是信息。
 * 但"登录已过期"是一条**走到头了**的结论（只有重新登录能解决），不说的话用户只能干等。
 * 所以只有它主动念一次；其余靠这个可点的状态条自己表达（`lib/accessibility.ts`）。
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useT } from '../lib/i18n/useT.ts';
import { useAnnounceOnAppear } from '../lib/accessibility.ts';
import { PRESS_OPACITY } from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';
import { useSession } from '../features/session/store.tsx';
import type { ConnectionState } from '../api/realtime.ts';

/**
 状态 → 文案 key。
 
 封闭集合用字典而不是嵌套三元（AGENTS.md 的规矩，这里也真的更清楚）：
 `connection` 以后再加一档（比如服务端主动踢人），只改这一张表。
 */
const LABELS: Record<ConnectionState, string> = {
  idle: 'chat.connecting',
  connecting: 'chat.connecting',
  reconnecting: 'chat.reconnecting',
  closed: 'chat.disconnected',
  unauthorized: 'chat.expired',
  // open 不会走到这里：连着的时候整块不渲染。
  open: 'chat.disconnected',
};

export function ConnectionBadge() {
  const palette = usePalette();
  const { typography } = useTheme();
  const t = useT();
  const { state, currentBot, realtimeEnabled, retryConnection } = useSession();
  const { connection, pendingSends } = state;

  /**
   ⚠️ **所有 hook 必须在任何提前返回之前调用**（React 的硬规则）。

   这里踩过一次：把 `useAnnounceOnAppear` 写在下面那两个提前返回之后，第一次渲染
   （`realtimeEnabled === true`、连接 `open`、无待发）走的是 `return null` 那条路，
   而线上错误时走的是完整那条路——两次渲染的 hook 数量不一样，直接
   `Rendered more hooks than during the previous render`（红屏）。
   dev client 上表现为"首页整屏是渲染错误"，而 `pnpm typecheck` 是看不出来的。
   */
  const announceLabel =
    realtimeEnabled && connection === 'unauthorized' ? t(LABELS.unauthorized) : null;
  useAnnounceOnAppear(announceLabel);

  if (currentBot === null) return null;

  if (!realtimeEnabled) {
    return (
      <View testID="connection-read-only" style={styles.row}>
        <View style={[styles.dot, { backgroundColor: palette.tertiaryLabel }]} />
        <Text style={[typography.caption, { color: palette.tertiaryLabel }]}>
          {t('chat.readOnly.short')}
        </Text>
      </View>
    );
  }

  /**
   连着的时候不渲染——正常状态不需要占位置。

   一个例外：`pendingSends > 0`。有帧还没送出去就必须说（那说明刚才是断的），
   哪怕此刻"看起来连着"。
   */
  if (connection === 'open' && pendingSends === 0) return null;

  const label = t(LABELS[connection]);
  const pendingLabel = pendingSends > 0 ? t('chat.pending', { count: pendingSends }) : '';
  /**
   ⚠️ 无障碍标签必须**带上**"还没发出去的那几条"。

   这个 Pressable 是一个整体（`accessibilityRole="button"`），里面的两行文字对无障碍
   系统来说是**看不见**的——读屏用户只会听到按钮自己的标签。所以掉线期间点了发送的人
   如果只听标签，就会以为消息发出去了。同一条信息对两种读法都得成立。

   分隔符用 `·` 而不是半角句点：中文标签（"已断开"）后面跟 `. ` 是在中文句子里插英文
   标点，而且读屏会把句点念成停顿、两句话的边界听不出来。`ui/PendingApprovals.tsx`
   与 `screens/ChatScreen.tsx`（run 失败那一块）用的是同一个分隔符。
   */
  const accessibilityLabel = pendingLabel === '' ? label : `${label} · ${pendingLabel}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={t('chat.connection.retryHint')}
      onPress={retryConnection}
      style={({ pressed }) => [styles.row, { opacity: pressed ? PRESS_OPACITY.control : 1 }]}
    >
      <View style={[styles.dot, { backgroundColor: palette.warning }]} />
      <View style={styles.stack}>
        {/* 一行一条：横条里高度只够两行，长句子折三行会顶掉内容（实测就是那样）。 */}
        <Text numberOfLines={1} style={[typography.caption, { color: palette.secondaryLabel }]}>
          {label}
        </Text>
        {pendingLabel === '' ? null : (
          <Text numberOfLines={1} style={[typography.caption, { color: palette.warning }]}>
            {pendingLabel}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    // 这一条渲染在 agent 行里（会话页/设置页），而那一行右边还有新建入口：
    // 掉线时这条状态文字会很长（"已断开 · 还有 2 条没发出去"），最大辅助字号下
    // 不让它收缩就会把 `＋` 挤出屏幕。文字本身在 `stack` 里已经有 `flexShrink`，
    // 这里补上容器自己的（否则容器按内容撑满，压缩传不下去）。
    flexShrink: 1,
  },
  stack: {
    flexShrink: 1,
    minWidth: 0,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
