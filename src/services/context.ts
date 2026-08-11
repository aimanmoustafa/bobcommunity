import { Message, TextChannel, ThreadChannel, AnyThreadChannel } from "discord.js";
import { logger } from "../utils/logger";

/**
 * Type guard: works for regular text channels, threads, and forum post
 * threads alike, since all of them expose .messages.fetch the same way.
 */
function isFetchableChannel(
  channel: unknown
): channel is TextChannel | ThreadChannel | AnyThreadChannel {
  return !!channel && typeof (channel as any).messages?.fetch === "function";
}

/**
 * Collects recent conversation context from a channel OR thread so the AI
 * can understand a message in the context of the surrounding discussion.
 * Works for regular channels, threads, and forum post threads.
 */
export async function getConversationContext(message: Message, limit: number = 8): Promise<string> {
  try {
    const channel = message.channel;
    if (!isFetchableChannel(channel)) return "";

    const messages = await channel.messages.fetch({
      before: message.id,
      limit,
    });

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

/**
 * Checks if a staff member (mod, dev, CM) already replied after the target
 * message -- in a regular channel, a thread, or a forum post thread.
 */
export async function checkStaffReplied(message: Message): Promise<boolean> {
  try {
    const channel = message.channel;
    if (!isFetchableChannel(channel)) return false;

    const after = await channel.messages.fetch({
      after: message.id,
      limit: 10,
    });

    const staffRoles = ["moderator", "mod", "developer", "dev", "community manager", "cm", "admin", "staff"];

    return after.some((m) => {
      if (m.author.bot) return false;
      const member = m.member;
      if (!member) return false;
      return member.roles.cache.some((role) =>
        staffRoles.some((sr) => role.name.toLowerCase().includes(sr))
      );
    });
  } catch {
    return false;
  }
}

/**
 * Resolves a human-readable name for the message's location, handling
 * forum post threads (name = post title) and regular threads (parent name).
 */
export function resolveChannelName(message: Message): string {
  const channel = message.channel as any;
  if (channel?.isThread?.()) {
    const parentName = channel.parent?.name ? `${channel.parent.name}/` : "";
    return `${parentName}${channel.name}`;
  }
  return channel?.name || "unknown";
}
