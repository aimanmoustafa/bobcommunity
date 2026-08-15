// Structural type for a feedback row. Avoids depending on the named
// `Feedback` export from @prisma/client, which can vary by generator setup.
export interface FeedbackRow {
  id: string;
  createdAt: Date;
  authorName: string;
  channelName: string;
  category: string;
  sentiment: string;
  urgency: string;
  needsReply: string;
  replyStatus: string;
  confidence: number;
  aiSummary: string | null;
  suggestedReply: string | null;
  content: string;
  messageLink: string;
  [key: string]: unknown;
}

/**
 * Converts feedback rows to CSV. Excel opens CSV natively, so this
 * covers both the "CSV" and "Excel" export requirements without needing
 * a separate xlsx dependency in the bot itself.
 */
export function toCsv(rows: FeedbackRow[]): string {
  const headers = [
    "id",
    "createdAt",
    "authorName",
    "channelName",
    "category",
    "sentiment",
    "urgency",
    "needsReply",
    "replyStatus",
    "confidence",
    "aiSummary",
    "suggestedReply",
    "content",
    "messageLink",
  ];

  const escape = (val: unknown): string => {
    const str = String(val ?? "");
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      headers
        .map((h) => escape((row as any)[h] instanceof Date ? (row as any)[h].toISOString() : (row as any)[h]))
        .join(",")
    );
  }
  return lines.join("\n");
}

export function toJson(rows: FeedbackRow[]): string {
  return JSON.stringify(rows, null, 2);
}
