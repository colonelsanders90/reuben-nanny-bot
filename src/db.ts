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
  `);
}

export async function registerChat(chatId: number) {
  await pool.query(
    'INSERT INTO chats (chat_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [chatId]
  );
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

export async function getAllChats(): Promise<number[]> {
  const result = await pool.query('SELECT chat_id FROM chats');
  return result.rows.map((r) => Number(r.chat_id));
}
