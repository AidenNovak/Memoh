/**
 * 生成一个 UUID v4 字符串。
 *
 * 为什么要自己写一个：RN 运行时不保证有 `crypto.randomUUID`（Hermes 上视配置而定）。
 * 这个值被当作**幂等身份**用（消息的 invocation_id、队列提交的 invocation_id），
 * 所以必须有实现，不能在运行时"看有没有"然后降级成时间戳——那样的碰撞会让服务端
 * 把两条不同的消息当成同一条去重掉。
 *
 * 有原生实现就用原生（它由系统 CSPRNG 提供）；没有就手写一个 v4：版本位与变体位
 * 按 RFC 4122 设置，其余用 `Math.random`。这里的安全性要求不高（不是密钥），
 * 但**唯一性**要求是真的，所以宁可要一个形状正确的 v4。
 */
export function uuid(): string {
  const globalCrypto = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (globalCrypto?.randomUUID) return globalCrypto.randomUUID();
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
