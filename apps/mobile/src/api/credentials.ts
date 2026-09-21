/**
 * Temporary JS projection of the native iOS session.
 *
 * Swift owns the `memoh.session.v1` Keychain item. RN keeps only an in-memory copy because the
 * existing API and WebSocket clients need synchronous token reads until the final app-shell pass.
 */
import { nativeAuth } from '@memoh-ios/kit';

export interface StoredSession {
  baseUrl: string;
  token: string;
  /** ISO8601 from the server. */
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
    candidate.baseUrl !== '' &&
    typeof candidate.token === 'string' &&
    candidate.token !== '' &&
    typeof candidate.expiresAt === 'string' &&
    candidate.expiresAt !== '' &&
    typeof candidate.userId === 'string' &&
    candidate.userId !== '' &&
    typeof candidate.username === 'string' &&
    candidate.username !== '' &&
    typeof candidate.displayName === 'string' &&
    typeof candidate.role === 'string' &&
    typeof candidate.timezone === 'string'
  );
}

function parseSession(raw: string | null | undefined): StoredSession | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Read native Keychain once; later synchronous reads use only the memory projection. */
export async function loadSession(): Promise<StoredSession | null> {
  if (loaded) return cached;
  try {
    const auth = nativeAuth();
    cached = auth === null ? null : parseSession(await auth.authLoadSession());
  } catch {
    cached = null;
  }
  loaded = true;
  return cached;
}

export function getSession(): StoredSession | null {
  return cached;
}

/** Used by authenticated refresh; native code validates the same complete session shape again. */
export async function saveSession(session: StoredSession): Promise<void> {
  cached = session;
  loaded = true;
  const auth = nativeAuth();
  if (auth === null) throw new Error('Native authentication module is unavailable');
  await auth.authSaveSession(JSON.stringify(session));
}

/** Adopt the already-persisted native login result without writing the Keychain twice. */
export function adoptNativeSession(raw: string | undefined): StoredSession | null {
  const session = parseSession(raw);
  if (session === null) return null;
  cached = session;
  loaded = true;
  return session;
}

export async function clearSession(): Promise<void> {
  cached = null;
  loaded = true;
  try {
    await nativeAuth()?.authClearSession();
  } catch {
    // The in-memory credential is gone, so the auth gate must still return to signed out.
  }
}

/** A token that is still valid; expired credentials cannot be refreshed without a refresh token. */
export function getFreshToken(now: number = Date.now()): string | null {
  if (cached === null) return null;
  const expires = Date.parse(cached.expiresAt);
  if (Number.isNaN(expires)) return cached.token;
  return expires > now ? cached.token : null;
}

/** Refresh once the remaining lifetime enters the default half-life window (84 hours). */
export function shouldRefresh(windowMs = 84 * 60 * 60 * 1000, now: number = Date.now()): boolean {
  if (cached === null) return false;
  const expires = Date.parse(cached.expiresAt);
  if (Number.isNaN(expires)) return false;
  return expires - now < windowMs;
}
