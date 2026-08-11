/**
 * Lightweight pre-filter to skip messages that are obviously not feedback.
 * Saves API calls by filtering out casual chat before sending to GPT.
 */

const SKIP_PATTERNS = [
  /^(lol|lmao|gg|nice|bruh|haha|xd|rip|oof|ez|pog|lets?\sgo|w+|damn|yo|sup|hey|hi|hello|gm|gn|ty|thx|thanks|np|ok|k|bet|fr|nah|idk|wow|omg|chill|vibe|based|cap|no\s?cap)$/i,
  /^.{0,3}$/, // 3 chars or less
  /^<a?:\w+:\d+>$/, // single emoji
  /^https?:\/\/\S+$/, // bare link with nothing else
];

const FEEDBACK_KEYWORDS = [
  "bug", "crash", "lag", "broken", "fix", "nerf", "buff", "overpowered", "op",
  "underpowered", "weak", "unfair", "unbalanced", "matchmaking", "mmr",
  "pay to win", "p2w", "expensive", "refund", "purchase", "gems", "coins",
  "suggestion", "feature", "request", "please add", "should add", "wish",
  "why can't", "how do", "how does", "where is", "what is", "help",
  "stuck", "confused", "frustrat", "annoying", "terrible", "worst",
  "love this", "great game", "amazing", "best moba",
  "cheat", "hack", "exploit", "abuse", "glitch",
  "server", "login", "disconnect", "kick", "freeze",
  "translate", "language", "localization", "arabic", "spanish",
  "halyx", "iron monk", "hero", "spell", "ability", "skill",
  "rank", "ranked", "ladder", "trophy", "season",
  "update", "patch", "version", "maintenance",
  "toxic", "report", "ban", "mute",
];

const CRITICAL_KEYWORDS = [
  "can't login", "cant login", "login fail", "server down", "servers down",
  "crash", "not loading", "black screen", "stuck on loading",
  "money", "paid", "charged", "refund", "purchase", "didn't receive",
  "didn't get", "stole", "scam",
  "hack", "cheat", "exploit", "aimbot", "speed hack",
];

export interface PrefilterResult {
  shouldAnalyze: boolean;
  isCritical: boolean;
}

export function prefilterMessage(content: string): PrefilterResult {
  const trimmed = content.trim();

  // Skip obvious non-feedback
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { shouldAnalyze: false, isCritical: false };
    }
  }

  // Too short to be meaningful feedback (unless it's a question)
  if (trimmed.length < 10 && !trimmed.includes("?")) {
    return { shouldAnalyze: false, isCritical: false };
  }

  const lower = trimmed.toLowerCase();

  // Critical keywords always get analyzed
  const isCritical = CRITICAL_KEYWORDS.some((kw) => lower.includes(kw));
  if (isCritical) {
    return { shouldAnalyze: true, isCritical: true };
  }

  // Check for feedback signals
  const hasFeedbackSignal = FEEDBACK_KEYWORDS.some((kw) => lower.includes(kw));
  const hasQuestion = trimmed.includes("?");
  const isLongEnough = trimmed.length > 40;

  // Analyze if it has a feedback keyword, is a question, or is long enough to matter
  if (hasFeedbackSignal || hasQuestion || isLongEnough) {
    return { shouldAnalyze: true, isCritical: false };
  }

  return { shouldAnalyze: false, isCritical: false };
}
