/**
 * 一次会话结束（401 或用户手动退出登录）的**唯一**处置：清凭据，然后回未登录。
 *
 * ## 为什么要单独一个模块
 *
 * `AGENTS.md` 写死了这条规则（"任意请求 401 一律清 Keychain 回登录页"），但实现里
 * 只有半条：`onUnauthorized` 换了个界面就完事，`clearSession()` 的唯一调用点是用户
 * **手动**退出。于是"token 按 `exp` 还没过期、服务端已经不要它了"（账号被停用/删除，
 * 见 `api/client.ts` 头注释）时，脏凭据留在 Keychain 里，下次冷启动又直接进主界面，
 * 第一个请求再被弹回来——用户体感是"进得去，但什么都打不开"。
 *
 * 反过来的半条同样是真的：手动退出**清了凭据**，但登录闸门的 `phase` 不跟着切，
 * 所以退出之后人落在空壳界面上而不是登录页（见 `signOut` 的注释）。两半合成一处之后，
 * "回到登录页"这件事只有一个实现，两条路不会再有先后修好的差异。
 *
 * 之所以抽成一个可注入依赖的小工厂（而不是写在 hook 里）：
 *
 * 1. `useAuthGate` 是 React 代码，`node --test` 跑不到它；这条规则重要到必须有测试；
 * 2. 处置顺序本身就是规则的一部分（**先**清、**后**回登录页），顺序错了就还是脏凭据；
 * 3. 并发 401 会来自多个请求（打开会话那一屏同时打了好几个端点），必须只清一次。
 *
 * 这不是第二套状态机：它只是把"会话结束该做什么"从 hook 里搬到一个能直测的函数里，
 * 状态的形状（`checking` / `signedOut` / `signedIn`）仍然只在 `useAuthGate` 里。
 */

/**
 * 会话为什么结束。**出口只有一个，起因有两种**——它只决定登录页要不要念一句原因：
 *
 * - `unauthorized`：被服务端踢回来（401）。用户没做任何动作，不说一句会以为是自己按错了；
 * - `manual`：用户自己按了"退出登录"。这时候再念"登录已过期"就是在瞎报故障。
 */
export type SessionEndReason = 'unauthorized' | 'manual';

export interface SessionLossPorts {
  /** 清凭据。生产实现是 `api/credentials.ts` 的 `clearSession`。 */
  clear: (reason: SessionEndReason) => Promise<void>;
  /** 回未登录（渲染由屏幕层负责，见 `useAuthGate` / `AuthGateScreen`）。 */
  onSignedOut: (reason: SessionEndReason) => void;
}

export interface SessionLoss {
  /**
   * 收到 401 时调用。**可以重复调用**：第一次之后是空操作（多个请求会同时被打回）。
   * 返回 void 是为了直接挂到 `MemohClient` 的 `onUnauthorized` 上。
   */
  handle: () => void;
  /**
   * 手动退出登录走这里（设置页那一行）。
   *
   * 为什么不用"设置页自己 `clearSession()` + 重置 store"那套：那会让**同一个人、
   * 同一个结果**有两条路——而闸门（`useAuthGate` 的 `phase`）只认这一条。以前退出登录
   * 确实清了钥匙串，但 `phase` 还停在 `signedIn`，于是人落在**已经卸掉会话的空壳界面**
   * 上；冷启动才发现"其实早就退出了"。清凭据 + 回登录页这件事只有一处实现（下面那个
   * `end`），两种起因共用它。
   */
  signOut: () => void;
  /**
   * 这一次会话结束**是否已经发生**。
   *
   * 启动时那一段"还剩一半有效期就续一次"必须问它：续期拿到 401 时 `handle` 已经把
   * 界面切回登录页了，而那段代码在 `catch` 之后还会继续往下走——不拦一下它会把
   * 刚刚被清掉的凭据又当成"登录成功"送进主界面。
   */
  hasFired: () => boolean;
  /**
   * 重新登录成功后复位（`useAuthGate` 的 `onSignedIn` 调）。
   *
   * 出口是幂等的（`fired` 只让第一次生效），那是为了压住同一会话里并发的一堆 401；
   * 但它不能跨会话粘住——不复位的话，**退出后重新登录**的人再遇到 401 会被当成
   * "已经处理过"，被扣在一个什么都打不开的主界面上。
   */
  reset: () => void;
  /** 清凭据那一步落地（测试等它；生产代码不需要）。 */
  settled: () => Promise<void>;
}

export function createSessionLoss(ports: SessionLossPorts): SessionLoss {
  let fired = false;
  let settled: Promise<void> | null = null;

  /** 唯一的出口：**先**清凭据，**再**回未登录。顺序错了留下的是脏凭据。 */
  const end = (reason: SessionEndReason) => {
    if (fired) return;
    fired = true;
    settled = (async () => {
      try {
        await ports.clear(reason);
      } catch {
        // 清不掉（Keychain 不可用）不是"继续当登录着"的理由：内存里那份已经被
        // `clearSession` 同步清掉了，界面这一步照走。
      } finally {
        ports.onSignedOut(reason);
      }
    })();
  };

  return {
    handle: () => end('unauthorized'),
    signOut: () => end('manual'),
    hasFired: () => fired,
    reset: () => {
      fired = false;
      settled = null;
    },
    settled: () => settled ?? Promise.resolve(),
  };
}
