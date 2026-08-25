import { Client } from "discord.js";
import { prisma } from "../database";
import { config } from "../config";
import { logger } from "../utils/logger";
import {
  TYPE_MAP,
  SENTIMENT_MAP,
  PRIORITY_MAP,
  BUG_PRIORITY_MAP,
  DEV_FACING_CATEGORIES,
  impactLevelFor,
  communitySentimentFor,
  guessBugCategories,
} from "./notion";

const DEFAULT_CM_NAME = "Ayman Mostafa";

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function formatDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
}

/**
 * Produces the exact same field values the real Notion sync would use
 * (same TYPE_MAP/SENTIMENT_MAP/PRIORITY_MAP/impact-level logic, imported
 * directly from notion.ts rather than reimplemented, so this can never
 * drift from what auto-sync actually does) -- but as labeled, copy-paste
 * text instead of an API call. For when Notion access isn't configured
 * but you still want the CM to hand-carry the data into a Notion-creating
 * conversation.
 */
export async function formatIssueForNotionExport(issueId: string): Promise<string | null> {
  const issue = await prisma.issue.findUnique({ where: { id: issueId } });
  if (!issue) return null;

  const messages = await prisma.feedback.findMany({
    where: { issueId: issue.id },
    orderBy: { createdAt: "asc" },
  });

  const isDevFacing = DEV_FACING_CATEGORIES.includes(issue.category);
  const isUrgent = issue.priority === "high" || issue.priority === "critical";
  const uniqueReporterCount = issue.uniqueUserIds.length;
  const primaryMessage = messages[0];

  let out = `=== NOTION EXPORT: ${issue.title} ===\n\n`;

  out += `[Community Management Entry]\n`;
  out += `Name: ${truncate(issue.latestSummary || issue.title, 200)}\n`;
  out += `Type: ${TYPE_MAP[issue.category] || "Complaint"}\n`;
  out += `Sentiment: ${SENTIMENT_MAP[issue.sentiment] || "Neutral"}\n`;
  out += `Priority: ${PRIORITY_MAP[issue.priority] || "Low"}\n`;
  out += `Status: ${isUrgent ? "Escalated" : "New"}\n`;
  if (isUrgent && isDevFacing) out += `Action Taken: Escalated to Development\n`;
  out += `Platform: Discord\n`;
  out += `Build: ${config.bot.currentBuild} (verify -- this is the CM's configured "current build" default, not detected per-message)\n`;
  out += `Community Manager: ${DEFAULT_CM_NAME}\n`;
  out += `Date Reported: ${formatDate(issue.firstReported)}\n`;
  if (primaryMessage) out += `Source URL: ${primaryMessage.messageLink}\n`;
  out += `Impact Level: ${impactLevelFor(uniqueReporterCount)}\n`;
  out += `Follow-up Required: ${messages.some((m) => m.needsReply === "yes") ? "Yes" : "No"}\n`;
  out += `Assigned To: ${issue.assignedTo || "-- none --"}\n`;
  out += `Follow-up Flagged: ${issue.followUpFlagged ? "Yes" : "No"}\n`;
  out += `Notes: ${issue.mentionCount} total report(s) from ${uniqueReporterCount} unique player(s). Latest: ${issue.latestSummary || "n/a"}.${issue.recommendedAction ? ` Reason: ${issue.recommendedAction}` : ""}\n`;

  out += `\n[Contributing Reports] (${messages.length} message${messages.length === 1 ? "" : "s"})\n`;
  messages.forEach((m, i) => {
    out += `${i + 1}. ${m.authorName} -- ${m.messageLink}\n`;
    out += `   "${truncate(m.content.replace(/\s+/g, " ").trim(), 200)}"\n`;
    out += `   Sentiment: ${m.sentiment} | Urgency: ${m.urgency} | Confidence: ${Math.round(m.confidence * 100)}%\n`;
  });

  if (issue.category === "bug_report" || issue.category === "performance") {
    const guessedCategories = guessBugCategories(`${issue.latestSummary || ""} ${issue.title}`);
    out += `\n[Bugs Database Entry]\n`;
    out += `Bug Title: ${truncate(issue.latestSummary || issue.title, 200)}\n`;
    out += `Priority: ${BUG_PRIORITY_MAP[issue.priority] || "P3"}\n`;
    out += `Category (best-effort guess, verify): ${guessedCategories.length > 0 ? guessedCategories.join(", ") : "-- none matched, review manually --"}\n`;
    out += `Player Reported: Yes\n`;
    out += `Username: ${primaryMessage?.authorName || "unknown"}\n`;
    out += `Reported Date: ${formatDate(issue.firstReported)}\n`;
  } else if (issue.category === "suggestion" || issue.category === "feature_request") {
    out += `\n[Features Database Entry]\n`;
    out += `Name: ${truncate(issue.latestSummary || issue.title, 200)}\n`;
    out += `Status: Idea\n`;
    out += `Source: Community Request\n`;
    out += `Community Sentiment: ${communitySentimentFor(uniqueReporterCount)}\n`;
    out += `Description: ${issue.latestSummary || issue.title}${primaryMessage ? `\n\nDiscord: ${primaryMessage.messageLink}` : ""}\n`;
  }

  return out;
}

/**
 * Raw, unmerged, per-message export -- one block per contributing Discord
 * message, exactly matching the format the manual CM skill expects as
 * input. Unlike formatIssueForNotionExport (which clusters into one
 * summarized entry), this never merges, translates, or adds sentiment/tags
 * of its own -- it's meant to be pasted directly into a chat with Claude,
 * where the actual judgment call (log individually, filter to bugs only,
 * summarize) happens explicitly, not silently inside the bot.
 *
 * Reactions and screenshot/attachment presence aren't stored anywhere in
 * the database (people react to a message long after it's classified, so
 * a stored snapshot would go stale) -- both are fetched live from Discord
 * at export time instead. If a message was deleted or is otherwise
 * unreachable, those two fields fall back to "unknown" rather than
 * silently omitting the message or crashing the whole export.
 */
export async function formatIssueRawMessages(client: Client, issueId: string): Promise<string | null> {
  const issue = await prisma.issue.findUnique({ where: { id: issueId } });
  if (!issue) return null;

  const messages = await prisma.feedback.findMany({
    where: { issueId: issue.id },
    orderBy: { createdAt: "asc" },
  });

  const blocks: string[] = [];

  for (const m of messages) {
    let reactionsText = "none";
    let hasScreenshot = "no";

    try {
      const channel = await client.channels.fetch(m.channelId);
      if (channel && "messages" in channel) {
        const discordMessage = await (channel as any).messages.fetch(m.messageId);
        if (discordMessage.reactions.cache.size > 0) {
          reactionsText = discordMessage.reactions.cache
            .map((r: any) => `${r.emoji.name || r.emoji.toString()} x${r.count}`)
            .join(", ");
        }
        hasScreenshot = discordMessage.attachments.size > 0 ? "yes" : "no";
      } else {
        reactionsText = "unknown (channel not accessible)";
        hasScreenshot = "unknown";
      }
    } catch (error: any) {
      logger.debug("Could not fetch live message data for export (likely deleted)", { messageId: m.messageId, error: error?.message });
      reactionsText = "unknown (message may be deleted)";
      hasScreenshot = "unknown";
    }

    // Plain-text substring check -- catches players who type "DEMON" as
    // literal text. A true Discord @mention would store as <@userId> in
    // raw content, not readable text, so this won't catch every mention
    // form, just the common "typed the name" case.
    const mentionsDemon = /demon/i.test(m.content) ? "yes" : "no";

    blocks.push(
      [
        "--- MESSAGE ---",
        `Player: ${m.authorName}`,
        `Date: ${formatDateTime(m.createdAt)}`,
        `Channel: #${m.channelName}`,
        `URL: ${m.messageLink}`,
        `Mentions DEMON: ${mentionsDemon}`,
        `Reactions: ${reactionsText}`,
        `Has screenshot/clip: ${hasScreenshot}`,
        `Text: ${m.content}`,
        "--- END ---",
      ].join("\n")
    );
  }

  return blocks.join("\n\n");
}
