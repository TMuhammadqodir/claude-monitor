// The owner's password for the dashboard, and the machines' tokens for sending their usage.

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { getSettings, setSetting } from './db.mjs';

const SESSION_DAYS = 30;
export const COOKIE = 'cm_session';

const hash = (token) => createHash('sha256').update(token).digest('hex');
// scrypt runs on Node's thread pool: a password being checked does not hold up the telemetry coming in.
const derive = promisify(scrypt);

/** A new machine token: shown once, kept only as its hash. */
export function newToken() {
  const token = `cm_${randomBytes(24).toString('base64url')}`;
  return { token, hash: hash(token), hint: `${token.slice(0, 6)}…${token.slice(-4)}` };
}

/** The hash of the token in a request's "Authorization: Bearer cm_…" header; null without one. */
export function presentedHash(header) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(header ?? '').trim());
  return match ? hash(match[1]) : null;
}

/** The machine a request's "Authorization: Bearer cm_…" header names; null when none or disabled. */
export function machineOf(db, header) {
  const presented = presentedHash(header);
  if (!presented) {
    return null;
  }

  const machine = db.prepare('SELECT * FROM machines WHERE token_hash = ?').get(presented);
  return machine && !machine.disabled ? machine : null;
}

function secret(db) {
  let value = getSettings(db).secret;
  if (!value) {
    value = randomBytes(32).toString('hex');
    setSetting(db, 'secret', value);
  }

  return value;
}

export function hasPassword(db) {
  return Boolean(getSettings(db).passwordHash);
}

export async function setPassword(db, password) {
  const salt = randomBytes(16).toString('hex');
  const derived = (await derive(password, salt, 64)).toString('hex');
  setSetting(db, 'passwordHash', `${salt}:${derived}`);
  // A new password ends every session: the ones signed with the old secret, and every one kept.
  setSetting(db, 'secret', randomBytes(32).toString('hex'));
  db.prepare('DELETE FROM sessions').run();
}

export async function checkPassword(db, password) {
  const stored = getSettings(db).passwordHash;
  if (!stored || typeof password !== 'string') {
    return false;
  }

  const [salt, expectedHex] = stored.split(':');
  const expected = Buffer.from(expectedHex ?? '', 'hex');
  if (!salt || expected.length !== 64) {
    return false;
  }

  return timingSafeEqual(await derive(password, salt, 64), expected);
}

/**
 * A signed session cookie value that ends in 30 days. The session is also kept (as its nonce's hash), so
 * signing out ends it on the server, not only in the browser.
 */
export function newSession(db, now = Date.now()) {
  const expires = now + SESSION_DAYS * 86_400_000;
  const nonce = randomBytes(18).toString('base64url');
  const body = `${expires}.${nonce}`;
  const signature = createHmac('sha256', secret(db)).update(body).digest('base64url');
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
  db.prepare('INSERT INTO sessions (id, expires) VALUES (?, ?)').run(hash(nonce), expires);
  return { value: `${body}.${signature}`, maxAge: SESSION_DAYS * 86_400 };
}

/** The session's nonce when the cookie is signed, unexpired and still kept; else null. */
function sessionOf(db, cookieHeader) {
  const value = parseCookies(cookieHeader)[COOKIE];
  if (!value) {
    return null;
  }

  const [expires, nonce, signature] = value.split('.');
  if (!expires || !nonce || !signature || Number(expires) < Date.now()) {
    return null;
  }

  const expected = createHmac('sha256', secret(db)).update(`${expires}.${nonce}`).digest('base64url');
  if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    return null;
  }

  return db.prepare('SELECT 1 FROM sessions WHERE id = ? AND expires >= ?').get(hash(nonce), Date.now()) ? nonce : null;
}

export function isSignedIn(db, cookieHeader) {
  return sessionOf(db, cookieHeader) !== null;
}

/** Signing out: the session stops working everywhere, even if its cookie was copied. */
export function endSession(db, cookieHeader) {
  const nonce = sessionOf(db, cookieHeader);
  if (nonce) db.prepare('DELETE FROM sessions WHERE id = ?').run(hash(nonce));
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      try {
        cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        // A cookie that is not valid percent-encoding is not ours.
      }
    }
  }

  return cookies;
}

// Password attempts from one address: five a minute, then it waits. Old entries go, so addresses that tried
// once do not pile up in memory.
const attempts = new Map();

export function allowAttempt(ip, now = Date.now()) {
  if (attempts.size > 1000) {
    for (const [key, entry] of attempts) {
      if (now - entry.start > 60_000) attempts.delete(key);
    }
  }

  const entry = attempts.get(ip) ?? { start: now, count: 0 };
  if (now - entry.start > 60_000) {
    entry.start = now;
    entry.count = 0;
  }

  entry.count++;
  attempts.set(ip, entry);
  return entry.count <= 5;
}
