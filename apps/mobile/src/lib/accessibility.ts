/**
 * 无障碍：**让读屏知道屏幕上刚刚出现了什么**。
 *
 * ## 减少动效（Reduce Motion）现在归原生
 *
 * 这里原来有一套 `useReducedMotionPreference()` / `useReducedMotion()` / `motionDuration()`：
 * 三态（`unknown | reduce | allow`）是为了表达"系统查询还没回来时先别动"。模块 9A 之后
 * 只剩引导页还有动画，而它已换成 SwiftUI——那边用 `@Environment(\.accessibilityReduceMotion)`
 * （同步已知，比三态更严格），所以这三个 hook 连同它们的判据一起删掉了（2026-09-21）。
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
import { useEffect, useRef } from 'react';
import { AccessibilityInfo } from 'react-native';

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
 * 那种情况用可点的状态条。
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
