import { Client } from "discord.js";
import { prisma } from "../database";
import { generateDailyReport, generateWeeklyReport } from "./feedback";
import { sendDailyReport, sendWeeklyReport } from "../slack/notifier";
import { sendReportDm, sendStaleItemsDm } from "../discord/dmNotifier";
import { resolveDigestChannel } from "./routing";
import { findStaleItems, markStaleAlertSent } from "./responseTracking";
import { logger } from "../utils/logger";

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // check every 15 minutes
const DAILY_REPORT_HOUR_UTC = 21; // ~midnight Cairo time
const WEEKLY_REPORT_DAY = 0; // Sunday
const WEEKLY_REPORT_HOUR_UTC = 21;

/**
 * DB-backed scheduler. Persists lastRunAt per task so a process restart
 * near the trigger window doesn't cause a skipped or duplicated report.
 */
export function startScheduler(client: Client): void {
  setInterval(() => runChecks(client).catch((e) => logger.error("Scheduler tick failed", e)), CHECK_INTERVAL_MS);
  // Also run once shortly after boot in case the process was down at trigger time
  setTimeout(() => runChecks(client).catch((e) => logger.error("Scheduler initial tick failed", e)), 30_000);
  logger.info("Scheduler started (daily report ~21:00 UTC, weekly on Sundays)");
}

async function runChecks(client: Client): Promise<void> {
  const now = new Date();

  await maybeRunDaily(client, now);
  await maybeRunWeekly(client, now);
  await checkStaleItems(client);
}

async function checkStaleItems(client: Client): Promise<void> {
  try {
    const stale = await findStaleItems();
    if (stale.length === 0) return;

    // DM only, by design -- response-time/staleness tracking is a personal
    // accountability signal, not something broadcast to the shared Slack channel.
    await sendStaleItemsDm(client, stale);
    await markStaleAlertSent(stale.map((s) => s.id));

    logger.info("Stale items alert sent (DM only)", { count: stale.length });
  } catch (error) {
    logger.error("Failed to check/send stale items alert", error);
  }
}

async function maybeRunDaily(client: Client, now: Date): Promise<void> {
  if (now.getUTCHours() !== DAILY_REPORT_HOUR_UTC) return;

  const state = await getState("daily_report");
  if (state.lastRunAt && isSameUtcDay(state.lastRunAt, now)) return;

  try {
    const report = await generateDailyReport();
    await sendDailyReport(report, resolveDigestChannel());
    await sendReportDm(client, "📊 Daily Community Report", report);
    await setState("daily_report", now);
    logger.info("Daily report sent");
  } catch (error) {
    logger.error("Failed to generate/send daily report", error);
  }
}

async function maybeRunWeekly(client: Client, now: Date): Promise<void> {
  if (now.getUTCDay() !== WEEKLY_REPORT_DAY) return;
  if (now.getUTCHours() !== WEEKLY_REPORT_HOUR_UTC) return;

  const state = await getState("weekly_report");
  if (state.lastRunAt && isSameUtcDay(state.lastRunAt, now)) return;

  try {
    const report = await generateWeeklyReport();
    await sendWeeklyReport(report, resolveDigestChannel());
    await sendReportDm(client, "📅 Weekly Community Report", report);
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
