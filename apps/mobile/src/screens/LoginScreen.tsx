/**
 * 登录页。
 *
 * ## 这一版重排了什么
 *
 * 信息层级对齐 Cloud 登录页（web/desktop）：品牌 → 标题「登录或注册」→ Cloud 的
 * 三种入口（GitHub / Google / 邮箱）→ 自部署入口。以前整屏只有
 * 服务器 + 用户名 + 密码，等于把"自部署"当成了唯一入口——但第一次打开 App 的人
 * 先问的往往是"有没有官方服务"，这屏要同时回答两个问题。
 *
 * ## Cloud 三个入口是**诚实的占位**，不是假按钮
 *
 * Cloud 的账号鉴权在另一个控制面（`memoh-ios-dev.md` §4.7）：当前 Web 客户端走
 * `/api/v1` 的 email code / OAuth / MFA + secure cookie，移动端要用
 * `ASWebAuthenticationSession` + PKCE 的一次性 code 合同——**服务端合同还没落地**。
 * 在那之前这三个入口遵守三条：
 *
 * 1. **不发任何网络请求**（按下只改本地 state，不 import client / fetch）；
 * 2. **不收集凭据**（邮箱那一格只做本地格式校验，值不出这台手机）；
 * 3. **占位必须诚实**：按下后出现本地化的"Cloud 登录尚未开放，当前不会发送信息"，
 *    并走 `announceForAccessibility` 播报——不是装死，也不是跳 WebView。
 *
 * ## 自部署入口在 Cloud 下方，单独标出
 *
 * 「Self-hosted / 自部署」单独一组，点开才进入原来的 服务器 + 用户名 + 密码 流程。
 * 那套流程的安全性质原样保留：`discoverMemohServer` 先于口令发送、探测命中的
 * base URL 与 JWT 进 Keychain、错误分档（地址错 / 不是 Memoh / 连不上 / 密码错）、
 * 发布构建默认 `https://memoh.yetodawn.com`（见下面 `DEFAULT_SERVER`）。
 *
 * 例外：`AuthGateScreen` 传来 `noticeKey`（如"登录过期了"）时，说明这个用户**本来就
 * 登在自部署服务器上**，直接落自部署那一半——把他先带去 Cloud 入口是答非所问。
 *
 * ## 自部署这一半的错误分档
 *
 * 登录页是**唯一**一个 401 含义与别处相反的地方：在 App 里 401 = "登录过期了"，而在这里
 * 401 = "用户名或密码不对"。所以这一屏**自己**决定 401 的文案，不走 `error.unauthorized`。
 *
 * 另外两处按 HIG 改的地方：
 *
 * - **不把服务端原文打到屏幕上**。失败时走 `features/errors/present.ts`：只有服务端给了
 *   类型化错误码、且那条 message 是写给人看的，才原样带出来当补充说明。
 * - **缺用户名/缺密码**不是笼统的"登录失败"：那是**校验**不是**登录被拒**，
 *   对应到具体那一个空着的框。
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, MemohClient } from '../api/client.ts';
import { getFreshToken, saveSession } from '../api/credentials.ts';
import { canContinueWithEmail, shouldShowEmailError } from '../features/auth/cloud.ts';
import {
  discoverMemohServer,
  hostOf,
  normalizeServer,
  serverProblemOf,
} from '../features/auth/server.ts';
import { presentError } from '../features/errors/present.ts';
import { useAnnounceOnAppear } from '../lib/accessibility.ts';
import { useT } from '../lib/i18n/useT.ts';
import { PRESS_OPACITY, radiusStyle } from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';
import type { SessionSeed } from '../features/session/store.tsx';

/**
 * 登录框的默认地址。
 *
 * 分两套，因为两种构建面对的"服务器"根本不是同一个：
 *
 * - **开发构建**（模拟器）：默认本地隧道 `http://127.0.0.1:18080`。模拟器跑在同一台
 *   Mac 上，隧道就是它够得到 dev 栈的唯一方式。
 * - **发布构建**（真机 / TestFlight）：默认 dev 栈的公网入口。真机够不着隧道，
 *   而默认填 `127.0.0.1` 会让第一次打开 App 的人必然连不上——那看起来像 App 坏了，
 *   实际上不是。填一个有 TLS 的真地址，装上去就能直接用。
 *
 * 仍然是"用户可以改的默认值"。Memoh 是自托管产品，谁都能填自己的服务器；这里
 * 给的只是"我们那台能被公众访问的 dev 环境"，好让内测的人不用先拿到一台服务器。
 */
/** 屏幕上那一次失败。`reasonKey` 只在"原因本身就是信息"时才有（见错误呈现规则 R23/R25）。 */
interface LoginError {
  key: string;
  reasonKey?: string;
}

/** 这一屏的两半：Cloud 官方入口（默认）与自部署流程。 */
type LoginMode = 'cloud' | 'selfHosted';

const DEV_SERVER = 'http://127.0.0.1:18080';
const PUBLIC_SERVER = 'https://memoh.yetodawn.com';
const DEFAULT_SERVER = __DEV__ ? DEV_SERVER : PUBLIC_SERVER;

export function LoginScreen({
  onSignedIn,
  noticeKey,
}: {
  onSignedIn: (seed: SessionSeed) => void;
  /**
   来自 `AuthGateScreen` 的、**已经发生过的**一件事（如"登录过期了"）的 i18n key。
   传 key 而不是译文：这一屏要的是"这一句和刚发生的事一起被读屏念出来"，
   而不是一个已经拼好的字符串（拼好了就没法再走一次本屏的文案规则）。
   */
  noticeKey?: string;
}) {
  const palette = usePalette();
  const { spacing, radius, typography } = useTheme();
  const insets = useSafeAreaInsets();
  const t = useT();

  /* 有 noticeKey 说明用户原本就登在自部署服务器上（会话过期之类），直接落自部署
     那一半；否则默认 Cloud 入口（见文件头）。 */
  const [mode, setMode] = useState<LoginMode>(noticeKey === undefined ? 'cloud' : 'selfHosted');

  // ---- Cloud 占位区：只改本地 state，不发请求、不收集凭据（见文件头三条）。 ----
  const [email, setEmail] = useState('');
  /** 三个占位入口共用的"尚未开放"反馈。出现后不自动消失（错误/反馈不做 time-boxed）。 */
  const [cloudNotice, setCloudNotice] = useState(false);
  const emailCanContinue = canContinueWithEmail(email);
  const showEmailError = shouldShowEmailError(email);
  useAnnounceOnAppear(cloudNotice ? t('login.cloud.unavailable') : null);
  useAnnounceOnAppear(showEmailError ? t('login.cloud.email.invalid') : null);
  const showCloudNotice = useCallback(() => setCloudNotice(true), []);

  // ---- 自部署流程（原有逻辑，安全顺序原样保留）。 ----
  const [server, setServer] = useState(DEFAULT_SERVER);
  /** 服务器地址默认折起（见文件头注释）。出错时**自动展开**，好让用户能就地改。 */
  const [editingServer, setEditingServer] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   一次失败的分量：**标题（发生了什么）+ 补充说明（为什么，可选）**。
   形状照 Apple 的错误对象（`localizedDescription` + `localizedRecoverySuggestion`）。
   这里没有动作按钮——登录页的动作就是那个 Sign in 按钮本身，再挂一个"重试"
   只是把同一个动作说两遍。
   */
  const [error, setError] = useState<LoginError | null>(
    noticeKey === undefined ? null : { key: noticeKey },
  );
  useAnnounceOnAppear(error === null ? null : t(error.reasonKey ?? error.key));

  const submit = useCallback(async () => {
    if (busy) return;
    const normalized = normalizeServer(server);
    if (!normalized.ok) {
      // 地址不合法就别发请求：发出去只会得到一个"连不上"，而那句话会把用户引到错误的方向。
      setEditingServer(true);
      setError({
        key: normalized.problem === 'empty' ? 'login.server.empty' : 'login.server.invalid',
      });
      return;
    }
    // 缺哪一格说哪一格。笼统的"登录失败"对用户没有可操作的信息：他不知道要回去补什么。
    if (username.trim() === '') {
      setError({ key: 'login.username.required' });
      return;
    }
    if (password === '') {
      setError({ key: 'login.password.required' });
      return;
    }

    setBusy(true);
    setError(null);

    try {
      /* 先探明那台真是 Memoh，再把口令发出去——顺序不能反：地址写错时把用户名/密码
         POST 给一台陌生服务器，等于替它收集凭据。候选优先级（公网先试 /api、本机/内网
         先试裸根）在 features/auth/server.ts，登录成功存的是**探测命中的那个** base URL。 */
      const baseUrl = await discoverMemohServer(normalized.server);
      if (baseUrl === null) {
        setEditingServer(true);
        setError({ key: 'login.server.notMemoh' });
        return;
      }
      const client = new MemohClient({
        baseUrl,
        // 登录前还没有 token；登录成功后这个闭包换成读 Keychain。
        getToken: () => null,
      });
      const response = await client.login(username.trim(), password);

      await saveSession({
        baseUrl,
        token: response.access_token,
        expiresAt: response.expires_at,
        userId: response.user_id,
        username: response.username,
        displayName: response.display_name,
        role: response.role,
        timezone: response.timezone,
      });

      // 真正的 client 从凭据存储读 token，而不是闭包捕获一个快照——续期之后
      // 闭包里那个旧字符串会失效，而 `getFreshToken()` 永远是当前有效的那个。
      const authed = new MemohClient({ baseUrl, getToken: () => getFreshToken() });
      onSignedIn({ client: authed });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        /* ⚠️ 这一档是登录页专有的：**401 在这里不是"登录过期"，是"用户名或密码不对"**。
           走通用映射会说成"登录已过期，请重新登录"——用户刚打开 App，看到这句只会困惑。 */
        setError({ key: 'login.invalidCredentials' });
      } else if (caught instanceof ApiError && (caught.isNetwork || caught.code === 'timeout')) {
        // 连不上（地址写错、主机没起、网断）。下一句是"检查那个地址"，所以地址栏也展开。
        setEditingServer(true);
        setError({ key: 'login.unreachable' });
      } else {
        // 其余（5xx、协议不对、意外）：**不带服务端原文**，只按性质说一句通用的。
        // 原文是给开发者看的，倒给用户既没用又会把人引到错误的排查方向。
        setError({ key: presentError(caught).key });
      }
    } finally {
      setBusy(false);
    }
  }, [busy, onSignedIn, password, server, username]);

  // 地址格式不对时按钮就不该亮——让用户按下去再报错是多余的一步。
  const canSubmit =
    serverProblemOf(server) === null && username.trim() !== '' && password !== '' && !busy;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          paddingHorizontal: spacing.lg,
          paddingTop: insets.top + spacing.xl,
          paddingBottom: insets.bottom + spacing.xl,
        }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >
        {/* 品牌标记：Memoh 的水母 logo。
            和桌面端登录页一样用**裸 logo**（它在 Web 上就是 size-14 直接放的，
            没有底色方块），所以这里也不加背景色——加了会变成一个"图标按钮"，
            而它不是可点的。 */}
        <Image
          source={require('../../assets/images/brand-mark.png')}
          style={{ width: 64, height: 64, alignSelf: 'center', marginBottom: spacing.xxl }}
          contentFit="contain"
          accessibilityIgnoresInvertColors
        />

        <Text
          style={[
            typography.title1,
            { color: palette.label, textAlign: 'center', marginBottom: spacing.sm },
          ]}
        >
          {mode === 'cloud' ? t('login.title') : t('login.selfhosted.title')}
        </Text>
        <Text
          style={[
            typography.subhead,
            { color: palette.secondaryLabel, textAlign: 'center', marginBottom: spacing.xxl },
          ]}
        >
          {mode === 'cloud' ? t('login.subtitle') : t('login.selfhosted.subtitle')}
        </Text>

        {mode === 'cloud' ? (
          <View>
            {/* Cloud 官方入口：三个都是诚实占位（见文件头三条）。
                按钮形态对齐 Cloud 登录页：白底卡片、品牌图标 + 全称。 */}
            <CloudButton
              testID="login-cloud-github"
              label={t('login.cloud.github')}
              icon={require('../../assets/images/github-mark.png')}
              onPress={showCloudNotice}
            />
            <CloudButton
              testID="login-cloud-google"
              label={t('login.cloud.google')}
              icon={require('../../assets/images/google-mark-color.png')}
              preserveIconColor
              onPress={showCloudNotice}
            />

            {/* 分隔「或」：两条发丝线夹一个词，与 Cloud 登录页同一语言。 */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.md,
                marginVertical: spacing.lg,
              }}
            >
              <View style={[styles.hairline, { backgroundColor: palette.separator }]} />
              <Text style={[typography.footnote, { color: palette.tertiaryLabel }]}>
                {t('login.cloud.divider')}
              </Text>
              <View style={[styles.hairline, { backgroundColor: palette.separator }]} />
            </View>

            <TextInput
              testID="login-cloud-email-input"
              value={email}
              onChangeText={setEmail}
              placeholder={t('login.cloud.email.placeholder')}
              placeholderTextColor={palette.placeholder}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="emailAddress"
              style={[
                typography.body,
                {
                  color: palette.label,
                  backgroundColor: palette.card,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: palette.separator,
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.sm,
                  minHeight: 48,
                  ...radiusStyle(radius.md),
                },
              ]}
            />

            {/*
              邮箱格式反馈：只有**填过且不对**才出现（空着不报错——用户可能还没填到这一格）。
              与自部署的错误一样走播报，不用空转的 accessibilityLiveRegion。
            */}
            {showEmailError ? (
              <Text
                testID="login-cloud-email-error"
                style={[typography.footnote, { color: palette.destructive, marginTop: spacing.xs }]}
              >
                {t('login.cloud.email.invalid')}
              </Text>
            ) : null}

            <Pressable
              testID="login-cloud-email-continue"
              accessibilityRole="button"
              accessibilityState={{ disabled: !emailCanContinue }}
              disabled={!emailCanContinue}
              onPress={showCloudNotice}
              style={({ pressed }) => [
                styles.blockButton,
                {
                  backgroundColor: emailCanContinue ? palette.accent : palette.field,
                  marginTop: spacing.md,
                  opacity: pressed ? PRESS_OPACITY.button : 1,
                  ...radiusStyle(radius.md),
                },
              ]}
            >
              <Text
                style={[
                  typography.headline,
                  {
                    color: emailCanContinue ? palette.onAccent : palette.tertiaryLabel,
                  },
                ]}
              >
                {t('login.cloud.email.continue')}
              </Text>
            </Pressable>

            {/* 占位反馈：诚实地说"还没开放"，出现后不自动消失，且会被播报。 */}
            {cloudNotice ? (
              <View
                testID="login-cloud-notice"
                accessible
                accessibilityLabel={t('login.cloud.unavailable')}
                style={{ marginTop: spacing.md }}
              >
                <Text style={[typography.footnote, { color: palette.secondaryLabel }]}>
                  {t('login.cloud.unavailable')}
                </Text>
              </View>
            ) : null}

            {/* 自部署：单独一组、单独标出，点开才进入服务器 + 用户名 + 密码。 */}
            <Text
              style={[
                typography.footnote,
                {
                  color: palette.secondaryLabel,
                  marginTop: spacing.xxl,
                  marginBottom: spacing.xs,
                  marginHorizontal: spacing.sm,
                },
              ]}
            >
              {t('login.selfhosted.section')}
            </Text>
            <Pressable
              testID="login-selfhosted-toggle"
              accessibilityRole="button"
              onPress={() => setMode('selfHosted')}
              style={({ pressed }) => [
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  minHeight: 48,
                  paddingHorizontal: spacing.lg,
                  backgroundColor: pressed ? palette.field : palette.card,
                  ...radiusStyle(radius.md),
                },
              ]}
            >
              <Text style={[typography.body, { color: palette.label, flex: 1 }]}>
                {t('login.selfhosted.enter')}
              </Text>
              <SymbolView
                name="chevron.right"
                size={14}
                tintColor={palette.tertiaryLabel}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              />
            </Pressable>
          </View>
        ) : (
          <View>
            {/* 返回 Cloud 入口：行内小控件，44pt 触控目标。 */}
            <Pressable
              testID="login-selfhosted-back"
              accessibilityRole="button"
              onPress={() => setMode('cloud')}
              style={({ pressed }) => [
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.xs,
                  alignSelf: 'flex-start',
                  minHeight: 44,
                  paddingRight: spacing.md,
                  marginBottom: spacing.sm,
                  opacity: pressed ? PRESS_OPACITY.control : 1,
                },
              ]}
            >
              <SymbolView
                name="chevron.backward"
                size={16}
                tintColor={palette.accent}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              />
              <Text style={[typography.body, { color: palette.accent }]}>{t('common.back')}</Text>
            </Pressable>

            <View
              style={{
                backgroundColor: palette.card,
                overflow: 'hidden',
                ...radiusStyle(radius.md),
              }}
            >
              <FormRow
                label={t('login.username')}
                // testID 是给自动化用的：这两格没有可见标识，按坐标点会随键盘高度与机型
                // 漂移，而端到端旅程必须能**确定地**把字打进去。
                testID="login-username-input"
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="username"
              />
              <FormRow
                label={t('login.password')}
                testID="login-password-input"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                textContentType="password"
                onSubmitEditing={() => void submit()}
                returnKeyType="go"
                last
              />
            </View>

            {/* 服务器地址：折起来是一行"服务器 · 主机:端口  更改"，点开才是输入框。
                它不是每次登录都要碰的东西，所以不占主卡片的位置。 */}
            <View style={{ marginTop: spacing.lg }}>
              <Pressable
                testID="login-server-toggle"
                accessibilityRole="button"
                accessibilityState={{ expanded: editingServer }}
                onPress={() => setEditingServer((previous) => !previous)}
                style={({ pressed }) => [
                  {
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.sm,
                    minHeight: 44,
                    paddingHorizontal: spacing.sm,
                    opacity: pressed ? PRESS_OPACITY.control : 1,
                  },
                ]}
              >
                <Text style={[typography.footnote, { color: palette.secondaryLabel }]}>
                  {t('login.server')}
                </Text>
                <Text
                  style={[typography.footnote, { color: palette.label, flexShrink: 1 }]}
                  numberOfLines={1}
                >
                  {hostOf(server)}
                </Text>
                <Text style={[typography.footnote, { color: palette.accent }]}>
                  {editingServer ? t('common.done') : t('login.server.change')}
                </Text>
              </Pressable>

              {editingServer ? (
                <View
                  style={{
                    backgroundColor: palette.card,
                    overflow: 'hidden',
                    ...radiusStyle(radius.md),
                  }}
                >
                  <FormRow
                    testID="login-server-input"
                    label={t('login.server')}
                    value={server}
                    onChangeText={setServer}
                    placeholder={t('login.server.placeholder')}
                    keyboardType="url"
                    autoCapitalize="none"
                    autoCorrect={false}
                    textContentType="URL"
                    last
                  />
                </View>
              ) : null}

              {/*
                常驻说明：这两样东西（地址、账号）**不是这个 App 自己长出来的**——
                第一次用的人卡在登录页时，屏幕上要有个地方能回答"我该填什么"。
                放在折起那一行的下面：用户真正需要它的时刻就是**看着这两个输入框**的时候。
              */}
              <Text
                style={[
                  typography.footnote,
                  {
                    color: palette.secondaryLabel,
                    marginTop: spacing.xs,
                    marginHorizontal: spacing.sm,
                  },
                ]}
              >
                {t('login.server.hint')}
              </Text>
            </View>

            {/*
              ⚠️ 这里以前写的是 `accessibilityLiveRegion="polite"`。**它在 iOS 上是空转的**，
              所以"登录失败"对读屏用户从来没有出现过。现在走 `useAnnounceOnAppear` + 系统的
              `AccessibilityInfo.announceForAccessibility`。见 `lib/accessibility.ts` 的说明。
            */}
            {error === null ? null : (
              <View
                testID="login-error"
                accessible
                accessibilityLabel={t(error.key)}
                style={{ marginTop: spacing.md, minHeight: 20 }}
              >
                <Text style={[typography.footnote, { color: palette.destructive }]}>
                  {t(error.key)}
                </Text>
                {error.reasonKey === undefined ? null : (
                  <Text style={[typography.caption, { color: palette.secondaryLabel }]}>
                    {t(error.reasonKey)}
                  </Text>
                )}
              </View>
            )}

            <Pressable
              testID="login-submit"
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSubmit, busy }}
              accessibilityLabel={busy ? t('login.submitting') : t('login.submit')}
              disabled={!canSubmit}
              onPress={() => void submit()}
              style={({ pressed }) => [
                styles.blockButton,
                {
                  backgroundColor: canSubmit ? palette.accent : palette.field,
                  marginTop: spacing.xxl,
                  opacity: pressed ? PRESS_OPACITY.button : 1,
                  ...radiusStyle(radius.pill),
                },
              ]}
            >
              {busy ? (
                <ActivityIndicator color={palette.onAccent} />
              ) : (
                <Text
                  style={[
                    typography.headline,
                    { color: canSubmit ? palette.onAccent : palette.tertiaryLabel },
                  ]}
                >
                  {t('login.submit')}
                </Text>
              )}
            </Pressable>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * Cloud 占位入口的按钮（GitHub / Google）。
 *
 * 形态对齐 Cloud 登录页：白底卡片、发丝描边、品牌图标 + 全称。GitHub 的单色资源跟随
 * label 语义色；Google 保留官方四色标记，不能为了暗色模式把品牌图标染成单色。图标本身
 * 是装饰，按钮的无障碍标签就是那句全称。
 */
function CloudButton({
  testID,
  label,
  icon,
  preserveIconColor = false,
  onPress,
}: {
  testID: string;
  label: string;
  icon: number;
  preserveIconColor?: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();
  const { spacing, radius, typography } = useTheme();

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: spacing.sm,
          minHeight: 48,
          marginBottom: spacing.md,
          backgroundColor: palette.card,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: palette.separator,
          opacity: pressed ? PRESS_OPACITY.button : 1,
          ...radiusStyle(radius.md),
        },
      ]}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ width: 20, height: 20 }}
      >
        <Image
          source={icon}
          style={{ width: 20, height: 20 }}
          tintColor={preserveIconColor ? undefined : palette.label}
          contentFit="contain"
        />
      </View>
      <Text style={[typography.headline, { color: palette.label }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * 分组表单行（系统「设置」的形态）。
 *
 * 原生做法是：一张 inset 圆角卡片，行内左侧标签、右侧输入，行高 44pt（系统最小
 * 触控目标），行间 0.5pt 发丝线且左缩进对齐文字起点。
 */
function FormRow({
  label,
  last,
  testID,
  ...inputProps
}: { label: string; last?: boolean; testID?: string } & React.ComponentProps<typeof TextInput>) {
  const palette = usePalette();
  const { spacing, typography } = useTheme();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 44,
        paddingHorizontal: spacing.lg,
        borderBottomWidth: last === true ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: palette.separator,
      }}
    >
      <Text style={[typography.body, { color: palette.label, width: 88 }]} numberOfLines={1}>
        {label}
      </Text>
      <TextInput
        testID={testID}
        {...inputProps}
        placeholderTextColor={palette.placeholder}
        style={[
          typography.body,
          {
            color: palette.label,
            flex: 1,
            paddingVertical: spacing.sm,
            minHeight: 44,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  blockButton: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hairline: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
});
