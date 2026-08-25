import { Message } from "discord.js";
import { prisma } from "../database";
import { sendExitReplyForward } from "./dmNotifier";
import { logger } from "../utils/logger";

export async function handleExitDmReply(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!message.content || message.content.trim().length === 0) return;

  try {
    const recipient = await prisma.exitDmRecipient.findUnique({ where: { userId: message.author.id } });
    if (!recipient) {
      logger.debug("DM from a user with no exit-feedback record, ignoring", { userId: message.author.id });
      return;
    }

    await sendExitReplyForward(message.client, recipient.username, message.author.id, message.content, message.createdAt);
    await prisma.exitDmRecipient.update({ where: { userId: message.author.id }, data: { repliedAt: new Date() } });

    logger.info("Forwarded exit-feedback reply", { username: recipient.username });
  } catch (error) {
    logger.error("Failed to handle exit DM reply", error);
  }
}
