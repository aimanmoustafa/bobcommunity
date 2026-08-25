import { createClient } from "./discord/client";
import { sendSystemAlertDm } from "./discord/dmNotifier";
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

  // Crash visibility: without this, a crash looks identical to the bot
  // just being quiet -- you'd only notice by absence. Only genuine fatal
  // errors trigger an alert; SIGTERM (Railway's normal redeploy/restart
  // signal) exits quietly, so this never turns into noise on routine deploys.
  process.on("uncaughtException", async (error) => {
    logger.error("FATAL: uncaught exception", error);
    await sendSystemAlertDm(client, "🔴 Bot Crashed", `Uncaught exception: ${error?.message || error}\n\nThe bot is shutting down. Railway should restart it automatically.`).catch(() => {});
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason: any) => {
    logger.error("FATAL: unhandled promise rejection", reason);
    await sendSystemAlertDm(client, "🔴 Bot Crashed", `Unhandled rejection: ${reason?.message || reason}\n\nThe bot is shutting down. Railway should restart it automatically.`).catch(() => {});
    process.exit(1);
  });

  process.on("SIGTERM", () => {
    logger.info("Received SIGTERM (normal redeploy/restart) -- shutting down gracefully, no crash alert");
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error("Fatal error during startup", error);
  process.exit(1);
});
