import { Message } from "discord.js";
import { prisma } from "../database";
import { config } from "../config";
import { logger } from "../utils/logger";
import { isStaffMember } from "./context";

export async function checkForLiveStaffReply(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!isStaffMember(message.member)) return;

  try {
    const referencedMessageId = (message as any).reference?.messageId;

    if (referencedMessageId) {
      const directMatch = await prisma.feedback.findFirst({
        where: { messageId: referencedMessageId, needsReply: "yes", replyStatus: "pending" },
        select: { id: true, createdAt: true },
      });

      if (directMatch) {
        await markReplied([directMatch], message);
        logger.debug("Marked feedback as replied via precise Discord reply-to match", { referencedMessageId, staffMember: message.author.username });
        return;
      }
    }

    const pending = await prisma.feedback.findMany({
      where: { channelId: message.channel.id, needsReply: "yes", replyStatus: "pending", createdAt: { lt: message.createdAt } },
      select: { id: true, createdAt: true },
    });

    if (pending.length === 0) return;
    await markReplied(pending, message);

    logger.debug("Marked feedback as replied via channel-wide fallback (no precise reply link)", {
      channelId: message.channel.id, count: pending.length, staffMember: message.author.username,
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
      data: { replyStatus: "replied", respondedAt: message.createdAt, responseTimeMinutes, repliedBy: message.author.username },
    });
  }
}

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

export interface CategoryResponseTime {
  category: string;
  avgMinutes: number;
  count: number;
}

/**
 * Same average as getAverageResponseTimeMinutes, but broken out per
 * category -- a single blended figure hides that, say, payment issues get
 * answered in 10 minutes while balance feedback sits for two days. Sorted
 * slowest-first so the categories most worth attention surface at the top.
 */
export async function getResponseTimeByCategory(days: number = 7): Promise<CategoryResponseTime[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.feedback.findMany({
    where: { respondedAt: { gte: since }, responseTimeMinutes: { not: null } },
    select: { category: true, responseTimeMinutes: true },
  });

  if (rows.length === 0) return [];

  const byCategory = new Map<string, number[]>();
  for (const r of rows) {
    const list = byCategory.get(r.category) || [];
    list.push(r.responseTimeMinutes || 0);
    byCategory.set(r.category, list);
  }

  const result: CategoryResponseTime[] = [...byCategory.entries()].map(([category, times]) => ({
    category,
    avgMinutes: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
    count: times.length,
  }));

  return result.sort((a, b) => b.avgMinutes - a.avgMinutes);
}

export function formatResponseTime(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export interface StaleItem {
  id: string; authorName: string; aiSummary: string | null; content: string;
  messageLink: string; category: string; urgency: string; ageHours: number;
}

export async function findStaleItems(): Promise<StaleItem[]> {
  const cutoff = new Date(Date.now() - config.bot.staleReplyHours * 60 * 60 * 1000);

  const rows = await prisma.feedback.findMany({
    where: { needsReply: "yes", replyStatus: "pending", staleAlertSent: false, createdAt: { lt: cutoff } },
    orderBy: { createdAt: "asc" },
    take: 20,
  });

  return rows.map((r) => ({
    id: r.id, authorName: r.authorName, aiSummary: r.aiSummary, content: r.content,
    messageLink: r.messageLink, category: r.category, urgency: r.urgency,
    ageHours: Math.round((Date.now() - r.createdAt.getTime()) / (60 * 60 * 1000)),
  }));
}

export async function markStaleAlertSent(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.feedback.updateMany({ where: { id: { in: ids } }, data: { staleAlertSent: true } });
}
