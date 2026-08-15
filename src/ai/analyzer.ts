import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { logger } from "../utils/logger";
import { withRetry } from "../utils/retry";
import { aiRateLimiter } from "../utils/rateLimiter";

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

/** Neutral result used when AI is disabled or a call fails. */
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

Respond with ONLY valid JSON, no other text, no markdown code fences, matching this exact schema:

{
  "isFeedback": boolean,
  "category": "bug_report" | "balance" | "hero_feedback" | "matchmaking" | "monetization" | "ui_ux" | "performance" | "suggestion" | "feature_request" | "confusion" | "question" | "praise" | "complaint" | "exploit" | "toxicity" | "localization" | "store" | "progression" | "new_player" | "veteran" | "community_event" | "none",
  "tags": string[],
  "sentiment": "positive" | "neutral" | "negative" | "frustrated" | "angry" | "excited" | "confused",
  "urgency": "low" | "medium" | "high" | "critical",
  "needsReply": "yes" | "no" | "maybe",
  "reason": "Why this needs CM attention (1-2 sentences)",
  "aiSummary": "Concise summary of what the player is saying",
  "confidence": number between 0 and 1,
  "suggestedReply": "A warm, professional reply the CM can use or adapt"
}

If the message is NOT feedback, return isFeedback: false and category: "none".`;

export async function analyzeMessage(
  content: string,
  authorName: string,
  channelName: string,
  recentContext?: string
): Promise<MessageAnalysis> {
  // AI disabled (no API key yet): skip classification entirely.
  if (!anthropic) {
    return emptyAnalysis();
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
        }),
      { label: "Anthropic analysis", retries: 2 }
    );

    const textBlock = response.content.find((block) => block.type === "text");
    const raw = textBlock && "text" in textBlock ? textBlock.text : undefined;
    if (!raw) throw new Error("Empty AI response");

    const parsed = JSON.parse(extractJson(raw)) as MessageAnalysis;
    logger.debug("AI analysis complete", {
      category: parsed.category,
      isFeedback: parsed.isFeedback,
      confidence: parsed.confidence,
    });

    return parsed;
  } catch (error) {
    logger.error("AI analysis failed after retries", error);
    return emptyAnalysis();
  }
}

/**
 * Claude reliably returns bare JSON given this prompt, but strips any
 * accidental markdown code fences just in case, so parsing never breaks
 * on a stray ```json wrapper.
 */
function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenced ? fenced[1] : trimmed;
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
