/**
 * App 根布局。
 *
 * 职责只有三件：主题、i18n、以及决定"登录还是不登录"。
 * 会话状态（bots / sessions / chats）由 `SessionProvider` 承载，但它需要凭据，
 * 所以放在 `AuthGateScreen`（登录闸门）里面按需挂载。
 */
import { DarkTheme, DefaultTheme, Stack, ThemeProvider as NavThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthGateScreen } from '../screens/AuthGateScreen.tsx';
import { NotificationCategoryRegistrar } from '../features/notifications/NotificationCategoryRegistrar.tsx';
import { NotificationOpenHandler } from '../features/notifications/NotificationOpenHandler.tsx';
import { SessionProvider } from '../features/session/store.tsx';
import { ScenePlanWatcher, VerifyPlanRunner } from '../features/verify/VerifyPlanRunner.tsx';
import { useLocale } from '../lib/i18n/useLocale.ts';
import { useT } from '../lib/i18n/useT.ts';
import { ThemeProvider, useTheme } from '../lib/theme/context.tsx';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <ThemedRoot />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function ThemedRoot() {
  const { palette, scheme } = useTheme();
  const t = useT();
  // 订阅语言变化：切换语言时整棵树重渲染。
  useLocale();

  // 把自己的调色板接到 React Navigation 上，避免两套主题打架。
  const navTheme = useMemo(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        background: palette.groupedBackground,
        card: palette.card,
        text: palette.label,
        border: palette.separator,
        primary: palette.accent,
      },
    };
  }, [palette, scheme]);

  return (
    <NavThemeProvider value={navTheme}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {/*
        通知分类在任何一次启动里都要注册一次，**不能等登录**：分类要在推送**投递那一刻**
        就匹配上，否则那条通知没有"允许/拒绝"按钮，事后再注册也补不回来
        （见 NotificationCategoryRegistrar 的头注释）。
      */}
      <NotificationCategoryRegistrar />
      <AuthGateScreen>
        {(seed, verify) => (
          <View style={{ flex: 1, backgroundColor: palette.groupedBackground }}>
            <SessionProvider seed={seed}>
              <VerifyPlanRunner verify={verify} />
              <ScenePlanWatcher verify={verify} />
              {/*
                推送的宿主：深链、审批动作、徽标。挂在 SessionProvider 里面是因为
                "点通知要打开哪个会话、点了允许要回应哪次审批"只有 store 知道；
                它不渲染任何东西（见 NotificationOpenHandler）。
              */}
              <NotificationOpenHandler />
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: palette.groupedBackground },
                }}
              >
                {/*
                  出席会话的宿主路由。

                  **为什么形态声明在这里而不是页面里**：`presentation` 是原生栈在 push
                  那一刻读的——在路由组件内部用 `<Stack.Screen>` 或 `setOptions()` 设置
                  都太晚，结果就是"以为开了 sheet，其实是一张全屏卡片"（实测踩过：内容
                  画到状态栏底下、没有抓手、没有圆角边距）。
                  页面自己仍然可以覆盖 detent / 抓手 / 能不能侧滑——那些是挂载后生效的。
                */}
                <Stack.Screen
                  name="presented/[presentationId]"
                  options={{
                    headerShown: false,
                    presentation: 'formSheet',
                    contentStyle: { backgroundColor: palette.background },
                  }}
                />
                {/*
                  `(tabs)` 这一屏**必须有一个 title**，哪怕它自己没有导航栏。

                  原生返回按钮的文案取的是**上一屏的 title**，而 expo-router /
                  react-navigation 在没给 title 时会回退到**路由名**——用户看到的就是
                  `‹ (tabs)`（2026-09-17 实测：会话页点进文件子目录、以及 bot 设置页，
                  返回键都写着这个内部名）。这不是某一屏写错了，是根栈没给这一屏起名。

                  用 tab 自己的名字（与底部标签同一个键 `home.title`），不另开文案：
                  同一个词在两处出现时，分成两个键迟早会在改文案时漏掉一处。
                */}
                <Stack.Screen name="(tabs)" options={{ title: t('home.title') }} />
              </Stack>
            </SessionProvider>
          </View>
        )}
      </AuthGateScreen>
    </NavThemeProvider>
  );
}
