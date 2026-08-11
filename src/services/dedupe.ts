import { prisma } from "../database";
import { logger } from "../utils/logger";

/**
 * Checks if the same author has posted a near-identical message very
 * recently (last 5 minutes). Prevents someone pasting the same complaint
 * 3 times from being analyzed 3 separate times.
 */
export async function isDuplicateFromAuthor(
  authorId: string,
  content: string,
  channelId: string
): Promise<boolean> {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const recent = await prisma.feedback.findMany({
      where: {
        authorId,
        channelId,
        createdAt: { gte: fiveMinutesAgo },
      },
      select: { content: true },
      take: 5,
    });

    const normalized = normalize(content);
    return recent.some((r) => similarity(normalize(r.content), normalized) > 0.85);
  } catch (error) {
    logger.debug("Dedupe check failed, proceeding anyway", error);
    return false;
  }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Simple similarity ratio based on shared word overlap.
 * Good enough to catch copy-pasted repeats without heavy NLP.
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const wordsA = new Set(a.split(" "));
  const wordsB = new Set(b.split(" "));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}
