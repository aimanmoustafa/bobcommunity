import { config } from "./config";
import { connectDatabase } from "./database";
import { createDiscordClient } from "./discord/client";
import { startApi } from "./services/api";
import { startScheduler } from "./services/scheduler";
import { logger } from "./utils/logger";

function printStartupBanner(discordConnected: boolean): void {
  const lines = [
    "===== BoB Community Bot: Startup Diagnostic =====",
    `AI Provider: Anthropic`,
    `AI Model: ${config.ai.model}`,
    `API Key: ${config.ai.enabled ? "Configured" : "MISSING"}`,
    `Discord: ${discordConnected ? "Connected" : "Connecting..."}`,
    `Watched Channels: ${config.discord.watchedChannelIds.length || "ALL (none configured)"}`,
    `AI Analysis: ${config.ai.enabled ? "Enabled" : "DISABLED"}`,
    "==================================================",
  ];
  for (const line of lines) logger.info(line);
}

async function main(): Promise<void> {
  logger.info("Starting BoB Community Intelligence Bot...");
  printStartupBanner(false);

  // Connect to database
  await connectDatabase();

  // Create and login Discord client (command registration happens in the
  // client's ClientReady handler, which is attached before login).
  const client = createDiscordClient();
  await client.login(config.discord.token);
  printStartupBanner(true);

  // Start REST API
  startApi(client);

  // Start scheduled tasks
  startScheduler(client);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    client.destroy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  logger.error("Fatal error", error);
  process.exit(1);
});
