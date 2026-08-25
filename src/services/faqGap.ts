import { prisma } from "../database";
import faqData from "../data/faqReference.json";

interface FaqEntry {
  id: string;
  category: string;
  question: string;
  keywords: string[];
}

// Static snapshot extracted from the FAQ workbook (English sheet, 197
// entries) at the time keywords were generated. This is intentionally a
// snapshot, not a live connection -- the FAQ lives in a separate system
// (AI Help) the bot has no API access to. If the FAQ is updated later,
// re-export it and regenerate this file to keep gap detection accurate.
const FAQ_ENTRIES: FaqEntry[] = faqData as FaqEntry[];

function tokenize(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => w.length > 2));
}

/**
 * Raw count of FAQ keyword phrases found in the player's words -- not a
 * ratio. A ratio would unfairly penalize FAQ entries that happen to have
 * more keywords listed (an entry with 18 keywords needing many matches to
 * score the same as one with 5 keywords makes no sense here); a genuine
 * topical match usually hits at least 2-3 keyword phrases regardless of
 * how many total keywords that FAQ entry has.
 */
function matchCount(playerWords: Set<string>, faqKeywords: string[]): number {
  let matches = 0;
  for (const kw of faqKeywords) {
    const kwWords = kw.split(/\s+/);
    if (kwWords.every((w) => playerWords.has(w))) matches++;
  }
  return matches;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "..." : str;
}

export interface FaqGapItem {
  id: string;
  summary: string;
  authorName: string;
  messageLink: string;
  bestMatchScore: number;
  bestMatchQuestion: string | null;
}

const COVERED_THRESHOLD = 2; // at least 2 matched keyword phrases counts as "already covered"

/**
 * Finds player questions/confusion from the last N days that don't match
 * any existing FAQ entry well -- i.e. real content gaps, not just things
 * players ask that are already answered somewhere in the FAQ.
 */
export async function findFaqGaps(days: number = 30): Promise<FaqGapItem[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.feedback.findMany({
    where: { category: { in: ["question", "confusion"] }, createdAt: { gte: since } },
    select: { id: true, aiSummary: true, content: true, tags: true, authorName: true, messageLink: true },
  });

  const gaps: FaqGapItem[] = [];
  for (const r of rows) {
    const text = `${r.aiSummary || ""} ${r.content} ${(r.tags || []).join(" ")}`;
    const words = tokenize(text);

    let best = 0;
    let bestQuestion: string | null = null;
    for (const faq of FAQ_ENTRIES) {
      const score = matchCount(words, faq.keywords);
      if (score > best) {
        best = score;
        bestQuestion = faq.question;
      }
    }

    if (best < COVERED_THRESHOLD) {
      gaps.push({
        id: r.id,
        summary: r.aiSummary || r.content,
        authorName: r.authorName,
        messageLink: r.messageLink,
        bestMatchScore: best,
        bestMatchQuestion: best > 0 ? bestQuestion : null,
      });
    }
  }

  return gaps;
}

export async function generateFaqGapReport(days: number = 30): Promise<string> {
  const gaps = await findFaqGaps(days);

  if (gaps.length === 0) {
    return `No FAQ content gaps found in the last ${days} days -- every player question matched something reasonably well in the existing FAQ.`;
  }

  // Lightweight clustering: surface which significant words recur across
  // multiple gap items, as a hint toward a genuinely new FAQ topic rather
  // than one-off phrasing.
  const wordCounts = new Map<string, number>();
  for (const g of gaps) {
    for (const w of tokenize(g.summary)) {
      wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
    }
  }
  const recurringWords = [...wordCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  let report = `*FAQ Content Gaps* (last ${days} days)\n\n`;
  report += `${gaps.length} player question${gaps.length === 1 ? "" : "s"} weren't well covered by the existing FAQ:\n\n`;

  const shown = gaps.slice(0, 10);
  for (const g of shown) {
    report += `• ${truncate(g.summary, 120)} -- *${g.authorName}*, [Discord](${g.messageLink})\n`;
    if (g.bestMatchQuestion) {
      report += `  (closest existing FAQ, weak match: "${truncate(g.bestMatchQuestion, 60)}")\n`;
    }
  }
  if (gaps.length > shown.length) {
    report += `\n_+${gaps.length - shown.length} more -- run again with a shorter window to narrow it down._\n`;
  }

  if (recurringWords.length > 0) {
    report += `\n*Recurring topics worth a new FAQ entry:* ${recurringWords.map(([w, c]) => `${w} (${c}x)`).join(", ")}\n`;
  }

  return report;
}
