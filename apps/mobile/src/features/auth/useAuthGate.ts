/**
 * 登录闸门的**状态机**。
 *
 * 负责一件事：让"有没有凭据"变成"该渲染登录页还是渲染 App"。
 *
 * 服务端的鉴权模型很简单也很硬：`POST /auth/login` → HS256 JWT，默认 168h，
 * **没有 refresh token**，过期即重登。所以这里只需要在启动时读一次 Keychain，
 * 有未过期的 token 就直接进 App。
 *
 * 明确不做的：不做"离线也能进"的降级。没有凭据就是没有凭据，展示登录页比展示
 * 一个空壳更诚实。
 *
 * **这里只算状态，不渲染屏幕。** 屏幕由 `screens/AuthGateScreen.tsx` 渲；
 * `features` 不得 import `screens`（见 AGENTS.md 的分层），所以"渲染登录页"
 * 这句话必须由屏幕层来说。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { MemohClient } from '../../api/client.ts';
import {
  clearSession,
  loadSession,
  shouldRefresh,
  getFreshToken,
  saveSession,
} from '../../api/credentials.ts';
import { bootstrapFromVerifySeed, type VerifyBootstrap } from '../verify/bootstrap.ts';
import { hasSeenOnboarding, markOnboardingSeen } from '../onboarding/seen.ts';
import { shouldShowOnboarding } from '../onboarding/pages.ts';
import type { SessionSeed } from '../session/store.tsx';
import { createSessionLoss } from './sessionLoss.ts';

export type AuthPhase = 'checking' | 'signedOut' | 'signedIn';

export interface AuthGateState {
  phase: AuthPhase;
  /** 已登录时的凭据种子；`phase === 'signedIn'` 时必非 null。 */
  seed: SessionSeed | null;
  /**
   * 验收种子（只在开发构建里非 null）。外壳用它决定要不要自动跑一段脚本化动作。
   */
  verify: VerifyBootstrap | null;
  /**
   * 该不该给用户看首启引导。
   *
   * 排在登录页之前，且**只在一台机器上出现一次**：它是启动路径上的第一屏，
   * 不是每次启动都要过的关口。有凭据的人看完直接进主界面（这里不拦）。
   */
  showOnboarding: boolean;
  /** 登录页要念一次的一次性失败原因（i18n key）。 */
  noticeKey: string | undefined;
  onSignedIn: (seed: SessionSeed) => void;
  onOnboardingDone: () => void;
}

export function useAuthGate(): AuthGateState {
  const [phase, setPhase] = useState<AuthPhase>('checking');
  const [seed, setSeed] = useState<SessionSeed | null>(null);
  const [verify, setVerify] = useState<VerifyBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 首启引导是否还没看过。
   *
   * 和凭据一起在启动时读一次，但要求不同：它必须在**第一帧**之前就有结论——首屏
   * 不能先闪一下登录页再换成引导。`checking` 那屏（转圈）正好覆盖这次读取。
   *
   * 初值给 `true`（= 不显示引导）：读 Keychain 是异步的，这段时间阶段还停在
   * `checking`；给 `false` 只会在极端时序下让引导闪一下。真读不到时
   * `hasSeenOnboarding()` 返回 false，那时照样显示引导。
   */
  const [onboardingSeen, setOnboardingSeen] = useState(true);

  /**
   * 会话结束（401 或手动退出登录）的**唯一**处置：清凭据 → 回登录页
   * （见 `sessionLoss.ts`）。
   *
   * 为什么在这里：这个 hook 是唯一知道"该渲染登录页还是渲染 App"的地方，
   * `AuthGateScreen` 按 `phase` 决定挂不挂 `SessionProvider`——所以 `phase` 一变
   * `signedOut`，整个已登录的界面（含它持有的 client）就跟着卸载了。
   *
   * 之前这里只换界面（`setPhase`），没删 Keychain：账号被停用/删除时，token 按 `exp`
   * 还没过期，脏凭据会一直留在设备上，下次冷启动又直接进主界面。规则见 `AGENTS.md`。
   *
   * 手动退出（设置页那一行）走同一个出口，只是**不念原因**：那时候"登录已过期"是假话。
   * 以前它是另一条路（设置页自己清凭据 + 重置 store），闸门的 `phase` 不跟着切，
   * 于是退出之后落在空壳界面上而不是登录页。
   */
  const loss = useMemo(
    () =>
      createSessionLoss({
        clear: clearSession,
        onSignedOut: (reason) => {
          // 登录页要念一次原因（`LoginScreen` 的 `noticeKey`）：用户没做任何动作就被
          // 送回登录页，不说一句会以为是自己按错了。
          setError(reason === 'unauthorized' ? 'error.unauthorized' : null);
          setPhase('signedOut');
        },
      }),
    [],
  );

  /**
   * 交给 `SessionProvider` 的 client **一律**带上 401 处置。
   *
   * 为什么不是"在构造处顺手传一下"：client 有三个来源（启动时读 Keychain、登录页
   * 登录成功、验收种子），漏掉任何一个，那条路上的 401 就没人管——登录之后那个 client
   * 就是这么漏的。这里包一层，规则就只有一处：**进 App 的 client 都接同一套处置**。
   * token 来源保持原样（`client.token()` 就是它自己的 getter），不改变任何取 token 的行为。
   */
  const asSessionClient = useCallback(
    (client: MemohClient) =>
      new MemohClient({
        baseUrl: client.url,
        getToken: () => client.token(),
        onUnauthorized: loss.handle,
      }),
    [loss],
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // 验收种子优先：它只在开发构建里存在，且没有种子时立刻返回 null。
      const bootstrap = await bootstrapFromVerifySeed();
      if (cancelled) return;
      if (bootstrap !== null) {
        setVerify(bootstrap);
        setSeed({ client: asSessionClient(bootstrap.seed.client), endSession: loss.signOut });
        setPhase('signedIn');
        return;
      }

      // 有没有看过引导，与有没有凭据是两件事：没看过的人先看引导（不管有没有凭据，
      // 有凭据的话看完直接进主界面）。
      const seen = await hasSeenOnboarding();
      if (cancelled) return;
      setOnboardingSeen(seen);

      const stored = await loadSession();
      if (cancelled) return;
      if (stored === null || getFreshToken() === null) {
        setPhase('signedOut');
        return;
      }

      const client = asSessionClient(
        new MemohClient({ baseUrl: stored.baseUrl, getToken: () => getFreshToken() }),
      );

      // 还剩一半有效期就续一次；失败不影响进入（token 可能仍然可用）。
      if (shouldRefresh()) {
        try {
          const refreshed = await client.refresh();
          await saveSession({
            ...stored,
            token: refreshed.access_token,
            expiresAt: refreshed.expires_at,
          });
        } catch {
          // 续期失败但 token 未过期时照常进入；真过期了会在首个请求上 401。
          //
          // ⚠️ 只有 401 和"可恢复的失败"是两件事：401 时 `loss.handle` 已经把凭据清了、
          // 界面切回登录页了（下面那道 `hasFired` 会拦住"进主界面"）；断网/超时则什么都
          // 不做——那次续期没成功不代表凭据坏了，弱网下把人登出是最烦的一种假故障。
        }
      }

      // 401 已经发生（续期那一跳就是）：**不许**再把自己当成登录成功送进去，
      // 否则刚清掉的凭据又变回"登录着"，用户看到的是进得去、什么都打不开。
      if (cancelled || loss.hasFired()) return;
      setSeed({ client, endSession: loss.signOut });
      setPhase('signedIn');
    })();

    return () => {
      cancelled = true;
    };
  }, [asSessionClient, loss]);

  const onSignedIn = useCallback(
    (nextSeed: SessionSeed) => {
      // 登录页自己建的那个 client 没有 401 处置（它只管登录这一跳），这里补上同一套——
      // 否则登录成功后每次 401 又回到"没人管"的状态，正是本次要修的洞。
      //
      // 复位先做：上一次会话结束（退出登录/被 401 踢）已经让出口进入幂等状态，
      // 不复位的话这一次会话的 401 会被当成"处理过了"。
      loss.reset();
      setSeed({ client: asSessionClient(nextSeed.client), endSession: loss.signOut });
      setVerify(null);
      setError(null);
      setPhase('signedIn');
    },
    [asSessionClient, loss],
  );

  /**
   * 看过引导了。
   *
   * 记忆的写入不 await：按钮已经按下了，界面必须马上走（写 Keychain 失败只影响
   * "下次还要不要再看"，见 `features/onboarding/seen.ts`）。
   */
  const onOnboardingDone = useCallback(() => {
    setOnboardingSeen(true);
    void markOnboardingSeen();
  }, []);

  return {
    phase,
    seed,
    verify,
    showOnboarding: shouldShowOnboarding({ seen: onboardingSeen, hasVerifySeed: verify !== null }),
    noticeKey: error ?? undefined,
    onSignedIn,
    onOnboardingDone,
  };
}
