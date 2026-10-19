// One machine's own page, opened with its share link: its spending, its limits and its part of the account's
// limits. Read-only; it asks /api/share/<link> every 30 seconds.

import { t, lang, LANGS, setLang, MONTHS } from './i18n.js';

const app = document.getElementById('app');
const link = location.pathname.split('/').pop();
let data = null;

const h = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A limit's label in the page's language: the server's names, and "N soatlik" for a window of any length. */
const limitLabelText = (label) => {
  const hours = /^(\d+) soatlik$/.exec(label)?.[1];
  return hours && hours !== '5' ? t('{n} soatlik', { n: hours }) : t(label);
};

function money(value) {
  const n = Number(value) || 0;
  const d = n !== 0 && Math.abs(n) < 1 ? (Math.abs(n) < 0.01 ? 4 : 3) : 2;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function tokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return t('{n} mlrd', { n: (n / 1e9).toFixed(2) });
  if (n >= 1e6) return t('{n} mln', { n: (n / 1e6).toFixed(1) });
  if (n >= 1e3) return t('{n} ming', { n: (n / 1e3).toFixed(1) });
  return String(Math.round(n));
}

const percent = (share) => (share == null ? '—' : share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`);
const shareColor = (share) => (share >= 1 ? 'var(--bad)' : share >= 0.8 ? 'var(--warn)' : 'var(--good)');

function time(ts, withDay = false) {
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: data?.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts));
  if (!withDay) return clock;
  const [, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: data?.timeZone }).format(new Date(ts)).split('-').map(Number);
  return lang === 'uz' ? `${day}-${MONTHS[month - 1]} ${clock}` : `${day} ${MONTHS[month - 1]} ${clock}`;
}

function until(ms) {
  if (ms <= 0) return t('hozir');
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t('{n} daq', { n: minutes });
  const hours = Math.floor(minutes / 60);
  return hours >= 24 ? t('{d} kun {h} soat', { d: Math.floor(hours / 24), h: hours % 24 }) : t('{h} soat {m} daq', { h: hours, m: minutes % 60 });
}

function ring(part, center, sub, color) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, part));
  return `<svg class="ring" viewBox="0 0 108 108" role="img" aria-label="${h(center)}">
    <circle r="${r}" cx="54" cy="54" fill="none" stroke="var(--card-2)" stroke-width="10"/>
    <circle r="${r}" cx="54" cy="54" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${p * c} ${c}" transform="rotate(-90 54 54)"/>
    <text x="54" y="54" text-anchor="middle" font-size="19">${h(center)}</text>
    <text x="54" y="72" text-anchor="middle" font-size="10" style="fill:var(--faint);font-weight:600">${h(sub)}</text>
  </svg>`;
}

/** The last two weeks, a bar a day. */
function bars(daily) {
  const max = Math.max(0.01, ...daily.map((d) => d.cost));
  return `<div class="share-bars">${daily
    .map((d) => {
      const [, m, day] = d.day.split('-');
      return `<div class="share-bar" title="${Number(day)}.${m}: ${money(d.cost)}"><i style="height:${(d.cost / max) * 100}%"></i><span>${Number(day)}</span></div>`;
    })
    .join('')}</div>`;
}

function render() {
  const m = data.machine;
  const kpi = (label, total) => `<div class="card kpi"><div class="label">${label}</div><div class="value">${money(total.cost)}</div><div class="sub"><span>${t('{n} token', { n: tokens(total.tokens) })}</span><span>${t('{n} so‘rov', { n: total.requests })}</span></div></div>`;
  const shares = data.shares
    .map(
      (account) => `<div class="card sub-card"><div class="sub-head"><div class="sub-who"><b>👤 ${h(account.email ?? t('Akkaunt'))}</b><span class="faint">${t('Bu kompyuterning ulushi')}</span></div></div>
        <div class="sub-rings">${account.limits
          .map((l) => {
            const reset = l.resetsAt ? Date.parse(l.resetsAt) : null;
            return `<div class="sub-ring">${ring(l.mine / 100, percent(l.mine / 100), t('sizniki'), shareColor(l.total / 100))}
              <div class="sub-text"><div class="sub-title">${h(t(l.label))}</div>
                <div class="muted">${t('Akkaunt jami: {total} · siz {cost}', { total: `<b>${percent(l.total / 100)}</b>`, cost: money(l.cost) })}</div>
                ${reset ? `<div class="faint">${t('{when} da yangilanadi ({left} qoldi)', { when: time(reset, reset - Date.now() > 20 * 3_600_000), left: until(reset - Date.now()) })}</div>` : ''}</div></div>`;
          })
          .join('')}</div></div>`,
    )
    .join('');
  const limits = data.limits
    .map(
      (l) => `<div class="limit-row"><span>${h(t('{name} limit', { name: limitLabelText(l.label) }).replace(/^./, (c) => c.toUpperCase()))}</span><span>${l.unit === '%' ? `${l.spent.toFixed(1)}% / ${l.limit}%` : `${money(l.spent)} / ${money(l.limit)}`} · <b>${percent(l.share)}</b></span>
        <div class="bar"><i style="width:${Math.min(100, (l.share ?? 0) * 100)}%;--c:${shareColor(l.share ?? 0)}"></i></div></div>`,
    )
    .join('');

  app.innerHTML = `<div class="shell share">
    <header class="top"><div class="brand"><span class="dot" style="--c:${h(m.color)};width:14px;height:14px"></span>${h(m.name)}</div>
      ${m.paused ? `<span class="pill bad">${t('⏸ To‘xtatilgan')}</span>` : ''}<span class="spacer"></span><span class="faint">${t('Claude sarfi')} · ${time(data.now)}</span>
      <select class="lang-select" data-action="lang" aria-label="Til / Language / Язык">${Object.entries(LANGS).map(([code, name]) => `<option value="${code}" ${code === lang ? 'selected' : ''}>${name}</option>`).join('')}</select></header>
    ${m.paused ? `<div class="card pause-card paused"><div><b>${t('⏸ Claude Code to‘xtatilgan')}</b><div class="faint">${t('Panel egasi davom ettirmaguncha bu kompyuterda yangi promptlar bajarilmaydi.')}</div></div></div>` : ''}
    ${shares ? `<h3 class="section-title">${t('🎯 Obuna limitlari')}</h3><div class="grid sub-grid">${shares}</div>` : ''}
    <div class="grid kpis">${kpi(t('Bugun'), data.totals.today)}${kpi(t('Shu hafta'), data.totals.week)}${kpi(t('Shu oy'), data.totals.month)}</div>
    ${limits ? `<div class="card" style="margin-top:16px"><h2>${t('Limitlaringiz')}</h2><div class="budget">${limits}</div>${data.blocking ? `<div class="faint" style="margin-top:8px">${t('🔒 Limit tugasa promptlar to‘xtatiladi')}</div>` : ''}</div>` : ''}
    <div class="card" style="margin-top:16px"><h2>${t('Oxirgi 14 kun')} <span class="right">${t('API narxida')}</span></h2>${bars(data.daily)}</div>
    <p class="faint" style="margin:18px 0 0;font-size:12px">${t('Bu sahifa faqat shu kompyuterning ma’lumotini ko‘rsatadi va 30 soniyada bir yangilanadi.')}</p>
  </div>`;
}

async function load() {
  try {
    const response = await fetch(`/api/share/${encodeURIComponent(link)}`, { cache: 'no-store' });
    if (response.status === 404) {
      app.innerHTML = `<div class="boot">${t('Bu havola endi ishlamaydi: panel egasidan yangisini so‘rang.')}</div>`;
      return;
    }

    data = await response.json();
    render();
  } catch {
    // Next round.
  }
}

document.documentElement.lang = lang;
document.title = t('Claude sarfi');
document.addEventListener('change', (event) => {
  if (event.target.matches?.('[data-action="lang"]')) setLang(event.target.value);
});

load();
setInterval(load, 30_000);
