import { config } from "./config";
import { connectDatabase } from "./database";
import { createDiscordClient, registerCommands } from "./discord/client";
import { startApi } from "./services/api";
import { startScheduler } from "./services/scheduler";
import { logger } from "./utils/logger";

async function main(): Promise<void> {
  logger.info("Starting BoB Community Intelligence Bot...");

  // Connect to database
  await connectDatabase();

  // Create and login Discord client
  const client = createDiscordClient();
  await client.login(config.discord.token);

  // Register slash commands once ready
  client.once("ready", async (c) => {
    await registerCommands(c.user.id);
  });

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
