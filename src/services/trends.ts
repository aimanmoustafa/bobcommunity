import { prisma } from "../database";
import { logger } from "../utils/logger";
import { sendTrendAlert } from "../slack/notifier";
import { resolveDigestChannel } from "./routing";

// A trend alert fires when today's count for a category is at least
// MIN_MENTIONS and has grown by GROWTH_THRESHOLD vs the prior day.
const MIN_MENTIONS = 10;
const GROWTH_THRESHOLD = 2.0; // 2x = +100%

// Only alert once per category per day
const alertedToday = new Set<string>();
let alertedDate = "";

/**
 * Increment today's counter for a category. Called on every stored feedback.
 */
export async function recordCategoryMention(category: string): Promise<void> {
  const today = startOfUtcDay(new Date());
  try {
    await prisma.dailyCategoryCount.upsert({
      where: { date_category: { date: today, category } },
      create: { date: today, category, count: 1 },
      update: { count: { increment: 1 } },
    });
  } catch (error) {
    logger.debug("Failed to record category mention", error);
  }
}

/**
 * Checks whether a category is trending (sharp growth vs yesterday) and
 * fires a Slack trend alert if so. Called after recording a mention.
 */
export async function checkTrend(category: string): Promise<void> {
  const todayKey = new Date().toISOString().split("T")[0];
  if (alertedDate !== todayKey) {
    alertedDate = todayKey;
    alertedToday.clear();
  }
  if (alertedToday.has(category)) return;

  try {
    const today = startOfUtcDay(new Date());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    const [todayRow, yesterdayRow] = await Promise.all([
      prisma.dailyCategoryCount.findUnique({ where: { date_category: { date: today, category } } }),
      prisma.dailyCategoryCount.findUnique({ where: { date_category: { date: yesterday, category } } }),
    ]);

    const todayCount = todayRow?.count || 0;
    const yesterdayCount = yesterdayRow?.count || 0;

    if (todayCount < MIN_MENTIONS) return;

    // If yesterday had nothing, any 10+ today is itself notable
    const growth = yesterdayCount === 0 ? Infinity : todayCount / yesterdayCount;
    if (growth < GROWTH_THRESHOLD) return;

    alertedToday.add(category);

    const growthLabel =
      yesterdayCount === 0
        ? `0 → ${todayCount} (new spike)`
        : `${yesterdayCount} → ${todayCount} (+${Math.round((growth - 1) * 100)}%)`;

    await sendTrendAlert(
      {
        category,
        growthLabel,
        todayCount,
      },
      resolveDigestChannel()
    );
    logger.info("Trend alert fired", { category, growthLabel });
  } catch (error) {
    logger.error("Trend check failed", error);
  }
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
