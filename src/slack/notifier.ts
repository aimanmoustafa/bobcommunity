import { WebClient } from "@slack/web-api";
import { config } from "../config";
import { logger } from "../utils/logger";
import { withRetry } from "../utils/retry";
import { THEME_COLORS, urgencyThemeColor } from "../utils/theme";
import type { MessageAnalysis } from "../ai/analyzer";

const slack = new WebClient(config.slack.token);

interface SlackAlertPayload {
  analysis: MessageAnalysis;
  authorName: string;
  channelName: string;
  messageLink: string;
  messageContent: string;
}

const URGENCY_EMOJI: Record<string, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "⚪" };

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
}

function formatCategory(category: string): string {
  return category.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function buildBlocks(
  analysis: MessageAnalysis,
  authorName: string,
  channelName: string,
  messageLink: string,
  messageContent: string,
  reporterCount?: number
) {
  const urgencyEmoji = URGENCY_EMOJI[analysis.urgency] || "⚪";
  return [
    {
      type: "header",
      text: { type: "plain_text", text: `${urgencyEmoji} Community Alert${reporterCount ? ` (${reporterCount} reports)` : ""}` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Channel:*\n#${channelName}` },
        { type: "mrkdwn", text: `*Author:*\n${authorName}` },
        { type: "mrkdwn", text: `*Category:*\n${formatCategory(analysis.category)}` },
        { type: "mrkdwn", text: `*Urgency:*\n${analysis.urgency.toUpperCase()}` },
        { type: "mrkdwn", text: `*Sentiment:*\n${analysis.sentiment}` },
        { type: "mrkdwn", text: `*Confidence:*\n${Math.round(analysis.confidence * 100)}%` },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: `*Summary:*\n${analysis.aiSummary}` } },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Latest Message:*\n> ${truncate(messageContent, 300)}` },
    },
    { type: "divider" },
    {
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "Open in Discord" }, url: messageLink }],
    },
  ];
}

export async function sendSlackAlert(payload: SlackAlertPayload, targetChannel: string): Promise<string | undefined> {
  const { analysis, authorName, channelName, messageLink, messageContent } = payload;
  const urgencyEmoji = URGENCY_EMOJI[analysis.urgency] || "⚪";

  try {
    const result = await withRetry(
      () =>
        slack.chat.postMessage({
          channel: targetChannel,
          text: `${urgencyEmoji} Community Alert: ${analysis.category} from ${authorName}`,
          attachments: [{ color: urgencyThemeColor(analysis.urgency), blocks: buildBlocks(analysis, authorName, channelName, messageLink, messageContent) }],
        }),
      { label: "Slack postMessage", retries: 3 }
    );

    logger.info("Slack alert sent", { category: analysis.category, ts: result.ts, targetChannel });
    return result.ts as string | undefined;
  } catch (error) {
    logger.error("Failed to send Slack alert after retries", error);
    return undefined;
  }
}

export async function updateSlackAlert(
  slackTs: string,
  targetChannel: string,
  payload: SlackAlertPayload,
  reporterCount: number
): Promise<boolean> {
  const { analysis, authorName, channelName, messageLink, messageContent } = payload;
  const urgencyEmoji = URGENCY_EMOJI[analysis.urgency] || "⚪";

  try {
    await withRetry(
      () =>
        slack.chat.update({
          channel: targetChannel,
          ts: slackTs,
          text: `${urgencyEmoji} Community Alert (${reporterCount} reports): ${analysis.category}`,
          attachments: [{ color: urgencyThemeColor(analysis.urgency), blocks: buildBlocks(analysis, authorName, channelName, messageLink, messageContent, reporterCount) }],
        }),
      { label: "Slack chat.update", retries: 3 }
    );
    return true;
  } catch (error) {
    logger.error("Failed to update Slack alert after retries", error);
    return false;
  }
}

export async function sendDailyReport(report: string, targetChannel: string): Promise<void> {
  try {
    await withRetry(
      () =>
        slack.chat.postMessage({
          channel: targetChannel,
          text: report,
          attachments: [{ color: THEME_COLORS.orange, blocks: [
            { type: "header", text: { type: "plain_text", text: "📊 Daily Community Report" } },
            { type: "section", text: { type: "mrkdwn", text: report } },
          ] }],
        }),
      { label: "Slack daily report", retries: 3 }
    );
  } catch (error) {
    logger.error("Failed to send daily report after retries", error);
  }
}

export async function sendWeeklyReport(report: string, targetChannel: string): Promise<void> {
  try {
    await withRetry(
      () =>
        slack.chat.postMessage({
          channel: targetChannel,
          text: report,
          attachments: [{ color: THEME_COLORS.orange, blocks: [
            { type: "header", text: { type: "plain_text", text: "📅 Weekly Community Report" } },
            { type: "section", text: { type: "mrkdwn", text: report } },
          ] }],
        }),
      { label: "Slack weekly report", retries: 3 }
    );
  } catch (error) {
    logger.error("Failed to send weekly report after retries", error);
  }
}

export async function sendTrendAlert(category: string, todayCount: number, growthLabel: string, targetChannel: string): Promise<void> {
  const prettyCategory = formatCategory(category);
  try {
    await withRetry(
      () =>
        slack.chat.postMessage({
          channel: targetChannel,
          text: `⚠️ TREND DETECTED: ${prettyCategory} mentions spiking (${growthLabel})`,
          attachments: [{ color: THEME_COLORS.darkOrange, blocks: [
            { type: "header", text: { type: "plain_text", text: "⚠️ Trend Detected" } },
            { type: "section", fields: [
              { type: "mrkdwn", text: `*Topic:*\n${prettyCategory}` },
              { type: "mrkdwn", text: `*Mentions:*\n${growthLabel}` },
              { type: "mrkdwn", text: `*Today so far:*\n${todayCount}` },
              { type: "mrkdwn", text: `*Status:*\nEscalating` },
            ] },
            { type: "context", elements: [{ type: "mrkdwn", text: "Recommendation: Community/LiveOps should investigate this spike." }] },
          ] }],
        }),
      { label: "Slack trend alert", retries: 2 }
    );
  } catch (error) {
    logger.error("Failed to send trend alert after retries", error);
  }
}

export async function logMemberExit(params: { username: string; userId: string; guildName: string; dmSent: boolean; failureReason?: string }): Promise<void> {
  const { username, userId, guildName, dmSent, failureReason } = params;
  try {
    await withRetry(
      () =>
        slack.chat.postMessage({
          channel: config.slack.channels.memberExits,
          text: `👋 ${username} left ${guildName}`,
          attachments: [{ color: THEME_COLORS.lightOrange, blocks: [
            { type: "section", text: { type: "mrkdwn", text: `👋 *${username}* (\`${userId}\`) left *${guildName}*` } },
            { type: "context", elements: [{ type: "mrkdwn", text: dmSent ? "✅ Exit-feedback DM sent successfully" : `⚠️ DM could not be delivered${failureReason ? ` (${failureReason})` : ""} -- consider a manual follow-up` }] },
          ] }],
        }),
      { label: "Slack member exit log", retries: 2 }
    );
  } catch (error) {
    logger.error("Failed to log member exit to Slack after retries", error);
  }
}
