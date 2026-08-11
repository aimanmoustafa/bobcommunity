import { config } from "../config";

/**
 * Decides which Slack channel an alert should be posted to.
 *
 * #community-alerts   -> critical urgency (payments, crashes, exploits, server down)
 * #bug-reports        -> bug_report, exploit, performance
 * #balance-feedback   -> balance, hero_feedback
 * #community-feedback -> everything else that needs attention (matchmaking, ui_ux,
 *                          suggestion, feature_request, confusion, question, complaint,
 *                          localization, store, progression, new_player, veteran,
 *                          community_event)
 * #community-moderation -> toxicity
 *
 * Praise and low-urgency items don't get routed here at all -- they only
 * show up in the daily/weekly digest, which posts to #community-digest.
 */
export function resolveAlertChannel(category: string, urgency: string): string {
  if (urgency === "critical") {
    return config.slack.channels.alerts;
  }

  switch (category) {
    case "bug_report":
    case "exploit":
    case "performance":
      return config.slack.channels.bugs;

    case "balance":
    case "hero_feedback":
      return config.slack.channels.balance;

    case "toxicity":
      return config.slack.channels.moderation;

    case "matchmaking":
    case "ui_ux":
    case "suggestion":
    case "feature_request":
    case "confusion":
    case "question":
    case "complaint":
    case "localization":
    case "store":
    case "progression":
    case "new_player":
    case "veteran":
    case "community_event":
    case "monetization":
      return config.slack.channels.feedback;

    default:
      return config.slack.channels.alerts;
  }
}

export function resolveDigestChannel(): string {
  return config.slack.channels.digest;
}
