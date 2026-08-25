import { prisma } from "../database";
import { logger } from "../utils/logger";
import { createNotionEntry, updateNotionEntryForEscalation } from "./notion";
import type { MessageAnalysis } from "../ai/analyzer";

const OPEN_STATUSES = ["new", "investigating", "acknowledged", "in_progress"];
const VALID_STATUSES = [...OPEN_STATUSES, "resolved", "ignored"];
const ISSUE_ATTACH_WINDOW_HOURS = 72;

function buildIssueTitle(analysis: MessageAnalysis): string {
  const categoryLabel = analysis.category.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return `${categoryLabel}: ${analysis.aiSummary}`.slice(0, 100);
}

function urgencyToPriority(urgency: string): string {
  return urgency;
}

function escalatePriority(currentPriority: string, newUrgency: string): string {
  const rank: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  return (rank[newUrgency] ?? 0) > (rank[currentPriority] ?? 0) ? newUrgency : currentPriority;
}

export async function attachToIssue(
  analysis: MessageAnalysis,
  authorId: string,
  authorName: string,
  messageLink: string
): Promise<string | null> {
  try {
    const windowStart = new Date(Date.now() - ISSUE_ATTACH_WINDOW_HOURS * 60 * 60 * 1000);

    const existing = await prisma.issue.findFirst({
      where: { category: analysis.category, status: { in: OPEN_STATUSES }, lastReported: { gte: windowStart } },
      orderBy: { lastReported: "desc" },
    });

    if (existing) {
      const uniqueUserIds = existing.uniqueUserIds.includes(authorId) ? existing.uniqueUserIds : [...existing.uniqueUserIds, authorId];

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

      if (existing.notionCmPageId) {
        await updateNotionEntryForEscalation(existing.notionCmPageId, {
          category: analysis.category,
          urgency: updated.priority,
          uniqueReporterCount: uniqueUserIds.length,
          mentionCount: updated.mentionCount,
          latestSummary: analysis.aiSummary,
        });
      }

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

    const notionResult = await createNotionEntry({ analysis, authorName, messageLink, createdAt: new Date(), uniqueReporterCount: 1 });

    if (notionResult) {
      await prisma.issue.update({
        where: { id: created.id },
        data: {
          notionCmPageId: notionResult.cmPageId,
          notionCmPageUrl: notionResult.cmPageUrl,
          notionBugPageId: notionResult.bugPageId,
          notionFeaturePageId: notionResult.featurePageId,
        },
      });
    }

    return created.id;
  } catch (error) {
    logger.error("Failed to attach feedback to issue", error);
    return null;
  }
}

export async function getIssues(status?: string) {
  return prisma.issue.findMany({
    where: status ? { status } : { status: { in: OPEN_STATUSES } },
    orderBy: [{ priority: "desc" }, { mentionCount: "desc" }],
    take: 25,
  });
}

export async function updateIssueStatus(issueId: string, status: string) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}. Valid: ${VALID_STATUSES.join(", ")}`);
  }
  return prisma.issue.update({ where: { id: issueId }, data: { status } });
}

/**
 * Resolves an issue by exact ID first (what autocomplete selections
 * provide, since the option's value is set to the issue ID there), falling
 * back to a case-insensitive title-substring search for anyone who types
 * free text without picking a suggestion. Shared by /community assign and
 * /community resolve so both get exact-match reliability once autocomplete
 * is used, without needing two copies of this lookup.
 */
async function findIssueByIdOrSearch(idOrSearch: string) {
  const byId = await prisma.issue.findUnique({ where: { id: idOrSearch } });
  if (byId) return byId;

  return prisma.issue.findFirst({
    where: { title: { contains: idOrSearch, mode: "insensitive" }, status: { in: OPEN_STATUSES } },
    orderBy: { lastReported: "desc" },
  });
}

export async function assignIssue(searchTerm: string, assignee: string, flagFollowUp?: boolean) {
  const issue = await findIssueByIdOrSearch(searchTerm);
  if (!issue) return null;

  return prisma.issue.update({
    where: { id: issue.id },
    data: { assignedTo: assignee, ...(flagFollowUp !== undefined ? { followUpFlagged: flagFollowUp } : {}) },
  });
}

/**
 * Same idea as assignIssue, but changes status instead. Accepts an ID
 * (from autocomplete) or a title fragment (typed free text).
 */
export async function resolveIssueByIdOrSearch(idOrSearch: string, status: string) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}. Valid: ${VALID_STATUSES.join(", ")}`);
  }
  const issue = await findIssueByIdOrSearch(idOrSearch);
  if (!issue) return null;

  return prisma.issue.update({ where: { id: issue.id }, data: { status } });
}

/**
 * Backing query for slash command autocomplete on the "issue" option --
 * returns open issues matching what's typed so far, capped at Discord's
 * 25-choice limit. Used by both /community assign and /community resolve.
 */
export async function searchOpenIssuesForAutocomplete(query: string, limit: number = 25) {
  return prisma.issue.findMany({
    where: {
      status: { in: OPEN_STATUSES },
      ...(query ? { title: { contains: query, mode: "insensitive" } } : {}),
    },
    orderBy: { lastReported: "desc" },
    take: limit,
    select: { id: true, title: true, priority: true, mentionCount: true },
  });
}

/**
 * Resolves a search string (or exact ID from an autocomplete selection)
 * to the real issue ID, reusing the same lookup as assign/resolve. Lets
 * other callers (like the Notion export command) accept the same flexible
 * input without duplicating the lookup logic.
 */
export async function resolveIssueId(idOrSearch: string): Promise<string | null> {
  const issue = await findIssueByIdOrSearch(idOrSearch);
  return issue?.id || null;
}
