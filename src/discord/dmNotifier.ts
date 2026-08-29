import { Client, EmbedBuilder } from "discord.js";
import { config } from "../config";
import { logger } from "../utils/logger";
import { THEME_COLORS, urgencyThemeColor } from "../utils/theme";
import type { MessageAnalysis } from "../ai/analyzer";

function formatCategory(category: string): string {
  return category.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
}

/**
 * Single-user send with the shared try/catch/log pattern. Reused by both
 * sendEmbedToConfiguredUsers (loops the general alert list) and the
 * primary-user-specific sends below, so there's one place that knows how
 * to actually deliver a DM and log a failure -- not duplicated per caller.
 */
async function trySendToUser(
  client: Client,
  userId: string,
  embed: EmbedBuilder,
  options: { pingRecipient?: boolean; pingText?: string } = {}
): Promise<void> {
  try {
    const user = await client.users.fetch(userId);
    const payload: any = { embeds: [embed] };
    if (options.pingRecipient) {
      payload.content = `<@${userId}>${options.pingText ? ` ${options.pingText}` : ""}`;
      payload.allowedMentions = { users: [userId] };
    }
    await user.send(payload);
  } catch (error: any) {
    logger.warn("Failed to DM user (closed DMs, invalid ID, or no shared server?)", { userId, error: error?.message });
  }
}

export async function sendEmbedToConfiguredUsers(
  client: Client,
  embed: EmbedBuilder,
  options: { pingRecipient?: boolean; pingText?: string } = {}
): Promise<void> {
  if (config.discord.dmUserIds.length === 0) return;
  for (const userId of config.discord.dmUserIds) {
    await trySendToUser(client, userId, embed, options);
  }
}

// Discord embed descriptions have a hard 4096-character limit. A busy
// day's report can exceed this; silently truncating with .slice() would
// cut content off with no indication anything was cut -- send multiple
// embeds instead, so the DM copy is always complete, matching the same
// no-silent-truncation fix applied to the Slack side.
function chunkForDiscordEmbeds(text: string, maxLen: number = 4000): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);

  return chunks;
}

export async function sendReportDm(client: Client, title: string, content: string): Promise<void> {
  const chunks = chunkForDiscordEmbeds(content);
  for (let i = 0; i < chunks.length; i++) {
    const embed = new EmbedBuilder()
      .setTitle(chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title)
      .setColor(THEME_COLORS.orange)
      .setDescription(chunks[i])
      .setTimestamp();
    await sendEmbedToConfiguredUsers(client, embed);
  }
}

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
      `**Summary:** ${analysis.aiSummary}\n\n**Reason:** ${analysis.reason}\n\n**Message:** ${truncate(messageContent, 300)}\n\n[Open in Discord](${messageLink})`
    )
    .setTimestamp();

  await sendEmbedToConfiguredUsers(client, embed);
}

export async function sendModerationAlertDm(
  client: Client,
  analysis: MessageAnalysis,
  authorName: string,
  channelName: string,
  messageLink: string,
  messageContent: string
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("🚨 Moderation Alert")
    .setColor(THEME_COLORS.darkOrange)
    .addFields(
      { name: "Channel", value: `#${channelName}`, inline: true },
      { name: "Author", value: authorName, inline: true },
      { name: "Sentiment", value: analysis.sentiment, inline: true }
    )
    .setDescription(`**Summary:** ${analysis.aiSummary}\n\n**Message:** ${truncate(messageContent, 400)}\n\n[Open in Discord](${messageLink})`)
    .setTimestamp();

  await sendEmbedToConfiguredUsers(client, embed, { pingRecipient: true, pingText: "⚠️ Possible toxic/inappropriate message detected" });
}

function formatReceivedTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/**
 * Forwards a reply to the Leave DM to the dedicated primary user
 * (DISCORD_PRIMARY_USER_ID), not the general alert list -- this is a
 * distinct escalation path per spec, even though in practice it's often
 * the same person as the general DM_USER_IDS. Format matches the exact
 * template requested: Member, User ID, Reply, Source, Received.
 */
export async function sendExitReplyForward(
  client: Client,
  username: string,
  userId: string,
  content: string,
  repliedAt: Date = new Date()
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("📨 Leave Feedback Received")
    .setColor(THEME_COLORS.lightOrange)
    .addFields(
      { name: "Member", value: `${username} (<@${userId}>)`, inline: true },
      { name: "User ID", value: `\`${userId}\``, inline: true },
      { name: "Source", value: "Leave DM", inline: true },
      { name: "Received", value: formatReceivedTimestamp(repliedAt), inline: true },
      { name: "Reply", value: `> ${truncate(content, 1500)}` }
    )
    .setTimestamp(repliedAt);

  await trySendToUser(client, config.discord.primaryUserId, embed);
}

interface StaleItemLike {
  authorName: string; aiSummary: string | null; content: string;
  messageLink: string; category: string; urgency: string; ageHours: number;
}

export async function sendStaleItemsDm(client: Client, items: StaleItemLike[]): Promise<void> {
  const lines = items
    .slice(0, 10)
    .map((i) => `• **${i.authorName}** (${i.ageHours}h ago): ${truncate(i.aiSummary || i.content, 150)}\n[Open in Discord](${i.messageLink})`)
    .join("\n\n");

  const embed = new EmbedBuilder().setTitle("⏰ Stale: Still Awaiting Reply").setColor(THEME_COLORS.darkOrange).setDescription(lines.slice(0, 4096)).setTimestamp();
  await sendEmbedToConfiguredUsers(client, embed);
}

/**
 * Startup/crash visibility. A crash otherwise looks identical to silence --
 * you'd only find out the bot went down by noticing nothing's happening.
 * The "started" DM confirms a deploy actually succeeded; the crash alert
 * fires only for genuine fatal errors (uncaughtException/unhandledRejection),
 * never for a normal SIGTERM redeploy, so this doesn't turn into noise on
 * every routine Railway restart.
 */
export async function sendSystemAlertDm(client: Client, title: string, message: string): Promise<void> {
  const embed = new EmbedBuilder().setTitle(title).setColor(THEME_COLORS.darkOrange).setDescription(message.slice(0, 4096)).setTimestamp();
  await sendEmbedToConfiguredUsers(client, embed);
}
