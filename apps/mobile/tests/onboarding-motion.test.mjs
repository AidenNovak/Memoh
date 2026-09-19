/**
 * 三条判断题：入场动效该不该播、呼吸该不该跑、辅助字号下上浮多少。
 *
 * 为什么值得单独钉：这三行夹在动画代码里，看截图看不出来，而它们**唯一**的失败方式
 * 正是我们最不想要的那一种——给一个明确要求"减弱动态效果"的人播动效（或反过来，
 * 让屏幕永远在呼吸）。所以它们被抽成纯函数，在这里逐条断。
 *
 * 判据出处：`docs/research/ios-motion-and-microinteractions.md` §2.4（呼吸要有终点）、
 * §6.1（Reduce Motion 覆盖表）、§6.3（Dynamic Type × 动效）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LARGE_FONT_SCALE,
  REVEAL_DISTANCE,
  revealDistance,
  shouldBreathe,
  shouldPlayEntrance,
} from '../src/features/onboarding/motion.ts';

test('系统结论还没回来时不播入场动效（宁可首帧静一下）', () => {
  assert.equal(shouldPlayEntrance('unknown'), false);
  assert.equal(shouldPlayEntrance('allow'), true);
  assert.equal(shouldPlayEntrance('reduce'), false);
});

test('呼吸只在「允许动效」且还在第一页时跑——它必须有终点', () => {
  assert.equal(shouldBreathe('allow', 0), true);
  // 用户开始自己翻页，"这一屏还活着"的信号就该收掉：屏幕不该永远在动。
  assert.equal(shouldBreathe('allow', 1), false);
  assert.equal(shouldBreathe('allow', 2), false);
  assert.equal(shouldBreathe('reduce', 0), false);
  // 'unknown' 与 'reduce' 一样不启动：不能先跑起来再被掐断。
  assert.equal(shouldBreathe('unknown', 0), false);
});

test('辅助字号下上浮归零，只留透明度', () => {
  assert.equal(revealDistance(1), REVEAL_DISTANCE);
  assert.equal(revealDistance(1.35), REVEAL_DISTANCE);
  assert.equal(revealDistance(LARGE_FONT_SCALE), 0);
  assert.equal(revealDistance(3.1), 0);
});
