import { Message } from "discord.js";
import { prisma } from "../database";
import { config } from "../config";
import { logger } from "../utils/logger";
import { generateExecutiveSummary } from "../ai/analyzer";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Records one message toward the activity heatmap. Called for EVERY message
 * in a watched channel -- including casual chat that never becomes
 * "feedback" -- because raw activity volume and who's around is exactly
 * the signal needed for "when should we run an event", unlike the
 * Feedback table which only captures a filtered subset. Never throws;
 * a tracking failure should never affect the real feedback pipeline.
 */
export async function recordActivity(message: Message): Promise<void> {
  try {
    const dayOfWeek = message.createdAt.getUTCDay();
    const hour = message.createdAt.getUTCHours();

    await prisma.activityBucket.upsert({
      where: { dayOfWeek_hour: { dayOfWeek, hour } },
      create: { dayOfWeek, hour, messageCount: 1 },
      update: { messageCount: { increment: 1 } },
    });

    await prisma.activityBucketAuthor.upsert({
      where: { dayOfWeek_hour_authorId: { dayOfWeek, hour, authorId: message.author.id } },
      create: { dayOfWeek, hour, authorId: message.author.id },
      update: {},
    });
  } catch (error) {
    logger.debug("Failed to record activity (non-fatal)", error);
  }
}

/**
 * Shifts a UTC (dayOfWeek, hour) bucket by a timezone offset for display,
 * correctly rolling the day over in either direction.
 */
function shiftToLocal(dayOfWeek: number, hour: number, offsetHours: number): { dayOfWeek: number; hour: number } {
  let newHour = hour + offsetHours;
  const dayShift = Math.floor(newHour / 24);
  newHour = ((newHour % 24) + 24) % 24;
  const newDay = (((dayOfWeek + dayShift) % 7) + 7) % 7;
  return { dayOfWeek: newDay, hour: newHour };
}

function formatHourRange(hour: number): string {
  const format = (h: number) => {
    const period = h < 12 ? "AM" : "PM";
    const displayHour = h % 12 === 0 ? 12 : h % 12;
    return `${displayHour}${period}`;
  };
  return `${format(hour)}–${format((hour + 1) % 24)}`;
}

export interface PeakSlot {
  dayName: string;
  hourRange: string;
  messageCount: number;
  uniqueAuthors: number;
}

/**
 * Returns the top N (day, hour) slots by message volume, with unique
 * participant counts for each, converted to the configured display timezone.
 */
export async function getPeakTimes(topN: number = 5): Promise<PeakSlot[]> {
  const buckets = await prisma.activityBucket.findMany({
    orderBy: { messageCount: "desc" },
    take: topN,
  });

  if (buckets.length === 0) return [];

  const authorCounts = await prisma.activityBucketAuthor.groupBy({
    by: ["dayOfWeek", "hour"],
    _count: { authorId: true },
  });
  const authorCountMap = new Map(authorCounts.map((a) => [`${a.dayOfWeek}:${a.hour}`, a._count.authorId]));

  return buckets.map((b) => {
    const local = shiftToLocal(b.dayOfWeek, b.hour, config.bot.timezoneOffsetHours);
    return {
      dayName: DAY_NAMES[local.dayOfWeek],
      hourRange: formatHourRange(local.hour),
      messageCount: b.messageCount,
      uniqueAuthors: authorCountMap.get(`${b.dayOfWeek}:${b.hour}`) || 0,
    };
  });
}

/**
 * Builds the full /community peak report: a ranked list of the busiest
 * time slots plus an AI-written recommendation synthesizing the pattern.
 */
export async function generatePeakTimesReport(): Promise<string> {
  const slots = await getPeakTimes(5);

  if (slots.length === 0) {
    return "Not enough activity data collected yet to identify peak times. Check back after the community has been active for a while.";
  }

  let report = `*Peak Engagement Times* (times shown in UTC${config.bot.timezoneOffsetHours >= 0 ? "+" : ""}${config.bot.timezoneOffsetHours})\n\n`;
  report += `Based on message volume and unique active members since tracking began:\n\n`;

  slots.forEach((slot, i) => {
    report += `${i + 1}. **${slot.dayName} ${slot.hourRange}** — ${slot.messageCount} messages from ${slot.uniqueAuthors} unique member${slot.uniqueAuthors === 1 ? "" : "s"}\n`;
  });

  const top = slots[0];
  report += `\n**Best time for an event:** ${top.dayName} ${top.hourRange} -- your highest historical engagement window.\n`;

  const snapshot = slots
    .map((s) => `${s.dayName} ${s.hourRange}: ${s.messageCount} messages, ${s.uniqueAuthors} unique members`)
    .join("; ");
  const aiTake = await generateExecutiveSummary(
    `Top 5 community activity time slots (all times local): ${snapshot}. Recommend the best time window to schedule a community event, and note any pattern (e.g. weekday evenings vs weekends).`
  );
  if (aiTake) report += `\n🤖 *AI Take:*\n${aiTake}\n`;

  return report;
}
