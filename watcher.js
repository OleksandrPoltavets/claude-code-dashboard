const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const chokidar = require('chokidar');

// --- Pricing --- (USD per 1M tokens)
const PRICING = {
  'claude-fable-5':    { input: 10.00, output: 50.00 },
  'claude-mythos-5':   { input: 10.00, output: 50.00 },
  'claude-opus-5':     { input: 5.00,  output: 25.00 },
  'claude-opus-4-8':   { input: 5.00,  output: 25.00 },
  'claude-opus-4-7':   { input: 5.00,  output: 25.00 },
  'claude-opus-4-6':   { input: 5.00,  output: 25.00 },
  'claude-sonnet-5':   { input: 3.00,  output: 15.00 }, // intro $2/$10 through 2026-08-31
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5':  { input: 1.00,  output: 5.00 },
  // Claude Code sometimes writes a bare family name instead of a full model id.
  'opus':              { input: 5.00,  output: 25.00 },
  'sonnet':            { input: 3.00,  output: 15.00 },
  'haiku':             { input: 1.00,  output: 5.00 },
};

// Cache multipliers on the base input price (Anthropic pricing).
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.00;
const CACHE_READ     = 0.10;

function getPricing(model) {
  if (!model) return PRICING['claude-opus-5'];
  for (const [key, val] of Object.entries(PRICING)) {
    if (model.includes(key)) return val;
  }
  return PRICING['claude-opus-5']; // fallback
}

// --- Context window --- (tokens)
// Claude Code does not record the session's context limit in the JSONL, so we
// infer it: start at the CONTEXT_WINDOW default and step up a tier once a turn
// is observed above it (a 200K session compacts before it can exceed 200K).
const CONTEXT_TIERS = [200_000, 1_000_000];
const DEFAULT_CONTEXT_WINDOW = Number(process.env.CONTEXT_WINDOW) || CONTEXT_TIERS[0];

// --- Retention ---
// Sessions older than this are folded into a running total and dropped from
// memory, so a long-lived watcher does not grow without bound.
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 30;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
// A file counts as "active" only if it was touched in the last few minutes.
const ACTIVE_FILE_WINDOW_MS = 15 * 60 * 1000;

// Usage from evicted sessions, so lifetime totals stay correct.
const archived = { costUSD: 0, tokensIn: 0, tokensOut: 0, sessionCount: 0 };

// Spend and tokens per calendar day, accumulated as events are parsed so it
// survives session eviction. Key is a local YYYY-MM-DD string.
const daily = new Map();
const DAILY_KEEP_DAYS = 90;
// Output tokens per model, for the "top model" readout.
const modelTotals = new Map();

function dayKey(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addToDaily(ts, cost, tokensOut, tokensAll) {
  const key = dayKey(ts);
  if (!key) return;
  const row = daily.get(key) || { date: key, costUSD: 0, tokensOut: 0, tokensAll: 0 };
  row.costUSD += cost;
  row.tokensOut += tokensOut;
  row.tokensAll += tokensAll;
  daily.set(key, row);
  if (daily.size > DAILY_KEEP_DAYS + 30) {
    for (const k of [...daily.keys()].sort().slice(0, daily.size - DAILY_KEEP_DAYS)) daily.delete(k);
  }
}

function costOfDelta(d, p) {
  return (d.in   * p.input  / 1_000_000) +
         (d.out  * p.output / 1_000_000) +
         (d.w5m  * p.input * CACHE_WRITE_5M / 1_000_000) +
         (d.w1h  * p.input * CACHE_WRITE_1H / 1_000_000) +
         (d.read * p.input * CACHE_READ     / 1_000_000);
}

// The per-message-id map is what makes a re-read of the same bytes harmless:
// deltas against the stored cumulative values come out as zero. Do NOT bound it
// by count - dropping an entry lets an old message be counted a second time.
// It is released when the session is archived.
// Subagent records kept per session, newest first.
const SUBAGENT_CACHE = 50;
// A subagent counts as running while it wrote within this window.
const SUBAGENT_ACTIVE_MS = 15_000;
// Directory Claude Code writes subagent transcripts into, beside the session file.
const SUBAGENT_DIR = 'subagents';
// Steps returned for one subagent transcript, newest kept.
const SUBAGENT_STEP_LIMIT = 300;
// Background tasks - a Bash call with run_in_background, or an agent moved to
// background execution - write their output beside the session in the temp
// tree, not into the JSONL. The session log records only the start and a
// finished notification, so live output has to be read from that directory.
// Windows has no uid, and Claude Code puts the tree straight under the user's
// temp directory there.
const TASK_ROOT = process.env.TASK_DIR || (typeof process.getuid === 'function'
  ? path.join('/tmp', `claude-${process.getuid()}`)
  : path.join(os.tmpdir(), 'claude'));
// Only recently active sessions are scanned: the temp output is short lived and
// a task can only still be running under a live session.
const TASK_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const TASK_CACHE_MS = 3_000;
// Bytes tailed for the status probe, and for the detail view.
const TASK_PROBE_BYTES = 400;
// A task with no exit line that has written nothing for this long is reported
// as quiet, not running: a killed task never writes its exit line.
const TASK_QUIET_MS = 10 * 60 * 1000;
// Task names kept per session, and Bash descriptions waiting for the task id
// their call turns into.
const TASK_NAME_CACHE = 200;
const PENDING_NAME_CACHE = 500;
const TASK_TAIL_BYTES = 20_000;
// Claude Code closes a background task's output with one of these: a clean exit
// carries its code, a terminated one does not.
const TASK_EXIT_RE = /\[exited with code (-?\d+)\]\s*$/;
const TASK_KILLED_RE = /\[killed\]\s*$/;
const TASK_END_RE = /\[(?:exited with code -?\d+|killed)\]\s*$/;

// Log lines held per session. Entries are capped at 120 chars, so 200 lines is
// ~30KB a session - only fetched when a card is expanded.
const LOG_KEEP = Number(process.env.LOG_KEEP) || 200;

function recomputeCost(session) {
  let total = 0;
  for (const [model, u] of Object.entries(session.usageByModel)) {
    const p = getPricing(model);
    total +=
      (u.in   * p.input  / 1_000_000) +
      (u.out  * p.output / 1_000_000) +
      (u.w5m  * p.input * CACHE_WRITE_5M / 1_000_000) +
      (u.w1h  * p.input * CACHE_WRITE_1H / 1_000_000) +
      (u.read * p.input * CACHE_READ     / 1_000_000);
  }
  session.costUSD = total;
}

function deriveSubagentStatus(sub) {
  const last = sub.lastEventAt ? new Date(sub.lastEventAt).getTime() : 0;
  return Date.now() - last < SUBAGENT_ACTIVE_MS ? 'thinking' : 'done';
}

// Cached per session so a 2s poll does not stat the same files every time.
const taskCache = new Map(); // sessionId -> { at, list }

function readTail(file, bytes, size) {
  const start = Math.max(0, size - bytes);
  const len = size - start;
  if (len <= 0) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// A background task's id means nothing on its own. Its name comes from the Bash
// call that launched it, or from the notification written when it ends.
const pendingTaskNames = new Map(); // tool_use id -> description

function rememberPendingTaskName(toolUseId, description) {
  if (!toolUseId || !description) return;
  pendingTaskNames.set(toolUseId, description.substring(0, 120));
  if (pendingTaskNames.size > PENDING_NAME_CACHE) {
    pendingTaskNames.delete(pendingTaskNames.keys().next().value);
  }
}

function setTaskName(session, taskId, name) {
  if (!name || session.taskNames[taskId]) return;
  session.taskNames[taskId] = name;
  const ids = Object.keys(session.taskNames);
  if (ids.length > TASK_NAME_CACHE) delete session.taskNames[ids[0]];
}

// Both notification shapes quote the name: a Bash task reads
// `Background command "x" completed`, an agent reads `Agent "x" finished`.
function noteTaskNotification(session, text) {
  const id = text.match(/<task-id>([A-Za-z0-9_-]+)<\/task-id>/);
  const summary = text.match(/<summary>([\s\S]*?)<\/summary>/);
  if (!id || !summary) return;
  const quoted = summary[1].match(/"([^"]+)"/);
  setTaskName(session, id[1], (quoted ? quoted[1] : summary[1]).trim().substring(0, 120));
}

function taskDir(session) {
  return path.join(TASK_ROOT, session.projectHash, session.sessionId, 'tasks');
}

function describeTask(name, st, tail) {
  const m = tail.match(TASK_EXIT_RE);
  const killed = TASK_KILLED_RE.test(tail);
  // The closing marker is already reported as the status, so the preview shows
  // the last line of real output instead.
  const lines = tail.split('\n').map(l => l.trim())
    .filter(l => l && !TASK_END_RE.test(l));
  const quiet = Date.now() - st.mtime.getTime() > TASK_QUIET_MS;
  return {
    taskId: name.slice(0, -'.output'.length),
    status: m ? 'done' : killed ? 'killed' : (quiet ? 'quiet' : 'running'),
    exitCode: m ? Number(m[1]) : null,
    bytes: st.size,
    updatedAt: st.mtime.toISOString(),
    lastLine: (lines[lines.length - 1] || '').substring(0, 120),
  };
}

function listBackgroundTasks(session) {
  const cached = taskCache.get(session.sessionId);
  if (cached && Date.now() - cached.at < TASK_CACHE_MS) return cached.list;

  const dir = taskDir(session);
  const list = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch { /* no tasks for this session */ }
  for (const name of names) {
    if (!name.endsWith('.output')) continue;
    try {
      // A subagent's entry here is a symlink to its transcript, and it already
      // has a row under Subagents.
      const st = fs.lstatSync(path.join(dir, name));
      if (!st.isFile()) continue;
      list.push(describeTask(name, st, readTail(path.join(dir, name), TASK_PROBE_BYTES, st.size)));
    } catch { /* file went away mid-scan */ }
  }
  list.sort((a, b) => {
    const rank = x => (x.status === 'running' ? 0 : x.status === 'quiet' ? 1 : 2);
    // 'done' and 'killed' both mean ended, so they share the last rank.
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });
  taskCache.set(session.sessionId, { at: Date.now(), list });
  return list;
}

function getContextLimit(session) {
  const seen = session.maxInputSeen || 0;
  const tier = CONTEXT_TIERS.find(t => t >= seen) || CONTEXT_TIERS[CONTEXT_TIERS.length - 1];
  return Math.max(DEFAULT_CONTEXT_WINDOW, tier);
}

// --- Session State ---
const sessions = new Map();
const fileOffsets = new Map(); // path -> byte offset
const seenMessageIds = new Map(); // sessionId -> Set of message.id

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      projectHash: '',
      cwd: '',
      label: '',
      model: '',
      gitBranch: '',
      status: 'idle',
      tokensIn: 0,
      tokensOut: 0,
      cacheCreationIn: 0,
      cacheReadIn: 0,
      costUSD: 0,
      turnCount: 0,
      activeFiles: [], // [{ name, at }] - pruned to a recent window on read
      recentLog: [],
      startedAt: null,
      lastEventAt: null,
      lastEventType: '',
      lastContentTypes: [],
      usageByModel: {}, // model -> {in,out,w5m,w1h,read}; each model is priced at its own rate
      lastTurnInputTotal: 0, // input + cache for context window estimate
      maxInputSeen: 0, // highest lastTurnInputTotal seen, for context-tier inference
      permissionMode: '',
      version: '',
      subagents: {}, // agentId -> see the subagent block in processEvent
      taskNames: {}, // background task id -> human name, see noteTaskNotification
    });
    seenMessageIds.set(sessionId, new Map()); // messageId -> {in, out, cacheCreate, cacheRead}
  }
  return sessions.get(sessionId);
}

function addToRecentLog(session, entry) {
  session.recentLog.push(entry);
  if (session.recentLog.length > LOG_KEEP) {
    session.recentLog = session.recentLog.slice(-LOG_KEEP);
  }
}

function extractActiveFiles(content) {
  const files = [];
  if (!Array.isArray(content)) return files;
  for (const block of content) {
    if (block.type === 'tool_use' && block.input) {
      const fp = block.input.file_path || block.input.path || block.input.command;
      if (fp && typeof fp === 'string' && !fp.includes(' ')) {
        files.push(path.basename(fp));
      }
    }
  }
  return files;
}

function processEvent(event, projectHash) {
  if (!event || !event.sessionId) return;
  // A queue-operation carries nothing else worth keeping, but the notification
  // in it is the only place an agent-started task's name appears.
  if (event.type === 'queue-operation') {
    if (typeof event.content === 'string' && event.content.includes('<task-notification>')) {
      noteTaskNotification(getOrCreateSession(event.sessionId), event.content);
    }
    return;
  }
  if (event.type === 'file-history-snapshot' || event.type === 'last-prompt') return;

  const session = getOrCreateSession(event.sessionId);
  if (!event.timestamp) return; // skip events without timestamps
  const ts = event.timestamp;

  if (!session.startedAt) session.startedAt = ts;
  session.lastEventAt = ts;
  session.lastEventType = event.type;
  session.projectHash = projectHash;

  if (event.cwd && !session.cwd) {
    session.cwd = event.cwd;
    const parts = event.cwd.split('/').filter(Boolean);
    session.label = parts.slice(-2).join('/');
  }
  if (event.gitBranch && !session.gitBranch) {
    session.gitBranch = event.gitBranch;
  }
  if (event.version) session.version = event.version;
  if (event.permissionMode) session.permissionMode = event.permissionMode;

  const msg = event.message || {};
  const content = msg.content;
  // Set by the assistant block below; the subagent block reuses it so subagent
  // tokens are not double counted when a message id is rewritten mid-stream.
  let outputDelta = null;
  const contentTypes = Array.isArray(content)
    ? content.map(c => c.type)
    : (typeof content === 'string' ? ['text'] : []);
  session.lastContentTypes = contentTypes;

  if (event.type === 'assistant' && msg.usage) {
    const msgId = msg.id;
    const usage = msg.usage;
    const seen = seenMessageIds.get(event.sessionId);

    // Only the main thread defines the session's model; a subagent on a cheaper
    // model must not reprice the whole session.
    const eventModel = msg.model || session.model;
    if (msg.model && !event.isSidechain && !event.agentId) session.model = msg.model;

    // Cache writes are billed by TTL: 1h costs 2x base input, 5m costs 1.25x.
    const cc = usage.cache_creation || {};
    const w1h = cc.ephemeral_1h_input_tokens || 0;
    const totalWrite = usage.cache_creation_input_tokens || 0;
    const w5m = cc.ephemeral_5m_input_tokens !== undefined
      ? cc.ephemeral_5m_input_tokens
      : Math.max(0, totalWrite - w1h);

    // Track per-message-id usage, only count the delta
    const prev = seen.get(msgId) || { in: 0, out: 0, w5m: 0, w1h: 0, cacheRead: 0, counted: false };
    const curr = {
      in: usage.input_tokens || 0,
      out: usage.output_tokens || 0,
      w5m,
      w1h,
      cacheRead: usage.cache_read_input_tokens || 0,
      counted: prev.counted,
    };

    // Add only the difference (later events for same msgId have cumulative values)
    const d = {
      in: Math.max(0, curr.in - prev.in),
      out: Math.max(0, curr.out - prev.out),
      w5m: Math.max(0, curr.w5m - prev.w5m),
      w1h: Math.max(0, curr.w1h - prev.w1h),
      read: Math.max(0, curr.cacheRead - prev.cacheRead),
    };

    outputDelta = d.out;
    session.tokensIn += d.in;
    session.tokensOut += d.out;
    session.cacheCreationIn += d.w5m + d.w1h;
    session.cacheReadIn += d.read;

    // Bucket the same delta under the model that actually produced it
    const bucket = session.usageByModel[eventModel]
      || (session.usageByModel[eventModel] = { in: 0, out: 0, w5m: 0, w1h: 0, read: 0 });
    bucket.in += d.in;
    bucket.out += d.out;
    bucket.w5m += d.w5m;
    bucket.w1h += d.w1h;
    bucket.read += d.read;

    seen.set(msgId, curr);

    // Track last turn's total input for context window estimate
    session.lastTurnInputTotal = curr.in + curr.w5m + curr.w1h + curr.cacheRead;
    session.maxInputSeen = Math.max(session.maxInputSeen, session.lastTurnInputTotal);

    recomputeCost(session);
    addToDaily(ts, costOfDelta(d, getPricing(eventModel)), d.out, d.in + d.out + d.w5m + d.w1h + d.read);
    modelTotals.set(eventModel, (modelTotals.get(eventModel) || 0) + d.out);

    // Log tool use
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          addToRecentLog(session, {
            time: ts,
            type: 'tool',
            msg: block.name + (block.input?.file_path ? `: ${path.basename(block.input.file_path)}` : ''),
          });
        } else if (block.type === 'text' && block.text) {
          const snippet = block.text.substring(0, 120);
          addToRecentLog(session, { time: ts, type: 'think', msg: snippet });
        }
      }
      // Track active files, newest first, with the time each was last touched
      const newFiles = extractActiveFiles(content);
      if (newFiles.length) {
        const kept = session.activeFiles.filter(f => !newFiles.includes(f.name));
        session.activeFiles = [...newFiles.map(name => ({ name, at: ts })), ...kept].slice(0, 20);
      }
    }

    // Count turns by unique message IDs with stop_reason. Claude Code rewrites
    // the same message id as it streams, so counting every event roughly doubles it.
    if (msg.stop_reason && !prev.counted) {
      session.turnCount++;
      curr.counted = true;
    }
  }

  // --- Subagent tracking ---
  if (event.agentId && !event.agentId.startsWith('acompact')) {
    const aid = event.agentId;
    if (!session.subagents[aid]) {
      session.subagents[aid] = {
        agentId: aid,
        task: '',
        agentType: '',
        model: '',
        tokensOut: 0,
        toolCount: 0,
        startedAt: ts,
        lastEventAt: null,
      };
    }
    const sub = session.subagents[aid];
    sub.lastEventAt = ts;

    if (event.attributionAgent && !sub.agentType) sub.agentType = event.attributionAgent;
    if (msg.model) sub.model = msg.model;

    // Count the tools it ran. The closing report is read from the transcript
    // on demand, so it is not held here.
    if (event.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') sub.toolCount++;
      }
    }

    // Capture task from first user message
    if (!sub.task && event.type === 'user' && msg.role === 'user') {
      const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.find(c => c.type === 'text')?.text : '');
      if (text) sub.task = text.substring(0, 120);
    }

    // Track subagent output tokens (delta only - see outputDelta above)
    if (outputDelta !== null) {
      sub.tokensOut += outputDelta;
    }

    // Keep only the most recent subagents; a long session spawns many.
    const aids = Object.keys(session.subagents);
    if (aids.length > SUBAGENT_CACHE) {
      aids
        .sort((x, y) => new Date(session.subagents[y].lastEventAt || 0) - new Date(session.subagents[x].lastEventAt || 0))
        .slice(SUBAGENT_CACHE)
        .forEach(id => delete session.subagents[id]);
    }
  }

  // --- Background task names ---
  if (event.type === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_use' && block.input && block.input.run_in_background) {
        rememberPendingTaskName(block.id, block.input.description);
      }
    }
  }
  if (event.type === 'user' && Array.isArray(content)) {
    // The tool result is what ties the launching call to the task id.
    for (const block of content) {
      if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
      const m = block.content.match(/background with ID: ([A-Za-z0-9_-]+)/);
      if (!m) continue;
      setTaskName(session, m[1], pendingTaskNames.get(block.tool_use_id));
      pendingTaskNames.delete(block.tool_use_id);
    }
  }
  if (event.type === 'user' && typeof content === 'string' && content.includes('<task-notification>')) {
    noteTaskNotification(session, content);
  }

  if (event.type === 'user' && msg.role === 'user') {
    const text = typeof content === 'string'
      ? content.substring(0, 120)
      : (Array.isArray(content) ? content.find(c => c.type === 'text')?.text?.substring(0, 120) : '');
    if (text) {
      addToRecentLog(session, { time: ts, type: 'user', msg: text });
    }
  }
}

function deriveStatus(session) {
  if (!session.lastEventAt) return 'idle';
  const elapsed = Date.now() - new Date(session.lastEventAt).getTime();

  if (elapsed > 60_000) return 'idle';

  // Check for error in recent log
  const lastLogs = session.recentLog.slice(-3);
  if (lastLogs.some(l => l.type === 'error')) return 'error';

  if (elapsed < 15_000) {
    if (session.lastEventType === 'assistant') {
      if (session.lastContentTypes.includes('tool_use')) return 'thinking';
      if (session.lastContentTypes.includes('text')) return 'waiting';
      if (session.lastContentTypes.includes('thinking')) return 'thinking';
    }
    if (session.lastEventType === 'progress') return 'thinking';
    if (session.lastEventType === 'user') return 'thinking'; // just sent input, waiting for response
  }

  return 'idle';
}

// --- JSONL File Processing ---
// Files being read right now. Without this, two quick change events both start
// at the same offset and process the same lines twice.
const inFlight = new Set();
// Trailing bytes of a line that was still being written when we read.
const partialLines = new Map();

function processFile(filePath) {
  if (inFlight.has(filePath)) return;

  let stat;
  try { stat = fs.statSync(filePath); } catch { return; }

  let offset = fileOffsets.get(filePath) || 0;
  if (stat.size < offset) {
    // File shrank (truncated or rotated). Rebuild this session from scratch,
    // otherwise it would be stuck at a stale offset forever.
    offset = 0;
    partialLines.delete(filePath);
    const sessionId = path.basename(filePath, '.jsonl');
    sessions.delete(sessionId);
    seenMessageIds.delete(sessionId);
  }
  if (stat.size <= offset) return;

  inFlight.add(filePath);
  // A subagent transcript sits at <hash>/<sessionId>/subagents/<file>, so its
  // project hash is three levels up, not one.
  const parent = path.dirname(filePath);
  const projectHash = path.basename(parent) === SUBAGENT_DIR
    ? path.basename(path.dirname(path.dirname(parent)))
    : path.basename(parent);
  // Read to a fixed end so bytes written mid-read are not consumed twice.
  const stream = fs.createReadStream(filePath, { start: offset, end: stat.size - 1, encoding: 'utf8' });
  let buffer = partialLines.get(filePath) || '';

  const finish = () => {
    inFlight.delete(filePath);
    // The file may have grown while we were reading it.
    try {
      if (fs.statSync(filePath).size > stat.size) processFile(filePath);
    } catch { /* file went away */ }
  };

  stream.on('error', () => { inFlight.delete(filePath); });
  // Parse complete lines as they arrive. Buffering the whole file first meant
  // holding hundreds of MB of JSONL in memory during the startup replay.
  stream.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        processEvent(JSON.parse(line), projectHash);
      } catch (e) {
        // Skip malformed lines (partial writes)
      }
    }
  });
  stream.on('end', () => {
    fileOffsets.set(filePath, stat.size);
    // Whatever is left has no newline yet: hold it until the rest arrives.
    partialLines.set(filePath, buffer);
    finish();
  });
}

// --- Express Server ---
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/open-folder', express.json(), (req, res) => {
  const folder = req.body.path;
  if (!folder || typeof folder !== 'string') return res.status(400).json({ error: 'No path' });
  if (!fs.existsSync(folder)) return res.status(404).json({ error: 'Folder not found' });
  const { execFile } = require('child_process');
  const plat = process.platform;
  if (plat === 'win32') {
    execFile('explorer', [folder.replace(/\//g, '\\')], () => {});
  } else if (plat === 'darwin') {
    execFile('open', [folder], () => {});
  } else {
    execFile('xdg-open', [folder], () => {});
  }
  res.json({ ok: true });
});

app.get('/api/sessions', (req, res) => {
  // Build list with derived status
  const all = [];
  for (const session of sessions.values()) {
    const status = deriveStatus(session);
    // Convert subagents object to a list, running first, then newest. A
    // finished agent stays in the list so its transcript is still reachable.
    const subagentList = Object.values(session.subagents)
      .map(sub => ({ ...sub, status: deriveSubagentStatus(sub) }))
      .sort((a, b) => {
        if ((a.status === 'thinking') !== (b.status === 'thinking')) return a.status === 'thinking' ? -1 : 1;
        return new Date(b.lastEventAt || 0) - new Date(a.lastEventAt || 0);
      });
    const { recentLog, usageByModel, taskNames, ...rest } = session;
    all.push({
      ...rest,
      status,
      costUSD: Math.round(session.costUSD * 10000) / 10000,
      contextLimit: getContextLimit(session),
      subagents: subagentList,
      // Names come from the log, the rows from disk, so they are joined here.
      backgroundTasks: Date.now() - new Date(session.lastEventAt || 0).getTime() < TASK_LOOKBACK_MS
        ? listBackgroundTasks(session).map(t => ({ ...t, name: taskNames[t.taskId] || '' }))
        : [],
      // Only files touched recently, so the list means "working on now"
      activeFiles: session.activeFiles
        .filter(f => Date.now() - new Date(f.at).getTime() < ACTIVE_FILE_WINDOW_MS)
        .slice(0, 10)
        .map(f => f.name),
      // Logs are fetched per-card on expand; sending them all every poll was
      // ~75% of the payload.
      logCount: recentLog.length,
    });
  }

  // Active sessions (thinking/waiting/error) always shown individually.
  // Idle sessions: only show the most recent per project label.
  const active = all.filter(s => s.status !== 'idle');
  const idle = all.filter(s => s.status === 'idle');
  // Collect labels that already have an active session
  const activeLabels = new Set(active.map(s => s.label));
  const latestIdleByLabel = new Map();
  for (const s of idle) {
    // Skip idle sessions if that project already has an active session
    if (activeLabels.has(s.label)) continue;
    const existing = latestIdleByLabel.get(s.label);
    if (!existing || new Date(s.lastEventAt || 0) > new Date(existing.lastEventAt || 0)) {
      latestIdleByLabel.set(s.label, s);
    }
  }

  // ?all=1 skips the collapse and returns every session the watcher holds.
  const result = req.query.all === '1'
    ? all
    : [...active, ...latestIdleByLabel.values()];
  // Sort: active today first (alphabetical), then inactive today (alphabetical)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  // Mark idle sessions not active today as 'idle-stale'
  for (const s of result) {
    if (s.status === 'idle' && (!s.lastEventAt || new Date(s.lastEventAt) < todayStart)) {
      s.status = 'idle-stale';
    }
  }
  result.sort((a, b) => {
    const aToday = a.lastEventAt && new Date(a.lastEventAt) >= todayStart ? 1 : 0;
    const bToday = b.lastEventAt && new Date(b.lastEventAt) >= todayStart ? 1 : 0;
    if (aToday !== bToday) return bToday - aToday; // active today first
    return (a.label || '').localeCompare(b.label || '');
  });
  // Totals cover every session the watcher knows about, not just the cards on
  // screen - the list above hides all but the newest session per project.
  let totalCost = archived.costUSD, totalOut = archived.tokensOut, totalIn = archived.tokensIn;
  for (const session of sessions.values()) {
    totalCost += session.costUSD;
    totalOut += session.tokensOut;
    totalIn += session.tokensIn;
  }

  res.json({
    sessions: result,
    totals: {
      costUSD: Math.round(totalCost * 10000) / 10000,
      tokensOut: totalOut,
      tokensIn: totalIn,
      sessionCount: sessions.size + archived.sessionCount,
      shownCount: result.length,
    },
    usage: buildUsage(),
    serverTime: new Date().toISOString(),
  });
});

// Rolling spend summary for the header: today, last 7 days, last 30 days, plus
// a day-by-day series for the sparkline.
function buildUsage() {
  const series = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = DAILY_KEEP_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    const row = daily.get(key);
    series.push({
      date: key,
      costUSD: row ? row.costUSD : 0,
      tokensOut: row ? row.tokensOut : 0,
      tokensAll: row ? row.tokensAll : 0,
    });
  }
  const sum = (n, field) => series.slice(-n).reduce((a, r) => a + r[field], 0);
  let topModel = '', topOut = 0;
  for (const [model, out] of modelTotals) {
    if (out > topOut && model && model !== '<synthetic>') { topOut = out; topModel = model; }
  }
  return {
    todayCost: sum(1, 'costUSD'),
    todayTokens: sum(1, 'tokensAll'),
    cost7d: sum(7, 'costUSD'),
    cost30d: sum(30, 'costUSD'),
    tokens30d: sum(30, 'tokensAll'),
    topModel,
    series: series.slice(-30),
  };
}

// Per-session log, fetched only while a card is expanded.
app.get('/api/sessions/:id/log', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Unknown session' });
  res.json(session.recentLog);
});

// One line of a subagent transcript, in the same shape as recentLog entries.
function describeTool(block) {
  const input = block.input || {};
  const arg = input.file_path || input.path || input.pattern || input.command || input.url || '';
  if (!arg || typeof arg !== 'string') return block.name;
  const short = (input.file_path || input.path) ? path.basename(arg) : arg;
  return `${block.name}: ${short.substring(0, 100)}`;
}

// Full transcript of one subagent, read from disk only when its row is opened.
app.get('/api/sessions/:id/subagents/:agentId', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Unknown session' });

  const agentId = req.params.agentId;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) {
    return res.status(400).json({ error: 'Bad agent id' });
  }
  const sub = session.subagents[agentId];
  if (!sub) return res.status(404).json({ error: 'Unknown subagent' });

  // Built from validated parts, then checked to be inside the watched tree.
  const file = path.join(WATCH_DIR, session.projectHash, session.sessionId, SUBAGENT_DIR, `agent-${agentId}.jsonl`);
  if (path.relative(WATCH_DIR, file).startsWith('..')) {
    return res.status(400).json({ error: 'Bad path' });
  }

  let raw;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch {
    return res.status(404).json({ error: 'No transcript on disk' });
  }

  const steps = [];
  // The agent's closing text is its report; keep it whole and separate.
  let result = '';
  let resultStep = -1;
  // The opening user message is the brief it was given, in full.
  let task = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const msg = event.message || {};
    const content = msg.content;
    if (!task && event.type === 'user' && typeof content === 'string' && content.trim()) {
      task = content;
      continue;
    }
    if (event.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use') {
        steps.push({ time: event.timestamp, type: 'tool', msg: describeTool(block) });
      } else if (block.type === 'text' && block.text.trim()) {
        result = block.text;
        resultStep = steps.length;
        steps.push({ time: event.timestamp, type: 'think', msg: block.text.substring(0, 300) });
      }
    }
  }

  // The report is shown on its own, so drop its duplicate feed entry.
  if (resultStep === steps.length - 1) steps.pop();
  else result = ''; // the agent stopped mid-tool: no closing report yet

  const started = sub.startedAt ? new Date(sub.startedAt).getTime() : 0;
  const ended = sub.lastEventAt ? new Date(sub.lastEventAt).getTime() : 0;
  res.json({
    agentId,
    agentType: sub.agentType,
    model: sub.model,
    status: deriveSubagentStatus(sub),
    task: task || sub.task,
    tokensOut: sub.tokensOut,
    toolCount: sub.toolCount,
    durationMs: started && ended ? ended - started : 0,
    result,
    truncated: steps.length > SUBAGENT_STEP_LIMIT,
    steps: steps.slice(-SUBAGENT_STEP_LIMIT),
  });
});

// Tail of one background task's output, read from the temp tree on demand.
app.get('/api/sessions/:id/tasks/:taskId', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Unknown session' });

  const taskId = req.params.taskId;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) {
    return res.status(400).json({ error: 'Bad task id' });
  }
  const dir = taskDir(session);
  const file = path.join(dir, `${taskId}.output`);

  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return res.status(404).json({ error: 'No output on disk' });
  }
  if (!st.isFile()) return res.status(404).json({ error: 'No output on disk' });

  const output = readTail(file, TASK_TAIL_BYTES, st.size);
  res.json({
    ...describeTask(`${taskId}.output`, st, output),
    name: session.taskNames[taskId] || '',
    truncated: st.size > TASK_TAIL_BYTES,
    output,
  });
});

// --- Start ---
const WATCH_DIR = path.join(os.homedir(), '.claude', 'projects');
const PORT = Number(process.env.PORT) || 3456;
const HOST = '127.0.0.1';

console.log(`Watching: ${WATCH_DIR}`);
console.log(`Dashboard: http://localhost:${PORT}`);

// Watch the projects directory (chokidar v5 needs directory, not glob)
const watcher = chokidar.watch(WATCH_DIR, {
  persistent: true,
  ignoreInitial: false,
  depth: 4, // reach projects/hash/session/subagents/*.jsonl
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
});

function shouldProcessFile(filePath) {
  return filePath.endsWith('.jsonl') && !path.basename(filePath).includes('compact');
}
watcher.on('add', (filePath) => {
  if (shouldProcessFile(filePath)) processFile(filePath);
});
watcher.on('change', (filePath) => {
  if (shouldProcessFile(filePath)) processFile(filePath);
});

// Fold long-dead sessions into the archived totals and release their memory.
function sweepOldSessions() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let dropped = 0;
  for (const [id, session] of sessions) {
    const last = session.lastEventAt ? new Date(session.lastEventAt).getTime() : 0;
    if (last >= cutoff) continue;
    archived.costUSD += session.costUSD;
    archived.tokensIn += session.tokensIn;
    archived.tokensOut += session.tokensOut;
    archived.sessionCount++;
    sessions.delete(id);
    seenMessageIds.delete(id);
    taskCache.delete(id);
    dropped++;
  }
  if (dropped) {
    console.log(`Archived ${dropped} session(s) older than ${RETENTION_DAYS} days`);
  }
}
setInterval(sweepOldSessions, SWEEP_INTERVAL_MS).unref();
setTimeout(sweepOldSessions, 30_000).unref(); // after the startup replay settles

const server = app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. Kill the existing process or use a different port.`);
    process.exit(1);
  }
  throw err;
});
