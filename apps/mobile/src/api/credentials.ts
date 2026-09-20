/**
 * 会话凭据存储。
 *
 * token 必须进 **Keychain**，不是 UserDefaults，也不是 cookie 那套（那是 Web 的）。
 * `expo-secure-store` 在 iOS 上就是 Keychain；这里额外把 profile 一起存下来，
 * 因为 `/auth/refresh` **不返回** `user_id` / `role` / `display_name` / `timezone`，
 * 只有登录那一次才有。
 *
 * 注意 `WHEN_UNLOCKED_THIS_DEVICE_ONLY` 的取舍：后台被唤醒时若设备已锁，读不到
 * Keychain。本项目没有后台任务需求，安全性优先。
 */
import * as SecureStore from 'expo-secure-store';

const KEY = 'memoh.session.v1';

export interface StoredSession {
  baseUrl: string;
  token: string;
  /** ISO8601，来自服务端。 */
  expiresAt: string;
  userId: string;
  username: string;
  displayName: string;
  role: string;
  timezone: string;
}

let cached: StoredSession | null = null;
let loaded = false;

function isSession(value: unknown): value is StoredSession {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.baseUrl === 'string' &&
    typeof candidate.token === 'string' &&
    typeof candidate.expiresAt === 'string' &&
    typeof candidate.userId === 'string'
  );
}

/** 读一次到内存；后续 `getSession()` 不再碰 Keychain。 */
export async function loadSession(): Promise<StoredSession | null> {
  if (loaded) return cached;
  try {
    const raw = await SecureStore.getItemAsync(KEY, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (raw !== null && raw !== '') {
      const parsed: unknown = JSON.parse(raw);
      cached = isSession(parsed) ? parsed : null;
    }
  } catch {
    cached = null;
  }
  loaded = true;
  return cached;
}

export function getSession(): StoredSession | null {
  return cached;
}

export async function saveSession(session: StoredSession): Promise<void> {
  cached = session;
  loaded = true;
  await SecureStore.setItemAsync(KEY, JSON.stringify(session), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearSession(): Promise<void> {
  cached = null;
  loaded = true;
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    // 已经不存在也算清干净了。
  }
}

/** 仍然有效的 token；已过期返回 null（没有 refresh token 可以救）。 */
export function getFreshToken(now: number = Date.now()): string | null {
  if (cached === null) return null;
  const expires = Date.parse(cached.expiresAt);
  if (Number.isNaN(expires)) return cached.token;
  return expires > now ? cached.token : null;
}

/**
 * 是否该静默续期：过期时间在 `windowMs` 之内。
 * 服务端签发 168h，所以在还剩 84h（一半）的时候续，给足冗余。
 */
export function shouldRefresh(windowMs = 84 * 60 * 60 * 1000, now: number = Date.now()): boolean {
  if (cached === null) return false;
  const expires = Date.parse(cached.expiresAt);
  if (Number.isNaN(expires)) return false;
  return expires - now < windowMs;
}
