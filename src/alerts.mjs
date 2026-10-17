// Notices for the owner: a machine over its daily budget, a reached subscription limit, a new machine.
// They show on the dashboard and, when a Telegram bot is set, come to Telegram too.

import { getSettings } from './db.mjs';
import { dayOf } from './time.mjs';
import { ACCOUNT, fallbackAccount, limitAmount, machineLimits } from './usage.mjs';
import { limitName, msg } from './messages.mjs';

/** Records a notice once per key; returns whether it is new. */
export function raise(db, { machineId = null, kind, message, key }) {
  const result = db
    .prepare('INSERT INTO alerts (ts, machine_id, kind, message, key) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING')
    .run(Date.now(), machineId, kind, message, key ?? null);
  if (result.changes > 0) {
    void sendTelegram(getSettings(db), message);
    return true;
  }

  return false;
}

/** After new requests: is any machine near (80%) or over one of its limits? Each is told once per period. */
export function checkBudgets(db, machineIds) {
  const settings = getSettings(db);
  for (const id of new Set(machineIds)) {
    const machine = db.prepare('SELECT * FROM machines WHERE id = ?').get(id);
    if (!machine) {
      continue;
    }

    for (const item of machineLimits(db, settings, machine).limits) {
      if (item.share == null || item.share < 0.8) {
        continue;
      }

      const over = item.share >= 1;
      const period = item.kind === 'day' ? dayOf(Date.now(), settings.timeZone) : String(item.resets);
      raise(db, {
        machineId: id,
        kind: 'budget',
        message: over
          ? msg(settings, 'budgetOver', { name: machine.name, limit: limitName(settings, item.label), spent: limitAmount(item, item.spent), max: limitAmount(item, item.limit), stop: machine.limit_block ? msg(settings, 'budgetStops') : '' })
          : msg(settings, 'budgetNear', { name: machine.name, limit: limitName(settings, item.label), percent: Math.round(item.share * 100), spent: limitAmount(item, item.spent), max: limitAmount(item, item.limit) }),
        key: `budget:${id}:${item.kind}:${over ? 'over' : 'near'}:${period}`,
      });
    }
  }
}

/** A 429 from the API: the subscription's limit; what the window had used by then is remembered. */
export function recordLimit(db, machine, { ts, account }) {
  const settings = getSettings(db);
  const hours = Number(settings.windowHours) || 5;
  // Only what was spent on the account that hit the limit counts.
  const fallback = fallbackAccount(db);
  const hit = account ?? machine.account ?? fallback;
  const onAccount = `FROM requests r JOIN machines m ON m.id = r.machine_id WHERE r.ts >= ? AND r.ts <= ? AND ${ACCOUNT} = ?`;
  const window = db
    .prepare(`SELECT coalesce(sum(r.cost), 0) AS cost, coalesce(sum(r.input + r.output + r.cache_read + r.cache_write), 0) AS tokens ${onAccount}`)
    .get(ts - hours * 3_600_000, ts, fallback, hit);
  const week = db.prepare(`SELECT coalesce(sum(r.cost), 0) AS cost ${onAccount}`).get(ts - 7 * 86_400_000, ts, fallback, hit);
  const recent = db.prepare('SELECT id FROM limit_hits WHERE ts > ? AND account IS ?').get(ts - 30 * 60_000, hit);
  if (recent) {
    return;
  }

  db.prepare('INSERT INTO limit_hits (machine_id, ts, account, window_cost, window_tokens, week_cost) VALUES (?, ?, ?, ?, ?, ?)').run(
    machine.id,
    ts,
    hit,
    window.cost,
    window.tokens,
    week.cost,
  );
  raise(db, {
    machineId: machine.id,
    kind: 'limit',
    message: msg(settings, 'limitHit', { name: machine.name, cost: `${window.cost.toFixed(2)}` }),
    key: `limit:${machine.id}:${Math.floor(ts / 1_800_000)}`,
  });
}

/** Sends a message to the owner's Telegram; says whether Telegram took it (and why not). */
async function sendTelegram(settings, text) {
  if (!settings.telegramToken || !settings.telegramChat) {
    return { ok: false, error: 'not-set' };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${settings.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: settings.telegramChat, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return { ok: true };
    const body = await response.json().catch(() => ({}));
    return { ok: false, error: String(body.description ?? response.status).slice(0, 200) };
  } catch (error) {
    // The dashboard still shows it.
    return { ok: false, error: error.cause?.code ?? error.message };
  }
}

export { sendTelegram };
