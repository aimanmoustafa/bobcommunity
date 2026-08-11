import { GuildMember, PartialGuildMember } from "discord.js";
import { config } from "../config";
import { logger } from "../utils/logger";
import { logMemberExit } from "../slack/notifier";

/**
 * Fires when someone leaves the Discord server.
 * Attempts to DM them the exit-feedback message, then logs the outcome
 * to Slack regardless of whether the DM succeeded.
 *
 * Note: Discord only allows a bot to DM a user if they still share a
 * server. Right after someone leaves, this can go either way depending
 * on timing -- so failures here are expected sometimes, not a bug.
 */
export async function handleMemberLeave(member: GuildMember | PartialGuildMember): Promise<void> {
  const username = member.user?.username || member.id;
  let dmSent = false;
  let failureReason: string | undefined;

  try {
    await member.send(config.bot.exitMessage);
    dmSent = true;
    logger.info("Exit DM sent", { username });
  } catch (error: any) {
    failureReason = error?.message || "Unknown error";
    logger.warn("Could not DM departing member (expected if no shared server / DMs closed)", {
      username,
      error: failureReason,
    });
  }

  await logMemberExit({
    username,
    userId: member.id,
    guildName: member.guild?.name || "Blitz of Battle",
    dmSent,
    failureReason,
  });
}
