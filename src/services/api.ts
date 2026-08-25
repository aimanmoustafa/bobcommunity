import express from "express";
import { getFeedback, getStats } from "./feedback";
import { getIssues, updateIssueStatus } from "./issues";
import { toCsv } from "./export";
import { config } from "../config";
import { logger } from "../utils/logger";

export function startApi(): void {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.get("/feedback", async (_req, res) => {
    const feedback = await getFeedback({ days: 30 });
    res.json(feedback);
  });

  app.get("/feedback/export", async (req, res) => {
    const format = (req.query.format as string) || "json";
    const feedback = await getFeedback({ days: 30 });
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.send(toCsv(feedback as any));
    } else {
      res.json(feedback);
    }
  });

  app.get("/stats", async (_req, res) => res.json(await getStats(7)));
  app.get("/issues", async (_req, res) => res.json(await getIssues()));

  app.patch("/issues/:id/status", async (req, res) => {
    try {
      const updated = await updateIssueStatus(req.params.id, req.body.status);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.listen(config.bot.port, () => logger.info(`API running on port ${config.bot.port}`));
}
