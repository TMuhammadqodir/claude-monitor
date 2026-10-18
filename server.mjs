#!/usr/bin/env node
// Claude Monitor: one server that every computer's Claude Code reports to, and the dashboard that shows it.
//   node server.mjs                     (port 4318, data in ./data/monitor.db)
//   PORT=8080 DATA=/srv/monitor.db node server.mjs

import { createServer } from 'node:http';
import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getSettings, keepPrivate, prune, setSetting } from './src/db.mjs';
import { ingestLogs, ingestMetrics } from './src/otlp.mjs';
import { importRecords } from './src/history.mjs';
import { overview, recentRequests, sessions, machineDetail, sharedView } from './src/stats.mjs';
import { COOKIE, allowAttempt, checkPassword, endSession, hasPassword, isSignedIn, machineOf, newSession, newToken, presentedHash, setPassword } from './src/auth.mjs';
import { checkBudgets, checkPolicy, raise, recordLimit, sendTelegram } from './src/alerts.mjs';
import { EFFORTS, MODEL_FAMILIES, parseModels, policyOf } from './src/policy.mjs';
import { exportCsv } from './src/export.mjs';
import { LANGUAGES, limitName, msg, when } from './src/messages.mjs';
import { accountEmails, breakdown, comparisons, exactUsage, fallbackAccount, limitAmount, limitLabel, machineLimits, mayUseAccount, periods, saveExactUsage, windowHistory } from './src/usage.mjs';
import { clientAddress } from './src/net.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 4318;
const HOST = process.env.HOST || '0.0.0.0';
const DATA = process.env.DATA || join(ROOT, 'data', 'monitor.db');
const db = openDb(DATA);
const MAX_BODY = 20 * 1024 * 1024;
const COLORS = ['#ff7a45', '#36cfc9', '#9254de', '#fadb14', '#52c41a', '#f759ab', '#40a9ff', '#ffa940', '#73d13d', '#b37feb', '#ff4d4f', '#13c2c2'];

// The dashboards listening for new requests (server-sent events): a few open tabs, not an unbounded number.
const listeners = new Set();
const MAX_LISTENERS = 50;

function broadcast(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of listeners) {
    // A dashboard that stopped reading (asleep, a dead link) is let go instead of piling up its messages here.
    if (response.writableLength > 1024 * 1024) {
      listeners.delete(response);
      response.destroy();
      continue;
    }

    response.write(message);
  }
}

function send(response, status, body, headers = {}) {
  const json = typeof body !== 'string';
  response.writeHead(status, {
    'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(json ? JSON.stringify(body) : body);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) {
      throw Object.assign(new Error('too large'), { status: 413 });
    }

    chunks.push(chunk);
  }

  let buffer = Buffer.concat(chunks);
  if (/gzip/i.test(request.headers['content-encoding'] ?? '')) {
    // A small gzip can unpack to gigabytes: it is unpacked only up to a limit.
    try {
      buffer = gunzipSync(buffer, { maxOutputLength: 5 * MAX_BODY });
    } catch {
      throw Object.assign(new Error('bad gzip or too large'), { status: 413 });
    }
  }

  return buffer;
}

async function readJson(request) {
  const buffer = await readBody(request);
  if (buffer.length === 0) {
    return {};
  }

  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw Object.assign(new Error('bad json'), { status: 400 });
  }
}

// Behind a proxy (Caddy, Nginx) set TRUST_PROXY=1 to take the address it passes on (see clientAddress);
// without one anybody could write any address there and get round the limit on password attempts.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ipOf = (request) => clientAddress(request.headers['x-forwarded-for'], request.socket.remoteAddress, TRUST_PROXY);

// The session cookie is marked Secure when the dashboard is reached over HTTPS: directly, through a trusted
// proxy that says so, or always with COOKIE_SECURE=1.
const isHttps = (request) =>
  process.env.COOKIE_SECURE === '1' ||
  Boolean(request.socket.encrypted) ||
  (TRUST_PROXY && /^https$/i.test(String(request.headers['x-forwarded-proto'] ?? '').split(',').pop().trim()));
const cookieFlags = (request) => `Path=/; HttpOnly; SameSite=Strict${isHttps(request) ? '; Secure' : ''}`;

// Unknown tokens are told about once a day per address, and at most this many a day in all: scanners on the
// internet (or one changing its IPv6 address) do not fill the alerts or the owner's Telegram.
const UNKNOWN_TOKEN_ALERTS = 5;

// Until the owner sets a password, setting it needs the code printed in this server's console: whoever reaches
// the server first over the network cannot take the dashboard.
const setupCode = randomBytes(4).toString('hex');

const STATIC = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

async function serveStatic(response, path) {
  const publicDir = resolve(ROOT, 'public');
  const file = resolve(publicDir, '.' + (path === '/' ? '/index.html' : path));
  if (!file.startsWith(publicDir)) {
    return send(response, 404, 'Not found');
  }

  try {
    const content = await readFile(file);
    response.writeHead(200, {
      'content-type': STATIC[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    });
    response.end(content);
  } catch {
    send(response, 404, 'Not found');
  }
}

/**
 * Refuses a request whose token names no machine. A computer still sending a token replaced by "new token"
 * is told about on the dashboard (once a day), so a machine that went quiet is not a mystery; so is a token
 * nobody knows, once a day per address. A stopped machine's own token is refused silently: that was meant.
 */
function refuse(request, response) {
  const presented = presentedHash(request.headers.authorization);
  if (presented) {
    const day = new Date().toISOString().slice(0, 10);
    const stale = db.prepare('SELECT id, name FROM machines WHERE old_token_hash = ?').get(presented);
    const stopped = db.prepare('SELECT 1 FROM machines WHERE token_hash = ? AND disabled = 1').get(presented);
    if (stale) {
      raise(db, {
        machineId: stale.id,
        kind: 'token',
        message: msg(getSettings(db), 'staleToken', { name: stale.name, ip: ipOf(request) }),
        key: `stale:${stale.id}:${day}`,
      });
      broadcast('machines', stale.id);
    } else if (!stopped) {
      const today = db.prepare("SELECT count(*) AS n FROM alerts WHERE key LIKE 'unknown:%' AND key LIKE ?").get(`%:${day}`).n;
      if (today < UNKNOWN_TOKEN_ALERTS) {
        raise(db, {
          kind: 'token',
          message: msg(getSettings(db), 'unknownToken', { ip: ipOf(request) }),
          key: `unknown:${ipOf(request)}:${day}`,
        });
      } else {
        raise(db, { kind: 'token', message: msg(getSettings(db), 'manyUnknownTokens'), key: `unknown-many:${day}` });
      }
    }
  }

  return send(response, 401, { error: 'token' });
}

// The OpenTelemetry receiver: Claude Code sends here with its machine's token.
async function receiveOtlp(request, response, kind) {
  const machine = machineOf(db, request.headers.authorization);
  if (!machine) {
    return refuse(request, response);
  }

  if (/protobuf/i.test(request.headers['content-type'] ?? '')) {
    return send(response, 415, { error: 'Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json' });
  }

  const payload = await readJson(request);
  // MONITOR_DUMP=file keeps every payload as it came, to see what a Claude Code version sends.
  if (process.env.MONITOR_DUMP) {
    await appendFile(process.env.MONITOR_DUMP, JSON.stringify({ kind, machine: machine.name, payload }) + '\n');
  }

  const firstContact = !machine.last_seen_at;
  const options = { ip: ipOf(request), timeZone: getSettings(db).timeZone };
  if (kind === 'logs') {
    const { requests } = ingestLogs(db, machine, payload, { ...options, onLimit: (m, hit) => recordLimit(db, m, hit) });
    if (requests.length > 0) {
      checkBudgets(db, [machine.id]);
      checkPolicy(db, machine, requests);
      broadcast('requests', requests.length);
    }
  } else if (kind === 'metrics') {
    ingestMetrics(db, machine, payload, options);
  }

  if (firstContact) {
    raise(db, { machineId: machine.id, kind: 'new', message: msg(getSettings(db), 'firstContact', { name: machine.name }), key: `first:${machine.id}` });
    broadcast('machines', machine.id);
  }

  // An empty partial-success answer: everything was taken.
  send(response, 200, {});
}

async function api(request, response, url) {
  const { pathname } = url;
  const method = request.method;

  // History from a machine's own Claude Code logs, sent by agent.mjs with the machine's token.
  if (pathname === '/api/import' && method === 'POST') {
    const machine = machineOf(db, request.headers.authorization);
    if (!machine) return refuse(request, response);
    const body = await readJson(request);
    const result = importRecords(db, machine, body.records ?? [], { ip: ipOf(request), meta: body.machine });
    if (result.added > 0) broadcast('requests', result.added);
    return send(response, 200, result);
  }

  // Asked by the agent's prompt hook before each prompt: may this machine go on?
  if (pathname === '/api/gate' && method === 'GET') {
    const machine = machineOf(db, request.headers.authorization);
    if (!machine) return refuse(request, response);
    // Stopped from the dashboard: nothing runs until it is let go.
    const settings = getSettings(db);
    // Which models and effort the machine may use: the agent writes them into Claude Code's settings.
    const policy = policyOf(machine);
    if (machine.paused) return send(response, 200, { allowed: false, reason: 'paused', paused: true, message: msg(settings, 'paused'), limits: [], policy });
    const { limits, over, block } = machineLimits(db, settings, machine);
    // A limit set for one account does not stop work on another: the agent says which account is in use,
    // else the machine's last request does.
    // The account the agent names counts only when it is one this machine is known to use.
    const named = url.searchParams.get('account');
    const inUse =
      (named && mayUseAccount(db, machine.id, named) ? named : null) ||
      db.prepare('SELECT account FROM requests WHERE machine_id = ? AND account IS NOT NULL ORDER BY ts DESC LIMIT 1').get(machine.id)?.account ||
      null;
    const stops = block && !(machine.limit_account && inUse && inUse !== machine.limit_account);
    const reason = over.map((item) => `${limitName(settings, item.label)}: ${limitAmount(item, item.spent)} / ${limitAmount(item, item.limit)}`).join(', ');
    return send(response, 200, { allowed: !stops, reason: stops ? reason : null, message: stops ? msg(settings, 'overLimit', { reason }) : null, limits, policy });
  }

  // The subscription's exact percentages, read by a machine's agent from Anthropic (only the numbers).
  if (pathname === '/api/limits' && method === 'POST') {
    const machine = machineOf(db, request.headers.authorization);
    if (!machine) return refuse(request, response);
    const body = await readJson(request);
    // The agent reporting is the machine being here, even before its next request.
    db.prepare('UPDATE machines SET last_seen_at = ?, last_ip = ? WHERE id = ?').run(Date.now(), ipOf(request), machine.id);
    // Another account's numbers are not this machine's to give (until its own telemetry shows it working there).
    if (typeof body?.account === 'string' && !mayUseAccount(db, machine.id, body.account.slice(0, 80))) return send(response, 403, { error: 'account' });
    const saved = saveExactUsage(db, machine, body);
    if (!saved) return send(response, 400, { error: 'limits' });
    for (const limit of saved.limits) {
      if (limit.percent >= 90) {
        raise(db, {
          machineId: machine.id,
          kind: 'limit',
          message: msg(getSettings(db), 'exactHigh', { who: saved.email ?? machine.name, limit: limitName(getSettings(db), limitLabel(limit.kind)), percent: Math.round(limit.percent), reset: limit.resetsAt ? msg(getSettings(db), 'exactReset', { when: when(getSettings(db), Date.parse(limit.resetsAt)) }) : '' }),
          key: `exact:${saved.account}:${limit.kind}:${limit.resetsAt}`,
        });
      }
    }

    broadcast('machines', machine.id);
    return send(response, 200, { ok: true });
  }

  // One machine's own page, opened with its share link and no password: only its usage and limits.
  const shareMatch = /^\/api\/share\/([A-Za-z0-9_-]{20,})$/.exec(pathname);
  if (shareMatch && method === 'GET') {
    const machine = db.prepare('SELECT * FROM machines WHERE share_token = ?').get(shareMatch[1]);
    // A machine turned off on the dashboard has no page either.
    if (!machine || machine.disabled) return send(response, 404, { error: 'share' });
    return send(response, 200, sharedView(db, getSettings(db), machine));
  }

  if (pathname === '/api/state' && method === 'GET') {
    return send(response, 200, { hasPassword: hasPassword(db), signedIn: isSignedIn(db, request.headers.cookie) });
  }

  if (pathname === '/api/setup' && method === 'POST') {
    if (hasPassword(db)) return send(response, 409, { error: 'already set' });
    if (!allowAttempt(ipOf(request))) return send(response, 429, { error: 'wait' });
    const { password, code } = await readJson(request);
    if (String(code ?? '').trim().toLowerCase() !== setupCode) return send(response, 403, { error: 'code' });
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) return send(response, 400, { error: 'password' });
    await setPassword(db, password);
    return signIn(request, response);
  }

  if (pathname === '/api/login' && method === 'POST') {
    if (!allowAttempt(ipOf(request))) return send(response, 429, { error: 'wait' });
    const { password } = await readJson(request);
    if (!(await checkPassword(db, password))) return send(response, 401, { error: 'password' });
    return signIn(request, response);
  }

  if (pathname === '/api/logout' && method === 'POST') {
    endSession(db, request.headers.cookie);
    return send(response, 200, {}, { 'set-cookie': `${COOKIE}=; ${cookieFlags(request)}; Max-Age=0` });
  }

  // Everything else is the owner's.
  if (!isSignedIn(db, request.headers.cookie)) {
    return send(response, 401, { error: 'signin' });
  }

  // A change must come from the dashboard itself (a form on another site cannot send JSON with this header).
  if (method !== 'GET' && request.headers['x-monitor'] !== '1') {
    return send(response, 403, { error: 'csrf' });
  }

  const settings = getSettings(db);

  if (pathname === '/api/overview' && method === 'GET') {
    return send(response, 200, overview(db, settings));
  }

  if (pathname === '/api/usage' && method === 'GET') {
    const all = periods(settings);
    const name = url.searchParams.get('period') ?? 'month';
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    const period = from && to ? { from, to, label: 'Tanlangan' } : all[name] ?? all.month;
    return send(response, 200, { ...breakdown(db, period.from, period.to), label: period.label, period: name });
  }

  if (pathname === '/api/windows' && method === 'GET') {
    const machines = db.prepare('SELECT id, name, color, account FROM machines').all();
    const fallback = fallbackAccount(db);
    // The limit seen at an account's last 429, to say how much of it a window used.
    const limits = new Map();
    for (const hit of db.prepare('SELECT account, window_cost FROM limit_hits ORDER BY ts').all()) {
      if (hit.window_cost > 0) limits.set(hit.account ?? fallback, hit.window_cost);
    }

    const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 7));
    const hours = Number(settings.windowHours) || 5;
    const exact = exactUsage(db, Date.now(), { machines, settings, fallback });
    const exactLimits = new Map();
    for (const account of exact) {
      const session = account.limits.find((l) => l.kind === 'five_hour');
      const open = windowHistory(db, { hours, days: 1, fallback }).find((w) => w.account === account.account && w.open);
      // Only from a share big enough to measure: 3% of a window is too little to scale from.
      if (session && !session.reset && session.percent >= 5 && open?.cost > 0) exactLimits.set(account.account, open.cost / (session.percent / 100));
    }

    return send(response, 200, {
      exact,
      exactLimits: Object.fromEntries(exactLimits),
      windows: windowHistory(db, { hours, days, fallback, limits: new Map([...limits, ...exactLimits]) }).map((w) => {
        if (!exactLimits.has(w.account)) return w;
        // The open window is Anthropic's own: its percentage and the time it starts again, not a scaled guess.
        const session = w.open ? exact.find((e) => e.account === w.account)?.limits.find((l) => l.kind === 'five_hour') : null;
        return session ? { ...w, basis: 'exact', share: session.percent / 100, end: Date.parse(session.resetsAt) || w.end } : { ...w, basis: 'exact' };
      }),
      compare: comparisons(db, settings),
      machines: db.prepare('SELECT id, name, color FROM machines').all(),
      emails: Object.fromEntries(accountEmails(db)),
    });
  }

  if (pathname === '/api/requests' && method === 'GET') {
    return send(response, 200, recentRequests(db, Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 40))));
  }

  if (pathname === '/api/sessions' && method === 'GET') {
    return send(response, 200, sessions(db, { limit: Math.min(300, Math.max(1, Number(url.searchParams.get('limit')) || 60)) }));
  }

  if (pathname === '/api/stream' && method === 'GET') {
    if (listeners.size >= MAX_LISTENERS) return send(response, 503, { error: 'busy' });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    response.write('retry: 5000\n\n');
    listeners.add(response);
    const ping = setInterval(() => response.write(': ping\n\n'), 25_000);
    request.on('close', () => {
      clearInterval(ping);
      listeners.delete(response);
    });
    return;
  }

  if (pathname === '/api/export.csv' && method === 'GET') {
    const days = Math.min(3650, Math.max(1, Math.round(Number(url.searchParams.get('days'))) || 30));
    return send(response, 200, exportCsv(db, Date.now() - days * 86_400_000, settings.timeZone), {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="claude-usage-${days}d.csv"`,
    });
  }

  if (pathname === '/api/settings' && method === 'GET') {
    const { passwordHash, secret, telegramToken, ...visible } = settings;
    return send(response, 200, { ...visible, telegramToken: telegramToken ? '••••' + telegramToken.slice(-4) : '' });
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readJson(request);
    if (body.language !== undefined && !LANGUAGES.includes(body.language)) return send(response, 400, { error: 'language' });
    // A new password is checked before anything is saved: a wrong current one changes nothing.
    const changing = typeof body.newPassword === 'string' && body.newPassword.length > 0;
    if (changing) {
      if (body.newPassword.length < 8 || body.newPassword.length > 200) return send(response, 400, { error: 'password' });
      // A dashboard left open is not enough to take it over: the password in use is asked for too (403, not
      // 401, so the page does not take it for a lost sign-in).
      if (!allowAttempt(ipOf(request))) return send(response, 429, { error: 'wait' });
      if (!(await checkPassword(db, body.currentPassword))) return send(response, 403, { error: 'currentPassword' });
    }

    const allowed = ['language', 'planName', 'planPrice', 'planAccount', 'billingDay', 'usdToUzs', 'windowHours', 'timeZone', 'chartDays', 'telegramChat', 'telegramToken'];
    for (const key of allowed) {
      if (body[key] === undefined || (key === 'telegramToken' && String(body[key]).startsWith('••••'))) continue;
      if (key === 'timeZone') {
        try {
          new Intl.DateTimeFormat('en', { timeZone: body[key] });
        } catch {
          return send(response, 400, { error: 'timeZone' });
        }
      }

      setSetting(db, key, String(body[key]).trim().slice(0, 200));
    }

    if (changing) {
      await setPassword(db, body.newPassword);
      return signIn(request, response);
    }

    return send(response, 200, { ok: true });
  }

  if (pathname === '/api/telegram-test' && method === 'POST') {
    return send(response, 200, await sendTelegram(settings, msg(settings, 'telegramTest')));
  }

  if (pathname === '/api/alerts/seen' && method === 'POST') {
    db.prepare('UPDATE alerts SET seen = 1').run();
    return send(response, 200, { ok: true });
  }

  if (pathname === '/api/machines' && method === 'POST') {
    const body = await readJson(request);
    const name = String(body.name ?? '').trim().slice(0, 60);
    if (!name) return send(response, 400, { error: 'name' });
    if (db.prepare('SELECT 1 FROM machines WHERE name = ?').get(name)) return send(response, 409, { error: 'taken' });
    const { token, hash, hint } = newToken();
    const count = db.prepare('SELECT count(*) AS n FROM machines').get().n;
    const result = db
      .prepare('INSERT INTO machines (name, token_hash, token_hint, color, created_at, daily_budget, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, hash, hint, COLORS[count % COLORS.length], Date.now(), Number(body.budget) > 0 ? Number(body.budget) : null, body.note ?? null);
    return send(response, 201, { id: Number(result.lastInsertRowid), name, token });
  }

  const machineMatch = /^\/api\/machines\/(\d+)(\/token|\/share)?$/.exec(pathname);
  if (machineMatch) {
    const id = Number(machineMatch[1]);
    if (!db.prepare('SELECT 1 FROM machines WHERE id = ?').get(id)) return send(response, 404, { error: 'machine' });

    // A new share link (the old one stops working), or none: DELETE.
    if (machineMatch[2] === '/share') {
      const share = method === 'POST' ? randomBytes(18).toString('base64url') : null;
      db.prepare('UPDATE machines SET share_token = ? WHERE id = ?').run(share, id);
      return send(response, 200, { share });
    }

    if (machineMatch[2] === '/token' && method === 'POST') {
      const { token, hash, hint } = newToken();
      db.prepare('UPDATE machines SET old_token_hash = token_hash, token_hash = ?, token_hint = ? WHERE id = ?').run(hash, hint, id);
      return send(response, 200, { token });
    }

    if (method === 'GET') {
      return send(response, 200, machineDetail(db, settings, id));
    }

    if (method === 'PATCH') {
      const body = await readJson(request);
      if (body.name !== undefined) {
        const name = String(body.name).trim().slice(0, 60);
        if (!name) return send(response, 400, { error: 'name' });
        if (db.prepare('SELECT 1 FROM machines WHERE name = ? AND id <> ?').get(name, id)) return send(response, 409, { error: 'taken' });
        db.prepare('UPDATE machines SET name = ? WHERE id = ?').run(name, id);
      }

      const amount = (value) => (Number(value) > 0 ? Number(value) : null);
      if (body.budget !== undefined) db.prepare('UPDATE machines SET daily_budget = ? WHERE id = ?').run(amount(body.budget), id);
      if (body.limitWindow !== undefined) db.prepare('UPDATE machines SET limit_window = ? WHERE id = ?').run(amount(body.limitWindow), id);
      if (body.limitWeek !== undefined) db.prepare('UPDATE machines SET limit_week = ? WHERE id = ?').run(amount(body.limitWeek), id);
      if (body.limitMonth !== undefined) db.prepare('UPDATE machines SET limit_month = ? WHERE id = ?').run(amount(body.limitMonth), id);
      if (body.limitBlock !== undefined) db.prepare('UPDATE machines SET limit_block = ? WHERE id = ?').run(body.limitBlock ? 1 : 0, id);
      const percentLimit = (value) => (Number(value) > 0 ? Math.min(100, Number(value)) : null);
      if (body.limitFivePct !== undefined) db.prepare('UPDATE machines SET limit_five_pct = ? WHERE id = ?').run(percentLimit(body.limitFivePct), id);
      if (body.limitWeekPct !== undefined) db.prepare('UPDATE machines SET limit_week_pct = ? WHERE id = ?').run(percentLimit(body.limitWeekPct), id);
      if (body.paused !== undefined) db.prepare('UPDATE machines SET paused = ? WHERE id = ?').run(body.paused ? 1 : 0, id);
      if (body.limitAccount !== undefined) db.prepare('UPDATE machines SET limit_account = ? WHERE id = ?').run(String(body.limitAccount ?? '').slice(0, 80) || null, id);
      if (body.note !== undefined) db.prepare('UPDATE machines SET note = ? WHERE id = ?').run(String(body.note).slice(0, 300) || null, id);
      if (body.color !== undefined && /^#[0-9a-f]{6}$/i.test(body.color)) db.prepare('UPDATE machines SET color = ? WHERE id = ?').run(body.color, id);
      if (body.disabled !== undefined) db.prepare('UPDATE machines SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, id);
      // null, or every family, is "any model"; a list without one known family is refused, not taken as none.
      if (body.allowedModels !== undefined) {
        const models = body.allowedModels === null ? null : parseModels(body.allowedModels);
        if (body.allowedModels !== null && !models) return send(response, 400, { error: 'models' });
        db.prepare('UPDATE machines SET allowed_models = ? WHERE id = ?').run(models && models.length < MODEL_FAMILIES.length ? JSON.stringify(models) : null, id);
      }

      if (body.maxEffort !== undefined) {
        if (body.maxEffort !== null && body.maxEffort !== '' && !EFFORTS.includes(body.maxEffort)) return send(response, 400, { error: 'effort' });
        db.prepare('UPDATE machines SET max_effort = ? WHERE id = ?').run(body.maxEffort && body.maxEffort !== 'max' ? body.maxEffort : null, id);
      }

      return send(response, 200, { ok: true });
    }

    if (method === 'DELETE') {
      db.prepare('DELETE FROM machines WHERE id = ?').run(id);
      return send(response, 200, { ok: true });
    }
  }

  return send(response, 404, { error: 'not found' });
}

function signIn(request, response) {
  const session = newSession(db);
  send(response, 200, { ok: true }, {
    'set-cookie': `${COOKIE}=${encodeURIComponent(session.value)}; ${cookieFlags(request)}; Max-Age=${session.maxAge}`,
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://local');
  try {
    if (request.method === 'POST' && (url.pathname === '/v1/logs' || url.pathname === '/v1/metrics' || url.pathname === '/v1/traces')) {
      return await receiveOtlp(request, response, url.pathname.slice(4));
    }

    if (url.pathname.startsWith('/api/')) {
      return await api(request, response, url);
    }

    if (request.method === 'GET' && /^\/share\/[A-Za-z0-9_-]{20,}$/.test(url.pathname)) {
      return await serveStatic(response, '/share.html');
    }

    if (url.pathname === '/agent.mjs') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-disposition': 'attachment; filename="agent.mjs"' });
      return response.end(await readFile(join(ROOT, 'agent', 'agent.mjs')));
    }

    if (request.method === 'GET') {
      return await serveStatic(response, url.pathname);
    }

    send(response, 405, 'Method not allowed');
  } catch (error) {
    if (!response.headersSent) {
      send(response, error.status ?? 500, { error: error.status ? error.message : 'server' });
    }

    if (!error.status) {
      console.error(new Date().toISOString(), request.method, url.pathname, error);
    }
  }
});

/**
 * A copy of the database once a day in backups/ next to it (the last 14 kept): everything the monitor knows is
 * in that one file. VACUUM INTO writes a consistent copy while the server keeps working.
 */
async function backUp() {
  if (DATA === ':memory:') return;
  const dir = join(dirname(DATA), 'backups');
  const file = join(dir, `monitor-${new Date().toISOString().slice(0, 10)}.db`);
  try {
    await mkdir(dir, { recursive: true });
    const have = (await readdir(dir)).filter((name) => /^monitor-\d{4}-\d{2}-\d{2}\.db$/.test(name)).sort();
    if (!have.includes(file.split(/[\\/]/).pop())) {
      db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
      keepPrivate(file);
      have.push(file.split(/[\\/]/).pop());
    }

    for (const old of have.sort().slice(0, -14)) await rm(join(dir, old), { force: true });
  } catch (error) {
    console.error(new Date().toISOString(), 'backup failed:', error.message);
  }
}

// Each round also clears out what only grows the file (see prune).
async function maintain() {
  try {
    prune(db);
  } catch (error) {
    console.error(new Date().toISOString(), 'prune failed:', error.message);
  }

  await backUp();
}

maintain();
setInterval(maintain, 6 * 3_600_000).unref();

server.listen(PORT, HOST, () => {
  if (process.env.MONITOR_DUMP) {
    console.warn(`MONITOR_DUMP is on: every payload (emails and account ids too) is written to ${process.env.MONITOR_DUMP}. Turn it off when done.`);
  }

  console.log(`Claude Monitor: http://localhost:${PORT}  (OTLP: http://<this-computer>:${PORT})`);
  if (!hasPassword(db)) {
    console.log(`The dashboard asks for a password on first visit. Setup code: ${setupCode}  (Sozlash kodi / Код настройки)`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
