/**
 * 首启引导是否看过——本机记忆。
 *
 * ## 为什么存在 Keychain 里
 *
 * 这不是秘密，本该放 `UserDefaults`。但 App 目前**只有一条持久化通道**：凭据走的
 * `expo-secure-store`（iOS 上就是 Keychain），MemohKit 那边还没有 preferences 桥。
 * 为一个布尔值加一个原生模块（要重新 prebuild + 全量构建 + 重跑 hosted 测试）不划算。
 *
 * 代价说清楚：Keychain 里的条目**重装 App 不会清**（这是 Keychain 的设计）。所以
 * "删掉 App 再装回来"不会再看到引导——这正是验收要覆盖的地方：验收脚本本来就会
 * `simctl keychain reset`，模拟"全新安装"。
 *
 * 迁移点：等 MemohKit 有了 UserDefaults 桥，把这两个函数换成它，别的地方不用动。
 */
import * as SecureStore from 'expo-secure-store';

const SEEN_KEY = 'memoh.onboarding.seen.v1';

/** 出错的语义：读不到就当"没看过"（宁可多给一次引导，也别让首启变成空白页）。 */
export async function hasSeenOnboarding(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(SEEN_KEY)) !== null;
  } catch {
    return false;
  }
}

/**
 * 记下"看过了"。
 *
 * 写失败**不抛**：按钮已经点了，用户该进登录页。下次启动会再看到引导——
 * 那比"点了没反应"好；而"点了没反应"正是这里抛异常会造成的后果。
 */
export async function markOnboardingSeen(): Promise<void> {
  try {
    await SecureStore.setItemAsync(SEEN_KEY, '1', {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch {
    // 见上：写不进去只影响"下次还要不要再看"。
  }
}
