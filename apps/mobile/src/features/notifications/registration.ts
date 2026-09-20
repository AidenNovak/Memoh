/**
 * **device token 上报契约**（客户端这一半）。
 *
 * ## 先看这件事为什么危险
 *
 * 推送是唯一一种"送错人也不会报错"的通道：投递失败没人看见，投递成功但送错了人
 * ——换号之后前一个用户的审批弹到新用户手机上——也没有任何一方会报错。
 * 本项目参考的 Lody 那台设备上就发生过一次（见 `docs/research/lody-ios-patterns.md`
 * 第 24 条），它的结论是：**token 注册必须按用户上锁，换号先解绑**。
 *
 * 所以这里定死两件事：
 *
 * 1. **换号（或 token 变了）永远是"先解绑、再绑定"**，不允许"直接覆盖"。
 *    覆盖看起来更省事，但它把"旧绑定有没有清掉"变成一个只能靠服务端小心处理的问题；
 *    显式解绑让它变成一条**顺序**：解绑失败就不继续，宁可这次不注册，也不要留下
 *    一个会串号的绑定。
 * 2. **同一个 token 只属于一个用户**。客户端保证顺序，服务端保证唯一性：如果解绑那次
 *    没跑到（App 在换号途中被杀），服务端收到新用户的绑定时必须**替换**旧绑定，
 *    而不是留下两条。这条是契约的一半，不写清楚就等于没定。
 *
 * ## 服务端端点还不存在
 *
 * 这个仓库里没有服务端的发送方，也没有 `POST /devices`。所以这里的**形状**是契约
 * （路径、请求体、鉴权、解绑顺序），而 `reportDeviceRegistration` 那类调用点在
 * `bridge.ts` 里留了 TODO 并明确"服务端没有这个端点前不得上线调用"——契约不能靠
 * 猜服务端行为来补齐。
 */

/** 绑定端点。注册与解绑同一个路径，靠方法区分。 */
export const DEVICE_REGISTRATION_PATH = '/devices';

/** 这条链路的 APNs 环境。debug 构建拿到的是 sandbox token，release 是 production。 */
export type PushEnvironment = 'sandbox' | 'production';

export function pushEnvironment(isDevBuild: boolean): PushEnvironment {
  return isDevBuild ? 'sandbox' : 'production';
}

/** 已上报成功的绑定（持久化在 Keychain，见 `store.ts`）。 */
export interface BoundRegistration {
  token: string;
  userId: string;
}

export interface RegistrationContext {
  /** 当前设备 token（hex）；拿不到就是 null（模拟器、无凭据、App ID 没开 Push）。 */
  token: string | null;
  /** 当前登录用户 id；没登录就是 null。 */
  userId: string | null;
  /** 上次**确认成功**的绑定；从没成功过就是 null。 */
  bound: BoundRegistration | null;
  environment: PushEnvironment;
}

export type RegistrationStep =
  /** 先把旧绑定解掉（换号或换 token 时的第一步）。 */
  | { kind: 'unregister'; token: string }
  /** 再绑定当前这台设备。 */
  | { kind: 'register'; token: string; userId: string; environment: PushEnvironment };

/**
 * 该对服务端做哪几步。
 *
 * 判据的顺序就是安全顺序，不要调整：
 *
 * 1. 没有 token 或没有用户 → **什么都不做**。没有用户时绑定等于"把这台设备挂到
 *    某个人身上"，那正是串号的来源。
 * 2. 压根没绑过 → 只注册。
 * 3. token 与用户都对得上 → **不重复上报**（每次冷启动都 POST 一遍是没意义的写，
 *    而且会让"注册表里到底哪条是真的"变得无法判断）。
 * 4. 其余（换号、token 轮换）→ **先解绑，再绑定**。
 */
export function registrationSteps(context: RegistrationContext): RegistrationStep[] {
  const { token, userId, bound, environment } = context;
  if (token === null || userId === null) return [];
  if (bound === null) return [{ kind: 'register', token, userId, environment }];
  const unchanged = bound.token === token && bound.userId === userId;
  if (unchanged) return [];
  return [
    { kind: 'unregister', token: bound.token },
    { kind: 'register', token, userId, environment },
  ];
}

/** 注册请求体。`user_id` 是**声明**，服务端必须拿它跟 Bearer 身份比对。 */
export interface RegisterBody {
  platform: 'ios';
  token: string;
  bundle_id: string;
  environment: PushEnvironment;
  user_id: string;
}

/** 解绑请求体。 */
export interface UnregisterBody {
  token: string;
  user_id: string;
}

export interface DeviceRequest {
  method: 'POST' | 'DELETE';
  path: string;
  body: RegisterBody | UnregisterBody;
}

/**
 * 一步 → 一个 HTTP 请求。
 *
 * **token 不放 URL**：它会进 nginx / 网关的访问日志，而一个 device token 是能直接
 * 向这台设备投递的凭据。所以解绑是 `DELETE` + body，不是 `DELETE /devices/<token>`。
 */
export function requestFor(
  step: RegistrationStep,
  context: { bundleId: string; userId: string },
): DeviceRequest {
  if (step.kind === 'unregister') {
    return {
      method: 'DELETE',
      path: DEVICE_REGISTRATION_PATH,
      body: { token: step.token, user_id: context.userId },
    };
  }
  return {
    method: 'POST',
    path: DEVICE_REGISTRATION_PATH,
    body: {
      platform: 'ios',
      token: step.token,
      bundle_id: context.bundleId,
      environment: step.environment,
      user_id: step.userId,
    },
  };
}

/** 鉴权与其余端点一致：`Authorization: Bearer <access_token>`。 */
export function authorizationHeader(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

/**
 * 一次上报的结果 → 新的绑定状态。
 *
 * **只有注册成功才更新绑定**：解绑成功只说明"旧的那条没了"，此时若把 bound 清成
 * null 再注册失败，下次启动会重头来一遍——这是对的（宁愿重试，也不要以为绑过而跳过）。
 */
export function boundAfter(
  step: RegistrationStep,
  succeeded: boolean,
  bound: BoundRegistration | null,
): BoundRegistration | null {
  if (!succeeded) return bound;
  if (step.kind === 'unregister') return null;
  return { token: step.token, userId: step.userId };
}

/** 持久化的绑定形状。读不出来（老版本、手工改坏）就当作"没绑过"。 */
export function parseBound(raw: string | null): BoundRegistration | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { token, userId } = parsed as Partial<BoundRegistration>;
    if (typeof token !== 'string' || token === '') return null;
    if (typeof userId !== 'string' || userId === '') return null;
    return { token, userId };
  } catch {
    return null;
  }
}

export function serializeBound(bound: BoundRegistration): string {
  return JSON.stringify({ token: bound.token, userId: bound.userId });
}

/**
 * 服务端实现这个端点时的硬要求（写在这里，因为它跟着契约走）。
 *
 * 三条都不是"建议"：
 *
 * 1. `user_id` 必须与 Bearer 身份一致，不一致一律 400 —— 不能以 body 为准，
 *    否则客户端 bug（拿错用户的 id）就变成"把别人的设备挂到自己名下"。
 * 2. 同一个 token 只保留一条绑定（后写覆盖）——换号途中被杀的那次解绑靠它兜底。
 * 3. 解绑必须**只**删当前身份 + 该 token 的绑定，不能按 token 删任意用户的绑定
 *    （否则任何人都能拿一个 hex 串解绑别人的设备）。
 */
export const SERVER_REQUIREMENTS: readonly string[] = [
  'user_id body 与 Bearer 身份必须一致，不一致 400',
  '同一 token 只保留一条绑定（后写覆盖）',
  '解绑按 (当前用户, token) 匹配，不按 token 全局删',
];
