// Days and hours in the owner's time zone, not the server's: a server abroad still counts Tashkent's days.

const formats = new Map();

function format(timeZone) {
  const key = timeZone || 'UTC';
  if (!formats.has(key)) {
    formats.set(
      key,
      new Intl.DateTimeFormat('en-CA', {
        timeZone: key,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
        hourCycle: 'h23',
      }),
    );
  }

  return formats.get(key);
}

function parts(ms, timeZone) {
  const result = {};
  for (const part of format(timeZone).formatToParts(new Date(ms))) {
    result[part.type] = part.value;
  }

  return result;
}

/** "2026-10-17" for the moment, in the zone. */
export function dayOf(ms, timeZone) {
  const p = parts(ms, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The hour of the day (0–23) and the weekday (0 = Monday) of the moment, in the zone. */
export function hourOf(ms, timeZone) {
  const p = parts(ms, timeZone);
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);
  return { hour: Number(p.hour) % 24, weekday };
}

/** The zone's offset from UTC at the moment, in minutes (zones like India's are half an hour off). */
export function offsetOf(ms, timeZone) {
  const p = parts(ms, timeZone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
  const minuteStart = ms - (ms % 60_000);
  return Math.round((asUtc - minuteStart) / 60_000);
}

/** The moment the day (in the zone) began. */
export function startOfDay(ms, timeZone) {
  const [year, month, day] = dayOf(ms, timeZone).split('-').map(Number);
  const guess = Date.UTC(year, month - 1, day);
  return guess - offsetOf(guess, timeZone) * 60_000;
}

/** The days from `from` to `to`, both included, as "YYYY-MM-DD". */
export function daysBetween(from, to) {
  const days = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const end = to;
  for (let t = Date.UTC(fy, fm - 1, fd); ; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    days.push(day);
    if (day >= end || days.length > 400) {
      break;
    }
  }

  return days;
}

/** The start of the current billing month: the billing day of this month or the last one. */
export function billingStart(now, billingDay, timeZone) {
  const [year, month, day] = dayOf(now, timeZone).split('-').map(Number);
  const wanted = Math.min(Math.max(1, Number(billingDay) || 1), 28);
  const start = day >= wanted ? Date.UTC(year, month - 1, wanted) : Date.UTC(year, month - 2, wanted);
  return start - offsetOf(start, timeZone) * 60_000;
}

/** The start of the current week (Monday by default), in the zone. */
export function weekStart(now, timeZone) {
  const today = startOfDay(now, timeZone);
  const { weekday } = hourOf(now, timeZone);
  return startOfDay(today - weekday * 86_400_000 + 12 * 3_600_000, timeZone);
}
