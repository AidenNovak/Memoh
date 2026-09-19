/**
 * 无障碍：减少动效，以及**让读屏知道屏幕上刚刚出现了什么**。
 *
 * ## 为什么必须做
 *
 * iOS 有个系统级开关「减弱动态效果」，前庭功能障碍的用户会因界面动效而眩晕。
 * Lody 把这条写成了硬规则：**每个动画路径都要查它并早退**。
 *
 * 我们目前的动效很少（列表出现、键盘、sheet），但**越少越容易漏**——因为不常写，
 * 写的时候想不起来这个开关。所以把它做成一个必须显式调用的 hook。
 *
 * ## 为什么自己写而不用 RN 自带的
 *
 * RN 0.76 起有 `useReducedMotion`，但**本项目用的 0.86.3 没有从主入口导出它**
 * （`Libraries/Components/AccessibilityInfo/AccessibilityInfo.js` 只有
 * `export default AccessibilityInfo`，没有具名 hook 导出）。查过再写，
 * 免得 import 一个不存在的符号在运行时才炸。
 *
 * 这里基于它确实有的两个东西实现：`AccessibilityInfo.isReduceMotionEnabled()`
 * （异步查询）与 `AccessibilityInfo.addEventListener('reduceMotionChanged', …)`
 * （运行时变化——用户在设置里切的时候要立刻生效，不能等下次启动）。
 *
 * ## ⚠️ 播报错误**不能**用 `accessibilityLiveRegion`
 *
 * 这是个实测出来的坑（见 `docs/research/ios-error-and-feedback.md` R29）。RN 的类型定义
 * 写着它 `@platform android`（"Works for Android API >= 19 only"），而 iOS 侧的实现里
 * **根本没有消费者**：`node_modules/react-native/React/`（Objective-C/Swift/渲染层）
 * 搜不到任何读取它的地方，只有 `ReactAndroid` 的 `BaseViewManager` 会把它接到
 * `View.AccessibilityDelegate` 上。
 *
 * 所以 0.86.3 上写 `accessibilityLiveRegion="polite"` 在 iOS 上**一句都不会读出来**——
 * 它是"写了看起来对、实际是空转"的那一类属性，比不写更危险。
 * iOS 侧唯一正确的机制是 `AccessibilityInfo.announceForAccessibility`，也就是下面这两个。
 */
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * 「减弱动态效果」的**当前结论**。
 *
 * 三态而不是布尔：系统查询是异步的，**在它回来之前我们并不知道答案**。把它压成
 * `false`（旧写法）会造成一个具体的错误——开了这个开关的人，冷启动 onboarding 时
 * 标记的入场动画会先跑起来，几十毫秒后才被掐断，看到的是一次"抽一下"的入场，
 * 正是这个人要求不要的东西。`'unknown'` 让调用方能表达"宁可先静一下，等结论"。
 */
export type ReducedMotionPreference = 'unknown' | 'reduce' | 'allow';

/**
 * 当前「减弱动态效果」的设置。
 *
 * 判据（调用方该怎么用，来自 HIG · Accessibility · Reduce Motion）：
 *
 * - `'allow'` → 正常播；
 * - `'reduce'` → 直接到终态，不播；
 * - `'unknown'` → **不要启动动画**，等它变成上面两种再决定。观感上是一瞬间的静止，
 *   而不是"先动一下再收住"。
 */
export function useReducedMotionPreference(): ReducedMotionPreference {
  const [preference, setPreference] = useState<ReducedMotionPreference>('unknown');

  useEffect(() => {
    let cancelled = false;

    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setPreference(enabled ? 'reduce' : 'allow');
      })
      .catch(() => {
        // 查不到就当作"不要求减少动效"——那是系统的默认值。
        if (!cancelled) setPreference('allow');
      });

    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      setPreference(enabled ? 'reduce' : 'allow');
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return preference;
}

/**
 * 布尔版本，**只用在"动画已经在播、需要中途收敛"的场合**（例如把时长收敛到 0）。
 *
 * 新写的动画路径请用 `useReducedMotionPreference()`：这个包装在首帧会把
 * `'unknown'` 当成 `false`（= 允许动效），于是又会漏出上面说的"先动一下"。
 */
export function useReducedMotion(): boolean {
  return useReducedMotionPreference() === 'reduce';
}

/**
 * 把一个动效时长按用户偏好收敛。
 *
 * 用法：`duration={motionDuration(reduceMotion, 250)}`。
 * 减少动效时返回 0 而不是直接跳过动画——跳过会让 `onAnimationEnd` 之类的回调
 * 永远不触发，那是个隐蔽的 bug。
 */
export function motionDuration(reduceMotion: boolean, milliseconds: number): number {
  return reduceMotion ? 0 : milliseconds;
}

/**
 * 让读屏把这句话念出来。
 *
 * 用系统约定的 `default` 优先级：**会打断**当前朗读（错误出现时这是对的——用户必须知道），
 * 但打断之后自己是可以被别的朗读打断的（不像 `high` 那样霸占）。
 *
 * 系统没有开读屏时这个调用是空的（`UIAccessibility.post` 没有 assistive app 时不做任何
 * 事），所以调用方不需要自己去查"读屏开没开"——那反而容易漏掉"运行中才打开读屏"的人。
 */
export function announceForAccessibility(text: string): void {
  const trimmed = text.trim();
  if (trimmed === '') return;
  const withOptions = AccessibilityInfo.announceForAccessibilityWithOptions;
  if (typeof withOptions === 'function') {
    withOptions(trimmed, { queue: false, priority: 'default' });
    return;
  }
  AccessibilityInfo.announceForAccessibility(trimmed);
}

/**
 * `text` 变成一句**新的、非空的**话时播报一次。
 *
 * 三条刻意的克制（都会在调试时被误会成 bug，所以写下来）：第一次渲染不播报（那是"进这一
 * 屏时它本来就在"，不是"刚刚出现"）；同一个字符串重复渲染不播报（比如父组件重渲染）；
 * `null`/空串是"没有话要说"，不播报。
 *
 * 反复翻转的状态**不要**用这个（弱网下每几秒翻一次的"重连中"会把读屏用户淹掉）——
 * 那种情况用可点的状态条，见 `ui/ConnectionBadge.tsx`。
 */
export function useAnnounceOnAppear(text: string | null | undefined): void {
  const previous = useRef<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    const next = text === null || text === undefined || text.trim() === '' ? null : text;
    if (next === previous.current) return;
    previous.current = next;
    const firstRender = !mounted.current;
    mounted.current = true;
    if (next === null || firstRender) return;
    announceForAccessibility(next);
  }, [text]);
}
