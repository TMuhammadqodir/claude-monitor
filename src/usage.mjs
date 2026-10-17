// Tokens by model for any period, the 5-hour windows one after another, this week and month against the
// last ones, and each machine's own limits.

import { billingStart, startOfDay, weekStart } from './time.mjs';
import { modelLabel } from './pricing.mjs';
import { rememberAccount } from './db.mjs';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Which account a request counts against: the one Claude Code said it was made with (one computer can
 * switch accounts), else the one its machine last used (history from the logs names none), else the only
 * account there is. Use as `${ACCOUNT}` over `requests r JOIN machines m ON m.id = r.machine_id`, with the
 * fallback as its parameter.
 */
export const ACCOUNT = 'coalesce(r.account, m.account, ?)';

/** The account for requests and machines that name none: the only one known, or "shared". */
export function fallbackAccount(db) {
  const known = db
    .prepare('SELECT account FROM accounts UNION SELECT account FROM machines WHERE account IS NOT NULL UNION SELECT account FROM usage_reports WHERE account IS NOT NULL')
    .all();
  return known.length === 1 ? known[0].account : 'shared';
}

/** Each account's email, from telemetry, the agents' reports and the machines. */
export function accountEmails(db) {
  const emails = new Map();
  for (const row of db.prepare('SELECT account, email FROM machines WHERE account IS NOT NULL AND email IS NOT NULL').all()) emails.set(row.account, row.email);
  for (const row of db.prepare('SELECT account, email FROM usage_reports WHERE account IS NOT NULL AND email IS NOT NULL ORDER BY ts').all()) emails.set(row.account, row.email);
  for (const row of db.prepare('SELECT account, email FROM accounts WHERE email IS NOT NULL').all()) emails.set(row.account, row.email);
  return emails;
}

/** The named periods, each [from, to) in milliseconds. */
export function periods(settings, now = Date.now()) {
  const tz = settings.timeZone;
  const today = startOfDay(now, tz);
  const week = weekStart(now, tz);
  const month = billingStart(now, settings.billingDay, tz);
  const lastMonth = billingStart(month - DAY, settings.billingDay, tz);
  return {
    today: { from: today, to: now, label: 'Bugun' },
    yesterday: { from: startOfDay(today - HOUR, tz), to: today, label: 'Kecha' },
    week: { from: week, to: now, label: 'Shu hafta' },
    lastWeek: { from: weekStart(week - HOUR, tz), to: week, label: 'O‘tgan hafta' },
    month: { from: month, to: now, label: 'Shu oy' },
    lastMonth: { from: lastMonth, to: month, label: 'O‘tgan oy' },
    days30: { from: now - 30 * DAY, to: now, label: '30 kun' },
    all: { from: 0, to: now, label: 'Hammasi' },
  };
}

const SUMS = `count(*) AS requests, coalesce(sum(cost), 0) AS cost, coalesce(sum(input), 0) AS input,
  coalesce(sum(output), 0) AS output, coalesce(sum(cache_read), 0) AS cacheRead, coalesce(sum(cache_write), 0) AS cacheWrite`;

const withTotals = (row) => ({ ...row, tokens: row.input + row.output + row.cacheRead + row.cacheWrite });

/**
 * Tokens of each kind by model in the period, overall and for every machine: what went in, what came out,
 * what was read from the cache and written to it, and what that would cost on the API.
 */
export function breakdown(db, from, to) {
  const totals = withTotals(db.prepare(`SELECT ${SUMS}, count(DISTINCT session_id) AS sessions FROM requests WHERE ts >= ? AND ts < ?`).get(from, to));
  const models = db
    .prepare(`SELECT model, ${SUMS} FROM requests WHERE ts >= ? AND ts < ? GROUP BY model ORDER BY cost DESC`)
    .all(from, to)
    .map((row) => ({ ...withTotals(row), label: modelLabel(row.model) }));

  const machines = new Map();
  for (const row of db
    .prepare(
      `SELECT m.id, m.name, m.color, r.model, count(*) AS requests, sum(r.cost) AS cost, sum(r.input) AS input,
         sum(r.output) AS output, sum(r.cache_read) AS cacheRead, sum(r.cache_write) AS cacheWrite
       FROM requests r JOIN machines m ON m.id = r.machine_id WHERE r.ts >= ? AND r.ts < ?
       GROUP BY m.id, r.model ORDER BY m.name`,
    )
    .all(from, to)) {
    const entry = machines.get(row.id) ?? { id: row.id, name: row.name, color: row.color, models: [], cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
    const model = { ...withTotals(row), label: modelLabel(row.model) };
    entry.models.push(model);
    for (const key of ['cost', 'tokens', 'input', 'output', 'cacheRead', 'cacheWrite', 'requests']) entry[key] += model[key];
    machines.set(row.id, entry);
  }

  const list = [...machines.values()].sort((a, b) => b.cost - a.cost);
  for (const machine of list) machine.models.sort((a, b) => b.cost - a.cost);
  return { from, to, totals, models, machines: list };
}

/**
 * The 5-hour windows of the last `days`, newest first, each with its tokens by model and by machine. A
 * window opens with the first request after the last one closed, from the start of that hour.
 * Its share is measured against the limit seen at the last 429, or else against the biggest window.
 */
export function windowHistory(db, { now = Date.now(), hours = 5, days = 7, fallback = fallbackAccount(db), limits = new Map() }) {
  const length = hours * HOUR;
  const rows = db
    .prepare(
      `SELECT r.ts, r.machine_id AS machineId, ${ACCOUNT} AS account, r.model, r.cost, r.input, r.output,
         r.cache_read AS cacheRead, r.cache_write AS cacheWrite
       FROM requests r JOIN machines m ON m.id = r.machine_id WHERE r.ts >= ? ORDER BY r.ts`,
    )
    .all(fallback, now - days * DAY - length);

  const open = new Map();
  const windows = [];
  for (const row of rows) {
    const account = row.account;
    let window = open.get(account);
    if (!window || row.ts >= window.start + length) {
      window = { account, start: row.ts - (row.ts % HOUR), cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, models: {}, machines: {} };
      window.end = window.start + length;
      open.set(account, window);
      windows.push(window);
    }

    window.cost += row.cost;
    window.input += row.input;
    window.output += row.output;
    window.cacheRead += row.cacheRead;
    window.cacheWrite += row.cacheWrite;
    window.requests++;
    const model = (window.models[row.model] ??= { model: row.model, label: modelLabel(row.model), cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });
    model.cost += row.cost;
    model.input += row.input;
    model.output += row.output;
    model.cacheRead += row.cacheRead;
    model.cacheWrite += row.cacheWrite;
    model.requests++;
    window.machines[row.machineId] = (window.machines[row.machineId] ?? 0) + row.cost;
  }

  const biggest = new Map();
  for (const window of windows) biggest.set(window.account, Math.max(biggest.get(window.account) ?? 0, window.cost));

  return windows
    .reverse()
    .map((window) => {
      const limit = limits.get(window.account) ?? null;
      const basis = limit ?? biggest.get(window.account) ?? 0;
      return {
        ...window,
        tokens: window.input + window.output + window.cacheRead + window.cacheWrite,
        models: Object.values(window.models).sort((a, b) => b.cost - a.cost),
        open: now < window.end,
        share: basis > 0 ? window.cost / basis : null,
        basis: limit ? 'limit' : 'biggest',
      };
    });
}

/** This week and month against the last ones, by model. */
export function comparisons(db, settings, now = Date.now()) {
  const p = periods(settings, now);
  const pair = (current, previous) => ({
    current: { ...breakdown(db, current.from, current.to), label: current.label },
    previous: { ...breakdown(db, previous.from, previous.to), label: previous.label },
  });
  return { day: pair(p.today, p.yesterday), week: pair(p.week, p.lastWeek), month: pair(p.month, p.lastMonth) };
}

/**
 * One machine's spending against each limit it has: today, this window, this week, this month. With a limit
 * account set, only what it spent on that account counts.
 */
export function machineLimits(db, settings, machine, now = Date.now()) {
  const p = periods(settings, now);
  const hours = Number(settings.windowHours) || 5;
  const onAccount = machine.limit_account ? `AND ${ACCOUNT} = ?` : '';
  const args = machine.limit_account ? [fallbackAccount(db), machine.limit_account] : [];
  const spent = (from) =>
    db
      .prepare(`SELECT coalesce(sum(r.cost), 0) AS cost FROM requests r JOIN machines m ON m.id = r.machine_id WHERE r.machine_id = ? AND r.ts >= ? ${onAccount}`)
      .get(machine.id, from, ...args).cost;

  // The machine's own window: from the hour of its first request after its last window closed.
  const recent = db
    .prepare(`SELECT r.ts FROM requests r JOIN machines m ON m.id = r.machine_id WHERE r.machine_id = ? AND r.ts >= ? ${onAccount} ORDER BY r.ts`)
    .all(machine.id, now - 2 * hours * HOUR, ...args);
  let windowStart = null;
  for (const { ts } of recent) {
    if (windowStart === null || ts >= windowStart + hours * HOUR) windowStart = ts - (ts % HOUR);
  }

  const windowOpen = windowStart !== null && now < windowStart + hours * HOUR;
  const list = [
    { kind: 'day', label: 'kunlik', unit: '$', limit: machine.daily_budget, spent: spent(p.today.from), resets: p.today.from + DAY },
    { kind: 'window', label: `${hours} soatlik`, unit: '$', limit: machine.limit_window, spent: windowOpen ? spent(windowStart) : 0, resets: windowOpen ? windowStart + hours * HOUR : null },
    { kind: 'week', label: 'haftalik', unit: '$', limit: machine.limit_week, spent: spent(p.week.from), resets: p.week.from + 7 * DAY },
    { kind: 'month', label: 'oylik', unit: '$', limit: machine.limit_month, spent: spent(p.month.from), resets: billingStart(p.month.from + 40 * DAY, settings.billingDay, settings.timeZone) },
    ...subscriptionLimits(db, settings, machine, now),
  ].map((item) => ({ ...item, share: item.limit > 0 ? item.spent / item.limit : null }));

  const over = list.filter((item) => item.share != null && item.share >= 1);
  return { limits: list, over, block: Boolean(machine.limit_block) && over.length > 0 };
}

/**
 * Limits in the subscription's own percentages: how much of the account's 5-hour and weekly limit this
 * machine may use (its part of Anthropic's percentage, see splitUsage). Without exact numbers it reads 0.
 */
function subscriptionLimits(db, settings, machine, now) {
  if (!(machine.limit_five_pct > 0) && !(machine.limit_week_pct > 0)) return [];
  const account = machine.limit_account ?? machine.account ?? fallbackAccount(db);
  const machines = db.prepare('SELECT id, name, color, account FROM machines').all();
  const exact = exactUsage(db, now, { machines, settings }).find((e) => e.account === account);
  const partOf = (kind) => {
    const split = exact?.split?.find((s) => s.kind === kind);
    return { spent: split?.machines.find((m) => m.id === machine.id)?.percent ?? 0, resets: split ? Date.parse(split.resetsAt) : null };
  };
  return [
    { kind: 'five_pct', label: '5 soatlik (obuna)', unit: '%', limit: machine.limit_five_pct, ...partOf('five_hour') },
    { kind: 'week_pct', label: 'haftalik (obuna)', unit: '%', limit: machine.limit_week_pct, ...partOf('seven_day') },
  ];
}

/** A limit's amount in its own unit: "$4.20" or "12.5%". */
export const limitAmount = (item, value) => (item.unit === '%' ? `${Number(value).toFixed(1)}%` : `$${Number(value).toFixed(2)}`);

// What Anthropic calls each limit, in the dashboard's words.
const LIMIT_LABELS = {
  five_hour: '5 soatlik sessiya',
  seven_day: 'Haftalik (hamma modellar)',
  seven_day_opus: 'Haftalik (Opus)',
  seven_day_sonnet: 'Haftalik (Sonnet)',
  seven_day_oauth_apps: 'Haftalik (ilovalar)',
};

export const limitLabel = (kind) => LIMIT_LABELS[kind] ?? kind.replace(/_/g, ' ');

// Anthropic gives the reset time to the microsecond and a little different each time ("06:29:59.62",
// "06:30:00.40"): to the nearest minute it is the same moment.
const toMinute = (value) => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(Math.round(ms / 60_000) * 60_000).toISOString() : null;
};

/** Keeps a report of the exact percentages a machine's agent read from Anthropic. */
export function saveExactUsage(db, machine, body, now = Date.now()) {
  const limits = (Array.isArray(body?.limits) ? body.limits : [])
    .slice(0, 20)
    .filter((l) => typeof l?.kind === 'string' && l.kind.length <= 40 && Number.isFinite(Number(l.percent)))
    .map((l) => ({ kind: l.kind, percent: Math.max(0, Math.min(1000, Number(l.percent))), resetsAt: toMinute(l.resetsAt) }));
  if (!limits.length) return null;
  const account = (typeof body.account === 'string' && body.account.slice(0, 80)) || machine.account || null;
  const email = typeof body.email === 'string' ? body.email.slice(0, 120) : null;
  // Agents report every minute: the same numbers again only move the last report's time forward.
  const text = JSON.stringify(limits);
  const last = db.prepare('SELECT id, limits FROM usage_reports WHERE machine_id = ? AND account IS ? AND ts >= ? ORDER BY ts DESC LIMIT 1').get(machine.id, account, now - 10 * 60_000);
  if (last?.limits === text) db.prepare('UPDATE usage_reports SET ts = ? WHERE id = ?').run(now, last.id);
  else db.prepare('INSERT INTO usage_reports (ts, machine_id, account, email, limits) VALUES (?, ?, ?, ?, ?)').run(now, machine.id, account, email, text);
  rememberAccount(db, account, email, now);
  db.prepare('DELETE FROM usage_reports WHERE ts < ?').run(now - 30 * DAY);
  if (account && !machine.account) db.prepare('UPDATE machines SET account = ? WHERE id = ?').run(account, machine.id);
  return { account, email, limits };
}

// How long each limit lasts, and which models count against it.
const LIMIT_SPANS = { five_hour: 5 * HOUR, seven_day: 7 * DAY, seven_day_opus: 7 * DAY, seven_day_sonnet: 7 * DAY };
const LIMIT_MODELS = { seven_day_opus: '%opus%', seven_day_sonnet: '%sonnet%' };

/** What each machine spent on the account between `from` and `to`, counting only the limit's models. */
function costByMachine(db, account, fallback, from, to, kind) {
  const model = LIMIT_MODELS[kind];
  const rows = db
    .prepare(
      `SELECT r.machine_id AS id, sum(r.cost) AS cost FROM requests r JOIN machines m ON m.id = r.machine_id
       WHERE r.ts >= ? AND r.ts < ? AND ${ACCOUNT} = ? ${model ? 'AND r.model LIKE ?' : ''}
       GROUP BY r.machine_id`,
    )
    .all(from, to, fallback, account, ...(model ? [model] : []));
  return new Map(rows.map((row) => [row.id, row.cost]));
}

const sum = (map) => [...map.values()].reduce((total, value) => total + value, 0);

/**
 * What 1% of a limit costs on the API, learned from the account's reports: in each period the last report's
 * monitored spending over its percentage, and the middle of those. Use from places the monitor does not see
 * (claude.ai, an unconnected computer) moves the percentage without the spending, so a period with such use
 * reads lower; the middle value keeps one such period from moving the rate.
 */
function ratePerPercent(db, reports, cost, kind) {
  const span = LIMIT_SPANS[kind];
  const lastOfPeriod = new Map();
  for (const report of reports) {
    const limit = report.limits.find((l) => l.kind === kind);
    const resets = limit?.resetsAt ? Date.parse(limit.resetsAt) : NaN;
    // Small shares are rounded too coarsely to divide by.
    if (!limit || !Number.isFinite(resets) || limit.percent < 5) continue;
    lastOfPeriod.set(Math.round(resets / 60_000), { ts: report.ts, from: resets - span, percent: limit.percent });
  }

  const ratios = [...lastOfPeriod.values()]
    .map((p) => sum(cost(p.from, p.ts, kind)) / p.percent)
    .filter((ratio) => ratio > 0)
    .sort((a, b) => a - b);
  if (!ratios.length) return null;
  const middle = Math.floor(ratios.length / 2);
  return ratios.length % 2 ? ratios[middle] : (ratios[middle - 1] + ratios[middle]) / 2;
}

/**
 * Each limit's percentage split between the machines that used the account since the limit's period began,
 * by what each spent on it, with the part the monitor did not see (other places on the same account) when it
 * can tell; and the billing month measured in weekly limits.
 */
function splitUsage(db, { account, limits, reports, machines, fallback, settings, now }) {
  const cost = (from, to, kind) => costByMachine(db, account, fallback, from, to, kind);
  const byId = new Map(machines.map((m) => [m.id, m]));
  const named = (costs, total, percent) =>
    [...costs]
      .map(([id, spent]) => ({ id, name: byId.get(id)?.name ?? '?', color: byId.get(id)?.color ?? '#888', cost: spent }))
      .map((m) => ({ ...m, percent: total > 0 ? (percent * m.cost) / total : 0 }))
      .sort((a, b) => b.cost - a.cost);

  const split = limits
    .filter((l) => LIMIT_SPANS[l.kind] && l.resetsAt && !l.reset)
    .map((l) => {
      const from = Date.parse(l.resetsAt) - LIMIT_SPANS[l.kind];
      const costs = cost(from, now, l.kind);
      const seen = sum(costs);
      const rate = ratePerPercent(db, reports, cost, l.kind);
      // The rate says what the seen spending is worth; the rest of the percentage came from elsewhere.
      const seenPercent = rate ? Math.min(l.percent, seen / rate) : l.percent;
      return {
        kind: l.kind,
        label: l.label,
        percent: l.percent,
        from,
        resetsAt: l.resetsAt,
        cost: seen,
        machines: named(costs, seen, seenPercent),
        others: rate ? Math.max(0, l.percent - seenPercent) : null,
      };
    });

  let month = null;
  const weekRate = ratePerPercent(db, reports, cost, 'seven_day');
  if (settings && weekRate) {
    const from = periods(settings, now).month.from;
    const to = billingStart(from + 40 * DAY, settings.billingDay, settings.timeZone);
    const costs = cost(from, now, null);
    const spent = sum(costs);
    // A month holds as many weekly limits as it has weeks.
    const weeks = (to - from) / (7 * DAY);
    const percent = spent / weekRate / weeks;
    month = { from, to, cost: spent, weeks, weekly: spent / weekRate, percent, machines: named(costs, spent, percent) };
  }

  return { split, month };
}

// How far back the pace of a limit is measured: the last hour and a half of a 5-hour session, the last day of
// a week.
const PACE_SPAN = { five_hour: 90 * 60_000 };
const PACE_SPAN_DEFAULT = DAY;

/**
 * At the pace of the recent reports in this period, when the limit runs out: { perHour, runsOutAt } with
 * runsOutAt only when that comes before the limit starts again. Null without two reports far enough apart.
 */
function forecastOf(limit, reports, now) {
  const resets = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
  if (!Number.isFinite(resets)) return null;
  const from = now - (PACE_SPAN[limit.kind] ?? PACE_SPAN_DEFAULT);
  const points = reports
    .filter((r) => r.ts >= from)
    .map((r) => ({ ts: r.ts, l: r.limits.find((x) => x.kind === limit.kind) }))
    .filter((p) => p.l && Math.abs(Date.parse(p.l.resetsAt) - resets) < 120_000);
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const hours = (last.ts - first.ts) / HOUR;
  if (hours < 10 / 60) return null;
  const perHour = Math.max(0, (last.l.percent - first.l.percent) / hours);
  const runsOutAt = perHour > 0 && limit.percent < 100 ? now + ((100 - limit.percent) / perHour) * HOUR : null;
  return { perHour, runsOutAt: runsOutAt && runsOutAt < resets ? Math.round(runsOutAt) : null };
}

/**
 * The latest exact percentages of each account (from the last six hours), with how the 5-hour and weekly
 * shares went over the last week. A limit that has reset since the report reads 0. Given the machines, each
 * limit is also split between the machines that used the account (see splitUsage).
 */
export function exactUsage(db, now = Date.now(), { machines = null, settings = null, fallback = fallbackAccount(db) } = {}) {
  const ownAccount = new Map(db.prepare('SELECT id, account FROM machines').all().map((m) => [m.id, m.account]));
  const accountOf = (row) => row.account ?? ownAccount.get(row.machineId) ?? fallback;
  const rows = db.prepare('SELECT ts, machine_id AS machineId, account, email, limits FROM usage_reports WHERE ts >= ? ORDER BY ts').all(now - 30 * DAY);
  const accounts = new Map();
  for (const row of rows) {
    const account = accountOf(row);
    const entry = accounts.get(account) ?? { account, history: [], reports: [] };
    const limits = JSON.parse(row.limits);
    entry.reports.push({ ts: row.ts, limits });
    if (row.ts >= now - 7 * DAY) {
      const labelled = limits.map((l) => ({ ...l, label: limitLabel(l.kind) }));
      entry.latest = { ts: row.ts, email: row.email, limits: labelled };
      entry.history.push({ ts: row.ts, ...Object.fromEntries(labelled.map((l) => [l.kind, l.percent])) });
    }

    accounts.set(account, entry);
  }

  return [...accounts.values()]
    .filter((entry) => entry.latest && now - entry.latest.ts < 6 * HOUR)
    .map((entry) => {
      const limits = entry.latest.limits
        .map((l) => (l.resetsAt && Date.parse(l.resetsAt) <= now ? { ...l, percent: 0, reset: true } : l))
        .map((l) => (l.reset ? l : { ...l, forecast: forecastOf(l, entry.reports, now) }));
      const result = { account: entry.account, email: entry.latest.email, ts: entry.latest.ts, limits, history: entry.history };
      if (!machines) return result;
      // A weekly limit spans more than the chart's week: its rate looks back over the month of reports.
      return { ...result, ...splitUsage(db, { account: entry.account, limits, reports: entry.reports, machines, fallback, settings, now }) };
    });
}
