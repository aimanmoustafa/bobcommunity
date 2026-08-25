# BoB Community Intelligence Bot

AI-powered Discord bot for Blitz of Battle: monitors community feedback, classifies it with Claude, routes alerts to Slack and Discord DMs, tracks issues, syncs to Notion, and reports on community health.

## Core Pipeline

1. Watches configured Discord channels (`DISCORD_WATCHED_CHANNELS`)
2. Pre-filters noise (short messages, "gg"/"lol", bare links) before spending an AI call
3. Dedupes near-identical repeat messages from the same author within 5 minutes
4. Pulls recent conversation context so the AI understands a message in context
5. Classifies with Claude via forced tool-use (guaranteed structured output, never fragile JSON parsing): category (21 types), sentiment, urgency, needs-reply, confidence, summary
6. Checks if a staff member already replied in-thread, so it doesn't ask twice
7. Routes and aggregates: repeat reports of the same issue update one Slack message in place instead of spamming; critical items always fire immediately
8. Stores everything, attaches to a tracked Issue if the category warrants it
9. Records activity (day-of-week/hour AND per-calendar-date) for peak-time analysis
10. Detects live staff replies -- precise via Discord's reply-to link, or a channel-wide fallback -- for real response-time tracking

## Reports

- **Daily digest** (~21:00 UTC / midnight Cairo): clustered by issue, trend deltas vs yesterday, capped per section with overflow pointer, AI-written take
- **Weekly report** (Sundays): week-over-week deltas, top open issues, most-requested feature, praise highlights
- **`/community pulse [hours]`**: quick snapshot including rolling average response time
- **`/community peak [window]`**: best time to run an event -- 24h/7d/30d (real dated results) or all-time (recurring weekly pattern)
- **`/community topic <search>`**: everything mentioning a specific hero/feature/keyword
- **`/community todo [window]`**: personal action queue -- needs-reply items (including AI-uncertain "maybe" ones, not just definite "yes") plus flagged follow-ups

## Alerts

- Slack alerts for urgent/needs-reply items, aggregated to avoid spam
- Discord DMs (`DISCORD_DM_USER_IDS`) mirror reports and new alerts
- Toxicity moderation pings: DM-only, actually pings via real @mention, deduplicated per incident
- Stale-item alerts (unanswered past `STALE_REPLY_HOURS`): DM-only, personal accountability signal, never posted to Slack

## Manual Commands

| Command | Description |
|---------|-------------|
| `/community pulse [hours]` | Quick snapshot |
| `/community peak [window]` | Best event time -- 24h/7d/30d/all |
| `/community topic search:<term> [days]` | Everything about a topic |
| `/community todo [window]` | Personal action queue |
| `/community report [period]` | Daily/weekly digest on demand |
| `/community refresh [window]` | Scan recent history for anything new |
| `/community assign issue:<search> to:<name> [follow_up]` | Assign + flag an issue (autocomplete on issue) |
| `/community resolve issue:<search> status:<choice>` | Change an issue's status (autocomplete on issue) |
| `/community faqgap [days]` | Recurring player questions not covered by the FAQ |
| `/community scan channel:<any> [window]` | Scan any channel, even unwatched ones |
| `/feedback list/stats/issues/export/backfill` | Search and manage feedback |

## Reliability

- **Crash alerting**: genuine fatal errors (uncaught exceptions/rejections) send a DM before the process exits. Routine Railway redeploys (SIGTERM) stay silent -- no false-alarm noise on every normal deploy. A "🟢 Bot Started" DM confirms every successful boot.
- **Response-time breakdown by category**: the weekly report shows average reply time per category (e.g. payment issues vs. balance feedback), not one blended figure that hides which categories are actually slow.
- **FAQ gap detection**: cross-references recurring player questions against a static snapshot of the FAQ's questions/keywords (`src/data/faqReference.json`, English only). Flags questions that don't match any FAQ entry well, clustering by recurring topic words. This is a snapshot, not a live connection -- re-export and regenerate if the FAQ changes.

## Integrations

- **Slack**: alerts, digests (orange Blitz of Battle theme)
- **Notion** (optional, `NOTION_API_KEY`): auto-creates Community Management / Bug / Feature DB entries matching the manual CM workflow, escalates existing entries as issues grow
- **Exit feedback**: DMs departing members, tracks and forwards their replies. A short welcome DM on join (`MEMBER_WELCOME_MESSAGE`) opens a DM channel while a shared server still clearly exists -- Discord blocks opening one cold once someone's already left, but tends to keep an existing channel usable, meaningfully improving exit-DM delivery

## Deployment

Docker (`node:20-slim`) on Railway. `prisma db push` runs on container start, applying schema changes automatically.
