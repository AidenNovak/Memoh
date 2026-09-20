import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export interface NativeAuth {
  authLoadSession(): Promise<string | null>;
  authSaveSession(json: string): Promise<void>;
  authClearSession(): Promise<void>;
}

const REQUIRED_METHODS: readonly (keyof NativeAuth)[] = [
  'authLoadSession',
  'authSaveSession',
  'authClearSession',
];

function isAuthCapable(module: unknown): module is NativeAuth {
  if (typeof module !== 'object' || module === null) return false;
  const candidate = module as Record<string, unknown>;
  return REQUIRED_METHODS.every((name) => typeof candidate[name] === 'function');
}

let resolved = false;
let facade: NativeAuth | null = null;

/** Optional only so an older dev client can show the explicit rebuild notice instead of crashing. */
export function nativeAuth(): NativeAuth | null {
  if (resolved) return facade;
  resolved = true;
  if (Platform.OS !== 'ios') return null;
  try {
    const module = requireOptionalNativeModule<unknown>('MemohKit');
    if (isAuthCapable(module)) facade = module;
  } catch {
    facade = null;
  }
  return facade;
}
