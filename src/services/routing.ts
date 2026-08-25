import { config } from "../config";

export function resolveAlertChannel(category: string, urgency: string): string {
  const c = config.slack.channels;
  if (category === "bug_report" || category === "performance") return c.bugs || c.default;
  if (category === "balance" || category === "hero_feedback") return c.balance || c.default;
  if (category === "toxicity" || category === "exploit") return c.moderation || c.default;
  if (urgency === "high" || urgency === "critical") return c.alerts || c.default;
  return c.default;
}

export function resolveDigestChannel(): string {
  return config.slack.channels.digest || config.slack.channels.default;
}
