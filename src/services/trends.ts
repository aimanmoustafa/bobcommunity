import { prisma } from "../database";
import { config } from "../config";
import { sendTrendAlert } from "../slack/notifier";
import { resolveDigestChannel } from "./routing";

const SPIKE_THRESHOLD_COUNT = 10;
const SPIKE_MULTIPLIER = 2;

function todayDate(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function recordCategoryMention(category: string): Promise<void> {
  const date = todayDate();
  await prisma.dailyCategoryCount.upsert({
    where: { date_category: { date, category } },
    create: { date, category, count: 1 },
    update: { count: { increment: 1 } },
  });
}

export async function checkTrend(category: string): Promise<void> {
  const today = todayDate();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

  const [todayRow, yesterdayRow] = await Promise.all([
    prisma.dailyCategoryCount.findUnique({ where: { date_category: { date: today, category } } }),
    prisma.dailyCategoryCount.findUnique({ where: { date_category: { date: yesterday, category } } }),
  ]);

  const todayCount = todayRow?.count || 0;
  const yesterdayCount = yesterdayRow?.count || 0;

  if (todayCount < SPIKE_THRESHOLD_COUNT) return;
  if (yesterdayCount === 0 || todayCount < yesterdayCount * SPIKE_MULTIPLIER) return;

  const growthPct = Math.round(((todayCount - yesterdayCount) / yesterdayCount) * 100);
  await sendTrendAlert(category, todayCount, `+${growthPct}%`, resolveDigestChannel());
}
