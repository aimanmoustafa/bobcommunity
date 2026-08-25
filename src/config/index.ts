import dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  discord: {
    token: required("DISCORD_TOKEN"),
    guildId: required("DISCORD_GUILD_ID"),
    watchedChannelIds: (process.env.DISCORD_WATCHED_CHANNELS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    dmUserIds: (process.env.DISCORD_DM_USER_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  },
  slack: {
    token: required("SLACK_BOT_TOKEN"),
    channels: {
      default: required("SLACK_CHANNEL_ID"),
      alerts: process.env.SLACK_CHANNEL_ALERTS,
      bugs: process.env.SLACK_CHANNEL_BUGS,
      balance: process.env.SLACK_CHANNEL_BALANCE,
      moderation: process.env.SLACK_CHANNEL_MODERATION,
      digest: process.env.SLACK_CHANNEL_DIGEST,
      memberExits: process.env.SLACK_CHANNEL_MEMBER_EXITS || required("SLACK_CHANNEL_ID"),
    },
  },
  ai: {
    provider: "Anthropic",
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
  },
  bot: {
    aggregationWindowMinutes: parseInt(process.env.AGGREGATION_WINDOW_MINUTES || "120"),
    logLevel: process.env.LOG_LEVEL || "info",
    port: parseInt(process.env.PORT || "3000"),
    timezoneOffsetHours: parseInt(process.env.TIMEZONE_OFFSET_HOURS || "2"),
    staleReplyHours: parseInt(process.env.STALE_REPLY_HOURS || "24"),
    exitMessage:
      process.env.MEMBER_EXIT_MESSAGE ||
      "Hey there! You were part of the Blitz of Battle community and we noticed you left. We'd really appreciate your feedback.\n\nWhat were you hoping to see but didn't find? What made you leave? What would you like to see improved?\n\nYour input helps us make the game and community better.",
    logMemberExitsToSlack: process.env.LOG_MEMBER_EXITS_TO_SLACK === "true",
  },
  notion: {
    apiKey: process.env.NOTION_API_KEY || "",
    enabled: !!process.env.NOTION_API_KEY,
  },
};
