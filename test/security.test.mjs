import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb, prune } from '../src/db.mjs';
import { ingestLogs, millisOf, text } from '../src/otlp.mjs';
import { allowAttempt, checkPassword, endSession, isSignedIn, newSession, newToken, setPassword } from '../src/auth.mjs';
import { clientAddress } from '../src/net.mjs';
import { mayUseAccount, saveExactUsage } from '../src/usage.mjs';
import { maskEmail } from '../src/stats.mjs';

function setup() {
  const db = openDb(':memory:');
  const { token, hash, hint } = newToken();
  db.prepare("INSERT INTO machines (name, token_hash, token_hint, color, created_at) VALUES ('pc', ?, ?, '#ff0000', ?)").run(hash, hint, Date.now());
  return { db, machine: db.prepare('SELECT * FROM machines').get(), token };
}

const logs = (attributes, record = {}) => ({
  resourceLogs: [{ scopeLogs: [{ logRecords: [{ ...record, attributes: Object.entries(attributes).map(([key, value]) => ({ key, value })) }] }] }],
});

test('behind a proxy the address is the one the proxy added, not one the client wrote', () => {
  assert.equal(clientAddress('6.6.6.6, 10.0.0.5', '127.0.0.1', true), '10.0.0.5');
  assert.equal(clientAddress('6.6.6.6', '::ffff:127.0.0.1', false), '127.0.0.1');
  assert.equal(clientAddress('', '::ffff:192.168.1.2', true), '192.168.1.2');
});

test('telemetry cannot lower a cost, break the receiver or fill the database', () => {
  const { db, machine } = setup();
  const name = { stringValue: 'api_request' };
  ingestLogs(db, machine, logs({ 'event.name': name, cost_usd: { doubleValue: -1000 }, input_tokens: { intValue: '-5' }, request_id: { stringValue: 'r1' } }));
  ingestLogs(db, machine, logs({ 'event.name': name, request_id: { stringValue: 'r2' } }, { timeUnixNano: '12.5e3' }));
  ingestLogs(db, machine, logs({ 'event.name': name, model: { arrayValue: { values: [{ stringValue: 'x' }] } }, request_id: { stringValue: 'r3' } }));
  ingestLogs(db, machine, logs({ 'event.name': name, model: { stringValue: 'x'.repeat(100_000) }, request_id: { stringValue: 'r4' } }));
  const rows = db.prepare('SELECT request_id, cost, input, model, ts FROM requests ORDER BY request_id').all();
  assert.equal(rows.length, 4);
  assert.equal(rows[0].cost, 0);
  assert.equal(rows[0].input, 0);
  assert.equal(rows[2].model, null);
  assert.equal(rows[3].model.length, 80);
  // A moment that is no moment is taken as now.
  assert.ok(Math.abs(rows[1].ts - Date.now()) < 5000);
  assert.equal(millisOf('nonsense'), 0);
  assert.equal(text({ nested: true }), null);
});

test('a machine may report only accounts it is known to use', () => {
  const { db, machine } = setup();
  const report = (account) => ({ account, limits: [{ kind: 'five_hour', percent: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] });
  // No account yet: the first one is taken.
  assert.equal(mayUseAccount(db, machine.id, 'mine'), true);
  saveExactUsage(db, machine, report('mine'));
  assert.equal(mayUseAccount(db, machine.id, 'mine'), true);
  assert.equal(mayUseAccount(db, machine.id, 'someone-else'), false);
  // Once its telemetry shows it working on another account, that one is its too.
  db.prepare("INSERT INTO requests (machine_id, ts, model, cost, account, origin) VALUES (?, ?, 'm', 1, 'someone-else', 'test')").run(machine.id, Date.now());
  assert.equal(mayUseAccount(db, machine.id, 'someone-else'), true);
});

test('signing out and a new password end sessions on the server', async () => {
  const { db } = setup();
  await setPassword(db, 'first-password');
  assert.equal(await checkPassword(db, 'first-password'), true);
  assert.equal(await checkPassword(db, 'wrong'), false);
  assert.equal(await checkPassword(db, undefined), false);

  const cookie = (session) => `cm_session=${encodeURIComponent(session.value)}`;
  const one = newSession(db);
  const two = newSession(db);
  assert.equal(isSignedIn(db, cookie(one)), true);
  endSession(db, cookie(one));
  assert.equal(isSignedIn(db, cookie(one)), false);
  assert.equal(isSignedIn(db, cookie(two)), true);
  await setPassword(db, 'second-password');
  assert.equal(isSignedIn(db, cookie(two)), false);
  // A cookie that is not percent-encoding is no session, not a crash.
  assert.equal(isSignedIn(db, 'cm_session=%E0%A4%A'), false);
});

test('password attempts are limited and old addresses are forgotten', () => {
  const start = 1_000_000_000_000;
  for (let i = 0; i < 5; i++) assert.equal(allowAttempt('9.9.9.9', start), true);
  assert.equal(allowAttempt('9.9.9.9', start), false);
  assert.equal(allowAttempt('9.9.9.9', start + 61_000), true);
});

test('old events, seen alerts and long-closed series are cleared; requests stay', () => {
  const { db, machine } = setup();
  const now = Date.now();
  const old = now - 400 * 86_400_000;
  db.prepare("INSERT INTO events (machine_id, ts, kind) VALUES (?, ?, 'tool_result')").run(machine.id, old);
  db.prepare("INSERT INTO events (machine_id, ts, kind) VALUES (?, ?, 'tool_result')").run(machine.id, now);
  db.prepare("INSERT INTO alerts (ts, kind, message, seen) VALUES (?, 'x', 'old', 1)").run(old);
  db.prepare("INSERT INTO alerts (ts, kind, message, seen) VALUES (?, 'x', 'unseen', 0)").run(old);
  db.prepare("INSERT INTO series (key, start, value) VALUES ('a', ?, 1), ('b', 0, 1)").run(old);
  db.prepare("INSERT INTO requests (machine_id, ts, model, cost, origin) VALUES (?, ?, 'm', 1, 'test')").run(machine.id, old);
  prune(db, now, {});
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
  assert.deepEqual(db.prepare('SELECT message FROM alerts').all().map((a) => a.message), ['unseen']);
  assert.deepEqual(db.prepare('SELECT key FROM series').all().map((s) => s.key), ['b']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM requests').get().n, 1);
  prune(db, now, { KEEP_DAYS: '365' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM requests').get().n, 0);
});

test('a share link shows only part of the email', () => {
  assert.equal(maskEmail('muhammad@gmail.com'), 'mu•••@gmail.com');
  assert.equal(maskEmail(null), null);
});

// ---------- the server itself, over HTTP ----------

async function startServer(env = {}) {
  const port = 41000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA: ':memory:', TRUST_PROXY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const code = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /Setup code: ([0-9a-f]+)/.exec(out);
      if (match) resolve(match[1]);
    });
    child.on('exit', () => reject(new Error(out)));
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (path, { method = 'GET', body, cookie, token, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(method !== 'GET' ? { 'x-monitor': '1' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = response.headers.get('set-cookie');
    return { status: response.status, body: await response.json().catch(() => null), cookie: setCookie?.split(';')[0] };
  };
  return { child, code, call };
}

test('over HTTP: setup, sessions, password change, share links and account reports are guarded', async (t) => {
  const { child, code, call } = await startServer();
  t.after(() => child.kill());

  assert.equal((await call('/api/setup', { method: 'POST', body: { password: 'owner-password', code: 'nope' } })).status, 403);
  const setupAnswer = await call('/api/setup', { method: 'POST', body: { password: 'owner-password', code } });
  assert.equal(setupAnswer.status, 200);
  const cookie = setupAnswer.cookie;
  assert.equal((await call('/api/overview', { cookie })).status, 200);

  // Without the dashboard's header a change is refused.
  assert.equal((await call('/api/alerts/seen', { method: 'POST', cookie, headers: { 'x-monitor': '0' } })).status, 403);

  // The password is changed only with the current one, and a wrong one changes no setting either.
  const wrong = await call('/api/settings', { method: 'PUT', cookie, body: { planName: 'Changed', newPassword: 'taken-over-password', currentPassword: 'guess' } });
  assert.equal(wrong.status, 403);
  assert.notEqual((await call('/api/settings', { cookie })).body.planName, 'Changed');
  const changed = await call('/api/settings', { method: 'PUT', cookie, body: { newPassword: 'second-password', currentPassword: 'owner-password' } });
  assert.equal(changed.status, 200);
  assert.equal((await call('/api/overview', { cookie })).status, 401);
  const fresh = changed.cookie;
  assert.equal((await call('/api/overview', { cookie: fresh })).status, 200);

  // Signing out ends the session on the server: the copied cookie no longer works.
  await call('/api/logout', { method: 'POST', cookie: fresh });
  assert.equal((await call('/api/overview', { cookie: fresh })).status, 401);
  const signedIn = (await call('/api/login', { method: 'POST', body: { password: 'second-password' } })).cookie;

  // A machine reports its own account, not someone else's.
  const machine = await call('/api/machines', { method: 'POST', cookie: signedIn, body: { name: 'laptop' } });
  const limits = (account) => ({ account, limits: [{ kind: 'five_hour', percent: 20, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] });
  assert.equal((await call('/api/limits', { method: 'POST', token: machine.body.token, body: limits('mine') })).status, 200);
  assert.equal((await call('/api/limits', { method: 'POST', token: machine.body.token, body: limits('not-mine') })).status, 403);

  // A turned-off machine's share link stops working.
  const share = (await call(`/api/machines/${machine.body.id}/share`, { method: 'POST', cookie: signedIn })).body.share;
  assert.equal((await call(`/api/share/${share}`)).status, 200);
  await call(`/api/machines/${machine.body.id}`, { method: 'PATCH', cookie: signedIn, body: { disabled: true } });
  assert.equal((await call(`/api/share/${share}`)).status, 404);

  // Bad telemetry is an answer, not a crash.
  const second = await call('/api/machines', { method: 'POST', cookie: signedIn, body: { name: 'desktop' } });
  const bad = await call('/v1/logs', { method: 'POST', token: second.body.token, body: logs({ 'event.name': { stringValue: 'api_request' }, model: { arrayValue: { values: [] } } }, { timeUnixNano: 'x' }) });
  assert.equal(bad.status, 200);
});

test('over HTTP: unknown tokens are reported a few times a day, not without end', async (t) => {
  // Behind a "proxy", so each request can come from another address, as a scanner's would.
  const { child, code, call } = await startServer({ TRUST_PROXY: '1' });
  t.after(() => child.kill());
  const cookie = (await call('/api/setup', { method: 'POST', body: { password: 'owner-password', code } })).cookie;
  for (let i = 0; i < 12; i++) await call('/v1/logs', { method: 'POST', token: `cm_unknown${i}`, body: {}, headers: { 'x-forwarded-for': `10.0.0.${i}` } });
  const alerts = (await call('/api/overview', { cookie })).body.alerts.filter((a) => a.kind === 'token');
  // Five addresses, then one notice that more came.
  assert.equal(alerts.length, 6);
});
