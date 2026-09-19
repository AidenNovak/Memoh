/**
 * 登录页。
 *
 * ## 这一版重排了什么
 *
 * 上一版把**服务器地址**和用户名、密码并排放在同一张卡片里、三行等权重。实际上这三样
 * 不是一回事：用户名和密码是每次登录都要打的，服务器地址是**装完一次就不该再碰**的。
 * 混在一起就有两个后果——用户会以为每次都得填一个地址；而且一行"地址错"的错误看起来
 * 和"密码错"一样近，于是他去反复重输密码。
 *
 * 所以：主卡片只留用户名 + 密码；服务器地址收到下面的**一行摘要**（`host:port`），
 * 点"更改"才展开成输入框。摘要里保留端口——自托管的人常同时跑几个实例，
 * 抹掉端口这行就没意义了。
 *
 * 错误也补了一档：**地址格式不对**（漏 `http://`、粘进空格）和**连不上**（网断、主机没起）
 * 是两件不同的事，以前都报"连不上"，用户就没有下一步动作可做。判断在
 * `features/auth/server.ts`（能直测）。
 *
 * ## 这一屏的错误分档（`docs/research/ios-error-and-feedback.md`）
 *
 * 登录页是**唯一**一个 401 含义与别处相反的地方：在 App 里 401 = "登录过期了"，而在这里
 * 401 = "用户名或密码不对"。所以这一屏**自己**决定 401 的文案，不走 `error.unauthorized`。
 *
 * 另外两处按 HIG 改的地方：
 *
 * - **不再把服务端原文打到屏幕上**。以前失败时走的是 `caught.message`，那是给开发者看的
 *   （"HTTP 502"、网关的 HTML 片段）。现在走 `features/errors/present.ts`：只有服务端给了
 *   类型化错误码、且那条 message 是写给人看的，才原样带出来当补充说明。
 * - **缺用户名/缺密码**不再是笼统的"登录失败"：那是**校验**不是**登录被拒**，
 *   对应到具体那一个空着的框，说法也不同（HIG Writing："给正例，别说教"）。
 *
 * ## 为什么这里**没有** Google 登录按钮
 *
 * 桌面端和 iOS 今天都只有用户名 + 密码，因为**服务端就没有第三方登录**：线上实例的
 * swagger 里 `/auth/*` 只有 `login` 与 `refresh` 两条；那些带 oauth 的路径（providers、
 * connectors、mcp、email 底下）是给模型供应商和邮箱用的，跟账号无关。
 * 客户端加一个按钮只会得到一个必然失败的按钮。
 * 要做得先改服务端（fork `AidenNovak/Memoh`）：验 Google ID token → 换发本服务 JWT ——
 * 而且一旦第三方成为主账号入口，App Store 4.8 还会要求等价的另一种登录方式（Sign in with
 * Apple），所以那是"两份服务端工作"，不是一个客户端的活。
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, MemohClient } from '../api/client.ts';
import { getFreshToken, saveSession } from '../api/credentials.ts';
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

  const [server, setServer] = useState(DEFAULT_SERVER);
  /** 服务器地址默认折起（见文件头注释）。出错时**自动展开**，好让用户能就地改。 */
  const [editingServer, setEditingServer] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   一次失败的分量：**标题（发生了什么）+ 补充说明（为什么，可选）**。
   形状照 Apple 的错误对象（`localizedDescription` + `localizedRecoverySuggestion`），
   见 `docs/research/ios-error-and-feedback.md` R13/R14。这里没有动作按钮——登录页的动作
   就是那个 Sign in 按钮本身，再挂一个"重试"只是把同一个动作说两遍。
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
            typography.largeTitle,
            { color: palette.label, textAlign: 'center', marginBottom: spacing.sm },
          ]}
        >
          {t('login.title')}
        </Text>
        <Text
          style={[
            typography.subhead,
            { color: palette.secondaryLabel, textAlign: 'center', marginBottom: spacing.xxl },
          ]}
        >
          {t('login.subtitle')}
        </Text>

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
            // 漂移，而端到端旅程必须能**确定地**把字打进去（见 verification/e2e）。
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
            常驻说明：这两样东西（地址、账号）**不是这个 App 自己长出来的**，而上一版
            全屏 16 条 `login.*` 文案里没有一条说它们从哪来——第一次用的人卡在登录页时，
            屏幕上没有任何地方能回答"我该填什么"。

            放在折起那一行的下面（而不是塞进引导页）：用户真正需要它的时刻就是**看着
            这两个输入框**的时候。只讲事实与出处（谁给、去哪儿看），不讲道理。
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
          ⚠️ 这里以前写的是 `accessibilityLiveRegion="polite"`。**它在 iOS 上是空转的**
          （RN 的类型定义写着 `@platform android`，iOS 侧实现没有消费者），所以"登录失败"
          对读屏用户从来没有出现过。现在走 `useAnnounceOnAppear` + 系统的
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
            styles.submit,
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
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * 分组表单行（系统「设置」的形态）。
 *
 * 之前用"全大写小标签悬浮在输入框上方"是 Web/Material 的模式，在 iOS 上会显得
 * 不是原生——而且实测那个布局的**组内距（12pt）比组间距（11pt）还大**，眼睛会把
 * 标签归到上一个框，读起来是乱的。
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
  submit: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
