// What the server itself says (alerts on the dashboard and in Telegram, the reason a stopped prompt shows in
// Claude Code), in the language chosen in the settings. {name} parts are filled in by msg(…, { name }).

export const LANGUAGES = ['uz', 'en', 'ru'];

const MESSAGES = {
  staleToken: {
    uz: '🔑 {name} eski token bilan yuboryapti (IP {ip}): uning sarfi yozilmayapti. O‘sha kompyuterda yangi token bilan "node agent.mjs setup ..." ni qayta ishga tushiring.',
    en: '🔑 {name} is sending an old token (IP {ip}): its usage is not recorded. Run "node agent.mjs setup ..." again on that computer with the new token.',
    ru: '🔑 {name} отправляет старый токен (IP {ip}): его расход не записывается. Снова выполните "node agent.mjs setup ..." на том компьютере с новым токеном.',
  },
  unknownToken: {
    uz: '🔑 Noma’lum token bilan urinish (IP {ip}). O‘chirilgan kompyuter yoki xato nusxalangan token bo‘lishi mumkin.',
    en: '🔑 An attempt with an unknown token (IP {ip}). A deleted computer or a mistyped token, perhaps.',
    ru: '🔑 Попытка с неизвестным токеном (IP {ip}). Возможно, удалённый компьютер или неверно скопированный токен.',
  },
  firstContact: {
    uz: '🟢 {name} birinchi marta ulandi.',
    en: '🟢 {name} connected for the first time.',
    ru: '🟢 {name} подключился впервые.',
  },
  exactHigh: {
    uz: '⏳ {who}: {limit} {percent}% ishlatildi{reset}.',
    en: '⏳ {who}: {limit} {percent}% used{reset}.',
    ru: '⏳ {who}: {limit} — использовано {percent}%{reset}.',
  },
  exactReset: {
    uz: ', {when} da yangilanadi',
    en: ', resets {when}',
    ru: ', обновится {when}',
  },
  limitHit: {
    uz: '⛔ {name}: obuna chegarasiga yetildi (429). Shu paytgacha 5 soatlik oynada {cost} ishlatilgan.',
    en: '⛔ {name}: the subscription limit was reached (429). The 5-hour window had used {cost} by then.',
    ru: '⛔ {name}: достигнут лимит подписки (429). К этому моменту в 5-часовом окне израсходовано {cost}.',
  },
  budgetOver: {
    uz: '💸 {name}: {limit} limit tugadi: {spent} / {max}.{stop}',
    en: '💸 {name}: the {limit} limit ran out: {spent} / {max}.{stop}',
    ru: '💸 {name}: исчерпан лимит ({limit}): {spent} / {max}.{stop}',
  },
  budgetStops: {
    uz: ' Yangi promptlar to‘xtatiladi.',
    en: ' New prompts are stopped.',
    ru: ' Новые промпты останавливаются.',
  },
  budgetNear: {
    uz: '⚠️ {name}: {limit} limitning {percent}% i ishlatildi ({spent} / {max}).',
    en: '⚠️ {name}: {percent}% of the {limit} limit used ({spent} / {max}).',
    ru: '⚠️ {name}: использовано {percent}% лимита ({limit}): {spent} / {max}.',
  },
  paused: {
    uz: 'Claude Monitor: bu kompyuter paneldan to‘xtatilgan. Panel egasi "Davom ettirish" ni bosgach, yana ishlaydi.',
    en: 'Claude Monitor: this computer was stopped from the dashboard. It works again once the owner presses "Resume".',
    ru: 'Claude Monitor: этот компьютер остановлен из панели. Он снова заработает, когда владелец нажмёт «Продолжить».',
  },
  overLimit: {
    uz: 'Claude Monitor: bu kompyuterning limiti tugadi ({reason}). Limitni paneldagi kompyuter sozlamasida o‘zgartirish mumkin.',
    en: 'Claude Monitor: this computer’s limit ran out ({reason}). The limit can be changed in the computer’s settings on the dashboard.',
    ru: 'Claude Monitor: лимит этого компьютера исчерпан ({reason}). Лимит можно изменить в настройках компьютера на панели.',
  },
  telegramTest: {
    uz: '✅ Claude Monitor: Telegram ulandi.',
    en: '✅ Claude Monitor: Telegram is connected.',
    ru: '✅ Claude Monitor: Telegram подключён.',
  },
};

// The names the limits are given in alerts (the dashboard translates its own copy).
const LIMIT_NAMES = {
  kunlik: { en: 'daily', ru: 'дневной' },
  '5 soatlik': { en: '5-hour', ru: '5-часовой' },
  haftalik: { en: 'weekly', ru: 'недельный' },
  oylik: { en: 'monthly', ru: 'месячный' },
  '5 soatlik (obuna)': { en: '5-hour (subscription)', ru: '5-часовой (подписка)' },
  'haftalik (obuna)': { en: 'weekly (subscription)', ru: 'недельный (подписка)' },
  '5 soatlik sessiya': { en: '5-hour session', ru: '5-часовая сессия' },
  'Haftalik (hamma modellar)': { en: 'Weekly (all models)', ru: 'Недельный (все модели)' },
  'Haftalik (Opus)': { en: 'Weekly (Opus)', ru: 'Недельный (Opus)' },
  'Haftalik (Sonnet)': { en: 'Weekly (Sonnet)', ru: 'Недельный (Sonnet)' },
  'Haftalik (ilovalar)': { en: 'Weekly (apps)', ru: 'Недельный (приложения)' },
};

const languageOf = (settings) => (LANGUAGES.includes(settings?.language) ? settings.language : 'en');

/** A server message in the settings' language. */
export function msg(settings, key, values = {}) {
  const text = MESSAGES[key][languageOf(settings)] ?? MESSAGES[key].en;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole));
}

/** A limit's name in the settings' language. */
export const limitName = (settings, label) => LIMIT_NAMES[label]?.[languageOf(settings)] ?? label;

/** A moment as the settings' language writes it, in the settings' time zone. */
export const when = (settings, ms) =>
  new Date(ms).toLocaleString({ uz: 'uz-UZ', en: 'en-GB', ru: 'ru-RU' }[languageOf(settings)], { timeZone: settings.timeZone, dateStyle: 'medium', timeStyle: 'short' });
