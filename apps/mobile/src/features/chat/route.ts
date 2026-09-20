/**
 * 这一屏的**路由同步**。
 *
 * ## 为什么单独一个文件
 *
 * `/chat/new` 是一条**真实的路由**，但那时还没有会话 id——页面读的是 `chatFor('')`。
 * 服务端在我们发第一句时会建会话、回 `session_created`（store 把它设成
 * `currentSessionId`），而**路由还停在 `/chat/new`**。于是用户看到的顺序是：
 * 点了发送 → 草稿消失 → 界面依旧一片空白；消息其实已经上路了，只是屏幕上没有任何证据。
 *
 * 这段"路由该跟着谁走"的判断过去埋在 `ChatScreen` 的两个 effect 里，只能靠真机复现。
 * 它不碰 React、不碰 store，只是把状态翻译成路由动作，所以搬到这里被断言：
 *
 * | 函数                  | 回答                                                   |
 * | --------------------- | ------------------------------------------------------ |
 * | `chatSessionId`       | 这一屏现在该读哪个会话的数据（`new` → 空串）           |
 * | `shouldOpenSession`   | 要不要让 store 打开这个会话（已经打开过就不再打开）    |
 * | `createdSessionRoute` | 会话建好了要不要 `replace`、`replace` 到哪             |
 *
 * ## 为什么 `replace` 而不是 `push`
 *
 * 用户没有"返回新会话"这个意图，草稿页不该留在栈里；这也和新会话创建后不该能用
 * 返回键退回去一致。
 */

/** 这一屏该读哪个会话的数据。`new` 是"还没有会话"，服务端来建（见文件头）。 */
export function chatSessionId(input: { isNew: boolean; routeSessionId: string }): string {
  return input.isNew ? '' : input.routeSessionId;
}

/**
 * 要不要让 store 打开路由上那个会话。
 *
 * 判据是"**store 里打开的那个**和路由上的不一样"——只看路由会让每次重渲染都重开一次，
 * 而重开会把正在流的内容清掉。
 */
export function shouldOpenSession(input: {
  isNew: boolean;
  routeSessionId: string;
  openSessionId: string | null;
}): boolean {
  if (input.isNew) return false;
  return input.openSessionId !== input.routeSessionId;
}

/**
 * 新会话建好之后要 `replace` 到哪。`null` = 什么都不做。
 *
 * 两种情况返回 `null`，理由不同：
 *
 * - **不是 `/chat/new`**：用户正在看一条已有会话，这时 `currentSessionId` 也会变（切会话、
 *   重连重订阅），跟着 `replace` 会把用户正在读的那一屏顶掉；
 * - **会话还没建好**（`currentSessionId` 仍是 null）：没有目标可去。
 *
 * 返回的是模板字面量类型（不是裸 `string`）：typed routes 下 `/chat/${string}` 才是
 * 合法目标，写成 `string` 会让 `router.replace` 编译不过。
 */
export function createdSessionRoute(input: {
  isNew: boolean;
  openSessionId: string | null;
}): `/chat/${string}` | null {
  if (!input.isNew) return null;
  if (input.openSessionId === null) return null;
  return `/chat/${input.openSessionId}`;
}
