/**
 * 「会话」tab 的外壳：大标题 + 三视图切换 + agent 行。
 *
 * ## 为什么三个视图挤在同一个 tab 里
 *
 * 2026-09-15 的裁决（`docs/research/memoh-design-baseline.md` §7.1）：底部只要两个 tab。
 * 文件与定时不是"另外两个地方"，而是**同一个 agent 的另外两种看法**——桌面端也是
 * Chat / Files / Schedule 三视图互斥。所以三视图共用这一屏的标题行与 agent 行，切视图
 * **不切 agent**；反过来切 agent 时三视图的数据整体跟着换（它们都属于这个 agent）。
 *
 * ## 分工
 *
 * 这一屏只负责"壳 + 当前视图"：标题行、图标组、agent 行、新建会话按钮。三个视图各自
 * 是独立屏幕（`HomeScreen` / `FilesScreen` / `ScheduleScreen`），它们**不画大标题**——
 * 大标题就是当前视图名，写两遍必然有一天不一致。
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '../lib/i18n/useT.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';
import { ACCESSIBILITY_FONT_SCALE, PRESS_OPACITY } from '../lib/theme/tokens.ts';
import { BotSwitcher } from '../ui/BotSwitcher.tsx';
import { ConnectionBadge } from '../ui/ConnectionBadge.tsx';
import { ViewSwitcher, type HubView } from '../ui/ViewSwitcher.tsx';
import { FilesScreen } from './FilesScreen.tsx';
import { HomeScreen } from './HomeScreen.tsx';
import { ScheduleScreen } from './ScheduleScreen.tsx';

/** 文件视图的根。**客户端钉死**：服务端只做 `path.Clean` + 拒 `..`，不校验前缀。 */
export const FILES_ROOT = '/data';

/** 视图 → 标题的 i18n 键。会话视图复用 `home.title`：同一个词不该有两个键。 */
const HUB_TITLE_KEY: Record<HubView, string> = {
  sessions: 'home.title',
  files: 'hub.view.files',
  schedule: 'hub.view.schedule',
};

function parseView(raw: string | undefined): HubView {
  return raw === 'files' || raw === 'schedule' ? raw : 'sessions';
}

/**
 * 新建会话的 `＋`（会话页新建会话的**唯一入口**）。
 *
 * 单独抽出来是因为它在两种形态下出现（默认档紧跟徽章、辅助档顶到最右），
 * 而"入口只有一份实现"这件事必须由代码结构保证：抄成两份就会有一天只改了一处。
 *
 * `allowFontScaling={false}`：`＋` 是**图标**不是文字。不关掉缩放的话，最大辅助字号下
 * 这个 24pt 的字形会变成 ~75pt，塞在 32pt 的按钮里——按钮的命中区没变，画出来的东西
 * 却不成比例（2026-09-18 实测这一档下它在屏幕上根本看不见）。入口的**可见性**比
 * "它跟着字号长大"重要，所以这里钉死尺寸，`hitSlop` 保证命中区仍有 48pt。
 */
function NewSessionButton() {
  const palette = usePalette();
  const t = useT();
  const router = useRouter();
  const onPress = useCallback(() => {
    router.push('/chat/new');
  }, [router]);
  return (
    <Pressable
      testID="hub-new-session"
      accessibilityRole="button"
      accessibilityLabel={t('home.newSession')}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        // `flexShrink: 0`：这一行里唯一不许被压缩的元素（见 agent 行的注释）。
        flexShrink: 0,
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? PRESS_OPACITY.control : 1,
      })}
    >
      <Text
        allowFontScaling={false}
        style={{ color: palette.accent, fontSize: 24, lineHeight: 28 }}
      >
        ＋
      </Text>
    </Pressable>
  );
}

export function SessionsHubScreen() {
  const palette = usePalette();
  const { spacing, typography } = useTheme();
  const insets = useSafeAreaInsets();
  const t = useT();
  // `?view=files` 这样进来能直达某个视图（设计稿的 `#files` / `#schedule` 等价物）。
  // 也让自动化验收能一条命令点到某一屏，不用先点两下图标。
  const params = useLocalSearchParams<{ view?: string }>();
  const [view, setView] = useState<HubView>(parseView(params.view));
  const { fontScale } = useWindowDimensions();
  const accessibilityText = fontScale >= ACCESSIBILITY_FONT_SCALE;

  useEffect(() => {
    const next = parseView(params.view);
    if (params.view !== undefined) setView(next);
  }, [params.view]);

  return (
    <View style={{ flex: 1, backgroundColor: palette.groupedBackground, paddingTop: insets.top }}>
      <View
        style={{
          flexDirection: accessibilityText ? 'column' : 'row',
          alignItems: accessibilityText ? 'stretch' : 'center',
          justifyContent: 'space-between',
          gap: spacing.sm,
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.sm,
        }}
      >
        {/* 当前视图名就是大标题。这样三个视图不需要各自再画一遍标题，也省下图标按钮
            那一行的高度（分段控件形态会把这一行让给它）。 */}
        {/* 大标题与切换器的竞争分两档：
            * 默认档：并排，标题 `flexShrink: 1` + 单行截断（同屏还有底部 tab 上的同一个词，
              所以截断在这个档是可接受的，省下的一行高度更有价值）；
            * **辅助档（AX）**：标题约 106pt，"Sessions"一个字就宽过屏宽，再并排就只剩
              `Se…`——而这一档的用户要的正是"看得见"，截断等于没有标题。所以切成两行布局：
              标题占满整行、**缩到一行放得下**，切换器移到下一行右对齐。切换器在辅助档下
              **比标题更重要**：它是三个视图唯一的入口，而标题在底部 tab 上还有一份。

            ## 为什么是"缩字号"而不是"允许折行"（2026-09-18 改）

            以前这一档允许折行，理由是"折行不丢字"。但 `Sessions` 是一个**单词**：折行
            折在词中间，屏幕上读到的不是 `Sessions`，是 `Sessio` + `ns`（同一件事在
            `Schedule` / `Settings` 上也发生，视觉评审 §3.3 把 `Settin` / `gs` 列为缺陷）。
            这一档下 `Sessions` 宽 482pt、可用宽 370pt——要么缩字号，要么拆词。
            `adjustsFontSizeToFit` 缩到 ~67pt（仍是默认档 34pt 的两倍）换来"一行读完、
            一个字符不少"，比拆词更接近"看得见"这个目标。 */}
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit={accessibilityText}
            minimumFontScale={accessibilityText ? 0.55 : undefined}
            style={[typography.largeTitle, { color: palette.label }]}
          >
            {/* 当前视图名就是大标题：封闭集合用字典，不用链式三元（AGENTS.md）。 */}
            {t(HUB_TITLE_KEY[view])}
          </Text>
        </View>
        <View
          style={
            accessibilityText ? { flexDirection: 'row', justifyContent: 'flex-end' } : undefined
          }
        >
          <ViewSwitcher value={view} onChange={setView} />
        </View>
      </View>

      {/* agent 行：三视图共用。左边是"当前是哪个 agent"，右边是这一屏能做的事。
          切换 agent 的入口在这里而不是标题里——桌面端对应的是顶部 bot/用户区。

          **这一行在最大辅助字号下曾经横向溢出**：`BotSwitcher` 里的名字与状态徽章
          （`● Online`）都不许收缩，于是整行宽过屏宽、被屏幕右缘切掉，而最右边那个
          新建按钮（`＋`）——新建会话的**唯一入口**——被挤出屏幕（2026-09-17 实测）。
          修法是"谁可以让步"写清楚：名字与徽章可以收（截断），`＋` 不让（`flexShrink: 0`），
          因为入口消失的代价比一行字被截断大得多。

          ## 辅助档下这一行改成"上下两段"（2026-09-18 改）

          上面那条修法**不够**：这一档下"头像 + 名字 + ⌄ + 徽章 + `＋`"要 ~500pt，
          而屏宽 402pt——名字被截成 `Assist…`、徽章的标签被截成 `O…`，`＋` 仍然不在
          屏幕上（2026-09-18 实测，三条一起发生）。"让步"再怎么写也变不出 100pt 来，
          所以这一档换形态而不是继续挤：`BotSwitcher` 把徽章移到**第二行**（名字那一行
          就只剩头像 + 名字 + ⌄，宽 276pt，放得下），`＋` 用弹簧顶到最右——它在屏幕上
          且有 32pt（hitSlop 8 → 48pt）的命中区。 */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          paddingRight: spacing.lg,
          paddingTop: spacing.sm,
          paddingBottom: spacing.sm,
        }}
      >
        <BotSwitcher variant="row" stacked={accessibilityText} />
        <ConnectionBadge />
        {/* 辅助档下把 `＋` 推到最右：它与徽章挤在一起时会被徽章的文字推着走，
            顶到屏幕外。默认档保持原样（紧跟徽章），那是视觉评审认可的形态。 */}
        {accessibilityText ? <View style={{ flex: 1 }} /> : null}
        {view === 'sessions' ? <NewSessionButton /> : null}
      </View>

      <View style={{ flex: 1 }}>
        {view === 'sessions' ? <HomeScreen embedded /> : null}
        {view === 'files' ? <FilesScreen path={FILES_ROOT} /> : null}
        {view === 'schedule' ? <ScheduleScreen /> : null}
      </View>
    </View>
  );
}
