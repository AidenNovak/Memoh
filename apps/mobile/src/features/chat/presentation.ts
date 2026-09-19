/**
 * 审批 / 提问这两个**"服务端说该出现了"的页面**的出席钥匙（纯逻辑，可单测）。
 *
 * ## 钥匙为什么是这个形状
 *
 * 审批与提问都不是用户点出来的：store 里 `chat.approval` / `chat.userInput` 一变，
 * 界面就该弹出来。`usePresentedPage` 的契约是**同一把钥匙只打开一次**，所以钥匙必须
 * 同时满足两件事：
 *
 * - **同一个待办重复出现**（effect 重跑、帧重发）→ 钥匙不变 → 不叠出第二个 sheet；
 * - **又来一个待办**（新的 approval id / user input id）→ 钥匙变了 → 该弹就弹。
 *
 * 用布尔的"有没有待办"会把第二个审批吞掉；只带 id 不带会话则会把另一个会话的同名
 * 待办当成同一个。所以是 `会话 id : 待办 id`。
 *
 * 会话 id 带上还有一层理由：**同一把钥匙在 store 里是跨会话的**，而审批面板的参数
 * 里带着 `sessionId`（它要拿这个 id 去回应），钥匙少了这一段，"A 会话的审批"与
 * "B 会话的审批"会撞成一把。
 *
 * 这里只做字符串拼接，但**"只发一次"这条行为全靠它**——所以搬出组件、单独钉住。
 */

/** 审批 sheet 的出席钥匙。`approvalId` 为空串时也照拼（那不是合法待办，交给上层判空）。 */
export function approvalPresentationKey(input: { sessionId: string; approvalId: string }): string {
  return `${input.sessionId}:${input.approvalId}`;
}

/** 提问表单（`ask_user`）的出席钥匙。理由同上。 */
export function userInputPresentationKey(input: {
  sessionId: string;
  userInputId: string;
}): string {
  return `${input.sessionId}:${input.userInputId}`;
}
