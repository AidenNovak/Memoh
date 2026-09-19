/**
 * 验收场景的执行器（仅开发构建）。
 *
 * 拿到启动种子之后，按脚本执行一段固定动作：登录 → 打开会话 → 发一条消息。
 * 每一步都走生产代码路径（`MemohClient` / `MemohRealtime` / reducer），
 * 只是把"手指点屏幕"换成了代码调用。
 *
 * 这个模块**不渲染任何东西**——它只做动作，渲染照旧由屏幕上那些真实组件负责。
 * 这样截图里出现的就是真正的产品界面，不是测试专用的替身。
 */
import type { MemohClient } from '../../api/client.ts';
import { createdSessionId } from '../../api/types.ts';
import { MemohClient as Client } from '../../api/client.ts';
import { saveSession } from '../../api/credentials.ts';
import type { SessionSeed } from '../session/store.tsx';
import { loadVerifySeed, type VerifySeed } from './seed.ts';

export interface VerifyBootstrap {
  seed: SessionSeed;
  /** 登录后要自动执行的动作。由调用方（App 外壳）在拿到 provider 之后再跑。 */
  plan: VerifySeed | null;
}

/**
 * 如果存在验收种子，就用它登录并返回一个 client。
 * 没有种子、或登录失败 → 返回 null，App 走正常的凭据流程。
 */
export async function bootstrapFromVerifySeed(): Promise<VerifyBootstrap | null> {
  const verifySeed = loadVerifySeed();
  if (verifySeed === null) return null;

  // 场景模式**不碰网络**。
  //
  // 场景的数据是本地注入的帧，跟服务端没关系，所以没有理由为了看一个错误态
  // 去登录一次。这条很重要：它让"看设计"摆脱对服务端、隧道和凭据的依赖——
  // CI 里没有服务器也能跑，网断了也能跑。
  //
  // 这里给的 client 永远不会被调用：外壳需要它才能挂载 SessionProvider，而
  // SessionProvider 只是持有它、不主动发请求。真发出去会连不上，这正好暴露
  // "场景模式不该联网"这条约束被破坏了。
  if (verifySeed.scenario === 'scene' && typeof verifySeed.scene === 'string') {
    return {
      seed: { client: new Client({ baseUrl: 'http://scene.invalid', getToken: () => null }) },
      plan: verifySeed,
    };
  }

  let token: string | null = null;
  const client = new Client({ baseUrl: verifySeed.baseUrl, getToken: () => token });

  try {
    const response = await client.login(verifySeed.username, verifySeed.password);
    token = response.access_token;
    await saveSession({
      baseUrl: verifySeed.baseUrl,
      token: response.access_token,
      expiresAt: response.expires_at,
      userId: response.user_id,
      username: response.username,
      displayName: response.display_name,
      role: response.role,
      timezone: response.timezone,
    });
    return { seed: { client }, plan: verifySeed };
  } catch {
    // 种子坏了不等于 App 坏了：退回正常登录流程。
    return null;
  }
}

/**
 * 执行种子里声明的动作。
 *
 * 返回它打开/创建的会话 id，让调用方知道该跳哪个路由。
 * 失败时返回 null——验收会因为没有预期文案而失败，而不是因为这里抛异常。
 */
export async function runVerifyPlan(
  plan: VerifySeed,
  client: MemohClient,
  hooks: {
    /** 拿到 bot 列表后选一个 bot 用。 */
    onBot?: (botId: string) => void;
  } = {},
): Promise<string | null> {
  try {
    const bots = await client.listBots();
    const bot = bots.items[0];
    if (bot === undefined) return null;
    hooks.onBot?.(bot.id);

    // 复用最近的会话；一个都没有就建一个。
    const sessions = await client.listSessions(bot.id, { limit: 1 });
    let sessionId = sessions.items[0]?.id;
    if (sessionId === undefined) {
      const candidate = createdSessionId(
        await client.createSession(bot.id, { title: 'Verify chat' }),
      );
      if (candidate === null) return null;
      sessionId = candidate;
    }

    return sessionId;
  } catch {
    return null;
  }
}

export function verifyEnabled(): boolean {
  if (!__DEV__) return false;
  return loadVerifySeed() !== null;
}
