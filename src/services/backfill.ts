import { Client, TextChannel } from "discord.js";
import { config } from "../config";
import { handleMessage } from "../discord/messageHandler";
import { logger } from "../utils/logger";

const BACKFILL_LIMIT_PER_CHANNEL = 100; // Discord's max per single fetch call
const DELAY_BETWEEN_MESSAGES_MS = 300; // keep well under AI/Slack rate limits

/**
 * One-time historical scan: the bot only reacts to NEW messages via the
 * MessageCreate event, so anything posted before the bot came online (or
 * before intents/API key were fixed) was never seen. This fetches the most
 * recent messages from each watched channel and runs them through the exact
 * same analysis pipeline as live messages.
 *
 * Limited to the most recent 100 messages per channel (Discord's per-call
 * fetch limit) to keep this simple and fast; run it again later if you need
 * to go further back, since aggregation/dedupe naturally prevent double-processing
 * of messages already stored.
 */
export async function backfillWatchedChannels(client: Client): Promise<{ scanned: number; channels: number }> {
  const channelIds = config.discord.watchedChannelIds;

  if (channelIds.length === 0) {
    logger.warn("Backfill skipped: no DISCORD_WATCHED_CHANNELS configured");
    return { scanned: 0, channels: 0 };
  }

  let totalScanned = 0;
  let channelsProcessed = 0;

  for (const channelId of channelIds) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !("messages" in channel)) {
        logger.warn("Backfill: channel not found or not text-based", { channelId });
        continue;
      }

      const messages = await (channel as TextChannel).messages.fetch({ limit: BACKFILL_LIMIT_PER_CHANNEL });
      const ordered = [...messages.values()].reverse(); // oldest first

      logger.info("Backfill: scanning channel", { channelId, count: ordered.length });

      for (const message of ordered) {
        try {
          await handleMessage(message);
          totalScanned++;
        } catch (error) {
          logger.error("Backfill: error processing a message", error);
        }
        await sleep(DELAY_BETWEEN_MESSAGES_MS);
      }

      channelsProcessed++;
    } catch (error) {
      logger.error("Backfill: failed to fetch channel", { channelId, error });
    }
  }

  logger.info("Backfill complete", { totalScanned, channelsProcessed });
  return { scanned: totalScanned, channels: channelsProcessed };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
