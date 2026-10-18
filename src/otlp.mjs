// Reads what Claude Code sends over OpenTelemetry (OTLP/HTTP with JSON, code.claude.com/docs/en/monitoring-usage):
// the events (logs) say what each API request cost, the metrics count sessions, lines, commits and active time.

import { costOf } from './pricing.mjs';
import { inTransaction, rememberAccount } from './db.mjs';
import { dayOf } from './time.mjs';

/** An OTLP attribute list as a plain object. */
export function attributes(list) {
  const result = {};
  for (const item of list ?? []) {
    result[item.key] = valueOf(item.value);
  }

  return result;
}

function valueOf(value) {
  if (!value || typeof value !== 'object') {
    return value ?? null;
  }

  if ('stringValue' in value) return value.stringValue;
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('boolValue' in value) return Boolean(value.boolValue);
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(valueOf);
  if ('kvlistValue' in value) return attributes(value.kvlistValue.values);
  return null;
}

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

// Counts and costs are never below zero: a negative cost would lower a machine's spending under its limit.
const amount = (value) => Math.max(0, number(value));

/**
 * A text attribute as the database keeps it: a string (or number) cut to `max`, else null. A token holder
 * could otherwise send megabytes in a model's name, or an array SQLite cannot store.
 */
export const text = (value, max = 200) =>
  typeof value === 'string' ? value.slice(0, max) || null : typeof value === 'number' || typeof value === 'boolean' ? String(value).slice(0, max) : null;

/** OTLP's nanoseconds as milliseconds; 0 when missing or not a whole number. */
export function millisOf(nanos) {
  if (!nanos) return 0;
  try {
    return Math.round(Number(BigInt(String(nanos)) / 1_000_000n));
  } catch {
    const n = Number(nanos);
    return Number.isFinite(n) && n > 0 ? Math.round(n / 1_000_000) : 0;
  }
}

// A moment more than a day ahead, or before 2020, is the sender's clock or a forgery: now is used instead.
const sane = (ms) => (Number.isFinite(ms) && ms > 1_577_836_800_000 && ms < Date.now() + 86_400_000 ? ms : 0);

/** The event's name without the "claude_code." prefix, e.g. "api_request". */
export function eventName(record, attrs) {
  const name = attrs['event.name'] ?? valueOf(record.body) ?? '';
  return String(name).replace(/^claude_code\./, '');
}

/** What a payload says about the machine itself: its system, version, terminal and account. */
function describeMachine(db, machine, resource, attrs, ip) {
  const pick = (...keys) => text(keys.map((key) => attrs[key] ?? resource[key]).find((value) => value != null && value !== ''), 120);
  db.prepare(
    `UPDATE machines SET last_seen_at = ?, last_ip = coalesce(?, last_ip),
       os = coalesce(?, os), arch = coalesce(?, arch), version = coalesce(?, version),
       terminal = coalesce(?, terminal), email = coalesce(?, email), account = coalesce(?, account)
     WHERE id = ?`,
  ).run(
    Date.now(),
    ip ?? null,
    pick('os.type', 'os.name') ?? null,
    pick('host.arch') ?? null,
    pick('app.version', 'service.version') ?? null,
    pick('terminal.type') ?? null,
    pick('user.email') ?? null,
    pick('user.account_uuid', 'user.account_id', 'organization.id') ?? null,
    machine.id,
  );
}

/** The Claude account an event was made with, as Claude Code names it. */
const accountIn = (resource, attrs) =>
  text(['user.account_uuid', 'user.account_id'].map((key) => attrs[key] ?? resource[key]).find((value) => value != null && value !== ''), 80);

/**
 * Stores the events of an OTLP logs payload for the machine. Returns how many were kept and the API
 * requests among them (the live feed shows those).
 */
export function ingestLogs(db, machine, payload, { ip, onLimit } = {}) {
  let kept = 0;
  const requests = [];
  const limits = [];

  inTransaction(db, () => {
    const insertRequest = db.prepare(
      `INSERT INTO requests (machine_id, ts, session_id, request_id, model, input, output, cache_read, cache_write,
         cost, duration_ms, speed, source, effort, project, account, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'otel')
       ON CONFLICT DO NOTHING`,
    );
    // Telemetry does not name the project; a session already known from the imported logs does.
    const projectOfSession = db.prepare('SELECT project FROM requests WHERE session_id = ? AND project IS NOT NULL LIMIT 1');
    const insertEvent = db.prepare(
      'INSERT INTO events (machine_id, ts, session_id, kind, name, ok, duration_ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );

    for (const resourceLogs of payload?.resourceLogs ?? []) {
      const resource = attributes(resourceLogs.resource?.attributes);
      let described = false;
      for (const scope of resourceLogs.scopeLogs ?? []) {
        for (const record of scope.logRecords ?? []) {
          const attrs = attributes(record.attributes);
          if (!described) {
            describeMachine(db, machine, resource, attrs, ip);
            described = true;
          }

          const name = eventName(record, attrs);
          const ts = sane(Date.parse(attrs['event.timestamp'])) || sane(millisOf(record.timeUnixNano)) || Date.now();
          const session = text(attrs['session.id'], 80);
          const project =
            text(attrs['vcs.repository.name'] ?? resource['vcs.repository.name'], 120) ?? (session ? projectOfSession.get(session)?.project : null) ?? null;

          if (name === 'api_request') {
            const account = accountIn(resource, attrs);
            rememberAccount(db, account, text(attrs['user.email'] ?? resource['user.email'], 120));
            const usage = {
              model: text(attrs.model, 80),
              input: amount(attrs.input_tokens),
              output: amount(attrs.output_tokens),
              cacheRead: amount(attrs.cache_read_tokens),
              cacheWrite: amount(attrs.cache_creation_tokens),
              speed: text(attrs.speed, 20),
            };
            // Claude Code works out the cost itself; it is only priced here when it says nothing.
            const cost = attrs.cost_usd != null ? amount(attrs.cost_usd) : costOf(usage);
            const result = insertRequest.run(
              machine.id,
              ts,
              session,
              text(attrs.request_id ?? attrs.client_request_id, 120),
              usage.model,
              usage.input,
              usage.output,
              usage.cacheRead,
              usage.cacheWrite,
              cost,
              amount(attrs.duration_ms) || null,
              usage.speed,
              text(attrs.query_source, 40),
              text(attrs.effort, 20),
              project,
              account,
            );
            if (result.changes > 0) {
              kept++;
              requests.push({ machineId: machine.id, ts, session, account, ...usage, cost, source: text(attrs.query_source, 40), effort: text(attrs.effort, 20) });
            }

            continue;
          }

          const detail = {
            api_error: () => [attrs.model, 0, String(attrs.status_code ?? '') + ' ' + String(attrs.error ?? '').slice(0, 200)],
            tool_result: () => [attrs.tool_name, attrs.success === true || attrs.success === 'true' ? 1 : 0, attrs.error_type ?? null],
            tool_decision: () => [attrs.tool_name, attrs.decision === 'accept' ? 1 : 0, attrs.source ?? null],
            user_prompt: () => [attrs.command_name ?? null, null, attrs.prompt_length != null ? String(attrs.prompt_length) : null],
            api_refusal: () => [attrs.model, 0, attrs.category ?? null],
            auth: () => [attrs.action, attrs.success === true || attrs.success === 'true' ? 1 : 0, attrs.auth_method ?? null],
            mcp_server_connection: () => [attrs.server_name ?? attrs.transport_type, attrs.status === 'failed' ? 0 : 1, attrs.status ?? null],
            internal_error: () => [attrs.error_name, 0, attrs.error_code ?? null],
          }[name];
          if (!detail) {
            continue;
          }

          const [label, ok, said] = detail();
          insertEvent.run(machine.id, ts, session, name, text(label, 120), ok ?? null, amount(attrs.duration_ms) || null, text(said, 300)?.trim() || null);
          kept++;

          // Too many requests: the subscription's limit was reached on this account.
          if (name === 'api_error' && (String(attrs.status_code) === '429' || /rate.?limit|usage limit/i.test(String(attrs.error)))) {
            limits.push({ ts, account: accountIn(resource, attrs) });
          }
        }
      }
    }
  });

  for (const hit of limits) {
    onLimit?.(machine, hit);
  }

  return { kept, requests };
}

// The metrics kept per day: the counts the events do not give.
const METRICS = {
  'claude_code.session.count': 'sessions',
  'claude_code.lines_of_code.count': 'lines',
  'claude_code.pull_request.count': 'pull_requests',
  'claude_code.commit.count': 'commits',
  'claude_code.active_time.total': 'active_seconds',
  'claude_code.code_edit_tool.decision': 'edit_decisions',
  'claude_code.cost.usage': 'cost',
  'claude_code.token.usage': 'tokens',
};

/**
 * Adds an OTLP metrics payload to the daily counters. A cumulative series counts only what grew since
 * its last export, so a value sent twice is not counted twice.
 */
export function ingestMetrics(db, machine, payload, { ip, timeZone } = {}) {
  let kept = 0;
  inTransaction(db, () => {
    const add = db.prepare(
      `INSERT INTO counters (machine_id, day, metric, kind, value) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(machine_id, day, metric, kind) DO UPDATE SET value = value + excluded.value`,
    );
    const previous = db.prepare('SELECT start, value FROM series WHERE key = ?');
    const remember = db.prepare(
      'INSERT INTO series (key, start, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET start = excluded.start, value = excluded.value',
    );

    for (const resourceMetrics of payload?.resourceMetrics ?? []) {
      const resource = attributes(resourceMetrics.resource?.attributes);
      let described = false;
      for (const scope of resourceMetrics.scopeMetrics ?? []) {
        for (const metric of scope.metrics ?? []) {
          const name = METRICS[metric.name];
          const data = metric.sum ?? metric.gauge;
          if (!name || !data) {
            continue;
          }

          const cumulative = data.aggregationTemporality === 2 || data.aggregationTemporality === 'AGGREGATION_TEMPORALITY_CUMULATIVE';
          for (const point of data.dataPoints ?? []) {
            const attrs = attributes(point.attributes);
            if (!described) {
              describeMachine(db, machine, resource, attrs, ip);
              described = true;
            }

            const value = number(point.asDouble ?? point.asInt ?? 0);
            let delta = value;
            if (cumulative) {
              const key = `${machine.id}|${metric.name}|${JSON.stringify(Object.entries(attrs).sort())}`;
              const start = millisOf(point.startTimeUnixNano);
              const last = previous.get(key);
              delta = last && last.start === start ? value - last.value : value;
              remember.run(key, start, value);
            }

            if (!(delta > 0)) {
              continue;
            }

            const kind = text(attrs.type ?? attrs.decision ?? attrs.model, 80) ?? '';
            const day = dayOf(sane(millisOf(point.timeUnixNano)) || Date.now(), timeZone);
            add.run(machine.id, day, name, name === 'tokens' ? (text(attrs.type, 40) ?? '') : name === 'cost' ? '' : kind, delta);
            kept++;
          }
        }
      }
    }
  });

  return { kept };
}
