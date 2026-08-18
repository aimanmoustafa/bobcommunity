import { Client, EmbedBuilder } from "discord.js";
import { config } from "../config";
import { logger } from "../utils/logger";
import { THEME_COLORS, urgencyThemeColor } from "../utils/theme";
import type { MessageAnalysis } from "../ai/analyzer";

function formatCategory(category: string): string {
  return category
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
}

/**
 * Sends an embed to every configured Discord user ID. Uses embeds (not
 * plain content) specifically because Discord only renders markdown links
 * like [Discord](url) inside embeds -- in plain message content they show
 * up as literal bracket-and-parens text. Failures per-user are logged and
 * skipped, never thrown, since a closed-DMs user shouldn't break delivery
 * to everyone else configured. Exported so other modules (exit-reply
 * forwarding) can reuse the exact same delivery logic.
 */
export async function sendEmbedToConfiguredUsers(client: Client, embed: EmbedBuilder): Promise<void> {
  if (config.discord.dmUserIds.length === 0) return;

  for (const userId of config.discord.dmUserIds) {
    try {
      const user = await client.users.fetch(userId);
      await user.send({ embeds: [embed] });
    } catch (error: any) {
      logger.warn("Failed to DM configured user (closed DMs, invalid ID, or no shared server?)", {
        userId,
        error: error?.message,
      });
    }
  }
}

/**
 * DMs a full report (daily digest, weekly report, pulse) to configured users.
 * Same content that goes to Slack, just delivered as a Discord embed too.
 */
export async function sendReportDm(client: Client, title: string, content: string): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(THEME_COLORS.orange)
    .setDescription(content.slice(0, 4096)) // Discord embed description hard limit
    .setTimestamp();

  await sendEmbedToConfiguredUsers(client, embed);
}

/**
 * DMs a single urgent-alert notification -- called only when a NEW alert
 * fires (critical bypass, or the first report of a new aggregation group),
 * never on subsequent "N more reports" updates, so configured users don't
 * get spammed every time an existing issue gets one more report.
 */
export async function sendAlertDm(
  client: Client,
  analysis: MessageAnalysis,
  authorName: string,
  channelName: string,
  messageLink: string,
  messageContent: string
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("🚨 Community Alert")
    .setColor(urgencyThemeColor(analysis.urgency))
    .addFields(
      { name: "Channel", value: `#${channelName}`, inline: true },
      { name: "Author", value: authorName, inline: true },
      { name: "Category", value: formatCategory(analysis.category), inline: true },
      { name: "Urgency", value: analysis.urgency.toUpperCase(), inline: true },
      { name: "Sentiment", value: analysis.sentiment, inline: true },
      { name: "Needs Reply", value: analysis.needsReply.toUpperCase(), inline: true }
    )
    .setDescription(
      `**Summary:** ${analysis.aiSummary}\n\n` +
        `**Reason:** ${analysis.reason}\n\n` +
        `**Message:** ${truncate(messageContent, 300)}\n\n` +
        `**Suggested reply:** ${analysis.suggestedReply}\n\n` +
        `[Open in Discord](${messageLink})`
    )
    .setTimestamp();

  await sendEmbedToConfiguredUsers(client, embed);
}

/**
 * Forwards a departed member's reply to their exit-feedback DM, so it
 * doesn't just sit unseen in the bot's own DM inbox.
 */
export async function sendExitReplyForward(
  client: Client,
  username: string,
  userId: string,
  content: string
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("📨 Exit Feedback Reply")
    .setColor(THEME_COLORS.lightOrange)
    .setDescription(
      `**${username}** (\`${userId}\`) replied to their exit-feedback DM:\n\n> ${truncate(content, 1500)}`
    )
    .setTimestamp();

  await sendEmbedToConfiguredUsers(client, embed);
}

interface StaleItemLike {
  authorName: string;
  aiSummary: string | null;
  content: string;
  messageLink: string;
  category: string;
  urgency: string;
  ageHours: number;
}

export async function sendStaleItemsDm(client: Client, items: StaleItemLike[]): Promise<void> {
  const lines = items
    .slice(0, 10)
    .map((i) => `• **${i.authorName}** (${i.ageHours}h ago): ${truncate(i.aiSummary || i.content, 150)}\n[Open in Discord](${i.messageLink})`)
    .join("\n\n");

  const embed = new EmbedBuilder()
    .setTitle("⏰ Stale: Still Awaiting Reply")
    .setColor(THEME_COLORS.darkOrange)
    .setDescription(lines.slice(0, 4096))
    .setTimestamp();

  await sendEmbedToConfiguredUsers(client, embed);
}
