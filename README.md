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
10. **Retries** OpenAI and Slack calls with exponential backoff; **rate-limits** OpenAI calls to avoid 429s during message bursts
11. **Daily report** (21:00 UTC) and **weekly report** (Sundays, with week-over-week comparisons) to Slack, with state persisted in the DB so a restart never causes a skipped or duplicated report
12. **Exports** via `/feedback export` (Discord file attachment) or `GET /feedback/export?format=csv|json`
13. **Exit feedback**: when a member leaves the server, the bot DMs them a feedback request and logs the departure (and whether the DM succeeded) to a dedicated Slack channel
14. **Issue tracking**: actionable feedback is grouped into living issues (per category, 72h attach window) with mention counts, unique player counts, auto-escalating priority, and statuses (new / investigating / acknowledged / in_progress / resolved / ignored)
15. **Trend detection**: if a category's mentions double vs. yesterday with 10+ mentions today, fires a one-per-day trend alert
16. **AI is optional at boot**: if `OPENAI_API_KEY` is missing, the bot still connects to Discord/Slack and runs the exit-DM feature; it logs "AI analysis: DISABLED" and skips classification until a real key is added — no redeploy needed, just update the variable

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
- OpenAI API Key (optional at first boot)
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

Bot should appear online in Discord and log `Bot online as ...`. Send a test message like "the matchmaking is really broken" and check Slack for the alert (requires a real `OPENAI_API_KEY`).

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

## REST API

| Endpoint | Description |
|----------|-------------|
| `GET /feedback` | All feedback (supports query params) |
| `GET /feedback/export?format=csv\|json` | Export |
| `GET /stats` | Aggregated stats |
| `GET /issues` | Open/closed issues |
| `PATCH /issues/:id/status` | Update issue status |
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

## Environment Variables

See `.env.example` for the full list.
