/**
 * 应用主界面：会话列表（首页）。
 *
 * 设计决策（来自 `docs/research/memoh-design-baseline.md`）：
 *
 * 首页是**"最近的会话"**，不是 Agent 卡片墙。理由是 Web 端的落地页就是 Chat，
 * 打开 App 直接看到"我上次在跟谁说话、它现在在干什么"符合既有心智。
 *
 * 顶部放**跨 bot 的待审批聚合**——这是移动端最大的差异化价值：agent 7x24 在线，
 * 人在路上点一下"允许"就能让它继续，这是桌面替代不了的场景。
 */
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '../lib/i18n/useT.ts';
import { GROUP_INSET, PRESS_OPACITY, radius, TAB_BAR_CLEARANCE } from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';
import { useSession, type SessionSummary } from '../features/session/store.tsx';
import { forkTarget, forkTitle, isForkable, sessionActions } from '../features/session/actions.ts';
import { present } from '../lib/presentation/index.ts';
import { RenameSessionSheet } from '../ui/RenameSessionPage.tsx';
import { canRetry, presentError, reasonKeyOf } from '../features/errors/present.ts';
import { syncNotificationBadge } from '../features/notifications/bridge.ts';
import { sessionDisplayTitle } from '../features/session/displayTitle.ts';
import { sessionsFooter } from '../features/session/paging.ts';
import { sessionSourceLabel } from '../features/session/sourceLabel.ts';
import {
  useSessionActivity,
  type SessionActivity,
} from '../features/activity/useSessionActivity.ts';
import { BotSwitcher } from '../ui/BotSwitcher.tsx';
import { ConnectionBadge } from '../ui/ConnectionBadge.tsx';
import { ErrorNotice } from '../ui/ErrorNotice.tsx';
import { PendingApprovals } from '../ui/PendingApprovals.tsx';

/**
 * `embedded`：这一屏被「会话」tab 的外壳（`SessionsHubScreen`）嵌进去时用。
 *
 * 外壳已经有**大标题（当前视图名）+ agent 行 + 新建按钮**，所以嵌入模式只保留"这一屏
 * 自己的内容"——待审批聚合、运行中聚合、会话列表。写两遍标题不只是重复，它一定会
 * 有一天不一致（标题改成"文件"而里面还写着"会话"）。
 */
export function HomeScreen({ embedded = false }: { embedded?: boolean } = {}) {
  const palette = usePalette();
  const { spacing, typography, scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const t = useT();
  const router = useRouter();
  const { state, refreshBots, refreshSessions, loadMoreSessions, openSession, selectBot } =
    useSession();
  /**
   * agent 7x24 在跑，所以首页要能看到"谁在等我"——这是移动端最该做的事。
   *
   * 已知取舍：这会为每个 bot 多开一条 WebSocket（当前会话那条由 store 持有）。对
   * 自托管用户的 1–3 个 bot 来说代价可忽略，换来的是"首页直接看到待审批"。要消除
   * 这条冗余，得把 store 改成"一条连接订阅多个会话"并跨 bot 共享状态，那是更大的
   * 重构，等有明确性能压力时再做。
   */
  const { pending, active } = useSessionActivity(state.client, state.bots);

  /**
   * 徽标 = **待审批数**，与这一屏的聚合**同源**。
   *
   * 为什么落在这里而不是让 App 外壳再订阅一次实时通道：徽标与首页数字不一致比不显示
   * 更糟（HIG *Badging* + `policy.badgeCountFor`）。外壳再订阅就是第二条连接，迟早会
   * 跟这一份错开；所以让**已经算好的**数字往徽标走。
   *
   * 归零会连通知中心里本 App 的通知一起清掉——这正是"处理完了"该有的样子。
   */
  useEffect(() => {
    void syncNotificationBadge(pending.length);
  }, [pending.length]);

  const { sessions, sessionsLoading, sessionsError, botsError } = state;
  // 两条路都会让「这一屏是空的」变成假话：会话列表自己拉失败，或者连 bot 都拉不到。
  const loadError = sessionsError ?? botsError;
  /**
   连不上服务端时**第一个失败的其实是 /bots**，而"没拉到 bot"这件事对用户来说和我自己的
   会话列表拉不到是同一件事（都是"这台服务器现在读不到"）。所以文案用会话列表那一句，
   但**动作跟着错误的性质走**：传输层失败给重试，凭据失效给重新登录。
   */
  const loadErrorRetry = loadError === null ? false : canRetry(loadError);
  const loadErrorReason = loadError === null ? '' : t(reasonKeyOf(loadError));

  const onOpen = useCallback(
    (sessionId: string) => {
      openSession(sessionId);
      router.push(`/chat/${sessionId}`);
    },
    [openSession, router],
  );

  /**
   * 点一条活动项。
   *
   * 待处理项可能属于**另一个 bot**——用户在看 A 的时候 B 在等他批准。所以要先切 bot
   * （否则 chat 页连到错的实时通道上，进去是空的），等会话列表切过来之后再跳转。
   * 用一个 pendingJump 记住目标，会话列表就绪后执行。
   */
  const [pendingJump, setPendingJump] = useState<string | null>(null);

  const onOpenActivity = useCallback(
    (entry: SessionActivity) => {
      if (entry.botId !== state.currentBotId) {
        setPendingJump(entry.sessionId);
        selectBot(entry.botId);
        return;
      }
      onOpen(entry.sessionId);
    },
    [onOpen, selectBot, state.currentBotId],
  );

  useEffect(() => {
    if (pendingJump === null) return;
    const stillThere = state.sessions.some((session) => session.id === pendingJump);
    if (!stillThere && state.sessionsLoading) return; // 还在加载，再等等
    const target = pendingJump;
    setPendingJump(null);
    onOpen(target);
  }, [pendingJump, state.sessions, state.sessionsLoading, onOpen]);

  const onNew = useCallback(() => {
    router.push('/chat/new');
  }, [router]);

  /**
   会话行上的动作（长按 → 原生清单）。

   清单本身是纯逻辑（`features/session/actions.ts`）：**哪些动作存在**由会话类型决定
   （分叉只有 `chat` 会话能做——实测非 chat 回 409），画法在这里。

   为什么是长按而不是行内按钮：行内放一排按钮会把每一行撑高，而这一屏读的就是
   "最近有哪些会话"；iOS 的既有位置是长按（邮件/信息/文件都是）。与文件列表同一个裁决。
   */
  const renameSession = useCallback((session: SessionSummary) => {
    void (async () => {
      const outcome = await present(RenameSessionSheet, {
        sessionId: session.id,
        title: session.title,
      });
      if (outcome.status !== 'completed') return;
      // 列表那份标题是本地缓存的；重命名页自己重拉过一次（`refreshSessions`），
      // 所以这里不用再拉——但拉一次是幂等的，不做多余的请求。
    })();
  }, []);

  const forkSession = useCallback(
    (session: SessionSummary) => {
      const client = state.client;
      const botId = state.currentBotId;
      if (client === null || botId === null) return;
      void (async () => {
        try {
          // 分叉的锚点 = **最近一条助手轮次**（服务端按 turn_id 找那一轮）。
          // 取不到就直说，而不是发一个必然 400 的请求。
          const page = await client.listMessages(botId, session.id, { limit: 50 });
          const turnId = forkTarget(page.items ?? []);
          if (turnId === null) {
            Alert.alert(t('session.fork.title'), t('session.fork.noTurn'));
            return;
          }
          const forked = await client.forkSession(botId, session.id, {
            turn_id: turnId,
            // 服务端默认叫 `<源标题> fork`（英文）；中文界面自己拼，源标题为空就交给它。
            title: forkTitle(session.title, t('session.fork.title')) ?? undefined,
          });
          await refreshSessions();
          // 分叉的意义就是"从这里接着走"——建好就进去，否则用户还得在列表里找它。
          if (typeof forked.id === 'string' && forked.id !== '') onOpen(forked.id);
        } catch (caught) {
          Alert.alert(t('session.fork.failed'), t(reasonKeyOf(presentError(caught))));
        }
      })();
    },
    [onOpen, refreshSessions, state.client, state.currentBotId, t],
  );

  const showSessionActions = useCallback(
    (session: SessionSummary) => {
      const actions = sessionActions({ type: session.type });
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: sessionDisplayTitle(session, t),
          message: isForkable(session.type) ? undefined : t('session.action.fork.unavailable'),
          options: [...actions.map((action) => t(action.labelKey)), t('common.cancel')],
          cancelButtonIndex: actions.length,
          userInterfaceStyle: scheme,
        },
        (index) => {
          const action = actions[index];
          if (action === undefined) return;
          if (action.id === 'rename') renameSession(session);
          if (action.id === 'fork') forkSession(session);
        },
      );
    },
    [forkSession, renameSession, scheme, t],
  );

  /**
   * 重试必须先重拉 bot：离线时最先失败的是 /bots，没有 botId 时
   * `refreshSessions` 会直接早退。
   */
  const onRetry = useCallback(async () => {
    await refreshBots();
    await refreshSessions();
  }, [refreshBots, refreshSessions]);

  const header = useMemo(
    () => (
      <View style={{ paddingTop: spacing.sm }}>
        {embedded ? null : (
          <>
            <BotSwitcher />
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: spacing.lg,
                paddingBottom: spacing.md,
                gap: spacing.sm,
              }}
            >
              <Text style={[typography.title2, { color: palette.label }]}>{t('home.title')}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <ConnectionBadge />
                {/* 新建会话放在标题行右侧，而不是右下角的浮动按钮。
                    FAB 是 Material 的形态，iOS 的"新建"在导航栏上——视觉评审
                    一眼就把它点出来了。没有原生导航栏时，这个位置最接近那个心智。 */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('home.newSession')}
                  onPress={onNew}
                  hitSlop={8}
                  style={({ pressed }) => ({
                    width: 32,
                    height: 32,
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: pressed ? PRESS_OPACITY.control : 1,
                  })}
                >
                  <Text style={{ color: palette.accent, fontSize: 24, lineHeight: 28 }}>＋</Text>
                </Pressable>
              </View>
            </View>
          </>
        )}
        {/* 有数据、但这次没刷新成功：说一句"可能不是最新的"，不打断列表。
            没数据的那条路走 empty 里的错误态。

            重试**只在真的可能有用时**才挂上去（`canRetry`）：凭据失效时挂一个"重试"
            等于让用户点一百次同一件不可能成的事。那句话本身照说，只是没有可点的部分。 */}
        {loadError !== null && sessions.length > 0 ? (
          <Pressable
            testID="home-stale-banner"
            accessibilityRole={loadErrorRetry ? 'button' : undefined}
            accessibilityHint={loadErrorRetry ? t('common.retry') : undefined}
            onPress={loadErrorRetry ? () => void onRetry() : undefined}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: spacing.sm,
              marginHorizontal: spacing.lg,
              marginBottom: spacing.sm,
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.sm,
              borderRadius: radius.md,
              backgroundColor: palette.card,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={[typography.footnote, { color: palette.secondaryLabel }]}>
                {t('home.stale')}
              </Text>
              <Text style={[typography.caption, { color: palette.tertiaryLabel }]}>
                {loadErrorReason}
              </Text>
            </View>
            {loadErrorRetry ? (
              <Text style={[typography.footnote, { color: palette.accent }]}>
                {t('common.retry')}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
        <PendingApprovals entries={pending} onOpen={onOpenActivity} />
        <ActiveRuns entries={active} />
      </View>
    ),
    [
      active,
      embedded,
      onNew,
      onOpenActivity,
      onRetry,
      palette.accent,
      palette.card,
      sessions.length,
      loadError,
      loadErrorReason,
      loadErrorRetry,
      palette.label,
      palette.secondaryLabel,
      palette.tertiaryLabel,
      pending,
      spacing.md,
      spacing.lg,
      spacing.sm,
      t,
      typography.caption,
      typography.footnote,
      typography.title2,
    ],
  );

  /**
   * 空态 vs 错误态。
   *
   * 这两个必须分开：拉取失败而列表恰好是空的时候，渲染"还没有会话"是一句假话——
   * 用户会以为自己的会话被删了，然后去别处找。所以只要 `sessionsError` 在，
   * 这一屏就说"没拉到"。
   *
   * 动作**跟着错误的性质走**（`features/errors/present.ts`）：只有传输层那几种
   * （没网/超时/限流/5xx）才配"重试"；凭据失效、权限不足、协议形状不对都不给——
   * 重试到天亮也不会好，给了就是让用户去做一件我们已知不会成的事。
   *
   * 凭据失效在这里**不需要**额外挂一个"重新登录"：那句话本身已经说了（`error.unauthorized`），
   * 而且客户端 401 的统一处理会直接把人送回登录页——再放一个按钮是把同一件事说两遍。
   */

  const empty = (
    <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.xxl, alignItems: 'center' }}>
      {loadError === null ? (
        <>
          <Text style={[typography.headline, { color: palette.label, marginBottom: spacing.xs }]}>
            {t('home.empty.title')}
          </Text>
          <Text
            style={[typography.subhead, { color: palette.secondaryLabel, textAlign: 'center' }]}
          >
            {t('home.empty.body')}
          </Text>
        </>
      ) : (
        <>
          <View style={{ marginTop: spacing.lg, width: '100%' }}>
            <ErrorNotice
              testID="home-error"
              title={t('home.error.title')}
              reason={loadErrorReason}
              action={
                loadError === null || !loadErrorRetry
                  ? undefined
                  : {
                      label: t('common.retry'),
                      // 整块可点，不只是那三个字："Retry" 这种小目标在空态里居中悬浮，
                      // 手指与自动化都容易点偏（2026-09-15 实测按 testID 与按坐标都没点动）。
                      onPress: () => void onRetry(),
                    }
              }
            />
          </View>
        </>
      )}
    </View>
  );

  /**
   列表尾部：**还有更早的会话就说出来**（评审 A2 的原话是"界面上一个字都不说"）。

   以前这一屏只拉一页 `limit: 50` 就再也不拉，超过 50 个会话的账号会以为旧会话被删了。
   现在这条尾巴有两个作用：

   - **如实说明**当前只显示最近 N 个（`home.sessions.window`）——数字是**已加载**的条数，
     不是编的"50"；
   - 给一个能点的入口（滚到底也会自动加载，见 `onEndReached`）。失败时说一句，
     游标留着，用户可以再点。

   到底了（服务端没给 `next_cursor`）就什么都不显示——那时多一个字都是噪音。
  */
  const footerState = sessionsFooter({
    cursor: state.sessionsCursor,
    loading: state.sessionsMoreLoading,
    error: state.sessionsMoreError,
  });

  const sessionListFooter = (() => {
    if (footerState === 'none') return null;
    if (footerState === 'loading') {
      return (
        <View
          testID="home-sessions-more-loading"
          style={{ paddingVertical: spacing.md, alignItems: 'center' }}
        >
          <Text style={[typography.footnote, { color: palette.secondaryLabel }]}>
            {t('home.sessions.more.loading')}
          </Text>
        </View>
      );
    }
    const failed = footerState === 'error';
    return (
      <Pressable
        testID={failed ? 'home-sessions-more-failed' : 'home-sessions-more'}
        accessibilityRole="button"
        accessibilityLabel={failed ? t('home.sessions.more.failed') : t('home.sessions.more')}
        accessibilityHint={t('home.sessions.more.hint')}
        onPress={() => void loadMoreSessions()}
        style={{
          paddingVertical: spacing.md,
          alignItems: 'center',
          gap: 2,
        }}
      >
        <Text
          style={[typography.footnote, { color: failed ? palette.destructive : palette.accent }]}
        >
          {failed ? t('home.sessions.more.failed') : t('home.sessions.more')}
        </Text>
        <Text style={[typography.caption, { color: palette.tertiaryLabel }]}>
          {t('home.sessions.window', { count: sessions.length })}
        </Text>
      </Pressable>
    );
  })();

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: palette.groupedBackground,
        paddingTop: embedded ? 0 : insets.top,
      }}
    >
      <FlatList
        data={sessions}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={header}
        ListEmptyComponent={sessionsLoading ? null : empty}
        ListFooterComponent={sessionListFooter}
        // 滚到底就接着拉下一页（游标分页）。`loadMoreSessions` 自己挡重复触发，
        // 没有下一页时是空操作；尾部那一行是同一件事的可见入口。
        onEndReached={() => void loadMoreSessions()}
        onEndReachedThreshold={0.4}
        refreshControl={
          <RefreshControl
            refreshing={sessionsLoading}
            onRefresh={() => void onRetry()}
            tintColor={palette.secondaryLabel}
          />
        }
        contentContainerStyle={{
          // 让开悬浮 tab 栏（同 ScheduleScreen 的注释）。
          paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
          // 会话列表是一张 inset 分组卡片：左右留 16pt，行在卡片里。
          // 之前是通栏白底行贴在灰底上（Web 表格的形态），视觉评审把它列为
          // "不像原生 iOS"的头几条之一。
          paddingHorizontal: GROUP_INSET,
        }}
        // 卡片：整段会话在一个圆角容器里，圆角只在首尾行生效。
        style={{ flex: 1 }}
        renderItem={({ item, index }) => (
          <SessionRow
            session={item}
            first={index === 0}
            last={index === sessions.length - 1}
            onPress={() => onOpen(item.id)}
            // 长按 = 重命名 / 分叉（原生清单）。与文件列表同一个手势位置。
            onLongPress={() => showSessionActions(item)}
          />
        )}
      />
    </View>
  );
}

/** 正在跑的会话。比待审批弱一档——用户不需要动手，但知道"它在干活"是安心的。 */
function ActiveRuns({ entries }: { entries: SessionActivity[] }) {
  const { spacing, typography } = useTheme();
  const palette = usePalette();
  const t = useT();
  // 待审批的已经在上面单独显示了，这里不重复。
  const running = entries.filter((entry) => entry.status !== 'waiting_decision');
  if (running.length === 0) return null;

  return (
    <View style={{ paddingHorizontal: spacing.lg, marginBottom: spacing.sm }}>
      {running.map((entry) => (
        <View
          key={entry.sessionId}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 28 }}
        >
          <View
            style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: palette.success }}
          />
          <Text
            style={[typography.footnote, { color: palette.secondaryLabel, flex: 1 }]}
            numberOfLines={1}
          >
            {sessionDisplayTitle({ title: entry.sessionTitle }, t)} · {t('chat.thinking')}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * 会话行。
 *
 * 两行结构，照 iOS 邮件/信息的形态：
 *
 *   [标题 ................ 时间]   ← 第一行：主体 + 右对齐时间
 *   [来源 · 类型]                  ← 第二行：次要信息
 *
 * 时间右对齐在第一行，是因为扫列表时眼睛不该换行——之前时间挤在副标题下面，
 * 视觉评审直接指出"浪费高度、右侧全空"。
 *
 * 分隔线**左缩进对齐文字起点**（不是通栏）：通栏是 Web 表格的习惯。
 * 圆角只在卡片的首尾行生效。
 */
function SessionRow({
  session,
  first,
  last,
  onPress,
  onLongPress,
}: {
  session: SessionSummary;
  first: boolean;
  last: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const palette = usePalette();
  const { spacing, typography } = useTheme();
  const t = useT();

  // 卡片圆角只给首尾行：中间行不能圆，否则卡片中间会出现圆弧。
  const corners = {
    borderTopLeftRadius: first ? radius.md : 0,
    borderTopRightRadius: first ? radius.md : 0,
    borderBottomLeftRadius: last ? radius.md : 0,
    borderBottomRightRadius: last ? radius.md : 0,
  };

  return (
    <Pressable
      testID={`session-row-${session.id}`}
      accessibilityRole="button"
      // 长按是一个**看不见的手势**，读屏用户不会自己发现它——把"按住能做别的"写进提示。
      accessibilityHint={t('session.action.hint')}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row,
        corners,
        {
          backgroundColor: pressed ? palette.field : palette.card,
          paddingHorizontal: spacing.lg,
        },
      ]}
    >
      <View style={{ flex: 1, gap: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm }}>
          <Text style={[typography.body, { color: palette.label, flex: 1 }]} numberOfLines={1}>
            {sessionDisplayTitle(session, t)}
          </Text>
          <Text style={[typography.footnote, { color: palette.secondaryLabel }]}>
            {formatRelative(session.updatedAt)}
          </Text>
        </View>
        {/* 副标题没有内容就整行不渲染：渲染一个空 Text 会白占一行高度，
            而"空"是这台部署上的常态（服务端不返回 channel_type，只剩 type）。
            实测过它渲染成 " · chat" 的样子——一个空段加一个多余分隔符。 */}
        {sessionSourceLabel(session) !== '' ? (
          <Text style={[typography.footnote, { color: palette.secondaryLabel }]} numberOfLines={1}>
            {sessionSourceLabel(session)}
          </Text>
        ) : null}
      </View>
      {!last ? (
        <View
          style={{
            position: 'absolute',
            left: spacing.lg,
            right: 0,
            bottom: 0,
            height: StyleSheet.hairlineWidth,
            backgroundColor: palette.separator,
          }}
        />
      ) : null}
    </Pressable>
  );
}

/** 相对时间的粗粒度展示。精确到分钟没必要——列表只用来扫一眼。 */
function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

const styles = StyleSheet.create({
  row: {
    // 行高由内容决定（两行文字 + 上下 10pt），不低于 44pt 触控下限。
    minHeight: 56,
    justifyContent: 'center',
    paddingVertical: 10,
  },
});

/** 悬浮 tab 栏让开的高度。 */
