// Claude Monitor dashboard: plain modules, no build step. Every number comes from /api/*.

import { t, LANGS, lang, setLang, MONTHS } from './i18n.js';

const app = document.getElementById('app');

// The browser's storage only remembers conveniences (the open tab, the period); it may be blocked.
function stored(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
}
const state = {
  tab: stored('tab') || 'overview',
  period: stored('period') || 'month',
  usage: null,
  windows: null,
  data: null,
  feed: [],
  sessions: [],
  live: false,
  feedIds: new Set(),
};

// ---------- helpers ----------

const h = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function money(value, digits) {
  const n = Number(value) || 0;
  const d = digits ?? (n !== 0 && Math.abs(n) < 1 ? (Math.abs(n) < 0.01 ? 4 : 3) : 2);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function som(value) {
  const rate = state.data?.plan?.usdToUzs || 0;
  if (!rate) return '';
  const n = Math.round((Number(value) || 0) * rate);
  return t('{n} so‘m', { n: n.toLocaleString('ru-RU').replace(/,/g, ' ') });
}

function tokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return t('{n} mlrd', { n: (n / 1e9).toFixed(2) });
  if (n >= 1e6) return t('{n} mln', { n: (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) });
  if (n >= 1e3) return t('{n} ming', { n: (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) });
  return String(Math.round(n));
}

const count = (n) => (Number(n) || 0).toLocaleString('en-US').replace(/,/g, ' ');

/** A limit's label in the page's language: the server's names, and "N soatlik" for a window of any length. */
const limitLabelText = (label) => {
  const hours = /^(\d+) soatlik$/.exec(label)?.[1];
  return hours && hours !== '5' ? t('{n} soatlik', { n: hours }) : t(label);
};

/** "16:12:43" in the browser's clock. */
const clockTime = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// The model families a machine can be kept to, and the effort caps (Claude Code's own names).
const MODEL_FAMILIES = [
  ['fable', 'Fable'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
];
const EFFORT_LEVELS = [
  ['max', 'chegarasiz'],
  ['xhigh', 'xhigh gacha'],
  ['high', 'high gacha'],
  ['medium', 'medium gacha'],
  ['low', 'faqat low'],
];

function ago(ts) {
  if (!ts) return t('hech qachon');
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return t('hozirgina');
  if (s < 3600) return t('{n} daq oldin', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n} soat oldin', { n: Math.round(s / 3600) });
  return t('{n} kun oldin', { n: Math.round(s / 86400) });
}

function duration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return t('{n} daq', { n: minutes });
  return t('{h} soat {m} daq', { h: Math.floor(minutes / 60), m: minutes % 60 });
}

/** "14:05", or "16-oktabr 14:05" with the day (month names come from i18n.js: browsers have no Uzbek ones). */
function time(ts, withDay = false) {
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: state.data?.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts));
  return withDay ? `${dateLabel(ts)} ${clock}` : clock;
}

/** "1-oktabr" for a moment, in the dashboard's zone. */
function dateLabel(ts) {
  const [, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: state.data?.timeZone }).format(new Date(ts)).split('-').map(Number);
  return lang === 'uz' ? `${day}-${MONTHS[month - 1]}` : `${day} ${MONTHS[month - 1]}`;
}

const dayLabel = (day) => {
  const [, m, d] = day.split('-');
  return `${Number(d)}.${m}`;
};

const STATUS = {
  active: t('Ishlayapti'),
  online: t('Ulangan'),
  idle: t('Bugun ishlagan'),
  offline: t('Ulanmagan'),
  never: t('Hali ulanmagan'),
  disabled: t('O‘chirilgan'),
};

function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2400);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-monitor': '1', ...(options.headers ?? {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/setup')) {
    // Drawn once: the timed refresh must not wipe a password being typed.
    if (!document.getElementById('login-form')) renderLogin(true);
    throw new Error('signin');
  }

  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw Object.assign(new Error(data?.error ?? 'error'), { status: response.status, data });
  return data;
}

// ---------- tooltip ----------

const tip = document.getElementById('tip');
document.addEventListener('mousemove', (event) => {
  const target = event.target.closest?.('[data-tip]');
  if (!target) {
    tip.classList.remove('show');
    return;
  }

  tip.innerHTML = target.dataset.tip;
  tip.classList.add('show');
  const x = Math.min(event.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = Math.min(event.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
});

// ---------- charts (SVG, drawn here) ----------

function stackedBars(daily, machines) {
  if (!daily.some((d) => d.cost > 0)) {
    return `<div class="empty">${t("Bu davrda sarf yo‘q")}</div>`;
  }

  const width = 900;
  const height = 240;
  const pad = { l: 44, r: 8, t: 10, b: 26 };
  const max = Math.max(0.01, ...daily.map((d) => d.cost));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const w = (width - pad.l - pad.r) / daily.length;
  const y = (v) => pad.t + (height - pad.t - pad.b) * (1 - v / top);
  const byId = new Map(machines.map((m) => [m.id, m]));
  let svg = '';
  for (let v = 0; v <= top + 1e-9; v += step) {
    svg += `<line class="grid-line" x1="${pad.l}" x2="${width - pad.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text class="axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">$${v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v >= 0.01 || v === 0 ? v.toFixed(2) : v.toFixed(4)}</text>`;
  }

  daily.forEach((d, i) => {
    const x = pad.l + i * w;
    let base = 0;
    const parts = Object.entries(d.machines).sort((a, b) => b[1] - a[1]);
    for (const [id, cost] of parts) {
      const m = byId.get(Number(id));
      const y1 = y(base + cost);
      const y0 = y(base);
      svg += `<rect x="${x + w * 0.16}" y="${y1}" width="${w * 0.68}" height="${Math.max(0, y0 - y1)}" rx="2" fill="${h(m?.color ?? '#888')}"/>`;
      base += cost;
    }

    const lines = parts.map(([id, cost]) => `<span class="dot" style="--c:${h(byId.get(Number(id))?.color)}"></span>${h(byId.get(Number(id))?.name ?? '?')}: ${money(cost)}`).join('<br>');
    const tipText = `<b>${dayLabel(d.day)} — ${money(d.cost)}</b>${tokens(d.tokens)} ${t('token')}${som(d.cost) ? ' · ' + som(d.cost) : ''}${lines ? '<br>' + lines : ''}`;
    svg += `<rect class="hit" x="${x}" y="${pad.t}" width="${w}" height="${height - pad.t - pad.b}" data-tip="${h(tipText)}"/>`;
    if (daily.length <= 14 || i % Math.ceil(daily.length / 10) === 0 || i === daily.length - 1) {
      svg += `<text class="axis" x="${x + w / 2}" y="${height - 8}" text-anchor="middle">${dayLabel(d.day)}</text>`;
    }
  });

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${t('Kunlik sarf')}">${svg}</svg>`;
}

function niceStep(max) {
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? power * 10;
}

const MODEL_COLORS = ['#ff7a45', '#9254de', '#36cfc9', '#fadb14', '#40a9ff', '#f759ab', '#73d13d'];

function donut(items, value, label) {
  const total = items.reduce((s, i) => s + value(i), 0) || 1;
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;
  let arcs = '';
  items.forEach((item, index) => {
    const part = value(item) / total;
    if (part <= 0) return;
    const color = MODEL_COLORS[index % MODEL_COLORS.length];
    arcs += `<circle r="${r}" cx="70" cy="70" fill="none" stroke="${color}" stroke-width="22" stroke-dasharray="${part * c} ${c}" stroke-dashoffset="${-offset * c}" transform="rotate(-90 70 70)" data-tip="${h(`<b>${h(label(item))}</b>${(part * 100).toFixed(1)}%`)}"/>`;
    offset += part;
  });
  return `<svg viewBox="0 0 140 140" width="150" height="150" role="img" aria-label="Modellar ulushi"><circle r="${r}" cx="70" cy="70" fill="none" stroke="var(--card-2)" stroke-width="22"/>${arcs}</svg>`;
}

function ring(part, center, sub, color = 'var(--accent)') {
  const r = 46;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, part));
  return `<svg class="ring" viewBox="0 0 108 108" role="img" aria-label="${h(center)}">
    <circle r="${r}" cx="54" cy="54" fill="none" stroke="var(--card-2)" stroke-width="10"/>
    <circle r="${r}" cx="54" cy="54" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="${p * c} ${c}" transform="rotate(-90 54 54)"/>
    <text x="54" y="54" text-anchor="middle" font-size="19">${h(center)}</text>
    <text x="54" y="72" text-anchor="middle" font-size="10" style="fill:var(--faint);font-weight:600">${h(sub)}</text>
  </svg>`;
}

function heatmap(heat) {
  const max = Math.max(0.0001, ...heat.flat());
  const days = ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];
  let html = '<div class="heat"><div class="label"></div>';
  for (let hour = 0; hour < 24; hour++) html += `<div class="label" style="justify-content:center">${hour % 3 === 0 ? hour : ''}</div>`;
  heat.forEach((row, day) => {
    html += `<div class="label">${days[day]}</div>`;
    row.forEach((value, hour) => {
      const alpha = value > 0 ? 0.15 + 0.85 * (value / max) : 0;
      html += `<div style="${alpha ? `background:rgba(255,122,69,${alpha.toFixed(3)})` : ''}" data-tip="${h(`<b>${days[day]}, ${hour}:00</b>${money(value)}`)}"></div>`;
    });
  });
  return html + '</div>';
}

// ---------- pages ----------

function renderLogin(signedOut = false, setup = false) {
  app.innerHTML = `
    <div class="login"><form class="card" id="login-form">
      <img src="/icon.svg" width="44" height="44" alt="">
      <h1>${setup ? t('Claude Monitor’ga xush kelibsiz') : 'Claude Monitor'}</h1>
      <p class="muted">${setup ? t('Panel uchun parol qo‘ying. U faqat shu serverda saqlanadi.') : signedOut ? t('Davom etish uchun parolni kiriting.') : t('Parolni kiriting.')}</p>
      <div class="field"><label for="password">${t("Parol")}</label>
        <input id="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" minlength="${setup ? 8 : 1}" required autofocus></div>
      ${setup ? `<div class="field"><label for="password2">${t("Parolni takrorlang")}</label><input id="password2" type="password" autocomplete="new-password" required></div>` : ''}
      ${setup ? `<div class="field"><label for="setup-code">${t("Sozlash kodi")}</label><input id="setup-code" type="text" autocomplete="off" required spellcheck="false"><span class="hint">${t("Server ishga tushganda oynasida chiqqan 8 belgili kod. Shu kodni bilgan odamgina birinchi parolni qo‘ya oladi.")}</span></div>` : ''}
      <p class="error" id="login-error"></p>
      <button class="btn primary" style="width:100%">${setup ? t('Parolni saqlash') : t('Kirish')}</button>
    </form></div>`;
  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = document.getElementById('password').value;
    const error = document.getElementById('login-error');
    if (setup && password !== document.getElementById('password2').value) {
      error.textContent = t('Parollar bir xil emas.');
      return;
    }

    if (setup && password.length < 8) {
      error.textContent = t('Kamida 8 belgi.');
      return;
    }

    try {
      const body = setup ? { password, code: document.getElementById('setup-code').value } : { password };
      await api(setup ? '/api/setup' : '/api/login', { method: 'POST', body });
      start();
    } catch (e) {
      error.textContent =
        e.status === 429
          ? t('Ko‘p urinish. Bir daqiqadan keyin.')
          : e.status === 403
            ? t('Sozlash kodi noto‘g‘ri: server oynasidagi kodni yozing.')
            : e.status === 409
              ? t('Parol allaqachon qo‘yilgan.')
              : setup
                ? t('Saqlanmadi.')
                : t('Parol noto‘g‘ri.');
    }
  });
}

function shell(content) {
  const tabs = [
    ['overview', t('Umumiy')],
    ['tokens', t('Tokenlar')],
    ['limits', t('Limitlar')],
    ['machines', t('Kompyuterlar')],
    ['sessions', t('Sessiyalar')],
    ['live', t('Jonli oqim')],
    ['settings', t('Sozlamalar')],
  ];
  const alerts = state.data?.alerts?.length ?? 0;
  return `
    <div class="shell">
      <header class="top">
        <div class="brand"><img src="/icon.svg" alt="">Claude Monitor</div>
        <span class="live ${state.live ? 'on' : ''}" title="${state.live ? t('Yangi so‘rovlar darhol ko‘rinadi') : t('Ulanish tiklanmoqda')}"><i></i>${state.live ? t('Jonli') : t('Kutilmoqda')}</span>
        <nav class="tabs" role="tablist">${tabs
          .map(([id, label]) => `<button role="tab" data-tab="${id}" aria-selected="${state.tab === id}">${label}${id === 'overview' && alerts ? ` <span class="pill bad">${alerts}</span>` : ''}</button>`)
          .join('')}</nav>
        <div class="spacer"></div>
        <button class="btn primary" data-action="add-machine" aria-label="${t('Kompyuter qo‘shish')}" title="${t('Kompyuter qo‘shish')}">＋<span class="hide-md"> ${t("Kompyuter qo‘shish")}</span></button>
        <select class="lang-select" data-action="lang" aria-label="Til / Language / Язык">${Object.entries(LANGS).map(([code, name]) => `<option value="${code}" ${code === lang ? 'selected' : ''}>${name}</option>`).join('')}</select>
        <button class="btn icon" data-action="theme" title="${t('Yorug‘ / qorong‘i')}" aria-label="${t('Yorug‘ yoki qorong‘i ko‘rinish')}">◐</button>
      </header>
      ${content}
    </div>`;
}

function kpi(label, totals, extra = '', feature = false) {
  return `<div class="card kpi ${feature ? 'feature' : ''}">
    <div class="label">${label}</div>
    <div class="value">${money(totals.cost)}</div>
    <div class="uzs">${som(totals.cost)}</div>
    <div class="sub"><span>${t('{n} token', { n: tokens(totals.tokens) })}</span><span>${t('{n} so‘rov', { n: count(totals.requests) })}</span><span>${t('{n} sessiya', { n: count(totals.sessions) })}</span>${extra}</div>
  </div>`;
}

function machineCard(m) {
  return `<article class="card machine" style="--c:${h(m.color)}" data-machine="${m.id}" tabindex="0" role="button" aria-label="${h(m.name)}">
    <div class="head"><span class="name">${h(m.name)}</span>${m.paused ? `<span class="pill bad">${t("⏸ To‘xtatilgan")}</span>` : `<span class="status ${m.status}"><i></i>${STATUS[m.status]}</span>`}</div>
    <div class="meta">${[m.os, m.version ? 'v' + m.version : null, m.terminal, m.model].filter(Boolean).map(h).join(' · ') || t('Ma’lumot hali kelmagan')}</div>
    ${accountLine(m.accounts)}
    <div class="nums">
      <div><span>${t("Bugun")}</span><b>${money(m.today.cost)}</b><span class="faint" style="text-transform:none">${tokens(m.today.tokens)}</span></div>
      <div><span>${t("Hafta")}</span><b>${money(m.week.cost)}</b><span class="faint" style="text-transform:none">${tokens(m.week.tokens)}</span></div>
      <div><span>${t('Oy')}</span><b>${money(m.month.cost)}</b><span class="faint" style="text-transform:none">${tokens(m.month.tokens)}</span></div>
    </div>
    <div class="now">${
      m.session
        ? `<span class="pill good">${t("● Sessiya")}</span> ${duration(Date.now() - m.session.started)} · ${money(m.session.cost)}`
        : `<span class="faint">${t('Oxirgi faollik: {when}', { when: ago(m.lastSeen) })}</span>`
    }</div>
    ${
      m.logsOnly?.length
        ? `<div class="faint" style="font-size:12px;margin-top:6px" data-tip="${h(t('Bu sessiyalar telemetriya yubormayapti: ular “setup”dan oldin ochilgan yoki eski token bilan ishlayapti. Sarfi faqat loglardan, 10 daqiqagacha kechikib keladi. O‘sha Claude Code’ni bir marta yopib qayta oching.'))}">⚠ ${t('Telemetriyasiz: {list}', { list: h([...new Set(m.logsOnly.map((s) => s.project ?? '?'))].join(', ')) })}</div>`
        : ''
    }
    ${limitBars(m.limits, m.blocking)}
  </article>`;
}

/** The accounts a computer used this week and what it spent on each: one computer can switch accounts. */
function accountLine(accounts) {
  if (!accounts?.length) return '';
  if (accounts.length === 1) return `<div class="meta">👤 ${h(accountName(accounts[0]))}</div>`;
  return `<div class="meta">👤 ${t('Shu hafta {n} akkaunt:', { n: accounts.length })} ${accounts.map((a) => `${h(accountName(a))} <b>${money(a.cost)}</b>`).join(' · ')}</div>`;
}

/** "2 soat 8 daq", or a day or more away "2 kun 22 soat". */
function until(ms) {
  if (ms <= 0) return t('hozir');
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 24 ? t('{d} kun {h} soat', { d: Math.floor(hours / 24), h: hours % 24 }) : duration(ms);
}

const accountName = (a) => a.email ?? (a.account === 'shared' || !a.account ? t('Hisob') : `${t('Hisob')} ${String(a.account).slice(0, 8)}`);

/** One subscription limit as a ring: how much is used, when it starts again and how long that is. */
function limitRing(title, share, { reset = null, center = null, sub = '', note = '', color = null, forecast = null } = {}) {
  const now = Date.now();
  return `<div class="sub-ring">${ring(share ?? 0, center ?? percent(share), note || t('ishlatildi'), color ?? (share == null ? 'var(--faint)' : shareColor(share)))}
    <div class="sub-text"><div class="sub-title">${h(title)}</div>
      ${reset ? `<div><b>${time(reset, reset - now > 20 * 3_600_000)}</b> <span class="muted">${t("da yangilanadi")}</span></div><div class="faint">${t('{left} qoldi', { left: until(reset - now) })}</div>` : ''}
      ${sub ? `<div class="faint">${sub}</div>` : ''}
      ${paceLine(forecast, reset)}</div></div>`;
}

// Between Anthropic's reports a limit can carry an estimate from the requests since (see liveOf on the server).
const shown = (l) => l.live ?? l.percent;
const liveCenter = (l) => (l.live != null && Math.round(l.live) !== Math.round(l.percent) ? `≈${Math.round(l.live)}%` : null);
const liveNote = (l) =>
  liveCenter(l) ? t('aniq {percent}% ({clock}), keyingi so‘rovlar bilan taxmin', { percent: Math.round(l.percent), clock: clockTime(l.liveSince) }) : '';

/** At the recent pace: when the limit runs out, or that it lasts until it resets. */
function paceLine(forecast, reset) {
  if (!forecast) return '';
  if (forecast.runsOutAt) {
    const soon = forecast.runsOutAt - Date.now();
    return `<div class="pace bad">${t('⚠ shu tezlikda <b>{when}</b> da tugaydi ({left} qoldi)', { when: time(forecast.runsOutAt, soon > 20 * 3_600_000), left: until(soon) })}</div>`;
  }

  return forecast.perHour > 0 && reset ? `<div class="pace good">${t("✓ shu tezlikda yangilanishgacha yetadi")}</div>` : '';
}

/**
 * Who used how much of each limit: a row per computer (and the places the monitor does not see), a column
 * per limit, each cell the computer's part of the account's percentage.
 */
function splitTable(exact) {
  const cols = [
    [t('5 soatlik'), exact.split?.find((s) => s.kind === 'five_hour')],
    [t('Haftalik'), exact.split?.find((s) => s.kind === 'seven_day')],
    [`${t('Oylik')} ≈`, exact.month],
  ].filter(([, s]) => s);
  const machines = new Map();
  for (const [, s] of cols) for (const m of s.machines) if (m.cost > 0) machines.set(m.id, m);
  if (!machines.size) return '';
  const weekly = exact.split?.find((s) => s.kind === 'seven_day');
  const weekCost = (id) => weekly?.machines.find((m) => m.id === id)?.cost ?? 0;
  const order = [...machines.values()].sort((a, b) => weekCost(b.id) - weekCost(a.id));
  const cell = (s, id) => {
    const m = s.machines.find((x) => x.id === id);
    return m?.cost > 0 ? `<td class="num"><b>${percent(m.percent / 100)}</b><div class="faint">${money(m.cost)}</div></td>` : '<td class="num faint">—</td>';
  };
  const others = cols.some(([, s]) => s.others >= 0.5);
  return `<div class="table-wrap"><table class="split-table">
    <tr><th>${t("Kim ishlatdi")}</th>${cols.map(([label]) => `<th class="num">${label}</th>`).join('')}</tr>
    ${order.map((m) => `<tr><td><span class="dot" style="--c:${h(m.color)}"></span>${h(m.name)}</td>${cols.map(([, s]) => cell(s, m.id)).join('')}</tr>`).join('')}
    ${others ? `<tr><td class="muted" title="${t('claude.ai, telefon yoki monitorga ulanmagan kompyuter')}">${t("Boshqa joylar")} <span class="faint">${t("(taxminiy)")}</span></td>${cols.map(([, s]) => `<td class="num muted">${s.others >= 0.5 ? percent(s.others / 100) : '—'}</td>`).join('')}</tr>` : ''}
    <tr class="total"><td><b>${t("Jami")}</b></td>${cols.map(([, s]) => `<td class="num"><b>${percent(s.percent / 100)}</b></td>`).join('')}</tr>
  </table></div>`;
}

/** An account's subscription: the 5-hour and weekly limits, who used them, and the month. */
function accountCard(a, machines) {
  const names = (a.machines ?? []).map((id) => machines.find((m) => m.id === id)?.name).filter(Boolean);
  const head = `<div class="sub-head"><div class="sub-who"><b>👤 ${h(accountName(a))}</b>${names.length ? `<span class="faint">${h(names.join(', '))}</span>` : ''}</div>${a.week != null ? `<span class="pill">${t('Shu hafta {cost}', { cost: money(a.week) })}</span>` : ''}</div>`;
  const exact = a.exact;
  if (exact) {
    const find = (kind) => exact.limits.find((l) => l.kind === kind);
    const resetOf = (l) => (l?.resetsAt ? Date.parse(l.resetsAt) : null);
    const five = find('five_hour');
    const week = find('seven_day');
    const extra = exact.limits.filter((l) => l.kind !== 'five_hour' && l.kind !== 'seven_day');
    const month = exact.month;
    return `<div class="card sub-card">${head}
      <div class="sub-rings">
        ${five ? limitRing(t('5 soatlik sessiya'), shown(five) / 100, { reset: resetOf(five), forecast: five.forecast, center: liveCenter(five), sub: liveNote(five) }) : ''}
        ${week ? limitRing(t('Haftalik'), shown(week) / 100, { reset: resetOf(week), forecast: week.forecast, center: liveCenter(week), sub: liveNote(week) }) : ''}
        ${month ? limitRing(t('Oylik (taxminiy)'), month.percent / 100, { sub: `${dateLabel(month.from)} – ${dateLabel(month.to - 1)}<br>${t('{n} haftalik limitga teng', { n: (month.weekly / 100).toFixed(1) })}`, color: 'var(--info)' }) : ''}
      </div>
      ${extra.map((l) => `<div class="limit-row"><span>${h(t(l.label))}</span><span><b>${percent(l.percent / 100)}</b></span><div class="bar"><i style="width:${Math.min(100, l.percent)}%;--c:${shareColor(l.percent / 100)}"></i></div></div>`).join('')}
      ${splitTable(exact)}
      <p class="faint sub-note">${t('Anthropic’dan {clock} da olindi ({when}), Claude Code’dagi /usage bilan bir xil. Agent foizni har daqiqada so‘raydi, Claude ishlayotganda va undan keyin 10 daqiqa davomida; orada ≈ belgili son har so‘rov bilan hisoblanadi. Yangi 5 soatlik oyna boshida birinchi hisobot 0% bo‘lishi mumkin. Kompyuterning ulushi uning shu davrdagi sarfidan.', { clock: clockTime(exact.ts), when: ago(exact.ts) })}${month ? ' ' + t('Oylik — taxmin: Anthropic’da oylik limit yo‘q, oy {n} haftalik limitga teng deb olinadi.', { n: month.weeks.toFixed(1) }) : ''}</p>
    </div>`;
  }

  // No exact numbers: the open window from the requests, measured against the last 429 when there was one.
  const w = a.window;
  const limit = a.observedWindowLimit;
  const used = w && limit ? w.cost / limit : null;
  const ringHtml = w
    ? limitRing(t('5 soatlik oyna'), used, { reset: w.end, center: used != null ? percent(used) : money(w.cost), note: used != null ? t('taxmin') : t('sarf'), color: used == null ? 'var(--info)' : null, sub: `${t('{time} da ochilgan', { time: time(w.start) })} · ${t('{n} so‘rov', { n: count(w.requests) })}` })
    : limitRing(t('5 soatlik oyna'), null, { center: '—', note: t('yopiq'), sub: t('Keyingi so‘rov yangi oynani boshlaydi') });
  return `<div class="card sub-card">${head}
    <div class="sub-rings">${ringHtml}</div>
    <p class="faint sub-note">${limit ? t('Taxmin oxirgi 429 dan: oyna chegarasi ≈ {cost} ({when}).', { cost: money(limit), when: ago(a.lastHit) }) + ' ' : ''}${t('Aniq foiz va kim qancha ishlatgani uchun shu akkauntdagi kompyuterda bir marta:')} <span class="mono">node agent.mjs usage --server … --token …</span></p>
  </div>`;
}

/** Every account's subscription, the ones with exact numbers first. */
function subscriptionSection(accounts, machines) {
  const list = accounts
    .filter((a) => a.exact || a.machines?.length)
    .sort((a, b) => Number(Boolean(b.exact)) - Number(Boolean(a.exact)) || (b.week ?? 0) - (a.week ?? 0));
  if (!list.length) return '';
  return `<h3 class="section-title">${t("🎯 Obuna limitlari")}</h3><div class="grid sub-grid">${list.map((a) => accountCard(a, machines)).join('')}</div>`;
}

const shareColor = (share) => (share >= 1 ? 'var(--bad)' : share >= 0.8 ? 'var(--warn)' : 'var(--good)');

/** A part of a whole as "12.3%", or "<0.1%" when it is there but small. */
function share(part, whole) {
  if (!whole || !part) return '0%';
  const p = (part / whole) * 100;
  return p < 0.1 ? '<0.1%' : `${p.toFixed(1)}%`;
}

function percent(share) {
  if (share == null) return '—';
  const p = share * 100;
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
}

/** A machine's limits, each as a bar: what it spent of it and when it starts again. */
function limitBars(limits = [], blocking = false) {
  if (!limits.length) return '';
  return `<div class="budget">${limits
    .map(
      (l) => `<div class="limit-row"><span>${h(t('{name} limit', { name: limitLabelText(l.label) }).replace(/^./, (c) => c.toUpperCase()))}</span><span>${l.unit === '%' ? `${l.spent.toFixed(1)}% / ${l.limit}%` : `${money(l.spent)} / ${money(l.limit, 2)}`} · <b>${percent(l.share)}</b></span>
        <div class="bar"><i style="width:${Math.min(100, (l.share ?? 0) * 100)}%;--c:${shareColor(l.share ?? 0)}"></i></div></div>`,
    )
    .join('')}${blocking ? `<div class="faint" style="margin-top:6px">${t("🔒 Limit tugasa promptlar to‘xtatiladi")}</div>` : ''}</div>`;
}

// ---------- tokens by model ----------

const PERIODS = [
  ['today', t('Bugun')],
  ['yesterday', t('Kecha')],
  ['week', t('Shu hafta')],
  ['lastWeek', t('O‘tgan hafta')],
  ['month', t('Shu oy')],
  ['lastMonth', t('O‘tgan oy')],
  ['all', t('Hammasi')],
];

const TOKEN_KINDS = [
  ['input', t('Kiruvchi'), '#40a9ff'],
  ['output', t('Chiquvchi'), '#ff7a45'],
  ['cacheRead', t('Keshdan o‘qish'), '#36cfc9'],
  ['cacheWrite', t('Keshga yozish'), '#9254de'],
];

/** One table: a row per model with each kind of token, the total and the API price. */
function modelTable(models, totals) {
  if (!models.length) return `<div class="empty">${t("Bu davrda so‘rov yo‘q")}</div>`;
  const row = (m, strong = false) => {
    const cell = (value) => `<td class="num">${strong ? `<b>${tokens(value)}</b>` : tokens(value)}<div class="faint exact">${count(value)}</div></td>`;
    return `<tr${strong ? ' class="total"' : ''}><td>${strong ? `<b>${t("Jami")}</b>` : `<span class="dot" style="--c:${MODEL_COLORS[models.indexOf(m) % MODEL_COLORS.length]}"></span>${h(m.label)}`}</td>
      ${cell(m.input)}${cell(m.output)}${cell(m.cacheRead)}${cell(m.cacheWrite)}${cell(m.tokens)}
      <td class="num">${count(m.requests)}</td><td class="num"><b>${money(m.cost)}</b><div class="faint exact">${som(m.cost)}</div></td></tr>`;
  };
  return `<div class="table-wrap"><table class="models">
    <tr><th>${t("Model")}</th>${TOKEN_KINDS.map(([, label, color]) => `<th class="num"><span class="dot" style="--c:${color}"></span>${label}</th>`).join('')}<th class="num">${t("Jami token")}</th><th class="num">${t("So‘rov")}</th><th class="num">${t("API narxi")}</th></tr>
    ${models.map((m) => row(m)).join('')}
    ${models.length > 1 ? row({ ...totals, label: t('Jami') }, true) : ''}
  </table></div>`;
}

/** How each model's tokens split between the kinds, as one stacked bar per model. */
function kindBars(models) {
  return models
    .map((m) => {
      const total = m.tokens || 1;
      return `<div class="kind-row"><div class="kind-head"><span>${h(m.label)}</span><span class="faint">${t('{n} token', { n: tokens(m.tokens) })} · ${money(m.cost)}</span></div>
        <div class="stack">${TOKEN_KINDS.map(([key, label, color]) => (m[key] > 0 ? `<i style="width:${(m[key] / total) * 100}%;background:${color}" data-tip="${h(`<b>${label}</b>${t('{n} token', { n: count(m[key]) })} · ${((m[key] / total) * 100).toFixed(1)}%`)}"></i>` : '')).join('')}</div></div>`;
    })
    .join('');
}

function renderTokens() {
  const u = state.usage;
  const period = state.period;
  const picker = `<div class="segmented" role="group" aria-label="${t('Davr')}">${PERIODS.map(([id, label]) => `<button data-period="${id}" aria-pressed="${period === id}">${label}</button>`).join('')}</div>`;
  if (!u) return `<h3 class="section-title">${t("🔤 Tokenlar")}</h3>${picker}<div class="card empty" style="margin-top:16px">${t("Yuklanmoqda…")}</div>`;
  const tot = u.totals;
  return `
    <div class="title-row"><h3 class="section-title">${t("🔤 Tokenlar")} <span class="pill">${h(t(u.label))}</span></h3>${picker}</div>
    <div class="grid kpis">
      ${TOKEN_KINDS.map(([key, label, color]) => `<div class="card kpi"><div class="label"><span class="dot" style="--c:${color}"></span>${label}</div><div class="value">${tokens(tot[key])}</div><div class="sub"><span>${t('{n} token', { n: count(tot[key]) })}</span><span>${share(tot[key], tot.tokens)}</span></div></div>`).join('')}
    </div>
    <div class="card" style="margin-top:16px"><h2>${t("🧠 Modellar bo‘yicha")} <span class="right">${t('{n} so‘rov', { n: count(tot.requests) })} · ${t('{cost} API narxida', { cost: money(tot.cost) })}</span></h2>${modelTable(u.models, tot)}</div>
    ${u.models.length ? `<div class="card" style="margin-top:16px"><h2>${t("Har modelda token turlari")}</h2>${kindBars(u.models)}<div class="legend">${TOKEN_KINDS.map(([, label, color]) => `<span><i style="--c:${color}"></i>${label}</span>`).join('')}</div></div>` : ''}
    <h3 class="section-title">${t("💻 Kompyuterlar bo‘yicha")}</h3>
    ${
      u.machines.length
        ? u.machines.map((m) => `<div class="card" style="margin-top:16px"><h2><span class="dot" style="--c:${h(m.color)}"></span>${h(m.name)} <span class="right">${t('{n} token', { n: tokens(m.tokens) })} · ${money(m.cost)}</span></h2>${modelTable(m.models, m)}</div>`).join('')
        : `<div class="card empty" style="margin-top:16px">${t("Bu davrda so‘rov yo‘q")}</div>`
    }`;
}

// ---------- windows, weeks and months ----------

function delta(current, previous) {
  if (!previous) return current > 0 ? `<span class="pill">${t("yangi")}</span>` : '';
  const change = (current - previous) / previous;
  const up = change >= 0;
  return `<span class="pill ${up ? 'warn' : 'good'}">${up ? '▲' : '▼'} ${Math.abs(change * 100).toFixed(0)}%</span>`;
}

function compareCard(title, pair) {
  const c = pair.current;
  const p = pair.previous;
  const labels = [...new Set([...c.models, ...p.models].map((m) => m.model))];
  const find = (list, model) => list.find((m) => m.model === model);
  return `<div class="card"><h2>${title}</h2>
    <div class="compare">
      <div><div class="faint">${h(t(c.label))}</div><b>${money(c.totals.cost)}</b><div class="muted">${t('{n} token', { n: tokens(c.totals.tokens) })}</div></div>
      <div class="vs">${delta(c.totals.cost, p.totals.cost)}</div>
      <div><div class="faint">${h(t(p.label))}</div><b class="muted">${money(p.totals.cost)}</b><div class="muted">${t('{n} token', { n: tokens(p.totals.tokens) })}</div></div>
    </div>
    ${
      labels.length
        ? `<div class="table-wrap"><table><tr><th>${t("Model")}</th><th class="num">${h(t(c.label))}</th><th class="num">${h(t(p.label))}</th><th class="num hide-sm">${t("Kiruvchi")}</th><th class="num hide-sm">${t("Chiquvchi")}</th><th class="num hide-sm">${t("Kesh (o‘qish / yozish)")}</th></tr>
          ${labels
            .map((model) => {
              const a = find(c.models, model);
              const b = find(p.models, model);
              return `<tr><td>${h((a ?? b).label)}</td><td class="num">${money(a?.cost ?? 0)} <span class="faint">${tokens(a?.tokens ?? 0)}</span></td><td class="num muted">${money(b?.cost ?? 0)} <span class="faint">${tokens(b?.tokens ?? 0)}</span></td>
                <td class="num faint hide-sm">${tokens(a?.input ?? 0)}</td><td class="num faint hide-sm">${tokens(a?.output ?? 0)}</td><td class="num faint hide-sm">${tokens(a?.cacheRead ?? 0)} / ${tokens(a?.cacheWrite ?? 0)}</td></tr>`;
            })
            .join('')}</table></div>`
        : `<div class="empty">${t("So‘rov yo‘q")}</div>`
    }</div>`;
}

function renderLimits() {
  const w = state.windows;
  if (!w) return `<h3 class="section-title">${t("⏱ Limitlar")}</h3><div class="card empty" style="margin-top:16px">${t("Yuklanmoqda…")}</div>`;
  const names = new Map(w.machines.map((m) => [m.id, m]));
  const basisLimit = w.windows.some((x) => x.basis === 'limit' || x.basis === 'exact' || x.basis === 'reported');
  // With several accounts each window says whose it is: every account has its own windows.
  const manyAccounts = new Set(w.windows.map((x) => x.account)).size > 1;
  const whose = (account) => accountName({ account, email: w.emails?.[account] });
  const rows = w.windows
    .map(
      (x) => `<div class="win ${x.open ? 'open' : ''}">
        <div class="win-time"><b>${time(x.start, true)} – ${time(x.end)}</b>${x.open ? ` <span class="pill good">${t("hozirgi")}</span>` : ''}${manyAccounts ? `<div class="muted">👤 ${h(whose(x.account))}</div>` : ''}<div class="faint">${t('{n} so‘rov', { n: count(x.requests) })} · ${t('{n} token', { n: tokens(x.tokens) })}</div></div>
        <div class="win-bar"><div class="bar big"><i style="width:${Math.min(100, (x.share ?? 0) * 100)}%;--c:${x.basis === 'biggest' ? 'var(--info)' : shareColor(x.share ?? 0)}"></i></div>
          <div class="chips">${x.models.map((m) => `<span class="pill" data-tip="${h(`<b>${h(m.label)}</b>${t('Kiruvchi')} ${count(m.input)}<br>${t('Chiquvchi')} ${count(m.output)}<br>${t('Keshdan o‘qish')} ${count(m.cacheRead)}<br>${t('Keshga yozish')} ${count(m.cacheWrite)}`)}">${h(m.label)} ${money(m.cost)}</span>`).join('')}
          ${Object.entries(x.machines).map(([id, cost]) => `<span class="pill"><span class="dot" style="--c:${h(names.get(Number(id))?.color)}"></span>${h(names.get(Number(id))?.name ?? '?')} ${money(cost)}</span>`).join('')}</div></div>
        <div class="win-num">${x.basis === 'biggest' ? `<b>${money(x.cost)}</b><div class="faint">${t("limit noma’lum")}</div>` : `<b>${percent(x.share)}</b><div>${money(x.cost)}</div>${x.basis === 'reported' ? `<div class="faint">Anthropic</div>` : ''}`}</div>
      </div>`,
    )
    .join('');
  const basisExact = w.windows.some((x) => x.basis === 'exact');
  const basisReported = w.windows.some((x) => x.basis === 'reported');
  const exactCards = w.exact.length
    ? subscriptionSection(w.exact.map((e) => ({ account: e.account, email: e.email, exact: e })), w.machines)
    : `<div class="card" style="margin-top:16px"><p class="muted" style="margin:0">${t('Claude Code’dagi /usage bilan bir xil aniq foiz uchun akkauntga kirgan kompyuterda bir marta {cmd} ni ishga tushiring. Keyin agent foizni o‘zi yuborib turadi (ko‘pi bilan daqiqada bir). Kirish kaliti kompyuterdan chiqmaydi: u faqat Anthropic’ga boradi, serverga faqat foizlar keladi.', { cmd: '<span class="mono">node agent.mjs usage --server … --token …</span>' })}</p></div>`;
  return `
    ${w.exact.length ? '' : `<h3 class="section-title">${t("🎯 Obuna limitlari")} <span class="pill">${t("hali kelmagan")}</span></h3>`}
    ${exactCards}
    <h3 class="section-title">${t("⏱ 5 soatlik oynalar")} <span class="pill">${t("oxirgi 7 kun")}</span></h3>
    <div class="card" style="margin-top:16px">
      <p class="muted" style="margin-top:0;font-size:13px">${
        basisReported ? t('“Anthropic” belgili oynalarda foiz — Anthropic shu oyna uchun bergan oxirgi raqam (/usage dagi kabi). Qolganlari: ') : ''
      }${
        basisExact
          ? t('Foiz: Anthropic bergan joriy oyna foizidan topilgan chegaraga nisbatan, ya’ni har oyna haqiqiy limitning qanchasini ishlatgani.')
          : basisLimit
          ? t('Foiz: oxirgi 429 xatosi (obuna chegarasiga yetilgan payt) dagi oyna sarfiga nisbatan.')
          : t('Limitning foizi hali noma’lum, shuning uchun har oynaning sarfi ko‘rsatiladi (chiziq eng katta oynaga nisbatan). Aniq foiz uchun kompyuterda bir marta: node agent.mjs usage. Birinchi 429 xatosidan keyin ham foiz chiqadi.')
      }</p>
      ${rows || `<div class="empty">${t("Oxirgi 7 kunda so‘rov yo‘q")}</div>`}
    </div>
    <h3 class="section-title">${t("📊 Taqqoslash")}</h3>
    <div class="grid">
      ${compareCard(t('📅 Bugun va kecha'), w.compare.day)}
      ${compareCard(t('🗓 Shu hafta va o‘tgan hafta'), w.compare.week)}
      ${compareCard(t('🧾 Shu oy va o‘tgan oy'), w.compare.month)}
    </div>`;
}

function renderOverview() {
  const d = state.data;
  if (!d.machines.length) {
    return `<div class="card welcome" style="margin-top:24px">
      <img src="/icon.svg" width="56" height="56" alt="">
      <h2>${t("Birinchi kompyuterni ulang")}</h2>
      <p class="muted">${t("Har kompyuterdagi Claude Code o‘z sarfini shu serverga yuboradi: tokenlar, modellar, sessiyalar, xatolar.")}<br>${t("Prompt va kodlar yuborilmaydi.")}</p>
      <button class="btn primary" data-action="add-machine">${t("＋ Kompyuter qo‘shish")}</button>
    </div>`;
  }

  const plan = d.plan;
  const machinesActive = d.machines.filter((m) => m.status === 'active').length;
  const machinesOnline = d.machines.filter((m) => m.status === 'active' || m.status === 'online').length;
  const c = d.counters;
  const lines = (c['lines:added'] ?? 0) + (c['lines:removed'] ?? 0);
  const activeHours = ((c['active_seconds:user'] ?? 0) + (c['active_seconds:cli'] ?? 0)) / 3600;
  const tokenTypes = [
    [t('Kiruvchi'), d.totals.month.input, '#40a9ff'],
    [t('Chiquvchi'), d.totals.month.output, '#ff7a45'],
    [t('Keshdan o‘qish'), d.totals.month.cacheRead, '#36cfc9'],
    [t('Keshga yozish'), d.totals.month.cacheWrite, '#9254de'],
  ];
  const tokenTotal = tokenTypes.reduce((sum, type) => sum + type[1], 0) || 1;
  const cacheShare = d.totals.month.cacheRead / Math.max(1, d.totals.month.input + d.totals.month.cacheRead + d.totals.month.cacheWrite);

  return `
    ${
      d.alerts.length
        ? `<div class="card" style="margin-top:16px"><h2>${t("🔔 Ogohlantirishlar")} <span class="right"><button class="btn small" data-action="alerts-seen">${t("Ko‘rildi")}</button></span></h2>
           <div class="alerts">${d.alerts.map((a) => `<div class="alert"><span>${h(a.message)}</span><span class="when">${ago(a.ts)}</span></div>`).join('')}</div></div>`
        : ''
    }
    ${subscriptionSection(d.accounts, d.machines)}
    <div class="grid kpis">
      ${kpi(t('Bugun'), d.totals.today, `<span>${t('{n} prompt', { n: count(d.totals.today.prompts) })}</span>`)}
      ${kpi(t('Shu hafta'), d.totals.week)}
      ${kpi(t('Shu oy ({date}dan)', { date: dateLabel(plan.start) }), d.totals.month)}
      <div class="card kpi feature">
        <div class="label">${t('{plan} obunasi qiymati', { plan: h(plan.name) })}</div>
        <div class="value">${plan.multiple != null ? '×' + plan.multiple.toFixed(plan.multiple >= 10 ? 0 : 1) : '—'}</div>
        <div class="sub"><span>${t('API narxida {cost}', { cost: money(plan.value) })}</span><span>${t('to‘lov {cost}/oy', { cost: money(plan.price, 0) })}</span></div>
        ${plan.email || plan.account ? `<div class="sub"><span>👤 ${h(accountName(plan))}${plan.chosen ? '' : ` (${t('avtomatik')})`}</span></div>` : ''}
        <div class="bar big" style="margin-top:12px" data-tip="${h(`<b>${money(plan.value)} / ${money(plan.price, 0)}</b>${t('Obuna puli necha marta qaytdi')}`)}"><i style="width:${Math.min(100, (plan.value / Math.max(1, plan.price)) * 100)}%"></i></div>
        <div class="sub"><span>${t('{n} / {total} kompyuter ulangan', { n: machinesOnline, total: d.machines.length })}</span>${machinesActive ? `<span class="pill good">${t('{n} ishlayapti', { n: machinesActive })}</span>` : ''}</div>
      </div>
    </div>

    <div class="card" style="margin-top:16px"><h2>${t("📊 Kunlik sarf (API narxida)")} <span class="right">${t('{n} kun · ustiga olib boring', { n: d.daily.length })}</span></h2>
        ${stackedBars(d.daily, d.machines)}
        <div class="legend">${d.machines.map((m) => `<span><i style="--c:${h(m.color)}"></i>${h(m.name)}</span>`).join('')}</div>
    </div>

    <h3 class="section-title">${t("💻 Kompyuterlar")} <span class="pill">${d.machines.length}</span></h3>
    <div class="grid machines">${d.machines.map(machineCard).join('')}</div>

    <div class="grid thirds" style="margin-top:28px">
      <div class="card"><h2>${t("🧠 Modellar")} <span class="right">${t("shu oy")}</span></h2>
        ${
          d.models.length
            ? `<div class="donut-wrap">${donut(d.models, (m) => m.cost, (m) => m.label)}
               <div class="rows">${d.models
                 .map((m, i) => `<div class="row"><span><span class="dot" style="--c:${MODEL_COLORS[i % MODEL_COLORS.length]}"></span>${h(m.label)}</span><span>${money(m.cost)}</span>
                   <span class="faint" style="grid-column:1/-1;font-size:12px">${t('{n} token', { n: tokens(m.tokens) })} · ${t('{n} so‘rov', { n: count(m.requests) })}</span></div>`)
                 .join('')}</div></div>`
            : `<div class="empty">${t("Hali so‘rov yo‘q")}</div>`
        }
      </div>
      <div class="card"><h2>${t("🔤 Token turlari")} <span class="right">${t('shu oy')} · ${tokens(tokenTotal)}</span></h2>
        <div class="rows">${tokenTypes
          .map(([label, value, color]) => `<div class="row"><span>${label}</span><span>${tokens(value)} <span class="faint">${share(value, tokenTotal)}</span></span><div class="bar"><i style="width:${(value / tokenTotal) * 100}%;--c:${color}"></i></div></div>`)
          .join('')}</div>
        <p class="faint" style="font-size:12px;margin:14px 0 0">${t('Kesh foydasi: kirishning {n}% keshdan o‘qilgan (10 baravar arzon).', { n: (cacheShare * 100).toFixed(0) })}</p>
      </div>
      <div class="card"><h2>${t("⚡ Ish natijasi")} <span class="right">${t("shu oy")}</span></h2>
        ${
          Object.keys(c).some((key) => !key.startsWith('cost') && !key.startsWith('tokens'))
            ? `<div class="stats">
          <div><b>${count(c['lines:added'] ?? 0)}</b><span>${t("qator qo‘shildi")}</span></div>
          <div><b>${count(c['lines:removed'] ?? 0)}</b><span>${t("qator o‘chirildi")}</span></div>
          <div><b>${count(c['commits:'] ?? 0)}</b><span>${t("commit")}</span></div>
          <div><b>${count(c['pull_requests:'] ?? 0)}</b><span>pull request</span></div>
          <div><b>${activeHours.toFixed(1)}</b><span>${t("faol soat")}</span></div>
          <div><b>${count(Object.entries(c).filter(([k]) => k.startsWith('sessions:')).reduce((s, [, v]) => s + v, 0))}</b><span>${t("sessiya")}</span></div>
        </div>
        <p class="faint" style="font-size:12px;margin:14px 0 0">${lines ? t('{n} qator o‘zgardi.', { n: count(lines) }) + ' ' : ''}${t('Telemetriya yoqilgandan beri hisoblanadi.')}</p>`
            : `<div class="empty">${t("Yozilgan qatorlar, commit, PR va faol vaqt telemetriya yoqilgandan keyin keladi (agent \"setup\").")}</div>`
        }
      </div>
    </div>

    <div class="grid halves">
      <div class="card"><h2>${t("🗓 Qaysi soatlarda ishlanadi")} <span class="right">${t('{n} kun', { n: d.daily.length })}, ${h(d.timeZone)}</span></h2>${heatmap(d.heat)}</div>
      <div class="card"><h2>${t("📁 Loyihalar")} <span class="right">${t("shu oy")}</span></h2>
        ${
          d.projects.length
            ? `<div class="table-wrap"><table><tr><th>${t("Loyiha")}</th><th class="num">${t("Sarf")}</th><th class="num">${t("Sessiya")}</th><th class="num hide-sm">${t("Oxirgi")}</th></tr>
               ${d.projects.map((p) => `<tr><td>${h(p.project)}</td><td class="num">${money(p.cost)}</td><td class="num">${count(p.sessions)}</td><td class="num faint hide-sm">${ago(p.last)}</td></tr>`).join('')}</table></div>`
            : `<div class="empty">${t("Loyiha nomlari import qilingan tarixdan va repozitoriy ma’lumotidan keladi.")}</div>`
        }
      </div>
    </div>

    <div class="grid halves">
      <div class="card"><h2>${t("🛠 Asboblar")} <span class="right">${t("shu oy")}</span></h2>
        ${
          d.tools.length
            ? `<div class="table-wrap"><table><tr><th>${t("Asbob")}</th><th class="num">${t("Ishlatildi")}</th><th class="num">${t("Muvaffaqiyat")}</th><th class="num">${t("O‘rtacha")}</th></tr>
               ${d.tools.map((tool) => `<tr><td class="mono">${h(tool.name)}</td><td class="num">${count(tool.uses)}</td><td class="num">${((tool.ok / tool.uses) * 100).toFixed(0)}%</td><td class="num faint">${tool.ms ? (tool.ms / 1000).toFixed(1) + ' s' : '—'}</td></tr>`).join('')}</table></div>`
            : `<div class="empty">${t("Asboblar telemetriya yoqilgandan keyin ko‘rinadi.")}</div>`
        }
      </div>
      <div class="card"><h2>${t("⚠️ Xatolar")} <span class="right">${t("7 kun")}</span></h2>
        ${
          d.errors.length
            ? `<div class="alerts">${d.errors.map((e) => `<div class="alert"><span><b>${h(e.machine)}</b> · ${h(e.name ?? e.kind)} <span class="muted">${h(e.detail ?? '')}</span></span><span class="when">${ago(e.ts)}</span></div>`).join('')}</div>`
            : `<div class="empty">${t("Xato yo‘q 🎉")}</div>`
        }
      </div>
    </div>`;
}

function renderMachines() {
  const d = state.data;
  return `
    <h3 class="section-title">${t("💻 Kompyuterlar")}</h3>
    <div class="card hide-sm" style="margin-top:16px"><div class="table-wrap"><table>
      <tr><th>${t("Kompyuter")}</th><th>${t("Holat")}</th><th class="num">${t("Bugun")}</th><th class="num">${t("Hafta")}</th><th class="num">${t('Oy')}</th><th class="num">${t("Jami")}</th><th class="num">${t("Jami token")}</th><th class="hide-sm">${t("Tizim")}</th><th class="hide-sm">${t("Oxirgi faollik")}</th><th></th></tr>
      ${d.machines
        .map(
          (m) => `<tr>
        <td><span class="dot" style="--c:${h(m.color)}"></span><b>${h(m.name)}</b>${m.note ? `<div class="faint" style="font-size:12px">${h(m.note)}</div>` : ''}</td>
        <td><span class="status ${m.status}" style="margin:0"><i></i>${STATUS[m.status]}</span></td>
        <td class="num">${money(m.today.cost)}</td><td class="num">${money(m.week.cost)}</td><td class="num">${money(m.month.cost)}</td><td class="num">${money(m.all.cost)}</td>
        <td class="num">${tokens(m.all.tokens)}</td>
        <td class="hide-sm faint">${h([m.os, m.version ? 'v' + m.version : null].filter(Boolean).join(' · ') || '—')}</td>
        <td class="hide-sm faint">${ago(m.lastSeen)}${m.ip ? ` · <span class="mono">${h(m.ip)}</span>` : ''}</td>
        <td><button class="btn small" data-machine="${m.id}">${t("Batafsil")}</button></td>
      </tr>`,
        )
        .join('')}
    </table></div>${d.machines.length ? '' : `<div class="empty">${t("Hali kompyuter yo‘q")}</div>`}</div>
    <div class="grid machines only-sm">${d.machines.map(machineCard).join('')}</div>`;
}

function renderSessions() {
  const rows = state.sessions;
  return `
    <h3 class="section-title">${t("💬 Sessiyalar")} <span class="pill">${rows.length}</span></h3>
    <div class="card" style="margin-top:16px">${
      rows.length
        ? `<div class="table-wrap"><table>
      <tr><th>${t("Kompyuter")}</th><th class="hide-sm">${t("Akkaunt")}</th><th>${t("Boshlangan")}</th><th class="num">${t("Davomiyligi")}</th><th class="num">${t("So‘rov")}</th><th class="num">${t("Token")}</th><th class="num">${t("Sarf")}</th><th class="hide-sm">${t("Modellar")}</th><th class="hide-sm">${t("Loyiha")}</th></tr>
      ${rows
        .map(
          (s) => `<tr><td><span class="dot" style="--c:${h(s.color)}"></span>${h(s.machine)}</td><td class="hide-sm faint">${h(s.email ?? (s.account ? accountName(s) : '—'))}</td><td>${time(s.started, true)}</td>
        <td class="num">${duration(s.last - s.started)}</td><td class="num">${count(s.requests)}</td><td class="num">${tokens(s.tokens)}</td><td class="num"><b>${money(s.cost)}</b></td>
        <td class="hide-sm">${s.models.map((m) => `<span class="pill">${h(m)}</span>`).join(' ')}</td><td class="hide-sm faint">${h(s.project ?? '—')}</td></tr>`,
        )
        .join('')}</table></div>`
        : `<div class="empty">${t("Hali sessiya yo‘q")}</div>`
    }</div>`;
}

function feedItem(r) {
  const isNew = !state.feedIds.has(r.id);
  return `<div class="item ${isNew && state.feedIds.size ? 'new' : ''}">
    <span class="t faint mono">${time(r.ts)}</span>
    <span><span class="dot" style="--c:${h(r.color)}"></span><b>${h(r.machine)}</b> · ${h(r.label)}${r.speed === 'fast' ? ` <span class="pill warn">${t("tez")}</span>` : ''}${r.source && r.source !== 'main' ? ` <span class="pill">${h(r.source)}</span>` : ''}
      <span class="faint"> · ${t('{in} kirish → {out} chiqish', { in: tokens(r.input + r.cacheRead + r.cacheWrite), out: tokens(r.output) })}${r.ms ? ` · ${(r.ms / 1000).toFixed(1)} s` : ''}</span></span>
    <b>${money(r.cost)}</b>
  </div>`;
}

function renderLive() {
  const html = `
    <h3 class="section-title">${t("🔴 Jonli oqim")} <span class="pill ${state.live ? 'good' : ''}">${state.live ? 'ulangan' : 'kutilmoqda'}</span></h3>
    <div class="card" style="margin-top:16px"><h2>${t("Har bir API so‘rovi")} <span class="right">oxirgi ${state.feed.length} ta</span></h2>
      <div class="feed">${state.feed.length ? state.feed.map(feedItem).join('') : `<div class="empty">${t("So‘rovlar bu yerda paydo bo‘ladi")}</div>`}</div>
    </div>`;
  state.feedIds = new Set(state.feed.map((r) => r.id));
  return html;
}

function renderSettings() {
  const s = state.settings ?? {};
  const zones = ['Asia/Tashkent', 'Asia/Samarkand', 'Europe/Moscow', 'Europe/Berlin', 'UTC', 'America/New_York'];
  return `
    <h3 class="section-title">${t("⚙️ Sozlamalar")}</h3>
    <form id="settings-form" class="grid halves">
      <div class="card"><h2>${t("Obuna")}</h2>
        <div class="form-grid">
          <div class="field"><label for="planName">${t("Tarif nomi")}</label><input id="planName" type="text" value="${h(s.planName)}"></div>
          <div class="field"><label for="planPrice">Oylik narx ($)</label><input id="planPrice" type="number" min="0" step="1" value="${h(s.planPrice)}"></div>
          <div class="field"><label for="planAccount">${t("Obuna qaysi akkauntniki")}</label><select id="planAccount">
            <option value="">${t("Avtomatik: shu oy eng ko‘p ishlatgani")}</option>
            ${(state.data?.accounts ?? []).filter((a) => a.account !== 'shared').map((a) => `<option value="${h(a.account)}" ${a.account === s.planAccount ? 'selected' : ''}>${h(accountName(a))}</option>`).join('')}
          </select><span class="hint">${t("\"Obuna qiymati\" faqat shu akkauntning sarfini sanaydi")}</span></div>
          <div class="field"><label for="billingDay">${t("To‘lov kuni")}</label><input id="billingDay" type="number" min="1" max="28" value="${h(s.billingDay)}"><span class="hint">${t("Oy shu kundan hisoblanadi")}</span></div>
          <div class="field"><label for="windowHours">${t("Oyna uzunligi (soat)")}</label><input id="windowHours" type="number" min="1" max="24" value="${h(s.windowHours)}"><span class="hint">${t("Pro va Max: 5 soat")}</span></div>
          <div class="field"><label for="usdToUzs">${t('1 $ = so‘m')}</label><input id="usdToUzs" type="number" min="0" step="1" value="${h(s.usdToUzs)}"><span class="hint">${t("0 bo‘lsa so‘m ko‘rsatilmaydi")}</span></div>
          <div class="field"><label for="timeZone">${t("Vaqt mintaqasi")}</label><select id="timeZone">${[...new Set([s.timeZone, ...zones])].map((z) => `<option ${z === s.timeZone ? 'selected' : ''}>${h(z)}</option>`).join('')}</select></div>
          <div class="field"><label for="language">${t("Xabarlar tili")}</label><select id="language">${Object.entries(LANGS).map(([code, name]) => `<option value="${code}" ${code === (s.language || 'en') ? 'selected' : ''}>${name}</option>`).join('')}</select><span class="hint">${t("Ogohlantirishlar, Telegram va Claude Code’da to‘xtatish sababi shu tilda yoziladi")}</span></div>
          <div class="field"><label for="chartDays">${t("Grafikdagi kunlar")}</label><input id="chartDays" type="number" min="7" max="90" value="${h(s.chartDays)}"></div>
        </div>
      </div>
      <div class="card"><h2>${t("Telegram ogohlantirishlari")}</h2>
        <p class="muted" style="margin-top:0;font-size:13px">${t("Kunlik chegara oshganda, obuna chegarasiga yetilganda va yangi kompyuter ulanganda xabar keladi. @BotFather'dan bot oching, unga /start yozing, chat ID'ni @userinfobot beradi.")}</p>
        <div class="field"><label for="telegramToken">${t("Bot tokeni")}</label><input id="telegramToken" type="text" autocomplete="off" value="${h(s.telegramToken)}"></div>
        <div class="field"><label for="telegramChat">Chat ID</label><input id="telegramChat" type="text" value="${h(s.telegramChat)}"></div>
        <button type="button" class="btn" data-action="telegram-test">${t("Sinov xabari")}</button>
        <h2 style="margin-top:22px">${t("Panel paroli")}</h2>
        <div class="field"><label for="currentPassword">${t("Hozirgi parol")}</label><input id="currentPassword" type="password" autocomplete="current-password" placeholder="${t('faqat parolni o‘zgartirganda kerak')}"></div>
        <div class="field"><label for="newPassword">${t("Yangi parol")}</label><input id="newPassword" type="password" autocomplete="new-password" minlength="8" placeholder="${t('o‘zgartirmaslik uchun bo‘sh qoldiring')}"></div>
      </div>
      <div class="card" style="grid-column:1/-1;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn primary">${t("Saqlash")}</button>
        <a class="btn" href="/api/export.csv?days=30">${t("⬇ CSV (30 kun)")}</a>
        <a class="btn" href="/api/export.csv?days=3650">${t("⬇ CSV (hammasi)")}</a>
        <span class="spacer"></span>
        <button type="button" class="btn danger" data-action="logout">${t("Chiqish")}</button>
      </div>
    </form>`;
}

function render() {
  if (!state.data) return;
  const pages = { overview: renderOverview, tokens: renderTokens, limits: renderLimits, machines: renderMachines, sessions: renderSessions, live: renderLive, settings: renderSettings };
  const scroll = window.scrollY;
  app.innerHTML = shell((pages[state.tab] ?? renderOverview)());
  window.scrollTo(0, scroll);
  if (state.tab === 'settings') bindSettings();
}

// ---------- machine dialogs ----------

function serverUrl() {
  return stored('serverUrl') || location.origin;
}

function setupGuide(token, name) {
  const server = serverUrl();
  const short = token ?? 'cm_…';
  const json = JSON.stringify(
    {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: server,
        OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${short}`,
        OTEL_METRIC_EXPORT_INTERVAL: '30000',
        OTEL_METRICS_INCLUDE_REPOSITORY: 'true',
      },
    },
    null,
    2,
  );
  const code = (text) => `<pre class="code"><button type="button" class="btn small copy" data-copy="${h(text)}">${t("Nusxa")}</button>${h(text)}</pre>`;
  return `
    <div class="field"><label for="server-url">${t("Server manzili (kompyuterlar shu manzilga yuboradi)")}</label>
      <input id="server-url" type="url" value="${h(server)}"><span class="hint">${t("Boshqa kompyuterdan ochiladigan manzil bo‘lsin: masalan http://192.168.1.10:4318 yoki serverning domeni. \"localhost\" faqat shu kompyuterning o‘zida ishlaydi.")}</span></div>
    <div class="steps">
      <h4>${t("Agentni yuklab oling (Node.js kerak)")}</h4>
      <p class="muted" style="margin:4px 0 0;font-size:13px">${t("Windows (PowerShell):")}</p>
      ${code(`curl.exe -o agent.mjs ${server}/agent.mjs`)}
      <p class="muted" style="margin:0;font-size:13px">${t("macOS / Linux:")}</p>
      ${code(`curl -o agent.mjs ${server}/agent.mjs`)}
      <h4>${t("Ulang")}</h4>
      ${code(`node agent.mjs setup --server ${server} --token ${short}${name ? ` --name ${name.replace(/[^A-Za-z0-9._-]/g, '_')}` : ''}`)}
      <p class="muted" style="margin:0;font-size:13px">${t("Bu telemetriyani va limit tekshiruvini yoqadi hamda o‘tgan sarfni ham yuboradi.")}</p>
      <h4>${t("Claude Code’ni qayta oching")}</h4>
      <p class="muted" style="margin:4px 0 0;font-size:13px">${t("Shu bilan tamom: birinchi so‘rovdan keyin kompyuter panelda \"Ishlayapti\" bo‘ladi.")}</p>
      <p class="faint" style="margin:4px 0 0;font-size:12px">${t("Ochiq turgan har bir Claude Code oynasini qayta oching: eskilari telemetriyani yubormaydi va kartada “Telemetriyasiz” deb ko‘rinadi.")}</p>
      <h4>${t("Keyin yangilash")}</h4>
      ${code(`node agent.mjs update`)}
      <p class="muted" style="margin:0;font-size:13px">${t("Yangi agent.mjs ni yuqoridagidek yuklab oling va shuni ishga tushiring: server va token o‘zgarmaydi. Agent o‘zini o‘zi faqat “setup --auto-update” bilan yangilaydi.")}</p>
    </div>
    <details style="margin-top:16px"><summary class="muted">${t("Agentsiz, qo‘lda: ~/.claude/settings.json")}</summary>
      ${code(json)}
      <p class="faint" style="font-size:12px">${t("Windows'da fayl: %USERPROFILE%\\\\.claude\\\\settings.json. Bor \"env\" bo‘limiga qo‘shing. Loyiha ichidagi .claude/settings.json ishlamaydi: Claude Code telemetriyani faqat foydalanuvchi sozlamasidan oladi.")}</p>
    </details>`;
}

function openDialog(html, wide = false) {
  const dialog = document.createElement('dialog');
  if (wide) dialog.classList.add('wide');
  dialog.innerHTML = html;
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
  });
  dialog.addEventListener('input', (event) => {
    if (event.target.id === 'server-url') {
      stored('serverUrl', event.target.value.replace(/\/+$/, ''));
    }
  });
  dialog.addEventListener('change', (event) => {
    if (event.target.id === 'server-url') {
      const token = dialog.dataset.token;
      dialog.querySelector('.guide').innerHTML = setupGuide(token || null, dialog.dataset.name);
    }
  });
  dialog.showModal();
  return dialog;
}

function addMachine() {
  const dialog = openDialog(`
    <div class="modal-head"><h2>${t("Kompyuter qo‘shish")}</h2><span class="spacer"></span><button class="btn icon" data-close aria-label="Yopish">✕</button></div>
    <form class="modal-body" id="add-form">
      <div class="form-grid">
        <div class="field"><label for="m-name">${t("Nomi")}</label><input id="m-name" type="text" required maxlength="60" placeholder="masalan: Ish-noutbuk"></div>
        <div class="field"><label for="m-budget">Kunlik chegara, $ (ixtiyoriy)</label><input id="m-budget" type="number" min="0" step="0.5" placeholder="${t('masalan 20')}"></div>
      </div>
      <p class="error" id="add-error"></p>
      <button class="btn primary">${t("Token yaratish")}</button>
    </form>`);
  dialog.querySelector('#add-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = dialog.querySelector('#m-name').value.trim();
    try {
      const result = await api('/api/machines', { method: 'POST', body: { name, budget: dialog.querySelector('#m-budget').value } });
      dialog.dataset.token = result.token;
      dialog.dataset.name = name;
      dialog.querySelector('.modal-body').outerHTML = `<div class="modal-body">
        <p>${t('{name} uchun token tayyor. U faqat hozir ko‘rsatiladi, uni saqlab qo‘ying:', { name: `<b>${h(name)}</b>` })}</p>
        <div class="token-box">${h(result.token)}</div>
        <div class="guide" style="margin-top:18px">${setupGuide(result.token, name)}</div>
      </div>`;
      refresh();
    } catch (e) {
      dialog.querySelector('#add-error').textContent = e.status === 409 ? t('Bu nom band.') : t('Saqlanmadi.');
    }
  });
}

async function openMachine(id) {
  const detail = await api(`/api/machines/${id}`);
  const m = detail.machine;
  const card = state.data.machines.find((x) => x.id === id);
  const c = detail.counters;
  let allowed = null;
  try {
    allowed = m.allowed_models ? JSON.parse(m.allowed_models) : null;
  } catch {
    allowed = null;
  }

  const dialog = openDialog(
    `
    <div class="modal-head"><span class="dot" style="--c:${h(m.color)};width:14px;height:14px"></span><h2>${h(m.name)}</h2>
      <span class="status ${card?.status}" style="margin-left:6px"><i></i>${STATUS[card?.status] ?? ''}</span>
      <span class="spacer"></span><button class="btn icon" data-close aria-label="Yopish">✕</button></div>
    <div class="modal-body">
      <div class="grid kpis" style="margin-top:0">
        <div class="card kpi"><div class="label">${t("30 kun")}</div><div class="value">${money(detail.totals.cost)}</div><div class="uzs">${som(detail.totals.cost)}</div><div class="sub"><span>${t('{n} token', { n: tokens(detail.totals.tokens) })}</span></div></div>
        <div class="card kpi"><div class="label">${t("So‘rovlar")}</div><div class="value">${count(detail.totals.requests)}</div><div class="sub"><span>${t('{n} sessiya', { n: count(detail.totals.sessions) })}</span></div></div>
        <div class="card kpi"><div class="label">${t("Kod")}</div>${
          c['lines:added'] || c['lines:removed']
            ? `<div class="value">+${count(c['lines:added'] ?? 0)}</div><div class="sub"><span>${t('−{n} qator', { n: count(c['lines:removed'] ?? 0) })}</span><span>${t('{n} commit', { n: count(c['commits:'] ?? 0) })}</span></div>`
            : `<div class="value muted">—</div><div class="sub"><span>${t("telemetriyadan keladi")}</span></div>`
        }</div>
        <div class="card kpi"><div class="label">${t("Tizim")}</div><div class="value" style="font-size:18px">${h(m.os ?? '—')}</div><div class="sub"><span>${h(m.version ? 'Claude Code ' + m.version : '')}</span><span>${h(m.terminal ?? '')}</span></div></div>
      </div>
      <div class="card" style="margin-top:16px"><h3>${t("Kunlik sarf")} <span class="right">${t("30 kun")}</span></h3>${stackedBars(
        detail.daily.map((d) => ({ ...d, machines: { [m.id]: d.cost } })),
        [{ id: m.id, color: m.color, name: m.name }],
      )}</div>
      <div class="grid halves">
        <div class="card"><h3>${t("Modellar")}</h3><div class="rows">${
          detail.models.map((x) => `<div class="row"><span>${h(x.label)}</span><span>${money(x.cost)} <span class="faint">${tokens(x.tokens)}</span></span></div>`).join('') || '<div class="empty">—</div>'
        }</div></div>
        <div class="card"><h3>${t("Oxirgi sessiyalar")}</h3><div class="rows">${
          detail.sessions
            .slice(0, 8)
            .map((s) => `<div class="row"><span>${time(s.started, true)} <span class="faint">· ${duration(s.last - s.started)} · ${h(s.project ?? '')}</span></span><span>${money(s.cost)}</span></div>`)
            .join('') || '<div class="empty">—</div>'
        }</div></div>
      </div>
      <div class="card pause-card ${m.paused ? 'paused' : ''}" style="margin-top:16px">
        <div><b>${m.paused ? t('⏸ Claude Code to‘xtatilgan') : t('▶ Claude Code ishlayapti')}</b>
          <div class="faint">${m.paused ? t('Bu kompyuterda yangi promptlar bajarilmaydi.') : t('To‘xtatilsa, bu kompyuterda Claude darhol to‘xtaydi: yangi prompt ham, yozilayotgan javobning keyingi qadami ham bajarilmaydi (agent "setup"/"update" qilingan bo‘lishi kerak).')}</div></div>
        <button type="button" class="btn ${m.paused ? 'primary' : 'danger'}" data-machine-action="pause">${m.paused ? t('▶ Davom ettirish') : t('⏸ Claude’ni to‘xtatish')}</button>
      </div>
      <form class="card" id="machine-form" style="margin-top:16px"><h3>${t("Sozlamalar")}</h3>
        <div class="form-grid">
          <div class="field"><label for="e-name">${t("Nomi")}</label><input id="e-name" type="text" value="${h(m.name)}" maxlength="60" required></div>
          <div class="field"><label for="e-note">${t("Izoh")}</label><input id="e-note" type="text" value="${h(m.note ?? '')}" maxlength="300"></div>
          <div class="field"><label for="e-color">${t("Rangi")}</label><input id="e-color" type="color" value="${h(m.color)}" class="color-input"></div>
        </div>
        <h3 style="margin-top:8px">${t("Limitlar")} <span class="right">${t('API narxida, $ · bo‘sh = limitsiz')}</span></h3>
        <div class="form-grid four">
          <div class="field"><label for="e-budget">${t("Kunlik")}</label><input id="e-budget" type="number" min="0" step="0.5" value="${h(m.daily_budget ?? '')}"></div>
          <div class="field"><label for="e-window">${t("5 soatlik oyna")}</label><input id="e-window" type="number" min="0" step="0.5" value="${h(m.limit_window ?? '')}"></div>
          <div class="field"><label for="e-week">${t("Haftalik")}</label><input id="e-week" type="number" min="0" step="1" value="${h(m.limit_week ?? '')}"></div>
          <div class="field"><label for="e-month">${t("Oylik")}</label><input id="e-month" type="number" min="0" step="1" value="${h(m.limit_month ?? '')}"></div>
        </div>
        <h3 style="margin-top:8px">${t("Obuna foizida")} <span class="right">${t('akkaunt limitining necha foizi · bo‘sh = limitsiz')}</span></h3>
        <div class="form-grid">
          <div class="field"><label for="e-five-pct">${t("5 soatlik sessiyadan, %")}</label><input id="e-five-pct" type="number" min="0" max="100" step="1" placeholder="masalan 20" value="${h(m.limit_five_pct ?? '')}"></div>
          <div class="field"><label for="e-week-pct">${t("Haftalikdan, %")}</label><input id="e-week-pct" type="number" min="0" max="100" step="1" placeholder="${t('masalan 15')}" value="${h(m.limit_week_pct ?? '')}"><span class="hint">${t("Anthropic’ning aniq foizi kerak (node agent.mjs usage).")}</span></div>
        </div>
        ${
          detail.accounts.length
            ? `<div class="field"><label for="e-account">${t("Limitlar qaysi akkauntdagi sarfni sanaydi")}</label><select id="e-account">
                <option value="">${t("Hamma akkauntlar")}</option>
                ${detail.accounts.map((a) => `<option value="${h(a.account)}" ${a.account === m.limit_account ? 'selected' : ''}>${h(accountName(a))}${a.cost ? ` · ${t('30 kunda {cost}', { cost: money(a.cost) })}` : ''}</option>`).join('')}
              </select><span class="hint">${t("Masalan, do‘stingiz bu kompyuterda o‘z akkauntini ham ishlatsa, sizning akkauntingizni tanlang: limit va to‘xtatish faqat unga qo‘llanadi.")}</span></div>`
            : ''
        }
        <h3 style="margin-top:8px">${t("Modellar va effort")} <span class="right">${t('hammasi belgilansa = cheklovsiz')}</span></h3>
        <div class="model-picks">${MODEL_FAMILIES.map(([family, label]) => `<label class="check inline"><input type="checkbox" name="e-model" value="${family}" ${!allowed || allowed.includes(family) ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div>
        <div class="field"><label for="e-effort">${t("Effort chegarasi")}</label><select id="e-effort">
          ${EFFORT_LEVELS.map(([level, label]) => `<option value="${level}" ${(m.max_effort ?? 'max') === level ? 'selected' : ''}>${t(label)}</option>`).join('')}
        </select><span class="hint">${t("Agent bularni Claude Code sozlamasiga yozadi (availableModels, maxEffortLevel): ruxsat etilmagan modelga o‘tib bo‘lmaydi, effort chegaradan oshmaydi. Har prompt va asbob oldidan ham tekshiriladi. Claude Code 2.1.251+ kerak.")}</span></div>
        <label class="check"><input id="e-block" type="checkbox" ${m.limit_block ? 'checked' : ''}>
          <span><b>${t("Limit tugasa promptlarni to‘xtatish")}</b><br><span class="faint">${t("Claude Code har prompt oldidan serverdan so‘raydi (agent \"setup\" o‘rnatgan hook). Belgilanmasa, faqat 80% va 100% da ogohlantirish keladi. Server ishlamasa, promptlar to‘xtatilmaydi.")}</span></span></label>
        ${limitBars(card?.limits ?? [], false)}
        <p class="faint" style="font-size:12px">${t("Token:")} <span class="mono">${h(m.token_hint)}</span> · ${t('qo‘shilgan {when}', { when: time(m.created_at, true) })}${m.email ? ` · ${h(m.email)}` : ''}${m.last_ip ? ` · IP <span class="mono">${h(m.last_ip)}</span>` : ''}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary">${t("Saqlash")}</button>
          <button type="button" class="btn" data-machine-action="guide">${t("Ulash yo‘riqnomasi")}</button>
          <button type="button" class="btn" data-machine-action="share">${t("🔗 Ko‘rish havolasi")}</button>
          <button type="button" class="btn" data-machine-action="token">${t("Yangi token")}</button>
          <button type="button" class="btn" data-machine-action="toggle" title="${t('Kuzatish o‘chirilsa, server bu kompyuterdan ma’lumot olmaydi; Claude Code esa ishlayveradi')}">${m.disabled ? t('Kuzatishni yoqish') : t('Kuzatishni o‘chirish')}</button>
          <span class="spacer"></span>
          <button type="button" class="btn danger" data-machine-action="delete">${t("O‘chirish")}</button>
        </div>
        <div class="guide" style="margin-top:12px"></div>
      </form>
    </div>`,
    true,
  );

  dialog.querySelector('#machine-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const picked = [...dialog.querySelectorAll('input[name="e-model"]:checked')].map((input) => input.value);
    if (picked.length === 0) {
      toast(t('Kamida bitta modelni belgilang (Claude’ni butunlay to‘xtatish uchun “To‘xtatish” bor)'));
      return;
    }

    try {
      await api(`/api/machines/${id}`, {
        method: 'PATCH',
        body: {
          name: dialog.querySelector('#e-name').value,
          budget: dialog.querySelector('#e-budget').value,
          limitWindow: dialog.querySelector('#e-window').value,
          limitWeek: dialog.querySelector('#e-week').value,
          limitMonth: dialog.querySelector('#e-month').value,
          limitBlock: dialog.querySelector('#e-block').checked,
          limitFivePct: dialog.querySelector('#e-five-pct').value,
          limitWeekPct: dialog.querySelector('#e-week-pct').value,
          ...(dialog.querySelector('#e-account') ? { limitAccount: dialog.querySelector('#e-account').value } : {}),
          color: dialog.querySelector('#e-color').value,
          note: dialog.querySelector('#e-note').value,
          allowedModels: picked.length === MODEL_FAMILIES.length ? null : picked,
          maxEffort: dialog.querySelector('#e-effort').value,
        },
      });
      toast(t('Saqlandi'));
      dialog.close();
      refresh();
    } catch (e) {
      toast(e.status === 409 ? t('Bu nom band') : t('Saqlanmadi'));
    }
  });

  dialog.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-machine-action]')?.dataset.machineAction;
    if (!action) return;
    if (action === 'guide') {
      dialog.querySelector('.guide').innerHTML = setupGuide(null, m.name);
    }

    if (action === 'token' && confirm(t('Eski token ishlamay qoladi va kompyuterda qayta "setup" qilish kerak bo‘ladi. Davom etasizmi?'))) {
      const { token } = await api(`/api/machines/${id}/token`, { method: 'POST' });
      dialog.dataset.token = token;
      dialog.querySelector('.guide').innerHTML = `<p>${t("Yangi token (faqat hozir ko‘rinadi):")}</p><div class="token-box">${h(token)}</div><div style="margin-top:14px">${setupGuide(token, m.name)}</div>`;
    }

    if (action === 'share' || action === 'share-new' || action === 'share-off') {
      const current = action === 'share' ? m.share_token : null;
      const share = action === 'share-off' ? (await api(`/api/machines/${id}/share`, { method: 'DELETE' }), null) : current ?? (await api(`/api/machines/${id}/share`, { method: 'POST' })).share;
      m.share_token = share;
      const url = share ? `${serverUrl()}/share/${share}` : null;
      dialog.querySelector('.guide').innerHTML = url
        ? `<p>${t('Shu havolani ochgan odam parolsiz faqat {name} ning sarfini, limitlarini va akkaunt limitidagi ulushini ko‘radi. Boshqa kompyuterlar ko‘rinmaydi.', { name: `<b>${h(m.name)}</b>` })}</p>
           <pre class="code"><button type="button" class="btn small copy" data-copy="${h(url)}">${t("Nusxa")}</button>${h(url)}</pre>
           <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn small" data-machine-action="share-new">${t("Yangi havola (eskisi ishlamay qoladi)")}</button><button type="button" class="btn small danger" data-machine-action="share-off">${t("Havolani o‘chirish")}</button></div>`
        : `<p class="muted">${t("Havola o‘chirildi: endi u ochilmaydi.")}</p>`;
    }

    if (action === 'pause') {
      await api(`/api/machines/${id}`, { method: 'PATCH', body: { paused: !m.paused } });
      toast(m.paused ? t('Davom ettirildi') : t('To‘xtatildi: Claude keyingi qadamda to‘xtaydi'));
      dialog.close();
      refresh();
    }

    if (action === 'toggle') {
      await api(`/api/machines/${id}`, { method: 'PATCH', body: { disabled: !m.disabled } });
      dialog.close();
      refresh();
    }

    if (action === 'delete' && confirm(t('"{name}" va uning butun tarixi o‘chiriladi. Davom etasizmi?', { name: m.name }))) {
      await api(`/api/machines/${id}`, { method: 'DELETE' });
      dialog.close();
      toast(t('O‘chirildi'));
      refresh();
    }
  });
}

// ---------- settings ----------

function bindSettings() {
  const form = document.getElementById('settings-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = {};
    for (const key of ['language', 'planName', 'planPrice', 'planAccount', 'billingDay', 'usdToUzs', 'windowHours', 'timeZone', 'chartDays', 'telegramToken', 'telegramChat', 'newPassword', 'currentPassword']) {
      body[key] = form.querySelector('#' + key).value;
    }

    try {
      await api('/api/settings', { method: 'PUT', body });
      toast(t('Saqlandi'));
      await loadSettings();
      refresh();
    } catch (e) {
      const error = e.data?.error;
      // A number out of its range names its field.
      const field = error && form.querySelector(`label[for="${error}"]`)?.textContent;
      if (field && error !== 'timeZone') return toast(t('Bu qiymat noto‘g‘ri: {name}', { name: field }));
      toast(error === 'currentPassword' ? t('Hozirgi parol noto‘g‘ri') : error === 'wait' ? t('Juda ko‘p urinish: bir daqiqa kuting') : error === 'password' ? t('Parol kamida 8 belgi') : error === 'timeZone' ? t('Vaqt mintaqasi noto‘g‘ri') : t('Saqlanmadi'));
    }
  });
}

async function loadTab(tab) {
  if (tab === 'sessions') state.sessions = await api('/api/sessions?limit=200');
  if (tab === 'settings' && !state.settings) await loadSettings();
  if (tab === 'tokens') state.usage = await api(`/api/usage?period=${state.period}`);
  if (tab === 'limits') state.windows = await api('/api/windows?days=7');
}

async function loadSettings() {
  state.settings = await api('/api/settings');
}

// ---------- data ----------

let refreshing = null;

async function refresh(force = false) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const [data, feed] = await Promise.all([api('/api/overview'), api('/api/requests?limit=60')]);
      state.data = data;
      state.feed = feed;
      await loadTab(state.tab);
      // Not while a dialog is open or a settings field is being typed in: it would be redrawn under the cursor.
      const typing = document.activeElement?.closest?.('#settings-form');
      if (!document.querySelector('dialog[open]') && (!typing || force)) render();
    } catch (error) {
      // A lost connection is retried by the next round; signing in shows its own page.
      if (error.message !== 'signin') console.error(error);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 1200);
}

function connect() {
  const source = new EventSource('/api/stream');
  const show = (live) => {
    state.live = live;
    const badge = document.querySelector('.live');
    if (badge) {
      badge.classList.toggle('on', live);
      badge.lastChild.textContent = live ? t('Jonli') : t('Kutilmoqda');
    }
  };
  source.onopen = () => show(true);
  source.onerror = () => {
    show(false);
    // A dropped link is retried by the browser itself; an answer like 401 (the session ended, the server was
    // updated) closes the stream for good, so a new one is opened: after signing in again it is live at once.
    if (source.readyState === EventSource.CLOSED) setTimeout(connect, 5000);
  };
  source.addEventListener('requests', refreshSoon);
  source.addEventListener('machines', refreshSoon);
}

/**
 * Copies text. The clipboard API works only on HTTPS or localhost; a server reached over plain HTTP (the home
 * network, Tailscale) gets the older way.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Try the older way.
  }

  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  (document.querySelector('dialog[open]') ?? document.body).append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }

  area.remove();
  return ok;
}

// ---------- events ----------

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('[data-tab]')?.dataset.tab;
  if (tab) {
    state.tab = tab;
    stored('tab', tab);
    await loadTab(tab);
    render();
    window.scrollTo(0, 0);
    return;
  }

  const period = event.target.closest('[data-period]')?.dataset.period;
  if (period) {
    state.period = period;
    stored('period', period);
    state.usage = await api(`/api/usage?period=${period}`);
    render();
    return;
  }

  const copy = event.target.closest('[data-copy]');
  if (copy) {
    toast((await copyText(copy.dataset.copy)) ? t('Nusxalandi') : t('Nusxa olinmadi: matnni belgilab, Ctrl+C bosing'));
    return;
  }

  const machine = event.target.closest('[data-machine]');
  if (machine && !event.target.closest('dialog')) {
    openMachine(Number(machine.dataset.machine));
    return;
  }

  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'add-machine') addMachine();
  if (action === 'theme') {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    stored('theme', next);
  }

  if (action === 'alerts-seen') {
    await api('/api/alerts/seen', { method: 'POST' });
    refresh();
  }

  if (action === 'telegram-test') {
    const result = await api('/api/telegram-test', { method: 'POST' });
    toast(
      result.ok
        ? t('Yuborildi: Telegram’ni tekshiring')
        : result.error === 'not-set'
          ? t('Avval bot tokeni va chat ID ni saqlang')
          : t('Telegram qabul qilmadi: {error}', { error: result.error }),
    );
  }

  if (action === 'logout') {
    await api('/api/logout', { method: 'POST' });
    renderLogin(true);
  }
});

// The language menu in the header: the page is drawn again in the chosen language.
document.addEventListener('change', (event) => {
  if (event.target.matches?.('[data-action="lang"]')) setLang(event.target.value);
});

document.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('article[data-machine]')) {
    event.preventDefault();
    openMachine(Number(event.target.dataset.machine));
  }
});

// ---------- start ----------

async function start() {
  document.documentElement.lang = lang;
  const saved = stored('theme');
  if (saved) document.documentElement.dataset.theme = saved;
  const { hasPassword, signedIn } = await api('/api/state');
  if (!hasPassword) return renderLogin(false, true);
  if (!signedIn) return renderLogin();
  await loadTab(state.tab);
  await refresh(true);
  if (!start.connected) {
    start.connected = true;
    connect();
    setInterval(refresh, 30_000);
  }
}

start();
