import { createClient } from "./discord/client";
import { startScheduler } from "./services/scheduler";
import { startApi } from "./services/api";
import { prisma } from "./database";
import { logger } from "./utils/logger";

async function main() {
  logger.info("Starting BoB Community Intelligence Bot...");

  await prisma.$connect();
  logger.info("Database connected");

  const client = createClient();
  await client.login(process.env.DISCORD_TOKEN);

  startScheduler(client);
  startApi();
}

main().catch((error) => {
  logger.error("Fatal error during startup", error);
  process.exit(1);
});
