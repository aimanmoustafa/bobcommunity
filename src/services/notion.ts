import { Client as NotionClient } from "@notionhq/client";
import { config } from "../config";
import { logger } from "../utils/logger";
import type { MessageAnalysis } from "../ai/analyzer";

// Fixed constants for this specific Notion workspace (from the existing
// manual CM workflow). These are single-source databases, where the data
// source ID and database ID are the same value, so they work directly as
// `database_id` in the standard Notion API.
const CM_DB_ID = "ee58a0fd-b1a8-49af-971f-ca2d358c1e7d";
const BUG_DB_ID = "025a46f7-5b0b-40d9-b8e3-04983f2c01ea";
const FEATURE_DB_ID = "2b45e385-ebf9-805d-a9b5-000bd455c614";
const BLITZ_OF_BATTLE_GAME_PAGE_ID = "1265e385-ebf9-806f-8ebf-db6720203ade";
const DEFAULT_CM_PERSON_ID = "28fd872b-594c-8113-9fe4-00020c6a61bc"; // Ayman Mostafa

const notion = config.notion.enabled ? new NotionClient({ auth: config.notion.apiKey }) : null;

// --- Category -> CM DB "Type" (multi_select) ---
const TYPE_MAP: Record<string, string> = {
  bug_report: "Bug Report",
  performance: "Bug Report",
  exploit: "Cheating Report",
  monetization: "Payment Issue",
  complaint: "Complaint",
  balance: "Complaint",
  matchmaking: "Complaint",
  ui_ux: "Complaint",
  localization: "Complaint",
  store: "Complaint",
  progression: "Complaint",
  veteran: "Complaint",
  toxicity: "Complaint",
  hero_feedback: "Complaint",
  community_event: "Announcement",
  praise: "Praise",
  question: "Question",
  confusion: "Question",
  new_player: "Question",
  suggestion: "Feature Request",
  feature_request: "Feature Request",
};

// --- Sentiment -> CM DB "Sentiment" (select) ---
const SENTIMENT_MAP: Record<string, string> = {
  positive: "Positive",
  excited: "Very Positive",
  neutral: "Neutral",
  confused: "Neutral",
  negative: "Negative",
  frustrated: "Negative",
  angry: "Very Negative",
};

// --- Urgency -> CM DB "Priority" (select). These match 1:1, just capitalized. ---
const PRIORITY_MAP: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

// --- Urgency -> Bug DB "Priority" (P0-P3 scale) ---
const BUG_PRIORITY_MAP: Record<string, string> = {
  critical: "P0",
  high: "P1",
  medium: "P2",
  low: "P3",
};

const DEV_FACING_CATEGORIES = ["bug_report", "performance", "matchmaking", "exploit"];

function impactLevelFor(uniqueReporterCount: number): string {
  if (uniqueReporterCount >= 15) return "Community-wide";
  if (uniqueReporterCount >= 5) return "Widespread";
  if (uniqueReporterCount >= 2) return "Small Group";
  return "Individual";
}

function communitySentimentFor(uniqueReporterCount: number): string {
  if (uniqueReporterCount >= 10) return "Highly Requested";
  if (uniqueReporterCount >= 5) return "Popular";
  if (uniqueReporterCount >= 2) return "Moderate Interest";
  return "N/A";
}

/** Best-effort keyword heuristic for the Bug DB's Category multi-select. Returns [] if nothing matches -- better to leave it blank than guess wrong. */
function guessBugCategories(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  if (/crash|freeze|force.?close/.test(lower)) found.push("Crash/Stability");
  if (/login|log in|sign.?in/.test(lower)) found.push("Login Issue");
  if (/lag|desync|connection|disconnect|network/.test(lower)) found.push("Networking");
  if (/ui|ux|button|menu|screen/.test(lower)) found.push("UI/UX");
  if (/sound|audio|music|mute/.test(lower)) found.push("Audio");
  if (/fps|slow|stutter|performance/.test(lower)) found.push("Performance");
  if (/save|load|progress lost/.test(lower)) found.push("Save/Load");
  if (/payment|purchase|gems|coins|receipt/.test(lower)) found.push("Monetization");
  return found;
}

function richText(content: string) {
  return [{ text: { content: content.slice(0, 2000) } }];
}

function dateProp(d: Date) {
  return { start: d.toISOString().split("T")[0] };
}

export interface NotionSyncInput {
  analysis: MessageAnalysis;
  authorName: string;
  messageLink: string;
  createdAt: Date;
  uniqueReporterCount: number;
}

export interface NotionSyncResult {
  cmPageId?: string;
  cmPageUrl?: string;
  bugPageId?: string;
  featurePageId?: string;
}

/**
 * Creates the CM DB entry for a brand-new issue, plus a linked Bug DB or
 * Feature DB entry if the category warrants it -- mirrors what the manual
 * CM workflow does, just automatic. Returns null (not a placeholder) if
 * Notion sync is disabled or the call fails, so callers can skip cleanly.
 */
export async function createNotionEntry(input: NotionSyncInput): Promise<NotionSyncResult | null> {
  if (!notion) return null;

  const { analysis, authorName, messageLink, createdAt, uniqueReporterCount } = input;
  const isDevFacing = DEV_FACING_CATEGORIES.includes(analysis.category);
  const isUrgent = analysis.urgency === "high" || analysis.urgency === "critical";

  try {
    const cmPage = await notion.pages.create({
      parent: { database_id: CM_DB_ID },
      properties: {
        Name: { title: [{ text: { content: analysis.aiSummary.slice(0, 200) || "Community feedback" } }] },
        Type: { multi_select: [{ name: TYPE_MAP[analysis.category] || "Complaint" }] },
        Sentiment: { select: { name: SENTIMENT_MAP[analysis.sentiment] || "Neutral" } },
        Priority: { select: { name: PRIORITY_MAP[analysis.urgency] || "Low" } },
        Status: { select: { name: isUrgent ? "Escalated" : "New" } },
        ...(isUrgent && isDevFacing ? { "Action Taken": { select: { name: "Escalated to Development" } } } : {}),
        Platform: { select: { name: "Discord" } },
        "Community Manager": { people: [{ id: DEFAULT_CM_PERSON_ID }] },
        "Date Reported": { date: dateProp(createdAt) },
        "Source URL": { url: messageLink },
        Notes: { rich_text: richText(`Auto-logged by BoB Community Bot. Confidence: ${Math.round(analysis.confidence * 100)}%. Reason: ${analysis.reason}`) },
        "Impact Level": { select: { name: impactLevelFor(uniqueReporterCount) } },
        "Follow-up Required": { checkbox: analysis.needsReply === "yes" },
        Game: { relation: [{ id: BLITZ_OF_BATTLE_GAME_PAGE_ID }] },
      },
    });

    const result: NotionSyncResult = { cmPageId: cmPage.id, cmPageUrl: (cmPage as any).url };

    if (analysis.category === "bug_report" || analysis.category === "performance") {
      const bugPage = await notion.pages.create({
        parent: { database_id: BUG_DB_ID },
        properties: {
          "Bug Title": { title: [{ text: { content: analysis.aiSummary.slice(0, 200) || "Reported bug" } }] },
          Status: { select: { name: "New" } },
          Priority: { select: { name: BUG_PRIORITY_MAP[analysis.urgency] || "P3" } },
          ...(guessBugCategories(`${analysis.aiSummary} ${analysis.tags.join(" ")}`).length > 0
            ? { Category: { multi_select: guessBugCategories(`${analysis.aiSummary} ${analysis.tags.join(" ")}`).map((c) => ({ name: c })) } }
            : {}),
          "Player Reported": { checkbox: true },
          Username: { rich_text: richText(authorName) },
          "Reported Date": { date: dateProp(createdAt) },
          Community: { relation: [{ id: cmPage.id }] },
          "Related Game": { relation: [{ id: BLITZ_OF_BATTLE_GAME_PAGE_ID }] },
        },
      });
      result.bugPageId = bugPage.id;
    } else if (analysis.category === "suggestion" || analysis.category === "feature_request") {
      const featurePage = await notion.pages.create({
        parent: { database_id: FEATURE_DB_ID },
        properties: {
          Name: { title: [{ text: { content: analysis.aiSummary.slice(0, 200) || "Feature suggestion" } }] },
          Status: { select: { name: "Idea" } },
          Source: { select: { name: "Community Request" } },
          "Community Sentiment": { select: { name: communitySentimentFor(uniqueReporterCount) } },
          Description: { rich_text: richText(`${analysis.aiSummary}\n\nDiscord: ${messageLink}`) },
          "Related Game": { select: { name: "Blitz of Battle" } },
          "👨‍👩‍👧 Community Management": { relation: [{ id: cmPage.id }] },
        },
      });
      result.featurePageId = featurePage.id;
    }

    logger.info("Notion entry created", { category: analysis.category, cmPageId: cmPage.id });
    return result;
  } catch (error: any) {
    logger.error("Failed to create Notion entry", { error: error?.message });
    return null;
  }
}

/**
 * Patches an existing CM DB page (and its linked Bug/Feature page, if any)
 * when the same issue gets a new report -- this is the "automatically
 * update for the dev team" behavior: growing report counts and urgency
 * escalation get reflected on the existing page instead of spamming new
 * rows, and if it crosses the urgent threshold, Status/Action Taken flip
 * to reflect that it now needs dev attention.
 */
export async function updateNotionEntryForEscalation(
  cmPageId: string,
  params: {
    category: string;
    urgency: string;
    uniqueReporterCount: number;
    mentionCount: number;
    latestSummary: string;
  }
): Promise<void> {
  if (!notion) return;

  const { category, urgency, uniqueReporterCount, mentionCount, latestSummary } = params;
  const isDevFacing = DEV_FACING_CATEGORIES.includes(category);
  const isUrgent = urgency === "high" || urgency === "critical";

  try {
    await notion.pages.update({
      page_id: cmPageId,
      properties: {
        Priority: { select: { name: PRIORITY_MAP[urgency] || "Low" } },
        Status: { select: { name: isUrgent ? "Escalated" : "Acknowledged" } },
        ...(isUrgent && isDevFacing ? { "Action Taken": { select: { name: "Escalated to Development" } } } : {}),
        "Impact Level": { select: { name: impactLevelFor(uniqueReporterCount) } },
        Notes: {
          rich_text: richText(
            `Auto-updated by BoB Community Bot: ${mentionCount} total reports from ${uniqueReporterCount} unique player(s) as of now. Latest: ${latestSummary}`
          ),
        },
      },
    });
    logger.info("Notion entry updated for escalation", { cmPageId, mentionCount, uniqueReporterCount });
  } catch (error: any) {
    logger.error("Failed to update Notion entry", { cmPageId, error: error?.message });
  }
}
