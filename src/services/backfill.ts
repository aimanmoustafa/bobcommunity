import { Client, TextChannel, Message, Collection } from "discord.js";
import { prisma } from "../database";
import { config } from "../config";
import { handleMessage, MessageOutcome } from "../discord/messageHandler";
import { logger } from "../utils/logger";

const PAGE_SIZE = 100; // Discord's max per fetch call
const MAX_PAGES_PER_CHANNEL = 10; // safety cap: up to 1000 messages per run
const DELAY_BETWEEN_MESSAGES_MS = 300; // keep well under AI/Slack rate limits

export interface BackfillSummary {
  channelsProcessed: number;
  scanned: number;
  filteredOut: number;
  duplicates: number;
  aiDisabled: number;
  aiErrors: number;
  notFeedback: number;
  stored: number;
  alerted: number;
  truncatedChannels: string[]; // hit the page cap -- there may be more unprocessed history
}

function emptySummary(): BackfillSummary {
  return {
    channelsProcessed: 0,
    scanned: 0,
    filteredOut: 0,
    duplicates: 0,
    aiDisabled: 0,
    aiErrors: 0,
    notFeedback: 0,
    stored: 0,
    alerted: 0,
    truncatedChannels: [],
  };
}

function tally(summary: BackfillSummary, outcome: MessageOutcome): void {
  summary.scanned++;
  switch (outcome.status) {
    case "filtered_out":
      summary.filteredOut++;
      break;
    case "duplicate":
      summary.duplicates++;
      break;
    case "ai_disabled":
      summary.aiDisabled++;
      break;
    case "ai_error":
      summary.aiErrors++;
      break;
    case "not_feedback":
      summary.notFeedback++;
      break;
    case "stored":
      summary.stored++;
      if (outcome.alerted) summary.alerted++;
      break;
    case "not_watched":
      // shouldn't happen here since we only fetch from watched channels, but harmless
      break;
  }
}

/**
 * Scans one channel for messages newer than its last checkpoint (or newer
 * than `sinceMs` if an explicit window was requested), walking backward from
 * the newest message via `before`-pagination so nothing between pages gets
 * silently skipped. Stops at whichever boundary applies, or after
 * MAX_PAGES_PER_CHANNEL as a safety cap against runaway history scans.
 */
async function backfillChannel(
  client: Client,
  channelId: string,
  sinceMs: number | undefined,
  summary: BackfillSummary
): Promise<void> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !("messages" in channel)) {
    logger.warn("Backfill: channel not found or not text-based", { channelId });
    return;
  }
  const textChannel = channel as TextChannel;

  const checkpoint = await prisma.channelCheckpoint.findUnique({ where: { channelId } });
  const checkpointId = sinceMs ? undefined : checkpoint?.lastMessageId || undefined;
  const cutoffMs = sinceMs ?? undefined;

  // First run, no explicit window, no checkpoint yet: fall back to "last 100" as a sane default.
  const isFirstRunNoWindow = !cutoffMs && !checkpointId;

  let beforeId: string | undefined = undefined;
  let pages = 0;
  let newestMessageIdThisRun: string | undefined;
  const toProcess: Message[] = [];

  outer: while (pages < MAX_PAGES_PER_CHANNEL) {
    const batch: Collection<string, Message> = await textChannel.messages.fetch({
      limit: PAGE_SIZE,
      ...(beforeId ? { before: beforeId } : {}),
    });
    pages++;

    if (batch.size === 0) break;

    const ordered = [...batch.values()]; // Discord returns newest-first
    if (!newestMessageIdThisRun) newestMessageIdThisRun = ordered[0].id;

    for (const message of ordered) {
      if (cutoffMs && message.createdTimestamp < cutoffMs) {
        break outer;
      }
      if (checkpointId && BigInt(message.id) <= BigInt(checkpointId)) {
        break outer;
      }
      toProcess.push(message);
    }

    beforeId = ordered[ordered.length - 1].id;

    if (isFirstRunNoWindow) break; // single page only for the default "no history yet" case

    if (pages >= MAX_PAGES_PER_CHANNEL) {
      summary.truncatedChannels.push(channelId);
    }
  }

  // Process oldest-first so aggregation/context reads naturally
  toProcess.reverse();

  for (const message of toProcess) {
    try {
      const outcome = await handleMessage(message);
      tally(summary, outcome);
    } catch (error) {
      logger.error("Backfill: error processing a message", error);
    }
    await sleep(DELAY_BETWEEN_MESSAGES_MS);
  }

  if (newestMessageIdThisRun) {
    await prisma.channelCheckpoint.upsert({
      where: { channelId },
      create: { channelId, lastMessageId: newestMessageIdThisRun, lastProcessedAt: new Date() },
      update: { lastMessageId: newestMessageIdThisRun, lastProcessedAt: new Date() },
    });
  } else {
    // No messages at all found (empty channel or nothing since checkpoint) -- still
    // record that we checked, so "0 new" reads as "confirmed quiet", not "never ran".
    await prisma.channelCheckpoint.upsert({
      where: { channelId },
      create: { channelId, lastProcessedAt: new Date() },
      update: { lastProcessedAt: new Date() },
    });
  }

  logger.info("Backfill: channel scan complete", {
    channelId,
    scanned: toProcess.length,
    pages,
  });
}

/**
 * Scans all watched channels for new messages through the exact same
 * pipeline as live messages. By default, scans everything since each
 * channel's last checkpoint (true incremental refresh). Pass `hours` to
 * force a specific lookback window instead (e.g. for `/community refresh
 * last24h`), which ignores checkpoints for that run.
 */
export async function backfillWatchedChannels(
  client: Client,
  options: { hours?: number } = {}
): Promise<BackfillSummary> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
