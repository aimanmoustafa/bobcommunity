import { Client, TextChannel, ThreadChannel } from "discord.js";
import { prisma } from "../database";
import { config } from "../config";
import { logger } from "../utils/logger";
import { handleMessage } from "../discord/messageHandler";

export interface BackfillSummary {
  scanned: number;
  stored: number;
  alerted: number;
  aiErrors: number;
  aiDisabled: number;
  channelsProcessed: number;
  truncatedChannels: string[];
}

function emptySummary(): BackfillSummary {
  return { scanned: 0, stored: 0, alerted: 0, aiErrors: 0, aiDisabled: 0, channelsProcessed: 0, truncatedChannels: [] };
}

const MAX_MESSAGES_PER_CHANNEL = 1000;
const PAGE_SIZE = 100;

export async function backfillChannel(
  client: Client,
  channelId: string,
  sinceMs: number | undefined,
  summary: BackfillSummary
): Promise<void> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !("messages" in channel)) return;

  const checkpoint = await prisma.channelCheckpoint.findUnique({ where: { channelId } });
  const useCheckpoint = sinceMs === undefined && checkpoint?.lastMessageId;

  let before: string | undefined;
  let messagesFetched = 0;
  let latestMessageId: string | undefined;
  let hitLimit = false;

  while (messagesFetched < MAX_MESSAGES_PER_CHANNEL) {
    const batch = await (channel as TextChannel | ThreadChannel).messages.fetch({ limit: PAGE_SIZE, before });
    if (batch.size === 0) break;

    const sorted = [...batch.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    if (!latestMessageId) latestMessageId = sorted[0].id;

    for (const message of sorted) {
      if (useCheckpoint && message.id === checkpoint!.lastMessageId) {
        messagesFetched = MAX_MESSAGES_PER_CHANNEL;
        break;
      }
      if (sinceMs !== undefined && message.createdTimestamp < sinceMs) {
        messagesFetched = MAX_MESSAGES_PER_CHANNEL;
        break;
      }

      summary.scanned++;
      const outcome = await handleMessage(message, { forceWatch: true });
      if (outcome.status === "stored") {
        summary.stored++;
        if ((outcome as any).alerted) summary.alerted++;
      } else if (outcome.status === "ai_error") {
        summary.aiErrors++;
      } else if (outcome.status === "ai_disabled") {
        summary.aiDisabled++;
      }
    }

    before = sorted[sorted.length - 1].id;
    messagesFetched += batch.size;
    if (batch.size < PAGE_SIZE) break;
  }

  if (messagesFetched >= MAX_MESSAGES_PER_CHANNEL) hitLimit = true;
  if (hitLimit) summary.truncatedChannels.push(channelId);

  if (latestMessageId) {
    await prisma.channelCheckpoint.upsert({
      where: { channelId },
      create: { channelId, lastMessageId: latestMessageId },
      update: { lastMessageId: latestMessageId, lastProcessedAt: new Date() },
    });
  }
}

export async function backfillWatchedChannels(client: Client, options: { hours?: number } = {}): Promise<BackfillSummary> {
  const channelIds = config.discord.watchedChannelIds;
  const summary = emptySummary();

  if (channelIds.length === 0) {
    logger.warn("Backfill skipped: no DISCORD_WATCHED_CHANNELS configured");
    return summary;
  }

  const sinceMs = options.hours ? Date.now() - options.hours * 60 * 60 * 1000 : undefined;

  for (const channelId of channelIds) {
    try {
      await backfillChannel(client, channelId, sinceMs, summary);
      summary.channelsProcessed++;
    } catch (error) {
      logger.error("Backfill: failed to process channel", { channelId, error });
    }
  }

  logger.info("Backfill complete", summary);
  return summary;
}

export async function scanChannel(client: Client, channelId: string, options: { hours?: number } = {}): Promise<BackfillSummary> {
  const summary = emptySummary();
  const sinceMs = options.hours ? Date.now() - options.hours * 60 * 60 * 1000 : undefined;

  try {
    await backfillChannel(client, channelId, sinceMs, summary);
    summary.channelsProcessed++;
  } catch (error) {
    logger.error("Scan: failed to process channel", { channelId, error });
  }

  logger.info("Ad hoc channel scan complete", { channelId, ...summary });
  return summary;
}
