import { prisma } from "../database";

const DEDUPE_WINDOW_MINUTES = 5;
const SIMILARITY_THRESHOLD = 0.85;

function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

export async function isDuplicateFromAuthor(authorId: string, content: string): Promise<boolean> {
  const since = new Date(Date.now() - DEDUPE_WINDOW_MINUTES * 60 * 1000);
  const recent = await prisma.feedback.findMany({
    where: { authorId, createdAt: { gte: since } },
    select: { content: true },
    take: 5,
  });

  return recent.some((r) => wordOverlap(r.content, content) >= SIMILARITY_THRESHOLD);
}
