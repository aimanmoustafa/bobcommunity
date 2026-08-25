import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { logger } from "../utils/logger";
import { recordAiSuccess, recordAiError } from "../services/aiHealth";

const anthropic = config.ai.apiKey ? new Anthropic({ apiKey: config.ai.apiKey }) : null;

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
}

export type AnalysisOutcome =
  | { status: "disabled" }
  | { status: "error"; error: string }
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
  };
}

const CATEGORIES = [
  "bug_report", "balance", "hero_feedback", "matchmaking", "monetization",
  "ui_ux", "performance", "suggestion", "feature_request", "confusion",
  "question", "praise", "complaint", "exploit", "toxicity", "localization",
  "store", "progression", "new_player", "veteran", "community_event",
];

const ANALYSIS_TOOL: Anthropic.Tool = {
  name: "submit_analysis",
  description: "Submit the structured analysis of a Discord message for the Blitz of Battle community management pipeline.",
  input_schema: {
    type: "object",
    properties: {
      isFeedback: { type: "boolean", description: "Whether this message is actual player feedback worth tracking (not spam, banter, or off-topic chat)." },
      category: { type: "string", enum: [...CATEGORIES, "none"], description: "The single best-fitting category. Use 'none' if isFeedback is false." },
      tags: { type: "array", items: { type: "string" }, description: "Short freeform keywords (hero names, features, specific topics mentioned)." },
      sentiment: { type: "string", enum: ["positive", "neutral", "negative", "frustrated", "angry", "excited", "confused"] },
      urgency: { type: "string", enum: ["low", "medium", "high", "critical"] },
      needsReply: { type: "string", enum: ["yes", "no", "maybe"], description: "Whether a CM/dev response is warranted." },
      reason: { type: "string", description: "Brief reason for the classification decisions made." },
      aiSummary: { type: "string", description: "One-sentence summary of what the player is saying." },
      confidence: { type: "number", description: "Confidence in this classification, between 0 and 1." },
    },
    required: [
      "isFeedback", "category", "tags", "sentiment", "urgency",
      "needsReply", "reason", "aiSummary", "confidence",
    ],
  },
};

const SYSTEM_PROMPT = `You are a community intelligence analyst for Blitz of Battle, a mobile MOBA game. Analyze Discord messages from players to determine if they contain actionable feedback, and classify them precisely. Be conservative about isFeedback -- casual chat, greetings, and banter are not feedback. Use the submit_analysis tool to respond, always.`;

export async function analyzeMessageWithStatus(
  content: string,
  context: string = ""
): Promise<AnalysisOutcome> {
  if (!anthropic) return { status: "disabled" };

  try {
    const response = await anthropic.messages.create({
      model: config.ai.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: context
            ? `Recent conversation context:\n${context}\n\nAnalyze this message:\n"${content}"`
            : `Analyze this message:\n"${content}"`,
        },
      ],
      tools: [ANALYSIS_TOOL],
      tool_choice: { type: "tool", name: "submit_analysis" },
    });

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("No tool_use block in response");
    }

    const analysis = toolUse.input as MessageAnalysis;
    await recordAiSuccess();
    return { status: "ok", analysis };
  } catch (error: any) {
    logger.error("AI analysis failed", { error: error?.message });
    await recordAiError(error?.message || "Unknown error");
    return { status: "error", error: error?.message || "Unknown error" };
  }
}

export async function generateExecutiveSummary(snapshot: string): Promise<string | null> {
  if (!anthropic) return null;

  try {
    const response = await anthropic.messages.create({
      model: config.ai.model,
      max_tokens: 300,
      system: "You are a sharp, concise community management analyst. Given a snapshot of stats, write a 3-4 sentence executive take: what actually matters, any risk, and a clear recommendation if warranted. No fluff, no restating the numbers verbatim -- synthesize.",
      messages: [{ role: "user", content: snapshot }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    return textBlock && textBlock.type === "text" ? textBlock.text : null;
  } catch (error: any) {
    logger.error("Failed to generate executive summary", { error: error?.message });
    return null;
  }
}

export { emptyAnalysis };
