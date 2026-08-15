import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { logger } from "../utils/logger";
import { withRetry } from "../utils/retry";
import { aiRateLimiter } from "../utils/rateLimiter";
import { recordAiSuccess, recordAiError } from "../services/aiHealth";

const anthropic = config.ai.enabled ? new Anthropic({ apiKey: config.ai.apiKey }) : null;

export interface MessageAnalysis {
  isFeedback: boolean;
  category: string;
  tags: string[];
  sentiment: string;
  urgency: string;
  needsReply: string;
  reason: string;
  aiSummary: string;
  confidence: number;
  suggestedReply: string;
}

/**
 * Structured outcome of an analysis attempt. Distinguishes "AI is turned
 * off", "the AI call itself failed", and "the AI ran fine and genuinely
 * decided this isn't feedback" -- these used to all collapse into the same
 * silent "not feedback" result, which made a broken API key indistinguishable
 * from a quiet day in Discord. Callers that need to report accurately
 * (backfill/refresh, health warnings) should use analyzeMessageWithStatus;
 * the simple live-message path can keep using analyzeMessage.
 */
export type AnalysisOutcome =
  | { status: "disabled" }
  | { status: "error"; message: string }
  | { status: "ok"; analysis: MessageAnalysis };

function emptyAnalysis(): MessageAnalysis {
  return {
    isFeedback: false,
    category: "none",
    tags: [],
    sentiment: "neutral",
    urgency: "low",
    needsReply: "no",
    reason: "",
    aiSummary: "",
    confidence: 0,
    suggestedReply: "",
  };
}

const SYSTEM_PROMPT = `You are the AI brain of a Community Intelligence bot for "Blitz of Battle," a 2v2 mobile MOBA.

Your job: analyze Discord messages and determine if they contain meaningful community feedback that a Community Manager needs to see.

IGNORE: casual chat, greetings, memes, off-topic banter, simple reactions, short messages with no substance (like "lol", "gg", "nice").

FLAG: bug reports, balance complaints, feature requests, payment issues, confusion about game systems, toxicity, exploit reports, unanswered questions, frustrated players, suggestions, localization issues.

CRITICAL (always flag with urgency "critical"): payment/purchase problems, server/login failures, game crashes, exploit/cheating reports, security concerns, large-scale outrage.

Always call the submit_analysis tool with your classification. Never respond with plain text.`;

const ANALYSIS_TOOL: Anthropic.Tool = {
  name: "submit_analysis",
  description: "Submit the structured classification of a Discord message.",
  input_schema: {
    type: "object",
    properties: {
      isFeedback: {
        type: "boolean",
        description: "True if this message contains meaningful community feedback.",
      },
      category: {
        type: "string",
        enum: [
          "bug_report", "balance", "hero_feedback", "matchmaking", "monetization",
          "ui_ux", "performance", "suggestion", "feature_request", "confusion",
          "question", "praise", "complaint", "exploit", "toxicity", "localization",
          "store", "progression", "new_player", "veteran", "community_event", "none",
        ],
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Short topical tags, e.g. hero names, feature names.",
      },
      sentiment: {
        type: "string",
        enum: ["positive", "neutral", "negative", "frustrated", "angry", "excited", "confused"],
      },
      urgency: {
        type: "string",
        enum: ["low", "medium", "high", "critical"],
      },
      needsReply: {
        type: "string",
        enum: ["yes", "no", "maybe"],
      },
      reason: {
        type: "string",
        description: "Why this needs CM attention (1-2 sentences). Empty string if not feedback.",
      },
      aiSummary: {
        type: "string",
        description: "Concise summary of what the player is saying. Empty string if not feedback.",
      },
      confidence: {
        type: "number",
        description: "Confidence in this classification, between 0 and 1.",
      },
      suggestedReply: {
        type: "string",
        description: "A warm, professional reply the CM can use or adapt. Empty string if not feedback.",
      },
    },
    required: [
      "isFeedback", "category", "tags", "sentiment", "urgency",
      "needsReply", "reason", "aiSummary", "confidence", "suggestedReply",
    ],
  },
};

/**
 * Runs the actual Anthropic call and returns a structured outcome that
 * distinguishes disabled / errored / succeeded. This is the source of
 * truth -- analyzeMessage() below is a thin convenience wrapper around it
 * for callers that don't need to distinguish failure modes.
 */
export async function analyzeMessageWithStatus(
  content: string,
  authorName: string,
  channelName: string,
  recentContext?: string
): Promise<AnalysisOutcome> {
  if (!anthropic) {
    return { status: "disabled" };
  }

  const userPrompt = buildPrompt(content, authorName, channelName, recentContext);

  try {
    await aiRateLimiter.acquire();

    const response = await withRetry(
      () =>
        anthropic.messages.create({
          model: config.ai.model,
          max_tokens: 1024,
          temperature: 0.1,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
          tools: [ANALYSIS_TOOL],
          tool_choice: { type: "tool", name: "submit_analysis" },
        }),
      { label: "Anthropic analysis", retries: 2 }
    );

    const toolUseBlock = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (!toolUseBlock) {
      throw new Error(`No tool_use block in response (stop_reason: ${response.stop_reason})`);
    }

    const parsed = toolUseBlock.input as MessageAnalysis;
    logger.debug("AI analysis complete", {
      category: parsed.category,
      isFeedback: parsed.isFeedback,
      confidence: parsed.confidence,
    });

    await recordAiSuccess();
    return { status: "ok", analysis: parsed };
  } catch (error: any) {
    const message = error?.message || String(error);
    await recordAiError(message);
    return { status: "error", message };
  }
}

/**
 * Convenience wrapper for callers that just want a MessageAnalysis and are
 * fine treating "disabled" and "error" the same way (silently skip). This
 * preserves the bot's never-crash-on-a-bad-API-call guarantee for the live
 * message path. Callers that need to report failures accurately (backfill,
 * refresh, health checks) should use analyzeMessageWithStatus instead.
 */
export async function analyzeMessage(
  content: string,
  authorName: string,
  channelName: string,
  recentContext?: string
): Promise<MessageAnalysis> {
  const outcome = await analyzeMessageWithStatus(content, authorName, channelName, recentContext);
  return outcome.status === "ok" ? outcome.analysis : emptyAnalysis();
}

/**
 * Synthesizes a short natural-language executive summary from already-
 * computed report data (stats, top categories, open issues). This is a
 * second, distinct use of the AI beyond per-message classification: instead
 * of just tagging individual messages, it reads the aggregated picture and
 * writes a genuinely useful "here's what actually matters" paragraph, the
 * way a sharp analyst would summarize the numbers for you.
 *
 * Returns null (not a placeholder string) if AI is disabled or the call
 * fails, so callers can omit the section cleanly rather than show empty text.
 */
export async function generateExecutiveSummary(dataSnapshot: string): Promise<string | null> {
  if (!anthropic) return null;

  const prompt = `Here is a community feedback data snapshot for "Blitz of Battle":\n\n${dataSnapshot}\n\nWrite a short (3-4 sentence) executive summary for the community manager: what actually matters here, any notable trend, and one concrete recommended action if warranted. Be direct and specific, referencing only the data given. Do not invent numbers not present above. Plain prose, no headers or bullet points.`;

  try {
    await aiRateLimiter.acquire();

    const response = await withRetry(
      () =>
        anthropic.messages.create({
          model: config.ai.model,
          max_tokens: 300,
          temperature: 0.3,
          messages: [{ role: "user", content: prompt }],
        }),
      { label: "Anthropic executive summary", retries: 1 }
    );

    const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === "text");
    if (!textBlock || !textBlock.text.trim()) throw new Error("Empty summary response");

    await recordAiSuccess();
    return textBlock.text.trim();
  } catch (error: any) {
    await recordAiError(error?.message || String(error));
    return null;
  }
}

function buildPrompt(
  content: string,
  authorName: string,
  channelName: string,
  recentContext?: string
): string {
  let prompt = `Channel: #${channelName}\nAuthor: ${authorName}\nMessage: "${content}"`;
  if (recentContext) {
    prompt = `Recent conversation context:\n${recentContext}\n\n---\nNew message to analyze:\n${prompt}`;
  }
  return prompt;
}
