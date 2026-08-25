import { prisma } from "../database";
import { config } from "../config";

export interface AggregationResult {
  groupKey: string;
  isNewGroup: boolean;
  reporterCount: number;
  existingSlackTs?: string | null;
  existingSlackChannel?: string | null;
}

export function shouldBypassAggregation(urgency: string): boolean {
  return urgency === "critical";
}

export async function registerReport(
  category: string,
  channelId: string,
  authorId: string,
  urgency: string,
  summary: string
): Promise<AggregationResult> {
  const key = `${category}:${channelId}`;
  const now = new Date();
  const windowMs = config.bot.aggregationWindowMinutes * 60 * 1000;

  const existing = await prisma.aggregationGroup.findUnique({ where: { key } });

  if (existing && existing.expiresAt.getTime() > now.getTime()) {
    const reporterIds = existing.reporterIds.includes(authorId) ? existing.reporterIds : [...existing.reporterIds, authorId];
    const updated = await prisma.aggregationGroup.update({
      where: { key },
      data: {
        reporterCount: reporterIds.length,
        reporterIds,
        latestSummary: summary,
        latestUrgency: urgency,
        expiresAt: new Date(now.getTime() + windowMs),
      },
    });
    return {
      groupKey: key,
      isNewGroup: false,
      reporterCount: updated.reporterCount,
      existingSlackTs: updated.slackTs,
      existingSlackChannel: updated.slackChannel,
    };
  }

  const created = await prisma.aggregationGroup.upsert({
    where: { key },
    create: {
      key,
      category,
      channelId,
      reporterCount: 1,
      reporterIds: [authorId],
      latestSummary: summary,
      latestUrgency: urgency,
      expiresAt: new Date(now.getTime() + windowMs),
    },
    update: {
      reporterCount: 1,
      reporterIds: [authorId],
      latestSummary: summary,
      latestUrgency: urgency,
      expiresAt: new Date(now.getTime() + windowMs),
      slackTs: null,
      slackChannel: null,
    },
  });

  return { groupKey: key, isNewGroup: true, reporterCount: created.reporterCount };
}

export async function saveSlackTs(groupKey: string, slackTs: string, slackChannel: string): Promise<void> {
  await prisma.aggregationGroup.update({ where: { key: groupKey }, data: { slackTs, slackChannel } });
}
