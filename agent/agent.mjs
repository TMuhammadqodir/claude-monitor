#!/usr/bin/env node
// Claude Monitor agent: run once on each computer that uses Claude Code.
//
//   node agent.mjs setup  --server http://192.168.1.10:4318 --token cm_xxx   turn reporting and limits on, send the past
//                         [--auto-update]                                    and take newer agents from the server
//   node agent.mjs import --server http://192.168.1.10:4318 --token cm_xxx   send past usage from the logs again
//   node agent.mjs watch  --server http://192.168.1.10:4318 --token cm_xxx   send the logs every few minutes
//   node agent.mjs usage  --server http://192.168.1.10:4318 --token cm_xxx   show and send the subscription's exact percentages
//   node agent.mjs update                                                 renew this agent and its hooks (same server, token)
//   node agent.mjs status                                                 what is set now
//   node agent.mjs remove                                                    turn everything off
//   node agent.mjs gate   ...                                                (run by Claude Code before each prompt)
//
// The token can come from CLAUDE_MONITOR_TOKEN instead of --token, to keep it out of the shell's history.
//
// Only numbers are sent: tokens, models, times, session ids and the project folder's name. Never prompts,
// answers, code or file contents.

import { readFile, writeFile, readdir, stat, copyFile, mkdir, rename } from 'node:fs/promises';
import { homedir, hostname, platform, arch } from 'node:os';
import { basename, join } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const command = args[0];
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const settingsFile = join(configDir, 'settings.json');
// The agent keeps a copy of itself here, so the prompt hook finds it wherever it was downloaded to.
const agentHome = join(configDir, 'claude-monitor');
const agentCopy = join(agentHome, 'agent.mjs').replaceAll('\\', '/');
const isOurHook = (entry) =>
  (entry?.hooks ?? []).some((hook) => String(hook.command ?? '').includes('claude-monitor') && /\s(gate|guard|report|session|model|switched)\b/.test(String(hook.command)));

// The hooks this agent adds: the limit check before each prompt; before each tool call the same check (so a
// machine stopped from the dashboard stops in the middle of an answer too); at the end of each answer the
// exact percentages, so the dashboard keeps up during a long answer, not only per prompt; and the model a
// session starts with or switches to, so a model the machine may not use is refused (PreModelSwitch needs
// Claude Code 2.1.251 or later; an older one leaves those hooks out).
const HOOKS = { UserPromptSubmit: 'gate', PreToolUse: 'guard', Stop: 'report', SessionStart: 'session', PreModelSwitch: 'model', PostModelSwitch: 'switched' };

// The keys of Claude Code's settings that carry the dashboard's rules for this machine (see applyPolicy).
const POLICY_KEYS = ['availableModels', 'enforceAvailableModels', 'maxEffortLevel'];

// How often the exact percentages are sent at most; how long a limit answer is reused between tool calls;
// how often the logs are read again for what telemetry lost; how often the server is asked for a newer agent.
// Anthropic's usage address answers 429 when asked too often (it says neither how often nor how long to wait),
// so once a minute; the dashboard works out the percentage in between from the requests themselves.
const REPORT_SECONDS = 60;
// How long after the last hook the percentages are still asked for: use elsewhere on the account (another
// computer, claude.ai) moves them too, and the end of an answer is reported, not missed.
const ACTIVE_SECONDS = 600;
const GUARD_SECONDS = 10;
const CATCH_UP_SECONDS = 3600;
const UPDATE_SECONDS = 6 * 3600;

// The keys this agent writes into Claude Code's user settings; "remove" takes exactly these out.
const KEYS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_METRICS_EXPORTER',
  'OTEL_LOGS_EXPORTER',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_LOGS_EXPORT_INTERVAL',
  'OTEL_METRICS_INCLUDE_REPOSITORY',
  'OTEL_RESOURCE_ATTRIBUTES',
];

// ---------- messages ----------
//
// In the computer's language (Uzbek, Russian, else English); CLAUDE_MONITOR_LANG=uz|en|ru chooses another.
// A stopped prompt's reason comes from the server, in the language set on the dashboard.

const LANG = (() => {
  const wanted = String(process.env.CLAUDE_MONITOR_LANG ?? Intl.DateTimeFormat().resolvedOptions().locale ?? '').slice(0, 2).toLowerCase();
  return ['uz', 'ru'].includes(wanted) ? wanted : 'en';
})();

const SAY = {
  needServer: ['--server http://manzil:4318 kerak', '--server http://address:4318 is needed', 'нужен --server http://адрес:4318'],
  needToken: ['--token cm_... kerak (paneldagi "Kompyuter qo‘shish" beradi)', '--token cm_... is needed ("Add computer" on the dashboard gives it)', 'нужен --token cm_... (его даёт «Добавить компьютер» на панели)'],
  unreadable: ['{file} o‘qilmadi: {error}', '{file} could not be read: {error}', 'не удалось прочитать {file}: {error}'],
  noServer: ['server javob bermadi: {error}', 'the server did not answer: {error}', 'сервер не ответил: {error}'],
  badToken: ['token noto‘g‘ri yoki kompyuter o‘chirilgan', 'wrong token, or the computer was turned off on the dashboard', 'неверный токен или компьютер отключён на панели'],
  serverStatus: ['server {status} qaytardi', 'the server answered {status}', 'сервер ответил {status}'],
  settingsSaved: ['✓ {file} yangilandi (eskisi: settings.json.bak).', '✓ {file} updated (the old one: settings.json.bak).', '✓ {file} обновлён (прежний: settings.json.bak).'],
  sendingPast: ['  O‘tgan sarf yuborilmoqda...', '  Sending past usage...', '  Отправка прошлого расхода...'],
  sentPast: ['✓ {files} log fayl, {added} so‘rov yuborildi.', '✓ {files} log files, {added} requests sent.', '✓ Лог-файлов: {files}, отправлено запросов: {added}.'],
  reopen: ['  Claude Code’ni qayta oching: shundan keyin har so‘rov panelda darhol ko‘rinadi.', '  Reopen Claude Code: from then on every request shows on the dashboard at once.', '  Перезапустите Claude Code: после этого каждый запрос сразу виден на панели.'],
  notSetUp: ['bu kompyuter hali ulanmagan: avval "setup" qiling', 'this computer is not connected yet: run "setup" first', 'этот компьютер ещё не подключён: сначала выполните "setup"'],
  updated: ['✓ Agent yangilandi: {file}', '✓ Agent updated: {file}', '✓ Агент обновлён: {file}'],
  reopenHooks: ['  Claude Code’ni qayta oching: yangi hook’lar shundan keyin ishlaydi.', '  Reopen Claude Code: the new hooks work from then on.', '  Перезапустите Claude Code: новые хуки заработают после этого.'],
  noKey: ['✗ Claude Code bu kompyuterda kirmagan (yoki kalit muddati o‘tgan: Claude Code’ni bir marta ishlating).', '✗ Claude Code is not signed in here (or the key expired: use Claude Code once).', '✗ Claude Code здесь не авторизован (или ключ истёк: запустите Claude Code один раз).'],
  noAnthropic: ['✗ Anthropic javob bermadi ({error}). Uzoq muddatli setup-token’da bu ruxsat bo‘lmasligi mumkin.', '✗ Anthropic did not answer ({error}). A long-lived setup-token may not allow this.', '✗ Anthropic не ответил ({error}). Долгосрочный setup-token может не давать такого доступа.'],
  limitsTitle: ['Obuna limitlari (Anthropic):', 'Subscription limits (Anthropic):', 'Лимиты подписки (Anthropic):'],
  account: ['  Akkaunt: {email}', '  Account: {email}', '  Аккаунт: {email}'],
  sentToPanel: ['✓ Panelga yuborildi.', '✓ Sent to the dashboard.', '✓ Отправлено на панель.'],
  notSentServer: ['panelga yuborilmadi: server javob bermadi ({error})', 'not sent: the server did not answer ({error})', 'не отправлено: сервер не ответил ({error})'],
  notSentToken: ['panelga yuborilmadi: token noto‘g‘ri yoki kompyuter o‘chirilgan', 'not sent: wrong token, or the computer was turned off on the dashboard', 'не отправлено: неверный токен или компьютер отключён на панели'],
  paused: ['Claude Monitor: bu kompyuter paneldan to‘xtatilgan. Panel egasi "Davom ettirish" ni bosgach, yana ishlaydi.', 'Claude Monitor: this computer was stopped from the dashboard. It works again once the owner presses "Resume".', 'Claude Monitor: этот компьютер остановлен из панели. Он снова заработает, когда владелец нажмёт «Продолжить».'],
  overLimit: ['Claude Monitor: bu kompyuterning limiti tugadi ({reason}). Limitni paneldagi kompyuter sozlamasida o‘zgartirish mumkin.', 'Claude Monitor: this computer’s limit ran out ({reason}). The limit can be changed in the computer’s settings on the dashboard.', 'Claude Monitor: лимит этого компьютера исчерпан ({reason}). Лимит можно изменить в настройках компьютера на панели.'],
  rejected: ['Claude Monitor: server bu kompyuterning tokenini qabul qilmadi (panelda yangi token olingan yoki kompyuter o‘chirilgan). Sarf yozilmayapti: panelda shu kompyuter uchun token olib, "node agent.mjs setup ..." ni qayta ishga tushiring.', 'Claude Monitor: the server refused this computer’s token (a new token was made on the dashboard, or the computer was removed). Usage is not recorded: get a token for this computer on the dashboard and run "node agent.mjs setup ..." again.', 'Claude Monitor: сервер не принял токен этого компьютера (на панели создан новый токен или компьютер удалён). Расход не записывается: получите токен на панели и снова выполните "node agent.mjs setup ...".'],
  removed: ['✓ Hisobot yuborish o‘chirildi. Claude Code’ni qayta oching.', '✓ Reporting turned off. Reopen Claude Code.', '✓ Отправка отчётов отключена. Перезапустите Claude Code.'],
  notOn: ['Hisobot yuborish yoqilmagan.', 'Reporting is not turned on.', 'Отправка отчётов не включена.'],
  statusName: ['Nomi', 'Name', 'Имя'],
  statusLimit: ['Limit:  {when}', 'Limit:  {when}', 'Лимит:  {when}'],
  beforePrompt: ['har prompt oldidan', 'before each prompt', 'перед каждым промптом'],
  andTools: [' va har asbob oldidan tekshiriladi', ' and before each tool call', ' и перед каждым вызовом инструмента'],
  notChecked: ['tekshirilmaydi', 'not checked', 'не проверяется'],
  statusPercent: ['Foiz:   {how}', 'Percent: {how}', 'Проценты: {how}'],
  afterAnswer: ['har {n} soniyada, Claude ishlayotganda va undan keyin 10 daqiqa', 'every {n} seconds while Claude works and for 10 minutes after', 'каждые {n} секунд, пока Claude работает, и ещё 10 минут после'],
  onlyPrompt: ['faqat prompt oldidan (node agent.mjs update)', 'only before a prompt (node agent.mjs update)', 'только перед промптом (node agent.mjs update)'],
  statusLink: ['Aloqa:  {state}', 'Link:   {state}', 'Связь:  {state}'],
  linkRefused: ['✗ server tokenni qabul qilmadi: panelda yangi token olib, "setup" ni qayta ishga tushiring', '✗ the server refuses the token: get a new one on the dashboard and run "setup" again', '✗ сервер не принимает токен: получите новый на панели и снова выполните "setup"'],
  linkPaused: ['✓ bor, lekin kompyuter paneldan to‘xtatilgan', '✓ fine, but the computer is stopped from the dashboard', '✓ есть, но компьютер остановлен из панели'],
  linkOk: ['✓ bor', '✓ fine', '✓ есть'],
  linkDown: ['✗ server javob bermadi', '✗ the server did not answer', '✗ сервер не ответил'],
  imported: ['✓ {files} log fayl ko‘rildi: {added} so‘rov qo‘shildi, {skipped} tasi oldin bor edi yoki bo‘sh.', '✓ {files} log files read: {added} requests added, {skipped} were there already or empty.', '✓ Просмотрено лог-файлов: {files}: добавлено запросов {added}, {skipped} уже были или пустые.'],
  watching: ['✓ Har {n} daqiqada yangi so‘rovlar {server} ga yuboriladi. To‘xtatish: Ctrl+C', '✓ New requests go to {server} every {n} minutes. Stop: Ctrl+C', '✓ Новые запросы отправляются на {server} каждые {n} мин. Остановить: Ctrl+C'],
  watchAdded: ['{time}  +{n} so‘rov', '{time}  +{n} requests', '{time}  +{n} запросов'],
  watchDown: ['{time}  server bilan aloqa yo‘q ({error}), keyinroq yana urinadi', '{time}  no link to the server ({error}), trying again later', '{time}  нет связи с сервером ({error}), повтор позже'],
  progress: ['\r  {files} fayl, {added} yangi so‘rov...', '\r  {files} files, {added} new requests...', '\r  файлов: {files}, новых запросов: {added}...'],
  stoppedTool: ['Claude Monitor bu amalni to‘xtatdi: kompyuter paneldan to‘xtatilgan yoki limiti tugagan. Foydalanuvchiga ayting va kuting.', 'Claude Monitor stopped this tool call: the computer is paused on the dashboard or over its limit. Tell the user and wait.', 'Claude Monitor остановил этот вызов: компьютер остановлен из панели или исчерпал лимит. Сообщите пользователю и подождите.'],
  autoUpdateOn: ['  Avto-yangilash yoqildi: agent serverdagi yangi versiyani o‘zi oladi.', '  Auto-update is on: the agent takes newer versions from the server.', '  Автообновление включено: агент сам берёт новые версии с сервера.'],
  autoUpdateHttp: ['  ⚠ Server HTTP orqali: tarmoqdagi boshqa odam agent o‘rniga o‘z kodini berishi mumkin. Avto-yangilashni faqat HTTPS yoki Tailscale bilan yoqing.', '  ⚠ The server is plain HTTP: someone on the network could hand over their own code as the agent. Turn auto-update on only over HTTPS or Tailscale.', '  ⚠ Сервер по HTTP: кто-то в сети может подменить агент своим кодом. Включайте автообновление только с HTTPS или Tailscale.'],
  modelBlocked: ['Claude Monitor: bu kompyuterda {model} ishlatib bo‘lmaydi. Ruxsat etilgan modellar: {allowed}. Almashtiring: /model {first}', 'Claude Monitor: {model} may not be used on this computer. Allowed models: {allowed}. Switch with: /model {first}', 'Claude Monitor: на этом компьютере нельзя использовать {model}. Разрешённые модели: {allowed}. Переключитесь: /model {first}'],
  effortBlocked: ['Claude Monitor: effort {level} bu kompyuter uchun chegaradan yuqori (ko‘pi bilan {max}). Pasaytiring: /effort {max}', 'Claude Monitor: effort {level} is above this computer’s cap (at most {max}). Lower it with: /effort {max}', 'Claude Monitor: effort {level} выше предела этого компьютера (не больше {max}). Понизьте: /effort {max}'],
  statusPolicy: ['Qoida:  modellar: {models} · effort: {effort}', 'Rules:  models: {models} · effort: {effort}', 'Правила: модели: {models} · effort: {effort}'],
  anyModel: ['hammasi', 'any', 'любые'],
  noCap: ['chegarasiz', 'no cap', 'без предела'],
  upTo: ['ko‘pi bilan {max}', 'at most {max}', 'не больше {max}'],
  usageLine: ['Foydalanish: node agent.mjs setup|update|import|watch|usage|status|remove --server http://manzil:4318 --token cm_...', 'Usage: node agent.mjs setup|update|import|watch|usage|status|remove --server http://address:4318 --token cm_...', 'Использование: node agent.mjs setup|update|import|watch|usage|status|remove --server http://адрес:4318 --token cm_...'],
};

/** A message in the computer's language, with {name} parts filled in. */
function say(key, values = {}) {
  const text = SAY[key][{ uz: 0, en: 1, ru: 2 }[LANG]];
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole));
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// An error after a request was sent: leaving through exitCode lets Node close its sockets first (process.exit
// in the middle of a closing fetch stops Node on Windows with an assertion).
function failLater(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

function serverAndToken() {
  const server = (option('server') ?? '').replace(/\/+$/, '');
  const token = option('token') ?? process.env.CLAUDE_MONITOR_TOKEN ?? '';
  if (!/^https?:\/\/[^/]+/.test(server)) fail(say('needServer'));
  if (!/^cm_[A-Za-z0-9_-]{20,}$/.test(token)) fail(say('needToken'));
  return { server, token };
}

async function readSettings() {
  try {
    return JSON.parse(await readFile(settingsFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    fail(say('unreadable', { file: settingsFile, error: error.message }));
  }
}

async function verifyServer(server, token) {
  const response = await fetch(`${server}/v1/logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ resourceLogs: [] }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error) => fail(say('noServer', { error: error.cause?.code ?? error.message })));
  if (response.status === 401) fail(say('badToken'));
  if (!response.ok) fail(say('serverStatus', { status: response.status }));
}

async function setup() {
  const { server, token } = serverAndToken();
  await verifyServer(server, token);

  const settings = await readSettings();
  await mkdir(configDir, { recursive: true });
  try {
    await copyFile(settingsFile, `${settingsFile}.bak`);
  } catch {
    // No settings yet: nothing to keep.
  }

  const name = (option('name') ?? hostname()).replace(/[^A-Za-z0-9._-]/g, '_');
  settings.env = {
    ...(settings.env ?? {}),
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: server,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}`,
    OTEL_METRIC_EXPORT_INTERVAL: '30000',
    OTEL_LOGS_EXPORT_INTERVAL: '5000',
    OTEL_METRICS_INCLUDE_REPOSITORY: 'true',
    OTEL_RESOURCE_ATTRIBUTES: `host.name=${name}`,
  };

  await installHooks(settings);
  await writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  console.log(say('settingsSaved', { file: settingsFile }));
  // Taking code from the server is asked for, never assumed: whoever controls the server (or, over plain HTTP,
  // the network) would otherwise run their code on this computer, where Claude Code's sign-in key is.
  const autoUpdate = args.includes('--auto-update');
  await writeState('config', { autoUpdate });
  if (autoUpdate) {
    console.log(say('autoUpdateOn'));
    if (server.startsWith('http://')) console.log(say('autoUpdateHttp'));
  }

  console.log(say('sendingPast'));
  const { scanned, added } = await sendLogs(server, token, 0, false);
  console.log('\n' + say('sentPast', { files: scanned, added }));
  console.log(say('reopen'));
}

/**
 * Copies this agent to where the hooks run it from and sets its hooks (see HOOKS); an older version's hooks,
 * on whatever event, go first.
 */
async function installHooks(settings) {
  await mkdir(agentHome, { recursive: true });
  if (process.argv[1].replaceAll('\\', '/') !== agentCopy) await copyFile(process.argv[1], agentCopy).catch(() => {});
  removeOurHooks(settings);
  const hooks = (settings.hooks ??= {});
  for (const [event, run] of Object.entries(HOOKS)) {
    (hooks[event] ??= []).push({ hooks: [{ type: 'command', command: `node "${agentCopy}" ${run}`, timeout: 10 }] });
  }
}

// A newer agent on a computer already set up: the server and token stay as they are, only the agent's copy
// and its hooks are renewed.
async function update() {
  const { server, token } = await hookServer();
  if (!server || !token) fail(say('notSetUp'));
  await verifyServer(server, token);
  const settings = await readSettings();
  await copyFile(settingsFile, `${settingsFile}.bak`).catch(() => {});
  await installHooks(settings);
  await writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  // Run by the agent's own update from the server: nobody is there to read it.
  if (args.includes('--quiet')) return;
  console.log(say('updated', { file: agentCopy }));
  console.log(say('reopenHooks'));
}

// ---------- the subscription's exact usage ----------
//
// Claude Code's /usage shows how much of the 5-hour session and of the week is used. The same numbers come
// from Anthropic for the account this computer is signed in with. The sign-in key is read here, on this
// computer, and goes only to Anthropic; the monitor server gets the percentages and nothing else.

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const usageState = join(agentHome, 'usage-sent.json');

/** The key Claude Code signs in with: a long-lived setup-token in the environment, or its saved sign-in. */
async function signInKey() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  let saved = null;
  try {
    saved = JSON.parse(await readFile(join(configDir, '.credentials.json'), 'utf8'));
  } catch {
    // macOS keeps it in the Keychain instead of a file.
    if (platform() === 'darwin') {
      const { execFileSync } = await import('node:child_process');
      try {
        saved = JSON.parse(execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 3000 }));
      } catch {
        saved = null;
      }
    }
  }

  const oauth = saved?.claudeAiOauth;
  // An expired key is not renewed here: renewing it would sign Claude Code out. It renews it itself when used.
  if (!oauth?.accessToken || (oauth.expiresAt && oauth.expiresAt < Date.now())) return null;
  return oauth.accessToken;
}

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const accountCache = join(agentHome, 'account.json');
const keyId = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16);

/**
 * Whose key it is: Anthropic's profile names the account behind the key, so a setup-token for another account
 * (CLAUDE_CODE_OAUTH_TOKEN) is not taken for the signed-in one. Kept for six hours under the key's hash.
 */
async function accountOfKey(key) {
  const id = keyId(key);
  try {
    const cached = JSON.parse(await readFile(accountCache, 'utf8'));
    if (cached.id === id && Date.now() - cached.at < 6 * 3_600_000) return { account: cached.account, email: cached.email };
  } catch {
    // Not asked yet.
  }

  try {
    const response = await fetch(PROFILE_URL, {
      headers: { authorization: `Bearer ${key}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'claude-monitor-agent' },
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      const body = await response.json();
      const found = { account: body?.account?.uuid ?? null, email: body?.account?.email ?? null };
      if (found.account) {
        await mkdir(agentHome, { recursive: true });
        await writeFile(accountCache, JSON.stringify({ id, at: Date.now(), ...found }));
        return found;
      }
    }
  } catch {
    // Anthropic not reached: fall back to Claude Code's config.
  }

  return process.env.CLAUDE_CODE_OAUTH_TOKEN ? { account: null, email: null } : signedInAccount();
}

/** The account Claude Code uses now, when it can be told without asking anyone (for the limit check). */
async function currentAccount() {
  const key = await signInKey();
  if (!key) return null;
  try {
    const cached = JSON.parse(await readFile(accountCache, 'utf8'));
    if (cached.id === keyId(key)) return cached.account;
  } catch {
    // Not known yet.
  }

  return process.env.CLAUDE_CODE_OAUTH_TOKEN ? null : (await signedInAccount()).account;
}

/** The signed-in account's id and email, from Claude Code's own config (no secret in it). */
async function signedInAccount() {
  for (const file of [join(homedir(), '.claude.json'), join(configDir, '.claude.json')]) {
    try {
      const account = JSON.parse(await readFile(file, 'utf8')).oauthAccount;
      if (account) return { account: account.accountUuid ?? null, email: account.emailAddress ?? null };
    } catch {
      // Next place.
    }
  }

  return { account: null, email: null };
}

/** Every limit Anthropic reports, e.g. { kind: 'five_hour', percent: 37, resetsAt: '…' }. */
async function fetchUsage() {
  const key = await signInKey();
  if (!key) return { error: 'no-key' };
  const who = accountOfKey(key);
  const response = await fetch(USAGE_URL, {
    headers: { authorization: `Bearer ${key}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'claude-monitor-agent' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return { error: `http-${response.status}` };
  const body = await response.json();
  const limits = [];
  for (const [kind, value] of Object.entries(body ?? {})) {
    if (value && typeof value === 'object' && value.utilization != null && Number.isFinite(Number(value.utilization))) {
      limits.push({ kind, percent: Number(value.utilization), resetsAt: value.resets_at ?? null });
    }
  }

  return { limits, ...(await who) };
}

/** Sends the percentages to the server; with `everySeconds`, not more often than that. */
/**
 * After a 429 from Anthropic the next asks wait: 2, 4, 8 … minutes, 30 at most, and a success starts again
 * from the minute. Asking on through a 429 only keeps the limit on.
 */
const backoffOf = async () => readState('usage-backoff');
async function noteUsageAnswer(error) {
  if (error === 'http-429') {
    const tries = ((await backoffOf()).tries ?? 0) + 1;
    await writeState('usage-backoff', { tries, until: Date.now() + Math.min(30, 2 ** tries) * 60_000 }).catch(() => {});
  } else if (!error) {
    await writeState('usage-backoff', {}).catch(() => {});
  }
}

async function reportUsage(server, token, { everySeconds = 0, print = false, waitOut = true } = {}) {
  if (waitOut && ((await backoffOf()).until ?? 0) > Date.now()) return { error: 'backoff' };
  if (everySeconds) {
    try {
      const last = JSON.parse(await readFile(usageState, 'utf8')).at ?? 0;
      if (Date.now() - last < everySeconds * 1000) return null;
    } catch {
      // Never sent.
    }
  }

  const usage = await fetchUsage();
  await noteUsageAnswer(usage.error);
  if (print) {
    if (usage.error === 'no-key') console.log(say('noKey'));
    else if (usage.error) console.log(say('noAnthropic', { error: usage.error }));
    else for (const limit of usage.limits) console.log(`  ${limit.kind.padEnd(24)} ${String(Math.round(limit.percent)).padStart(3)}%   ${limit.resetsAt ?? ''}`);
  }

  await mkdir(agentHome, { recursive: true });
  await writeFile(usageState, JSON.stringify({ at: Date.now() }));
  if (usage.error) return usage;
  const { account, email } = usage;
  const response = await fetch(`${server}/api/limits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ account, email, limits: usage.limits }),
    signal: AbortSignal.timeout(5000),
  });
  return { ...usage, sent: response.ok };
}

async function usageCommand() {
  const { server, token } = serverAndToken();
  console.log(say('limitsTitle'));
  // Asked by hand: tried even while the hooks wait out a 429.
  const result = await reportUsage(server, token, { print: true, waitOut: false }).catch((error) => ({ failed: error.cause?.code ?? error.message }));
  if (result?.email) console.log(say('account', { email: result.email }));
  if (result?.sent) console.log(say('sentToPanel'));
  else if (result?.failed) failLater(say('notSentServer', { error: result.failed }));
  else if (result && !result.error) failLater(say('notSentToken'));
}

// ---------- the hooks Claude Code runs ----------
//
// None of them ever stops work by the monitor being down: when the server cannot be reached, everything goes on.

/** The server and token from the telemetry settings, so a hook's command (which Claude Code shows) holds no secret. */
async function hookServer() {
  const env = (await readSettings()).env ?? {};
  const server = (option('server') ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').replace(/\/+$/, '');
  const token = option('token') ?? /Bearer\s+(\S+)/.exec(env.OTEL_EXPORTER_OTLP_HEADERS ?? '')?.[1] ?? process.env.CLAUDE_MONITOR_TOKEN ?? '';
  return { server, token };
}

const stateFile = (name) => join(agentHome, `${name}.json`);

async function readState(name) {
  try {
    return JSON.parse(await readFile(stateFile(name), 'utf8'));
  } catch {
    return {};
  }
}

async function writeState(name, value) {
  await mkdir(agentHome, { recursive: true });
  await writeFile(stateFile(name), JSON.stringify(value));
}

/**
 * Asks the server whether this machine may go on: stopped from the dashboard, or over a limit. With
 * `reuseSeconds` a recent answer is used again (the check before each tool call must be quick). Returns null
 * when the server cannot be reached; { rejected: true } when it refuses the token.
 */
async function askGate(server, token, { reuseSeconds = 0 } = {}) {
  if (reuseSeconds) {
    const last = await readState('gate');
    if (last.answer && Date.now() - (last.at ?? 0) < reuseSeconds * 1000) return last.answer;
  }

  let answer = null;
  try {
    // The account in use, so a limit set for one account does not stop work on another.
    const account = await currentAccount().catch(() => null);
    const query = account ? `?account=${encodeURIComponent(account)}` : '';
    const response = await fetch(`${server}/api/gate${query}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(reuseSeconds ? 2500 : 4000) });
    if (response.status === 401) answer = { rejected: true };
    else if (response.ok) answer = await response.json();
  } catch {
    // Down or slow.
  }

  if (answer) await writeState('gate', { at: Date.now(), answer }).catch(() => {});
  return answer;
}

// What the server says is shown to the person, never handed to Claude, and only as one short line of text.
const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, 300);
const stopMessage = (answer) => clean(answer.message) || (answer.paused ? say('paused') : say('overLimit', { reason: clean(answer.reason) }));

const REJECTED = say('rejected');

/** Says once an hour that the token is refused, as a notice Claude Code shows (it does not stop anything). */
async function warnRejected() {
  const last = await readState('rejected');
  if (Date.now() - (last.told ?? 0) < 3600_000) return null;
  await writeState('rejected', { told: Date.now() }).catch(() => {});
  return REJECTED;
}

/**
 * What runs beside the hooks, in a detached process so it never holds them up: the exact percentages (once a
 * minute), and once an hour the logs read again for what telemetry lost and a newer agent from the server.
 * A hook waits only for the server's answer: asking Anthropic as well could take it past Claude Code's hook
 * timeout, and a hook that times out (or falls over) lets the prompt through even on a stopped computer.
 */
async function sideWork() {
  const now = Date.now();
  await writeState('active', { at: now }).catch(() => {});
  const state = await readState('background');
  const catchUp = now - (state.at ?? 0) > CATCH_UP_SECONDS * 1000;
  // A poller already running keeps the percentages coming: no second one; nor while a 429 is waited out.
  const polling = ((await readState('poller')).until ?? 0) > now;
  const waiting = ((await backoffOf()).until ?? 0) > now;
  const usage = !polling && !waiting && now - ((await readState('usage-sent')).at ?? 0) >= REPORT_SECONDS * 1000;
  if (!catchUp && !usage) return;
  // Claimed before the start, so hooks running at the same moment do not start one each.
  if (catchUp) await writeState('background', { ...state, at: now }).catch(() => {});
  if (usage) await writeState('usage-sent', { at: now }).catch(() => {});
  const { spawn } = await import('node:child_process');
  spawn(process.execPath, [agentCopy, catchUp ? 'background' : 'side'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/**
 * Started detached by a hook: the exact percentages every REPORT_SECONDS while Claude Code is in use and for
 * ACTIVE_SECONDS after, so the dashboard keeps up whether or not an answer just ended. It stops early when
 * there is nothing to send (no sign-in here) or the server will not take it.
 */
async function side() {
  const { server, token } = await hookServer();
  if (!server || !token) return;
  for (;;) {
    await writeState('poller', { pid: process.pid, until: Date.now() + (REPORT_SECONDS + 15) * 1000 }).catch(() => {});
    const result = await reportUsage(server, token).catch(() => null);
    // Nothing to send, an error (Anthropic or the server), or not taken: the next hook starts it again.
    if (!result || result.error || result.sent === false) break;
    if (Date.now() - ((await readState('active')).at ?? 0) > ACTIVE_SECONDS * 1000) break;
    await new Promise((resolve) => setTimeout(resolve, REPORT_SECONDS * 1000));
  }

  await writeState('poller', {}).catch(() => {});
}

// ---------- the dashboard's rules: models and effort ----------
//
// The gate's answer carries them. They are written into Claude Code's own settings, so Claude Code keeps to
// them itself: availableModels (with enforceAvailableModels, so "Default" follows the list too) and
// maxEffortLevel, which runs any higher level at the cap. The hooks check them as well, for a session that
// started before the rules came or on a model given by ANTHROPIC_MODEL.

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const familyOf = (model) => {
  const match = /(fable|mythos|opus|sonnet|haiku)/.exec(String(model ?? '').toLowerCase());
  return match ? (match[1] === 'mythos' ? 'fable' : match[1]) : null;
};
// A model of no known family is not judged: the rules name families.
const modelAllowed = (policy, model) => !policy?.models || familyOf(model) === null || policy.models.includes(familyOf(model));
const effortAbove = (policy, level) => Boolean(policy?.maxEffort) && EFFORTS.includes(level) && EFFORTS.indexOf(level) > EFFORTS.indexOf(policy.maxEffort);

/** What Claude Code passes a hook on stdin (JSON); {} when there is none. */
async function hookInput() {
  if (process.stdin.isTTY) return {};
  const read = (async () => {
    let data = '';
    for await (const chunk of process.stdin) {
      data += chunk;
      if (data.length > 1_000_000) break;
    }

    return JSON.parse(data || '{}');
  })().catch(() => ({}));
  // Claude Code closes stdin once it has written; a hook run by hand without input does not wait for ever.
  return Promise.race([read, new Promise((resolve) => setTimeout(() => resolve({}), 2000).unref())]);
}

/** Writes JSON over a file through a temporary one, so Claude Code never reads a half-written settings file. */
async function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, file);
}

/**
 * Puts the rules into Claude Code's user settings when they changed; takes them out when the dashboard has
 * none, as long as they are still what this agent wrote (a value the person set themselves stays).
 */
async function applyPolicy(policy) {
  if (!policy) return;
  let settings;
  try {
    settings = JSON.parse(await readFile(settingsFile, 'utf8'));
  } catch {
    // No settings, or not readable: nothing is written over them.
    return;
  }

  const wanted = {
    availableModels: policy.models ?? null,
    enforceAvailableModels: policy.models ? true : null,
    maxEffortLevel: policy.maxEffort ?? null,
  };
  const applied = await readState('policy');
  let changed = false;
  for (const key of POLICY_KEYS) {
    const want = wanted[key];
    if (want !== null) {
      if (JSON.stringify(settings[key]) !== JSON.stringify(want)) {
        settings[key] = want;
        changed = true;
      }
    } else if (applied[key] !== undefined && JSON.stringify(settings[key]) === JSON.stringify(applied[key])) {
      delete settings[key];
      changed = true;
    }
  }

  if (changed) await writeJson(settingsFile, settings);
  const next = Object.fromEntries(POLICY_KEYS.filter((key) => wanted[key] !== null).map((key) => [key, wanted[key]]));
  if (JSON.stringify(next) !== JSON.stringify(applied)) await writeState('policy', next);
}

/** The model each session runs on, as SessionStart and PostModelSwitch said (the 100 latest sessions). */
async function rememberModel(session, model) {
  if (!session || !model) return;
  const models = await readState('models');
  models[session] = { model: String(model).slice(0, 100), at: Date.now() };
  const latest = Object.entries(models)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 100);
  await writeState('models', Object.fromEntries(latest)).catch(() => {});
}

const modelOfSession = async (session) => (session ? ((await readState('models'))[session]?.model ?? null) : null);

/** Why the rules stop this session now: its model or its effort; null when they do not. */
async function policyStop(policy, input) {
  if (!policy) return null;
  const model = await modelOfSession(input.session_id);
  if (model && !modelAllowed(policy, model)) {
    return say('modelBlocked', { model, allowed: policy.models.join(', '), first: policy.models[0] });
  }

  const level = input.effort?.level;
  if (effortAbove(policy, level)) return say('effortBlocked', { level, max: policy.maxEffort });
  return null;
}

// Before each prompt (UserPromptSubmit). Exit 2 stops the prompt and Claude Code shows why.
async function gate() {
  const input = await hookInput();
  const { server, token } = await hookServer();
  if (!server || !token) return;
  await sideWork().catch(() => {});
  const answer = await askGate(server, token);
  if (answer?.rejected) {
    const notice = await warnRejected();
    if (notice) process.stdout.write(JSON.stringify({ systemMessage: notice }));
    return;
  }

  await applyPolicy(answer?.policy).catch(() => {});
  if (answer?.allowed === false) {
    process.stderr.write(stopMessage(answer) + '\n');
    process.exitCode = 2;
    return;
  }

  const stop = await policyStop(answer?.policy, input);
  if (stop) {
    process.stderr.write(stop + '\n');
    process.exitCode = 2;
  }
}

// Before each tool call (PreToolUse): a machine stopped from the dashboard, or over its limit, stops in the
// middle of an answer too; so does one on a model or an effort its rules do not allow. "continue: false" ends
// Claude's turn; the reason is shown.
async function guard() {
  const input = await hookInput();
  const { server, token } = await hookServer();
  if (!server || !token) return;
  await sideWork().catch(() => {});
  const answer = await askGate(server, token, { reuseSeconds: GUARD_SECONDS });
  if (answer?.rejected) return;
  if (answer?.allowed === false) {
    const reason = stopMessage(answer);
    process.stdout.write(
      // stopReason is for the person; Claude reads permissionDecisionReason, so it gets this agent's own words.
      JSON.stringify({ continue: false, stopReason: reason, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: say('stoppedTool') } }),
    );
    return;
  }

  const stop = await policyStop(answer?.policy, input);
  if (stop) {
    process.stdout.write(
      JSON.stringify({ continue: false, stopReason: stop, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: stop } }),
    );
  }
}

// When a session starts (SessionStart): its model is remembered, and the rules are put in place before the
// first prompt. It cannot stop anything; a model the rules do not allow is said here and stopped at the prompt.
async function session() {
  const input = await hookInput();
  await rememberModel(input.session_id, input.model);
  const { server, token } = await hookServer();
  if (!server || !token) return;
  const answer = await askGate(server, token, { reuseSeconds: GUARD_SECONDS });
  if (!answer || answer.rejected) return;
  await applyPolicy(answer.policy).catch(() => {});
  const stop = await policyStop(answer.policy, input);
  if (stop) process.stdout.write(JSON.stringify({ systemMessage: stop }));
}

// Before a model switch (PreModelSwitch): a model the rules do not allow is refused (exit 2). An answer from
// the last minute is used as it is; else the server is asked briefly, and when it does not answer the last
// answer still decides. With none at all and no server, the switch goes on.
async function modelSwitch() {
  const input = await hookInput();
  const { server, token } = await hookServer();
  if (!server || !token) return;
  const answer = (await askGate(server, token, { reuseSeconds: 60 })) ?? (await readState('gate')).answer;
  const policy = answer?.rejected ? null : answer?.policy;
  if (policy && !modelAllowed(policy, input.to_model)) {
    process.stderr.write(say('modelBlocked', { model: input.to_model, allowed: policy.models.join(', '), first: policy.models[0] }) + '\n');
    process.exitCode = 2;
  }
}

// After a model switch (PostModelSwitch), the automatic ones too: the session's model is remembered.
async function switched() {
  const input = await hookInput();
  await rememberModel(input.session_id, input.to_model);
}

// At the end of each answer (Stop): the percentages and the side work. It never stops anything.
async function report() {
  const { server, token } = await hookServer();
  if (server && token) await sideWork().catch(() => {});
}

/** Started detached by a hook: the logs again since the last time, then a newer agent if the server has one. */
async function background() {
  const { server, token } = await hookServer();
  if (!server || !token) return;
  await reportUsage(server, token).catch(() => null);
  const state = await readState('background');
  // A little before the last round, to miss nothing; the first time two days back.
  const since = state.logsAt ? state.logsAt - 15 * 60_000 : Date.now() - 2 * 86_400_000;
  const started = Date.now();
  try {
    await sendLogs(server, token, since, true);
    state.logsAt = started;
  } catch {
    // Next time.
  }

  if ((await readState('config')).autoUpdate === true && Date.now() - (state.updateAt ?? 0) > UPDATE_SECONDS * 1000) {
    state.updateAt = Date.now();
    await selfUpdate(server).catch(() => {});
  }

  await writeState('background', { ...state, at: Date.now() });
}

/**
 * Only after "setup --auto-update": takes the server's agent when it differs from this one, and lets the new
 * one set its hooks. Only a file that looks like this agent and passes Node's syntax check replaces it; that
 * guards against a broken file, not a hostile server, which is why it has to be asked for.
 */
async function selfUpdate(server) {
  if ((await readState('config')).autoUpdate !== true) return false;
  const response = await fetch(`${server}/agent.mjs`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return false;
  const fresh = await response.text();
  const mine = await readFile(agentCopy, 'utf8').catch(() => '');
  if (fresh === mine || !fresh.startsWith('#!/usr/bin/env node') || !fresh.includes('Claude Monitor agent')) return false;
  const next = `${agentCopy}.next.mjs`;
  await writeFile(next, fresh);
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync(process.execPath, ['--check', next], { stdio: 'ignore', timeout: 15_000 });
    execFileSync(process.execPath, [next, 'update', '--quiet'], { stdio: 'ignore', timeout: 30_000 });
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(next, { force: true });
  }

  return true;
}

async function remove() {
  const settings = await readSettings();
  for (const key of KEYS) delete settings.env?.[key];
  // The dashboard's rules go too, as long as they are still what this agent wrote.
  const applied = await readState('policy');
  for (const key of POLICY_KEYS) {
    if (applied[key] !== undefined && JSON.stringify(settings[key]) === JSON.stringify(applied[key])) delete settings[key];
  }

  if (settings.env && Object.keys(settings.env).length === 0) delete settings.env;
  removeOurHooks(settings);
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  await writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  console.log(say('removed'));
}

/** Takes this agent's hooks out of every event, older versions' ones too, and leaves everyone else's. */
function removeOurHooks(settings) {
  for (const event of Object.keys(settings.hooks ?? {})) {
    if (!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event] = settings.hooks[event].filter((entry) => !isOurHook(entry));
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
}

async function status() {
  const settings = await readSettings();
  const env = settings.env ?? {};
  if (env.CLAUDE_CODE_ENABLE_TELEMETRY !== '1') {
    console.log(say('notOn'));
    return;
  }

  console.log(`Server: ${env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
  console.log(`${say('statusName').padEnd(7)} ${env.OTEL_RESOURCE_ATTRIBUTES ?? '-'}`);
  console.log(`Format: ${env.OTEL_EXPORTER_OTLP_PROTOCOL}`);
  const has = (event) => (settings.hooks?.[event] ?? []).some(isOurHook);
  console.log(say('statusLimit', { when: (has('UserPromptSubmit') ? say('beforePrompt') : say('notChecked')) + (has('PreToolUse') ? say('andTools') : '') }));
  console.log(say('statusPercent', { how: has('Stop') ? say('afterAnswer', { n: REPORT_SECONDS }) : say('onlyPrompt') }));
  const { server, token } = await hookServer();
  const answer = server && token ? await askGate(server, token) : null;
  console.log(say('statusLink', { state: answer?.rejected ? say('linkRefused') : answer ? (answer.paused ? say('linkPaused') : say('linkOk')) : say('linkDown') }));
  if (answer?.policy) {
    const { models, maxEffort } = answer.policy;
    console.log(say('statusPolicy', { models: models ? models.join(', ') : say('anyModel'), effort: maxEffort ? say('upTo', { max: maxEffort }) : say('noCap') }));
  }
}


async function* files(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.name.endsWith('.jsonl')) yield path;
  }
}

async function importHistory() {
  const { server, token } = serverAndToken();
  await verifyServer(server, token);
  const since = option('since') ? Date.parse(option('since')) : 0;
  const { scanned, added, skipped } = await sendLogs(server, token, since, false);
  console.log('\n' + say('imported', { files: scanned, added, skipped }));
}

// Without telemetry, or as well as it: the logs are read every few minutes and what is new is sent.
async function watch() {
  const { server, token } = serverAndToken();
  await verifyServer(server, token);
  const minutes = Math.max(1, Number(option('every')) || 5);
  // The first round covers two days; then each round re-reads a little before the last one, to miss nothing.
  let since = Date.now() - 2 * 86_400_000;
  console.log(say('watching', { n: minutes, server }));
  for (;;) {
    const started = Date.now();
    try {
      const { added } = await sendLogs(server, token, since, true);
      await reportUsage(server, token).catch(() => null);
      if (added > 0) console.log(say('watchAdded', { time: new Date().toLocaleTimeString(), n: added }));
      since = started - 15 * 60_000;
    } catch (error) {
      console.log(say('watchDown', { time: new Date().toLocaleTimeString(), error: error.message }));
    }

    await new Promise((resolve) => setTimeout(resolve, minutes * 60_000));
  }
}

async function sendLogs(server, token, since, quiet) {
  const roots = [join(configDir, 'projects'), join(homedir(), '.config', 'claude', 'projects')];
  const seen = new Set();
  let batch = [];
  let added = 0;
  let skipped = 0;
  let scanned = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const response = await fetch(`${server}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ records: batch, machine: { os: platform(), arch: arch(), hostname: hostname() } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`server ${response.status} qaytardi`);
    const result = await response.json();
    added += result.added;
    skipped += result.skipped;
    batch = [];
    if (!quiet) process.stdout.write(say('progress', { files: scanned, added }));
  };

  for (const root of roots) {
    for await (const file of files(root)) {
      if (since && (await stat(file)).mtimeMs < since) continue;
      scanned++;
      const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
      // The project is the folder the session was opened in (its first cwd): later commands may run in sub-folders.
      let project = null;
      for await (const line of lines) {
        if (!line.includes('"usage"')) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        if (!project && entry.cwd) project = basename(String(entry.cwd).replace(/[\\/]+$/, ''));
        const message = entry.message;
        const usage = message?.usage;
        if (entry.type !== 'assistant' || !usage || !message.model || message.model === '<synthetic>') continue;

        // One answer is written as several lines, each with the same usage: it counts once.
        const id = entry.requestId || message.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const ts = Date.parse(entry.timestamp);
        if (since && ts < since) continue;

        batch.push({
          ts: entry.timestamp,
          session: entry.sessionId ?? null,
          requestId: entry.requestId ?? null,
          messageId: message.id ?? null,
          model: message.model,
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
          cacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          speed: usage.speed === 'fast' ? 'fast' : null,
          // Only the folder's name, never the whole path.
          project,
        });
        if (batch.length >= 2000) await flush();
      }
    }
  }

  await flush();
  return { scanned, added, skipped };
}

const commands = { setup, update, import: importHistory, watch, usage: usageCommand, status, remove, gate, guard, report, background, side, session, model: modelSwitch, switched };
if (!commands[command]) {
  console.log(say('usageLine'));
  process.exit(command ? 1 : 0);
}

try {
  await commands[command]();
} catch (error) {
  failLater(error.message);
}
