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

const URGENCY_EMOJI: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🟢",
};

const SENTIMENT_EMOJI: Record<string, string> = {
  positive: "😊",
  neutral: "😐",
  negative: "😞",
  frustrated: "😤",
  angry: "🔥",
  excited: "🎉",
  confused: "❓",
};

function buildBlocks(
  analysis: MessageAnalysis,
  authorName: string,
  channelName: string,
  messageLink: string,
  messageContent: string,
  reporterCount: number = 1
) {
  const urgencyEmoji = URGENCY_EMOJI[analysis.urgency] || "⚪";
  const sentimentEmoji = SENTIMENT_EMOJI[analysis.sentiment] || "😐";

  const headerText =
    reporterCount > 1
      ? `${urgencyEmoji} Community Alert (${reporterCount} reports)`
      : `${urgencyEmoji} Community Alert`;

  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: headerText },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Channel:*\n#${channelName}` },
        { type: "mrkdwn", text: `*Latest reporter:*\n${authorName}` },
        { type: "mrkdwn", text: `*Category:*\n${formatCategory(analysis.category)}` },
        { type: "mrkdwn", text: `*Urgency:*\n${urgencyEmoji} ${analysis.urgency.toUpperCase()}` },
        { type: "mrkdwn", text: `*Needs Reply:*\n${analysis.needsReply.toUpperCase()}` },
        { type: "mrkdwn", text: `*Sentiment:*\n${sentimentEmoji} ${analysis.sentiment}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Confidence:* ${Math.round(analysis.confidence * 100)}%` },
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*AI Summary:*\n${analysis.aiSummary}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Reason:*\n${analysis.reason}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Latest Message:*\n> ${truncate(messageContent, 300)}` },
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Suggested Reply:*\n${analysis.suggestedReply}` },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in Discord" },
          url: messageLink,
          style: "primary",
        },
      ],
    },
  ];

  if (reporterCount > 1) {
    blocks.splice(1, 0, {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `📈 Updated: ${reporterCount} players have now reported this issue` },
      ],
    });
  }

  return blocks;
}

export async function sendSlackAlert(
  payload: SlackAlertPayload,
  targetChannel: string
): Promise<string | undefined> {
  const { analysis, authorName, channelName, messageLink, messageContent } = payload;
  const urgencyEmoji = URGENCY_EMOJI[analysis.urgency] || "⚪";

  try {
    const result = await withRetry(
      () =>
        slack.chat.postMessage({
          channel: targetChannel,
          text: `${urgencyEmoji} Community Alert: ${analysis.category} from ${authorName}`,
          attachments: [
            {
              color: urgencyThemeColor(analysis.urgency),
              blocks: buildBlocks(analysis, authorName, channelName, messageLink, messageContent),
            },
          ],
        }),
      { label: "Slack postMessage", retries: 3 }
    );

    logger.info("Slack alert sent", { category: analysis.category, ts: result.ts, targetChannel });
    return result.ts;
  } catch (error) {
    logger.error("Failed to send Slack alert after retries", error);
    return undefined;
  }
}

/**
 * Updates an existing Slack alert in place (aggregation).
 * Used when the same issue is reported again within the aggregation window
 * instead of posting a new, noisy alert. Must target the same channel the
 * original alert was posted to.
 */
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
          attachments: [
            {
              color: urgencyThemeColor(analysis.urgency),
              blocks: buildBlocks(analysis, authorName, channelName, messageLink, messageContent, reporterCount),
            },
          ],
        }),
      { label: "Slack chat.update", retries: 3 }
    );
    logger.info("Slack alert updated", { category: analysis.category, ts: slackTs, reporterCount, targetChannel });
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
          attachments: [
            {
              color: THEME_COLORS.orange,
              blocks: [
                { type: "header", text: { type: "plain_text", text: "📊 Daily Community Report" } },
                { type: "section", text: { type: "mrkdwn", text: report } },
              ],
            },
          ],
        }),
      { label: "Slack daily report", retries: 3 }
    );
    logger.info("Daily report sent to Slack");
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
          attachments: [
            {
              color: THEME_COLORS.orange,
              blocks: [
                { type: "header", text: { type: "plain_text", text: "📅 Weekly Community Report" } },
                { type: "section", text: { type: "mrkdwn", text: report } },
              ],
            },
          ],
        }),
      { label: "Slack weekly report", retries: 3 }
    );
    logger.info("Weekly report sent to Slack");
  } catch (error) {
    logger.error("Failed to send weekly report after retries", error);
  }
}

interface TrendAlertPayload {
  category: string;
  growthLabel: string;
  todayCount: number;
}

export async function sendTrendAlert(payload: TrendAlertPayload, targetChannel: string): Promise<void> {
  const { category, growthLabel, todayCount } = payload;
  const prettyCategory = formatCategory(category);

  try {
    await withRetry(
      () =>
        slack.chat.postMessage({
          channel: targetChannel,
          text: `⚠️ TREND DETECTED: ${prettyCategory} mentions spiking (${growthLabel})`,
          attachments: [
            {
              color: THEME_COLORS.darkOrange,
              blocks: [
                { type: "header", text: { type: "plain_text", text: "⚠️ Trend Detected" } },
                {
                  type: "section",
                  fields: [
                    { type: "mrkdwn", text: `*Topic:*\n${prettyCategory}` },
                    { type: "mrkdwn", text: `*Mentions:*\n${growthLabel}` },
                    { type: "mrkdwn", text: `*Today so far:*\n${todayCount}` },
                    { type: "mrkdwn", text: `*Status:*\nEscalating` },
                  ],
                },
                {
                  type: "context",
                  elements: [
                    {
                      type: "mrkdwn",
                      text: "Recommendation: Community/LiveOps should investigate this spike.",
                    },
                  ],
                },
              ],
            },
          ],
        }),
      { label: "Slack trend alert", retries: 2 }
    );
  } catch (error) {
    logger.error("Failed to send trend alert after retries", error);
  }
}

interface MemberExitPayload {
  username: string;
  userId: string;
  guildName: string;
  dmSent: boolean;
  failureReason?: string;
}

export async function logMemberExit(payload: MemberExitPayload): Promise<void> {
  const { username, userId, guildName, dmSent, failureReason } = payload;

  try {
    await withRetry(
      () =>
        slack.chat.postMessage({
          channel: config.slack.channels.memberExits,
          text: `👋 ${username} left ${guildName}`,
          attachments: [
            {
              color: THEME_COLORS.lightOrange,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `👋 *${username}* (\`${userId}\`) left *${guildName}*`,
                  },
                },
                {
                  type: "context",
                  elements: [
                    {
                      type: "mrkdwn",
                      text: dmSent
                        ? "✅ Exit-feedback DM sent successfully"
                        : `⚠️ DM could not be delivered${failureReason ? ` (${failureReason})` : ""} -- consider a manual follow-up`,
                    },
                  ],
                },
              ],
            },
          ],
        }),
      { label: "Slack member exit log", retries: 2 }
    );
  } catch (error) {
    logger.error("Failed to log member exit to Slack after retries", error);
  }
}

function formatCategory(category: string): string {
  return category
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
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

export async function sendStaleItemsAlert(items: StaleItemLike[], targetChannel: string): Promise<void> {
  const lines = items
    .slice(0, 10)
    .map(
      (i) =>
        `• *${i.authorName}* (${i.ageHours}h ago, ${formatCategory(i.category)}): ${truncate(i.aiSummary || i.content, 120)} -- <${i.messageLink}|Discord>`
    )
    .join("\n");

  try {
    await withRetry(
      () =>
        slack.chat.postMessage({
          channel: targetChannel,
          text: `⏰ ${items.length} message(s) still awaiting a reply`,
          attachments: [
            {
              color: THEME_COLORS.darkOrange,
              blocks: [
                { type: "header", text: { type: "plain_text", text: "⏰ Stale: Still Awaiting Reply" } },
                { type: "section", text: { type: "mrkdwn", text: lines } },
              ],
            },
          ],
        }),
      { label: "Slack stale items alert", retries: 2 }
    );
  } catch (error) {
    logger.error("Failed to send stale items alert after retries", error);
  }
}
