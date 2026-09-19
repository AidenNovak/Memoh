/**
 * 账号那一行显示什么名字。
 *
 * 抽出来的理由：`displayName` 是**空串**在服务端很常见（没设显示名），而"没有会话"是另一件事。
 * 写成 `displayName || username` 会把两者混成一个结果——虽然这里恰好都退回登录名，但读的人
 * 无法从代码看出"空显示名"是被考虑过的。没有会话时返回空串，调用方据此整行不显示。
 */
export interface AccountIdentity {
  displayName: string;
  username: string;
}

export function accountNameOf(session: AccountIdentity | null): string {
  if (session === null) return '';
  if (session.displayName !== '') return session.displayName;
  return session.username;
}
