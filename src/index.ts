import { Bot, InlineKeyboard } from 'grammy';
import cron from 'node-cron';
import {
  initDb,
  registerChat,
  logFeed,
  logNappy,
  getLastFeed,
  getLastNappy,
  getRecentFeeds,
  getRecentNappies,
  getAllChats,
} from './db';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

const bot = new Bot(token);

// --- Conversation state (per chat) ---

type ConvStep = 'feed_ml' | 'feed_time' | 'nappy_time';
interface ConvState { step: ConvStep; amountMl?: number; nappyType?: string; }
const conv = new Map<number, ConvState>();

// --- Time helpers ---

function parseHHMM(text: string): Date | null {
  const match = text.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = parseInt(match[1]);
  const m = parseInt(match[2]);
  if (h > 23 || m > 59) return null;
  const result = new Date();
  result.setHours(h, m, 0, 0);
  // if time is in the future, assume it was yesterday
  if (result.getTime() > Date.now() + 60_000) result.setDate(result.getDate() - 1);
  return result;
}

function formatAgo(date: Date): string {
  const totalMins = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (totalMins < 1) return 'just now';
  if (totalMins < 60) return `${totalMins}m ago`;
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
}

function formatTime(date: Date): string {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
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

// --- Keyboards ---

function menuKeyboard() {
  return new InlineKeyboard()
    .text('🍼 Fed now', 'menu:fed')
    .text('📊 Status', 'menu:status')
    .text('📋 History', 'menu:history').row()
    .text('💧 Wet nappy', 'nappy:wet')
    .text('💩 Dirty', 'nappy:dirty')
    .text('💩💧 Both', 'nappy:both');
}

function mlKeyboard() {
  return new InlineKeyboard()
    .text('80ml', 'feed_ml:80').text('100ml', 'feed_ml:100')
    .text('120ml', 'feed_ml:120').text('150ml', 'feed_ml:150').row()
    .text('❌ Cancel', 'cancel');
}

function timeKeyboard() {
  return new InlineKeyboard()
    .text('✅ Just now', 'time:now').row()
    .text('❌ Cancel', 'cancel');
}

function getChatId(ctx: any): number {
  return ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
}

// --- Commands ---

bot.command('start', async (ctx) => {
  conv.delete(ctx.chat.id);
  await registerChat(ctx.chat.id);
  await ctx.reply('👶 Reuben Nanny Bot ready! What do you need?', {
    reply_markup: menuKeyboard(),
  });
});

bot.command('menu', async (ctx) => {
  conv.delete(ctx.chat.id);
  await registerChat(ctx.chat.id);
  await ctx.reply('What do you need?', { reply_markup: menuKeyboard() });
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    `🍼 *Feeding:* Tap "Fed now" → pick ml → set time\n` +
    `🚼 *Nappy:* Tap wet/dirty/both → set time\n` +
    `📊 /status — last feed & nappy status\n` +
    `📋 /history — last 3 feeds & nappy changes\n` +
    `🎛️ /menu — show quick-action buttons`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('fed', async (ctx) => {
  conv.delete(ctx.chat.id);
  await registerChat(ctx.chat.id);
  conv.set(ctx.chat.id, { step: 'feed_ml' });
  await ctx.reply('How many ml did Reuben have?\n\nTap a quick amount or type a number:', {
    reply_markup: mlKeyboard(),
  });
});

bot.command('nappy', async (ctx) => {
  conv.delete(ctx.chat.id);
  await registerChat(ctx.chat.id);
  await ctx.reply('What type of nappy change?', {
    reply_markup: new InlineKeyboard()
      .text('💧 Wet', 'nappy:wet')
      .text('💩 Dirty', 'nappy:dirty')
      .text('💩💧 Both', 'nappy:both').row()
      .text('❌ Cancel', 'cancel'),
  });
});

bot.command('status', async (ctx) => {
  conv.delete(ctx.chat.id);
  await registerChat(ctx.chat.id);
  await sendStatus(ctx.chat.id, (text, extra) => ctx.reply(text, extra));
});

bot.command('history', async (ctx) => {
  conv.delete(ctx.chat.id);
  await registerChat(ctx.chat.id);
  await sendHistory(ctx.chat.id, (text, extra) => ctx.reply(text, extra));
});

// --- Inline button: Fed now ---

bot.callbackQuery('menu:fed', async (ctx) => {
  const chatId = getChatId(ctx);
  await registerChat(chatId);
  conv.set(chatId, { step: 'feed_ml' });
  await ctx.answerCallbackQuery();
  await ctx.reply('How many ml did Reuben have?\n\nTap a quick amount or type a number:', {
    reply_markup: mlKeyboard(),
  });
});

// --- Inline button: ML quick-pick ---

bot.callbackQuery(/^feed_ml:(\d+)$/, async (ctx) => {
  const chatId = getChatId(ctx);
  const amountMl = parseInt(ctx.match[1]);
  conv.set(chatId, { step: 'feed_time', amountMl });
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🍼 ${amountMl}ml — when was this feed?\n\nTap *Just now* or type the time (HH:MM, 24h):`,
    { parse_mode: 'Markdown', reply_markup: timeKeyboard() }
  );
});

// --- Inline button: Nappy type (now asks for time) ---

bot.callbackQuery(/^nappy:(.+)$/, async (ctx) => {
  const chatId = getChatId(ctx);
  await registerChat(chatId);
  const type = ctx.match[1];
  conv.set(chatId, { step: 'nappy_time', nappyType: type });
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `${NAPPY_EMOJI[type]} ${type} nappy — when was this change?\n\nTap *Just now* or type the time (HH:MM, 24h):`,
    { parse_mode: 'Markdown', reply_markup: timeKeyboard() }
  );
});

// --- Inline button: Just now ---

bot.callbackQuery('time:now', async (ctx) => {
  const chatId = getChatId(ctx);
  const state = conv.get(chatId);
  await ctx.answerCallbackQuery();
  if (!state) {
    await ctx.editMessageText('What do you need?', { reply_markup: menuKeyboard() });
    return;
  }
  await finishLog(chatId, state, new Date(), (text, extra) =>
    ctx.editMessageText(text, extra)
  );
});

// --- Inline button: Cancel ---

bot.callbackQuery('cancel', async (ctx) => {
  const chatId = getChatId(ctx);
  conv.delete(chatId);
  await ctx.answerCallbackQuery('Cancelled');
  await ctx.editMessageText('What do you need?', { reply_markup: menuKeyboard() });
});

// --- Inline button: Status / History ---

bot.callbackQuery('menu:status', async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = getChatId(ctx);
  if (chatId) await sendStatus(chatId, (text, extra) => ctx.reply(text, extra));
});

bot.callbackQuery('menu:history', async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = getChatId(ctx);
  if (chatId) await sendHistory(chatId, (text, extra) => ctx.reply(text, extra));
});

// --- Text input handler (for custom ml or HH:MM time) ---

bot.on('message:text', async (ctx) => {
  const chatId = ctx.chat.id;
  const state = conv.get(chatId);
  if (!state) return;

  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  if (state.step === 'feed_ml') {
    const n = parseInt(text);
    if (isNaN(n) || n <= 0 || n > 600) {
      await ctx.reply('Please enter a valid amount in ml (e.g. 120):', {
        reply_markup: mlKeyboard(),
      });
      return;
    }
    conv.set(chatId, { step: 'feed_time', amountMl: n });
    await ctx.reply(
      `🍼 ${n}ml — when was this feed?\n\nTap *Just now* or type the time (HH:MM, 24h):`,
      { parse_mode: 'Markdown', reply_markup: timeKeyboard() }
    );
    return;
  }

  if (state.step === 'feed_time' || state.step === 'nappy_time') {
    const loggedAt = parseHHMM(text);
    if (!loggedAt) {
      await ctx.reply('Please enter the time as HH:MM (e.g. 14:30):', {
        reply_markup: timeKeyboard(),
      });
      return;
    }
    await finishLog(chatId, state, loggedAt, (text, extra) => ctx.reply(text, extra));
  }
});

// --- Finish logging ---

async function finishLog(
  chatId: number,
  state: ConvState,
  loggedAt: Date,
  reply: (text: string, extra?: any) => Promise<any>
) {
  conv.delete(chatId);
  const isNow = Math.abs(Date.now() - loggedAt.getTime()) < 90_000;
  const timeSuffix = isNow ? '' : ` at ${formatTime(loggedAt)}`;

  if (state.step === 'feed_time' && state.amountMl != null) {
    await logFeed(chatId, state.amountMl, loggedAt);
    await reply(`✅ 🍼 Reuben had ${state.amountMl}ml${timeSuffix}`, {
      reply_markup: menuKeyboard(),
    });
  } else if (state.step === 'nappy_time' && state.nappyType) {
    const emoji = NAPPY_EMOJI[state.nappyType] ?? '🚼';
    await logNappy(chatId, state.nappyType, loggedAt);
    await reply(`✅ ${emoji} Nappy change logged (${state.nappyType})${timeSuffix}`, {
      reply_markup: menuKeyboard(),
    });
  }
}

// --- Status helper ---

async function sendStatus(
  chatId: number,
  reply: (text: string, extra?: { reply_markup: InlineKeyboard }) => Promise<unknown>
) {
  const [lastFeed, lastNappy] = await Promise.all([
    getLastFeed(chatId),
    getLastNappy(chatId),
  ]);

  const feedAgo = lastFeed ? formatAgo(new Date(lastFeed.logged_at)) : null;
  const feedTime = lastFeed ? formatTime(new Date(lastFeed.logged_at)) : null;
  const feedLine = lastFeed
    ? `🍼 Last fed: ${lastFeed.amount_ml}ml — ${feedAgo} (${feedTime})`
    : '🍼 No feeds logged yet';

  const nextLine = lastFeed
    ? `⏰ Next feed: ${formatNextFeed(new Date(lastFeed.logged_at))}`
    : '';

  const nappyAgo = lastNappy ? formatAgo(new Date(lastNappy.logged_at)) : null;
  const nappyTime = lastNappy ? formatTime(new Date(lastNappy.logged_at)) : null;
  const nappyEmoji = lastNappy ? (NAPPY_EMOJI[lastNappy.nappy_type] ?? '🚼') : '🚼';
  const nappyLine = lastNappy
    ? `${nappyEmoji} Last nappy: ${lastNappy.nappy_type} — ${nappyAgo} (${nappyTime})`
    : '🚼 No nappy changes logged yet';

  await reply([feedLine, nextLine, nappyLine].filter(Boolean).join('\n'), {
    reply_markup: menuKeyboard(),
  });
}

// --- History helper ---

async function sendHistory(
  chatId: number,
  reply: (text: string, extra?: { reply_markup: InlineKeyboard }) => Promise<unknown>
) {
  const [feeds, nappies] = await Promise.all([
    getRecentFeeds(chatId, 5),
    getRecentNappies(chatId, 5),
  ]);

  const feedLines = feeds.length
    ? feeds.map((f) => {
        const t = formatTime(new Date(f.logged_at));
        return `  🍼 ${f.amount_ml}ml — ${formatAgo(new Date(f.logged_at))} (${t})`;
      }).join('\n')
    : '  No feeds logged yet';

  const nappyLines = nappies.length
    ? nappies.map((n) => {
        const t = formatTime(new Date(n.logged_at));
        return `  ${NAPPY_EMOJI[n.nappy_type] ?? '🚼'} ${n.nappy_type} — ${formatAgo(new Date(n.logged_at))} (${t})`;
      }).join('\n')
    : '  No nappy changes logged yet';

  await reply(
    `📋 Last 5 feeds:\n${feedLines}\n\n📋 Last 5 nappy changes:\n${nappyLines}`,
    { reply_markup: menuKeyboard() }
  );
}

// --- 3-hour feeding reminder ---

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
    { command: 'fed',     description: '🍼 Log a feed' },
    { command: 'nappy',   description: '🚼 Log a nappy change' },
    { command: 'status',  description: '📊 Show last feed & nappy' },
    { command: 'history', description: '📋 Show last 5 feeds & nappy changes' },
    { command: 'menu',    description: '🎛️ Show quick-action buttons' },
    { command: 'help',    description: '❓ Show all commands' },
  ]);
  console.log('Commands registered');

  bot.start();
  console.log('Reuben Nanny Bot running');
}

main().catch(console.error);
