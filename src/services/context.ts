import { Message, GuildMember, TextChannel, ThreadChannel, AnyThreadChannel } from "discord.js";
import { logger } from "../utils/logger";

export const STAFF_ROLE_KEYWORDS = ["moderator", "mod", "developer", "dev", "community manager", "cm", "admin", "staff"];

export function isStaffMember(member: GuildMember | null | undefined): boolean {
  if (!member) return false;
  return member.roles.cache.some((role) => STAFF_ROLE_KEYWORDS.some((sr) => role.name.toLowerCase().includes(sr)));
}

function isFetchableChannel(channel: unknown): channel is TextChannel | ThreadChannel | AnyThreadChannel {
  return !!channel && typeof (channel as any).messages?.fetch === "function";
}

export async function getConversationContext(message: Message, limit: number = 8): Promise<string> {
  try {
    const channel = message.channel;
    if (!isFetchableChannel(channel)) return "";

    const messages = await channel.messages.fetch({ before: message.id, limit });
    if (messages.size === 0) return "";

    const lines = messages
      .reverse()
      .map((m) => `[${m.author.username}]: ${m.content.slice(0, 200)}`)
      .filter((line) => line.length > 10);

    return lines.join("\n");
  } catch (error) {
    logger.debug("Could not fetch context", error);
    return "";
  }
}

export async function checkStaffReplied(message: Message): Promise<boolean> {
  try {
    const channel = message.channel;
    if (!isFetchableChannel(channel)) return false;

    const after = await channel.messages.fetch({ after: message.id, limit: 10 });
    return after.some((m) => !m.author.bot && isStaffMember(m.member));
  } catch {
    return false;
  }
}

export function resolveChannelName(message: Message): string {
  const channel = message.channel as any;
  return channel?.name || "unknown-channel";
}
