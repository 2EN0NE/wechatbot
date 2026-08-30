/**
 * 发送者白名单鉴权纯逻辑（无 IO / 无 pi 运行时依赖）。
 * 见 docs/adr/0010-sender-allowlist.md：默认拒绝 + 首用户配对 + 显式锁定。
 */

export type AuthorizationState =
 | { kind: "pair"; userId: string }
 | { kind: "allow" }
 | { kind: "deny" };

/**
 * 判定某 wxid 是否被授权触发轮次。
 * - allowedUserId 未设：首用户配对（pair）——谁先说话谁成为授权发送者。
 * - allowedUserId 已设且匹配：放行（allow）。
 * - 其余：拒绝（deny），静默丢弃。
 */
export function authorizationState(
 userId: string,
 allowedUserId: string | undefined,
): AuthorizationState {
 if (allowedUserId === undefined) return { kind: "pair", userId };
 if (userId === allowedUserId) return { kind: "allow" };
 return { kind: "deny" };
}
