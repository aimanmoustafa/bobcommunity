import { config } from "../config";

/**
 * The real enforcement for "who can run /feedback and /community" --
 * Discord's own command permission menu (default_member_permissions, set
 * in client.ts) only controls visibility/discoverability in the slash
 * command picker, which a server admin can override for anyone at any
 * time without this bot knowing. This check is what actually decides
 * whether a command runs, independent of anyone's Discord role.
 */
export function isAuthorizedUser(userId: string): boolean {
  return config.discord.authorizedCommandUserIds.includes(userId);
}
