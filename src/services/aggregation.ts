import { prisma } from "../database";
import { config } from "../config";
import { logger } from "../utils/logger";

export interface AggregationResult {
  isNewGroup: boolean;
  reporterCount: number;
  existingSlackTs?: string;
  existingSlackChannel?: string;
  groupKey: string;
}

/**
 * Tracks feedback by category+channel over a rolling window.
 * - First report in the window -> new Slack alert, new group created.
 * - Subsequent reports on the same issue within the window -> existing
 *   Slack message gets UPDATED (via chat.update) instead of a new post,
 *   and the reporter count increments.
 * Critical urgency always creates its own alert (bypasses grouping).
 */
export async function registerReport(
  category: string,
  channelId: string,
  authorId: string,
  urgency: string,
  aiSummary: string
): Promise<AggregationResult> {
  const key = `${category}:${channelId}`;
  const now = new Date();

  const existing = await prisma.aggregationGroup.findUnique({ where: { key } });

  if (existing && existing.expiresAt > now) {
    const reporterIds = existing.reporterIds.includes(authorId)
      ? existing.reporterIds
      : [...existing.reporterIds, authorId];

    const updated = await prisma.aggregationGroup.update({
      where: { key },
      data: {
        reporterCount: reporterIds.length,
        reporterIds,
        latestSummary: aiSummary,
        latestUrgency: urgency,
        // Extend window slightly so an actively-discussed issue stays grouped
        expiresAt: new Date(now.getTime() + config.bot.aggregationWindowMinutes * 60 * 1000),
      },
    });

    logger.debug("Aggregation group updated", { key, reporterCount: updated.reporterCount });

    return {
      isNewGroup: false,
      reporterCount: updated.reporterCount,
      existingSlackTs: updated.slackTs || undefined,
      existingSlackChannel: updated.slackChannel || undefined,
      groupKey: key,
    };
  }

  // New group
  const expiresAt = new Date(now.getTime() + config.bot.aggregationWindowMinutes * 60 * 1000);
  await prisma.aggregationGroup.upsert({
    where: { key },
    create: {
      key,
      category,
      channelId,
      reporterCount: 1,
      reporterIds: [authorId],
      latestSummary: aiSummary,
      latestUrgency: urgency,
      expiresAt,
    },
    update: {
      reporterCount: 1,
      reporterIds: [authorId],
      latestSummary: aiSummary,
      latestUrgency: urgency,
      expiresAt,
      slackTs: null,
      slackChannel: null,
    },
  });

  return { isNewGroup: true, reporterCount: 1, groupKey: key };
}

export async function saveSlackTs(groupKey: string, slackTs: string, slackChannel: string): Promise<void> {
  try {
    await prisma.aggregationGroup.update({
      where: { key: groupKey },
      data: { slackTs, slackChannel },
    });
  } catch (error) {
    logger.error("Failed to save Slack ts to aggregation group", error);
  }
}

/**
 * A parallel long cooldown (separate from aggregation) still applies once a
 * group's window fully expires, so a resolved issue that resurfaces hours
 * later gets a fresh alert rather than silently reusing an old dead group.
 * This is handled naturally since expiresAt controls the group lifecycle --
 * no separate table needed anymore.
 */
export function shouldBypassAggregation(urgency: string): boolean {
  return urgency === "critical";
}
