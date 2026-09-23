# Claude Code Dashboard

A localhost dashboard that monitors every Claude Code session at once. Spend, tokens,
context usage, status, and activity across all your terminals on one page.

![Claude Code Dashboard screenshot](Screenshot.png)

<sub>Captured in demo mode. Every project, figure and log line above is made up — see
[Demo mode](#demo-mode).</sub>

> Began as a fork of [Stargx/claude-code-dashboard](https://github.com/Stargx/claude-code-dashboard),
> standalone since September 2026. The watcher and the interface have both been largely
> rewritten: corrected pricing and token accounting, a hardened file reader, subagent and
> background-task views, tool results in the log feed, reworked status detection, and a
> poll payload that stays small as the rest grows.

## Why?

Claude Code has no cross-session visibility. Running two or more sessions in separate
terminals means alt-tabbing to check status, no combined token/cost view, and no way to
see which session is active.

## Features

- **Live session monitoring** — auto-detects all Claude Code sessions
- **Usage header** — today / 7-day / 30-day spend, token counts, top model, 30-day sparkline
- **Cost tracking** — per-model rates, with cache writes billed by TTL and cache reads at 0.1x
- **Context window bar** — per session, sized to that session's actual limit
- **Status detection** — thinking (green), waiting (yellow), idle (orange), stale (dimmed).
  A session you closed stops waiting at once. See [How status is decided](#how-status-is-decided)
- **Session start time** — clock time plus elapsed, per card
- **Reasoning effort** — `low` / `medium` / `high`, beside the model
- **Permission mode badge** — `AUTO`, `AUTO-EDIT`, `PLAN`, `YOLO` — and the output mode
  when it is not `normal`
- **Alerts when a session waits for you** — an in-page banner, the tab-title count, and
  a desktop notification, so at least one lands whatever the window looks like. One
  switch governs all three. See [Alerts](#alerts)
- **Project filter** — matches the name, the full path, the branch or the model
- **Hide-stale and show-all-sessions toggles** — both persist across reloads
- **Connection health** — red dot and last-update age if the watcher stops responding
- **Subagents** — every one the session spawned, running or finished, each row labelled
  with its name, or with its type while it still runs. Click a row for the full brief it
  was given and its full report, with the tool-by-tool feed one click away. The whole
  list folds; it opens itself while an agent is still running
- **Background tasks** — anything the session pushed to the background. Their output
  never reaches the session log, so it is read from their output files; click a row for
  the tail of it. The list folds too, and opens itself while a task is still running
- **Recently touched files**, per session
- **Expandable log feed**, fetched on demand. Every row carries its argument — the
  command, the pattern, the URL — and each tool call is followed by how it ended.
  A success is a dim `→` carrying the first line of output; a failure is a red `err`
  with the exit code, so failures are the only thing in that column that reads as a
  word. **Click a row** for the full command and its output tail
- **Project name, path and branch** — the name is the folder alone, since the path above
  it repeats on every card. The full path is a labelled row beneath it, shortened to
  `~/projects/x`, so a nested project still shows what it sits under. The filter box
  searches the whole path, so filtering by a parent folder works
- **Click the name to open** the project folder in your file manager
- **Phone-friendly** — the header and the card grid reflow down to a phone screen
- **Cross-platform** — Windows, macOS, and Linux

## Quick Start

```bash
git clone https://github.com/OleksandrPoltavets/claude-code-dashboard.git
cd claude-code-dashboard
npm install
npm start
```

Open **http://localhost:3456**.

Run it in its own terminal tab. Your Claude Code sessions run as normal; the dashboard
watches them from the side.

## Demo Mode

```bash
DEMO=1 npm start
```

Serves a fixed, made-up dataset instead of your logs. Nothing under `~/.claude` is
opened and the file watcher never starts. Use it to try the interface before installing,
or to regenerate the screenshot above without publishing real project names or real spend.

The fixture lives in `demo.js`. It holds one thinking session, one waiting, two idle and
two stale, so every status colour appears at once. Timestamps are relative to start-up,
so the cards always read as "now". Edit that file to change what the screenshot shows.

## Install With A Coding Agent

If you would rather not do it by hand, paste the block below to Claude Code, Codex,
Cursor, or any other coding agent. It installs the dashboard, starts it, checks it
answers, and then asks you whether you want it to start at login.

````
Install the Claude Code Dashboard from https://github.com/OleksandrPoltavets/claude-code-dashboard

It is a localhost Node.js web dashboard that watches the Claude Code JSONL session
logs in ~/.claude/projects/ and shows every session's spend, tokens, context use and
status on one page. It reads those logs and never writes to them.

Do this:

1. Check node --version is 18 or later. Stop and tell me if it is not.
2. Clone the repo into ~/projects/claude-code-dashboard, or into wherever I usually
   keep repositories on this machine. If that directory already exists, do NOT clone
   over it: run `git remote -v` there first, and only `git pull` if it is already a
   clone of this repo. If it is some other repo, stop and ask me where to put this one.
3. Run npm install in it. It has two production dependencies, express and chokidar.
4. Start it detached, so you do not block on it:
   `mkdir -p logs && nohup npm start > logs/dashboard.log 2>&1 &`
   Then wait about three seconds. Do not run `npm start` in the foreground.
5. Verify it: `curl -s -o /dev/null -w "%{http_code}" localhost:3456/api/sessions`
   must print 200. If it does not, show me logs/dashboard.log. If the port is already
   taken, restart it with PORT=<free port> and use that port everywhere after this.
6. Check whether ~/.claude/projects exists. If it does not, tell me the dashboard
   will stay empty until I have run at least one Claude Code session.
7. Tell me the URL to open.

Rules:
- Do not run anything with sudo. This is a user-level tool.
- Do not modify, move or delete anything under ~/.claude. Read only.
- Do not open a port to anything but localhost.

Then ask me whether I want it to start automatically at login. Do not set that up
until I say yes. If I say yes, follow the "Run It On Boot" section of the repo's
README: a launchd agent on macOS, a systemd user unit on Linux, or a Task Scheduler
logon task on Windows. Use my real home directory, and use the output of `which node`
(`where node` on Windows) as the node path - do not copy the example paths. If I run
the 1M context tier, set CONTEXT_WINDOW=1000000; otherwise leave it out. Afterwards,
show me the command that proves it is running, and the command to undo it.
````

The agent should end with a URL for you to open, normally **http://localhost:3456**.

## Run It On Boot

The dashboard is more useful when it is always there. Each block below starts the watcher
at login, restarts it if it dies, and keeps its output in `logs/`.

### macOS (`launchd`)

`launchd` will not expand `~` or `$HOME`, so a plist needs absolute paths. Rather than
having you edit them in, the block below fills them from your own shell. Set `DASH` to
wherever you cloned the repo and paste the rest as-is.

```bash
DASH=~/projects/claude-code-dashboard          # where you cloned it
mkdir -p "$DASH/logs"

cat > ~/Library/LaunchAgents/local.claude-code-dashboard.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>local.claude-code-dashboard</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(which node)</string>
		<string>$DASH/watcher.js</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$DASH</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PORT</key>
		<string>3456</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>$DASH/logs/dashboard.log</string>
	<key>StandardErrorPath</key>
	<string>$DASH/logs/dashboard.error.log</string>
</dict>
</plist>
EOF

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.claude-code-dashboard.plist
```

`RunAtLoad` starts it at login. `KeepAlive` restarts it whenever it exits, and
`ThrottleInterval` holds the restart to once every 10 seconds so a crash cannot spin into
a loop. On the 1M context tier, add a `CONTEXT_WINDOW` key of `1000000` beside `PORT`.

Check it is up, and read its output:

```bash
launchctl list | grep claude-code-dashboard   # first column is the pid
curl -s localhost:3456/api/sessions | head -c 200
tail -f "$DASH/logs/dashboard.log"
```

After pulling new code, restart it:

```bash
launchctl kickstart -k gui/$(id -u)/local.claude-code-dashboard
```

After editing the plist, reload it, since `kickstart` keeps the copy launchd already read:

```bash
launchctl bootout gui/$(id -u)/local.claude-code-dashboard
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.claude-code-dashboard.plist
```

To stop it starting at login, boot it out and delete the plist. `logs/` is in
`.gitignore`, so nothing the agent writes is committed.

### Linux (`systemd --user`)

The same shape, as a user unit in `~/.config/systemd/user/claude-code-dashboard.service`:

```ini
[Unit]
Description=Claude Code Dashboard

[Service]
ExecStart=/usr/bin/node %h/projects/claude-code-dashboard/watcher.js
WorkingDirectory=%h/projects/claude-code-dashboard
Environment=PORT=3456
Environment=CONTEXT_WINDOW=1000000
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now claude-code-dashboard
systemctl --user status claude-code-dashboard
journalctl --user -u claude-code-dashboard -f
loginctl enable-linger "$USER"   # keeps it running while you are logged out
```

After pulling new code, or after editing the unit (run `systemctl --user daemon-reload`
first for that):

```bash
systemctl --user restart claude-code-dashboard
```

### Windows (Task Scheduler)

A logon task, created from an ordinary Command Prompt. Replace the paths with your own;
`where node` prints yours.

```bat
schtasks /create /tn "Claude Code Dashboard" /sc onlogon ^
  /tr "\"C:\Program Files\nodejs\node.exe\" \"%USERPROFILE%\projects\claude-code-dashboard\watcher.js\"" ^
  /rl limited /f
```

Set the environment variables machine-wide, since a task carries no shell of its own:

```bat
setx CONTEXT_WINDOW 1000000
setx PORT 3456
```

Check it, run it now without waiting for a logon, and remove it again:

```bat
schtasks /query /tn "Claude Code Dashboard"
schtasks /run   /tn "Claude Code Dashboard"
schtasks /delete /tn "Claude Code Dashboard" /f
```

After pulling new code, stop it and start it again:

```bat
schtasks /end /tn "Claude Code Dashboard"
schtasks /run /tn "Claude Code Dashboard"
```

The task runs with no console window. Unlike `launchd` and `systemd`, Task Scheduler
will not restart the watcher if it exits; tick **Restart on failure** in `taskschd.msc`
if you want that.

## Configuration

All optional, all environment variables:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3456` | Port to serve on |
| `CONTEXT_WINDOW` | `200000` | Starting context limit per session, in tokens |
| `RETENTION_DAYS` | `30` | Sessions idle longer than this are archived |
| `LOG_KEEP` | `200` | Log lines held per session |
| `TASK_DIR` | `/tmp/claude-<uid>`, or `<temp>/claude` on Windows | Where Claude Code writes background task output |
| `DEMO` | unset | `DEMO=1` serves made-up data and reads no real logs. See [Demo mode](#demo-mode) |

```bash
PORT=8080 CONTEXT_WINDOW=1000000 npm start
```

### `CONTEXT_WINDOW`

Claude Code does not record a session's context limit in its logs, so the dashboard
infers it. It starts at `CONTEXT_WINDOW` and steps up to 1M once a session is seen
using more than 200K in a single turn — a 200K session compacts before it can.

Set `CONTEXT_WINDOW=1000000` if you run the 1M context tier. Otherwise every session
reads as nearly full until it crosses 200K.

### `RETENTION_DAYS`

Sessions with no activity for this many days are folded into a running total and dropped
from memory. Their spend still counts in the header; they lose their card and their log.
This keeps memory flat on a long-running watcher.

## Reading the header

```
Sessions 0/20 of 115    Output 13.4M out    Cost $2,269.13
```

| Number | Meaning |
| --- | --- |
| `0` | Sessions busy right now — thinking or waiting for input |
| `20` | Cards drawn on screen |
| `115` | Every session found in the logs |

Fewer cards than sessions is normal. Each time you open Claude Code in a project — and
each `/clear`, which starts a new session file rather than continuing the old one — you
start another session, so a project accumulates many.

**The collapse only folds idle sessions.** Of those, the newest per project gets a card.
A `thinking` or `waiting` session always keeps its own card: one of them is working and
the other is asking you something, and folding either away would hide the thing you
opened the dashboard for.

So a project can legitimately show several cards at once. After a `/clear` you will
usually see two for a while — the session you just left, still `waiting` because it ended
on a question, and the one you are now in. The old one folds away on its own once it
passes the 30-minute `waiting` window.

The `newest only` / `all sessions` button in the header switches between the two views,
and carries the count it would add — `newest only (+135)`.

**The two toggles chain.** `newest only` works server side; `hide stale` then filters what
came back. Older sessions of a project are nearly always stale, so with `hide stale` on,
switching to `all sessions` can fetch a hundred sessions and show none of them. When every
held-back session is stale the button is disabled and says so, rather than doing nothing
visible.

The two cost figures cover different windows on purpose: the top row is **all time**,
the usage row's `30 days` is the **last 30 days**.

## How status is decided

| Status | When |
| --- | --- |
| `waiting` | The last turn ended in text with no tool call — it asked you something, or it finished and is waiting. Holds for 30 minutes, or until the session is closed |
| `thinking` | Anything else within the last 2 minutes — a tool call, a thinking block, input you just sent |
| `idle` | Neither of the above |
| `idle-stale` | Idle, and nothing today |

Status is decided by the last **conversational turn**, not by the last line in the file.
A finished turn is routinely followed by machinery that carries a timestamp: hook output
as a `system` event, an `attachment`, a background task's completion notification. In one
sampled session, 10 of 38 finished turns were followed by one of those within
milliseconds. Letting any of it stand as the turn makes a session that is waiting for you
look busy, and then idle. A `tool_result` is not a human turn either — it is the other
half of a tool call the assistant made.

The two windows are different lengths on purpose, and neither is short.

**A working session is not continuously noisy.** Measured across 4,173 consecutive-event
gaps in real logs: median 1s, p90 10s, p95 19s, **p99 240s**. A long tool call writes
nothing at all while it runs. 6.2% of gaps are over 15 seconds, so a short window reports
a busy session as idle.

**"Waiting for you" is a state, not a burst.** A session that asked you a question ten
minutes ago is still waiting. It expires after 30 minutes only so that yesterday's
finished sessions do not all sit there yellow. This is the status the desktop alert fires
on, so a short window would mean the alert almost never arrives.

**A closed session stops waiting at once.** Closing Claude Code writes nothing to the
log, so the log alone cannot tell a closed session from one still waiting for you. A
running Claude Code keeps a small file in `~/.claude/sessions/` naming its process id,
session id and folder, and deletes it on exit. A `waiting` session drops to `idle` when
no live process names its session id. A live SDK process also keeps open every session
in its folder, because it writes logs under session ids other than the one in its file.

Two limits. A closed session whose folder has a live SDK process keeps waiting out the
30 minutes, as before. And the file is undocumented and checked on macOS only: where `~/.claude/sessions/` does not exist, status falls back to the log alone.

## Alerts

Three channels, because each one fails somewhere. One switch — the `alerts` button —
governs all three.

| Channel | Works when | Fails when |
| --- | --- | --- |
| In-page banner | always | — |
| Tab-title count `(2)` | there is a tab bar | kiosk or chromeless window |
| Desktop notification | permission granted | the browser refuses, or there is no Notification API |

With `alerts off`, nothing announces a waiting session except its own card. That is the
point of the switch, but it is worth knowing before you turn it off.

The **banner** is the reliable one: a yellow bar under the header naming every session
waiting on you and how long each has been waiting. It needs no permission, no tab bar
and no Notification API, which is what a chromeless or kiosk window leaves you with.
Click a name to jump to that card and clear it from the bar — the session is still
waiting, this only stops the bar repeating something you have already seen. A cleared
session reappears if it goes busy and comes back to waiting, so acknowledging one can
never swallow the next one. Reloading the page clears the acknowledgements, since a
reload is a fresh look at what still needs you.

A **notification** fires once per session and re-arms when that session goes busy again.
When the browser is refusing notifications, the button keeps saying `alerts on` — the
setting is on — but carries an amber dot, and its tooltip says which channels are still
working and how to allow the rest. It re-checks when you come back to the tab, so
unblocking it in browser settings takes effect without a reload.

## How It Works

Claude Code writes JSONL session logs to `~/.claude/projects/`. The dashboard:

1. **Watches** those files with `chokidar`
2. **Parses** appended lines as they stream in, holding back any partial trailing line
3. **Serves** aggregated state over a small Express API
4. **Renders** a page that polls every 2 seconds

No WebSockets, no build step, no cloud services. A Node.js process reading local files.

Token counts are de-duplicated per message id. Claude Code rewrites the same message
repeatedly while streaming, so counting raw events roughly doubles both turns and tokens.

The reader is built for files being appended to underneath it. A second read of the same
file is locked out while one is in flight, and a file that is truncated or rotated resets
that session rather than freezing it.

### API

| Endpoint | Returns |
| --- | --- |
| `GET /api/sessions` | `{ sessions, totals, usage, serverTime }` — `?all=1` skips the newest-per-project collapse. `totals.hiddenCount` / `hiddenStaleCount` say what the collapse held back |
| `GET /api/sessions/:id/log` | Recent log entries for one session |
| `GET /api/sessions/:id/subagents/:agentId` | Summary, report, and step feed for one subagent |
| `GET /api/sessions/:id/tasks/:taskId` | Status, exit code, and output tail for one background task |
| `GET /api/sessions/:id/tools/:toolUseId` | Full input and output tail for one tool call |
| `POST /api/open-folder` | Opens a path in the OS file manager |

Logs are served separately because they were ~75% of every poll. Fetching them only for
expanded cards cut the payload by about 80%. Subagent transcripts are read from
`~/.claude/projects/<hash>/<session>/subagents/agent-<id>.jsonl` on click, for the same reason.

A background task's output is never streamed to the JSONL. The session log records only
that one was started and, later, a `queue-operation` notification that it finished - so
the live output has to come from elsewhere. Claude Code writes it to
`/tmp/claude-<uid>/<hash>/<session>/tasks/<taskId>.output`, and appends
`[exited with code N]` or `[killed]` when one ends. A task with neither marker that has
been silent for ten minutes is shown as `quiet`, not `run`.

Claude Code records no exit code for a tool call. A failed Bash arrives as a result with
`is_error` set and content opening `Exit code N`, so the code is parsed back out of that
text. The `toolUseResult` object beside each result carries the useful detail, but its
shape differs per tool — Bash has `stdout`/`stderr`, WebFetch an HTTP `code`, Edit a
`structuredPatch` — so the one-line outcome is written per tool rather than from one
common field. An output too large to inline is not in the log at all: Claude Code writes
it to a file and leaves a `persistedOutputPath`, which the detail endpoint reads on
demand.

The same notifications name subagents: an agent's finish note is keyed by its agent id,
so a finished subagent row carries its name too, and needs no other label. A running one
cannot be named - nothing in its transcript points back to the call that launched it - so
it is labelled with its type and the opening of its brief until it ends.

A task's name is not in its output file. A Bash task is named from the `description` of
the call that launched it, matched to the task id through the tool result; anything else
is named from the `Background command "x" completed` / `Agent "x" finished` notification
written when it ends. A row with neither - an agent-started task still running, or a
launch whose tool result was too large to keep inline - falls back to the task id.

## Requirements

- **Node.js** v18 or later
- **Claude Code**, any version that writes JSONL session logs

## Resource use

Measured on a MacBook Pro (14 cores, 24 GB) watching **163 sessions / 438 JSONL files /
505 MB** under `~/.claude/projects`. Scale from the session count, not the machine.

| | Measured |
| --- | --- |
| CPU, steady | 0–2% of one core, mostly 0 |
| Memory, steady | 85–170 MB |
| Memory, startup | ~560 MB for a few seconds |
| Open file descriptors | ~1,100 (≈ 1 per watched file, plus the process's own) |
| Browser poll | 37 KB every 2s over loopback — ~63 MB/hour, never leaves the machine |

**It is read-only.** There are no write calls anywhere in the code, and the running
process holds no writable descriptor under `~/.claude`. It cannot affect a Claude Code
session.

**It reads incrementally.** A change is read with
`createReadStream(file, { start: offset })`, so appending a line reads that line — not
the file. The largest session file in the sample was 26 MB and is never re-read.

**It is idle between changes.** No polling of the session logs; `chokidar` is
event-driven, which is why steady CPU is ~0. The one exception is `~/.claude/sessions/`,
a handful of small files read at most once a second while a page is open, to tell a
closed session from a waiting one.

### On a small machine

Two things scale, and neither is the CPU:

- **File descriptors, one per watched file.** A host with the common `ulimit -n` of 1024
  will hit `EMFILE` somewhere under a thousand session files. Check with `ulimit -n`
  before running it on a small VPS or a Raspberry Pi, and raise it or lower
  `RETENTION_DAYS`. On Linux the same applies to inotify watches — `sysctl
  fs.inotify.max_user_watches` is often 8192, shared with every other watcher on the box.
- **The startup spike**, which is the whole history being parsed once. It tracked roughly
  the size of `~/.claude/projects` in the sample. On a 512 MB host with a large history
  this is the number that bites, and `RETENTION_DAYS` is the lever — sessions older than
  it are folded into a running total and dropped from memory.

Steady-state memory is bounded by design: log lines, tool details, subagents and task
names all have per-session caps (`LOG_KEEP` and the constants beside it in `watcher.js`).

## Pricing

Rates live in `PRICING` in `watcher.js`, in USD per 1M tokens. Update them when Anthropic's
pricing changes:

```js
const PRICING = {
  'claude-opus-5':    { input: 5.00, output: 25.00 },
  'claude-sonnet-5':  { input: 3.00, output: 15.00 },
  'claude-haiku-4-5': { input: 1.00, output:  5.00 },
  // ...
};
```

Cache tokens are multipliers on the base input rate:

| Kind | Multiplier |
| --- | --- |
| Cache write, 5-minute TTL | 1.25x |
| Cache write, 1-hour TTL | 2x |
| Cache read | 0.1x |

Tokens are bucketed per model, so a subagent on a cheaper model does not reprice the
whole session.

Figures are estimates from your local logs at API rates. They are not a bill, and they do
not know about subscription plans or quotas.

## Tech Stack

- **Backend**: Node.js, Express, chokidar
- **Frontend**: single HTML file, React via CDN, no build step
- **Styling**: dark terminal aesthetic, IBM Plex Mono
- **Dependencies**: 2 production packages (`express`, `chokidar`)

## License

MIT. This work is copyright Oleksandr Poltavets; the original it builds on is copyright
Cold Beam Games. Both notices are in [LICENSE](LICENSE), and the second one stays there
permanently — MIT permits everything else but requires the original notice to travel with
the code.
