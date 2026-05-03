# 🍼 Baby Nanny Bot

A Telegram bot for tracking newborn feeds and nappy changes — built for sleep-deprived parents who need one-tap logging at 3am.

![logo](logo.png)

## Features

- **Log feeds** — tap a quick ml amount (90/100/110/120ml) or type any value; set the time with one tap (just now, or 10–60 min ago)
- **Log nappy changes** — wet, dirty, or both; same time picker
- **Live status** — last feed, time since, and next feed countdown
- **Last 5** — recent feeds and nappy changes with interval deltas
- **Daily snapshot** — full day view with ◀ ▶ navigation between days
- **Activity heatmap** — GitHub-style 8-week trends chart for feeds (ml/day) and nappies (changes/day)
- **Delete entries** — tap to remove any recent event
- **3-hour reminders** — bot sends a prep reminder at 2.5h and a feed reminder at 3h
- **Partner sharing** — `/share` generates a one-time code; `/join <code>` links two chats to the same data
- **Configurable baby name** — asked on first `/start`, stored per chat

## Commands

| Command | Description |
|---|---|
| `/start` | Start the bot (asks for baby name on first run) |
| `/menu` | Show the quick-action keyboard |
| `/fed` | Log a feed |
| `/nappy` | Log a nappy change |
| `/status` | Last feed & nappy summary |
| `/last5` | Last 5 feeds and nappy changes |
| `/daily` | Today's full day snapshot with navigation |
| `/history` | Yesterday's snapshot |
| `/trends` | 8-week activity heatmap image |
| `/delete` | Delete a recent entry |
| `/share` | Generate a link code for your partner |
| `/join <code>` | Join your partner's tracker |
| `/help` | Show all commands |

## Stack

- **Runtime** — Node.js + TypeScript
- **Bot framework** — [Grammy](https://grammy.dev)
- **Database** — PostgreSQL (`pg`)
- **Scheduling** — `node-cron`
- **Chart rendering** — `@napi-rs/canvas` (Skia) + `@fontsource/roboto`
- **Deployment** — [Railway](https://railway.app)

## Setup

### Prerequisites

- Node.js 18+
- A PostgreSQL database
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | Token from @BotFather |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `TIMEZONE` | optional | IANA timezone for display (default: `Asia/Singapore`) |
| `ALLOWED_CHAT_IDS` | optional | Comma-separated chat IDs to restrict access |

### Local development

```bash
git clone https://github.com/colonelsanders90/baby-nanny-bot.git
cd baby-nanny-bot
npm install
cp .env.example .env
# fill in your values in .env
npm run dev
```

### Deploy to Railway

1. Create a new Railway project and add a **PostgreSQL** plugin
2. Set the environment variables above in the Railway dashboard
3. Connect your GitHub repo — Railway builds and deploys on push

The bot uses polling mode (no webhook setup required).

## Database

Tables are created automatically on first startup via `initDb()`:

- `events` — feed and nappy log entries
- `chats` — registered chats with baby name and auth status
- `link_codes` — one-time partner linking codes
- `chat_links` — maps secondary chats to a primary chat

## Project structure

```
src/
  index.ts    — bot logic, commands, callbacks, cron reminders
  db.ts       — PostgreSQL helpers and validated write functions
  charts.ts   — heatmap chart generator (Canvas 2D → PNG buffer)
scripts/
  generate-logo.ts  — generates logo.png
```

## Contributing

This was built for personal use but feel free to fork it for your own family. The baby name is configurable — no hard-coded names in the code.

## License

MIT
