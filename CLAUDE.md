# Claude Code Dashboard — working notes

Guide for an agent working on this repo. The README is written for users; this file is
what the code does not say about itself.

The project is built and running. This file was originally a pre-build brief; it
described a design that no longer matches the code, so it now records current state.

## What it is

A localhost dashboard over the Claude Code JSONL session logs in `~/.claude/projects/`.
It **reads those logs and never writes to them**. No cloud, no auth, no database.

```bash
npm start              # http://localhost:3456
DEMO=1 npm start       # fixed made-up data, no real log opened, watcher never starts
```

## Layout

| File | Lines | What |
| --- | --- | --- |
| `watcher.js` | ~1160 | Everything server side: parse, state, pricing, API |
| `public/index.html` | ~1200 | Whole frontend. React via CDN, **no build step** |
| `demo.js` | ~420 | Demo fixture and its routes |

Two production dependencies, `express` and `chokidar`. Keep it that way.

## Conventions that matter

- **No build step.** The page is one HTML file with React from a CDN. Do not add a
  bundler, JSX compilation, or a `src/` tree.
- **Keep the 2-second poll small.** Logs, subagent transcripts, background-task output
  and tool detail are all fetched per card on expand, never in the poll. Logs alone were
  ~75% of the payload before that split. Anything new that is large follows the same
  rule, and anything held per session must be excluded from the `...rest` spread in
  `GET /api/sessions`.
- **Bound everything held in memory.** A watcher runs for weeks. Per-session caches all
  have a cap: `LOG_KEEP`, `TOOL_DETAIL_KEEP`, `SUBAGENT_CACHE`, `TASK_NAME_CACHE`.
  The one deliberate exception is the per-message-id usage map, which must not be
  bounded by count — dropping an entry lets an old message be billed twice. It is
  released when the session is archived.
- **Colour is never the only signal.** Status shows a word as well as a colour; a
  subagent row reads `run` / `done`; a foldable list shows `+` / `−`.

## JSONL schema — what was actually found

Verified against real logs, not assumed. Re-verify before relying on any of it; Claude
Code changes.

- **Token usage is per message id, and messages are rewritten while streaming.**
  Counting raw events roughly doubles both turns and tokens. Deltas are taken against
  the stored cumulative value per message id, which also makes re-reading the same bytes
  harmless.
- **The context limit is not recorded.** It is inferred: start at `CONTEXT_WINDOW`, step
  up a tier once a turn is seen above 200K, since a 200K session compacts before it can.
- **There is no exit code for a tool call.** A failed Bash arrives as a `tool_result`
  with `is_error: true` whose content opens `Exit code N`. That text is the only source.
- **`toolUseResult` sits on the event beside the result, and its shape differs per
  tool.** Bash has `stdout`/`stderr`/`interrupted`/`timedOutAfterMs`; WebFetch has an
  HTTP `code`/`codeText`/`bytes`; Edit and Write have `structuredPatch`; Read has
  `file`. There is no common field, so outcome summaries are written per tool.
  `gitOperation` is an **object** shaped like `{push: {branch: 'main'}}`, not a string.
- **A large tool output never reaches the log.** Claude Code writes it to a file and
  leaves `persistedOutputPath` / `persistedOutputSize`, read on demand.
- **A background task's output is not in the JSONL either.** It goes to
  `/tmp/claude-<uid>/<hash>/<session>/tasks/<taskId>.output`, closed with
  `[exited with code N]` or `[killed]`. The session log records only the start and a
  `queue-operation` notification when it ends.
- **A subagent transcript lives one directory deeper** than the session log, at
  `<hash>/<session>/subagents/agent-<id>.jsonl`. Its events would otherwise set the
  session's project label to `subagents`.
- **A running subagent cannot be named.** Nothing in its transcript points back to the
  call that launched it, so it is labelled by type until its finish notification arrives.
- **`tool_result.content` is a string on most tools and an array of blocks on some.**
- **Reasoning effort is `effort` on every assistant event** (`low`/`medium`/`high`).
  `perTurnEffort` sits beside it as a single-turn override and is `null` unless set, so
  it takes precedence only when present.
- **Settings events carry no timestamp.** `{type: 'mode', mode, sessionId}` and
  `{type: 'permission-mode', permissionMode, sessionId}` have three keys and nothing
  else. They must be handled before the `!event.timestamp` guard, and must not touch
  `lastEventAt` — they are settings, not activity.
- **`permissionMode` values seen in practice are `auto` and `plan`**, not only the
  `acceptEdits` / `bypassPermissions` the UI originally knew about.
- **`attachment.identity.modelId` spells the context tier** (`claude-opus-5[1m]`). Rare
  — 10 occurrences in a 10-session sample — so the tier inference still stands, but this
  would be the direct signal if it turns out to be reliable.
- **Tool output carries terminal colour escapes**, which reach the feed as literal
  `[90m` noise unless stripped.

## Status

`deriveStatus` in `watcher.js`. The rules and, more importantly, why the windows are
these lengths:

| Status | When |
| --- | --- |
| `waiting` | Last turn ended in text with **no** tool call. Holds `WAITING_MS` (30 min) |
| `thinking` | Anything else within `THINKING_MS` (2 min) |
| `idle` | Neither |
| `idle-stale` | Idle, and nothing today. Applied in the API handler, not here |

**Status follows the last conversational turn, not the last event.** `lastTurnType` and
`lastTurnContentTypes` are set only by an `assistant` event or a genuine human `user`
turn; everything else leaves them alone. A finished turn is followed within milliseconds
by hook output as a `system` event, and by `attachment` events and background-task
notifications later — 10 of 38 finished turns in one sampled session. Taking the last
event instead made `waiting` unreachable: it was never observed once on 26 live sessions
before this was fixed.

**Do not shorten these without measuring first.** An earlier version used 15s and 60s
and had a dead zone: everything between them returned `idle`, so a session running a
one-minute command read as idle. Measured over 4,173 consecutive-event gaps in real
logs: median 1s, p90 10s, p95 19s, **p99 240s** — a long tool call writes nothing at all
while it runs, and 6.2% of gaps exceed 15s.

`waiting` is deliberately the long one. It is a state that persists until you answer,
not a burst of activity, and it is what the desktop alert fires on.

There is a `recentLog` check for `type === 'error'` above these rules that matches no
type the parser emits — pre-existing, left alone. Do not widen it to the `err` rows: a
failed grep or a failing test is normal work, not a session-level error.

## Pricing

`PRICING` in `watcher.js`, USD per 1M tokens, plus cache multipliers on the base input
rate (5-min write 1.25x, 1-hour write 2x, read 0.1x). Tokens are bucketed per model, so
a subagent on a cheaper model does not reprice the whole session. Update when Anthropic's
pricing changes; the README documents the table for users.

Figures are estimates from local logs at API rates. Not a bill, and they know nothing
about subscription plans or quotas.

## Demo mode

`DEMO=1` mounts `demo.js` routes ahead of the real ones and skips chokidar entirely. It
exists because the README screenshot cannot come from a live board: that leaks real
project names and spend, and it only shows whatever statuses happen to exist at the
time — in practice all `IDLE`.

**The fixture's field names must match what the frontend reads, and they are not the
obvious ones:** `cacheReadIn`, `bytes` on a task row, `lastTurnInputTotal` for the
context bar. Wrong names render silently wrong rather than erroring.

When a feature is added, add it to the fixture too, or the screenshot stops showing what
the README claims.

## Not goals

WebSocket push, sending messages to Claude Code, remote or multi-machine sessions,
authentication.

## Origin

Began as a fork of `Stargx/claude-code-dashboard`; a standalone repo since 2026-09-22.
`LICENSE` carries both copyrights. **The Cold Beam Games line cannot be removed** — MIT
permits everything else but requires the original notice to travel with the code.
