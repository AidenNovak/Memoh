/**
 * 验收脚本的执行器（仅开发构建，不渲染任何 UI）。
 *
 * 挂在 `SessionProvider` 里面，所以它能用到真实的 store 动作：真实的 `sendMessage`、
 * 真实的实时通道、真实的 reducer。屏幕上看到的是产品组件本身。
 *
 * 为什么不用点击自动化：`simctl` 没有 tap 能力，而引入 XCUITest / Appium / Maestro
 * 会给这个项目加一整套重型依赖。用"脚本化动作"替代"手指"，被验证的路径本身没有变。
 *
 * 非验收场景下这个组件什么都不做，且不产生任何副作用。
 */
import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';

import { createdSessionId } from '../../api/types.ts';
import type { VerifyBootstrap } from './bootstrap.ts';
import { watchVerifyNavigation } from './seed.ts';
import { useSession } from '../session/store.tsx';

export function VerifyPlanRunner({ verify }: { verify: VerifyBootstrap | null }) {
  const { state, selectBot, openSession, submit } = useSession();
  const router = useRouter();
  const started = useRef(false);
  /**
   * 场景模式：本地帧回放，跟服务端无关。
   *
   * 必须排在"等 bot 列表到位"之前——场景模式下 client 指向一个不存在的地址，
   * `state.bots` 永远是空的，排在后面就永远进不去。这个顺序是踩过的坑。
   */
  const sceneMode =
    verify?.plan?.scenario === 'scene' && typeof verify.plan.scene === 'string'
      ? verify.plan.scene
      : null;
  const routeMode =
    verify?.plan?.scenario === 'route' && typeof verify.plan.path === 'string'
      ? verify.plan.path
      : null;

  useEffect(() => {
    if (sceneMode !== null) {
      if (started.current) return;
      started.current = true;
      // `replace` 而不是 `push`：场景台是这一趟的目的地，不是从首页点进去的下一层。
      router.replace(`/debug/scene/${sceneMode}`);
      return;
    }
    // 直接开某个真实页面。**要等 bot 列表到位**——首页与设置页的文案依赖
    // 当前 bot（名字、权限），早跳会截到还没取到数据的中间态。
    if (routeMode !== null) {
      if (started.current) return;
      if (state.bots.length === 0) return;
      started.current = true;
      router.replace(routeMode as never);
      return;
    }

    if (verify === null || verify.plan === null) return;
    if (started.current) return;
    // 等 bot 列表到位再动手。
    if (state.bots.length === 0) return;

    const plan = verify.plan;
    const bot = state.bots[0];
    if (bot === undefined) return;

    started.current = true;

    void (async () => {
      selectBot(bot.id);

      // 让 store 的 effect 先把会话列表拉回来，再决定进哪个会话。
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      const client = state.client;
      if (client === null) return;

      // 优先用种子指定的会话（验收要挑"有内容的"那个）；否则最近的一个。
      let sessionId = typeof plan.sessionId === 'string' ? plan.sessionId : state.sessions[0]?.id;
      if (sessionId === undefined) {
        try {
          const candidate = createdSessionId(
            await client.createSession(bot.id, { title: 'Verify chat' }),
          );
          if (candidate !== null) sessionId = candidate;
        } catch {
          return;
        }
      }
      if (sessionId === undefined) return;

      openSession(sessionId);
      // 走到对话页——脚本化动作也要让界面处于产品路径上，截图才有意义。
      //
      // `?info=1` 让对话页把会话信息面板打开（面板本是点标题才出现的）。
      // 用查询参数而不是"直接调 store"：面板的开合状态属于 ChatScreen，
      // 从外面改它就得把状态提上去——为验收改产品结构不值得。
      router.push(
        plan.openSessionInfo === true ? `/chat/${sessionId}?info=1` : `/chat/${sessionId}`,
      );

      if (plan.scenario === 'chat' && typeof plan.message === 'string') {
        // 等实时通道订阅完成（收到 snapshot）再发，否则正文收不到。
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        await submit(plan.message);
      }
    })();
  }, [
    sceneMode,
    routeMode,
    verify,
    state.bots,
    state.sessions,
    state.client,
    selectBot,
    openSession,
    submit,
    router,
  ]);

  return null;
}

/**
 * 验收导航的跟随者（仅开发构建）。
 *
 * 跟着种子文件切换到场景台或某个真实页面。
 *
 * 单独一个组件而不是塞进 `VerifyPlanRunner`：那个组件的 effect 依赖一堆 store 状态
 * （bots / sessions / client），每次它们变化都会重跑 effect；而这里只依赖一个文件，
 * 两者生命周期不同。分开以后切换也不受 store 刷新影响。
 */
export function ScenePlanWatcher({ verify }: { verify: VerifyBootstrap | null }) {
  const router = useRouter();
  const plan = verify?.plan ?? null;
  const enabled = plan?.scenario === 'scene' || plan?.scenario === 'route';

  useEffect(() => {
    if (plan === null || !enabled) return;
    return watchVerifyNavigation(plan, (target) => {
      const [kind, value] = [
        target.slice(0, target.indexOf(':')),
        target.slice(target.indexOf(':') + 1),
      ];
      if (kind === 'scene') router.replace(`/debug/scene/${value}`);
      if (kind === 'route') router.replace(value as never);
    });
  }, [plan, enabled, router]);

  return null;
}
