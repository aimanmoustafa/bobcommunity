# BoB Community Intelligence Bot

AI-powered Discord bot for Blitz of Battle: monitors community feedback, classifies it with Claude, routes alerts to Slack and Discord DMs, tracks issues, syncs to Notion, and reports on community health.

## Core Pipeline

1. Watches configured Discord channels (`DISCORD_WATCHED_CHANNELS`)
2. Decides which messages are worth an AI call (see **Message Selection** below)
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
- **Two versions of each digest.** Slack gets no reply-tracking detail. The Discord DM version adds the "Needs a reply" section (daily), the "items still awaiting reply" count and response time by category (weekly). `/community report` is private to you, so it shows the full version.
- **`/community pulse [hours]`**: quick snapshot including rolling average response time
- **`/community peak [window]`**: best time to run an event -- 24h/7d/30d (real dated results) or all-time (recurring weekly pattern)
- **`/community topic <search>`**: everything mentioning a specific hero/feature/keyword
- **`/community todo [window]`**: personal action queue -- needs-reply items (including AI-uncertain "maybe" ones, not just definite "yes") plus flagged follow-ups

## Alerts

- Slack alerts fire only for **high or critical urgency**, aggregated to avoid spam
- **"Needs a reply" is private.** Non-urgent items that need a reply go to the Discord DM only, never Slack
- Discord DMs (`DISCORD_DM_USER_IDS`) get the full reports and every new alert
- Toxicity moderation pings: DM-only, actually pings via real @mention, deduplicated per incident
- Stale-item alerts (unanswered past `STALE_REPLY_HOURS`): DM-only, personal accountability signal, never posted to Slack

## Message Selection

`src/ai/prefilter.ts` decides which Discord messages are sent to the AI. Every pass costs money and every drop is feedback the bot never sees, so the rules are documented at the top of that file. In short: links, mentions and emoji are stripped first; acknowledgements and greetings are dropped; critical phrases, question marks (any language, including `؟` and `¿`), strong feedback keywords, hero names and game terms pass; long prose with no signal passes; everything else is dropped. Keywords match whole words only, so "op" no longer fires on "people" or "stop".

- Hero names (localized for all 8 FAQ languages) and game terms come from the FAQ, in `src/data/prefilterVocabulary.json`.
- English keyword lists are hand-written; other languages rely on question marks, hero names, shared English game terms and the long-message rule. Non-English statements with none of those are the main known gap.
- `npm run check:prefilter` runs `tools/prefilter-cases.json` (labeled real and synthetic messages, including known misses and known leaks) through the real filter. When it misjudges something, add the message to that file.
- Set `LOG_LEVEL=debug` to see which rule decided each message.

### Refreshing FAQ-derived data

When the FAQ changes, regenerate both data files and commit them:

```
pip install openpyxl
python3 tools/generate_faq_data.py path/to/faqworkbook.xlsx
```

This rewrites `src/data/faqReference.json` (used by `/community faqgap`) and `src/data/prefilterVocabulary.json` (used by message selection).

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
| `/community notiondata issue:<search> [format]` | Copy-paste export for pasting into a Notion-creating chat with Claude. `format:raw` (default) gives one block per contributing message -- unmerged, untranslated, no bot-added sentiment/tags, including live-fetched reactions and screenshot/attachment presence. `format:summary` gives one clustered Notion-ready entry instead |
| `/community scan channel:<any> [window]` | Scan any channel, even unwatched ones |
| `/feedback list/stats/issues/export/backfill` | Search and manage feedback |

## Access Control

Only the user IDs listed in `DISCORD_AUTHORIZED_USERS` (defaults to Ayman's ID) can run `/feedback` or `/community` commands -- checked in code, not just Discord's permission menu, so it can't be bypassed by a server role change. Regular members can't see or use these commands at all.

## Reliability

- **Crash alerting**: genuine fatal errors (uncaught exceptions/rejections) send a DM before the process exits. Routine Railway redeploys (SIGTERM) stay silent -- no false-alarm noise on every normal deploy. A "🟢 Bot Started" DM confirms every successful boot.
- **Response-time breakdown by category**: the weekly report shows average reply time per category (e.g. payment issues vs. balance feedback), not one blended figure that hides which categories are actually slow.
- **FAQ gap detection**: cross-references recurring player questions against a static snapshot of the FAQ's questions/keywords (`src/data/faqReference.json`, English only). Flags questions that don't match any FAQ entry well, clustering by recurring topic words. This is a snapshot, not a live connection -- re-export and regenerate if the FAQ changes.

## Integrations

- **Slack**: alerts, digests (orange Blitz of Battle theme)
- **Notion** (optional, `NOTION_API_KEY`): auto-creates Community Management / Bug / Feature DB entries matching the manual CM workflow, escalates existing entries as issues grow
- **Exit feedback**: DMs departing members, tracks and forwards their replies. (A welcome-DM-on-join workaround was tried and removed -- confirmed by direct testing that Discord re-validates shared-server status live at send time, so a previously-opened DM channel doesn't survive someone leaving. This is a hard platform restriction with no code-side fix.)

## Deployment

Docker (`node:20-slim`) on Railway. `prisma db push` runs on container start, applying schema changes automatically.
