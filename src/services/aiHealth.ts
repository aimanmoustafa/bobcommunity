import { prisma } from "../database";
import { logger } from "../utils/logger";

const SINGLETON_ID = "singleton";
const CONSECUTIVE_ERROR_THRESHOLD = 3;

async function getState() {
  const existing = await prisma.aiHealthState.findUnique({ where: { id: SINGLETON_ID } });
  if (existing) return existing;
  return prisma.aiHealthState.create({ data: { id: SINGLETON_ID } });
}

export async function recordAiSuccess(): Promise<void> {
  try {
    await prisma.aiHealthState.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, lastSuccessAt: new Date(), consecutiveErrors: 0, totalCalls: 1 },
      update: { lastSuccessAt: new Date(), consecutiveErrors: 0, totalCalls: { increment: 1 } },
    });
  } catch (error) {
    logger.debug("Failed to record AI success", error);
  }
}

export async function recordAiError(message: string): Promise<void> {
  try {
    const state = await getState();
    await prisma.aiHealthState.update({
      where: { id: SINGLETON_ID },
      data: {
        lastErrorAt: new Date(),
        lastErrorMessage: message,
        consecutiveErrors: state.consecutiveErrors + 1,
        totalCalls: { increment: 1 },
        totalErrors: { increment: 1 },
      },
    });
  } catch (error) {
    logger.debug("Failed to record AI error", error);
  }
}

/** Returns a warning string if AI is unhealthy (3+ consecutive errors), else null. */
export async function getAiHealthWarning(): Promise<string | null> {
  try {
    const state = await prisma.aiHealthState.findUnique({ where: { id: SINGLETON_ID } });
    if (!state) return null;

    if (state.consecutiveErrors >= CONSECUTIVE_ERROR_THRESHOLD) {
      return `⚠️ AI analysis has failed ${state.consecutiveErrors} times in a row (last error: ${state.lastErrorMessage}). Numbers below may not reflect real community activity -- check ANTHROPIC_API_KEY / ANTHROPIC_MODEL.`;
    }
    return null;
  } catch {
    return null;
  }
}
