import { prisma } from "../database";
import { logger } from "../utils/logger";
import { attachToIssue } from "./issues";
import { recordCategoryMention, checkTrend } from "./trends";
import { getAiHealthWarning } from "./aiHealth";
import { generateExecutiveSummary } from "../ai/analyzer";
import { getAverageResponseTimeMinutes, formatResponseTime } from "./responseTracking";
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
    // Group into a living issue. Includes suggestion/feature_request/praise
    // now too (not just bugs/complaints), so recurring requests and repeated
    // praise cluster in the digest the same way bug reports do, instead of
    // showing up as separate lines every time.
    const ISSUE_CATEGORIES = [
      "bug_report", "balance", "hero_feedback", "matchmaking", "monetization",
      "ui_ux", "performance", "complaint", "exploit", "localization",
      "store", "progression", "suggestion", "feature_request", "praise",
    ];
    let issueId: string | null = null;
    if (ISSUE_CATEGORIES.includes(input.analysis.category)) {
      issueId = await attachToIssue(input.analysis, input.authorId, input.authorName, input.messageLink);
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
  sentiment?: string;
  needsReply?: string;
  search?: string;
  days?: number;
  from?: Date;
  to?: Date;
}) {
  const where: any = {};

  if (filters.category) where.category = filters.category;
  if (filters.urgency) where.urgency = filters.urgency;
  if (filters.sentiment) where.sentiment = filters.sentiment;
  if (filters.needsReply) where.needsReply = filters.needsReply;
  if (filters.search) {
    where.OR = [
      { content: { contains: filters.search, mode: "insensitive" } },
      { aiSummary: { contains: filters.search, mode: "insensitive" } },
      { tags: { has: filters.search.toLowerCase() } },
    ];
  }
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = filters.from;
    if (filters.to) where.createdAt.lte = filters.to;
  } else if (filters.days) {
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
  const healthWarning = await getAiHealthWarning();

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(startOfDay.getTime() - 24 * 60 * 60 * 1000);

  const todayRows = await prisma.feedback.findMany({
    where: { createdAt: { gte: startOfDay } },
    select: {
      messageId: true,
      category: true,
      aiSummary: true,
      content: true,
      authorId: true,
      authorName: true,
      messageLink: true,
      urgency: true,
      needsReply: true,
      issueId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  type Row = (typeof todayRows)[number];

  const feedbackFeature = todayRows.filter((r) => ["suggestion", "feature_request"].includes(r.category));
  const complaints = todayRows.filter((r) => r.category === "complaint");
  const payment = todayRows.filter((r) => r.category === "monetization");
  const praise = todayRows.filter((r) => r.category === "praise");
  const needsAttention = todayRows.filter((r) => r.urgency === "high" || r.urgency === "critical");
  const needsReplySection = todayRows.filter((r) => r.needsReply === "yes");

  // --- Clustering: group today's rows sharing the same tracked Issue, so
  // 5 reports of the same bug/suggestion show as one line, not 5. ---
  function clusterRows(rows: Row[]): Row[][] {
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const key = r.issueId || `single:${r.messageId}`;
      const existing = groups.get(key);
      if (existing) existing.push(r);
      else groups.set(key, [r]);
    }
    return [...groups.values()].sort((a, b) => b.length - a.length);
  }

  // Assignment/follow-up info for any issues touched today, so the digest
  // can show "assigned to X" / "follow-up flagged" the way a human triager would.
  const touchedIssueIds = [...new Set(todayRows.map((r) => r.issueId).filter((id): id is string => !!id))];
  const issueMetaMap = new Map<string, { assignedTo: string | null; followUpFlagged: boolean }>();
  if (touchedIssueIds.length > 0) {
    const issues = await prisma.issue.findMany({
      where: { id: { in: touchedIssueIds } },
      select: { id: true, assignedTo: true, followUpFlagged: true },
    });
    for (const i of issues) issueMetaMap.set(i.id, { assignedTo: i.assignedTo, followUpFlagged: i.followUpFlagged });
  }

  function renderClusterBullet(group: Row[]): string {
    const latest = group[group.length - 1];
    const uniqueAuthors = new Set(group.map((r) => r.authorId)).size;
    const summary = truncateSummary(latest.aiSummary || latest.content);

    let line: string;
    if (group.length === 1) {
      line = `• ${summary} *${latest.authorName}*, [Discord](${latest.messageLink})`;
    } else {
      line = `• ${summary} — ${group.length} reports, ${uniqueAuthors} player${uniqueAuthors === 1 ? "" : "s"}. Latest: *${latest.authorName}*, [Discord](${latest.messageLink})`;
    }

    const meta = latest.issueId ? issueMetaMap.get(latest.issueId) : undefined;
    if (meta?.assignedTo) line += ` — assigned to ${meta.assignedTo}`;
    if (meta?.followUpFlagged) line += ` 🚩 follow-up flagged`;

    return line;
  }

  // Renders a section: clusters, caps at `limit` (sorted by cluster size),
  // and appends a "+N more" pointer if truncated.
  function renderSection(rows: Row[], limit: number = 5): string {
    if (rows.length === 0) return "";
    const clusters = clusterRows(rows);
    const shown = clusters.slice(0, limit);
    const lines = shown.map(renderClusterBullet).join("\n");
    const remaining = clusters.length - shown.length;
    return remaining > 0 ? `${lines}\n_+${remaining} more cluster${remaining === 1 ? "" : "s"} today — run /feedback today for the full list._` : lines;
  }

  async function yesterdayCountFor(categories: string[]): Promise<number> {
    const rows = await prisma.dailyCategoryCount.findMany({
      where: { date: yesterdayStart, category: { in: categories } },
    });
    return rows.reduce((sum, r) => sum + r.count, 0);
  }

  async function sectionHeader(emoji: string, label: string, rows: Row[], categories: string[]): Promise<string> {
    const yesterday = await yesterdayCountFor(categories);
    const delta = formatDelta(rows.length, yesterday, "vs yesterday");
    const countPart = rows.length > 0 || yesterday > 0 ? ` (${rows.length}${delta ? `, ${delta.slice(1, -1)}` : ""})` : "";
    return `${emoji} *${label}${countPart}*`;
  }

  let report = healthWarning ? `${healthWarning}\n\n` : "";
  report += `*Daily digest — community feedback, complaints & payments — ${formatDigestDate(new Date())}*\n`;
  report += `${todayRows.length} item${todayRows.length === 1 ? "" : "s"}, ${payment.length === 0 ? "no payment failures" : `${payment.length} payment issue${payment.length === 1 ? "" : "s"}`}.\n\n`;

  report += `${await sectionHeader("📣", "Feedback & feature requests", feedbackFeature, ["suggestion", "feature_request"])}\n`;
  report += feedbackFeature.length > 0 ? renderSection(feedbackFeature) : "No new suggestions today.";
  report += "\n\n";

  report += `${await sectionHeader("⚠️", "Complaints", complaints, ["complaint"])}\n`;
  report += complaints.length > 0 ? renderSection(complaints) : "No new complaints today.";
  report += "\n\n";

  report += `${await sectionHeader("❤️", "Community Praise", praise, ["praise"])}\n`;
  report += praise.length > 0 ? renderSection(praise) : "No new praise today.";
  report += "\n\n";

  report += `${await sectionHeader("💳", "Payment issues", payment, ["monetization"])}\n`;
  if (payment.length > 0) {
    report += renderSection(payment);
  } else {
    const openPaymentIssue = await prisma.issue.findFirst({
      where: { category: "monetization", status: { in: ["new", "investigating", "acknowledged", "in_progress"] } },
      orderBy: { lastReported: "desc" },
    });
    report += openPaymentIssue
      ? `Nothing new. "${openPaymentIssue.title.slice(0, 70)}" is still the only open ticket.`
      : "Nothing new. No open payment tickets.";
  }
  report += "\n";

  if (needsReplySection.length > 0) {
    report += `\n🕑 *Needs a reply (${needsReplySection.length})*\n`;
    report += renderSection(needsReplySection);
    report += "\n";
  }

  if (needsAttention.length > 0) {
    report += `\n🔥 *Needs attention*\n`;
    report += renderSection(needsAttention);
    report += "\n";
  }

  if (!healthWarning) {
    const stats = await getStats(1);
    const sentimentMap = Object.fromEntries(
      stats.bySentiment.map((s: { sentiment: string; count: number }) => [s.sentiment, s.count])
    );
    const total = stats.totalFeedback || 1;
    const posPercent = Math.round(((sentimentMap["positive"] || 0) / total) * 100);
    const negPercent = Math.round(
      (((sentimentMap["negative"] || 0) + (sentimentMap["frustrated"] || 0) + (sentimentMap["angry"] || 0)) / total) * 100
    );

    const snapshot =
      `Total feedback today: ${todayRows.length}. Feature requests/suggestions: ${feedbackFeature.length}. ` +
      `Complaints: ${complaints.length}. Payment issues: ${payment.length}. Praise: ${praise.length}. High/critical items: ${needsAttention.length}. ` +
      `Unanswered: ${stats.unansweredCount}. Sentiment: ${posPercent}% positive, ${negPercent}% negative.`;
    const aiTake = await generateExecutiveSummary(snapshot);
    if (aiTake) report += `\n🤖 *AI Take:*\n${aiTake}\n`;
  }

  return report;
}

function truncateSummary(text: string, max: number = 140): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "..." : clean;
}

function formatDigestDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export async function generateWeeklyReport(): Promise<string> {
  const healthWarning = await getAiHealthWarning();
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
  const wow = (current: number, prev: number): string => formatDelta(current, prev, "WoW");

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

  let report = healthWarning ? `${healthWarning}\n\n` : "";
  report += `*Weekly Community Report*\n\n`;
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

  if (!healthWarning) {
    const topIssuesText = openIssues
      .map((i: { priority: string; title: string; mentionCount: number }) => `${i.title} (${i.priority}, ${i.mentionCount} mentions)`)
      .join("; ") || "none";
    const snapshot =
      `Total feedback: ${stats.totalFeedback} (${wow(stats.totalFeedback, prevStats.totalFeedback)} vs last week). ` +
      `Unanswered: ${stats.unansweredCount}. Critical issues: ${criticalCount}. ` +
      `Top categories: ${topCategories.map((c: { category: string; count: number }) => `${c.category} (${c.count})`).join(", ") || "none"}. ` +
      `Open tracked issues: ${topIssuesText}. ` +
      `Sentiment: ${posPercent}% positive, ${negPercent}% negative.`;
    const aiTake = await generateExecutiveSummary(snapshot);
    if (aiTake) report += `\n🤖 *AI Take:*\n${aiTake}\n`;
  }

  return report;
}

/**
 * Pulls everything mentioning a specific hero, feature, or keyword across
 * time (default 30 days) and synthesizes a topic-level view: total
 * mentions, unique players, sentiment split, and representative quotes
 * with links -- useful for balance/feature discussions where you want
 * "everything about X" rather than a time-window digest.
 */
export async function generateTopicReport(topic: string, days: number = 30): Promise<string> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await prisma.feedback.findMany({
    where: {
      createdAt: { gte: since },
      OR: [
        { content: { contains: topic, mode: "insensitive" } },
        { aiSummary: { contains: topic, mode: "insensitive" } },
        { tags: { has: topic.toLowerCase() } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  if (rows.length === 0) {
    return `No mentions of "${topic}" found in the last ${days} days.`;
  }

  const uniqueAuthors = new Set(rows.map((r) => r.authorId)).size;
  const sentimentCounts = new Map<string, number>();
  for (const r of rows) sentimentCounts.set(r.sentiment, (sentimentCounts.get(r.sentiment) || 0) + 1);
  const negCount = (sentimentCounts.get("negative") || 0) + (sentimentCounts.get("frustrated") || 0) + (sentimentCounts.get("angry") || 0);
  const posCount = (sentimentCounts.get("positive") || 0) + (sentimentCounts.get("excited") || 0);

  const relatedIssues = await prisma.issue.findMany({
    where: {
      OR: [
        { title: { contains: topic, mode: "insensitive" } },
        { latestSummary: { contains: topic, mode: "insensitive" } },
      ],
      status: { in: ["new", "investigating", "acknowledged", "in_progress"] },
    },
    orderBy: { mentionCount: "desc" },
    take: 3,
  });

  let report = `*Topic: "${topic}"* (last ${days} days)\n\n`;
  report += `*${rows.length}* mentions from *${uniqueAuthors}* unique player${uniqueAuthors === 1 ? "" : "s"}\n`;
  report += `Sentiment: ${posCount} positive, ${negCount} negative, ${rows.length - posCount - negCount} neutral/other\n\n`;

  if (relatedIssues.length > 0) {
    report += `*Tracked issues:*\n`;
    for (const issue of relatedIssues) {
      report += `  - [${issue.priority.toUpperCase()}] ${issue.title.slice(0, 80)} (${issue.mentionCount} mentions, status: ${issue.status})\n`;
    }
    report += "\n";
  }

  report += `*Representative quotes:*\n`;
  for (const r of rows.slice(0, 5)) {
    report += `• ${truncateSummary(r.aiSummary || r.content, 150)} -- *${r.authorName}*, [Discord](${r.messageLink})\n`;
  }

  const snapshot = `Topic "${topic}": ${rows.length} mentions, ${uniqueAuthors} unique players. Sentiment: ${posCount} positive, ${negCount} negative. ${relatedIssues.length > 0 ? `Tracked issues: ${relatedIssues.map((i) => i.title).join("; ")}.` : ""}`;
  const aiTake = await generateExecutiveSummary(snapshot);
  if (aiTake) report += `\n🤖 *AI Take:*\n${aiTake}\n`;

  return report;
}

/**
 * A personal action-item queue: everything still needing a reply, plus
 * any issue explicitly flagged for follow-up (via /community assign),
 * sorted by urgency then age, so nothing sits split between Slack alerts
 * and Discord without a single place to check "what do I still owe".
 */
export async function generateTodoQueue(): Promise<string> {
  const pending = await prisma.feedback.findMany({
    where: { needsReply: "yes", replyStatus: "pending" },
    orderBy: [{ urgency: "desc" }, { createdAt: "asc" }],
    take: 15,
  });

  const flaggedIssues = await prisma.issue.findMany({
    where: { followUpFlagged: true, status: { in: ["new", "investigating", "acknowledged", "in_progress"] } },
    orderBy: { lastReported: "desc" },
    take: 10,
  });

  if (pending.length === 0 && flaggedIssues.length === 0) {
    return "Nothing on your queue right now -- all caught up. 🎉";
  }

  const urgencyRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sortedPending = [...pending].sort((a, b) => (urgencyRank[a.urgency] ?? 3) - (urgencyRank[b.urgency] ?? 3));

  let report = `*Your Action Queue*\n\n`;

  if (sortedPending.length > 0) {
    report += `🕑 *Needs a reply (${sortedPending.length})*\n`;
    for (const item of sortedPending) {
      const ageHours = Math.round((Date.now() - item.createdAt.getTime()) / (60 * 60 * 1000));
      report += `• [${item.urgency.toUpperCase()}] ${truncateSummary(item.aiSummary || item.content, 120)} -- *${item.authorName}* (${ageHours}h ago), [Discord](${item.messageLink})\n`;
    }
    report += "\n";
  }

  if (flaggedIssues.length > 0) {
    report += `🚩 *Flagged for follow-up (${flaggedIssues.length})*\n`;
    for (const issue of flaggedIssues) {
      report += `• [${issue.priority.toUpperCase()}] ${issue.title.slice(0, 80)}${issue.assignedTo ? ` -- assigned to ${issue.assignedTo}` : ""} (${issue.mentionCount} mentions)\n`;
    }
  }

  return report;
}

export async function generatePulse(hours: number = 6): Promise<string> {
  const healthWarning = await getAiHealthWarning();
  const now = new Date();
  const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const stats = await getStatsRange(from, now);

  const sentimentMap = Object.fromEntries(stats.bySentiment.map((s: { sentiment: string; count: number }) => [s.sentiment, s.count]));
  const total = stats.totalFeedback || 1;
  const negTotal = (sentimentMap["negative"] || 0) + (sentimentMap["frustrated"] || 0) + (sentimentMap["angry"] || 0);
  const posTotal = sentimentMap["positive"] || 0;
  const overallSentiment =
    negTotal > posTotal * 1.5 ? "Negative" : posTotal > negTotal * 1.5 ? "Positive" : "Mixed/Neutral";

  const topCategory = stats.byCategory[0];
  const urgentCount =
    (stats.byUrgency.find((u: { urgency: string; count: number }) => u.urgency === "high")?.count || 0) +
    (stats.byUrgency.find((u: { urgency: string; count: number }) => u.urgency === "critical")?.count || 0);

  const openIssues = await prisma.issue.findMany({
    where: {
      status: { in: ["new", "investigating", "acknowledged", "in_progress"] },
      lastReported: { gte: from },
    },
    orderBy: { mentionCount: "desc" },
    take: 1,
  });

  let report = healthWarning ? `${healthWarning}\n\n` : "";
  report += `*Community Pulse — Last ${hours} Hours*\n\n`;
  report += `*Overall sentiment:* ${overallSentiment}\n\n`;

  if (topCategory) {
    report += `*Main discussion:* ${formatCategory(topCategory.category)} (${topCategory.count} mentions)\n`;
  }
  if (openIssues.length > 0) {
    report += `*Emerging issue:* ${openIssues[0].title.slice(0, 80)} (${openIssues[0].mentionCount} mentions, ${openIssues[0].uniqueUserIds.length} players)\n`;
  }

  report += `\n*${stats.totalFeedback}* feedback items | *${urgentCount}* high/critical | *${stats.unansweredCount}* still need a reply\n`;

  const avgResponseTime = await getAverageResponseTimeMinutes(7);
  if (avgResponseTime !== null) {
    report += `*Avg response time (7d):* ${formatResponseTime(avgResponseTime)}\n`;
  }

  if (urgentCount === 0) {
    report += `\nNo major incidents detected.`;
  }

  if (!healthWarning) {
    const snapshot =
      `Window: last ${hours} hours. Total feedback: ${stats.totalFeedback}. High/critical: ${urgentCount}. ` +
      `Unanswered: ${stats.unansweredCount}. Overall sentiment: ${overallSentiment}. ` +
      `Top category: ${topCategory ? `${topCategory.category} (${topCategory.count})` : "none"}. ` +
      `Emerging issue: ${openIssues.length > 0 ? openIssues[0].title : "none"}.`;
    const aiTake = await generateExecutiveSummary(snapshot);
    if (aiTake) report += `\n\n🤖 *AI Take:* ${aiTake}`;
  }

  return report;
}

/**
 * Shared trend-delta formatter used by both the daily digest ("vs yesterday")
 * and the weekly report ("WoW"), so the two never drift into inconsistent
 * wording or rounding behavior.
 */
function formatDelta(current: number, previous: number, label: string): string {
  if (previous === 0) return current > 0 ? "(new)" : "";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return `(flat ${label})`;
  return pct > 0 ? `(+${pct}% ${label})` : `(${pct}% ${label})`;
}

function formatCategory(category: string): string {
  return category
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
