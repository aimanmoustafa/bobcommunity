import { Message } from "discord.js";
import { prisma } from "../database";
import { sendExitReplyForward } from "./dmNotifier";
import { logger } from "../utils/logger";

/**
 * Fires for any message the bot receives in a DM channel (guild is null).
 * If the sender previously received an exit-feedback DM (tracked via
 * ExitDmRecipient), their reply gets forwarded to the configured DM
 * user(s) so it's never just sitting unseen in the bot's own inbox.
 * Anyone else's DM (a stranger, a current member testing something) is
 * simply ignored -- this is specifically exit-feedback reply tracking,
 * not a general-purpose DM relay.
 */
export async function handleExitDmReply(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!message.content || message.content.trim().length === 0) return;

  try {
    const recipient = await prisma.exitDmRecipient.findUnique({ where: { userId: message.author.id } });
    if (!recipient) {
      logger.debug("DM from a user with no exit-feedback record, ignoring", { userId: message.author.id });
      return;
    }

    await sendExitReplyForward(message.client, recipient.username, message.author.id, message.content);
    await prisma.exitDmRecipient.update({
      where: { userId: message.author.id },
      data: { repliedAt: new Date() },
    });

    logger.info("Forwarded exit-feedback reply", { username: recipient.username });
  } catch (error) {
    logger.error("Failed to handle exit DM reply", error);
  }
}
