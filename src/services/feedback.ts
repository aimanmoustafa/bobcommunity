import { prisma } from "../database";
import { logger } from "../utils/logger";
import { attachToIssue } from "./issues";
import { recordCategoryMention, checkTrend } from "./trends";
import type { MessageAnalysis } from "../ai/analyzer";

interface FeedbackInput {
  messageId: string;
  authorId: string;
  authorName: string;
  channelId: string;
  channelName: string;
  guildId: string;
  content: string;
  messageLink: string;
  analysis: MessageAnalysis;
  slackTs?: string;
}

export async function storeFeedback(input: FeedbackInput) {
  try {
    // Group into a living issue (only for actionable categories, not praise/questions)
    const ISSUE_CATEGORIES = [
      "bug_report", "balance", "hero_feedback", "matchmaking", "monetization",
      "ui_ux", "performance", "complaint", "exploit", "localization",
      "store", "progression",
    ];
    let issueId: string | null = null;
    if (ISSUE_CATEGORIES.includes(input.analysis.category)) {
      issueId = await attachToIssue(input.analysis, input.authorId);
    }

    const feedback = await prisma.feedback.create({
      data: {
        messageId: input.messageId,
        authorId: input.authorId,
        authorName: input.authorName,
        channelId: input.channelId,
        channelName: input.channelName,
        guildId: input.guildId,
        content: input.content,
        messageLink: input.messageLink,
        category: input.analysis.category,
        tags: input.analysis.tags,
        sentiment: input.analysis.sentiment,
        urgency: input.analysis.urgency,
        needsReply: input.analysis.needsReply,
        reason: input.analysis.reason,
        aiSummary: input.analysis.aiSummary,
        confidence: input.analysis.confidence,
        slackNotified: !!input.slackTs,
        slackTs: input.slackTs,
        issueId,
      },
    });

    // Track daily counts and check for trend spikes (fire-and-forget)
    recordCategoryMention(input.analysis.category)
      .then(() => checkTrend(input.analysis.category))
      .catch(() => {});

    logger.debug("Feedback stored", { id: feedback.id, category: feedback.category, issueId });
    return feedback;
  } catch (error: any) {
    // Duplicate message -- skip
    if (error?.code === "P2002") {
      logger.debug("Duplicate message, skipping", { messageId: input.messageId });
      return null;
    }
    logger.error("Failed to store feedback", error);
    throw error;
  }
}

export async function getFeedback(filters: {
  category?: string;
  urgency?: string;
  needsReply?: string;
  search?: string;
  days?: number;
}) {
  const where: any = {};

  if (filters.category) where.category = filters.category;
  if (filters.urgency) where.urgency = filters.urgency;
  if (filters.needsReply) where.needsReply = filters.needsReply;
  if (filters.search) {
    where.OR = [
      { content: { contains: filters.search, mode: "insensitive" } },
      { aiSummary: { contains: filters.search, mode: "insensitive" } },
      { tags: { has: filters.search.toLowerCase() } },
    ];
  }
  if (filters.days) {
    where.createdAt = {
      gte: new Date(Date.now() - filters.days * 24 * 60 * 60 * 1000),
    };
  }

  return prisma.feedback.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function getStats(days: number = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return getStatsRange(since, new Date());
}

export async function getStatsRange(from: Date, to: Date) {
  const range = { gte: from, lt: to };

  const [total, byCategory, bySentiment, byUrgency, needingReply] = await Promise.all([
    prisma.feedback.count({ where: { createdAt: range } }),
    prisma.feedback.groupBy({
      by: ["category"],
      _count: true,
      where: { createdAt: range },
      orderBy: { _count: { category: "desc" } },
    }),
    prisma.feedback.groupBy({
      by: ["sentiment"],
      _count: true,
      where: { createdAt: range },
    }),
    prisma.feedback.groupBy({
      by: ["urgency"],
      _count: true,
      where: { createdAt: range },
    }),
    prisma.feedback.count({
      where: { createdAt: range, needsReply: "yes", replyStatus: "pending" },
    }),
  ]);

  return {
    totalFeedback: total,
    byCategory: byCategory.map((r: { category: string; _count: number }) => ({ category: r.category, count: r._count })),
    bySentiment: bySentiment.map((r: { sentiment: string; _count: number }) => ({ sentiment: r.sentiment, count: r._count })),
    byUrgency: byUrgency.map((r: { urgency: string; _count: number }) => ({ urgency: r.urgency, count: r._count })),
    unansweredCount: needingReply,
  };
}

export async function generateDailyReport(): Promise<string> {
  const stats = await getStats(1);
  const topCategories = stats.byCategory.slice(0, 5);

  const sentimentMap = Object.fromEntries(
    stats.bySentiment.map((s: { sentiment: string; count: number }) => [s.sentiment, s.count])
  );
  const total = stats.totalFeedback || 1;

  const posPercent = Math.round(((sentimentMap["positive"] || 0) / total) * 100);
  const negPercent = Math.round(((sentimentMap["negative"] || 0) + (sentimentMap["frustrated"] || 0) + (sentimentMap["angry"] || 0)) / total * 100);
  const neutralPercent = 100 - posPercent - negPercent;

  const categoryCount = (cat: string) =>
    stats.byCategory.find((c: { category: string; count: number }) => c.category === cat)?.count || 0;

  const complaintCount = categoryCount("complaint");
  const paymentCount = categoryCount("monetization");

  let report = `*Today's Community Report*\n\n`;
  report += `*${stats.totalFeedback}* feedback items collected\n`;
  report += `*${stats.unansweredCount}* messages still need a reply\n\n`;

  report += `*Complaints:* ${complaintCount}\n`;
  report += `*Payment/Monetization issues:* ${paymentCount}\n\n`;

  report += `*Top Categories:*\n`;
  for (const cat of topCategories) {
    report += `  - ${formatCategory(cat.category)}: ${cat.count}\n`;
  }

  report += `\n*Sentiment:*\n`;
  report += `  ${posPercent}% Positive | ${neutralPercent}% Neutral | ${negPercent}% Negative\n`;

  return report;
}

export async function generateWeeklyReport(): Promise<string> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [stats, prevStats] = await Promise.all([
    getStatsRange(weekAgo, now),
    getStatsRange(twoWeeksAgo, weekAgo),
  ]);
  const topCategories = stats.byCategory.slice(0, 5);

  const sentimentMap = Object.fromEntries(stats.bySentiment.map((s: { sentiment: string; count: number }) => [s.sentiment, s.count]));
  const total = stats.totalFeedback || 1;
  const negTotal =
    (sentimentMap["negative"] || 0) + (sentimentMap["frustrated"] || 0) + (sentimentMap["angry"] || 0);
  const posPercent = Math.round(((sentimentMap["positive"] || 0) / total) * 100);
  const negPercent = Math.round((negTotal / total) * 100);

  // Week-over-week helpers
  const prevCategoryMap = Object.fromEntries(prevStats.byCategory.map((c: { category: string; count: number }) => [c.category, c.count]));
  const wow = (current: number, prev: number): string => {
    if (prev === 0) return current > 0 ? "(new)" : "";
    const pct = Math.round(((current - prev) / prev) * 100);
    return pct === 0 ? "(flat WoW)" : pct > 0 ? `(+${pct}% WoW)` : `(${pct}% WoW)`;
  };

  // Most requested feature: top tag among feature_request category
  const featureRequests = await prisma.feedback.findMany({
    where: {
      category: "feature_request",
      createdAt: { gte: weekAgo },
    },
    select: { tags: true },
  });
  const tagCounts = new Map<string, number>();
  for (const fr of featureRequests) {
    for (const tag of fr.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }
  const topFeature = [...tagCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  // Praise highlights: top tags among praise this week
  const praiseItems = await prisma.feedback.findMany({
    where: { category: "praise", createdAt: { gte: weekAgo } },
    select: { tags: true, aiSummary: true },
    orderBy: { createdAt: "desc" },
  });
  const praiseTagCounts = new Map<string, number>();
  for (const p of praiseItems) {
    for (const tag of p.tags) {
      praiseTagCounts.set(tag, (praiseTagCounts.get(tag) || 0) + 1);
    }
  }
  const topPraiseTags = [...praiseTagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  // Open issues from the issue tracker
  const openIssues = await prisma.issue.findMany({
    where: { status: { in: ["new", "investigating", "acknowledged", "in_progress"] } },
    orderBy: [{ mentionCount: "desc" }],
    take: 5,
  });

  let report = `*Weekly Community Report*\n\n`;
  report += `*${stats.totalFeedback}* feedback items ${wow(stats.totalFeedback, prevStats.totalFeedback)}\n`;
  report += `*${stats.unansweredCount}* items still awaiting reply\n\n`;

  report += `*Top Issues:*\n`;
  for (const cat of topCategories) {
    const prev = prevCategoryMap[cat.category] || 0;
    report += `  - ${formatCategory(cat.category)}: ${cat.count} ${wow(cat.count, prev)}\n`;
  }

  if (openIssues.length > 0) {
    report += `\n*Open Tracked Issues:*\n`;
    for (const issue of openIssues) {
      report += `  - [${issue.priority.toUpperCase()}] ${issue.title.slice(0, 70)} -- ${issue.mentionCount} mentions, ${issue.uniqueUserIds.length} unique players (${issue.status})\n`;
    }
  }

  if (topFeature) {
    report += `\n*Most Requested Feature:* ${topFeature[0]} (${topFeature[1]} mentions)\n`;
  }

  if (praiseItems.length > 0) {
    report += `\n❤️ *Community Praise:* ${praiseItems.length} positive mentions ${wow(praiseItems.length, prevCategoryMap["praise"] || 0)}\n`;
    if (topPraiseTags.length > 0) {
      report += `  Players love: ${topPraiseTags.map(([tag, count]) => `${tag} (${count})`).join(", ")}\n`;
    }
  }

  report += `\n*Sentiment:* ${posPercent}% Positive | ${negPercent}% Negative\n`;

  const criticalCount = stats.byUrgency.find((u: { urgency: string; count: number }) => u.urgency === "critical")?.count || 0;
  if (criticalCount > 0) {
    report += `\n⚠️ *${criticalCount}* critical issues this week -- worth a dev sync.\n`;
  }

  return report;
}

function formatCategory(category: string): string {
  return category
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
