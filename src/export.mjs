// Every request since a moment as CSV, to open in Excel or Google Sheets.

import { modelLabel } from './pricing.mjs';
import { ACCOUNT, accountEmails, fallbackAccount } from './usage.mjs';

const cell = (value) => {
  const text = value == null ? '' : String(value);
  // A cell starting with = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function exportCsv(db, since, timeZone) {
  const rows = db
    .prepare(
      `SELECT r.ts, m.name AS machine, ${ACCOUNT} AS account, r.session_id, r.model, r.input, r.output, r.cache_read, r.cache_write, r.cost,
         r.duration_ms, r.speed, r.project, r.origin
       FROM requests r JOIN machines m ON m.id = r.machine_id WHERE r.ts >= ? ORDER BY r.ts`,
    )
    .all(fallbackAccount(db), since);
  const emails = accountEmails(db);
  const format = new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'medium' });
  const lines = [
    ['time', 'machine', 'account', 'session', 'model', 'input', 'output', 'cache_read', 'cache_write', 'cost_usd', 'duration_ms', 'speed', 'project', 'source'].join(','),
  ];
  for (const row of rows) {
    lines.push(
      [
        format.format(new Date(row.ts)),
        row.machine,
        emails.get(row.account) ?? row.account,
        row.session_id,
        modelLabel(row.model),
        row.input,
        row.output,
        row.cache_read,
        row.cache_write,
        row.cost.toFixed(6),
        row.duration_ms,
        row.speed,
        row.project,
        row.origin,
      ]
        .map(cell)
        .join(','),
    );
  }

  return '﻿' + lines.join('\r\n') + '\r\n';
}
