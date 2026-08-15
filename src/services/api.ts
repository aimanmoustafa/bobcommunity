import express from "express";
import type { Client } from "discord.js";
import { getFeedback, getStats } from "./feedback";
import { getIssues, updateIssueStatus } from "./issues";
import { toCsv, toJson } from "./export";
import { backfillWatchedChannels } from "./backfill";
import { config } from "../config";
import { logger } from "../utils/logger";

export function startApi(discordClient: Client): void {
  const app = express();

  app.post("/backfill", async (_req, res) => {
    try {
      const result = await backfillWatchedChannels(discordClient);
      res.json(result);
    } catch (error) {
      logger.error("Backfill via API failed", error);
      res.status(500).json({ error: "Backfill failed" });
    }
  });

  app.get("/feedback", async (req, res) => {
    try {
      const feedback = await getFeedback({
        category: req.query.category as string,
        urgency: req.query.urgency as string,
        needsReply: req.query.needsReply as string,
        search: req.query.search as string,
        days: req.query.days ? parseInt(req.query.days as string) : undefined,
      });
      res.json({ count: feedback.length, data: feedback });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch feedback" });
    }
  });

  app.get("/feedback/export", async (req, res) => {
    try {
      const format = (req.query.format as string) || "csv";
      const feedback = await getFeedback({
        category: req.query.category as string,
        urgency: req.query.urgency as string,
        needsReply: req.query.needsReply as string,
        search: req.query.search as string,
        days: req.query.days ? parseInt(req.query.days as string) : 30,
      });

      if (format === "json") {
        res.setHeader("Content-Disposition", "attachment; filename=feedback.json");
        res.setHeader("Content-Type", "application/json");
        res.send(toJson(feedback));
      } else {
        res.setHeader("Content-Disposition", "attachment; filename=feedback.csv");
        res.setHeader("Content-Type", "text/csv");
        res.send(toCsv(feedback));
      }
    } catch (error) {
      logger.error("Export failed", error);
      res.status(500).json({ error: "Failed to export feedback" });
    }
  });

  app.get("/stats", async (req, res) => {
    try {
      const days = req.query.days ? parseInt(req.query.days as string) : 7;
      const stats = await getStats(days);
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  app.get("/issues", async (req, res) => {
    try {
      const issues = await getIssues({
        status: req.query.status as string,
        category: req.query.category as string,
      });
      res.json({ count: issues.length, data: issues });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch issues" });
    }
  });

  app.patch("/issues/:id/status", express.json(), async (req, res) => {
    try {
      const updated = await updateIssueStatus(req.params.id, req.body?.status);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ error: error?.message || "Failed to update issue" });
    }
  });

  app.get("/health", (_, res) => res.json({ status: "ok" }));

  app.listen(config.bot.port, () => {
    logger.info(`API running on port ${config.bot.port}`);
  });
}
