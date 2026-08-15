/**
 * Parses a free-text query like:
 *   "category:matchmaking sentiment:negative today"
 *   "priority:high last_7d"
 *   "from 12:00 to 18:00"
 *   "yesterday complaints about rewards"
 *
 * into structured filters + an explicit date range, so /feedback and
 * /community commands can support flexible querying without needing a
 * dozen separate Discord command options.
 */

export interface ParsedQuery {
  from?: Date;
  to?: Date;
  category?: string;
  sentiment?: string;
  urgency?: string;
  channelName?: string;
  freeText?: string;
}

const KEY_VALUE_RE = /\b(category|sentiment|urgency|priority|channel):([a-zA-Z0-9_\-]+)/gi;
const FROM_TO_RE = /\bfrom\s+(\d{1,2}:\d{2})\s+to\s+(\d{1,2}:\d{2})\b/i;
const SINCE_RE = /\bsince\s+(\d{1,2}:\d{2})\b/i;

export function parseFeedbackQuery(raw: string | undefined): ParsedQuery {
  const result: ParsedQuery = {};
  if (!raw || !raw.trim()) return result;

  let remaining = raw;
  const now = new Date();

  // --- key:value pairs (category, sentiment, urgency/priority, channel) ---
  let match: RegExpExecArray | null;
  KEY_VALUE_RE.lastIndex = 0;
  while ((match = KEY_VALUE_RE.exec(raw)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2].toLowerCase();
    if (key === "category") result.category = value;
    else if (key === "sentiment") result.sentiment = value;
    else if (key === "urgency" || key === "priority") result.urgency = value;
    else if (key === "channel") result.channelName = value;
  }
  remaining = remaining.replace(KEY_VALUE_RE, "");

  // --- explicit "from HH:MM to HH:MM" (assumes today) ---
  const fromToMatch = remaining.match(FROM_TO_RE);
  if (fromToMatch) {
    result.from = atTimeToday(fromToMatch[1], now);
    result.to = atTimeToday(fromToMatch[2], now);
    remaining = remaining.replace(FROM_TO_RE, "");
  } else {
    const sinceMatch = remaining.match(SINCE_RE);
    if (sinceMatch) {
      result.from = atTimeToday(sinceMatch[1], now);
      result.to = now;
      remaining = remaining.replace(SINCE_RE, "");
    }
  }

  // --- named time windows (only applied if from/to not already set explicitly) ---
  const lower = remaining.toLowerCase();
  if (!result.from) {
    if (/\btoday\b/.test(lower)) {
      result.from = startOfDay(now);
      result.to = now;
      remaining = remaining.replace(/\btoday\b/i, "");
    } else if (/\byesterday\b/.test(lower)) {
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      result.from = startOfDay(yesterday);
      result.to = startOfDay(now);
      remaining = remaining.replace(/\byesterday\b/i, "");
    } else if (/\blast[_ ]?24h\b|\b24h\b|\blast 24 hours\b/.test(lower)) {
      result.from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      result.to = now;
      remaining = remaining.replace(/\blast[_ ]?24h\b|\b24h\b|\blast 24 hours\b/i, "");
    } else if (/\blast[_ ]?7d\b|\bweek\b|\blast week\b/.test(lower)) {
      result.from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      result.to = now;
      remaining = remaining.replace(/\blast[_ ]?7d\b|\bweek\b|\blast week\b/i, "");
    } else if (/\bmorning\b/.test(lower)) {
      result.from = atHourToday(6, now);
      result.to = atHourToday(12, now);
      remaining = remaining.replace(/\bmorning\b/i, "");
    } else if (/\bafternoon\b/.test(lower)) {
      result.from = atHourToday(12, now);
      result.to = atHourToday(18, now);
      remaining = remaining.replace(/\bafternoon\b/i, "");
    } else if (/\bevening\b/.test(lower)) {
      result.from = atHourToday(18, now);
      result.to = atHourToday(24, now);
      remaining = remaining.replace(/\bevening\b/i, "");
    }
  }

  const leftover = remaining.replace(/\s+/g, " ").trim();
  if (leftover) result.freeText = leftover;

  return result;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function atHourToday(hour: number, now: Date): Date {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function atTimeToday(hhmm: string, now: Date): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d;
}
