/**
 * 首启引导（Onboarding）的页模型。
 *
 * ## 它是什么
 *
 * 装好 App、还没登录时的那三屏。它只回答三个问题：Memoh 是干什么的、手机端最该
 * 用它做什么（**审批**）、数据放在哪（**你自己的服务器**）。
 *
 * ## 它明确不是什么
 *
 * **不是配置向导。** 桌面端 Web 的 `/onboarding` 是 5 步向导（语言/主题 → 填
 * provider key → 创建第一个 bot）。手机上复刻它有两个问题：填 API Key 在小屏上
 * 体验极差，而"创建 bot"本身就是重决策（选模型、绑定渠道）。`memoh-design-baseline.md`
 * §1.3 已经裁决过：**手机上不允许创建 bot，配置回桌面端**。这里遵守那个裁决。
 *
 * ## 为什么页定义是纯数据
 *
 * 页数、每页用哪个符号、文案 key——这些是**内容**，与怎么渲染无关。放在纯模块里，
 * 就能保持页面 id、顺序与文案 key 的单一来源：
 * 文案 key 在两份语言文件里都存在、符号名不是空串。这些正是"改内容时最容易写坏、
 * 而肉眼看截图看不出来"的东西。
 */

import type { SFSymbol } from 'sf-symbols-typescript';

export interface OnboardingPage {
  /** 稳定 id：测试、无障碍标签、日志都用它。 */
  id: string;
  /**
   * SF Symbol 名。系统符号，不引第三方图标库。
   *
   * 类型是 `SFSymbol`（`expo-symbols` 带的那份符号名联合类型）而不是 `string`：
   * 符号名写错在 iOS 上表现为**什么都画不出来**——不崩、不报错，只是空一块。
   * 那是最难发现的一类错，让 tsc 拦掉它。
   */
  symbol: SFSymbol;
  titleKey: string;
  bodyKey: string;
}

/**
 * 三页，顺序就是"先讲这是什么 → 再讲你能干什么 → 最后讲数据在哪"。
 */
export const ONBOARDING_PAGES: readonly OnboardingPage[] = [
  {
    id: 'agents',
    symbol: 'server.rack',
    titleKey: 'onboarding.agents.title',
    bodyKey: 'onboarding.agents.body',
  },
  {
    id: 'approval',
    symbol: 'hand.raised.fill',
    titleKey: 'onboarding.approval.title',
    bodyKey: 'onboarding.approval.body',
  },
  {
    id: 'selfHosted',
    symbol: 'lock.shield.fill',
    titleKey: 'onboarding.selfHosted.title',
    bodyKey: 'onboarding.selfHosted.body',
  },
];
