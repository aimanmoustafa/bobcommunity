import { config } from "./config";
import { connectDatabase } from "./database";
import { createDiscordClient } from "./discord/client";
import { startApi } from "./services/api";
import { startScheduler } from "./services/scheduler";
import { logger } from "./utils/logger";

async function main(): Promise<void> {
  logger.info("Starting BoB Community Intelligence Bot...");
  if (config.openai.enabled) {
    logger.info("AI analysis: ENABLED");
  } else {
    logger.warn("AI analysis: DISABLED (no OPENAI_API_KEY set). Bot will connect and handle member-exit DMs; add the key to switch on feedback classification.");
  }

  // Connect to database
  await connectDatabase();

  // Create and login Discord client (command registration happens in the
  // client's ClientReady handler, which is attached before login).
  const client = createDiscordClient();
  await client.login(config.discord.token);

  // Start REST API
  startApi();

  // Start scheduled tasks
  startScheduler();

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
