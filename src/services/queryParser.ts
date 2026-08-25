export interface ParsedQuery {
  category?: string;
  sentiment?: string;
  urgency?: string;
  priority?: string;
  from?: Date;
  to?: Date;
  freeText?: string;
}

export function parseFeedbackQuery(input: string): ParsedQuery {
  const result: ParsedQuery = {};
  let remaining = input;

  const fieldPattern = /(category|sentiment|urgency|priority):(\S+)/gi;
  let match;
  while ((match = fieldPattern.exec(input)) !== null) {
    const [full, field, value] = match;
    (result as any)[field.toLowerCase()] = value;
    remaining = remaining.replace(full, "");
  }

  const now = new Date();
  if (/\btoday\b/i.test(remaining)) {
    result.from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    remaining = remaining.replace(/\btoday\b/i, "");
  } else if (/\byesterday\b/i.test(remaining)) {
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    result.from = y;
    result.to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    remaining = remaining.replace(/\byesterday\b/i, "");
  } else if (/\blast_7d\b/i.test(remaining)) {
    result.from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    remaining = remaining.replace(/\blast_7d\b/i, "");
  }

  const rangeMatch = remaining.match(/from\s+(\d{1,2}:\d{2})\s+to\s+(\d{1,2}:\d{2})/i);
  if (rangeMatch) {
    const [, fromTime, toTime] = rangeMatch;
    const [fh, fm] = fromTime.split(":").map(Number);
    const [th, tm] = toTime.split(":").map(Number);
    result.from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), fh, fm);
    result.to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), th, tm);
    remaining = remaining.replace(rangeMatch[0], "");
  }

  for (const [word, range] of [["morning", [6, 12]], ["afternoon", [12, 18]], ["evening", [18, 24]]] as const) {
    if (new RegExp(`\\b${word}\\b`, "i").test(remaining)) {
      result.from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), range[0]);
      result.to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), range[1]);
      remaining = remaining.replace(new RegExp(`\\b${word}\\b`, "i"), "");
    }
  }

  result.freeText = remaining.trim() || undefined;
  return result;
}
