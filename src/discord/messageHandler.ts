import { Message } from "discord.js";
import { config } from "../config";
import { prefilterMessage } from "../ai/prefilter";
import { analyzeMessageWithStatus } from "../ai/analyzer";
import { sendSlackAlert, updateSlackAlert } from "../slack/notifier";
import { sendAlertDm } from "./dmNotifier";
import { storeFeedback } from "../services/feedback";
import { registerReport, saveSlackTs, shouldBypassAggregation } from "../services/aggregation";
import { isDuplicateFromAuthor } from "../services/dedupe";
import { getConversationContext, checkStaffReplied, resolveChannelName } from "../services/context";
import { resolveAlertChannel } from "../services/routing";
import { logger } from "../utils/logger";

/**
 * Outcome of processing a single message. Distinguishes every reason a
 * message might not turn into stored feedback, so callers that need to
 * report accurately (backfill/refresh) never have to guess why a batch
 * came back with "0 feedback" -- was it genuinely quiet, or is the AI
 * layer broken?
 */
export type MessageOutcome =
  | { status: "not_watched" }
  | { status: "filtered_out" }
  | { status: "duplicate" }
  | { status: "ai_disabled" }
  | { status: "ai_error"; message: string }
  | { status: "not_feedback" }
  | { status: "stored"; alerted: boolean };

/**
 * Checks whether this message's channel (or its parent, for threads/forum
 * posts) is in the watch list. If the watch list is empty, every channel
 * is watched.
 */
function isWatchedChannel(message: Message): boolean {
  if (config.discord.watchedChannelIds.length === 0) return true;

  const channel = message.channel as any;
  const channelId = channel.id;
  const parentId = channel.isThread?.() ? channel.parentId : undefined;

  return (
    config.discord.watchedChannelIds.includes(channelId) ||
    (!!parentId && config.discord.watchedChannelIds.includes(parentId))
  );
}

export async function handleMessage(
  message: Message,
  options: { forceWatch?: boolean } = {}
): Promise<MessageOutcome> {
  // Skip bots and DMs
  if (message.author.bot) return { status: "not_watched" };
  if (!message.guild) return { status: "not_watched" };
  if (!message.content || message.content.trim().length === 0) return { status: "not_watched" };
  // The watched-channel restriction only applies to the passive live listener
  // (bounding automatic monitoring to configured channels). Manual commands
  // (backfill/refresh/scan) explicitly represent a requested action on a
  // specific channel, so they pass forceWatch to bypass this gate.
  if (!options.forceWatch && !isWatchedChannel(message)) return { status: "not_watched" };

  // --- Step 1: Lightweight pre-filter ---
  const prefilter = prefilterMessage(message.content);
  if (!prefilter.shouldAnalyze) return { status: "filtered_out" };

  const channelName = resolveChannelName(message);

  // --- Step 2: Dedupe -- skip if same author just posted near-identical text ---
  const isDupe = await isDuplicateFromAuthor(message.author.id, message.content, message.channel.id);
  if (isDupe) {
    logger.debug("Skipping duplicate message from same author", { author: message.author.username });
    return { status: "duplicate" };
  }

  logger.debug("Message passed pre-filter", {
    author: message.author.username,
    channel: channelName,
    critical: prefilter.isCritical,
  });

  // --- Step 3: Gather conversation context (works for channels, threads, forum posts) ---
  const context = await getConversationContext(message);

  // --- Step 4: AI analysis -- structured outcome so failures are never silent ---
  const outcome = await analyzeMessageWithStatus(message.content, message.author.username, channelName, context);

  if (outcome.status === "disabled") {
    return { status: "ai_disabled" };
  }
  if (outcome.status === "error") {
    logger.warn("Message skipped: AI analysis failed", { author: message.author.username, error: outcome.message });
    return { status: "ai_error", message: outcome.message };
  }

  const analysis = outcome.analysis;

  // Not feedback? Stop here.
  if (!analysis.isFeedback) return { status: "not_feedback" };

  // --- Step 5: Build message link ---
  const messageLink = `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`;

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

  const shouldConsiderAlert =
    analysis.needsReply === "yes" || analysis.urgency === "high" || analysis.urgency === "critical";

  if (shouldConsiderAlert) {
    if (bypass) {
      // Critical: always its own fresh alert, no grouping, goes to #community-alerts
      slackTs = await sendSlackAlert(
        {
          analysis,
          authorName: message.author.username,
          channelName,
          messageLink,
          messageContent: message.content,
        },
        targetChannel
      );
      await sendAlertDm(message.client, analysis, message.author.username, channelName, messageLink, message.content);
    } else {
      const agg = await registerReport(
        analysis.category,
        message.channel.id,
        message.author.id,
        analysis.urgency,
        analysis.aiSummary
      );

      if (agg.isNewGroup) {
        slackTs = await sendSlackAlert(
          {
            analysis,
            authorName: message.author.username,
            channelName,
            messageLink,
            messageContent: message.content,
          },
          targetChannel
        );
        if (slackTs) await saveSlackTs(agg.groupKey, slackTs, targetChannel);
        await sendAlertDm(message.client, analysis, message.author.username, channelName, messageLink, message.content);
      } else if (agg.existingSlackTs && agg.existingSlackChannel) {
        const updated = await updateSlackAlert(
          agg.existingSlackTs,
          agg.existingSlackChannel,
          {
            analysis,
            authorName: message.author.username,
            channelName,
            messageLink,
            messageContent: message.content,
          },
          agg.reporterCount
        );
        slackTs = updated ? agg.existingSlackTs : undefined;
      }
    }
  }

  // --- Step 8: Store in database ---
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
    alerted: !!slackTs,
    targetChannel,
    confidence: analysis.confidence,
  });

  return { status: "stored", alerted: !!slackTs };
}
