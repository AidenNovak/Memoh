/**
 * 主题上下文。
 *
 * 主题模式（system/light/dark/oled）是用户设置，要持久化；但**不需要**进
 * Keychain——它不是秘密。用内存 + AsyncStorage 级别的持久化即可。
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';

import type { AppearanceMode, Palette, SystemScheme } from './index';
import { paletteFor, radius, resolvedScheme, spacing, typography } from './index';

interface ThemeValue {
  mode: AppearanceMode;
  scheme: 'light' | 'dark';
  palette: Palette;
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
  setMode: (mode: AppearanceMode) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({
  children,
  initialMode = 'system',
}: {
  children: React.ReactNode;
  initialMode?: AppearanceMode;
}) {
  const systemScheme = useColorScheme();
  // RN 的 ColorSchemeName 含 'unspecified'；主题只认三态，其余当"跟随系统但未知"。
  const scheme: SystemScheme =
    systemScheme === 'light' || systemScheme === 'dark' ? systemScheme : null;
  const [mode, setMode] = useState<AppearanceMode>(initialMode);

  const value = useMemo<ThemeValue>(
    () => ({
      mode,
      scheme: resolvedScheme(mode, scheme),
      palette: paletteFor(mode, scheme),
      spacing,
      radius,
      typography,
      setMode,
    }),
    [mode, scheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error('useTheme 必须在 ThemeProvider 内使用');
  }
  return value;
}

/** 只拿调色板。绝大多数组件只需要这个。 */
export function usePalette(): Palette {
  return useTheme().palette;
}

/** 供不需要 hook 的地方（例如常量表）使用。 */
export function useSetAppearance(): (mode: AppearanceMode) => void {
  const { setMode } = useTheme();
  return useCallback((mode: AppearanceMode) => setMode(mode), [setMode]);
}
