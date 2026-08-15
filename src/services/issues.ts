import { prisma } from "../database";
import { logger } from "../utils/logger";
import type { MessageAnalysis } from "../ai/analyzer";

const OPEN_STATUSES = ["new", "investigating", "acknowledged", "in_progress"];

// Issues stay "attachable" for this long after the last report.
// A matchmaking complaint 5 days after the last one is likely a new wave.
const ISSUE_ATTACH_WINDOW_HOURS = 72;

/**
 * Attaches a feedback item to an existing open issue for the same category,
 * or creates a new issue if none is active. Returns the issue ID.
 */
export async function attachToIssue(
  analysis: MessageAnalysis,
  authorId: string
): Promise<string | null> {
  try {
    const windowStart = new Date(Date.now() - ISSUE_ATTACH_WINDOW_HOURS * 60 * 60 * 1000);

    const existing = await prisma.issue.findFirst({
      where: {
        category: analysis.category,
        status: { in: OPEN_STATUSES },
        lastReported: { gte: windowStart },
      },
      orderBy: { lastReported: "desc" },
    });

    if (existing) {
      const uniqueUserIds = existing.uniqueUserIds.includes(authorId)
        ? existing.uniqueUserIds
        : [...existing.uniqueUserIds, authorId];

      const updated = await prisma.issue.update({
        where: { id: existing.id },
        data: {
          mentionCount: existing.mentionCount + 1,
          uniqueUserIds,
          latestSummary: analysis.aiSummary,
          lastReported: new Date(),
          priority: escalatePriority(existing.priority, analysis.urgency),
        },
      });
      return updated.id;
    }

    const created = await prisma.issue.create({
      data: {
        title: buildIssueTitle(analysis),
        category: analysis.category,
        priority: urgencyToPriority(analysis.urgency),
        status: "new",
        mentionCount: 1,
        uniqueUserIds: [authorId],
        sentiment: analysis.sentiment,
        latestSummary: analysis.aiSummary,
        recommendedAction: analysis.reason,
      },
    });

    logger.info("New issue created", { id: created.id, title: created.title });
    return created.id;
  } catch (error) {
    logger.error("Failed to attach feedback to issue", error);
    return null;
  }
}

export async function getIssues(filters: { status?: string; category?: string } = {}) {
  const where: any = {};
  if (filters.status) where.status = filters.status;
  if (filters.category) where.category = filters.category;

  return prisma.issue.findMany({
    where,
    orderBy: [{ lastReported: "desc" }],
    take: 50,
  });
}

const VALID_STATUSES = ["new", "investigating", "acknowledged", "in_progress", "resolved", "ignored"];

export async function updateIssueStatus(issueId: string, status: string) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}. Valid: ${VALID_STATUSES.join(", ")}`);
  }
  return prisma.issue.update({ where: { id: issueId }, data: { status } });
}

/**
 * Assigns an open issue to a named person (e.g. a developer) and optionally
 * flags it for follow-up, so the digest can surface "went to X, follow-up
 * flagged" the way a human triager would note it. Matches by a case-insensitive
 * substring of the issue title since Discord slash commands don't have a
 * clean way to pick from a live list of issue IDs.
 */
export async function assignIssue(
  searchTerm: string,
  assignee: string,
  flagFollowUp?: boolean
) {
  const issue = await prisma.issue.findFirst({
    where: {
      title: { contains: searchTerm, mode: "insensitive" },
      status: { in: OPEN_STATUSES },
    },
    orderBy: { lastReported: "desc" },
  });

  if (!issue) return null;

  return prisma.issue.update({
    where: { id: issue.id },
    data: {
      assignedTo: assignee,
      ...(flagFollowUp !== undefined ? { followUpFlagged: flagFollowUp } : {}),
    },
  });
}

function buildIssueTitle(analysis: MessageAnalysis): string {
  const cat = analysis.category
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const summary = analysis.aiSummary?.slice(0, 80) || "";
  return summary ? `${cat}: ${summary}` : cat;
}

function urgencyToPriority(urgency: string): string {
  switch (urgency) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    default:
      return "low";
  }
}

const PRIORITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function escalatePriority(current: string, newUrgency: string): string {
  const candidate = urgencyToPriority(newUrgency);
  return (PRIORITY_RANK[candidate] ?? 0) > (PRIORITY_RANK[current] ?? 0) ? candidate : current;
}
