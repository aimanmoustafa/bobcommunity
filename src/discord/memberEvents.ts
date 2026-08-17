import { GuildMember, PartialGuildMember } from "discord.js";
import { config } from "../config";
import { logger } from "../utils/logger";
import { logMemberExit } from "../slack/notifier";
import { prisma } from "../database";

/**
 * Fires when someone leaves the Discord server.
 * Attempts to DM them the exit-feedback message. Whether that outcome
 * also gets posted to Slack is controlled by LOG_MEMBER_EXITS_TO_SLACK
 * (default off, so who-left events stay private to Discord).
 *
 * Note: Discord only allows a bot to DM a user if they still share a
 * server. Right after someone leaves, this can go either way depending
 * on timing -- so DM failures are expected sometimes, not a bug.
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

  if (dmSent) {
    // Remember them so a later reply in this DM channel can be recognized
    // as exit feedback and forwarded, instead of silently ignored.
    try {
      await prisma.exitDmRecipient.upsert({
        where: { userId: member.id },
        create: { userId: member.id, username },
        update: { username, sentAt: new Date(), repliedAt: null },
      });
    } catch (error) {
      logger.error("Failed to record exit DM recipient", error);
    }
  }

  if (!config.bot.logMemberExitsToSlack) {
    return;
  }

  await logMemberExit({
    username,
    userId: member.id,
    guildName: member.guild?.name || "Blitz of Battle",
    dmSent,
    failureReason,
  });
}
