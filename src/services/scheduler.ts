import { Client } from "discord.js";
import { prisma } from "../database";
import { generateDailyReport, generateWeeklyReport } from "./feedback";
import { sendDailyReport, sendWeeklyReport } from "../slack/notifier";
import { sendReportDm, sendStaleItemsDm } from "../discord/dmNotifier";
import { resolveDigestChannel } from "./routing";
import { findStaleItems, markStaleAlertSent } from "./responseTracking";
import { logger } from "../utils/logger";

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const DAILY_REPORT_HOUR_UTC = 21;
const WEEKLY_REPORT_DAY = 0;
const WEEKLY_REPORT_HOUR_UTC = 21;

export function startScheduler(client: Client): void {
  setInterval(() => runChecks(client).catch((e) => logger.error("Scheduler tick failed", e)), CHECK_INTERVAL_MS);
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
    const slackOk = await sendDailyReport(report, resolveDigestChannel());
    await sendReportDm(client, "📊 Daily Community Report", report);
    await setState("daily_report", now);
    logger.info(slackOk ? "Daily report sent (Slack + DM)" : "Daily report sent to DM only -- Slack send FAILED, see error above");
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
    const slackOk = await sendWeeklyReport(report, resolveDigestChannel());
    await sendReportDm(client, "📅 Weekly Community Report", report);
    await setState("weekly_report", now);
    logger.info(slackOk ? "Weekly report sent (Slack + DM)" : "Weekly report sent to DM only -- Slack send FAILED, see error above");
  } catch (error) {
    logger.error("Failed to generate/send weekly report", error);
  }
}

async function getState(taskName: string) {
  const existing = await prisma.schedulerState.findUnique({ where: { taskName } });
  return existing || { taskName, lastRunAt: null };
}

async function setState(taskName: string, lastRunAt: Date): Promise<void> {
  await prisma.schedulerState.upsert({ where: { taskName }, create: { taskName, lastRunAt }, update: { lastRunAt } });
}

function isSameUtcDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}
