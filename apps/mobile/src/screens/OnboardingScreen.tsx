/**
 * 首启引导（三屏）。
 *
 * ## 为什么是"启动页"而不是一个 sheet
 *
 * 它是 App 的第一屏：冷启动 → 这三屏 → 登录页。从底部升起一个 sheet 是"从某个
 * 上下文里弹出来的东西"的形态，而这里**没有那个上下文**。
 *
 * ## 形态与动效
 *
 * 背景用 `palette.background`，和 `expo-splash-screen` 的底色是**同一个值**
 * （`app.config.ts` 里写死的 `#FAF8F7` / `#060606`）。冷启动到这一屏不跳色，
 * 引导看起来是启动屏长出来的，而不是又开了一页。
 *
 * 动效只有三件事，都在时间轴上，不靠装饰：
 *
 * 1. 品牌标记入场（缩放 0.92 → 1 + 淡入，easeOutExpo，500ms）；
 * 2. 每页内容随翻页淡入上浮（14pt → 0，easeOutExpo，400ms）——用 `onScroll` 驱动，
 *    不是等手势停下来才出现；
 * 3. 标记待机呼吸（scale 1 ↔ 1.03，2.6s 一个来回）：幅度小到只有盯着它才看得见，
 *    作用是让静止的屏幕不像"卡住了"。
 *
 * 加上一条**不是动画**的连续变化：页码点的宽度与颜色由滚动偏移插值得到，跟着手指
 * 长出来（见 `PageDot`）。
 *
 * 曲线是设计基线里唯一那条 easeOutExpo（`cubic-bezier(0.16,1,0.3,1)`）。
 * **Reduce Motion 打开时三步全部退化为直接呈现**（时长 0，呼吸不启动）；系统查询还没
 * 回来（`'unknown'`）时**也不启动**，不让要减少动效的人先看到一次入场（三条判断题都在
 * `features/onboarding/motion.ts`）。呼吸还有一个终点：用户开始翻页后它收掉。
 *
 * ## 大字号（Dynamic Type）
 *
 * 正文放到辅助字号时，「标记 + 分页」这一组比屏幕还高，而横向分页器的溢出是**裁掉**
 * 的——`accessibility-extra-large` 下正文第 5 行压在页码点上、句子断在句中，剩下的话
 * 读不到（冷启动实测）。所以外面套一层纵向 ScrollView：放得下就还是居中一屏，放不下
 * 就能滚。CTA 与"跳过"留在滚动区之外，保证任何字号下都够得着。
 *
 * ## 不做的事
 *
 * 不填服务器、不建 bot、不选模型。服务器地址在登录页那一步；创建 bot 与 provider
 * 配置回桌面端（`memoh-design-baseline.md` §1.3 的裁决）。理由见
 * `features/onboarding/pages.ts`。
 */
import { SymbolView } from 'expo-symbols';
import type { SFSymbol } from 'sf-symbols-typescript';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useReducedMotionPreference, type ReducedMotionPreference } from '../lib/accessibility.ts';
import {
  revealDistance,
  shouldBreathe,
  shouldPlayEntrance,
} from '../features/onboarding/motion.ts';
import { ONBOARDING_PAGES } from '../features/onboarding/pages.ts';
import { useT } from '../lib/i18n/useT.ts';
import { PRESS_OPACITY, radius, radiusStyle } from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';

/** 设计基线里唯一那条曲线：easeOutExpo。 */
const EASE_OUT_EXPO = Easing.bezier(0.16, 1, 0.3, 1);

/** 品牌标记的直径。登录页是 64pt——这里是主角，大一号。 */
const MARK_SIZE = 96;

/**
 * 文案列宽。
 *
 * 一屏宽（iPhone 上 393–440pt）减去左右边距之后，一行能塞下 60 多个字符——
 * 读起来太长。引导的正文是"一句话说明"，收窄到 320pt 更像印刷品的栏宽。
 */
const TEXT_COLUMN = 320;

/**
 * 动效集中的那一页。
 *
 * 三页里只有 ②「在哪儿都能批准」是**别人替代不了的能力**（agent 7x24 在跑，人不在
 * 电脑前点一下就能让它继续）——设计基线的决策记 §7.2 明确要求动效集中在它身上。
 * 所以只有这一页的符号在进入时会"弹"一下，其余两页只有淡入上浮。
 */
const EMPHASIS_PAGE = 'approval';

export function OnboardingScreen({ onDone }: { onDone: () => void }) {
  const palette = usePalette();
  const { spacing, typography } = useTheme();
  const insets = useSafeAreaInsets();
  const t = useT();
  const reduceMotion = useReducedMotionPreference();
  const { width, fontScale } = useWindowDimensions();

  const pager = useRef<ScrollView | null>(null);
  const [page, setPage] = useState(0);
  const lastPage = ONBOARDING_PAGES.length - 1;

  /** 入场进度 0 → 1；标记的缩放与透明度都由它插值。 */
  const entrance = useRef(new Animated.Value(0)).current;
  /** 待机呼吸 0 ↔ 1；只驱动一个很小的缩放。 */
  const breath = useRef(new Animated.Value(0)).current;
  /**
   * 分页器当前的水平偏移（pt）。
   *
   * 它不是"第几页"，而是**手指现在到哪儿了**——页码点靠它连续变化。见文件头
   * "页码点跟着手指"。
   */
  const scrollX = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!shouldPlayEntrance(reduceMotion)) {
      entrance.setValue(1);
      return;
    }
    Animated.timing(entrance, {
      toValue: 1,
      duration: 500,
      easing: EASE_OUT_EXPO,
      useNativeDriver: true,
    }).start();
  }, [entrance, reduceMotion]);

  useEffect(() => {
    // 呼吸**有终点**：用户一旦自己翻页，"这一屏还活着"的信号就该收掉（见 motion.ts 的
    // shouldBreathe）。`'unknown'` 时也不启动——宁可首帧不动，也不给要减少动效的人播。
    if (!shouldBreathe(reduceMotion, page)) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: 1300,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: 1300,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breath, page, reduceMotion]);

  const goTo = useCallback(
    (index: number) => {
      setPage(index);
      pager.current?.scrollTo({ x: index * width, animated: reduceMotion !== 'reduce' });
    },
    [reduceMotion, width],
  );

  const onAdvance = useCallback(() => {
    if (page === lastPage) {
      onDone();
      return;
    }
    goTo(page + 1);
  }, [goTo, lastPage, onDone, page]);

  const markStyle = useMemo(() => {
    const appear = entrance.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] });
    const idle = breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] });
    return {
      width: MARK_SIZE,
      height: MARK_SIZE,
      opacity: entrance,
      transform: [{ scale: Animated.multiply(appear, idle) }],
    };
  }, [breath, entrance]);

  const last = page === lastPage;

  return (
    <View style={{ flex: 1, backgroundColor: palette.background }}>
      <View
        style={{
          paddingTop: insets.top + spacing.sm,
          paddingHorizontal: spacing.lg,
          // 高度写死成一个 44pt 的行高：最后一页隐藏"跳过"时，标记不该跟着跳一下。
          height: insets.top + spacing.sm + 44,
          alignItems: 'flex-end',
          justifyContent: 'flex-end',
        }}
      >
        {/*
          「跳过」在右上角：内容讲得再好也有人急着登录，不给出口只会逼人乱点。
          最后一页不显示——那时主按钮就是"开始使用"，再放一个跳过是自相矛盾。
        */}
        <Pressable
          testID="onboarding-skip"
          accessibilityRole="button"
          accessibilityLabel={t('onboarding.skip')}
          accessibilityElementsHidden={last}
          importantForAccessibility={last ? 'no-hide-descendants' : 'auto'}
          onPress={onDone}
          hitSlop={12}
          style={({ pressed }) => ({
            opacity: pressed ? PRESS_OPACITY.control : 1,
            minHeight: 44,
            justifyContent: 'center',
          })}
        >
          <Text style={[typography.subhead, { color: palette.accent }]}>
            {t('onboarding.skip')}
          </Text>
        </Pressable>
      </View>

      {/*
        「标记 + 分页」是一整组，垂直居中。

        为什么不做成"标记钉在最上面、内容填满剩下的空间"：那是一屏 874pt 的 iPhone 上
        会得到 200pt 上下的两片大空白，看起来像排版没做完（视觉评审原话："Logo 孤悬、
        与内容块完全脱节"）。整组居中之后，上下的留白是**一份**，读起来是有意的留白。

        ⚠️ 分页区的高度由内容决定（`flexGrow: 0`），不要写成 `flex: 1`：那样它会吃掉
        全部剩余空间，标记又被推回顶部。

        外面这层纵向 ScrollView 是**辅助字号下的兜底**：正文放大到两三倍时这一组比屏幕
        还高，而横向分页器的溢出是**裁掉**（不是滚）——`accessibility-extra-large` 下
        正文第 5 行压在页码点上、句子断在 "…the work happens on your"，剩下的话没有出口
        （冷启动实测，对照图见 `verification/onboarding/out/*-motion-and-a11y/`）。
        纵向能滚之后，内容放得下就还是居中的一屏（`flexGrow: 1` + `justifyContent: 'center'`），
        放不下就能滚。`bounces={false}`：内容放得下时它不该像一张可以扯动的纸。
      */}
      <ScrollView
        testID="onboarding-body"
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', gap: spacing.xl }}
        bounces={false}
      >
        <View style={{ alignItems: 'center' }}>
          <Animated.Image
            testID="onboarding-mark"
            source={require('../../assets/images/brand-mark.png')}
            style={markStyle}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
          />
        </View>

        <ScrollView
          ref={pager}
          testID="onboarding-pager"
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ alignItems: 'stretch' }}
          // 用 onScroll（而不是等手势停下）取当前页：翻页过程中内容就开始淡入，
          // "等停下来才出现"会显得这一页是卡出来的。
          scrollEventThrottle={16}
          onScroll={(event) => {
            scrollX.setValue(event.nativeEvent.contentOffset.x);
            const next = Math.round(event.nativeEvent.contentOffset.x / width);
            if (next !== page && next >= 0 && next <= lastPage) setPage(next);
          }}
          accessibilityLabel={t('onboarding.progress', {
            current: String(page + 1),
            total: String(ONBOARDING_PAGES.length),
          })}
        >
          {ONBOARDING_PAGES.map((item, index) => (
            <OnboardingPage
              key={item.id}
              id={item.id}
              symbol={item.symbol}
              title={t(item.titleKey)}
              body={t(item.bodyKey)}
              width={width}
              active={index === page}
              motion={reduceMotion}
              fontScale={fontScale}
            />
          ))}
        </ScrollView>
      </ScrollView>

      <Animated.View
        style={{
          opacity: entrance,
          paddingHorizontal: spacing.lg,
          paddingBottom: insets.bottom + spacing.lg,
          gap: spacing.lg,
        }}
      >
        {/* 页码点：只表达"这是第几屏"，不给它无障碍标签——内容本身是标题，
            念一遍"第 2 页，共 3 页"是噪音。 */}
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.sm }}
        >
          {ONBOARDING_PAGES.map((item, index) => (
            <PageDot
              key={item.id}
              testID={index === page ? 'onboarding-dot-active' : `onboarding-dot-${index}`}
              index={index}
              pageWidth={width}
              scrollX={scrollX}
              idleColor={palette.tertiaryLabel}
              activeColor={palette.accent}
            />
          ))}
        </View>

        <Pressable
          testID="onboarding-advance"
          accessibilityRole="button"
          accessibilityLabel={last ? t('onboarding.start') : t('onboarding.next')}
          onPress={onAdvance}
          style={({ pressed }) => [
            styles.advance,
            {
              backgroundColor: pressed ? palette.accentPressed : palette.accent,
              ...radiusStyle(radius.pill),
            },
          ]}
        >
          <Text style={[typography.headline, { color: palette.onAccent }]}>
            {last ? t('onboarding.start') : t('onboarding.next')}
          </Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

/**
 * 一页。
 *
 * `active` 由父级的滚动位置驱动（不是"翻完才变"）：内容在上滑过程中就淡入，
 * 手一停它已经在位了。Reduce Motion 时不动，直接切换。
 */
function OnboardingPage({
  id,
  symbol,
  title,
  body,
  width,
  active,
  motion,
  fontScale,
}: {
  id: string;
  symbol: SFSymbol;
  title: string;
  body: string;
  width: number;
  active: boolean;
  motion: ReducedMotionPreference;
  fontScale: number;
}) {
  const palette = usePalette();
  const { spacing, typography } = useTheme();
  const reveal = useRef(new Animated.Value(0)).current;
  /** 符号的一次"弹"（只有 EMPHASIS_PAGE 会用到）。 */
  const emphasis = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!shouldPlayEntrance(motion)) {
      reveal.setValue(active ? 1 : 0);
      return;
    }
    Animated.timing(reveal, {
      toValue: active ? 1 : 0,
      duration: 400,
      easing: EASE_OUT_EXPO,
      useNativeDriver: true,
    }).start();
  }, [active, motion, reveal]);

  useEffect(() => {
    if (id !== EMPHASIS_PAGE || !active || !shouldPlayEntrance(motion)) {
      emphasis.setValue(1);
      return;
    }
    const pop = Animated.sequence([
      Animated.timing(emphasis, {
        toValue: 1.12,
        duration: 160,
        easing: EASE_OUT_EXPO,
        useNativeDriver: true,
      }),
      Animated.timing(emphasis, {
        toValue: 1,
        duration: 260,
        easing: EASE_OUT_EXPO,
        useNativeDriver: true,
      }),
    ]);
    pop.start();
    return () => pop.stop();
  }, [active, emphasis, id, motion]);

  return (
    <Animated.View
      testID={`onboarding-page-${id}`}
      style={{
        width,
        opacity: reveal,
        transform: [
          // 辅助字号下位移归零（只留透明度）：14pt 的上浮在一个 40pt 行高的页面上读出来
          // 不是"上浮"而是"晃"。判据在 features/onboarding/motion.ts 的 revealDistance。
          {
            translateY: reveal.interpolate({
              inputRange: [0, 1],
              outputRange: [revealDistance(fontScale), 0],
            }),
          },
        ],
        paddingHorizontal: spacing.xxl,
        // 垂直居中：标记与页码点之间的这块空间里，内容居中最稳。
        // 不居中的话内容会挤在标记下方，下面留一大片空白（视觉评审提过这一点）。
        justifyContent: 'center',
        alignItems: 'center',
        gap: spacing.sm,
      }}
    >
      {/* SF Symbol 而不是自绘图形：系统符号自带 Dynamic Type、明暗与粗细适配，
          也没有"我们自己画了一个 iOS 图标"那种拼缝。 */}
      <Animated.View style={{ transform: [{ scale: emphasis }] }}>
        <SymbolView
          name={symbol}
          size={40}
          tintColor={palette.accent}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ width: 44, height: 44, marginBottom: spacing.xs }}
        />
      </Animated.View>
      <Text
        accessibilityRole="header"
        style={[
          typography.title2,
          { color: palette.label, textAlign: 'center', maxWidth: TEXT_COLUMN },
        ]}
      >
        {title}
      </Text>
      <Text
        style={[
          typography.subhead,
          { color: palette.secondaryLabel, textAlign: 'center', maxWidth: TEXT_COLUMN },
        ]}
      >
        {body}
      </Text>
    </Animated.View>
  );
}

/** 页码点的两种尺寸：非当前页是一个 6pt 圆点，当前页是一枚 18pt 胶囊。 */
const DOT_SIZE = 6;
const DOT_ACTIVE_WIDTH = 18;

/**
 * 一个页码点——它的宽度与颜色**跟着手指连续变化**。
 *
 * 之前是"跨过半页跳一次"（由 `page` 状态驱动），于是翻页时屏幕上同时发生两件事：
 * 内容在滑、点在跳，而且点的跳变和内容的淡入不在同一个节奏上。改成由 `scrollX`
 * 插值之后，胶囊是从圆点**长出来**的：整屏只有一个连续事件，用户不需要重新定位
 * "我现在到第几页了"。
 *
 * 为什么不用 `Animated.timing` 做一个 200ms 补间：那要等手势结束才开始动，与手指
 * 脱节，而且会多出一个"我松手了但界面还在动"的尾巴。HIG 的 Reduce Motion 一节把
 * "让动画直接跟着人的手势走"列为**减少动效的做法**之一——所以这一条不需要额外的
 * Reduce Motion 分支：点永远在手指所在的位置上。Reduce Motion 关掉的是点"继续"
 * 时的滚动动画（`goTo`），那时偏移是直接跳的，点跟着一起跳，一致。
 *
 * 插值的三段是 `[i-1, i, i+1]` 页：输入范围必须单调递增（插值器的要求），首尾
 * 多出来的那一格在屏幕外。回弹（offset < 0 或 > 末页）用 `extrapolate: 'clamp'`
 * 钉住，否则手指往边上多拽一点，胶囊会被拉得更长。
 */
function PageDot({
  testID,
  index,
  pageWidth,
  scrollX,
  idleColor,
  activeColor,
}: {
  testID: string;
  index: number;
  pageWidth: number;
  scrollX: Animated.Value;
  idleColor: string;
  activeColor: string;
}) {
  const range = useMemo(
    () => [(index - 1) * pageWidth, index * pageWidth, (index + 1) * pageWidth],
    [index, pageWidth],
  );

  const style = useMemo(
    () => ({
      width: scrollX.interpolate({
        inputRange: range,
        outputRange: [DOT_SIZE, DOT_ACTIVE_WIDTH, DOT_SIZE],
        extrapolate: 'clamp' as const,
      }),
      height: DOT_SIZE,
      ...radiusStyle(radius.pill),
      backgroundColor: scrollX.interpolate({
        inputRange: range,
        outputRange: [idleColor, activeColor, idleColor],
        extrapolate: 'clamp' as const,
      }),
    }),
    [activeColor, idleColor, range, scrollX],
  );

  return <Animated.View testID={testID} style={style} />;
}

const styles = StyleSheet.create({
  advance: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
