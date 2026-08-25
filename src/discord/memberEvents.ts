import { GuildMember, PartialGuildMember } from "discord.js";
import { config } from "../config";
import { logger } from "../utils/logger";
import { logMemberExit } from "../slack/notifier";
import { prisma } from "../database";

/**
 * Fires when someone joins the server. Sends a short welcome DM whose real
 * purpose is opening a DM channel while a shared server clearly still
 * exists -- Discord tends to keep that channel usable later, even after
 * the person leaves, unlike trying to open one fresh at that point (which
 * Discord blocks outright once there's no longer a mutual server). This is
 * what actually makes the exit-feedback DM deliverable for more people,
 * not a trick -- just working with Discord's rule instead of against it.
 */
export async function handleMemberJoin(member: GuildMember): Promise<void> {
  const username = member.user?.username || member.id;

  try {
    await member.send(config.bot.welcomeMessage);
    logger.info("Welcome DM sent", { username });
  } catch (error: any) {
    logger.debug("Could not DM new member on join (DMs likely closed)", { username, error: error?.message });
  }
}

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
    logger.warn("Could not DM departing member (expected if no shared server / DMs closed)", { username, error: failureReason });
  }

  if (dmSent) {
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

  if (!config.bot.logMemberExitsToSlack) return;

  await logMemberExit({ username, userId: member.id, guildName: member.guild?.name || "Blitz of Battle", dmSent, failureReason });
}
