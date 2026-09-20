/**
 * Cloud 登录入口的纯逻辑：邮箱校验与"继续"按钮的可用性。
 *
 * ## 为什么有这份文件
 *
 * 登录首页的 Cloud 区（GitHub / Google / 邮箱）今天**全部是占位入口**：Cloud 的账号
 * 鉴权在另一个控制面（`memoh-ios-dev.md` §4.7），服务端给移动端的一次性 code 换
 * 凭证合同还没落地。在那之前，这三个入口**不许发任何网络请求、不许收集凭据**——
 * 按下后只给一句本地化的"尚未开放"。
 *
 * 但邮箱这一格仍要做**本地校验**：格式明显不对的地址不该让"继续"亮起来。这不是
 * 为了拦住谁（反正按下也不会发请求），而是因为"按钮什么时候能按"本身就是界面在
 * 教用户规则——亮着的按钮 + 一句"尚未开放"是诚实的占位；对明显错误的输入也亮，
 * 是在教用户"这格随便填"。
 *
 * 抽成纯函数的理由和 `server.ts` 一样：校验规则要能被 node --test 直测，
 * 不挂在 React 组件里靠渲染去猜。
 *
 * ## 校验的尺度
 *
 * 这是登录表单的**可用性闸门**，不是 RFC 5322 验证器。刻意只查三件事：
 * 有且仅有一个 `@`、两侧都非空、域名段里有个点。够拦住"少打了 @"、"粘进来一段
 * 带空格的话"这类真实笔误；更怪的地址（`a@b.c`）放过——它不危害任何人，
 * 因为这一格今天根本不会离开这台手机。
 */

/** 邮箱的问题。`null` = 看起来是个邮箱地址（能不能收信是另一回事）。 */
export type EmailProblem = 'empty' | 'invalid';

/** 实用型邮箱形状：非空、无空白、恰好一个 `@`、域名段含点。 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 校验入口（唯一事实源）。输入会先 trim——首尾空格当作没看见。 */
export function emailProblemOf(rawEmail: string): EmailProblem | null {
  const email = rawEmail.trim();
  if (email === '') return 'empty';
  if (!EMAIL_SHAPE.test(email)) return 'invalid';
  return null;
}

/**
 * "继续"按钮该不该亮：只在校验通过时亮。
 *
 * 空着 → 不亮也不报错（用户还没填，报错是说教）；
 * 填了但不对 → 不亮，且界面上同时给出 `invalid` 那句说明；
 * 对了 → 亮，按下走占位反馈。
 */
export function canContinueWithEmail(rawEmail: string): boolean {
  return emailProblemOf(rawEmail) === null;
}

/**
 * 输入过程中该不该显示"格式不对"那句话：只有**填过内容且不对**时才显示。
 * 空着不显示（用户可能只是还没开始填这一格）。
 */
export function shouldShowEmailError(rawEmail: string): boolean {
  return emailProblemOf(rawEmail) === 'invalid';
}
