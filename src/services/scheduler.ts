import { prisma } from "../database";
import { generateDailyReport, generateWeeklyReport } from "./feedback";
import { sendDailyReport, sendWeeklyReport } from "../slack/notifier";
import { resolveDigestChannel } from "./routing";
import { logger } from "../utils/logger";

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // check every 15 minutes
const DAILY_REPORT_HOUR_UTC = 21; // ~midnight Cairo time
const WEEKLY_REPORT_DAY = 0; // Sunday
const WEEKLY_REPORT_HOUR_UTC = 21;

/**
 * DB-backed scheduler. Persists lastRunAt per task so a process restart
 * near the trigger window doesn't cause a skipped or duplicated report.
 */
export function startScheduler(): void {
  setInterval(() => runChecks().catch((e) => logger.error("Scheduler tick failed", e)), CHECK_INTERVAL_MS);
  // Also run once shortly after boot in case the process was down at trigger time
  setTimeout(() => runChecks().catch((e) => logger.error("Scheduler initial tick failed", e)), 30_000);
  logger.info("Scheduler started (daily report ~21:00 UTC, weekly on Sundays)");
}

async function runChecks(): Promise<void> {
  const now = new Date();

  await maybeRunDaily(now);
  await maybeRunWeekly(now);
}

async function maybeRunDaily(now: Date): Promise<void> {
  if (now.getUTCHours() !== DAILY_REPORT_HOUR_UTC) return;

  const state = await getState("daily_report");
  if (state.lastRunAt && isSameUtcDay(state.lastRunAt, now)) return;

  try {
    const report = await generateDailyReport();
    await sendDailyReport(report, resolveDigestChannel());
    await setState("daily_report", now);
    logger.info("Daily report sent");
  } catch (error) {
    logger.error("Failed to generate/send daily report", error);
  }
}

async function maybeRunWeekly(now: Date): Promise<void> {
  if (now.getUTCDay() !== WEEKLY_REPORT_DAY) return;
  if (now.getUTCHours() !== WEEKLY_REPORT_HOUR_UTC) return;

  const state = await getState("weekly_report");
  if (state.lastRunAt && isSameUtcDay(state.lastRunAt, now)) return;

  try {
    const report = await generateWeeklyReport();
    await sendWeeklyReport(report, resolveDigestChannel());
    await setState("weekly_report", now);
    logger.info("Weekly report sent");
  } catch (error) {
    logger.error("Failed to generate/send weekly report", error);
  }
}

async function getState(taskName: string) {
  const existing = await prisma.schedulerState.findUnique({ where: { taskName } });
  return existing || { taskName, lastRunAt: null };
}

async function setState(taskName: string, lastRunAt: Date): Promise<void> {
  await prisma.schedulerState.upsert({
    where: { taskName },
    create: { taskName, lastRunAt },
    update: { lastRunAt },
  });
}

function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}
