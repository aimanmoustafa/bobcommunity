import { Message } from "discord.js";
import { prisma } from "../database";
import { config } from "../config";
import { logger } from "../utils/logger";
import { isStaffMember } from "./context";

/**
 * Called for every message in a watched channel. If the author is staff,
 * tries two ways to find what they answered:
 *
 * 1. PRECISE: if this message is a genuine Discord reply (the reply-arrow
 *    feature, quoting a specific message) to a message that's a pending
 *    feedback item, mark ONLY that exact item as replied.
 * 2. FALLBACK: if it's not a precise reply (or the quoted message isn't a
 *    pending item), fall back to the broader "staff said something in this
 *    channel" heuristic, marking every still-pending item in that channel.
 *
 * The precise path is the accurate one; the fallback exists so a staff
 * member who just types a normal answer (without using Discord's reply
 * feature) still gets credited, at the cost of being less exact when
 * multiple unrelated items are pending in the same channel at once.
 */
export async function checkForLiveStaffReply(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!isStaffMember(message.member)) return;

  try {
    const referencedMessageId = message.reference?.messageId;

    if (referencedMessageId) {
      const directMatch = await prisma.feedback.findFirst({
        where: { messageId: referencedMessageId, needsReply: "yes", replyStatus: "pending" },
        select: { id: true, createdAt: true },
      });

      if (directMatch) {
        await markReplied([directMatch], message);
        logger.debug("Marked feedback as replied via precise Discord reply-to match", {
          referencedMessageId,
          staffMember: message.author.username,
        });
        return; // precise match handled -- skip the broader fallback entirely
      }
    }

    const pending = await prisma.feedback.findMany({
      where: {
        channelId: message.channel.id,
        needsReply: "yes",
        replyStatus: "pending",
        createdAt: { lt: message.createdAt },
      },
      select: { id: true, createdAt: true },
    });

    if (pending.length === 0) return;

    await markReplied(pending, message);

    logger.debug("Marked feedback as replied via channel-wide fallback (no precise reply link)", {
      channelId: message.channel.id,
      count: pending.length,
      staffMember: message.author.username,
    });
  } catch (error) {
    logger.debug("Failed to check for live staff reply (non-fatal)", error);
  }
}

async function markReplied(items: { id: string; createdAt: Date }[], message: Message): Promise<void> {
  for (const item of items) {
    const responseTimeMinutes = Math.round((message.createdAt.getTime() - item.createdAt.getTime()) / 60000);
    await prisma.feedback.update({
      where: { id: item.id },
      data: {
        replyStatus: "replied",
        respondedAt: message.createdAt,
        responseTimeMinutes,
        repliedBy: message.author.username,
      },
    });
  }
}

/**
 * Average response time (in minutes) for items answered within the window.
 * Returns null if nothing has been answered yet -- distinct from 0, which
 * would misleadingly suggest instant replies.
 */
export async function getAverageResponseTimeMinutes(days: number = 7): Promise<number | null> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.feedback.findMany({
    where: { respondedAt: { gte: since }, responseTimeMinutes: { not: null } },
    select: { responseTimeMinutes: true },
  });

  if (rows.length === 0) return null;
  const total = rows.reduce((sum, r) => sum + (r.responseTimeMinutes || 0), 0);
  return Math.round(total / rows.length);
}

export function formatResponseTime(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export interface StaleItem {
  id: string;
  authorName: string;
  aiSummary: string | null;
  content: string;
  messageLink: string;
  category: string;
  urgency: string;
  ageHours: number;
}

/**
 * Finds "needs reply" items that have been pending longer than the
 * configured threshold and haven't already triggered a stale alert.
 * Marking staleAlertSent afterward (done by the caller) prevents this
 * from re-alerting on the same item every scheduler tick.
 */
export async function findStaleItems(): Promise<StaleItem[]> {
  const cutoff = new Date(Date.now() - config.bot.staleReplyHours * 60 * 60 * 1000);

  const rows = await prisma.feedback.findMany({
    where: {
      needsReply: "yes",
      replyStatus: "pending",
      staleAlertSent: false,
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: "asc" },
    take: 20,
  });

  return rows.map((r) => ({
    id: r.id,
    authorName: r.authorName,
    aiSummary: r.aiSummary,
    content: r.content,
    messageLink: r.messageLink,
    category: r.category,
    urgency: r.urgency,
    ageHours: Math.round((Date.now() - r.createdAt.getTime()) / (60 * 60 * 1000)),
  }));
}

export async function markStaleAlertSent(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.feedback.updateMany({
    where: { id: { in: ids } },
    data: { staleAlertSent: true },
  });
}
