/**
 * 登录页的服务器地址：规范化、Memoh 探测与显示。
 *
 * 抽成纯函数有三个理由，都不是洁癖：
 *
 * 1. **地址错、不是 Memoh、密码错是三件不同的事，必须分开报。** 自托管产品最常见的登录
 *    失败原因不是密码打错，而是地址填错（漏了协议、粘了一串带空格的东西、指向一台
 *    根本不是 Memoh 的机器）。以前这些都落到 "Can't reach the server" 上，用户于是去
 *    反复重输密码。
 * 2. **口令只能在确认对方是 Memoh 之后发出去。** 地址写错时把用户名/密码 POST 给一台
 *    陌生服务器，等于替它收集凭据。所以 `discoverMemohServer` 必须先于 `/auth/login`，
 *    顺序不能反。
 * 3. **折叠起来的那一行要显示一个短地址**（只有主机名），不然一行放不下。
 *
 * REST 客户端本身已使用标准 `URL`，这里复用同一个解析器；不再自己维护
 * authority / IPv4 / IPv6 语法的第二份实现。
 */

/** 服务器地址的问题。`null` = 看起来能用（能不能连通是网络的事，不是格式的事）。 */
export type ServerProblem = 'empty' | 'invalid';

/** 规范化后的服务器地址。 */
export interface NormalizedServer {
  /** 最终拿来发请求的 base URL：含协议与用户显式路径，末尾无斜杠。 */
  baseUrl: string;
  /** 协议 + 主机 + 端口，没有路径。探测候选从它派生。 */
  origin: string;
  /** 用户明确写了路径。写了就只探测这一条，不替他猜。 */
  explicitPath: boolean;
  /** localhost / loopback / RFC1918 IPv4 / `.local`。 */
  local: boolean;
  /** 显式端口；没写就是 `null`（即该协议的默认端口）。 */
  port: number | null;
}

export type NormalizeResult =
  { ok: true; server: NormalizedServer } | { ok: false; problem: ServerProblem };

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * localhost / loopback / RFC1918 / `.local`。
 * 刻意不做完整 PSL：这里只需要回答"明文 HTTP 发给它安不安全"。
 */
function isLocalHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    return true;
  }
  if (normalized === '::1') return true;
  const m = IPV4.exec(normalized);
  if (m === null) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * 规范化入口（唯一的事实源，`serverProblemOf` 只是它的薄壳）：
 *
 * - 空白是 `empty`，其余不合法是 `invalid`。
 * - 没写协议时补协议：本机/内网补 `http://`，公网域名补 `https://`。
 * - 只允许 HTTP/HTTPS；userinfo、query、fragment、空 host 一律拒绝。
 * - 公网地址的 `http://` 拒绝——口令不能明文上公网。本机/内网放行。
 * - 用户显式写的路径保留，只去掉末尾斜杠。
 */
export function normalizeServer(rawServer: string): NormalizeResult {
  const input = rawServer.trim();
  if (input === '') return { ok: false, problem: 'empty' };
  if (/\s/.test(input) || input.includes('?') || input.includes('#')) {
    return { ok: false, problem: 'invalid' };
  }

  const hasScheme = SCHEME.test(input);
  if (!hasScheme && input.includes('://')) return { ok: false, problem: 'invalid' };

  let preliminary: URL;
  try {
    preliminary = new URL(hasScheme ? input : `http://${input}`);
  } catch {
    return { ok: false, problem: 'invalid' };
  }
  const local = isLocalHost(preliminary.hostname);

  let url: URL;
  try {
    url = new URL(hasScheme ? input : `${local ? 'http' : 'https'}://${input}`);
  } catch {
    return { ok: false, problem: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, problem: 'invalid' };
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return { ok: false, problem: 'invalid' };
  }

  // `URL` 会把 `host:` 容错成“没写端口”；输入框不应替用户猜这个笔误。
  const authority = input.replace(SCHEME, '').split('/')[0] ?? '';
  if (authority.endsWith(':')) return { ok: false, problem: 'invalid' };

  // 公网明文 = 把口令送给任何能看流量的人。本机/内网没有 TLS 是常态，放行。
  if (url.protocol === 'http:' && !local) return { ok: false, problem: 'invalid' };

  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  const port = url.port === '' ? null : Number(url.port);

  return {
    ok: true,
    server: {
      baseUrl: url.origin + path,
      origin: url.origin,
      explicitPath: path !== '',
      local,
      port,
    },
  };
}

/** 旧入口保留给"这格能不能提交"的判定；新代码请直接用 `normalizeServer`。 */
export function serverProblemOf(rawServer: string): ServerProblem | null {
  const result = normalizeServer(rawServer);
  if (result.ok) return null;
  return result.problem;
}

/**
 * 探测候选（顺序即优先级）：
 *
 * - 用户明确写了路径：只探测那一条，不猜。
 * - 公网域名（无端口、无路径）：先 `/api`（标准部署挂在 `/api` 后面），再裸根。
 * - localhost / 内网 / 显式 `8080` / `18080`：先裸根（开发栈与单机部署的习惯），再 `/api`。
 */
export function discoveryCandidates(server: NormalizedServer): string[] {
  if (server.explicitPath) return [server.baseUrl];
  const rootFirst = server.local || server.port === 8080 || server.port === 18080;
  if (rootFirst) return [server.origin, `${server.origin}/api`];
  return [`${server.origin}/api`, server.origin];
}

/** 可注入的 fetch 形状：只要够探 `/ping` 用。 */
export interface PingResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: {
    signal: AbortSignal;
    headers: Record<string, string>;
    method?: 'GET' | 'POST';
    body?: string;
  },
) => Promise<PingResponseLike>;

export interface DiscoverOptions {
  fetchFn?: FetchLike;
  /** 每个候选共用的超时上限（毫秒）。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4000;

/**
 * 服务器发现：对候选请求 `<candidate>/ping`，**HTTP 2xx 且 JSON
 * `status === "ok"`** 后，再用空载荷确认 `<candidate>/auth/login` 是 self-host 登录端点。
 * 这两条都成立才可以发送用户口令：Cloud 的 `/api/ping` 也会成功，但它的账号
 * 鉴权在另一个控制面，不能被误当成 JWT self-host。
 *
 * 候选并行探测（用户等登录不该串行等两遍超时），但**选择结果严格按优先级**：
 * 排在前面的候选成功就选它，不管后面的多快回来。全部失败返回 `null`。
 */
export async function discoverMemohServer(
  server: NormalizedServer,
  options: DiscoverOptions = {},
): Promise<string | null> {
  const fetchFn = options.fetchFn ?? (fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const candidates = discoveryCandidates(server);
  const results = await Promise.all(
    candidates.map((candidate) => probeSelfHostedMemoh(candidate, fetchFn, timeoutMs)),
  );
  for (const [index, candidate] of candidates.entries()) {
    if (results[index]) return candidate;
  }
  return null;
}

async function probeSelfHostedMemoh(
  candidate: string,
  fetchFn: FetchLike,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(`${candidate}/ping`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return false;
    if ((body as { status?: unknown }).status !== 'ok') return false;

    // 空对象不含凭据；400/401/422 都证明路由存在且正在做输入/鉴权校验。
    // 404 则是 Cloud 控制面或别的 API，不得继续发真口令。
    const login = await fetchFn(`${candidate}/auth/login`, {
      signal: controller.signal,
      method: 'POST',
      body: '{}',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
    });
    return login.status === 400 || login.status === 401 || login.status === 422;
  } catch {
    // 超时（abort）、网断、HTML 当 JSON 解析失败——对探测来说都是同一个答案：不是。
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 显示用的短地址：去掉协议、路径与结尾斜杠，只留主机（含端口）。

 端口要留着——自托管的人常同时跑好几个实例，`127.0.0.1:18080` 和 `:8080` 是两台不同
 的服务器，把端口抹掉这行就失去意义了。协议也去掉，因为折叠状态这一行是给人扫一眼的，
 不是给人复制的（要复制就展开输入框）。
 */
export function hostOf(rawServer: string): string {
  const server = rawServer.trim();
  const withoutScheme = server.replace(/^https?:\/\//i, '');
  const host = withoutScheme.split(/[/?#]/)[0] ?? '';
  return host.replace(/\/+$/, '');
}
