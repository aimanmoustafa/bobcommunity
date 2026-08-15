# BoB Community Intelligence Bot

AI-powered Discord bot for Blitz of Battle that monitors community feedback, detects messages needing a reply, and sends smart Slack notifications with direct Discord message links.

## What It Does

1. **Reads every Discord message** in your watched channels, including threads and forum posts (auto-joins new threads)
2. **Pre-filters** casual chat locally (no API cost for "lol" and "gg")
3. **Dedupes** near-identical repeat messages from the same author within 5 minutes
4. **AI-analyzes** potential feedback using GPT (category, sentiment, urgency, needs-reply), with conversation context so it understands multi-person discussions, not just single messages
5. **Stores feedback** in PostgreSQL with full metadata
6. **Aggregates repeat reports**: if 15 players report the same bug in the same channel within the aggregation window, that's ONE Slack alert that updates in place with a growing reporter count, not 15 separate messages
7. **Sends Slack alerts** only when something actually needs CM attention, with category, urgency, sentiment, confidence score, AI summary, reason, a clickable Discord message link, and a suggested reply
8. **Critical issues bypass aggregation** entirely (payments, crashes, exploits, security) — always get their own immediate alert
9. **Checks if staff already replied** before flagging "needs reply"
10. **Retries** Anthropic and Slack calls with exponential backoff; **rate-limits** Anthropic calls to avoid 429s during message bursts
11. **Daily digest** (21:00 UTC): a scannable, actionable format — 📣 Feedback & feature requests, ⚠️ Complaints, ❤️ Community Praise, 💳 Payment issues, 🕑 Needs a reply, 🔥 Needs attention (high/critical) — each with a day-over-day trend in the header (e.g. `Complaints (3, +200% vs yesterday)`), duplicate reports clustered into one line (`— 5 reports, 4 players. Latest: ...`), capped at 5 clusters per section with a "+N more" pointer, plus a 🤖 AI-written take. **Weekly report** (Sundays) with week-over-week comparisons using the same trend logic, both persisted in the DB so a restart never causes a skipped or duplicated report
12. **Exports** via `/feedback export` (Discord file attachment) or `GET /feedback/export?format=csv|json`
13. **Exit feedback**: when a member leaves the server, the bot DMs them a feedback request. Whether that departure also gets logged to Slack is controlled by `LOG_MEMBER_EXITS_TO_SLACK` (default off, so who-left events stay private)
14. **Issue tracking**: actionable feedback is grouped into living issues (per category, 72h attach window) with mention counts, unique player counts, auto-escalating priority, and statuses (new / investigating / acknowledged / in_progress / resolved / ignored)
15. **Trend detection**: if a category's mentions double vs. yesterday with 10+ mentions today, fires a one-per-day trend alert
16. **AI is optional at boot**: if `ANTHROPIC_API_KEY` is missing, the bot still connects to Discord/Slack and runs the exit-DM feature; it logs "AI analysis: DISABLED" and skips classification until a real key is added — no redeploy needed, just update the variable
17. **Backfill**: the bot only reacts to new messages by default. Run `/feedback backfill` (or `POST /backfill`) to scan the most recent 100 messages in each watched channel through the same analysis pipeline — useful for catching feedback that was posted before the bot went live or before its configuration was fixed
18. **Flexible querying**: the `/feedback` search box doubles as a mini query language — type things like `category:matchmaking sentiment:negative today`, `priority:high last_7d`, `from 12:00 to 18:00`, `yesterday`, `morning`/`afternoon`/`evening`, and it parses the time window and filters automatically, with any leftover words used as plain text search
19. **`/community pulse`**: a quick snapshot (default last 6 hours) — overall sentiment, main discussion topic, the biggest emerging issue, and counts of feedback/urgent items/unanswered messages
20. **`/community report`**: runs the daily or weekly digest on demand instead of waiting for the scheduled time
21. **`/community refresh`**: same as backfill, framed as "check for anything new right now" -- supports an optional `window` (today / last24h / 7d) to force a specific lookback instead of the default since-last-checkpoint behavior
22. **`/community assign`**: assign an open issue to someone by matching part of its title, optionally flagging it for follow-up -- shows up in the digest as "assigned to X 🚩 follow-up flagged"
23. **`/community scan channel:<any channel>`**: manually scan any channel via Discord's native channel picker, even one that's not in `DISCORD_WATCHED_CHANNELS`. Picking a channel explicitly is itself the authorization -- no config change needed. Supports the same `window` options (today/last24h/7d) as refresh, and uses the same per-channel checkpoint so repeated scans of the same ad hoc channel only process new messages
22. **Real incremental refresh**: each channel remembers the last message it processed (`ChannelCheckpoint`), so repeated backfill/refresh runs only scan genuinely new messages instead of re-fetching the same 100 every time, and nothing gets silently skipped even if more than 100 messages accumulated between runs (safe backward pagination, capped at 1000 messages/run as a safety limit)
23. **AI health tracking**: every AI call's success/failure is recorded. If the AI is disabled or has failed 3+ times in a row, `/community pulse`, `/community report`, and the daily/weekly digests all show a ⚠️ warning banner explaining why -- so "0 feedback" is never mistaken for "no community activity" when it actually means the AI layer is broken
24. **Startup diagnostic banner**: on boot (and again once Discord connects), the logs print AI Provider/Model/API Key status/Discord connection/Watched Channel count/AI Analysis enabled state, so you can confirm the bot's actual capabilities at a glance
25. **Suggested replies are now persisted**: the AI drafts a ready-to-send reply for every classified message, not just ones that trigger a Slack alert. It's saved to the database and included in CSV/JSON exports and in the `/feedback` list view -- previously this was thrown away unless a real-time alert happened to fire
26. **AI executive summaries**: the daily digest, weekly report, and `/community pulse` each get a short 🤖 *AI Take* -- Claude reads the already-computed stats (categories, sentiment, open issues, week-over-week deltas) and writes a genuinely synthesized "here's what actually matters" paragraph, not just a template. Skipped cleanly (no empty section) if AI is disabled or unhealthy
27. **Discord DM delivery**: set `DISCORD_DM_USER_IDS` (comma-separated user IDs) to also receive the daily digest, weekly report, and new urgent alerts as Discord DMs, alongside (not instead of) Slack. Alerts are DMed only when they first fire, not on every subsequent "N more reports" aggregation update, to avoid spam. Off entirely if the variable is unset -- Slack delivery is unaffected either way

## Architecture

```
Discord Message (channel, thread, or forum post)
  -> Pre-filter (local keywords, skips casual chat)
  -> Dedupe check (same author, near-identical text, last 5 min)
  -> Conversation context pulled (last ~8 messages)
  -> AI Analysis (GPT classifies, summarizes, scores, suggests a reply)
  -> Staff Reply Check (skip "needs reply" if mod/dev already answered)
  -> Aggregation:
       - Critical urgency -> always a fresh Slack alert
       - New issue in channel -> new Slack alert, tracked as a group
       - Repeat of tracked issue -> existing Slack message updated in place
  -> Store in PostgreSQL
```

## Setup

### 1. Prerequisites

- Node.js 20+
- PostgreSQL (or use Docker Compose)
- Discord Bot Token (with Message Content + Server Members intents enabled)
- Anthropic API Key (optional at first boot)
- Slack Bot Token + Channel ID

### 2. Discord Bot Setup

1. Go to https://discord.com/developers/applications
2. Create a new application, go to Bot tab, click "Add Bot"
3. Enable **Message Content Intent** AND **Server Members Intent** under Privileged Gateway Intents (required — the bot will crash-loop with "Used disallowed intents" if either is off)
4. Copy the bot token
5. Invite the bot via OAuth2 URL Generator: scopes `bot` + `applications.commands`; permissions: View Channels, Send Messages, Read Message History

### 3. Slack Bot Setup

1. Go to https://api.slack.com/apps, create a new app
2. Add OAuth scopes: `chat:write`, `chat:write.public`
3. Install to workspace, copy the Bot User OAuth Token (`xoxb-...`)
4. Create the channels you want to route alerts into (or just one to start), copy their channel IDs

### 4. Install and Run

```bash
cp .env.example .env
# Fill in your tokens in .env

# Docker (recommended)
docker-compose up -d

# Or locally
npm install
npx prisma generate
npx prisma db push
npm run dev
```

### 5. Verify

Bot should appear online in Discord and log `Bot online as ...`. Send a test message like "the matchmaking is really broken" and check Slack for the alert (requires a real `ANTHROPIC_API_KEY`).

## Slash Commands

| Command | Description |
|---------|-------------|
| `/feedback today` | Today's feedback |
| `/feedback week` | This week's feedback |
| `/feedback bugs` | Bug reports |
| `/feedback urgent` | High/critical urgency |
| `/feedback unanswered` | Needs reply, still pending |
| `/feedback issues` | Open tracked issues |
| `/feedback stats` | 7-day stats overview |
| `/feedback export` | Downloads a CSV of the last 30 days |
| `/feedback backfill` | Scans the last 100 messages per watched channel for missed feedback |

## Community Commands

| Command | Description |
|---------|-------------|
| `/community pulse [hours]` | Quick sentiment/activity snapshot (default 6h) |
| `/community report [period]` | Daily or weekly digest, on demand |
| `/community refresh` | Scan recent history for anything new |
| `/community assign issue:<search> to:<name> [follow_up]` | Assign an open issue to someone, optionally flag for follow-up |
| `/community scan channel:<any channel> [window]` | Manually scan any channel, even ones outside the regular watch list |

## Flexible Query Syntax (in `/feedback`'s search box)

```
category:matchmaking sentiment:negative today
priority:high last_7d
from 12:00 to 18:00
yesterday complaints about rewards
channel:bug-reports urgency:critical
morning / afternoon / evening
```
Recognized keys: `category`, `sentiment`, `urgency` (or `priority`, same thing), `channel`. Recognized time windows: `today`, `yesterday`, `last_24h`/`24h`, `last_7d`/`week`, `morning`/`afternoon`/`evening`, or an explicit `from HH:MM to HH:MM` / `since HH:MM`. Anything left over after parsing is used as a plain text search.

## REST API

| Endpoint | Description |
|----------|-------------|
| `GET /feedback` | All feedback (supports query params) |
| `GET /feedback/export?format=csv\|json` | Export |
| `GET /stats` | Aggregated stats |
| `GET /issues` | Open/closed issues |
| `PATCH /issues/:id/status` | Update issue status |
| `POST /backfill` | Scan recent message history in watched channels |
| `GET /health` | Health check |

## Alert Routing

| Trigger | Slack Channel |
|---------|---------------|
| Critical urgency (payments, crashes, exploits, server down) | `SLACK_CHANNEL_ALERTS` |
| Bug reports, exploits, performance | `SLACK_CHANNEL_BUGS` |
| Balance / hero feedback | `SLACK_CHANNEL_BALANCE` |
| Matchmaking, UI/UX, suggestions, feature requests, etc. | `SLACK_CHANNEL_FEEDBACK` |
| Toxicity | `SLACK_CHANNEL_MODERATION` |
| Daily / weekly summaries | `SLACK_CHANNEL_DIGEST` |
| Member departures | `SLACK_CHANNEL_MEMBER_EXITS` |

All fall back to `SLACK_CHANNEL_ID` if not individually set, so a single-channel setup works out of the box.

## Categories

bug_report, balance, hero_feedback, matchmaking, monetization, ui_ux, performance, suggestion, feature_request, confusion, question, praise, complaint, exploit, toxicity, localization, store, progression, new_player, veteran, community_event

## Troubleshooting

- **"Used disallowed intents" crash loop**: enable Message Content + Server Members intents in the Discord Developer Portal (Bot tab → Privileged Gateway Intents → Save).
- **"DATABASE_URL resolved to an empty string"**: the variable reference isn't resolving. Use the literal Postgres connection string instead of a `${{Service.VAR}}` reference if in doubt.
- **"Prisma failed to detect libssl"**: use `node:20-slim` (Debian), not `node:20-alpine` — Alpine's musl libc doesn't ship OpenSSL the way Prisma's engine expects.
- **Bot connects fine but never flags/stores any feedback despite a valid API key**: check `/community report` or `/community pulse` first -- both now show a ⚠️ banner at the top if the AI layer is disabled or has 3+ consecutive failures, naming the actual error. You can also check `GET /health` or the deploy logs for `"AI request failed"`. The analyzer forces structured tool-use output (not prompted JSON), which eliminates the most common silent-failure mode, but a bad model name, invalid key, or account access issue still surfaces clearly now instead of silently reporting "0 feedback."
- **Feedback that's already sitting in the channel isn't showing up**: the bot only reacts to messages posted *after* it's running (`MessageCreate` events), it doesn't retroactively scan history on its own. Run `/feedback backfill` or `/community refresh` to catch up -- both use per-channel checkpoints so repeated runs only process genuinely new messages, and `/community refresh window:7d` (etc.) can force a specific lookback regardless of checkpoint.

## Environment Variables

See `.env.example` for the full list.
