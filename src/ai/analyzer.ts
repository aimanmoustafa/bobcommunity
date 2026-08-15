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

Always call the submit_analysis tool with your classification. Never respond with plain text.`;

/**
 * Tool definition that forces Claude to return a structured, schema-valid
 * result via tool-use rather than hoping a prompted text response happens
 * to be valid JSON. This is a deliberate reliability choice: prompted JSON
 * can silently break (stray preamble text, a missed code fence) and every
 * failure gets caught and treated as "not feedback" -- which looks exactly
 * like the bot doing nothing. Forcing tool-use removes that failure mode.
 */
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

    return parsed;
  } catch (error) {
    logger.error("AI analysis failed after retries", error);
    return emptyAnalysis();
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
