/**
 * 通知相关的本机记忆：**权限请求史**与**已确认的 device 绑定**。
 *
 * ## 为什么走 Keychain（`expo-secure-store`）
 *
 * 跟 `features/onboarding/seen.ts` 同一个理由：App 目前只有一条持久化通道，而
 * MemohKit 还没有 preferences 桥。为两条记录加一个原生模块（要重 prebuild + 全量
 * 构建）不划算。代价也一样：Keychain 里的条目**删掉 App 不会清**，所以模拟"全新安装"
 * 要用 `simctl keychain reset`（验收脚本本来就会这么做）。
 *
 * ## 读写失败的语义（两条都不一样，故意的）
 *
 * - 权限史读不到 → 当"没请求过"。最坏是再请求一次（而请求本身有封顶与冷却兜着）。
 * - 绑定读不到 → 当"没绑过"。于是下次会走一遍"注册"，不会去解绑一个我们并不确定存在的
 *   绑定——**解绑错的东西比重复注册危险得多**。
 */
import * as SecureStore from 'expo-secure-store';

import {
  EMPTY_HISTORY,
  parsePermissionHistory,
  serializePermissionHistory,
  type PermissionHistory,
} from './history.ts';
import { parseBound, serializeBound, type BoundRegistration } from './registration.ts';

const PERMISSION_KEY = 'memoh.notifications.permission.v1';
const BINDING_KEY = 'memoh.notifications.binding.v1';

const WRITE_OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function loadPermissionHistory(): Promise<PermissionHistory> {
  try {
    return parsePermissionHistory(await SecureStore.getItemAsync(PERMISSION_KEY));
  } catch {
    return EMPTY_HISTORY;
  }
}

export async function savePermissionHistory(history: PermissionHistory): Promise<void> {
  try {
    await SecureStore.setItemAsync(
      PERMISSION_KEY,
      serializePermissionHistory(history),
      WRITE_OPTIONS,
    );
  } catch {
    // 写不进去只影响"下次请求会不会被冷却拦下"：最坏是多问一次，比崩掉好。
  }
}

export async function loadBoundRegistration(): Promise<BoundRegistration | null> {
  try {
    return parseBound(await SecureStore.getItemAsync(BINDING_KEY));
  } catch {
    return null;
  }
}

export async function saveBoundRegistration(bound: BoundRegistration): Promise<void> {
  try {
    await SecureStore.setItemAsync(BINDING_KEY, serializeBound(bound), WRITE_OPTIONS);
  } catch {
    // 见文件头：写不进去会导致下次重复注册，这是可接受的失败方向。
  }
}

export async function clearBoundRegistration(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(BINDING_KEY);
  } catch {
    // 同上。
  }
}
