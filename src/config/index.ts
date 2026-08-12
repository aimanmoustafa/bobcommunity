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
    // Optional at boot: the bot runs without it (AI analysis disabled) so it can
    // still connect to Discord/Slack and handle member-exit DMs. Add the key to
    // switch on full feedback classification.
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    enabled: !!process.env.OPENAI_API_KEY,
  },
  slack: (() => {
    const fallback = required("SLACK_CHANNEL_ID");
    return {
      token: required("SLACK_BOT_TOKEN"),
      // Default/fallback channel if no routing rule matches
      channelId: fallback,
      channels: {
        alerts: process.env.SLACK_CHANNEL_ALERTS || fallback,
        bugs: process.env.SLACK_CHANNEL_BUGS || fallback,
        balance: process.env.SLACK_CHANNEL_BALANCE || fallback,
        feedback: process.env.SLACK_CHANNEL_FEEDBACK || fallback,
        moderation: process.env.SLACK_CHANNEL_MODERATION || fallback,
        digest: process.env.SLACK_CHANNEL_DIGEST || fallback,
        memberExits: process.env.SLACK_CHANNEL_MEMBER_EXITS || fallback,
      },
    };
  })(),
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
