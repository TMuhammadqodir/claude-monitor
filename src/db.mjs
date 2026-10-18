import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_ip TEXT,
  os TEXT,
  arch TEXT,
  version TEXT,
  terminal TEXT,
  email TEXT,
  account TEXT,
  daily_budget REAL,
  note TEXT,
  disabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  session_id TEXT,
  request_id TEXT,
  model TEXT,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  speed TEXT,
  source TEXT,
  effort TEXT,
  project TEXT,
  origin TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS requests_once ON requests(machine_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS requests_machine_ts ON requests(machine_id, ts);
CREATE INDEX IF NOT EXISTS requests_session ON requests(session_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  name TEXT,
  ok INTEGER,
  duration_ms INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_kind_ts ON events(kind, ts);

CREATE TABLE IF NOT EXISTS counters (
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  value REAL NOT NULL,
  PRIMARY KEY (machine_id, day, metric, kind)
);

CREATE TABLE IF NOT EXISTS series (
  key TEXT PRIMARY KEY,
  start INTEGER NOT NULL,
  value REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS limit_hits (
  id INTEGER PRIMARY KEY,
  machine_id INTEGER REFERENCES machines(id) ON DELETE SET NULL,
  ts INTEGER NOT NULL,
  account TEXT,
  window_cost REAL,
  window_tokens INTEGER,
  week_cost REAL
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  machine_id INTEGER REFERENCES machines(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  key TEXT UNIQUE,
  seen INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS usage_reports (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  machine_id INTEGER REFERENCES machines(id) ON DELETE SET NULL,
  account TEXT,
  email TEXT,
  limits TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_reports_ts ON usage_reports(ts);

-- The Claude accounts seen in telemetry or in the agents' reports, with the email to show for each.
CREATE TABLE IF NOT EXISTS accounts (
  account TEXT PRIMARY KEY,
  email TEXT,
  seen_at INTEGER NOT NULL
);

-- The dashboard's signed-in sessions (the hash of each cookie's nonce): signing out ends one on the server.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Opens (and creates when missing) the database file. */
export function openDb(file) {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  }

  const db = new DatabaseSync(file);
  if (file !== ':memory:') keepPrivate(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * The database holds the password's hash, the session secret and the Telegram token: on Linux and macOS only
 * its owner may read it (Windows keeps a user's files to that user through the folder's own permissions).
 */
export function keepPrivate(file) {
  if (process.platform === 'win32') return;
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      if (existsSync(path)) chmodSync(path, 0o600);
    } catch {
      // Not the owner: nothing to do about it here.
    }
  }
}

const DAY_MS = 86_400_000;

/**
 * Old rows that only grow the file: tool and prompt events after EVENT_DAYS (180 by default), alerts already
 * seen after 90 days, the cumulative series of Claude Code runs long over. The requests themselves are the
 * history and are kept, unless KEEP_DAYS asks for less.
 */
export function prune(db, now = Date.now(), env = process.env) {
  const eventDays = Number(env.EVENT_DAYS) > 0 ? Number(env.EVENT_DAYS) : 180;
  db.prepare('DELETE FROM events WHERE ts < ?').run(now - eventDays * DAY_MS);
  db.prepare('DELETE FROM alerts WHERE seen = 1 AND ts < ?').run(now - 90 * DAY_MS);
  // A series that started 60 days ago belongs to a Claude Code long closed (start 0 means "not known": kept).
  db.prepare('DELETE FROM series WHERE start > 0 AND start < ?').run(now - 60 * DAY_MS);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
  if (Number(env.KEEP_DAYS) > 0) {
    const before = now - Number(env.KEEP_DAYS) * DAY_MS;
    db.prepare('DELETE FROM requests WHERE ts < ?').run(before);
    db.prepare('DELETE FROM limit_hits WHERE ts < ?').run(before);
    db.prepare('DELETE FROM counters WHERE day < ?').run(new Date(before).toISOString().slice(0, 10));
  }
}

// Columns added after the first version: an older database gets them on start.
const ADDED_COLUMNS = {
  machines: {
    limit_window: 'REAL',
    limit_week: 'REAL',
    limit_month: 'REAL',
    limit_block: 'INTEGER NOT NULL DEFAULT 0',
    // The account the machine's limits count; none counts every account.
    limit_account: 'TEXT',
    // The machine's share of the account's 5-hour and weekly limits, in Anthropic's percentages.
    limit_five_pct: 'REAL',
    limit_week_pct: 'REAL',
    // Stopped from the dashboard: no prompt runs until it is let go again.
    paused: 'INTEGER NOT NULL DEFAULT 0',
    // The token before the last "new token": a computer still sending it is told about on the dashboard.
    old_token_hash: 'TEXT',
    // A link that shows this machine's own usage, without the password (see /share/…).
    share_token: 'TEXT',
    // The model families the machine may use (a JSON list, none = every one) and its highest effort level.
    allowed_models: 'TEXT',
    max_effort: 'TEXT',
  },
  // The account a request was made with: one computer can switch between accounts.
  requests: {
    account: 'TEXT',
  },
};

function migrate(db) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!have.has(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    }
  }

  db.exec('CREATE INDEX IF NOT EXISTS requests_account_ts ON requests(account, ts)');
}

/** Remembers an account and, when known, its email. */
export function rememberAccount(db, account, email, now = Date.now()) {
  if (!account) return;
  db.prepare(
    `INSERT INTO accounts (account, email, seen_at) VALUES (?, ?, ?)
     ON CONFLICT(account) DO UPDATE SET email = coalesce(excluded.email, email), seen_at = excluded.seen_at`,
  ).run(account, email ?? null, now);
}

/** Runs the work in one transaction. */
export function inTransaction(db, work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const DEFAULTS = {
  // The language of the server's own messages (alerts, Telegram, a stopped prompt's reason): uz, en or ru.
  language: 'en',
  planName: 'Max 20x',
  planPrice: '200',
  billingDay: '1',
  usdToUzs: '12700',
  windowHours: '5',
  telegramToken: '',
  telegramChat: '',
  timeZone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tashkent',
  chartDays: '30',
};

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = { ...DEFAULTS };
  for (const row of rows) {
    settings[row.key] = row.value;
  }

  return settings;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value),
  );
}
