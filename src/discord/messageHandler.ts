import { Message } from "discord.js";
import { config } from "../config";
import { prefilterMessage } from "../ai/prefilter";
import { analyzeMessageWithStatus } from "../ai/analyzer";
import { sendSlackAlert, updateSlackAlert } from "../slack/notifier";
import { sendAlertDm, sendModerationAlertDm } from "./dmNotifier";
import { storeFeedback } from "../services/feedback";
import { registerReport, saveSlackTs, shouldBypassAggregation } from "../services/aggregation";
import { isDuplicateFromAuthor } from "../services/dedupe";
import { getConversationContext, checkStaffReplied, resolveChannelName } from "../services/context";
import { resolveAlertChannel } from "../services/routing";
import { recordActivity } from "../services/activity";
import { checkForLiveStaffReply } from "../services/responseTracking";
import { logger } from "../utils/logger";

export type MessageOutcome =
  | { status: "not_watched" }
  | { status: "filtered_out" }
  | { status: "duplicate" }
  | { status: "ai_disabled" }
  | { status: "ai_error" }
  | { status: "not_feedback" }
  | { status: "stored"; alerted: boolean };

function isWatchedChannel(message: Message): boolean {
  const watched = config.discord.watchedChannelIds;
  if (watched.length === 0) return true;

  const channel = message.channel as any;
  if (watched.includes(channel.id)) return true;
  if (channel.isThread?.() && channel.parentId && watched.includes(channel.parentId)) return true;
  return false;
}

export async function handleMessage(
  message: Message,
  options: { forceWatch?: boolean } = {}
): Promise<MessageOutcome> {
  if (message.author.bot) return { status: "not_watched" };
  if (!message.guild) return { status: "not_watched" };
  if (!message.content || message.content.trim().length === 0) return { status: "not_watched" };
  if (!options.forceWatch && !isWatchedChannel(message)) return { status: "not_watched" };

  if (!options.forceWatch) {
    recordActivity(message).catch(() => {});
  }
  checkForLiveStaffReply(message).catch(() => {});

  // --- Step 1: Lightweight pre-filter ---
  const prefilter = prefilterMessage(message.content);
  if (!prefilter.shouldAnalyze) return { status: "filtered_out" };

  // --- Step 2: Dedupe check ---
  const isDupe = await isDuplicateFromAuthor(message.author.id, message.content);
  if (isDupe) return { status: "duplicate" };

  // --- Step 3: Conversation context ---
  const context = await getConversationContext(message);

  // --- Step 4: AI analysis ---
  const outcome = await analyzeMessageWithStatus(message.content, context);
  if (outcome.status === "disabled") return { status: "ai_disabled" };
  if (outcome.status === "error") return { status: "ai_error" };

  const analysis = outcome.analysis;
  if (!analysis.isFeedback) return { status: "not_feedback" };

  // --- Step 5: Build message link ---
  const messageLink = `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`;
  const channelName = resolveChannelName(message);

  // --- Step 5b: Moderation alert for toxicity -- fires independently of the
  // urgency/needsReply gating below, since toxic content often doesn't
  // naturally have "needsReply: yes" or high urgency but still deserves a
  // heads-up. DM-only (not Slack), deduplicated per channel over the
  // aggregation window so a heated back-and-forth pings you once, not per message.
  if (analysis.category === "toxicity") {
    const modAgg = await registerReport("moderation_dm", message.channel.id, message.author.id, analysis.urgency, analysis.aiSummary);
    if (modAgg.isNewGroup) {
      await sendModerationAlertDm(message.client, analysis, message.author.username, channelName, messageLink, message.content);
    }
  }

  // --- Step 6: Check if staff already replied ---
  if (analysis.needsReply === "yes") {
    const staffReplied = await checkStaffReplied(message);
    if (staffReplied) {
      analysis.needsReply = "no";
      analysis.reason += " (Staff already replied)";
    }
  }

  // --- Step 7: Route + aggregate -- merge repeat reports into one updating alert ---
  const bypass = shouldBypassAggregation(analysis.urgency);
  const targetChannel = resolveAlertChannel(analysis.category, analysis.urgency);
  let slackTs: string | undefined;

  const shouldConsiderAlert = analysis.needsReply === "yes" || analysis.urgency === "high" || analysis.urgency === "critical";

  if (shouldConsiderAlert) {
    if (bypass) {
      slackTs = await sendSlackAlert(
        { analysis, authorName: message.author.username, channelName, messageLink, messageContent: message.content },
        targetChannel
      );
      await sendAlertDm(message.client, analysis, message.author.username, channelName, messageLink, message.content);
    } else {
      const agg = await registerReport(analysis.category, message.channel.id, message.author.id, analysis.urgency, analysis.aiSummary);

      if (agg.isNewGroup) {
        slackTs = await sendSlackAlert(
          { analysis, authorName: message.author.username, channelName, messageLink, messageContent: message.content },
          targetChannel
        );
        if (slackTs) await saveSlackTs(agg.groupKey, slackTs, targetChannel);
        await sendAlertDm(message.client, analysis, message.author.username, channelName, messageLink, message.content);
      } else if (agg.existingSlackTs && agg.existingSlackChannel) {
        await updateSlackAlert(
          agg.existingSlackTs,
          agg.existingSlackChannel,
          { analysis, authorName: message.author.username, channelName, messageLink, messageContent: message.content },
          agg.reporterCount
        );
        slackTs = agg.existingSlackTs;
      }
    }
  }

  // --- Step 8: Store ---
  await storeFeedback({
    messageId: message.id,
    authorId: message.author.id,
    authorName: message.author.username,
    channelId: message.channel.id,
    channelName,
    guildId: message.guild.id,
    content: message.content,
    messageLink,
    analysis,
    slackTs,
  });

  logger.info("Feedback processed", {
    category: analysis.category,
    urgency: analysis.urgency,
    needsReply: analysis.needsReply,
    confidence: analysis.confidence,
    alerted: !!slackTs,
    targetChannel,
  });

  return { status: "stored", alerted: !!slackTs };
}
