/**
 * User identity (spec #72 票5/C6) — the single point for "what is a user
 * identity here". Three representations coexist (cross-transport need +
 * config-storage history), and every conversion/matching rule between them
 * lives HERE as a named, tested function instead of scattered compat code:
 *
 *  - namespaced（存储形式）: "matrix:@user:server" — trustedUsers/adminUserId/
 *    powerElevatedUsers 等配置账本统一用它区分不同 transport 下的同 ID。
 *  - native（Matrix API 形式）: "@user:server" — 房间成员/邀请/权力等级操作。
 *  - display（展示形式）: "@user (matrix)" — /trusted 输出(注意:沿用既有
 *    截断行为,MXID 的 homeserver 段不展示;改动属行为变化,不在纯重构范围)。
 */

/** 存储形式:按 transport 加命名空间前缀。 */
export function namespacedId(userId: string, transport?: string): string {
  return transport ? `${transport}:${userId}` : userId;
}

/** native 形式:剥掉 transport 前缀(Matrix API 消费);无前缀形式原样返回。 */
export function nativeMxid(namespaced: string): string {
  return namespaced.startsWith("matrix:") ? namespaced.slice("matrix:".length) : namespaced;
}

/** 展示形式:/trusted 输出。与历史实现逐字一致 — 已知怪癖:MXID 的
 *  homeserver 段被截断(不属本 spec 的行为变化范围)。 */
export function displayIdentity(namespaced: string): string {
  const [transport, uid] = namespaced.split(":");
  return uid ? `${uid} (${transport})` : namespaced;
}

/**
 * 信任账本匹配(/revoke 的统一规则):完整条目精确匹配优先;未命中时,
 * 允许裸 ID(无 transport 前缀的 telegram ID 或 /trusted 展示的 native MXID)
 * 以 ":<id>" 后缀匹配一个条目。suffix 匹配是有名字的规则,不是猜。
 */
export function matchesTrustedEntry(revokeId: string, entry: string): boolean {
  return entry === revokeId || entry.endsWith(`:${revokeId}`);
}

/**
 * 管理员匹配(统一规则,含存量兼容):config 的 adminUserId 规范上是
 * namespaced 形式;极早期部署存过裸 ID — 双形式比较作为显式命名的兼容
 * 规则保留(替代 isAdminUser 里无名的 `||` 兜底)。
 */
export function matchesAdmin(adminUserId: string, userId: string, transport?: string): boolean {
  return adminUserId === namespacedId(userId, transport) || adminUserId === userId;
}
