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
  content: string;
  messageLink: string;
  [key: string]: unknown;
}

export function toCsv(rows: FeedbackRow[]): string {
  const headers = [
    "id", "createdAt", "authorName", "channelName", "category", "sentiment",
    "urgency", "needsReply", "replyStatus", "confidence", "aiSummary", "content", "messageLink",
  ];

  const escape = (val: unknown): string => {
    const str = val instanceof Date ? val.toISOString() : String(val ?? "");
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(","));
  return lines.join("\n");
}
