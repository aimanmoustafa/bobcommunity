import { Message } from "discord.js";
import { prisma } from "../database";
import { config } from "../config";
import { logger } from "../utils/logger";
import { generateExecutiveSummary } from "../ai/analyzer";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type PeakWindow = "24h" | "7d" | "30d" | "all";

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Records one message toward the activity heatmap. Called for EVERY message
 * in a watched channel -- including casual chat that never becomes
 * "feedback" -- because raw activity volume and who's around is exactly
 * the signal needed for "when should we run an event", unlike the
 * Feedback table which only captures a filtered subset. Never throws;
 * a tracking failure should never affect the real feedback pipeline.
 *
 * Writes to two parallel sets of tables: the all-time day-of-week pattern
 * (for "Saturdays are generally best" style recurring insight) and a
 * per-calendar-date bucket (for "what happened in just the last 7 days"
 * style windowed queries, which the day-of-week tables structurally can't
 * answer since they don't know which specific date anything happened on).
 */
export async function recordActivity(message: Message): Promise<void> {
  try {
    const dayOfWeek = message.createdAt.getUTCDay();
    const hour = message.createdAt.getUTCHours();
    const date = startOfUtcDay(message.createdAt);

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

    await prisma.dailyActivityBucket.upsert({
      where: { date_hour: { date, hour } },
      create: { date, hour, messageCount: 1 },
      update: { messageCount: { increment: 1 } },
    });
    await prisma.dailyActivityBucketAuthor.upsert({
      where: { date_hour_authorId: { date, hour, authorId: message.author.id } },
      create: { date, hour, authorId: message.author.id },
      update: {},
    });
  } catch (error) {
    logger.debug("Failed to record activity (non-fatal)", error);
  }
}

/** Shifts a UTC (dayOfWeek, hour) bucket by a timezone offset, rolling the day over correctly. */
function shiftDayHourToLocal(dayOfWeek: number, hour: number, offsetHours: number): { dayOfWeek: number; hour: number } {
  let newHour = hour + offsetHours;
  const dayShift = Math.floor(newHour / 24);
  newHour = ((newHour % 24) + 24) % 24;
  const newDay = (((dayOfWeek + dayShift) % 7) + 7) % 7;
  return { dayOfWeek: newDay, hour: newHour };
}

/** Shifts a real UTC calendar date + hour by a timezone offset, using actual Date arithmetic so day/month rollovers are always correct. */
function shiftDateHourToLocal(date: Date, hour: number, offsetHours: number): { label: string; sortKey: number } {
  const shifted = new Date(date.getTime() + hour * 3600000 + offsetHours * 3600000);
  const label = `${DAY_NAMES[shifted.getUTCDay()].slice(0, 3)} ${MONTH_NAMES[shifted.getUTCMonth()]} ${shifted.getUTCDate()}, ${formatHourRange(shifted.getUTCHours())}`;
  return { label, sortKey: shifted.getTime() };
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
  label: string; // pre-formatted for display (either "Saturday 8PM–9PM" or "Tue Aug 18, 8PM–9PM")
  messageCount: number;
  uniqueAuthors: number;
}

/** All-time recurring pattern: "Saturdays at 8pm are generally your busiest." */
async function getAllTimePeakTimes(topN: number): Promise<PeakSlot[]> {
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
    const local = shiftDayHourToLocal(b.dayOfWeek, b.hour, config.bot.timezoneOffsetHours);
    return {
      label: `${DAY_NAMES[local.dayOfWeek]} ${formatHourRange(local.hour)}`,
      messageCount: b.messageCount,
      uniqueAuthors: authorCountMap.get(`${b.dayOfWeek}:${b.hour}`) || 0,
    };
  });
}

/** Windowed: actual busiest specific hours within the last N hours (24h/7d/30d), with real dates. */
async function getWindowedPeakTimes(topN: number, windowHours: number): Promise<PeakSlot[]> {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  // Fetch from a slightly earlier calendar-date floor to be safe, then filter precisely in JS
  const dateFloor = startOfUtcDay(cutoff);

  const buckets = await prisma.dailyActivityBucket.findMany({
    where: { date: { gte: dateFloor } },
  });

  const inWindow = buckets.filter((b) => b.date.getTime() + b.hour * 3600000 >= cutoff.getTime());
  if (inWindow.length === 0) return [];

  const authorRows = await prisma.dailyActivityBucketAuthor.findMany({
    where: { date: { gte: dateFloor } },
  });
  // Use epoch-time + hour as the key, NOT a colon-joined ISO string --
  // ISO timestamps already contain colons (for HH:MM:SS), so splitting
  // "2026-08-18T00:00:00.000Z:18" on ":" breaks the date apart incorrectly.
  const bucketKey = (dateMs: number, hour: number) => `${dateMs}_${hour}`;
  const authorCountMap = new Map<string, number>();
  for (const b of inWindow) {
    const key = bucketKey(b.date.getTime(), b.hour);
    const count = authorRows.filter((a) => a.date.getTime() === b.date.getTime() && a.hour === b.hour).length;
    authorCountMap.set(key, count);
  }

  const top = [...inWindow].sort((a, b) => b.messageCount - a.messageCount).slice(0, topN);

  return top.map((b) => {
    const { label } = shiftDateHourToLocal(b.date, b.hour, config.bot.timezoneOffsetHours);
    return {
      label,
      messageCount: b.messageCount,
      uniqueAuthors: authorCountMap.get(bucketKey(b.date.getTime(), b.hour)) || 0,
    };
  });
}

export async function getPeakTimes(topN: number = 5, window: PeakWindow = "all"): Promise<PeakSlot[]> {
  if (window === "all") return getAllTimePeakTimes(topN);
  const hoursMap: Record<Exclude<PeakWindow, "all">, number> = { "24h": 24, "7d": 168, "30d": 720 };
  return getWindowedPeakTimes(topN, hoursMap[window]);
}

const WINDOW_LABELS: Record<PeakWindow, string> = {
  "24h": "the last 24 hours",
  "7d": "the last 7 days",
  "30d": "the last 30 days",
  all: "since tracking began",
};

/**
 * Builds the full /community peak report: a ranked list of the busiest
 * time slots plus an AI-written recommendation synthesizing the pattern.
 */
export async function generatePeakTimesReport(window: PeakWindow = "all"): Promise<string> {
  const slots = await getPeakTimes(5, window);

  if (slots.length === 0) {
    return `Not enough activity data collected for ${WINDOW_LABELS[window]}. Try a longer window, or check back once the community's been active a while.`;
  }

  let report = `*Peak Engagement Times* (times shown in UTC${config.bot.timezoneOffsetHours >= 0 ? "+" : ""}${config.bot.timezoneOffsetHours})\n\n`;
  report += `Based on message volume and unique active members, ${WINDOW_LABELS[window]}:\n\n`;

  slots.forEach((slot, i) => {
    report += `${i + 1}. **${slot.label}** — ${slot.messageCount} messages from ${slot.uniqueAuthors} unique member${slot.uniqueAuthors === 1 ? "" : "s"}\n`;
  });

  const top = slots[0];
  report += `\n**Best time for an event:** ${top.label} -- your highest engagement window ${WINDOW_LABELS[window]}.\n`;

  const snapshot = slots.map((s) => `${s.label}: ${s.messageCount} messages, ${s.uniqueAuthors} unique members`).join("; ");
  const aiTake = await generateExecutiveSummary(
    `Top 5 community activity time slots, ${WINDOW_LABELS[window]}: ${snapshot}. Recommend the best time window to schedule a community event, and note any pattern (e.g. weekday evenings vs weekends).`
  );
  if (aiTake) report += `\n🤖 *AI Take:*\n${aiTake}\n`;

  return report;
}
