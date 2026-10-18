# Claude Monitor

**English** · [O‘zbekcha](README.uz.md) · [Русский](README.ru.md)

One dashboard for Claude Code on several computers: how many tokens each one used, what that would cost at
API prices, sessions, models, the subscription's 5-hour and weekly limits with each computer's share of
them, errors and a live feed. It can also limit a computer, or stop Claude on it, from the dashboard.

No packages to install: Node.js 22.13 or newer is enough (it uses the built-in `node:sqlite`).

## How it works

```
 Computer 1 ─┐  Claude Code's OpenTelemetry (each request: model, tokens, cost, account)
 Computer 2 ─┼──────────────►  server.mjs  ──►  data/monitor.db  ──►  dashboard (browser)
 ...        ─┘  agent.mjs: past logs, exact limit percentages, limit checks (hooks)
```

- **Live data.** Claude Code has telemetry built in
  ([monitoring-usage](https://code.claude.com/docs/en/monitoring-usage)). After each API request it sends the
  model, tokens, cost (`cost_usd`) and the account to the server. A computer is known by its own token (`cm_...`).
- **History.** Claude Code writes every session to `~/.claude/projects/**/*.jsonl`. The agent reads only the
  numbers from them, so usage from before telemetry was on shows too. A request that arrives both ways is
  counted once (by its `req_...` id).
- **What is never sent.** Prompts, answers, code and files: Claude Code redacts them itself (`<REDACTED>`), and
  the agent reads only numbers and the project folder's name.

## Getting started

Run the server somewhere every computer can reach: a computer on the home or office network (Tailscale works
well across places), or a VPS.

```sh
node server.mjs                        # port 4318, data in ./data/monitor.db
PORT=8080 DATA=/srv/monitor.db node server.mjs
```

On Windows PowerShell: `$env:PORT=8080; node server.mjs`.

1. Open `http://<server>:4318` and set the dashboard password. The page asks for the **setup code** the server
   printed when it started (`Setup code: ...`), so nobody else on the network can take the dashboard first.
2. Press **"Add computer"** and give it a name. The token is shown only once.
3. On that computer run the two commands the dashboard shows:

   ```sh
   curl -o agent.mjs http://<server>:4318/agent.mjs
   node agent.mjs setup --server http://<server>:4318 --token cm_...
   ```

4. Reopen Claude Code. After the first request the computer shows as "Working".

`setup` writes the telemetry settings into the `env` section of `~/.claude/settings.json` (the old file is kept
as `settings.json.bak`), adds its hooks (others' hooks are left alone), copies itself to
`~/.claude/claude-monitor/` and sends past usage. A project's `.claude/settings.json` does not work for this:
Claude Code takes telemetry settings only from the user settings. To undo: `node agent.mjs remove`.

| Hook | Runs | Does |
|---|---|---|
| `UserPromptSubmit` → `gate` | before each prompt | stops the prompt when the computer is stopped or over its limit |
| `PreToolUse` → `guard` | before each tool call | the same check (answer reused for 10 s), so Claude stops in the middle of an answer too |
| `Stop` → `report` | at the end of each answer | sends the exact percentages (at most once a minute) |
| `SessionStart` → `session` | when a session starts | remembers its model and puts the machine's rules in place |
| `PreModelSwitch` → `model` | before `/model` switches | refuses a model the machine may not use |
| `PostModelSwitch` → `switched` | after a model switch | remembers the session's new model |

**Models and effort.** In a computer's settings on the dashboard, tick the model families it may use (Fable,
Opus, Sonnet, Haiku) and pick an effort cap. The agent writes them into Claude Code's user settings
(`availableModels` with `enforceAvailableModels`, and `maxEffortLevel`), so Claude Code itself refuses other
models and runs a higher effort at the cap; the hooks check them too, and the dashboard tells you if a request
went past them anyway. Needs Claude Code 2.1.251 or later. Claude Code's own small helpers (session titles,
web pages) may still use Haiku.

Every hook takes about 0.1 s, and none of them stops work when the server is down.

**Updating the agent.** With `setup --auto-update` the agent updates itself (see below). By hand: download the new `agent.mjs` and run
`node agent.mjs update` — the server and token are taken from the settings. Claude Code reads hooks when it
starts, so reopen it afterwards.

### Without telemetry (or alongside it)

```sh
node agent.mjs watch --server http://<server>:4318 --token cm_... --every 5
```

Reads the logs every 5 minutes and sends what is new. Not live, but needs no settings at all.

## The dashboard

| Tab | Shows |
|---|---|
| Overview | Subscription limits per account (rings, reset times, pace, who used what); today, week, month (from the billing day) and the subscription's value; daily spending by computer; computers; models; token kinds; lines, commits and PRs; hours heat map; projects; tools; errors |
| Tokens | For a chosen period: input, output, cache-read and cache-write tokens per model with exact counts, requests and API price; the same per computer |
| Limits | The subscription limits; every 5-hour window of the last 7 days by model and computer; today vs yesterday, this week vs last, this month vs last |
| Computers | Status, system, Claude Code version, IP, spending; click for a 30-day chart, models, sessions and settings (name, color, limits, stop, share link, new token, delete) |
| Sessions | Every Claude Code conversation: computer, account, duration, requests, tokens, cost, models, project |
| Live feed | Each API request as it arrives |
| Settings | Plan, whose subscription it is, billing day, UZS rate, time zone, message language, Telegram, password, CSV export |

The dashboard speaks **Uzbek, English and Russian** (menu in the header; by default the browser's language).
The server's own messages — alerts, Telegram, the reason a stopped prompt shows — use the **message language**
set in Settings. The agent speaks the computer's language; `CLAUDE_MONITOR_LANG=uz|en|ru` chooses another.

**Computer status.** "Working": a request in the last 3 minutes. "Connected": data in the last 10 minutes.
"Active today": within 24 hours. "Offline": longer. "Not connected yet": nothing ever came.

## Exact percentages (the same as /usage in Claude Code)

Once, on a computer signed in to the account:

```sh
node agent.mjs usage --server http://<server>:4318 --token cm_...
```

It prints the 5-hour session and weekly percentages and sends them to the dashboard; from then on the hooks
keep sending them. The agent reads Claude Code's sign-in key on that computer and sends it only to Anthropic;
the server gets only the percentages. Which account they belong to comes from Anthropic's profile, so a
computer using a setup-token for another account (`CLAUDE_CODE_OAUTH_TOKEN`) reports to the right one.

**Who used how much.** Each limit is split between the computers that used the account, by what each spent in
that period (counted back from the reset time Anthropic gives): "5-hour 41%: Laptop 30%, Office-PC 8%,
elsewhere 3%".

- **Elsewhere (estimate)** — claude.ai, a phone, or a computer without the agent. The dashboard learns from past
  periods what 1% costs (the median of each period's last report) and puts the part of the percentage the
  computers' spending does not explain here. In the first days everything looks like the computers'.
- **Monthly (estimate).** Anthropic has no monthly limit; the billing month is measured in weekly limits, as
  many as it has weeks.
- **Pace.** Under the 5-hour and weekly rings: at the recent pace, when the limit runs out (if before it resets).

**One computer, several accounts.** Claude Code sends each request's account (`user.account_uuid`, email), and
every request counts against its own account. A friend switching between your account and theirs on one
computer adds to your percentages only what they did on yours. History from old logs has no account and
counts against the computer's last one.

## Limits and stopping

In a computer's window, under **Limits**:

- **In dollars (API prices):** daily, 5-hour window, weekly, monthly.
- **In subscription percent:** "of the 5-hour session 20%", "of the weekly 15%" — the computer's part of
  Anthropic's percentage. Needs the exact percentages; without them it reads 0% and stops nothing.
- **Which account the limits count:** when a computer uses several accounts, the limits can count one of them,
  and stopping then applies only while that account is in use.
- **Stop prompts when a limit runs out.** Unchecked, only alerts come (at 80% and 100%, once per period).

**Stop Claude.** "⏸ Stop Claude" stops Claude on that computer at once, until "▶ Resume": no new prompt runs,
and an answer being written ends at its next tool call. "Turn watching off" is something else: the server only
stops taking that computer's data, Claude Code keeps working.

These checks run where the agent is set up, while the server is up; the computer's owner can remove the hook
from their settings. It is a control for your own computers and people you trust.

## Share link

"🔗 View link" in a computer's window gives a page that opens without the password and shows only that
computer's spending, limits and part of each account's limits (with the account's total). Give it to the
person using the computer. "New link" replaces it, "Turn the link off" closes it.

## How the numbers are counted

- **Prices are API prices.** A Pro or Max subscription is not billed per token; the dashboard shows what the
  same work would cost on the API. "Subscription value ×3.3" means a $200 plan did $660 of work this month.
  With several accounts watched, only the owner's counts (Settings → "Whose subscription it is"; else the
  busiest). Telemetry's cost is Claude Code's own; history is priced from `src/pricing.mjs`.
- **There is no way to find computers by signing in with the account:** Anthropic offers no public API for the
  devices on a subscription or their usage, so each computer runs `setup` once.
- **5-hour windows.** Requests on one account share a window, from whichever computer. Without exact numbers,
  the window spent at the last 429 (limit reached) is the reference.
- **Days** follow the time zone in Settings, so a server abroad still counts your days.

## Repairs itself

- **Lost usage.** When the server is down, a computer sleeps or its token is wrong, telemetry loses those
  requests. Once an hour the agent (in the background, without holding up Claude Code) sends the recent logs
  again: the gaps fill, nothing counts twice.
- **Updating.** Only when set up with `--auto-update`: every 6 hours the agent compares itself with the
  server's `agent.mjs` and, when they differ, takes the new one (after a syntax check) and lets it set its
  hooks. It is off by default because it runs the server's code on the computer, where Claude Code's sign-in
  key is: turn it on only for a server you trust, over HTTPS or Tailscale.
- **Refused token.** After "New token", a computer still sending the old one shows in the dashboard's alerts;
  its Claude Code says so once an hour, and `node agent.mjs status` shows "Link: ✗".

## Security

- The dashboard password is kept with scrypt; the session cookie is signed (`HttpOnly`, `SameSite=Strict`, and
  `Secure` over HTTPS) and kept on the server, so "Sign out" ends it everywhere. A new password ends every
  session and needs the current one. More than 5 attempts a minute from one address are refused.
- Only someone with the setup code from the server's window can set the first password.
- Behind a proxy (Caddy, Nginx) start with `TRUST_PROXY=1` so attempts are counted per real address (the last
  one in `X-Forwarded-For`, the one the proxy adds). Without a proxy leave it off. If the proxy does not send
  `X-Forwarded-Proto: https`, set `COOKIE_SECURE=1`.
- Gzip bodies unpack to 100 MB at most. Machine tokens are kept only as hashes. Telemetry is checked: costs
  and counts never go below zero, texts are cut to a sane length.
- A machine's token speaks only for that machine: it can report the percentages only of accounts its own
  telemetry shows it using. Unknown tokens are told about at most 5 times a day.
- The machines' limits are kept by the agent's hooks: whoever runs a computer can take the hooks out, and
  while the server cannot be reached nothing is stopped. They keep honest people within limits, not someone
  set on getting round them.
- The database (and `backups/`) holds the password's hash, the session secret and the Telegram token: keep
  the data folder to the server's user (on Linux and macOS the files are made readable only by it).
- The exact percentages come from Anthropic's `api/oauth/usage`, which is not a documented API: it may change.
- Over the internet put the server behind HTTPS (e.g. Caddy or Nginx), or tokens and the password travel in
  the clear. On a home network or Tailscale, HTTP is enough.
- `node agent.mjs setup` takes the token from `CLAUDE_MONITOR_TOKEN` too, to keep it out of the shell's history.
- Old rows are cleared: tool events after `EVENT_DAYS` (180), seen alerts after 90 days. Requests are kept,
  unless `KEEP_DAYS` says how many days to keep.

## Keeping it running

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

- **Windows:** in PowerShell opened as administrator, once:

  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts\autostart-windows.ps1
  ```

  The server starts at boot without a window (even before anyone signs in), restarts within a minute after a
  crash and opens port 4318 in the firewall. Its output (the setup code too) goes to `data\server.log`. Close
  a server started by hand first, or the port is taken. To undo: the same command with `-Remove`.
- **Backups:** everything is in one file, `data/monitor.db`. The server copies it daily to `data/backups/` and
  keeps 14 days. To restore: stop the server and put a copy in place of `data/monitor.db`.

## Troubleshooting

- **A computer does not connect.** Run `node agent.mjs status` on it: the last line ("Link") says whether the
  server answers and takes the token. The server address must not be "localhost" (that works only on the
  server itself), and the server's firewall must let port 4318 in.
- **Error 415.** `OTEL_EXPORTER_OTLP_PROTOCOL` must be `http/json`: the server does not take protobuf.
- **What does Claude Code send?** Start the server with `MONITOR_DUMP=dump.jsonl node server.mjs`: every payload
  is written to that file.

## Tests

```sh
npm test
```

## License

[MIT](LICENSE)
