const FEEDBACK_KEYWORDS = [
  "bug", "glitch", "broken", "crash", "lag", "issue", "problem", "fix",
  "suggest", "wish", "would be nice", "please add", "feature", "idea",
  "op", "overpowered", "underpowered", "nerf", "buff", "balance",
  "love", "hate", "amazing", "terrible", "awful", "great", "awesome",
  "pay", "purchase", "money", "gems", "refund", "scam",
  "confus", "how do i", "how to", "why does", "what does",
  "matchmaking", "queue", "connection", "disconnect", "server",
];

const CRITICAL_KEYWORDS = ["crash", "can't log in", "cannot log in", "lost my account", "banned", "hacked", "cheat", "exploit", "refund"];

const NOISE_PATTERNS = [/^gg$/i, /^lol+$/i, /^lmao+$/i, /^nice$/i, /^ok$/i, /^k$/i, /^\+1$/, /^👍$/, /^😂+$/];

export interface PrefilterResult {
  shouldAnalyze: boolean;
  isPotentiallyCritical: boolean;
}

export function prefilterMessage(content: string): PrefilterResult {
  const trimmed = content.trim();

  if (trimmed.length < 10) return { shouldAnalyze: false, isPotentiallyCritical: false };
  if (NOISE_PATTERNS.some((p) => p.test(trimmed))) return { shouldAnalyze: false, isPotentiallyCritical: false };
  if (/^https?:\/\/\S+$/.test(trimmed)) return { shouldAnalyze: false, isPotentiallyCritical: false };

  const lower = trimmed.toLowerCase();
  const isPotentiallyCritical = CRITICAL_KEYWORDS.some((k) => lower.includes(k));
  const hasKeyword = FEEDBACK_KEYWORDS.some((k) => lower.includes(k));

  return { shouldAnalyze: hasKeyword || trimmed.length > 40 || isPotentiallyCritical, isPotentiallyCritical };
}
