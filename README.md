# BoB Community Intelligence Bot

AI-powered Discord bot for Blitz of Battle that monitors community feedback, detects messages needing a reply, and sends smart Slack notifications with direct Discord message links.

## What It Does

1. **Reads every Discord message** in your server, including threads and forum posts (auto-joins new threads)
2. **Pre-filters** casual chat locally (no API cost for "lol" and "gg")
3. **Dedupes** near-identical repeat messages from the same author within 5 minutes
4. **AI-analyzes** potential feedback using GPT (category, sentiment, urgency, needs-reply), with conversation context so it understands multi-person discussions, not just single messages
5. **Stores feedback** in PostgreSQL with full metadata
6. **Aggregates repeat reports**: if 15 players report the same bug in the same channel within the aggregation window, that's ONE Slack alert that updates in place with a growing reporter count, not 15 separate messages
7. **Sends Slack alerts** only when something actually needs CM attention, with:
   - Category, urgency, sentiment, confidence score
   - AI summary and reason
   - Clickable Discord message link
   - Suggested reply
8. **Critical issues bypass aggregation** entirely (payments, crashes, exploits, security) — always get their own immediate alert
9. **Checks if staff already replied** before flagging "needs reply"
10. **Retries** OpenAI and Slack calls with exponential backoff; **rate-limits** OpenAI calls to avoid 429s during message bursts
11. **Daily report** (21:00 UTC) and **weekly report** (Sundays) to Slack, with state persisted in the DB so a restart never causes a skipped or duplicated report
12. **Exports** via `/feedback export` (Discord file attachment) or `GET /feedback/export?format=csv|json`
13. **Exit feedback**: when a member leaves the server, the bot DMs them a feedback request and logs the departure (and whether the DM succeeded) to a dedicated Slack channel
14. **Issue tracking**: actionable feedback is grouped into living issues (per category, 72h attach window) with mention counts, unique player counts, auto-escalating priority, and statuses (new / investigating / acknowledged / in_progress / resolved / ignored). View via `/feedback issues` in Discord or `GET /issues`; update status via `PATCH /issues/:id/status`
15. **Trend detection**: daily per-category counters; if a category doubles vs yesterday with 10+ mentions today, a ⚠️ Trend Detected alert fires (once per category per day)
16. **Week-over-week weekly report**: totals and top categories vs the prior week, open tracked issues, most requested feature, and a ❤️ community praise section

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
- Discord Bot Token (with Message Content intent enabled)
- OpenAI API Key
- Slack Bot Token + Channel ID

### 2. Discord Bot Setup

1. Go to https://discord.com/developers/applications
2. Create a new application
3. Go to Bot tab, click "Add Bot"
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. Copy the bot token
6. Invite the bot to your server using OAuth2 URL Generator:
   - Scopes: `bot`, `applications.commands`
   - Permissions: `Read Messages/View Channels`, `Read Message History`, `Send Messages`

### 3. Slack Bot Setup

1. Go to https://api.slack.com/apps
2. Create a new app
3. Add OAuth scopes: `chat:write`, `chat:write.public`
4. Install to workspace
5. Copy the Bot User OAuth Token (`xoxb-...`)
6. Create the channels you want to route alerts into, then invite the bot to each one (or rely on `chat:write.public` so it can post without being invited):
   - `#community-alerts` — critical issues (payments, crashes, exploits, server down)
   - `#bug-reports` — bug reports, exploits, performance issues
   - `#balance-feedback` — hero and gameplay balance discussions
   - `#community-feedback` — everything else needing attention (matchmaking, UI/UX, suggestions, feature requests, etc.)
   - `#community-moderation` — toxicity flags
   - `#community-digest` — daily and weekly automated reports
7. Copy each channel's ID (right-click the channel → Copy link, the ID is the last segment) into the matching `SLACK_CHANNEL_*` variable in `.env`. Any you skip fall back to `SLACK_CHANNEL_ID`, so a single-channel setup still works fine — just leave the rest unset.

### 4. Install and Run

```bash
# Clone and install
cp .env.example .env
# Fill in your tokens in .env

# Option A: Docker (recommended)
docker-compose up -d
docker-compose exec bot npx prisma migrate dev
docker-compose up -d

# Option B: Local
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

### 5. Verify

- Bot should appear online in Discord
- Send a test message like "the matchmaking is really broken, I keep fighting max level players"
- Check your Slack channel for the alert

## Slash Commands

| Command | Description |
|---------|-------------|
| `/feedback today` | Today's feedback |
| `/feedback week` | This week's feedback |
| `/feedback bugs` | Bug reports |
| `/feedback urgent` | High/critical urgency |
| `/feedback unanswered` | Needs reply, still pending |
| `/feedback stats` | 7-day stats overview |
| `/feedback export` | Downloads a CSV of the last 30 days as a Discord file attachment |

## REST API

| Endpoint | Description |
|----------|-------------|
| `GET /feedback` | All feedback (supports query params) |
| `GET /feedback?category=bug_report` | Filter by category |
| `GET /feedback?needsReply=yes` | Messages needing reply |
| `GET /feedback?urgency=high` | High urgency items |
| `GET /feedback?search=matchmaking` | Search feedback |
| `GET /stats` | Aggregated stats |
| `GET /feedback/export?format=csv` | Download CSV (opens directly in Excel) |
| `GET /feedback/export?format=json` | Download JSON |
| `GET /health` | Health check |

## Categories

bug_report, balance, hero_feedback, matchmaking, monetization, ui_ux, performance, suggestion, feature_request, confusion, question, praise, complaint, exploit, toxicity, localization, store, progression, new_player, veteran, community_event

## Alert Routing

| Trigger | Slack Channel |
|---------|---------------|
| Critical urgency (payment issues, crashes, exploits, server down) | `#community-alerts` |
| Bug reports, exploits, performance | `#bug-reports` |
| Balance / hero feedback | `#balance-feedback` |
| Matchmaking, UI/UX, suggestions, feature requests, questions, etc. | `#community-feedback` |
| Toxicity | `#community-moderation` |
| Daily / weekly summaries | `#community-digest` |

Praise and low-urgency items never get a real-time alert at all — they only show up in the daily/weekly digest, so `#community-feedback` doesn't get flooded with positive-but-non-actionable messages.

## Exit Feedback (Member Leave DMs)

When someone leaves the Discord server, the bot:
1. Attempts to DM them the message set in `MEMBER_EXIT_MESSAGE`
2. Logs the departure to `SLACK_CHANNEL_MEMBER_EXITS` regardless of whether the DM succeeded, noting the outcome

**Important limitation**: Discord only lets a bot DM a user if they still share a server with the bot. The moment someone leaves, that condition can already be gone by the time the bot's handler runs, so some DMs will fail with a Discord-side error — this is a platform restriction, not a bug. That's exactly why every attempt (success or failure) is logged to Slack: so you always know who left and can follow up manually if the DM bounced.

## Cost Optimization

The pre-filter catches ~70-80% of messages before they hit the OpenAI API. Only messages with feedback keywords, questions, or sufficient length get analyzed. Dedupe filtering also prevents re-analyzing the same complaint pasted multiple times. This keeps API costs manageable even on active servers.

## Reliability

- **Retries**: OpenAI and Slack calls retry up to 3x with exponential backoff on transient failures (5xx, 429, network errors). Non-retryable errors (bad auth, invalid request) fail fast.
- **Rate limiting**: OpenAI calls are throttled to 20 per 10 seconds by default (tune `openaiRateLimiter` in `src/utils/rateLimiter.ts` for your API tier) so a sudden burst of Discord activity doesn't trigger 429s.
- **Scheduler state** lives in Postgres (`SchedulerState` table), so restarting the bot near the daily/weekly report window never causes a skipped or duplicated report.

## Notes on Aggregation

Aggregation groups are keyed by `category:channelId`. When a new report comes in for an existing group within the aggregation window, the bot calls Slack's `chat.update` on the original alert rather than posting a new one, and increments a visible reporter count. The window resets on each new report, so an actively-discussed issue stays as one live-updating alert. Critical-urgency messages (payments, crashes, exploits, security) always bypass aggregation and get their own immediate, individual alert.

## Environment Variables

See `.env.example` for the full list.
