// Past usage from a machine's own Claude Code logs (~/.claude/projects/**/*.jsonl), sent by agent.mjs:
// what happened before telemetry was turned on. A request already reported over telemetry is not counted twice.

import { costOf } from './pricing.mjs';
import { inTransaction } from './db.mjs';
import { text } from './otlp.mjs';

const number = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);

export function importRecords(db, machine, records, { ip, meta } = {}) {
  let added = 0;
  let skipped = 0;

  inTransaction(db, () => {
    const insert = db.prepare(
      `INSERT INTO requests (machine_id, ts, session_id, request_id, model, input, output, cache_read, cache_write,
         cost, speed, project, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import')
       ON CONFLICT DO NOTHING`,
    );

    for (const record of Array.isArray(records) ? records.slice(0, 50_000) : []) {
      const ts = Date.parse(record?.ts);
      const id = record?.requestId || record?.messageId;
      const usage = {
        model: typeof record?.model === 'string' ? record.model.slice(0, 80) : null,
        input: number(record?.input),
        output: number(record?.output),
        cacheRead: number(record?.cacheRead),
        cacheWrite: number(record?.cacheWrite),
        cacheWrite1h: number(record?.cacheWrite1h),
        speed: record?.speed === 'fast' ? 'fast' : null,
      };
      // Before 2020 or more than a day ahead is no Claude Code log.
      if (!Number.isFinite(ts) || ts < 1_577_836_800_000 || ts > Date.now() + 86_400_000 || !id || usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) {
        skipped++;
        continue;
      }

      const result = insert.run(
        machine.id,
        ts,
        typeof record.session === 'string' ? record.session.slice(0, 80) : null,
        String(id).slice(0, 120),
        usage.model,
        usage.input,
        usage.output,
        usage.cacheRead,
        usage.cacheWrite,
        costOf(usage),
        usage.speed,
        typeof record.project === 'string' ? record.project.slice(0, 120) : null,
      );
      if (result.changes > 0) {
        added++;
      } else {
        skipped++;
      }
    }

    // Requests that came over telemetry first get the project their session's logs name.
    db.prepare(
      `UPDATE requests SET project = (SELECT p.project FROM requests p WHERE p.session_id = requests.session_id AND p.project IS NOT NULL LIMIT 1)
       WHERE machine_id = ? AND project IS NULL AND session_id IS NOT NULL`,
    ).run(machine.id);

    db.prepare(
      `UPDATE machines SET last_ip = coalesce(?, last_ip), os = coalesce(?, os), arch = coalesce(?, arch),
         version = coalesce(?, version), last_seen_at = coalesce(last_seen_at, ?) WHERE id = ?`,
    ).run(ip ?? null, text(meta?.os, 40), text(meta?.arch, 40), text(meta?.version, 40), Date.now(), machine.id);
  });

  return { added, skipped };
}
