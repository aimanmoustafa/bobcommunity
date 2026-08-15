import { prisma } from "../database";
import { config } from "../config";
import { logger } from "../utils/logger";

const SINGLETON_ID = "singleton";
const UNHEALTHY_THRESHOLD = 3; // consecutive errors before we consider it "failing", not just a blip

export async function recordAiSuccess(): Promise<void> {
  try {
    await prisma.aiHealthState.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, lastSuccessAt: new Date(), totalCalls: 1 },
      update: { lastSuccessAt: new Date(), consecutiveErrors: 0, totalCalls: { increment: 1 } },
    });
  } catch (error) {
    logger.debug("Failed to record AI health success", error);
  }
}

export async function recordAiError(message: string): Promise<void> {
  logger.error("AI request failed", { message });
  try {
    const existing = await prisma.aiHealthState.findUnique({ where: { id: SINGLETON_ID } });
    await prisma.aiHealthState.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        lastErrorAt: new Date(),
        lastErrorMessage: message,
        consecutiveErrors: 1,
        totalCalls: 1,
        totalErrors: 1,
      },
      update: {
        lastErrorAt: new Date(),
        lastErrorMessage: message,
        consecutiveErrors: (existing?.consecutiveErrors || 0) + 1,
        totalCalls: { increment: 1 },
        totalErrors: { increment: 1 },
      },
    });
  } catch (error) {
    logger.debug("Failed to record AI health error", error);
  }
}

/**
 * Returns a human-readable warning to prepend to reports if the AI layer
 * is disabled or appears to be failing, so "0 feedback" is never presented
 * as "no community activity" when it actually means "AI isn't working."
 */
export async function getAiHealthWarning(): Promise<string | null> {
  if (!config.ai.enabled) {
    return "⚠️ AI analysis is currently DISABLED (no ANTHROPIC_API_KEY set). Numbers below reflect zero classified feedback, not zero community activity.";
  }

  try {
    const state = await prisma.aiHealthState.findUnique({ where: { id: SINGLETON_ID } });
    if (!state) return null; // no calls made yet, nothing to warn about

    if (state.consecutiveErrors >= UNHEALTHY_THRESHOLD) {
      return `⚠️ AI analysis appears to be failing (${state.consecutiveErrors} consecutive errors, last: "${state.lastErrorMessage}"). Numbers below may be incomplete -- check ANTHROPIC_API_KEY and ANTHROPIC_MODEL.`;
    }

    if (state.totalCalls > 0 && !state.lastSuccessAt) {
      return `⚠️ AI analysis has never succeeded (last error: "${state.lastErrorMessage}"). Check ANTHROPIC_API_KEY and ANTHROPIC_MODEL.`;
    }

    return null;
  } catch (error) {
    logger.debug("Failed to check AI health", error);
    return null;
  }
}

export async function getAiHealthSnapshot() {
  try {
    return await prisma.aiHealthState.findUnique({ where: { id: SINGLETON_ID } });
  } catch {
    return null;
  }
}
