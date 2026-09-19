/**
 * 登录页的服务器地址：校验与显示。
 *
 * 抽成纯函数有两个理由，都不是洁癖：
 *
 * 1. **地址错和密码错必须分开报。** 自托管产品最常见的登录失败原因不是密码打错，而是
 *    地址填错（漏了 `http://`、多了一个路径、粘了一串带空格的东西）。以前这两种失败都落到
 *    "Can't reach the server" 上，用户于是去反复重输密码。
 * 2. 折叠起来的那一行要显示一个**短**地址（只有主机名），不然一行放不下、
 *    用户也读不出自己连的是哪台。
 *
 * 不用 `new URL()`：Hermes 上的实现不全，而这里要判的东西一个正则就够，
 * 少一个"运行时行为不一致"的来源。
 */

/** 服务器地址的问题。`null` = 看起来能用（能不能连通是网络的事，不是格式的事）。 */
export type ServerProblem = 'empty' | 'invalid';

/** 必须有 `http://` 或 `https://` 加一个主机名，中间不能有空格。 */
const SHAPE = /^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i;

export function serverProblemOf(rawServer: string): ServerProblem | null {
  const server = rawServer.trim();
  if (server === '') return 'empty';
  if (!SHAPE.test(server)) return 'invalid';
  return null;
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
