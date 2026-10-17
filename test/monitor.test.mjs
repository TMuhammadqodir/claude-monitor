import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { costOf, modelLabel, priceOf } from '../src/pricing.mjs';
import { ingestLogs, ingestMetrics } from '../src/otlp.mjs';
import { importRecords } from '../src/history.mjs';
import { overview, windowsOf, statusOf } from '../src/stats.mjs';
import { newToken, machineOf } from '../src/auth.mjs';
import { dayOf, billingStart, startOfDay } from '../src/time.mjs';
import { exportCsv } from '../src/export.mjs';

function setup() {
  const db = openDb(':memory:');
  const { token, hash, hint } = newToken();
  db.prepare("INSERT INTO machines (name, token_hash, token_hint, color, created_at) VALUES ('pc', ?, ?, '#ff0000', ?)").run(hash, hint, Date.now());
  const machine = db.prepare('SELECT * FROM machines').get();
  return { db, machine, token };
}

const attr = (key, value) => ({
  key,
  value: typeof value === 'number' ? (Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }) : { stringValue: String(value) },
});

function apiRequest({ ts = Date.now(), requestId = 'req_1', cost = 0.5, model = 'claude-opus-5-5', input = 10, output = 200, session = 's1' } = {}) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [attr('service.name', 'claude-code'), attr('service.version', '2.1.300'), attr('os.type', 'windows')] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: String(BigInt(ts) * 1_000_000n),
                body: { stringValue: 'claude_code.api_request' },
                attributes: [
                  attr('event.name', 'api_request'),
                  attr('event.timestamp', new Date(ts).toISOString()),
                  attr('session.id', session),
                  attr('user.account_uuid', 'acc-1'),
                  attr('user.email', 'a@b.uz'),
                  attr('terminal.type', 'vscode'),
                  attr('model', model),
                  attr('cost_usd', cost),
                  attr('duration_ms', 1200),
                  attr('input_tokens', input),
                  attr('output_tokens', output),
                  attr('cache_read_tokens', 1000),
                  attr('cache_creation_tokens', 50),
                  attr('request_id', requestId),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

test('prices follow the models', () => {
  assert.equal(priceOf('claude-opus-5-5').output, 20);
  assert.equal(priceOf('claude-sonnet-4-5-20250929').input, 3);
  assert.equal(priceOf('claude-3-5-haiku-20241022').input, 0.8);
  assert.equal(priceOf('gpt-4'), null);
  // 1M output tokens of Opus 5.5 cost $20; fast mode doubles it.
  assert.equal(costOf({ model: 'claude-opus-5-5', output: 1_000_000 }), 20);
  assert.equal(costOf({ model: 'claude-opus-5-5', output: 1_000_000, speed: 'fast' }), 40);
  // A 1-hour cache write costs more than a 5-minute one.
  assert.equal(costOf({ model: 'claude-opus-5-5', cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 }), 8);
  assert.equal(costOf({ model: 'claude-opus-5-5', cacheWrite: 1_000_000 }), 5);
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('claude-opus-4-20250514'), 'Opus 4');
  assert.equal(modelLabel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
});

test('a token finds its machine, a wrong one finds none', () => {
  const { db, token } = setup();
  assert.equal(machineOf(db, `Bearer ${token}`).name, 'pc');
  assert.equal(machineOf(db, 'Bearer cm_wrong'), null);
  assert.equal(machineOf(db, undefined), null);
});

test('an API request event is stored once with its cost and the machine is described', () => {
  const { db, machine } = setup();
  ingestLogs(db, machine, apiRequest());
  ingestLogs(db, machine, apiRequest());
  const rows = db.prepare('SELECT * FROM requests').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost, 0.5);
  assert.equal(rows[0].output, 200);
  assert.equal(rows[0].cache_read, 1000);
  const m = db.prepare('SELECT * FROM machines').get();
  assert.equal(m.os, 'windows');
  assert.equal(m.version, '2.1.300');
  assert.equal(m.terminal, 'vscode');
  assert.equal(m.account, 'acc-1');
  assert.ok(m.last_seen_at > 0);
});

test('history from the logs is not counted twice with telemetry', () => {
  const { db, machine } = setup();
  ingestLogs(db, machine, apiRequest({ requestId: 'req_A' }));
  const result = importRecords(db, machine, [
    { ts: new Date().toISOString(), requestId: 'req_A', model: 'claude-opus-5-5', input: 10, output: 200 },
    { ts: new Date().toISOString(), requestId: 'req_B', model: 'claude-opus-5-5', input: 0, output: 1_000_000 },
    { ts: new Date().toISOString(), requestId: 'req_C', model: 'claude-opus-5-5', input: 0, output: 0 },
    { ts: 'not a date', requestId: 'req_D', model: 'x', output: 5 },
  ]);
  assert.deepEqual(result, { added: 1, skipped: 3 });
  const b = db.prepare("SELECT cost FROM requests WHERE request_id = 'req_B'").get();
  assert.equal(b.cost, 20);
});

test('a 429 is reported as a reached limit', () => {
  const { db, machine } = setup();
  const hits = [];
  ingestLogs(
    db,
    machine,
    {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [attr('event.name', 'api_error'), attr('status_code', '429'), attr('error', 'rate_limit_error'), attr('model', 'claude-opus-5-5')],
                },
              ],
            },
          ],
        },
      ],
    },
    { onLimit: (m, hit) => hits.push(hit) },
  );
  assert.equal(hits.length, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'api_error'").get().n, 1);
});

test('cumulative metrics count only what grew', () => {
  const { db, machine } = setup();
  const payload = (value) => ({
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.lines_of_code.count',
                sum: {
                  aggregationTemporality: 2,
                  dataPoints: [{ startTimeUnixNano: '1000000000', timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), asInt: String(value), attributes: [attr('type', 'added')] }],
                },
              },
            ],
          },
        ],
      },
    ],
  });
  ingestMetrics(db, machine, payload(10), { timeZone: 'UTC' });
  ingestMetrics(db, machine, payload(10), { timeZone: 'UTC' });
  ingestMetrics(db, machine, payload(25), { timeZone: 'UTC' });
  assert.equal(db.prepare("SELECT sum(value) AS v FROM counters WHERE metric = 'lines'").get().v, 25);
});

test('delta metrics are added as they come', () => {
  const { db, machine } = setup();
  const payload = (value) => ({
    resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'claude_code.commit.count', sum: { aggregationTemporality: 1, dataPoints: [{ asInt: String(value), timeUnixNano: String(BigInt(Date.now()) * 1_000_000n) }] } }] }] }],
  });
  ingestMetrics(db, machine, payload(1), { timeZone: 'UTC' });
  ingestMetrics(db, machine, payload(2), { timeZone: 'UTC' });
  assert.equal(db.prepare("SELECT sum(value) AS v FROM counters WHERE metric = 'commits'").get().v, 3);
});

test('a 5-hour window starts at the hour of its first request', () => {
  const { db, machine } = setup();
  const hour = 3_600_000;
  const base = Date.UTC(2026, 9, 17, 10, 20);
  for (const [i, ts] of [base, base + hour, base + 6 * hour].entries()) {
    ingestLogs(db, machine, apiRequest({ ts, requestId: `r${i}`, cost: 1 }));
  }

  const windows = windowsOf(db, base + 6 * hour + 1000, 5, 'acc');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].start, Date.UTC(2026, 9, 17, 16, 0));
  assert.equal(windows[0].cost, 1);
  assert.equal(windows[0].open, true);
});

test('the overview adds up the machines', () => {
  const { db, machine } = setup();
  ingestLogs(db, machine, apiRequest({ requestId: 'x1', cost: 2 }));
  ingestLogs(db, machine, apiRequest({ requestId: 'x2', cost: 3, session: 's2' }));
  const data = overview(db, { timeZone: 'Asia/Tashkent', billingDay: '1', planPrice: '200', planName: 'Max', windowHours: '5', usdToUzs: '12700', chartDays: '30' });
  assert.equal(data.totals.today.cost, 5);
  assert.equal(data.totals.today.sessions, 2);
  assert.equal(data.machines[0].today.cost, 5);
  assert.equal(data.machines[0].status, 'active');
  assert.equal(data.plan.multiple, 5 / 200);
  assert.equal(data.daily.length, 30);
  assert.equal(data.daily.at(-1).cost, 5);
  assert.equal(data.accounts.length, 1);
  assert.equal(data.accounts[0].window.cost, 5);
});

test('status follows the last activity', () => {
  const now = Date.now();
  assert.equal(statusOf({ last_seen_at: null }, null, now), 'never');
  assert.equal(statusOf({ last_seen_at: now - 60_000 }, now - 60_000, now), 'active');
  assert.equal(statusOf({ last_seen_at: now - 5 * 60_000 }, null, now), 'online');
  assert.equal(statusOf({ last_seen_at: now - 3_600_000 }, null, now), 'idle');
  assert.equal(statusOf({ last_seen_at: now - 3 * 86_400_000 }, null, now), 'offline');
  assert.equal(statusOf({ last_seen_at: now, disabled: 1 }, now, now), 'disabled');
});

test('days and the billing month are in the chosen zone', () => {
  // 21:00 UTC on the 16th is already the 17th in Tashkent (UTC+5).
  const t = Date.UTC(2026, 9, 16, 21, 0);
  assert.equal(dayOf(t, 'Asia/Tashkent'), '2026-10-17');
  assert.equal(startOfDay(t, 'Asia/Tashkent'), Date.UTC(2026, 9, 16, 19, 0));
  assert.equal(billingStart(t, 20, 'Asia/Tashkent'), Date.UTC(2026, 8, 19, 19, 0));
  assert.equal(billingStart(t, 1, 'UTC'), Date.UTC(2026, 9, 1));
});

test('the CSV keeps formulas out of spreadsheets', () => {
  const { db, machine } = setup();
  db.prepare("UPDATE machines SET name = '=HYPERLINK(1)' WHERE id = ?").run(machine.id);
  ingestLogs(db, machine, apiRequest({ requestId: 'csv' }));
  const csv = exportCsv(db, 0, 'UTC');
  assert.match(csv, /'=HYPERLINK\(1\)/);
  assert.equal(csv.trim().split('\r\n').length, 2);
});

import { breakdown, windowHistory, machineLimits, periods } from '../src/usage.mjs';

test('tokens split by kind and model, overall and per machine', () => {
  const { db, machine } = setup();
  ingestLogs(db, machine, apiRequest({ requestId: 'a', model: 'claude-opus-5-5', input: 10, output: 100, cost: 1 }));
  ingestLogs(db, machine, apiRequest({ requestId: 'b', model: 'claude-haiku-5-5', input: 5, output: 7, cost: 0.1 }));
  const result = breakdown(db, 0, Date.now() + 1000);
  assert.equal(result.models.length, 2);
  assert.equal(result.models[0].label, 'Opus 5.5');
  assert.equal(result.models[0].output, 100);
  assert.equal(result.models[1].input, 5);
  assert.equal(result.totals.output, 107);
  assert.equal(result.machines[0].models.length, 2);
  assert.equal(result.machines[0].cost, 1.1);
});

test('each 5-hour window is measured against the seen limit, or the biggest window', () => {
  const { db, machine } = setup();
  const hour = 3_600_000;
  const base = Date.now() - 20 * hour;
  ingestLogs(db, machine, apiRequest({ ts: base, requestId: 'w1', cost: 4 }));
  ingestLogs(db, machine, apiRequest({ ts: base + 6 * hour, requestId: 'w2', cost: 2 }));
  const windows = windowHistory(db, { hours: 5, days: 7, fallback: 'acc' });
  assert.equal(windows.length, 2);
  assert.equal(windows[0].cost, 2);
  assert.equal(windows[0].share, 0.5);
  assert.equal(windows[0].basis, 'biggest');
  const limited = windowHistory(db, { hours: 5, days: 7, fallback: 'acc', limits: new Map([['acc-1', 8]]) });
  assert.equal(limited[1].share, 0.5);
  assert.equal(limited[1].basis, 'limit');
});

test('a machine over a limit is stopped only when it is set to be', () => {
  const { db, machine } = setup();
  const settings = { timeZone: 'UTC', billingDay: '1', windowHours: '5' };
  ingestLogs(db, machine, apiRequest({ requestId: 'l1', cost: 3 }));
  db.prepare('UPDATE machines SET daily_budget = 2, limit_week = 10 WHERE id = ?').run(machine.id);
  let state = machineLimits(db, settings, db.prepare('SELECT * FROM machines').get());
  assert.equal(state.over.length, 1);
  assert.equal(state.over[0].kind, 'day');
  assert.equal(state.block, false);
  assert.equal(state.limits.find((l) => l.kind === 'week').share, 0.3);
  assert.equal(state.limits.find((l) => l.kind === 'window').spent, 3);
  db.prepare('UPDATE machines SET limit_block = 1 WHERE id = ?').run(machine.id);
  state = machineLimits(db, settings, db.prepare('SELECT * FROM machines').get());
  assert.equal(state.block, true);
});

test('last week and last month end where this week and month begin', () => {
  const p = periods({ timeZone: 'Asia/Tashkent', billingDay: '5' }, Date.UTC(2026, 9, 17, 3));
  assert.equal(p.lastWeek.to, p.week.from);
  assert.equal(p.week.from - p.lastWeek.from, 7 * 86_400_000);
  assert.equal(p.lastMonth.to, p.month.from);
  assert.equal(p.yesterday.to, p.today.from);
});

import { saveExactUsage, exactUsage, limitAmount } from '../src/usage.mjs';

test('exact percentages are kept per account and a reset limit reads 0', () => {
  const { db, machine } = setup();
  const now = Date.now();
  const soon = new Date(now + 3_600_000).toISOString();
  const past = new Date(now - 60_000).toISOString();
  const saved = saveExactUsage(db, machine, {
    account: 'acc-9',
    email: 'a@b.uz',
    limits: [
      { kind: 'five_hour', percent: 42, resetsAt: soon },
      { kind: 'seven_day', percent: 12.5, resetsAt: past },
      { kind: 'bad', percent: 'x' },
    ],
  }, now);
  assert.equal(saved.limits.length, 2);
  assert.equal(db.prepare('SELECT account FROM machines').get().account, 'acc-9');
  const [account] = exactUsage(db, now);
  assert.equal(account.email, 'a@b.uz');
  assert.equal(account.limits[0].label, '5 soatlik sessiya');
  assert.equal(account.limits[0].percent, 42);
  assert.equal(account.limits[1].percent, 0);
  assert.equal(account.limits[1].reset, true);
  assert.equal(saveExactUsage(db, machine, { limits: [] }), null);
});

test('each limit is split between the machines, with what the monitor did not see', () => {
  const { db, machine } = setup();
  const now = Date.now();
  const HOUR = 3_600_000;
  db.prepare("INSERT INTO machines (name, token_hash, token_hint, color, created_at, account) VALUES ('pc2', 'h2', 'x', '#00ff00', ?, 'acc-1')").run(now);
  db.prepare("UPDATE machines SET account = 'acc-1' WHERE id = ?").run(machine.id);
  const other = db.prepare("SELECT * FROM machines WHERE name = 'pc2'").get();
  const spend = (id, ts, cost) =>
    db.prepare("INSERT INTO requests (machine_id, ts, model, cost, origin) VALUES (?, ?, 'claude-opus-5-5', ?, 'test')").run(id, ts, cost);
  const report = (ts, percent, resetsAt) =>
    saveExactUsage(db, db.prepare('SELECT * FROM machines WHERE id = ?').get(machine.id), { account: 'acc-1', limits: [{ kind: 'five_hour', percent, resetsAt: new Date(resetsAt).toISOString() }] }, ts);

  // Three earlier windows, all seen: 1% cost $0.10 in each.
  for (const back of [18, 13, 8]) {
    spend(machine.id, now - back * HOUR + 60_000, 2);
    report(now - (back - 4) * HOUR, 20, now - (back - 5) * HOUR);
  }

  // This window: $3 and $1 seen, 50% used, so 10% came from elsewhere.
  spend(machine.id, now - 2 * HOUR, 3);
  spend(other.id, now - HOUR, 1);
  report(now, 50, now + 2 * HOUR);

  const machines = db.prepare('SELECT * FROM machines').all();
  const [account] = exactUsage(db, now, { machines, settings: { timeZone: 'Asia/Tashkent', billingDay: '1' } });
  const session = account.split.find((s) => s.kind === 'five_hour');
  assert.equal(session.cost, 4);
  assert.equal(Math.round(session.machines.find((m) => m.name === 'pc').percent), 30);
  assert.equal(Math.round(session.machines.find((m) => m.name === 'pc2').percent), 10);
  assert.equal(Math.round(session.others), 10);
  // No weekly report yet, so no month in weekly limits.
  assert.equal(account.month, null);
});

test('the month is measured in weekly limits and split between the machines', () => {
  const { db, machine } = setup();
  const now = Date.now();
  db.prepare("INSERT INTO requests (machine_id, ts, model, cost, origin) VALUES (?, ?, 'claude-opus-5-5', 10, 'test')").run(machine.id, now - 60_000);
  saveExactUsage(db, machine, { account: 'acc-2', limits: [{ kind: 'seven_day', percent: 10, resetsAt: new Date(now + 3 * 86_400_000).toISOString() }] }, now);
  const machines = db.prepare('SELECT * FROM machines').all();
  const [account] = exactUsage(db, now, { machines, settings: { timeZone: 'Asia/Tashkent', billingDay: String(new Date(now).getUTCDate()) } });
  // $10 is 10% of a week; a month of w weeks holds w weekly limits.
  assert.equal(Math.round(account.month.weekly), 10);
  assert.ok(Math.abs(account.month.percent - 10 / account.month.weeks) < 1e-9);
  assert.equal(account.month.machines[0].percent, account.month.percent);
});

test('one computer on two accounts: each request counts against its own account', () => {
  const { db, machine } = setup();
  const now = Date.now();
  const event = (requestId, account, cost) => {
    const payload = apiRequest({ ts: now - 60_000, requestId, cost });
    const attrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    attrs.find((a) => a.key === 'user.account_uuid').value = { stringValue: account };
    attrs.find((a) => a.key === 'user.email').value = { stringValue: `${account}@x.uz` };
    return payload;
  };
  ingestLogs(db, machine, event('a1', 'mine', 3));
  ingestLogs(db, machine, event('a2', 'friend', 5));
  saveExactUsage(db, machine, { account: 'mine', limits: [{ kind: 'five_hour', percent: 30, resetsAt: new Date(now + 3_600_000).toISOString() }] }, now);

  const data = overview(db, { timeZone: 'Asia/Tashkent', billingDay: '1', windowHours: '5', planPrice: '200' }, now);
  const mine = data.accounts.find((a) => a.account === 'mine');
  const friend = data.accounts.find((a) => a.account === 'friend');
  assert.equal(mine.week, 3);
  assert.equal(friend.week, 5);
  assert.equal(friend.email, 'friend@x.uz');
  assert.equal(mine.window.cost, 3);
  // Only the $3 on "mine" shares its 30%.
  assert.equal(mine.exact.split[0].cost, 3);
  assert.equal(mine.exact.split[0].machines[0].percent, 30);
  assert.deepEqual(data.machines[0].accounts.map((a) => [a.account, a.cost]), [['friend', 5], ['mine', 3]]);
});

import { offsetOf } from '../src/time.mjs';

test('a day begins at local midnight in half-hour zones too', () => {
  const noon = Date.UTC(2026, 9, 17, 12);
  assert.equal(offsetOf(noon, 'Asia/Kolkata'), 330);
  assert.equal(startOfDay(noon, 'Asia/Kolkata'), Date.UTC(2026, 9, 16, 18, 30));
  assert.equal(startOfDay(noon, 'Asia/Tashkent'), Date.UTC(2026, 9, 16, 19));
});

test('the same percentages a minute later move the last report instead of adding one', () => {
  const { db, machine } = setup();
  const now = Date.now();
  const body = (percent, reset) => ({ account: 'a', limits: [{ kind: 'five_hour', percent, resetsAt: reset }] });
  saveExactUsage(db, machine, body(40, '2026-10-17T06:29:59.621506+00:00'), now);
  saveExactUsage(db, machine, body(40, '2026-10-17T06:30:00.404171+00:00'), now + 60_000);
  assert.equal(db.prepare('SELECT count(*) AS n FROM usage_reports').get().n, 1);
  assert.equal(db.prepare('SELECT ts FROM usage_reports').get().ts, now + 60_000);
  saveExactUsage(db, machine, body(41, '2026-10-17T06:30:00Z'), now + 120_000);
  assert.equal(db.prepare('SELECT count(*) AS n FROM usage_reports').get().n, 2);
});

test('a paused machine is stopped, and a share of the subscription can be its limit', () => {
  const { db, machine } = setup();
  const now = Date.now();
  const settings = { timeZone: 'Asia/Tashkent', billingDay: '1', windowHours: '5' };
  db.prepare("INSERT INTO requests (machine_id, ts, model, cost, account, origin) VALUES (?, ?, 'claude-opus-5-5', 4, 'acc', 'test')").run(machine.id, now - 60_000);
  db.prepare("UPDATE machines SET account = 'acc', limit_five_pct = 30, limit_block = 1 WHERE id = ?").run(machine.id);
  saveExactUsage(db, machine, { account: 'acc', limits: [{ kind: 'five_hour', percent: 40, resetsAt: new Date(now + 3_600_000).toISOString() }] }, now);
  const state = machineLimits(db, settings, db.prepare('SELECT * FROM machines').get(), now);
  const five = state.limits.find((l) => l.kind === 'five_pct');
  // The only machine on the account used all of its 40%: over a 30% limit.
  assert.equal(Math.round(five.spent), 40);
  assert.equal(five.unit, '%');
  assert.equal(state.block, true);
  assert.equal(limitAmount(five, five.spent), '40.0%');
});

test('the pace of the reports says when a limit runs out before it resets', () => {
  const { db, machine } = setup();
  const now = Date.now();
  const resetsAt = new Date(now + 2 * 3_600_000).toISOString();
  const week = new Date(now + 3 * 86_400_000).toISOString();
  // 60% to 80% in the last hour: 20 points an hour, 20 left, so out in about an hour (before the reset).
  saveExactUsage(db, machine, { account: 'a', limits: [{ kind: 'five_hour', percent: 60, resetsAt }, { kind: 'seven_day', percent: 50, resetsAt: week }] }, now - 3_600_000);
  saveExactUsage(db, machine, { account: 'a', limits: [{ kind: 'five_hour', percent: 80, resetsAt }, { kind: 'seven_day', percent: 50, resetsAt: week }] }, now);
  const [account] = exactUsage(db, now);
  const five = account.limits.find((l) => l.kind === 'five_hour');
  assert.equal(Math.round(five.forecast.perHour), 20);
  assert.ok(Math.abs(five.forecast.runsOutAt - (now + 3_600_000)) < 60_000);
  // The week did not move: no running out.
  assert.equal(account.limits.find((l) => l.kind === 'seven_day').forecast.runsOutAt, null);
});

import { sharedView } from '../src/stats.mjs';

test('a share link shows the machine its own usage and part, not the other machines', () => {
  const { db, machine } = setup();
  const now = Date.now();
  db.prepare("INSERT INTO machines (name, token_hash, token_hint, color, created_at, account) VALUES ('other', 'h9', 'x', '#00f', ?, 'acc')").run(now);
  db.prepare("UPDATE machines SET account = 'acc' WHERE id = ?").run(machine.id);
  const other = db.prepare("SELECT id FROM machines WHERE name = 'other'").get().id;
  const spend = (id, cost) => db.prepare("INSERT INTO requests (machine_id, ts, model, cost, account, origin) VALUES (?, ?, 'claude-opus-5-5', ?, 'acc', 'test')").run(id, now - 60_000, cost);
  spend(machine.id, 1);
  spend(other, 3);
  saveExactUsage(db, machine, { account: 'acc', limits: [{ kind: 'five_hour', percent: 40, resetsAt: new Date(now + 3_600_000).toISOString() }] }, now);
  const view = sharedView(db, { timeZone: 'Asia/Tashkent', billingDay: '1', windowHours: '5' }, db.prepare('SELECT * FROM machines WHERE id = ?').get(machine.id), now);
  assert.equal(view.totals.today.cost, 1);
  const five = view.shares[0].limits[0];
  assert.equal(five.total, 40);
  assert.equal(Math.round(five.mine), 10);
  assert.equal(JSON.stringify(view).includes('other'), false);
});
