// The owner's password for the dashboard, and the machines' tokens for sending their usage.

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getSettings, setSetting } from './db.mjs';

const SESSION_DAYS = 30;
export const COOKIE = 'cm_session';

const hash = (token) => createHash('sha256').update(token).digest('hex');

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
  const match = /^Bearer\s+(\S+)$/i.exec(String(header ?? '').trim());
  if (!match) {
    return null;
  }

  const machine = db.prepare('SELECT * FROM machines WHERE token_hash = ?').get(hash(match[1]));
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

export function setPassword(db, password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  setSetting(db, 'passwordHash', `${salt}:${derived}`);
  // A new password ends every session signed with the old secret.
  setSetting(db, 'secret', randomBytes(32).toString('hex'));
}

export function checkPassword(db, password) {
  const stored = getSettings(db).passwordHash;
  if (!stored || typeof password !== 'string') {
    return false;
  }

  const [salt, expected] = stored.split(':');
  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

/** A signed session cookie value that ends in 30 days. */
export function newSession(db) {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const body = `${expires}.${randomBytes(9).toString('base64url')}`;
  const signature = createHmac('sha256', secret(db)).update(body).digest('base64url');
  return { value: `${body}.${signature}`, maxAge: SESSION_DAYS * 86_400 };
}

export function isSignedIn(db, cookieHeader) {
  const value = parseCookies(cookieHeader)[COOKIE];
  if (!value) {
    return false;
  }

  const [expires, nonce, signature] = value.split('.');
  if (!expires || !nonce || !signature || Number(expires) < Date.now()) {
    return false;
  }

  const expected = createHmac('sha256', secret(db)).update(`${expires}.${nonce}`).digest('base64url');
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
  }

  return cookies;
}

// Wrong passwords from one address: five a minute, then it waits.
const attempts = new Map();

export function allowAttempt(ip) {
  const now = Date.now();
  const entry = attempts.get(ip) ?? { start: now, count: 0 };
  if (now - entry.start > 60_000) {
    entry.start = now;
    entry.count = 0;
  }

  entry.count++;
  attempts.set(ip, entry);
  return entry.count <= 5;
}
