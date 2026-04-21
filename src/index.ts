import { Bot } from 'grammy';
import cron from 'node-cron';
import {
  initDb,
  registerChat,
  logFeed,
  logNappy,
  getLastFeed,
  getLastNappy,
  getAllChats,
} from './db';

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

// --- Time helpers ---

function parseTimeOffset(args: string): number {
  const match = args.match(/(\d+)(m|h)\s+ago/i);
  if (!match) return 0;
  const value = parseInt(match[1]);
  return match[2].toLowerCase() === 'h'
    ? value * 60 * 60 * 1000
    : value * 60 * 1000;
}

function formatAgo(date: Date): string {
  const totalMins = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (totalMins < 1) return 'just now';
  if (totalMins < 60) return `${totalMins}m ago`;
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
}

function formatNextFeed(lastFeedTime: Date): string {
  const due = new Date(lastFeedTime.getTime() + 3 * 60 * 60 * 1000);
  const diffMs = due.getTime() - Date.now();
  if (diffMs <= 0) {
    const overdueMins = Math.floor(Math.abs(diffMs) / 60_000);
    const h = Math.floor(overdueMins / 60);
    const m = overdueMins % 60;
    const label = h > 0 ? `${h}h ${m}m` : `${m}m`;
    return `⚠️ OVERDUE by ${label}`;
  }
  const mins = Math.floor(diffMs / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

// --- Commands ---

bot.command('start', async (ctx) => {
  await registerChat(ctx.chat.id);
  await ctx.reply(
    `👶 Reuben Nanny Bot ready!\n\n` +
    `/fed 120ml — log a feed now\n` +
    `/fed 120ml 20m ago — log a feed with a time offset\n` +
    `/nappy wet — log a nappy change (wet / dirty / both)\n` +
    `/status — show last feed & nappy\n` +
    `/help — show this message`
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    `/fed 120ml — log a feed now\n` +
    `/fed 120ml 20m ago — log a feed with a time offset\n` +
    `/nappy wet — log a nappy change (wet / dirty / both)\n` +
    `/status — show last feed & nappy`
  );
});

bot.command('fed', async (ctx) => {
  await registerChat(ctx.chat.id);
  const args = ctx.match.trim();
  const amountMatch = args.match(/(\d+)\s*ml/i);

  if (!amountMatch) {
    await ctx.reply('Usage: /fed 120ml [20m ago]');
    return;
  }

  const amountMl = parseInt(amountMatch[1]);
  const offsetMs = parseTimeOffset(args);
  const loggedAt = new Date(Date.now() - offsetMs);

  await logFeed(ctx.chat.id, amountMl, loggedAt);

  const suffix = offsetMs > 0 ? ` (logged as ${formatAgo(loggedAt)})` : '';
  await ctx.reply(`✅ Reuben had ${amountMl}ml${suffix}`);
});

bot.command('nappy', async (ctx) => {
  await registerChat(ctx.chat.id);
  const type = ctx.match.trim().toLowerCase();

  if (!['wet', 'dirty', 'both'].includes(type)) {
    await ctx.reply('Usage: /nappy wet | dirty | both');
    return;
  }

  await logNappy(ctx.chat.id, type, new Date());
  await ctx.reply(`✅ Nappy change logged (${type})`);
});

bot.command('status', async (ctx) => {
  await registerChat(ctx.chat.id);

  const [lastFeed, lastNappy] = await Promise.all([
    getLastFeed(ctx.chat.id),
    getLastNappy(ctx.chat.id),
  ]);

  const feedLine = lastFeed
    ? `🍼 Last fed: ${lastFeed.amount_ml}ml — ${formatAgo(new Date(lastFeed.logged_at))}`
    : '🍼 No feeds logged yet';

  const nextLine = lastFeed
    ? `⏰ Next feed: ${formatNextFeed(new Date(lastFeed.logged_at))}`
    : '';

  const nappyLine = lastNappy
    ? `🚼 Last nappy: ${lastNappy.nappy_type} — ${formatAgo(new Date(lastNappy.logged_at))}`
    : '🚼 No nappy changes logged yet';

  await ctx.reply([feedLine, nextLine, nappyLine].filter(Boolean).join('\n'));
});

// --- 3-hour feeding reminder (checks every 5 minutes) ---

cron.schedule('*/5 * * * *', async () => {
  const chats = await getAllChats();

  for (const chatId of chats) {
    const lastFeed = await getLastFeed(chatId);
    if (!lastFeed) continue;

    const msSince = Date.now() - new Date(lastFeed.logged_at).getTime();
    const threeHours = 3 * 60 * 60 * 1000;
    const fiveMinutes = 5 * 60 * 1000;

    // Fire once in the 5-minute window after the 3-hour mark
    if (msSince >= threeHours && msSince < threeHours + fiveMinutes) {
      await bot.api.sendMessage(
        chatId,
        `⏰ Time to feed Reuben! Last fed ${lastFeed.amount_ml}ml — ${formatAgo(new Date(lastFeed.logged_at))}`
      );
    }
  }
});

// --- Start ---

async function main() {
  await initDb();
  console.log('DB ready');
  bot.start();
  console.log('Reuben Nanny Bot running');
}

main().catch(console.error);
