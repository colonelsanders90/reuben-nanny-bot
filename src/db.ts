import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id        SERIAL PRIMARY KEY,
      chat_id   BIGINT NOT NULL,
      type      VARCHAR(10) NOT NULL,
      amount_ml INTEGER,
      nappy_type VARCHAR(10),
      logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chats (
      chat_id      BIGINT PRIMARY KEY,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS link_codes (
      code            VARCHAR(8) PRIMARY KEY,
      primary_chat_id BIGINT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chat_links (
      chat_id         BIGINT PRIMARY KEY,
      primary_chat_id BIGINT NOT NULL
    );
  `);
}

export async function registerChat(chatId: number) {
  await pool.query(
    'INSERT INTO chats (chat_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [chatId]
  );
}

export async function resolvePrimaryChat(chatId: number): Promise<number> {
  const result = await pool.query(
    'SELECT primary_chat_id FROM chat_links WHERE chat_id = $1',
    [chatId]
  );
  return result.rows[0]?.primary_chat_id ?? chatId;
}

export async function createLinkCode(chatId: number): Promise<string> {
  const primary = await resolvePrimaryChat(chatId);
  await pool.query('DELETE FROM link_codes WHERE primary_chat_id = $1', [primary]);
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  await pool.query(
    'INSERT INTO link_codes (code, primary_chat_id) VALUES ($1, $2)',
    [code, primary]
  );
  return code;
}

// Returns the primary chat_id on success, null if code is invalid or self-link.
export async function linkChat(chatId: number, code: string): Promise<number | null> {
  const result = await pool.query(
    'SELECT primary_chat_id FROM link_codes WHERE code = $1',
    [code.toUpperCase()]
  );
  if (!result.rows[0]) return null;
  const primaryChatId: number = result.rows[0].primary_chat_id;
  if (primaryChatId === chatId) return null;
  await pool.query(
    `INSERT INTO chat_links (chat_id, primary_chat_id) VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET primary_chat_id = EXCLUDED.primary_chat_id`,
    [chatId, primaryChatId]
  );
  await pool.query('DELETE FROM link_codes WHERE code = $1', [code.toUpperCase()]);
  return primaryChatId;
}

export async function logFeed(chatId: number, amountMl: number, loggedAt: Date) {
  await pool.query(
    'INSERT INTO events (chat_id, type, amount_ml, logged_at) VALUES ($1, $2, $3, $4)',
    [chatId, 'feed', amountMl, loggedAt]
  );
}

export async function logNappy(chatId: number, nappyType: string, loggedAt: Date) {
  await pool.query(
    'INSERT INTO events (chat_id, type, nappy_type, logged_at) VALUES ($1, $2, $3, $4)',
    [chatId, 'nappy', nappyType, loggedAt]
  );
}

export async function getLastFeed(chatId: number) {
  const result = await pool.query(
    `SELECT * FROM events WHERE chat_id = $1 AND type = 'feed' ORDER BY logged_at DESC LIMIT 1`,
    [chatId]
  );
  return result.rows[0] ?? null;
}

export async function getLastNappy(chatId: number) {
  const result = await pool.query(
    `SELECT * FROM events WHERE chat_id = $1 AND type = 'nappy' ORDER BY logged_at DESC LIMIT 1`,
    [chatId]
  );
  return result.rows[0] ?? null;
}

export async function getRecentFeeds(chatId: number, limit = 3) {
  const result = await pool.query(
    `SELECT * FROM events WHERE chat_id = $1 AND type = 'feed' ORDER BY logged_at DESC LIMIT $2`,
    [chatId, limit]
  );
  return result.rows;
}

export async function getRecentNappies(chatId: number, limit = 3) {
  const result = await pool.query(
    `SELECT * FROM events WHERE chat_id = $1 AND type = 'nappy' ORDER BY logged_at DESC LIMIT $2`,
    [chatId, limit]
  );
  return result.rows;
}

export async function getAllChats(): Promise<number[]> {
  const result = await pool.query('SELECT chat_id FROM chats');
  return result.rows.map((r) => Number(r.chat_id));
}
