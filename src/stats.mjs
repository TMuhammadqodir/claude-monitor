// The numbers the dashboard shows, read from the stored requests, events and counters.

import { dayOf, hourOf, startOfDay, daysBetween, billingStart, weekStart } from './time.mjs';
import { modelLabel } from './pricing.mjs';
import { ACCOUNT, accountEmails, exactUsage, fallbackAccount, machineLimits } from './usage.mjs';

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Whether the machine works right now, was here today, or is away. */
export function statusOf(machine, lastActivity, now) {
  const seen = Math.max(machine.last_seen_at ?? 0, lastActivity ?? 0);
  if (machine.disabled) return 'disabled';
  if (!seen) return 'never';
  if (lastActivity && now - lastActivity < 3 * MINUTE) return 'active';
  if (now - seen < 10 * MINUTE) return 'online';
  if (now - seen < 24 * HOUR) return 'idle';
  return 'offline';
}

function totalsSince(db, since, machineId) {
  const where = machineId ? 'ts >= ? AND machine_id = ?' : 'ts >= ?';
  const args = machineId ? [since, machineId] : [since];
  const row = db
    .prepare(
      `SELECT count(*) AS requests, coalesce(sum(cost), 0) AS cost, coalesce(sum(input), 0) AS input,
         coalesce(sum(output), 0) AS output, coalesce(sum(cache_read), 0) AS cacheRead,
         coalesce(sum(cache_write), 0) AS cacheWrite, count(DISTINCT session_id) AS sessions
       FROM requests WHERE ${where}`,
    )
    .get(...args);
  return { ...row, tokens: row.input + row.output + row.cacheRead + row.cacheWrite };
}

/**
 * The subscription's usage windows: a window opens with the first request after the last one closed and
 * lasts `hours` (five on Pro and Max), from the start of that hour. Machines that share an account share it.
 */
export function windowsOf(db, now, hours, fallback = fallbackAccount(db)) {
  const length = hours * HOUR;
  const rows = db
    .prepare(
      `SELECT r.ts, r.machine_id AS machineId, ${ACCOUNT} AS account, r.cost, r.input + r.output + r.cache_read + r.cache_write AS tokens
       FROM requests r JOIN machines m ON m.id = r.machine_id WHERE r.ts >= ? ORDER BY r.ts`,
    )
    .all(fallback, now - 2 * length - HOUR);

  const accounts = new Map();
  for (const row of rows) {
    const account = row.account;
    let state = accounts.get(account);
    if (!state || row.ts >= state.start + length) {
      state = { account, start: row.ts - (row.ts % HOUR), cost: 0, tokens: 0, requests: 0, machines: {} };
      accounts.set(account, state);
    }

    state.cost += row.cost;
    state.tokens += row.tokens;
    state.requests++;
    state.machines[row.machineId] = (state.machines[row.machineId] ?? 0) + row.cost;
  }

  return [...accounts.values()].map((state) => ({
    ...state,
    end: state.start + length,
    open: now < state.start + length,
  }));
}

/** Everything the overview page shows. */
export function overview(db, settings, now = Date.now()) {
  const tz = settings.timeZone;
  const today = startOfDay(now, tz);
  const week = weekStart(now, tz);
  const month = billingStart(now, settings.billingDay, tz);
  const days = Math.max(7, Math.min(90, Number(settings.chartDays) || 30));
  const from = startOfDay(now - (days - 1) * 86_400_000, tz);

  const machines = db.prepare('SELECT * FROM machines ORDER BY name').all();
  const fallback = fallbackAccount(db);
  const emails = accountEmails(db);
  // This week's spending of each machine on each account: a computer can switch between accounts.
  const weekUse = db
    .prepare(
      `SELECT r.machine_id AS id, ${ACCOUNT} AS account, sum(r.cost) AS cost, count(*) AS requests
       FROM requests r JOIN machines m ON m.id = r.machine_id WHERE r.ts >= ? GROUP BY r.machine_id, 2 ORDER BY cost DESC`,
    )
    .all(fallback, week)
    .map((row) => ({ ...row, email: emails.get(row.account) ?? null }));
  const lastActivity = new Map(
    db
      .prepare('SELECT machine_id AS id, max(ts) AS ts FROM (SELECT machine_id, ts FROM requests WHERE ts >= ? UNION ALL SELECT machine_id, ts FROM events WHERE ts >= ?) GROUP BY machine_id')
      .all(now - 7 * 86_400_000, now - 7 * 86_400_000)
      .map((row) => [row.id, row.ts]),
  );

  const perMachine = (since) =>
    new Map(
      db
        .prepare(
          `SELECT machine_id AS id, count(*) AS requests, sum(cost) AS cost,
             sum(input + output + cache_read + cache_write) AS tokens, count(DISTINCT session_id) AS sessions
           FROM requests WHERE ts >= ? GROUP BY machine_id`,
        )
        .all(since)
        .map((row) => [row.id, row]),
    );
  const todayBy = perMachine(today);
  const weekBy = perMachine(week);
  const monthBy = perMachine(month);
  const allBy = perMachine(0);

  const openSessions = new Map(
    db
      .prepare('SELECT machine_id AS id, session_id AS session, min(ts) AS started, sum(cost) AS cost FROM requests WHERE ts >= ? AND session_id IS NOT NULL GROUP BY machine_id, session_id ORDER BY max(ts)')
      .all(now - 30 * MINUTE)
      .map((row) => [row.id, row]),
  );
  const lastModel = new Map(
    db
      .prepare('SELECT r.machine_id AS id, r.model FROM requests r JOIN (SELECT machine_id, max(ts) AS ts FROM requests GROUP BY machine_id) l ON l.machine_id = r.machine_id AND l.ts = r.ts')
      .all()
      .map((row) => [row.id, row.model]),
  );

  const zero = { requests: 0, cost: 0, tokens: 0, sessions: 0 };
  const machineCards = machines.map((m) => {
    const t = todayBy.get(m.id) ?? zero;
    return {
      id: m.id,
      name: m.name,
      color: m.color,
      status: statusOf(m, lastActivity.get(m.id), now),
      lastSeen: Math.max(m.last_seen_at ?? 0, lastActivity.get(m.id) ?? 0) || null,
      os: m.os,
      arch: m.arch,
      version: m.version,
      terminal: m.terminal,
      email: m.email,
      ip: m.last_ip,
      tokenHint: m.token_hint,
      note: m.note,
      disabled: Boolean(m.disabled),
      budget: m.daily_budget,
      limits: machineLimits(db, settings, m, now).limits.filter((item) => item.limit > 0),
      blocking: Boolean(m.limit_block),
      paused: Boolean(m.paused),
      accounts: weekUse.filter((u) => u.id === m.id).map(({ account, email, cost, requests }) => ({ account, email, cost, requests })),
      model: lastModel.get(m.id) ? modelLabel(lastModel.get(m.id)) : null,
      session: openSessions.get(m.id) ?? null,
      today: t,
      week: weekBy.get(m.id) ?? zero,
      month: monthBy.get(m.id) ?? zero,
      all: allBy.get(m.id) ?? zero,
    };
  });

  // Day by day, per machine; the counters stand in for a day a machine sent only metrics.
  const dayRows = db
    .prepare('SELECT ts, machine_id AS id, cost, input + output + cache_read + cache_write AS tokens FROM requests WHERE ts >= ?')
    .all(from);
  const daily = new Map(daysBetween(dayOf(from, tz), dayOf(now, tz)).map((day) => [day, { day, cost: 0, tokens: 0, machines: {} }]));
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const row of dayRows) {
    const entry = daily.get(dayOf(row.ts, tz));
    if (entry) {
      entry.cost += row.cost;
      entry.tokens += row.tokens;
      entry.machines[row.id] = (entry.machines[row.id] ?? 0) + row.cost;
    }

    const { hour, weekday } = hourOf(row.ts, tz);
    if (weekday >= 0) heat[weekday][hour] += row.cost;
  }

  const metricCost = db
    .prepare("SELECT day, machine_id AS id, sum(value) AS cost FROM counters WHERE metric = 'cost' AND day >= ? GROUP BY day, machine_id")
    .all(dayOf(from, tz));
  for (const row of metricCost) {
    const entry = daily.get(row.day);
    if (entry && !(entry.machines[row.id] > 0)) {
      entry.machines[row.id] = row.cost;
      entry.cost += row.cost;
    }
  }

  const models = db
    .prepare(
      `SELECT model, count(*) AS requests, sum(cost) AS cost, sum(input) AS input, sum(output) AS output,
         sum(cache_read) AS cacheRead, sum(cache_write) AS cacheWrite
       FROM requests WHERE ts >= ? GROUP BY model ORDER BY cost DESC`,
    )
    .all(month)
    .map((row) => ({ ...row, label: modelLabel(row.model), tokens: row.input + row.output + row.cacheRead + row.cacheWrite }));

  const counters = Object.fromEntries(
    db
      .prepare("SELECT metric || ':' || kind AS key, sum(value) AS value FROM counters WHERE day >= ? GROUP BY metric, kind")
      .all(dayOf(month, tz))
      .map((row) => [row.key, row.value]),
  );

  const tools = db
    .prepare(
      `SELECT name, count(*) AS uses, sum(ok) AS ok, avg(duration_ms) AS ms FROM events
       WHERE kind = 'tool_result' AND ts >= ? AND name IS NOT NULL GROUP BY name ORDER BY uses DESC LIMIT 12`,
    )
    .all(month);

  const projects = db
    .prepare(
      `SELECT project, count(*) AS requests, sum(cost) AS cost, count(DISTINCT session_id) AS sessions, max(ts) AS last
       FROM requests WHERE ts >= ? AND project IS NOT NULL GROUP BY project ORDER BY cost DESC LIMIT 12`,
    )
    .all(month);

  const errors = db
    .prepare(
      `SELECT e.ts, e.kind, e.name, e.detail, m.name AS machine FROM events e JOIN machines m ON m.id = e.machine_id
       WHERE e.kind IN ('api_error', 'api_refusal', 'internal_error') AND e.ts >= ? ORDER BY e.ts DESC LIMIT 20`,
    )
    .all(now - 7 * 86_400_000);

  const prompts = db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'user_prompt' AND ts >= ?").get(today).n;

  const windowHours = Number(settings.windowHours) || 5;
  const windows = windowsOf(db, now, windowHours, fallback);
  const hits = db.prepare('SELECT account, ts, window_cost AS windowCost, week_cost AS weekCost FROM limit_hits ORDER BY ts DESC LIMIT 20').all();
  const exact = exactUsage(db, now, { machines, settings, fallback });
  // Every account used this week or reported on, each with the machines that used it.
  const accountIds = [...new Set([...weekUse.map((u) => u.account), ...exact.map((e) => e.account), ...windows.filter((w) => w.open).map((w) => w.account)])];
  const accounts = accountIds.map((account) => {
    const window = windows.find((w) => w.account === account && w.open) ?? null;
    const own = hits.filter((h) => (h.account ?? fallback) === account);
    const lastHit = own[0] ?? null;
    const use = weekUse.filter((u) => u.account === account);
    return {
      account,
      email: emails.get(account) ?? exact.find((e) => e.account === account)?.email ?? null,
      machines: [...new Set([...use.map((u) => u.id), ...Object.keys(window?.machines ?? {}).map(Number)])],
      window,
      week: use.reduce((total, u) => total + u.cost, 0),
      observedWindowLimit: lastHit?.windowCost ?? null,
      observedWeekLimit: own.reduce((max, h) => Math.max(max, h.weekCost ?? 0), 0) || null,
      lastHit: lastHit?.ts ?? null,
      exact: exact.find((e) => e.account === account) ?? null,
    };
  });

  const planPrice = Number(settings.planPrice) || 0;
  const monthTotals = totalsSince(db, month);
  // The subscription is paid for one account: its value counts that account's month, not a friend's. Without
  // a choice in the settings, the account that did the most this month.
  const byAccount = db
    .prepare(`SELECT ${ACCOUNT} AS account, sum(r.cost) AS cost FROM requests r JOIN machines m ON m.id = r.machine_id WHERE r.ts >= ? GROUP BY 1 ORDER BY cost DESC`)
    .all(fallback, month);
  const planAccount = settings.planAccount || byAccount[0]?.account || null;
  const planValue = byAccount.length > 1 ? (byAccount.find((a) => a.account === planAccount)?.cost ?? 0) : monthTotals.cost;
  return {
    now,
    timeZone: tz,
    plan: {
      name: settings.planName,
      price: planPrice,
      start: month,
      next: billingStart(month + 40 * 86_400_000, settings.billingDay, tz),
      value: planValue,
      multiple: planPrice > 0 ? planValue / planPrice : null,
      account: byAccount.length > 1 ? planAccount : null,
      email: byAccount.length > 1 ? (emails.get(planAccount) ?? null) : null,
      chosen: Boolean(settings.planAccount),
      usdToUzs: Number(settings.usdToUzs) || 0,
    },
    totals: {
      today: { ...totalsSince(db, today), prompts },
      week: totalsSince(db, week),
      month: monthTotals,
      all: totalsSince(db, 0),
    },
    machines: machineCards,
    accounts,
    daily: [...daily.values()],
    heat,
    models,
    counters,
    tools,
    projects,
    errors,
    alerts: db.prepare('SELECT a.*, m.name AS machine FROM alerts a LEFT JOIN machines m ON m.id = a.machine_id WHERE a.seen = 0 ORDER BY a.ts DESC LIMIT 20').all(),
  };
}

/** The latest requests, newest first, for the live feed. */
export function recentRequests(db, limit = 40, machineId = null) {
  return db
    .prepare(
      `SELECT r.id, r.ts, r.model, r.input, r.output, r.cache_read AS cacheRead, r.cache_write AS cacheWrite, r.cost,
         r.duration_ms AS ms, r.speed, r.source, r.project, r.session_id AS session, m.name AS machine, m.color
       FROM requests r JOIN machines m ON m.id = r.machine_id
       ${machineId ? 'WHERE r.machine_id = ?' : ''}
       ORDER BY r.ts DESC LIMIT ?`,
    )
    .all(...(machineId ? [machineId, limit] : [limit]))
    .map((row) => ({ ...row, label: modelLabel(row.model) }));
}

/** Sessions, newest first: one Claude Code conversation each, with the account it was on. */
export function sessions(db, { machineId = null, limit = 50, since = 0 } = {}) {
  const emails = accountEmails(db);
  return db
    .prepare(
      `SELECT r.session_id AS id, m.name AS machine, m.color, min(r.ts) AS started, max(r.ts) AS last,
         count(*) AS requests, sum(r.cost) AS cost, sum(r.input + r.output + r.cache_read + r.cache_write) AS tokens,
         sum(r.output) AS output, group_concat(DISTINCT r.model) AS models, max(r.project) AS project,
         coalesce(max(r.account), m.account) AS account
       FROM requests r JOIN machines m ON m.id = r.machine_id
       WHERE r.session_id IS NOT NULL AND r.ts >= ? ${machineId ? 'AND r.machine_id = ?' : ''}
       GROUP BY r.session_id, m.id ORDER BY last DESC LIMIT ?`,
    )
    .all(...(machineId ? [since, machineId, limit] : [since, limit]))
    .map((row) => ({ ...row, email: emails.get(row.account) ?? null, models: [...new Set(String(row.models ?? '').split(',').filter(Boolean).map(modelLabel))] }));
}

/** One machine in detail: its days, models and sessions. */
export function machineDetail(db, settings, id, now = Date.now()) {
  const machine = db.prepare('SELECT * FROM machines WHERE id = ?').get(id);
  if (!machine) {
    return null;
  }

  const tz = settings.timeZone;
  const from = startOfDay(now - 29 * 86_400_000, tz);
  const daily = new Map(daysBetween(dayOf(from, tz), dayOf(now, tz)).map((day) => [day, { day, cost: 0, tokens: 0, requests: 0 }]));
  for (const row of db
    .prepare('SELECT ts, cost, input + output + cache_read + cache_write AS tokens FROM requests WHERE machine_id = ? AND ts >= ?')
    .all(id, from)) {
    const entry = daily.get(dayOf(row.ts, tz));
    if (entry) {
      entry.cost += row.cost;
      entry.tokens += row.tokens;
      entry.requests++;
    }
  }

  const models = db
    .prepare('SELECT model, count(*) AS requests, sum(cost) AS cost, sum(input + output + cache_read + cache_write) AS tokens FROM requests WHERE machine_id = ? AND ts >= ? GROUP BY model ORDER BY cost DESC')
    .all(id, from)
    .map((row) => ({ ...row, label: modelLabel(row.model) }));

  const counters = Object.fromEntries(
    db
      .prepare("SELECT metric || ':' || kind AS key, sum(value) AS value FROM counters WHERE machine_id = ? AND day >= ? GROUP BY metric, kind")
      .all(id, dayOf(from, tz))
      .map((row) => [row.key, row.value]),
  );

  // Every account known, with what this machine spent on each in the 30 days: its limits can count one of them.
  const fallback = fallbackAccount(db);
  const emails = accountEmails(db);
  const spentOn = new Map(
    db
      .prepare(`SELECT ${ACCOUNT} AS account, sum(r.cost) AS cost FROM requests r JOIN machines m ON m.id = r.machine_id WHERE r.machine_id = ? AND r.ts >= ? GROUP BY 1`)
      .all(fallback, id, from)
      .map((row) => [row.account, row.cost]),
  );
  const known = db.prepare('SELECT account FROM accounts').all().map((row) => row.account);
  const accounts = [...new Set([...spentOn.keys(), ...known, ...emails.keys()])]
    .filter((account) => account !== 'shared')
    .map((account) => ({ account, email: emails.get(account) ?? null, cost: spentOn.get(account) ?? 0 }))
    .sort((a, b) => b.cost - a.cost);

  return {
    machine: { ...machine, token_hash: undefined },
    accounts,
    totals: totalsSince(db, from, id),
    daily: [...daily.values()],
    models,
    counters,
    sessions: sessions(db, { machineId: id, limit: 30 }),
    recent: recentRequests(db, 30, id),
  };
}

/**
 * What a machine's share link shows, without the password: its own spending, its limits and its part of each
 * account's limits. Nothing about the other machines but the account's total percentage.
 */
/** "muhammad@gmail.com" → "mu•••@gmail.com". */
export const maskEmail = (email) => {
  const [name, domain] = String(email ?? '').split('@');
  return email && domain ? `${name.slice(0, 2)}•••@${domain}` : null;
};

export function sharedView(db, settings, machine, now = Date.now()) {
  const tz = settings.timeZone;
  const from = startOfDay(now - 13 * 86_400_000, tz);
  const daily = new Map(daysBetween(dayOf(from, tz), dayOf(now, tz)).map((day) => [day, { day, cost: 0, tokens: 0, machines: {} }]));
  for (const row of db.prepare('SELECT ts, cost, input + output + cache_read + cache_write AS tokens FROM requests WHERE machine_id = ? AND ts >= ?').all(machine.id, from)) {
    const entry = daily.get(dayOf(row.ts, tz));
    if (!entry) continue;
    entry.cost += row.cost;
    entry.tokens += row.tokens;
    entry.machines[machine.id] = entry.cost;
  }

  const machines = db.prepare('SELECT id, name, color, account FROM machines').all();
  const shares = exactUsage(db, now, { machines, settings })
    .map((e) => ({
      // Whoever has the link sees whose subscription it is, not the whole address.
      email: maskEmail(e.email),
      limits: (e.split ?? [])
        .map((s) => ({ kind: s.kind, label: s.label, resetsAt: s.resetsAt, total: s.percent, mine: s.machines.find((m) => m.id === machine.id)?.percent ?? 0, cost: s.machines.find((m) => m.id === machine.id)?.cost ?? 0 }))
        .filter((l) => l.cost > 0),
    }))
    .filter((e) => e.limits.length);
  const lastActivity = db.prepare('SELECT max(ts) AS ts FROM requests WHERE machine_id = ?').get(machine.id).ts;

  return {
    now,
    timeZone: tz,
    usdToUzs: Number(settings.usdToUzs) || 0,
    machine: { id: machine.id, name: machine.name, color: machine.color, paused: Boolean(machine.paused), status: statusOf(machine, lastActivity, now), lastSeen: Math.max(machine.last_seen_at ?? 0, lastActivity ?? 0) || null },
    totals: { today: totalsSince(db, startOfDay(now, tz), machine.id), week: totalsSince(db, weekStart(now, tz), machine.id), month: totalsSince(db, billingStart(now, settings.billingDay, tz), machine.id) },
    daily: [...daily.values()],
    limits: machineLimits(db, settings, machine, now).limits.filter((item) => item.limit > 0),
    blocking: Boolean(machine.limit_block),
    shares,
  };
}
