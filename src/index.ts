import { Bot, InlineKeyboard } from 'grammy';
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

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

const bot = new Bot(token);

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
    return `⚠️ OVERDUE by ${h > 0 ? `${h}h ${m}m` : `${m}m`}`;
  }
  const mins = Math.floor(diffMs / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

const NAPPY_EMOJI: Record<string, string> = {
  wet: '💧',
  dirty: '💩',
  both: '💩💧',
};

function nappyKeyboard() {
  return new InlineKeyboard()
    .text('💧 Wet', 'nappy:wet')
    .text('💩 Dirty', 'nappy:dirty')
    .text('💩💧 Both', 'nappy:both');
}

function menuKeyboard() {
  return new InlineKeyboard()
    .text('🍼 Fed now', 'menu:fed')
    .text('📊 Status', 'menu:status').row()
    .text('💧 Wet nappy', 'nappy:wet')
    .text('💩 Dirty', 'nappy:dirty')
    .text('💩💧 Both', 'nappy:both');
}

// --- Commands ---

bot.command('start', async (ctx) => {
  await registerChat(ctx.chat.id);
  await ctx.reply('👶 Reuben Nanny Bot ready! What do you need?', {
    reply_markup: menuKeyboard(),
  });
});

bot.command('menu', async (ctx) => {
  await registerChat(ctx.chat.id);
  await ctx.reply('What do you need?', { reply_markup: menuKeyboard() });
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    `🍼 /fed 120ml — log a feed now\n` +
    `🍼 /fed 120ml 20m ago — log with a time offset\n` +
    `🚼 /nappy — show nappy type buttons\n` +
    `📊 /status — last feed & nappy\n` +
    `🎛️ /menu — show quick-action buttons`
  );
});

bot.command('fed', async (ctx) => {
  await registerChat(ctx.chat.id);
  const args = ctx.match.trim();
  const amountMatch = args.match(/(\d+)\s*ml/i);

  if (!amountMatch) {
    await ctx.reply('How much did Reuben have? Reply with e.g. /fed 120ml [20m ago]');
    return;
  }

  const amountMl = parseInt(amountMatch[1]);
  const offsetMs = parseTimeOffset(args);
  const loggedAt = new Date(Date.now() - offsetMs);

  await logFeed(ctx.chat.id, amountMl, loggedAt);

  const suffix = offsetMs > 0 ? ` (logged as ${formatAgo(loggedAt)})` : '';
  await ctx.reply(`✅ 🍼 Reuben had ${amountMl}ml${suffix}`, {
    reply_markup: menuKeyboard(),
  });
});

bot.command('nappy', async (ctx) => {
  await registerChat(ctx.chat.id);
  await ctx.reply('What type of nappy change?', { reply_markup: nappyKeyboard() });
});

bot.command('status', async (ctx) => {
  await registerChat(ctx.chat.id);
  await sendStatus(ctx.chat.id, (text, extra) => ctx.reply(text, extra));
});

// --- Inline button handlers ---

bot.callbackQuery(/^nappy:(.+)$/, async (ctx) => {
  const type = ctx.match[1];
  await registerChat(ctx.chat.id);
  await logNappy(ctx.chat.id, type, new Date());
  await ctx.editMessageText(`✅ ${NAPPY_EMOJI[type]} Nappy change logged (${type})`);
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('menu:fed', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply('How much did Reuben have? Type /fed 120ml [20m ago]');
});

bot.callbackQuery('menu:status', async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendStatus(ctx.chat.id, (text, extra) => ctx.reply(text, extra));
});

// --- Shared status helper ---

async function sendStatus(
  chatId: number,
  reply: (text: string, extra?: { reply_markup: InlineKeyboard }) => Promise<void>
) {
  const [lastFeed, lastNappy] = await Promise.all([
    getLastFeed(chatId),
    getLastNappy(chatId),
  ]);

  const feedLine = lastFeed
    ? `🍼 Last fed: ${lastFeed.amount_ml}ml — ${formatAgo(new Date(lastFeed.logged_at))}`
    : '🍼 No feeds logged yet';

  const nextLine = lastFeed
    ? `⏰ Next feed: ${formatNextFeed(new Date(lastFeed.logged_at))}`
    : '';

  const nappyEmoji = lastNappy ? (NAPPY_EMOJI[lastNappy.nappy_type] ?? '🚼') : '🚼';
  const nappyLine = lastNappy
    ? `${nappyEmoji} Last nappy: ${lastNappy.nappy_type} — ${formatAgo(new Date(lastNappy.logged_at))}`
    : '🚼 No nappy changes logged yet';

  await reply([feedLine, nextLine, nappyLine].filter(Boolean).join('\n'), {
    reply_markup: menuKeyboard(),
  });
}

// --- 3-hour feeding reminder (checks every 5 minutes) ---

cron.schedule('*/5 * * * *', async () => {
  const chats = await getAllChats();

  for (const chatId of chats) {
    const lastFeed = await getLastFeed(chatId);
    if (!lastFeed) continue;

    const msSince = Date.now() - new Date(lastFeed.logged_at).getTime();
    const threeHours = 3 * 60 * 60 * 1000;
    const fiveMinutes = 5 * 60 * 1000;

    if (msSince >= threeHours && msSince < threeHours + fiveMinutes) {
      await bot.api.sendMessage(
        chatId,
        `⏰ Time to feed Reuben! Last fed ${lastFeed.amount_ml}ml — ${formatAgo(new Date(lastFeed.logged_at))}`,
        { reply_markup: menuKeyboard() }
      );
    }
  }
});

// --- Start ---

async function main() {
  await initDb();
  console.log('DB ready');

  await bot.api.setMyCommands([
    { command: 'fed',    description: '🍼 Log a feed — /fed 120ml [20m ago]' },
    { command: 'nappy',  description: '🚼 Log a nappy change' },
    { command: 'status', description: '📊 Show last feed & nappy' },
    { command: 'menu',   description: '🎛️ Show quick-action buttons' },
    { command: 'help',   description: '❓ Show all commands' },
  ]);
  console.log('Commands registered');

  bot.start();
  console.log('Reuben Nanny Bot running');
}

main().catch(console.error);
