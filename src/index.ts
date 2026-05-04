import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { generateTrendsImage, DayStats, generateFeedSleepChart, FeedSleepDay, generateMlSleepChart, MlSleepBucket } from './charts';
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
  getFeedsForDay,
  getNappiesForDay,
  getRecentEvents,
  deleteEvent,
  getAllChats,
  resolvePrimaryChat,
  createLinkCode,
  linkChat,
  getBabyName,
  setBabyName,
  getEventSummaryByDay,
  getFeedTimestampsForPeriod,
  getFeedCorrelationData,
  VALID_NAPPY_TYPES,
} from './db';

const TZ = process.env.TIMEZONE ?? 'Asia/Singapore';

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

type ConvStep = 'baby_name' | 'feed_ml' | 'feed_time' | 'nappy_time';
interface ConvState { step: ConvStep; amountMl?: number; nappyType?: string; }
const conv = new Map<number, ConvState>();

// ============================================================
// Baby name cache (keyed by primary chat ID)
// ============================================================

const babyNameCache = new Map<number, string>();

async function getCachedBabyName(primaryId: number): Promise<string | null> {
  if (babyNameCache.has(primaryId)) return babyNameCache.get(primaryId)!;
  const name = await getBabyName(primaryId);
  if (name) babyNameCache.set(primaryId, name);
  return name;
}

// ============================================================
// Time helpers
// ============================================================

const MAX_BACKDATE_MS = 12 * 60 * 60 * 1000; // 12 hours
const SGT_OFFSET_MS  = 8 * 60 * 60 * 1000;  // UTC+8

// Parses HH:MM (or HHMM) as Singapore time (UTC+8) and returns a UTC Date.
// Accepts the standard colon, the full-width colon ：(iOS autocorrect), or no separator.
function parseHHMM(text: string): Date | null {
  const normalized = text.trim().replace(/：/g, ':');
  const match = normalized.match(/^(\d{1,2}):?(\d{2})$/);
  if (!match) return null;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (h > 23 || m > 59) return null;

  const nowUtc = Date.now();
  // Work in SGT by shifting 'now' forward 8 hours, treating it as UTC
  const nowSgt = new Date(nowUtc + SGT_OFFSET_MS);
  const candidate = new Date(nowSgt);
  candidate.setUTCHours(h, m, 0, 0);

  // If the candidate is in the future (SGT), it must be from yesterday
  if (candidate.getTime() > nowSgt.getTime() + 60_000) {
    candidate.setUTCDate(candidate.getUTCDate() - 1);
  }

  // Shift back to actual UTC
  const utcDate = new Date(candidate.getTime() - SGT_OFFSET_MS);

  if (nowUtc - utcDate.getTime() > MAX_BACKDATE_MS) return null;
  return utcDate;
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
  const sgt = new Date(date.getTime() + SGT_OFFSET_MS);
  const h = sgt.getUTCHours().toString().padStart(2, '0');
  const m = sgt.getUTCMinutes().toString().padStart(2, '0');
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

// Returns today's date as YYYY-MM-DD in the configured timezone
function todayStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

// Shifts a YYYY-MM-DD string by N days
function offsetDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// "Wed, 23 Apr 2026"
function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en-GB', {
    timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
}

// "23 Apr" for nav buttons
function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' });
}

// "14:30" in the configured timezone
function formatTimeInTz(date: Date): string {
  return date.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
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
    .text('📊 Status', 'menu:status').row()
    .text('📋 Last 5', 'menu:last5')
    .text('📅 Daily', 'menu:daily')
    .text('🗑️ Delete', 'menu:delete').row()
    .text('📈 Trends', 'menu:trends').row()
    .text('💧 Wet nappy', 'nappy:wet')
    .text('💩 Dirty', 'nappy:dirty')
    .text('💩💧 Both', 'nappy:both');
}

function trendsKeyboard() {
  return new InlineKeyboard()
    .text('📊 Activity Heatmap', 'trends:heatmap').row()
    .text('😴 Feed vs Sleep',    'trends:feedsleep').row()
    .text('🍼 ml vs Sleep',      'trends:mlsleep').row()
    .text('⬅️ Back',             'cancel');
}

function mlKeyboard() {
  return new InlineKeyboard()
    .text('90ml', 'feed_ml:90').text('100ml', 'feed_ml:100')
    .text('110ml', 'feed_ml:110').text('120ml', 'feed_ml:120').row()
    .text('❌ Cancel', 'cancel');
}

function timeKeyboard() {
  return new InlineKeyboard()
    .text('✅ Just now', 'time:now').row()
    .text('10m ago', 'time:10').text('20m ago', 'time:20').text('30m ago', 'time:30').row()
    .text('40m ago', 'time:40').text('50m ago', 'time:50').text('60m ago', 'time:60').row()
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
  const primaryId = await resolvePrimaryChat(ctx.chat.id);
  const name = await getCachedBabyName(primaryId);
  if (!name) {
    conv.set(ctx.chat.id, { step: 'baby_name' });
    await ctx.reply("👶 Welcome to Nanny Bot!\n\nWhat's your baby's name?");
    return;
  }
  await ctx.reply(`👶 ${name} Nanny Bot ready! What do you need?`, {
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
    `📋 /last5 — last 5 feeds & nappy changes\n` +
    `📅 /history — yesterday's full feed log\n` +
    `📅 /daily — day snapshot with ◀▶ navigation\n` +
    `🗑️ /delete — delete a recent entry\n` +
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
  const primaryId = await resolvePrimaryChat(ctx.chat.id);
  const babyName = await getCachedBabyName(primaryId) ?? 'baby';
  conv.set(ctx.chat.id, { step: 'feed_ml' });
  await ctx.reply(`How many ml did ${babyName} have?\n\nTap a quick amount or type a number:`, {
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

bot.command('last5', async (ctx) => {
  conv.delete(ctx.chat.id);
  if (!await guard(ctx)) return;
  await registerChat(ctx.chat.id);
  const primaryId = await resolvePrimaryChat(ctx.chat.id);
  await sendLast5(primaryId, (text, extra) => ctx.reply(text, extra));
});

bot.command('history', async (ctx) => {
  conv.delete(ctx.chat.id);
  if (!await guard(ctx)) return;
  await registerChat(ctx.chat.id);
  const primaryId = await resolvePrimaryChat(ctx.chat.id);
  const yesterday = offsetDate(todayStr(), -1);
  await sendDailySnapshot(primaryId, yesterday, (text, extra) => ctx.reply(text, extra));
});

bot.command('daily', async (ctx) => {
  conv.delete(ctx.chat.id);
  if (!await guard(ctx)) return;
  await registerChat(ctx.chat.id);
  const primaryId = await resolvePrimaryChat(ctx.chat.id);
  await sendDailySnapshot(primaryId, todayStr(), (text, extra) => ctx.reply(text, extra));
});

bot.command('delete', async (ctx) => {
  conv.delete(ctx.chat.id);
  if (!await guard(ctx)) return;
  await registerChat(ctx.chat.id);
  const primaryId = await resolvePrimaryChat(ctx.chat.id);
  await sendDeleteList(primaryId, (text, extra) => ctx.reply(text, extra));
});

bot.command('trends', async (ctx) => {
  conv.delete(ctx.chat.id);
  if (!await guard(ctx)) return;
  await registerChat(ctx.chat.id);
  await ctx.reply('📈 Which trend would you like to see?', { reply_markup: trendsKeyboard() });
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
  const primaryId = await resolvePrimaryChat(chatId);
  const babyName = await getCachedBabyName(primaryId) ?? 'baby';
  conv.set(chatId, { step: 'feed_ml' });
  await ctx.answerCallbackQuery();
  await ctx.reply(`How many ml did ${babyName} have?\n\nTap a quick amount or type a number:`, {
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

bot.callbackQuery(/^time:(now|\d+)$/, async (ctx) => {
  if (!await guard(ctx)) return;
  const chatId = getChatId(ctx);
  const state = conv.get(chatId);
  await ctx.answerCallbackQuery();
  if (!state) {
    await ctx.editMessageText('What do you need?', { reply_markup: menuKeyboard() });
    return;
  }
  const val = ctx.match[1];
  const loggedAt = val === 'now'
    ? new Date()
    : new Date(Date.now() - parseInt(val, 10) * 60_000);
  await finishLog(chatId, state, loggedAt, (text, extra) =>
    ctx.editMessageText(text, extra)
  );
});

bot.callbackQuery('cancel', async (ctx) => {
  const chatId = getChatId(ctx);
  conv.delete(chatId);
  await ctx.answerCallbackQuery('Cancelled');
  try {
    await ctx.editMessageText('What do you need?', { reply_markup: menuKeyboard() });
  } catch (err: any) {
    if (!err?.description?.includes('message is not modified')) throw err;
  }
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

bot.callbackQuery('menu:last5', async (ctx) => {
  if (!await guard(ctx)) return;
  await ctx.answerCallbackQuery();
  const chatId = getChatId(ctx);
  if (chatId) {
    const primaryId = await resolvePrimaryChat(chatId);
    await sendLast5(primaryId, (text, extra) => ctx.reply(text, extra));
  }
});

bot.callbackQuery('menu:daily', async (ctx) => {
  if (!await guard(ctx)) return;
  await ctx.answerCallbackQuery();
  const chatId = getChatId(ctx);
  if (chatId) {
    const primaryId = await resolvePrimaryChat(chatId);
    await sendDailySnapshot(primaryId, todayStr(), (text, extra) => ctx.reply(text, extra));
  }
});

bot.callbackQuery('menu:delete', async (ctx) => {
  if (!await guard(ctx)) return;
  await ctx.answerCallbackQuery();
  const chatId = getChatId(ctx);
  if (chatId) {
    const primaryId = await resolvePrimaryChat(chatId);
    // Edit the existing message (not a new reply) so the whole delete flow
    // stays on one message and cancel/close can reliably edit it back.
    await sendDeleteList(primaryId, (text, extra) => ctx.editMessageText(text, extra));
  }
});

bot.callbackQuery('menu:trends', async (ctx) => {
  if (!await guard(ctx)) return;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('📈 Which trend would you like to see?', {
    reply_markup: trendsKeyboard(),
  });
});

bot.callbackQuery('trends:heatmap', async (ctx) => {
  if (!await guard(ctx)) return;
  await ctx.answerCallbackQuery('Generating chart…');
  const chatId = getChatId(ctx);
  if (chatId) {
    const primaryId = await resolvePrimaryChat(chatId);
    await sendTrends(chatId, primaryId);
  }
});

bot.callbackQuery('trends:feedsleep', async (ctx) => {
  if (!await guard(ctx)) return;
  await ctx.answerCallbackQuery('Generating chart…');
  const chatId = getChatId(ctx);
  if (chatId) {
    const primaryId = await resolvePrimaryChat(chatId);
    await sendFeedSleepChart(chatId, primaryId);
  }
});

bot.callbackQuery('trends:mlsleep', async (ctx) => {
  if (!await guard(ctx)) return;
  await ctx.answerCallbackQuery('Generating chart…');
  const chatId = getChatId(ctx);
  if (chatId) {
    const primaryId = await resolvePrimaryChat(chatId);
    await sendMlSleepChart(chatId, primaryId);
  }
});

// Show confirmation before deleting
bot.callbackQuery(/^del:(\d+)$/, async (ctx) => {
  if (!await guard(ctx)) return;
  const id = parseInt(ctx.match[1], 10);
  const chatId = getChatId(ctx);
  const primaryId = await resolvePrimaryChat(chatId);
  const events = await getRecentEvents(primaryId, 20);
  const event = events.find((e: any) => e.id === id);
  if (!event) {
    await ctx.answerCallbackQuery({ text: 'Entry not found', show_alert: true });
    return;
  }
  const label = event.type === 'feed'
    ? `🍼 ${event.amount_ml}ml at ${formatTimeInTz(new Date(event.logged_at))}`
    : `${NAPPY_EMOJI[event.nappy_type] ?? '🚼'} ${event.nappy_type} nappy at ${formatTimeInTz(new Date(event.logged_at))}`;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🗑️ Delete this entry?\n\n${label}`,
    {
      reply_markup: new InlineKeyboard()
        .text('✅ Yes, delete', `delconfirm:${id}`)
        .text('❌ Cancel', 'delcancel'),
    }
  );
});

// Actually delete
bot.callbackQuery(/^delconfirm:(\d+)$/, async (ctx) => {
  if (!await guard(ctx)) return;
  const id = parseInt(ctx.match[1], 10);
  const chatId = getChatId(ctx);
  const primaryId = await resolvePrimaryChat(chatId);
  const deleted = await deleteEvent(id, primaryId);
  if (!deleted) {
    await ctx.answerCallbackQuery({ text: 'Entry not found or already deleted', show_alert: true });
    return;
  }
  const label = deleted.type === 'feed'
    ? `🍼 ${deleted.amount_ml}ml at ${formatTimeInTz(new Date(deleted.logged_at))}`
    : `${NAPPY_EMOJI[deleted.nappy_type] ?? '🚼'} ${deleted.nappy_type} nappy at ${formatTimeInTz(new Date(deleted.logged_at))}`;
  await ctx.answerCallbackQuery({ text: 'Deleted ✅' });
  await ctx.editMessageText(`✅ Deleted: ${label}`, { reply_markup: menuKeyboard() });
});

bot.callbackQuery('delcancel', async (ctx) => {
  await ctx.answerCallbackQuery('Cancelled');
  const chatId = getChatId(ctx);
  const primaryId = await resolvePrimaryChat(chatId);
  try {
    await sendDeleteList(primaryId, (text, extra) => ctx.editMessageText(text, extra));
  } catch (err: any) {
    if (!err?.description?.includes('message is not modified')) throw err;
  }
});

bot.callbackQuery(/^daily:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  if (!await guard(ctx)) return;
  await ctx.answerCallbackQuery();
  const chatId = getChatId(ctx);
  if (chatId) {
    const primaryId = await resolvePrimaryChat(chatId);
    await sendDailySnapshot(primaryId, ctx.match[1], async (text, extra) => {
      try {
        await ctx.editMessageText(text, extra);
      } catch (err: any) {
        // Telegram rejects edits when content is unchanged — safe to ignore
        if (!err?.description?.includes('message is not modified')) throw err;
      }
    });
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

  if (state.step === 'baby_name') {
    const name = text.slice(0, 50).trim();
    if (!name) {
      await ctx.reply("Please enter a name for your baby:");
      return;
    }
    const primaryId = await resolvePrimaryChat(chatId);
    await setBabyName(primaryId, name);
    babyNameCache.set(primaryId, name);
    conv.delete(chatId);
    await ctx.reply(`👶 ${name} Nanny Bot is ready! What do you need?`, {
      reply_markup: menuKeyboard(),
    });
    return;
  }

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
    const babyName = await getCachedBabyName(primaryId) ?? 'baby';
    await logFeed(primaryId, state.amountMl, loggedAt);
    await reply(`✅ 🍼 ${babyName} had ${state.amountMl}ml${timeSuffix}`, {
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
function formatDelta(olderDate: Date, newerDate: Date): string {
  const totalMins = Math.floor((newerDate.getTime() - olderDate.getTime()) / 60_000);
  if (totalMins < 60) return `+${totalMins}m`;
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return m > 0 ? `+${h}h ${m}m` : `+${h}h`;
}



async function sendDeleteList(
  chatId: number,
  reply: (text: string, extra?: any) => Promise<unknown>
) {
  const events = await getRecentEvents(chatId, 8);
  if (!events.length) {
    await reply('No entries to delete.', { reply_markup: menuKeyboard() });
    return;
  }

  const kb = new InlineKeyboard();
  const lines: string[] = ['🗑️ <b>Tap an entry to delete it:</b>\n'];

  for (const e of events) {
    const time = formatTimeInTz(new Date(e.logged_at));
    const dateLabel = formatShortDate(new Date(e.logged_at).toLocaleDateString('en-CA', { timeZone: TZ }));
    if (e.type === 'feed') {
      lines.push(`🍼 ${e.amount_ml}ml — ${dateLabel} ${time}`);
      kb.text(`🍼 ${e.amount_ml}ml ${dateLabel} ${time}`, `del:${e.id}`).row();
    } else {
      const emoji = NAPPY_EMOJI[e.nappy_type] ?? '🚼';
      lines.push(`${emoji} ${e.nappy_type} — ${dateLabel} ${time}`);
      kb.text(`${emoji} ${e.nappy_type} ${dateLabel} ${time}`, `del:${e.id}`).row();
    }
  }
  kb.text('❌ Close', 'cancel');

  await reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
}

async function sendLast5(
  chatId: number,
  reply: (text: string, extra?: any) => Promise<unknown>
) {
  const [feeds, nappies] = await Promise.all([
    getRecentFeeds(chatId, 5),
    getRecentNappies(chatId, 5),
  ]);

  const feedLines = feeds.length
    ? feeds.map((f, i) => {
        const delta = i < feeds.length - 1
          ? `  ↑ ${formatDelta(new Date(feeds[i + 1].logged_at), new Date(f.logged_at))}`
          : '';
        return `  🍼 ${f.amount_ml}ml · ${formatTimeInTz(new Date(f.logged_at))} · ${formatAgo(new Date(f.logged_at))}${delta}`;
      }).join('\n')
    : '  No feeds logged yet';

  const nappyLines = nappies.length
    ? nappies.map((n) => `  ${NAPPY_EMOJI[n.nappy_type] ?? '🚼'} ${n.nappy_type} — ${formatAgo(new Date(n.logged_at))} (${formatTimeInTz(new Date(n.logged_at))})`).join('\n')
    : '  No nappy changes logged yet';

  await reply(
    `📋 Last 5 feeds:\n${feedLines}\n\n📋 Last 5 nappy changes:\n${nappyLines}`,
    { reply_markup: menuKeyboard() }
  );
}

// ============================================================
// Daily snapshot helper
// ============================================================

async function sendDailySnapshot(
  chatId: number,
  dateStr: string,
  reply: (text: string, extra?: any) => Promise<unknown>
) {
  const today = todayStr();
  const [feeds, nappies] = await Promise.all([
    getFeedsForDay(chatId, dateStr, TZ),
    getNappiesForDay(chatId, dateStr, TZ),
  ]);

  const isToday = dateStr === today;
  const label   = isToday ? `Today — ${formatDateLabel(dateStr)}` : formatDateLabel(dateStr);

  let text = `📅 <b>${label}</b>\n`;

  if (feeds.length) {
    const totalMl = feeds.reduce((sum: number, f: any) => sum + f.amount_ml, 0);
    text += `\n🍼 <b>Feeds</b> — ${feeds.length} total · ${totalMl}ml\n<code>`;
    for (const f of feeds) {
      text += `${formatTimeInTz(new Date(f.logged_at))}  ${String(f.amount_ml).padStart(3)}ml\n`;
    }
    text += '</code>';
  } else {
    text += '\n🍼 No feeds logged\n';
  }

  if (nappies.length) {
    text += `\n🚼 <b>Nappies</b> — ${nappies.length} changes\n<code>`;
    for (const n of nappies) {
      text += `${formatTimeInTz(new Date(n.logged_at))}  ${(NAPPY_EMOJI[n.nappy_type] ?? '') + ' ' + n.nappy_type}\n`;
    }
    text += '</code>';
  } else {
    text += '\n🚼 No nappy changes logged\n';
  }

  // Navigation buttons — never go into the future
  const prevDate = offsetDate(dateStr, -1);
  const nextDate = offsetDate(dateStr, 1);

  const kb = new InlineKeyboard()
    .text(`◀ ${formatShortDate(prevDate)}`, `daily:${prevDate}`);

  if (nextDate <= today) {
    kb.text(`${formatShortDate(nextDate)} ▶`, `daily:${nextDate}`);
  }

  await reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

// ============================================================
// Trends helper
// ============================================================

const TRENDS_WEEKS = 8;
const TRENDS_DAYS  = TRENDS_WEEKS * 7;  // 56

async function sendTrends(chatId: number, primaryId: number) {
  const babyName = await getCachedBabyName(primaryId) ?? 'Baby';
  const toDate   = todayStr();
  const fromDate = offsetDate(toDate, -(TRENDS_DAYS - 1));

  const rows = await getEventSummaryByDay(primaryId, fromDate, toDate, TZ);

  const dayData = new Map<string, DayStats>();
  for (const row of rows) {
    dayData.set(row.day, {
      feedMl:     Number(row.total_ml),
      nappyCount: Number(row.nappy_count),
    });
  }

  const imgBuf = await generateTrendsImage(dayData, babyName, toDate, TZ);

  // 7-day summary stats for the photo caption
  const last7 = Array.from({ length: 7 }, (_, i) => offsetDate(toDate, i - 6));
  const weekTotalMl    = last7.reduce((s, d) => s + (dayData.get(d)?.feedMl     ?? 0), 0);
  const weekTotalNappy = last7.reduce((s, d) => s + (dayData.get(d)?.nappyCount ?? 0), 0);
  const daysWithFeeds  = last7.filter(d => (dayData.get(d)?.feedMl ?? 0) > 0).length;
  const avgMl = daysWithFeeds > 0 ? Math.round(weekTotalMl / daysWithFeeds) : 0;

  const caption =
    `📈 ${babyName}'s activity — last ${TRENDS_WEEKS} weeks\n\n` +
    `🍼 Past 7 days: ${weekTotalMl} ml total · avg ${avgMl} ml/day\n` +
    `🚼 Past 7 days: ${weekTotalNappy} nappy change${weekTotalNappy !== 1 ? 's' : ''}`;

  await bot.api.sendPhoto(chatId, new InputFile(imgBuf, 'trends.png'), {
    caption,
    reply_markup: menuKeyboard(),
  });
}

// ============================================================
// Feed vs Sleep chart helper
// ============================================================

const FEED_SLEEP_DAYS = 14;

function computeFeedSleepStats(
  rows:        Array<{ day: string; logged_at: Date }>,
  fromDateStr: string,
  toDateStr:   string,
): Map<string, FeedSleepDay> {
  // Build ordered date list for the display window
  const dates: string[] = [];
  {
    let d = new Date(fromDateStr + 'T12:00:00Z');
    const end = new Date(toDateStr + 'T12:00:00Z');
    while (d <= end) {
      dates.push(d.toISOString().slice(0, 10));
      d = new Date(d.getTime() + 86_400_000);
    }
  }

  // Sort by time (DB already orders, but guard against edge cases)
  const times = rows
    .map(r => ({ day: r.day, t: new Date(r.logged_at) }))
    .sort((a, b) => a.t.getTime() - b.t.getTime());

  // Compute inter-feed gaps; assign each gap to the day of the later feed
  const gapsByDay = new Map<string, number[]>();
  for (let i = 1; i < times.length; i++) {
    const gapH = (times[i].t.getTime() - times[i - 1].t.getTime()) / 3_600_000;
    const day  = times[i].day;
    const arr  = gapsByDay.get(day) ?? [];
    arr.push(gapH);
    gapsByDay.set(day, arr);
  }

  const result = new Map<string, FeedSleepDay>();
  for (const day of dates) {
    const feedCount     = times.filter(t => t.day === day).length;
    const gaps          = gapsByDay.get(day) ?? [];
    const avgSleepHours = gaps.length > 0
      ? gaps.reduce((s, g) => s + g, 0) / gaps.length
      : null;
    result.set(day, { feedCount, avgSleepHours });
  }
  return result;
}

async function sendFeedSleepChart(chatId: number, primaryId: number) {
  const babyName = await getCachedBabyName(primaryId) ?? 'Baby';
  const toDate   = todayStr();
  const fromDate = offsetDate(toDate, -(FEED_SLEEP_DAYS - 1));

  const rows = await getFeedTimestampsForPeriod(primaryId, fromDate, toDate, TZ);
  const data = computeFeedSleepStats(rows, fromDate, toDate);

  const imgBuf = await generateFeedSleepChart(data, babyName, fromDate, toDate);

  // Summary stats for caption
  let totalFeeds = 0, sleepSum = 0, sleepCount = 0;
  for (const v of data.values()) {
    totalFeeds += v.feedCount;
    if (v.avgSleepHours !== null) { sleepSum += v.avgSleepHours; sleepCount++; }
  }
  const avgFeedsPerDay = (totalFeeds / FEED_SLEEP_DAYS).toFixed(1);
  const avgSleepHours  = sleepCount > 0 ? (sleepSum / sleepCount).toFixed(1) : null;

  const caption =
    `😴 ${babyName}'s feed & sleep — last ${FEED_SLEEP_DAYS} days\n\n` +
    `🍼 Avg ${avgFeedsPerDay} feeds/day\n` +
    (avgSleepHours !== null
      ? `💤 Avg ${avgSleepHours}h between feeds`
      : `💤 Not enough data to calculate sleep gaps`);

  await bot.api.sendPhoto(chatId, new InputFile(imgBuf, 'feed-sleep.png'), {
    caption,
    reply_markup: menuKeyboard(),
  });
}

// ============================================================
// ml vs Sleep correlation helper
// ============================================================

const ML_SLEEP_DAYS = 60;

function computeMlSleepBuckets(
  rows: Array<{ amount_ml: number; logged_at: Date }>
): MlSleepBucket[] {
  // For each consecutive feed pair, record (ml of first feed, hours until next feed)
  const pairs: { ml: number; sleepH: number }[] = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const sleepH = (new Date(rows[i + 1].logged_at).getTime() - new Date(rows[i].logged_at).getTime()) / 3_600_000;
    pairs.push({ ml: rows[i].amount_ml, sleepH });
  }

  // Group by exact ml amount
  const groups = new Map<number, number[]>();
  for (const { ml, sleepH } of pairs) {
    const arr = groups.get(ml) ?? [];
    arr.push(sleepH);
    groups.set(ml, arr);
  }

  // Sort by ml, compute average per group
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([amountMl, sleeps]) => ({
      amountMl,
      avgSleepH: sleeps.reduce((s, v) => s + v, 0) / sleeps.length,
      count: sleeps.length,
    }));
}

async function sendMlSleepChart(chatId: number, primaryId: number) {
  const babyName = await getCachedBabyName(primaryId) ?? 'Baby';
  const fromDate = offsetDate(todayStr(), -ML_SLEEP_DAYS);

  const rows    = await getFeedCorrelationData(primaryId, fromDate, TZ);
  const buckets = computeMlSleepBuckets(rows);

  const imgBuf = await generateMlSleepChart(buckets, babyName, ML_SLEEP_DAYS);

  const totalPairs = buckets.reduce((s, b) => s + b.count, 0);
  const best = buckets.length > 0
    ? buckets.reduce((a, b) => b.avgSleepH > a.avgSleepH ? b : a)
    : null;

  const caption =
    `🍼 ${babyName}'s milk vs sleep — last ${ML_SLEEP_DAYS} days\n\n` +
    (best
      ? `💤 Longest sleep after *${best.amountMl}ml* (avg ${best.avgSleepH.toFixed(1)}h)\n` +
        `📊 Based on ${totalPairs} feed→sleep pairs`
      : `Not enough feeds logged yet to show correlation.`);

  await bot.api.sendPhoto(chatId, new InputFile(imgBuf, 'ml-sleep.png'), {
    caption,
    parse_mode: 'Markdown',
    reply_markup: menuKeyboard(),
  });
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

      const babyName = await getCachedBabyName(primaryId) ?? 'baby';
      if (msSince >= twoHalfHours && msSince < twoHalfHours + fiveMinutes) {
        await bot.api.sendMessage(
          chatId,
          `🍼 Time to prepare milk! ${babyName}'s next feed is in 30 minutes.`
        );
      } else if (msSince >= threeHours && msSince < threeHours + fiveMinutes) {
        await bot.api.sendMessage(
          chatId,
          `⏰ Time to feed ${babyName}! Last fed ${lastFeed.amount_ml}ml — ${formatAgo(new Date(lastFeed.logged_at))}`,
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
    { command: 'status',  description: '📊 Last feed & nappy' },
    { command: 'last5',   description: '📋 Last 5 feeds & nappy changes' },
    { command: 'history', description: '📅 Yesterday\'s full feed log' },
    { command: 'daily',   description: '📅 Day snapshot with navigation' },
    { command: 'delete',  description: '🗑️ Delete a recent entry' },
    { command: 'trends',  description: '📈 Activity heatmap — last 8 weeks' },
    { command: 'menu',    description: '🎛️ Show quick-action buttons' },
    { command: 'share',   description: '🔗 Generate a code to share with your partner' },
    { command: 'join',    description: "🔗 Join your partner's shared tracker" },
    { command: 'help',    description: '❓ Show all commands' },
  ]);
  console.log('Commands registered');

  bot.start();
  console.log('Nanny Bot running');
}

// Global error handler — prevents any single bad update from crashing the bot
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error handling update ${ctx.update.update_id}:`, err.error);
});

main().catch(console.error);
