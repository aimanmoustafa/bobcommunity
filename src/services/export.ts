import type { Feedback } from "@prisma/client";

/**
 * Converts feedback rows to CSV. Excel opens CSV natively, so this
 * covers both the "CSV" and "Excel" export requirements without needing
 * a separate xlsx dependency in the bot itself.
 */
export function toCsv(rows: Feedback[]): string {
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

export function toJson(rows: Feedback[]): string {
  return JSON.stringify(rows, null, 2);
}
