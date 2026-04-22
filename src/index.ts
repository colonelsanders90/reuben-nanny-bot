import { Bot, InlineKeyboard } from 'grammy';
import cron from 'node-cron';
import {
  initDb,
  registerChat,
  authorizeChat,
  getAuthorizedChats,
  logFeed,
  logNappy,
  getLastFeed,
  getLastNappy,
  getRecentFeeds,
  getRecentNappies,
  getAllChats,
  resolvePrimaryChat,
  createLinkCode,
  linkChat,
  VALID_NAPPY_TYPES,
} from './db';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

const bot = new Bot(token);

// ============================================================
// Security: chat allowlist
// ============================================================
//
// Set ALLOWED_CHAT_IDS=id1,id2 in your environment to restrict
// the bot to specific Telegram chat IDs.  Leave unset to run in
// open mode (not recommended outside of local dev).

const ALLOWED_CHAT_IDS_ENV: Set<number> = new Set(
  (process.env.ALLOWED_CHAT_IDS ?? '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n))
);

const RESTRICTED_MODE = ALLOWED_CHAT_IDS_ENV.size > 0;

// In-memory set — populated at startup from env + DB, updated on /join
const authorizedChats = new Set<number>(ALLOWED_CHAT_IDS_ENV);

function isAuthorized(chatId: number): boolean {
  return !RESTRICTED_MODE || authorizedChats.has(chatId);
}

function grantAccess(chatId: number) {
  authorizedChats.add(chatId);
}

// ============================================================
// Security: rate limiting
// ============================================================

interface RateBucket { count: number; resetAt: number; }
const rateBuckets = new Map<string, RateBucket>();

/** Returns true if the request should be allowed. */
function rateLimit(key: string, maxCount: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= maxCount) return false;
  bucket.count++;
  return true;
}

// Prune expired buckets every 10 minutes to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(key);
  }
}, 10 * 60_000);

/**
 * Combined auth + rate-limit guard.
 * Returns true if the request should proceed, false if rejected
 * (the handler already replied/answered).
 */
async function guard(ctx: any, rateLimitKey?: string): Promise<boolean> {
  const chatId: number = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;

  if (!isAuthorized(chatId)) {
    const msg = '🔒 This bot is private. You are not authorised to use it.';
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: msg, show_alert: true });
    else await ctx.reply(msg);
    return false;
  }

  const key = rateLimitKey ?? `cmd:${chatId}`;
  if (!rateLimit(key, 20, 60_000)) {
    const msg = '⏱️ Too many requests — please slow down.';
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: msg, show_alert: true });
    else await ctx.reply(msg);
    return false;
  }

  return true;
}

// ============================================================
// Conversation state (per chat)
// ============================================================

type ConvStep = 'feed_ml' | 'feed_time' | 'nappy_time';
interface ConvState { step: ConvStep; amountMl?: number; nappyType?: string; }
const conv = new Map<number, ConvState>();

// ============================================================
// Time helpers
// ============================================================

const MAX_BACKDATE_MS = 12 * 60 * 60 * 1000; // 12 hours

function parseHHMM(text: string): Date | null {
  const match = text.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (h > 23 || m > 59) return null;

  const result = new Date();
  result.setHours(h, m, 0, 0);

  // If time is in the future, assume it was yesterday
  if (result.getTime() > Date.now() + 60_000) result.setDate(result.getDate() - 1);

  // Reject times more than 12 hours in the past
  if (result.getTime() < Date.now() - MAX_BACKDATE_MS) return null;

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

// ============================================================
// Keyboards
// ============================================================

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

// ============================================================
// Commands
// ============================================================

bot.command('start', async (ctx) => {
  conv.delete(ctx.chat.id);
  if (!await guard(ctx)) return;
  await registerChat(ctx.chat.id);
  await ctx.reply('👶 Reuben Nanny Bot ready! What do you need?', {
    reply_markup: menuKeyboard(),
  });
});

bot.command('menu', async (ctx) => {
  conv.delete(ctx.chat.id);
  if (!await guard(ctx)) return;
  await registerChat(ctx.chat.id);
  await ctx.reply('What do you need?', { reply_markup: menuKeyboard() });
});

bot.command('help', async (ctx) => {
  if (!await guard(ctx)) return;
  await ctx.reply(
    `🍼 *Feeding:* Tap "Fed now" → pick ml → set time\n` +
    `🚼 *Nappy:* Tap wet/dirty/both → set time\n` +
    `📊 /status — last feed & nappy status\n` +
    `📋 /history — last 5 feeds & nappy changes\n` +
    `🎛️ /menu — show quick-action buttons\n` +
    `🔗 /share — generate a link code to share with your partner\n` +
    `🔗 /join <code> — join your partner's shared tracker`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('fed', async (ctx) => {
  conv.delete(ctx.chat.id);
  if (!await guard(ctx)) return;
  await registerChat(ctx.chat.id);
  conv.set(ctx.chat.id, { step: 'feed_ml' });
  await ctx.reply('How many ml did Reuben have?\n\nTap a quick amount or type a number:', {
    reply_markup: mlKeyboard(),
  });
});

bot.command('nappy', async (ctx) => {
  conv.delete(ctx.chat.id);
  if (!await guard(ctx)) return;
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
  if (!await guard(ctx)) return;
  await registerChat(ctx.chat.id);
  const primaryId = await resolvePrimaryChat(ctx.chat.id);
  await sendStatus(primaryId, (text, extra) => ctx.reply(text, extra));
});

bot.command('history', async (ctx) => {
  conv.delete(ctx.chat.id);
  if (!await guard(ctx)) return;
  await registerChat(ctx.chat.id);
  const primaryId = await resolvePrimaryChat(ctx.chat.id);
  await sendHistory(primaryId, (text, extra) => ctx.reply(text, extra));
});

bot.command('share', async (ctx) => {
  if (!await guard(ctx)) return;
  await registerChat(ctx.chat.id);
  const code = await createLinkCode(ctx.chat.id);
  await ctx.reply(
    `🔗 Your link code is: *${code}*\n\nAsk your partner to send the bot:\n/join ${code}\n\nThe code expires after one use.`,
    { parse_mode: 'Markdown' }
  );
});

// /join is intentionally not behind guard() — it IS the registration step.
// Instead it gets a stricter rate limit to prevent brute-forcing link codes.
bot.command('join', async (ctx) => {
  await registerChat(ctx.chat.id);
  const code = ctx.match.trim();
  if (!code) {
    await ctx.reply('Please provide a code: /join ABC123');
    return;
  }
  // 5 attempts per 10 minutes per chat
  if (!rateLimit(`join:${ctx.chat.id}`, 5, 10 * 60_000)) {
    await ctx.reply('⏱️ Too many join attempts. Please wait 10 minutes before trying again.');
    return;
  }
  const primaryId = await linkChat(ctx.chat.id, code);
  if (!primaryId) {
    await ctx.reply('❌ Invalid or expired code. Ask your partner to send /share again.');
    return;
  }
  grantAccess(ctx.chat.id);
  await authorizeChat(ctx.chat.id);
  await ctx.reply("✅ You're now linked! You and your partner share the same baby tracker.", {
    reply_markup: menuKeyboard(),
  });
});

// ============================================================
// Inline buttons
// ============================================================

bot.callbackQuery('menu:fed', async (ctx) => {
  if (!await guard(ctx)) return;
  const chatId = getChatId(ctx);
  await registerChat(chatId);
  conv.set(chatId, { step: 'feed_ml' });
  await ctx.answerCallbackQuery();
  await ctx.reply('How many ml did Reuben have?\n\nTap a quick amount or type a number:', {
    reply_markup: mlKeyboard(),
  });
});

bot.callbackQuery(/^feed_ml:(\d+)$/, async (ctx) => {
  if (!await guard(ctx)) return;
  const chatId = getChatId(ctx);
  const amountMl = parseInt(ctx.match[1], 10);
  conv.set(chatId, { step: 'feed_time', amountMl });
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🍼 ${amountMl}ml — when was this feed?\n\nTap *Just now* or type the time (HH:MM, 24h):`,
    { parse_mode: 'Markdown', reply_markup: timeKeyboard() }
  );
});

bot.callbackQuery(/^nappy:(.+)$/, async (ctx) => {
  if (!await guard(ctx)) return;
  const chatId = getChatId(ctx);
  const type = ctx.match[1];

  if (!VALID_NAPPY_TYPES.has(type)) {
    await ctx.answerCallbackQuery({ text: 'Invalid option', show_alert: true });
    return;
  }

  await registerChat(chatId);
  conv.set(chatId, { step: 'nappy_time', nappyType: type });
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `${NAPPY_EMOJI[type]} ${type} nappy — when was this change?\n\nTap *Just now* or type the time (HH:MM, 24h):`,
    { parse_mode: 'Markdown', reply_markup: timeKeyboard() }
  );
});

bot.callbackQuery('time:now', async (ctx) => {
  if (!await guard(ctx)) return;
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

bot.callbackQuery('cancel', async (ctx) => {
  const chatId = getChatId(ctx);
  conv.delete(chatId);
  await ctx.answerCallbackQuery('Cancelled');
  await ctx.editMessageText('What do you need?', { reply_markup: menuKeyboard() });
});

bot.callbackQuery('menu:status', async (ctx) => {
  if (!await guard(ctx)) return;
  await ctx.answerCallbackQuery();
  const chatId = getChatId(ctx);
  if (chatId) {
    const primaryId = await resolvePrimaryChat(chatId);
    await sendStatus(primaryId, (text, extra) => ctx.reply(text, extra));
  }
});

bot.callbackQuery('menu:history', async (ctx) => {
  if (!await guard(ctx)) return;
  await ctx.answerCallbackQuery();
  const chatId = getChatId(ctx);
  if (chatId) {
    const primaryId = await resolvePrimaryChat(chatId);
    await sendHistory(primaryId, (text, extra) => ctx.reply(text, extra));
  }
});

// ============================================================
// Text input handler (custom ml or HH:MM time)
// ============================================================

bot.on('message:text', async (ctx) => {
  const chatId = ctx.chat.id;
  const state = conv.get(chatId);
  if (!state) return;

  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  if (!await guard(ctx)) return;

  if (state.step === 'feed_ml') {
    const n = parseInt(text, 10);
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
      await ctx.reply(
        'Please enter the time as HH:MM (e.g. 14:30). Times more than 12 hours ago are not accepted:',
        { reply_markup: timeKeyboard() }
      );
      return;
    }
    await finishLog(chatId, state, loggedAt, (t, extra) => ctx.reply(t, extra));
  }
});

// ============================================================
// Finish logging
// ============================================================

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
    const primaryId = await resolvePrimaryChat(chatId);
    await logFeed(primaryId, state.amountMl, loggedAt);
    await reply(`✅ 🍼 Reuben had ${state.amountMl}ml${timeSuffix}`, {
      reply_markup: menuKeyboard(),
    });
  } else if (state.step === 'nappy_time' && state.nappyType) {
    const primaryId = await resolvePrimaryChat(chatId);
    const emoji = NAPPY_EMOJI[state.nappyType] ?? '🚼';
    await logNappy(primaryId, state.nappyType, loggedAt);
    await reply(`✅ ${emoji} Nappy change logged (${state.nappyType})${timeSuffix}`, {
      reply_markup: menuKeyboard(),
    });
  }
}

// ============================================================
// Status helper
// ============================================================

async function sendStatus(
  chatId: number,
  reply: (text: string, extra?: { reply_markup: InlineKeyboard }) => Promise<unknown>
) {
  const [lastFeed, lastNappy] = await Promise.all([
    getLastFeed(chatId),
    getLastNappy(chatId),
  ]);

  const feedAgo  = lastFeed ? formatAgo(new Date(lastFeed.logged_at)) : null;
  const feedTime = lastFeed ? formatTime(new Date(lastFeed.logged_at)) : null;
  const feedLine = lastFeed
    ? `🍼 Last fed: ${lastFeed.amount_ml}ml — ${feedAgo} (${feedTime})`
    : '🍼 No feeds logged yet';

  const nextLine = lastFeed
    ? `⏰ Next feed: ${formatNextFeed(new Date(lastFeed.logged_at))}`
    : '';

  const nappyAgo   = lastNappy ? formatAgo(new Date(lastNappy.logged_at)) : null;
  const nappyTime  = lastNappy ? formatTime(new Date(lastNappy.logged_at)) : null;
  const nappyEmoji = lastNappy ? (NAPPY_EMOJI[lastNappy.nappy_type] ?? '🚼') : '🚼';
  const nappyLine  = lastNappy
    ? `${nappyEmoji} Last nappy: ${lastNappy.nappy_type} — ${nappyAgo} (${nappyTime})`
    : '🚼 No nappy changes logged yet';

  await reply([feedLine, nextLine, nappyLine].filter(Boolean).join('\n'), {
    reply_markup: menuKeyboard(),
  });
}

// ============================================================
// History helper
// ============================================================

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

// ============================================================
// Feeding reminders (checks every 5 minutes)
// ============================================================

cron.schedule('*/5 * * * *', async () => {
  let chats: number[];
  try {
    chats = await getAllChats();
  } catch (err) {
    console.error('Cron: failed to fetch chats:', err);
    return;
  }

  for (const chatId of chats) {
    try {
      const primaryId = await resolvePrimaryChat(chatId);
      const lastFeed  = await getLastFeed(primaryId);
      if (!lastFeed) continue;

      const msSince      = Date.now() - new Date(lastFeed.logged_at).getTime();
      const twoHalfHours = 2.5 * 60 * 60 * 1000;
      const threeHours   = 3 * 60 * 60 * 1000;
      const fiveMinutes  = 5 * 60 * 1000;

      if (msSince >= twoHalfHours && msSince < twoHalfHours + fiveMinutes) {
        await bot.api.sendMessage(
          chatId,
          `🍼 Time to prepare milk! Reuben's next feed is in 30 minutes.`
        );
      } else if (msSince >= threeHours && msSince < threeHours + fiveMinutes) {
        await bot.api.sendMessage(
          chatId,
          `⏰ Time to feed Reuben! Last fed ${lastFeed.amount_ml}ml — ${formatAgo(new Date(lastFeed.logged_at))}`,
          { reply_markup: menuKeyboard() }
        );
      }
    } catch (err) {
      // Swallow per-chat errors (e.g. user blocked the bot) so one bad chat
      // doesn't abort notifications for everyone else.
      console.error(`Cron: error for chat ${chatId}:`, (err as Error).message);
    }
  }
});

// ============================================================
// Start
// ============================================================

async function main() {
  await initDb();
  console.log('DB ready');

  // Persist env-var chat IDs to DB so they survive restarts
  for (const id of ALLOWED_CHAT_IDS_ENV) await authorizeChat(id);

  // Load all previously authorised chats (including joined partners) from DB
  const dbAuthorized = await getAuthorizedChats();
  for (const id of dbAuthorized) grantAccess(id);

  if (!RESTRICTED_MODE) {
    console.warn(
      'WARNING: ALLOWED_CHAT_IDS is not set — bot is open to anyone. ' +
      'Set ALLOWED_CHAT_IDS=<your chat id> to restrict access.'
    );
  } else {
    console.log(`Restricted mode active — ${authorizedChats.size} authorised chat(s)`);
  }

  await bot.api.setMyCommands([
    { command: 'fed',     description: '🍼 Log a feed' },
    { command: 'nappy',   description: '🚼 Log a nappy change' },
    { command: 'status',  description: '📊 Show last feed & nappy' },
    { command: 'history', description: '📋 Show last 5 feeds & nappy changes' },
    { command: 'menu',    description: '🎛️ Show quick-action buttons' },
    { command: 'share',   description: '🔗 Generate a code to share with your partner' },
    { command: 'join',    description: "🔗 Join your partner's shared tracker" },
    { command: 'help',    description: '❓ Show all commands' },
  ]);
  console.log('Commands registered');

  bot.start();
  console.log('Reuben Nanny Bot running');
}

main().catch(console.error);
