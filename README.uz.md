# Claude Monitor

[English](README.md) · **O‘zbekcha** · [Русский](README.ru.md)

Bir nechta kompyuterdagi Claude Code uchun bitta panel: qaysi kompyuter qancha token ishlatgani, bu API
narxida qancha turishi, sessiyalar, modellar, obunaning 5 soatlik va haftalik limitlari hamda ulardagi har
kompyuterning ulushi, xatolar va jonli oqim. Paneldan kompyuterga limit qo'yish yoki undagi Claude'ni
to'xtatish ham mumkin.

Qo'shimcha paket kerak emas: Node.js 22.13 yoki undan yangisi yetadi (ichidagi `node:sqlite` ishlatiladi).

## Qanday ishlaydi

```
 Kompyuter 1 ─┐  Claude Code OpenTelemetry (har so'rov: model, tokenlar, narx, akkaunt)
 Kompyuter 2 ─┼──────────────►  server.mjs  ──►  data/monitor.db  ──►  panel (brauzer)
 ...         ─┘  agent.mjs: eski loglar, limitlarning aniq foizi, limit tekshiruvi (hook'lar)
```

- **Jonli ma'lumot.** Claude Code'ning o'zida telemetriya bor
  ([monitoring-usage](https://code.claude.com/docs/en/monitoring-usage)). Har API so'rovidan keyin u modelni,
  tokenlarni, narxni (`cost_usd`) va akkauntni serverga yuboradi. Kompyuter o'z tokeni (`cm_...`) bilan tanitiladi.
- **Tarix.** Claude Code har sessiyani `~/.claude/projects/**/*.jsonl` ga yozadi. Agent ulardan faqat raqamlarni
  o'qiydi, shuning uchun telemetriya yoqilmasdan oldingi sarf ham ko'rinadi. Ikki yo'l bilan kelgan so'rov bir
  marta sanaladi (`req_...` raqami bo'yicha).
- **Nima yuborilmaydi.** Promptlar, javoblar, kod va fayllar: Claude Code ularni o'zi yashiradi (`<REDACTED>`),
  agent esa faqat raqamlarni va loyiha papkasining nomini oladi.

## Ishga tushirish

Serverni hamma kompyuter yeta oladigan joyda ishga tushiring: uy yoki ofis tarmog'idagi kompyuterda (turli
joylar uchun Tailscale qulay), yoki VPS'da.

```sh
node server.mjs                        # port 4318, ma'lumot ./data/monitor.db
PORT=8080 DATA=/srv/monitor.db node server.mjs
```

Windows PowerShell'da: `$env:PORT=8080; node server.mjs`.

1. `http://<server>:4318` ni oching va panel parolini qo'ying. Sahifa server ishga tushganda oynasida chiqqan
   **sozlash kodini** so'raydi (`Setup code: ...`): tarmoqdagi boshqa odam sizdan oldin panelni egallab ololmaydi.
2. **"Kompyuter qo'shish"** ni bosing, nom bering. Token faqat bir marta ko'rsatiladi.
3. O'sha kompyuterda panel ko'rsatgan ikkita buyruqni ishga tushiring:

   ```sh
   curl -o agent.mjs http://<server>:4318/agent.mjs
   node agent.mjs setup --server http://<server>:4318 --token cm_...
   ```

4. Claude Code'ni qayta oching. Birinchi so'rovdan keyin kompyuter panelda "Ishlayapti" bo'ladi.

`setup` telemetriya sozlamalarini `~/.claude/settings.json` dagi `env` bo'limiga yozadi (eskisi
`settings.json.bak` da qoladi), o'z hook'larini qo'shadi (boshqalarnikiga tegmaydi), o'zini
`~/.claude/claude-monitor/` ga nusxalaydi va o'tgan sarfni yuboradi. Loyihaning `.claude/settings.json` fayli
bunga yaramaydi: Claude Code telemetriyani faqat foydalanuvchi sozlamasidan oladi. O'chirish:
`node agent.mjs remove`.

| Hook | Qachon | Nima qiladi |
|---|---|---|
| `UserPromptSubmit` → `gate` | har prompt oldidan | kompyuter to'xtatilgan yoki limiti tugagan bo'lsa, promptni to'xtatadi |
| `PreToolUse` → `guard` | har asbob chaqiruvi oldidan | xuddi shu tekshiruv (javob 10 soniya eslab qolinadi): Claude javob o'rtasida ham to'xtaydi |
| `Stop` → `report` | har javob oxirida | aniq foizlarni yuboradi (ko'pi bilan daqiqada bir) |

Har hook taxminan 0.1 soniya oladi va server ishlamasa, hech biri ishni to'xtatmaydi.

**Agentni yangilash.** Agent o'zini o'zi yangilaydi (pastda). Qo'lda: yangi `agent.mjs` ni yuklab olib,
`node agent.mjs update` ni ishga tushiring — server va token sozlamadan olinadi. Claude Code hook'larni ishga
tushganda o'qiydi, shuning uchun keyin uni qayta oching.

### Telemetriyasiz (yoki u bilan birga)

```sh
node agent.mjs watch --server http://<server>:4318 --token cm_... --every 5
```

Loglarni har 5 daqiqada o'qib, yangisini yuboradi. Jonli emas, lekin hech qanday sozlama talab qilmaydi.

## Panelda nima bor

| Bo'lim | Nima ko'rsatadi |
|---|---|
| Umumiy | Har akkauntning obuna limitlari (halqalar, yangilanish vaqti, tezlik, kim qancha ishlatgani); bugun, hafta, oy (to'lov kunidan) va obuna qiymati; kompyuterlar bo'yicha kunlik sarf; kompyuterlar; modellar; token turlari; qatorlar, commit va PR; soatlar xaritasi; loyihalar; asboblar; xatolar |
| Tokenlar | Tanlangan davr uchun har model bo'yicha kiruvchi, chiquvchi, keshdan o'qilgan va keshga yozilgan tokenlar, aniq soni, so'rovlar va API narxi; xuddi shu har kompyuter uchun |
| Limitlar | Obuna limitlari; oxirgi 7 kundagi har 5 soatlik oyna modellar va kompyuterlar bo'yicha; bugun va kecha, shu va o'tgan hafta, shu va o'tgan oy |
| Kompyuterlar | Holati, tizimi, Claude Code versiyasi, IP, sarfi; bosilganda 30 kunlik grafik, modellar, sessiyalar va sozlamalar (nom, rang, limitlar, to'xtatish, ko'rish havolasi, yangi token, o'chirish) |
| Sessiyalar | Har Claude Code suhbati: kompyuter, akkaunt, davomiyligi, so'rovlar, token, narx, modellar, loyiha |
| Jonli oqim | Har API so'rovi kelishi bilan |
| Sozlamalar | Tarif, obuna kimniki, to'lov kuni, so'm kursi, vaqt mintaqasi, xabarlar tili, Telegram, parol, CSV eksport |

Panel **o'zbek, ingliz va rus** tilida (tepadagi menyu; sukut bo'yicha brauzer tili). Serverning o'z xabarlari —
ogohlantirishlar, Telegram, to'xtatilgan promptning sababi — Sozlamalardagi **xabarlar tilida**. Agent
kompyuter tilida gapiradi; boshqasini `CLAUDE_MONITOR_LANG=uz|en|ru` tanlaydi.

**Kompyuter holati.** "Ishlayapti": oxirgi 3 daqiqada so'rov bo'lgan. "Ulangan": 10 daqiqa ichida ma'lumot
kelgan. "Bugun ishlagan": 24 soat ichida. "Ulanmagan": undan uzoq. "Hali ulanmagan": hech narsa kelmagan.

## Aniq foiz (Claude Code'dagi /usage bilan bir xil)

Akkauntga kirgan kompyuterda bir marta:

```sh
node agent.mjs usage --server http://<server>:4318 --token cm_...
```

U 5 soatlik sessiya va haftalik foizni ekranga chiqaradi va panelga yuboradi; keyin hook'lar o'zi yuborib
turadi. Agent Claude Code'ning kirish kalitini shu kompyuterda o'qib, faqat Anthropic'ga yuboradi; serverga
faqat foizlar boradi. Foiz qaysi akkauntniki ekanini Anthropic profili aytadi, shuning uchun boshqa akkaunt
setup-token'i (`CLAUDE_CODE_OAUTH_TOKEN`) bilan ishlayotgan kompyuter ham to'g'ri akkauntga yuboradi.

**Kim qancha ishlatdi.** Har limit akkauntni ishlatgan kompyuterlarga, har birining shu davrdagi sarfiga qarab
bo'linadi (davr Anthropic aytgan yangilanish vaqtidan orqaga sanaladi): "5 soatlik 41%: Noutbuk 30%, Ofis-PC
8%, boshqa joylar 3%".

- **Boshqa joylar (taxminiy)** — claude.ai, telefon yoki agentsiz kompyuter. Panel avvalgi davrlardan 1% qancha
  turishini o'rganadi (har davr oxirgi hisobotining medianasi) va foizning kompyuterlar sarfi bilan
  tushuntirilmagan qismini shu yerga yozadi. Birinchi kunlarda hammasi kompyuterlarniki deb ko'rinadi.
- **Oylik (taxminiy).** Anthropic'da oylik limit yo'q; to'lov oyi haftalik limitlar bilan o'lchanadi — oy necha
  hafta bo'lsa, shuncha.
- **Tezlik.** 5 soatlik va haftalik halqalar ostida: shu tezlikda limit qachon tugashi (yangilanishdan oldin bo'lsa).

**Bitta kompyuterda bir nechta akkaunt.** Claude Code har so'rovning akkauntini (`user.account_uuid`, email)
yuboradi va har so'rov o'z akkauntiga hisoblanadi. Do'stingiz bir kompyuterda goh sizning, goh o'z akkauntini
ishlatsa, sizning foizingizga faqat sizning akkauntingizdagi ishi qo'shiladi. Eski loglardagi tarixda akkaunt
yo'q: u kompyuterning oxirgi akkauntiga hisoblanadi.

## Limitlar va to'xtatish

Kompyuter oynasida, **Limitlar** qismida:

- **Dollarda (API narxida):** kunlik, 5 soatlik oyna, haftalik, oylik.
- **Obuna foizida:** "5 soatlik sessiyadan 20%", "haftalikdan 15%" — kompyuterning Anthropic foizidagi
  ulushi. Aniq foiz kerak; u bo'lmasa, 0% ko'rinadi va hech narsani to'xtatmaydi.
- **Limitlar qaysi akkauntdagi sarfni sanaydi:** kompyuter bir nechta akkauntni ishlatsa, limit bittasini sanaydi
  va to'xtatish ham faqat o'sha akkaunt ishlatilayotganda qo'llanadi.
- **Limit tugasa promptlarni to'xtatish.** Belgilanmasa, faqat ogohlantirish keladi (80% va 100% da, har davrda bir marta).

**Claude'ni to'xtatish.** "⏸ Claude'ni to'xtatish" o'sha kompyuterda Claude'ni darhol to'xtatadi, "▶ Davom
ettirish" bosilguncha: yangi prompt bajarilmaydi, yozilayotgan javob esa keyingi asbob chaqiruvida tugaydi.
"Kuzatishni o'chirish" boshqa narsa: u faqat serverning shu kompyuterdan ma'lumot olishini to'xtatadi, Claude
Code ishlayveradi.

Bu tekshiruvlar agent o'rnatilgan kompyuterda, server ishlab turganda ishlaydi; kompyuter egasi hook'ni o'z
sozlamasidan olib tashlashi mumkin. Bu o'z kompyuterlaringiz va ishonchli odamlar uchun nazorat.

## Ko'rish havolasi

Kompyuter oynasidagi "🔗 Ko'rish havolasi" parolsiz ochiladigan sahifa beradi: unda faqat o'sha kompyuterning
sarfi, limitlari va akkaunt limitidagi ulushi (akkaunt jami bilan) ko'rinadi. Uni kompyuterdan foydalanayotgan
odamga bering. "Yangi havola" eskisini almashtiradi, "Havolani o'chirish" uni yopadi.

## Raqamlar qanday hisoblanadi

- **Narx API narxida.** Pro va Max obunasi har token uchun to'lanmaydi; panel xuddi shu ish API'da qancha
  turishini ko'rsatadi. "Obuna qiymati ×3.3" — $200 lik obuna shu oy $660 lik ish qildi. Bir nechta akkaunt
  kuzatilsa, faqat egasiniki sanaladi (Sozlamalar → "Obuna qaysi akkauntniki"; tanlanmasa — eng ko'p
  ishlatgani). Telemetriyadagi narxni Claude Code o'zi hisoblaydi; tarix `src/pricing.mjs` dan narxlanadi.
- **Akkaunt bilan kirib kompyuterlarni topish** imkoni yo'q: Anthropic obunaga ulangan qurilmalar yoki ularning
  sarfi uchun ochiq API bermaydi, shuning uchun har kompyuterda bir marta `setup` qilinadi.
- **5 soatlik oynalar.** Bir akkauntdagi so'rovlar, qaysi kompyuterdan bo'lmasin, bitta oynani bo'lishadi. Aniq
  foiz bo'lmasa, oxirgi 429 (limitga yetildi) paytidagi oyna sarfi asos bo'ladi.
- **Kunlar** Sozlamalardagi vaqt mintaqasida sanaladi, shuning uchun chet eldagi server ham sizning kunlaringizni hisoblaydi.

## O'zini o'zi tuzatadi

- **Yo'qolgan sarf.** Server o'chiq bo'lsa, kompyuter uxlab qolsa yoki token xato bo'lsa, telemetriya o'sha
  so'rovlarni yo'qotadi. Agent soatiga bir marta (fonda, Claude Code'ni kutdirmasdan) oxirgi loglarni qayta
  yuboradi: bo'shliqlar to'ladi, hech narsa ikki marta sanalmaydi.
- **Yangilanish.** Agent har 6 soatda o'zini serverdagi `agent.mjs` bilan solishtiradi va farq bo'lsa, sintaksis
  tekshiruvidan keyin yangisini olib, hook'larini sozlaydi.
- **Rad etilgan token.** "Yangi token" dan keyin eskisini yuborayotgan kompyuter panel ogohlantirishlarida
  ko'rinadi; uning Claude Code'i soatiga bir marta buni aytadi, `node agent.mjs status` esa "Aloqa: ✗" ko'rsatadi.

## Xavfsizlik

- Panel paroli scrypt bilan saqlanadi; sessiya cookie'si imzolangan (`HttpOnly`, `SameSite=Strict`). Bir
  manzildan daqiqasiga 5 tadan ortiq urinish qabul qilinmaydi.
- Birinchi parolni faqat server oynasidagi sozlash kodini bilgan odam qo'ya oladi.
- Proksi (Caddy, Nginx) ortida `TRUST_PROXY=1` bilan ishga tushiring: urinishlar haqiqiy manzil bo'yicha
  sanaladi. Proksisiz qo'ymang, aks holda `X-Forwarded-For` ni soxtalashtirib chegarani aylanib o'tish mumkin.
- Gzip so'rov ko'pi bilan 100 MB gacha ochiladi. Kompyuter tokenlari faqat xesh holida saqlanadi.
- Internet orqali serverni HTTPS ortiga qo'ying (masalan Caddy yoki Nginx), aks holda token va parol ochiq
  ketadi. Uy tarmog'i yoki Tailscale'da HTTP yetadi.

## Doimiy ishlashi

- **Linux (systemd):** `/etc/systemd/system/claude-monitor.service`

  ```ini
  [Service]
  WorkingDirectory=/opt/claude-monitor
  ExecStart=/usr/bin/node server.mjs
  Environment=PORT=4318
  Restart=always

  [Install]
  WantedBy=multi-user.target
  ```

- **Windows:** administrator sifatida ochilgan PowerShell'da bir marta:

  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts\autostart-windows.ps1
  ```

  Server kompyuter yoqilganda oynasiz ishga tushadi (hech kim kirmasa ham), yiqilsa bir daqiqada qayta turadi
  va firewall'da 4318 portini ochadi. Yozuvlari (sozlash kodi ham) `data\server.log` da. Oldin qo'lda ochilgan
  serverni yoping, aks holda port band bo'ladi. O'chirish: o'sha buyruq `-Remove` bilan.
- **Zaxira:** hammasi bitta faylda, `data/monitor.db`. Server har kuni uni `data/backups/` ga nusxalaydi va 14
  kunini saqlaydi. Qaytarish: serverni to'xtatib, nusxani `data/monitor.db` o'rniga qo'ying.

## Muammo bo'lsa

- **Kompyuter ulanmayapti.** Unda `node agent.mjs status` ni ishga tushiring: oxirgi qator ("Aloqa") server
  javob beryaptimi va tokenni qabul qilyaptimi, aytadi. Server manzili "localhost" bo'lmasin (u faqat serverning
  o'zida ishlaydi), server firewall'i 4318 portini ochsin.
- **415 xatosi.** `OTEL_EXPORTER_OTLP_PROTOCOL` `http/json` bo'lishi kerak: server protobuf'ni qabul qilmaydi.
- **Claude Code nima yuboryapti?** Serverni `MONITOR_DUMP=dump.jsonl node server.mjs` bilan ishga tushiring: har
  paket shu faylga yoziladi.

## Testlar

```sh
npm test
```

## Litsenziya

[MIT](LICENSE)
