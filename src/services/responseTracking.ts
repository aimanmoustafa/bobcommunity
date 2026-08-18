import { Message } from "discord.js";
import { prisma } from "../database";
import { config } from "../config";
import { logger } from "../utils/logger";
import { isStaffMember } from "./context";

/**
 * Called for every message in a watched channel. If the author is staff,
 * checks whether there are any still-pending "needs reply" feedback items
 * in the same channel posted before this message, and if so, marks them
 * answered with a real response-time measurement.
 *
 * This catches replies at ANY point after classification -- unlike
 * checkStaffReplied (used at classification time), which only looks a few
 * messages ahead. A staff member replying hours later, even with a short
 * message that itself gets filtered out as noise, still gets credited here.
 */
export async function checkForLiveStaffReply(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!isStaffMember(message.member)) return;

  try {
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

    for (const item of pending) {
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

    logger.debug("Marked feedback as replied via live staff detection", {
      channelId: message.channel.id,
      count: pending.length,
      staffMember: message.author.username,
    });
  } catch (error) {
    logger.debug("Failed to check for live staff reply (non-fatal)", error);
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
