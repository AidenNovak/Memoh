/**
 * 把「减弱动态效果」的结论 + 字号，翻成三个**能被断言**的判断。
 *
 * 为什么单开一个纯函数模块，而不是写在屏幕里那三行里：屏幕里它们夹在动画代码中间，
 * 谁也不会去测；而它们恰好是"给要减少动效的人播动效"这类错误的唯一开关。
 * 纯函数 → `tests/onboarding-motion.test.mjs` 钉住。
 */
import type { ReducedMotionPreference } from '../../lib/accessibility.ts';

/** 辅助字号从这个倍数起，位移类动效的收益归零、代价翻倍（动效文档 §6.3）。 */
export const LARGE_FONT_SCALE = 2;

/** 页面内容的入场位移（pt）。设计基线：14pt 上浮。 */
export const REVEAL_DISTANCE = 14;

/**
 入场动效该不该播。

 `'unknown'`（系统查询还没回来）**不播**：宁可首帧静一下，也不要给一个明确要求减少
 动效的人播一次他不要的动画。
 */
export function shouldPlayEntrance(preference: ReducedMotionPreference): boolean {
  return preference === 'allow';
}

/**
 标记的待机呼吸该不该跑。

 呼吸是**持续振荡**（HIG 点名了 0.2Hz 附近的敏感带）。它只在"这一屏还静止着"时有意义：
 用户一旦自己开始翻页，"活着"的信号就该收掉，屏幕不该永远在动。
 */
export function shouldBreathe(preference: ReducedMotionPreference, page: number): boolean {
  return shouldPlayEntrance(preference) && page === 0;
}

/**
 页面内容的上浮距离。

 辅助字号下行高很大，14pt 的上浮读出来不是"上浮"而是"晃"——所以大字号下只保留透明度
 变化，位移归零。
 */
export function revealDistance(fontScale: number): number {
  return fontScale >= LARGE_FONT_SCALE ? 0 : REVEAL_DISTANCE;
}
