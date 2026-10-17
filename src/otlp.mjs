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

const millisOf = (nanos) => (nanos ? Math.round(Number(BigInt(String(nanos)) / 1_000_000n)) : 0);

/** The event's name without the "claude_code." prefix, e.g. "api_request". */
export function eventName(record, attrs) {
  const name = attrs['event.name'] ?? valueOf(record.body) ?? '';
  return String(name).replace(/^claude_code\./, '');
}

/** What a payload says about the machine itself: its system, version, terminal and account. */
function describeMachine(db, machine, resource, attrs, ip) {
  const pick = (...keys) => keys.map((key) => attrs[key] ?? resource[key]).find((value) => value != null && value !== '');
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
  ['user.account_uuid', 'user.account_id'].map((key) => attrs[key] ?? resource[key]).find((value) => value != null && value !== '') ?? null;

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
          const ts = Date.parse(attrs['event.timestamp']) || millisOf(record.timeUnixNano) || Date.now();
          const session = attrs['session.id'] ?? null;
          const project =
            attrs['vcs.repository.name'] ?? resource['vcs.repository.name'] ?? (session ? projectOfSession.get(session)?.project : null) ?? null;

          if (name === 'api_request') {
            const account = accountIn(resource, attrs);
            rememberAccount(db, account, attrs['user.email'] ?? resource['user.email'] ?? null);
            const usage = {
              model: attrs.model ?? null,
              input: number(attrs.input_tokens),
              output: number(attrs.output_tokens),
              cacheRead: number(attrs.cache_read_tokens),
              cacheWrite: number(attrs.cache_creation_tokens),
              speed: attrs.speed ?? null,
            };
            // Claude Code works out the cost itself; it is only priced here when it says nothing.
            const cost = attrs.cost_usd != null ? number(attrs.cost_usd) : costOf(usage);
            const result = insertRequest.run(
              machine.id,
              ts,
              session,
              attrs.request_id ?? attrs.client_request_id ?? null,
              usage.model,
              usage.input,
              usage.output,
              usage.cacheRead,
              usage.cacheWrite,
              cost,
              number(attrs.duration_ms) || null,
              usage.speed,
              attrs.query_source ?? null,
              attrs.effort ?? null,
              project,
              account,
            );
            if (result.changes > 0) {
              kept++;
              requests.push({ machineId: machine.id, ts, session, account, ...usage, cost });
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

          const [label, ok, text] = detail();
          insertEvent.run(machine.id, ts, session, name, label ?? null, ok ?? null, number(attrs.duration_ms) || null, text?.trim() || null);
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

            const value = point.asDouble != null ? Number(point.asDouble) : Number(point.asInt ?? 0);
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

            const kind = String(attrs.type ?? attrs.decision ?? attrs.model ?? '');
            const day = dayOf(millisOf(point.timeUnixNano) || Date.now(), timeZone);
            add.run(machine.id, day, name, name === 'tokens' ? `${attrs.type ?? ''}` : name === 'cost' ? '' : kind, delta);
            kept++;
          }
        }
      }
    }
  });

  return { kept };
}
