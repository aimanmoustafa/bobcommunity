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
    // If set, the bot only analyzes messages in these channel IDs (comma-separated).
    // Leave unset to watch every channel in the server.
    watchedChannelIds: (process.env.DISCORD_WATCHED_CHANNELS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  },
  openai: {
    apiKey: required("OPENAI_API_KEY"),
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  },
  slack: {
    token: required("SLACK_BOT_TOKEN"),
    // Default/fallback channel if no routing rule matches
    channelId: required("SLACK_CHANNEL_ID"),
    channels: {
      alerts: process.env.SLACK_CHANNEL_ALERTS || process.env.SLACK_CHANNEL_ID,
      bugs: process.env.SLACK_CHANNEL_BUGS || process.env.SLACK_CHANNEL_ID,
      balance: process.env.SLACK_CHANNEL_BALANCE || process.env.SLACK_CHANNEL_ID,
      feedback: process.env.SLACK_CHANNEL_FEEDBACK || process.env.SLACK_CHANNEL_ID,
      moderation: process.env.SLACK_CHANNEL_MODERATION || process.env.SLACK_CHANNEL_ID,
      digest: process.env.SLACK_CHANNEL_DIGEST || process.env.SLACK_CHANNEL_ID,
      memberExits: process.env.SLACK_CHANNEL_MEMBER_EXITS || process.env.SLACK_CHANNEL_ID,
    },
  },
  database: {
    url: required("DATABASE_URL"),
  },
  bot: {
    aggregationWindowMinutes: parseInt(process.env.AGGREGATION_WINDOW_MINUTES || "120"),
    logLevel: process.env.LOG_LEVEL || "info",
    port: parseInt(process.env.PORT || "3000"),
    exitMessage:
      process.env.MEMBER_EXIT_MESSAGE ||
      "Hey there! You were part of the Blitz of Battle community and we noticed you left. We'd really appreciate your feedback.\n\nWhat were you hoping to see but didn't find? What made you leave? What would you like to see improved?\n\nYour input helps us make the game and community better.",
  },
};
