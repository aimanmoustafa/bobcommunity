import { Message } from "discord.js";
import { config } from "../config";
import { prefilterMessage } from "../ai/prefilter";
import { analyzeMessage } from "../ai/analyzer";
import { sendSlackAlert, updateSlackAlert } from "../slack/notifier";
import { storeFeedback } from "../services/feedback";
import { registerReport, saveSlackTs, shouldBypassAggregation } from "../services/aggregation";
import { isDuplicateFromAuthor } from "../services/dedupe";
import { getConversationContext, checkStaffReplied, resolveChannelName } from "../services/context";
import { resolveAlertChannel } from "../services/routing";
import { logger } from "../utils/logger";

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

export async function handleMessage(message: Message): Promise<void> {
  // Skip bots and DMs
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.content || message.content.trim().length === 0) return;
  if (!isWatchedChannel(message)) return;

  // --- Step 1: Lightweight pre-filter ---
  const prefilter = prefilterMessage(message.content);
  if (!prefilter.shouldAnalyze) return;

  const channelName = resolveChannelName(message);

  // --- Step 2: Dedupe -- skip if same author just posted near-identical text ---
  const isDupe = await isDuplicateFromAuthor(message.author.id, message.content, message.channel.id);
  if (isDupe) {
    logger.debug("Skipping duplicate message from same author", { author: message.author.username });
    return;
  }

  logger.debug("Message passed pre-filter", {
    author: message.author.username,
    channel: channelName,
    critical: prefilter.isCritical,
  });

  // --- Step 3: Gather conversation context (works for channels, threads, forum posts) ---
  const context = await getConversationContext(message);

  // --- Step 4: AI analysis ---
  const analysis = await analyzeMessage(message.content, message.author.username, channelName, context);

  // Not feedback? Stop here.
  if (!analysis.isFeedback) return;

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
}
