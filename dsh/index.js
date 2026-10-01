// dsh-ops-monitor - Host half
//
// Purpose: record every tool call the agent makes, in real time, so the user
// can see what the agent is doing on their machine instead of trusting a
// summary.
//
// Why this layer: every tool call passes through `tools/result`, regardless of
// whether it touches the filesystem or spawns a process. A FileSystemWatcher
// only ever sees the subset that writes to disk -- measured at roughly 13% of
// real operations on a live session -- and read/search/fetch are invisible to it.
//
// Two ways out:
//   - RPC  `feed`         consumed by the browser half (client.js)
//   - HTTP GET /ops-feed  consumed by external scripts
//
// Zero dependencies: node builtins only.

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const name = 'dsh-ops-monitor';
export const inject = ['tools', 'sessions'];

const MAX_LINES = 5000;      // in-memory window served to clients
const MAX_ARG_CHARS = 400;   // per-entry argument summary cap

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value, max) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : safeStringify(value);
  if (text === undefined) return '';
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length} chars)`;
}

// Compress a tool's arguments into one readable line.
// Only an allowlist of keys is used; bulk payloads such as `content` are
// deliberately excluded so the feed stays small and never carries file bodies.
function summarizeArgs(args) {
  if (args === undefined || args === null) return '';
  if (typeof args !== 'object') return truncate(args, MAX_ARG_CHARS);

  const prefer = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description'];
  const parts = [];
  for (const key of prefer) {
    if (args[key] !== undefined) parts.push(`${key}=${truncate(args[key], 160)}`);
  }
  if (parts.length === 0) return truncate(args, MAX_ARG_CHARS);
  const joined = parts.join('  ');
  return joined.length <= MAX_ARG_CHARS ? joined : `${joined.slice(0, MAX_ARG_CHARS)}…`;
}

function classify(toolName) {
  switch (toolName) {
    case 'read':
    case 'read_image':
      return 'read';
    case 'write':
      return 'write';
    case 'edit':
      return 'edit';
    case 'glob':
    case 'grep':
      return 'search';
    case 'bash':
    case 'pwsh':
    case 'terminal_open':
    case 'terminal_write':
      return 'exec';
    case 'web_search':
    case 'web_fetch':
      return 'fetch';
    case 'subagent':
    case 'subagent_fork':
    case 'spawn_teammate':
    case 'workflow':
      return 'delegate';
    case 'ask_user_question':
      return 'ask';
    case 'present':
      return 'deliver';
    default:
      return 'other';
  }
}

export function apply(ctx, config = {}) {
  // Where the durable copies go.
  //
  // process.cwd() is the dsh profile directory, not the user's workspace, so a
  // plain default writes the logs somewhere surprising. Order of preference:
  // an explicit config value, the workspace of the session that owns the call,
  // then cwd as a last resort.
  const configured = config.workspace ?? null;
  let workspace = null;
  let opsDir = null;
  let feedPath = null;
  let controlPath = null;
  let resolvedFrom = configured ? 'config' : 'unresolved';

  const buffer = [];
  let total = 0;
  const startedAt = Date.now();
  // Before a session workspace is known, control markers go to a temp file.
  // They are NOT written into process.cwd(): doing that would bind the
  // workspace early and short-circuit session-cwd resolution, which is exactly
  // the bug the harness caught.
  const bootstrapControl = join(tmpdir(), 'dsh-ops-monitor-control.log');

  function bindWorkspace(dir) {
    workspace = dir;
    opsDir = join(dir, '.dsh-ops');
    feedPath = join(opsDir, 'feed.jsonl');
    controlPath = join(opsDir, 'control.log');
    try {
      mkdirSync(opsDir, { recursive: true });
    } catch {
      // a missing directory only means the durable copy is skipped
    }
  }

  function control(marker) {
    const target = controlPath ?? bootstrapControl;
    try {
      appendFileSync(target, `${new Date().toISOString()}  ${marker}\n`, 'utf8');
    } catch {
      // ignore
    }
  }

  // Resolve the workspace from the session that owns the tool call. The
  // `sessions` service exposes binding(id) and scope(id); either may carry the
  // session header with its cwd.
  function workspaceFor(sessionId) {
    if (!sessionId) return null;
    const pick = (obj) => {
      const candidate = obj?.session?.header?.cwd ?? obj?.header?.cwd ?? obj?.cwd;
      return typeof candidate === 'string' && candidate ? candidate : null;
    };
    try {
      const found = pick(typeof ctx.sessions?.binding === 'function' ? ctx.sessions.binding(sessionId) : undefined);
      if (found) return found;
    } catch {
      // fall through
    }
    try {
      const found = pick(typeof ctx.sessions?.scope === 'function' ? ctx.sessions.scope(sessionId) : undefined);
      if (found) return found;
    } catch {
      // fall through
    }
    return null;
  }

  function ensureBound(sessionId) {
    if (opsDir) return;
    const found = workspaceFor(sessionId);
    if (found) {
      bindWorkspace(found);
      resolvedFrom = 'session cwd';
      control(`workspace resolved from session cwd: ${found}`);
      return;
    }
    bindWorkspace(process.cwd());
    resolvedFrom = 'process cwd (fallback)';
    control(`workspace fell back to process cwd: ${process.cwd()}`);
  }

  function record(entry) {
    // The durable file is the single source of truth. There is deliberately no
    // in-memory ring buffer: if this plugin ends up mounted more than once (a
    // bundle row plus a patch row both resolving), per-instance buffers diverge
    // and every reader reports a different count. Reading the file makes all
    // readers agree, whichever instance answers.
    if (!feedPath) return;
    try {
      appendFileSync(feedPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // never let a logging failure affect the agent's tool call
    }
  }

  // Read the durable feed and return its most recent `limit` entries, plus
  // honest totals. Bounded read: the whole file is only parsed when small, and
  // the tail slice is generous but capped.
  function readFeed(limit) {
    const empty = { entries: [], total: 0, buffered: 0 };
    if (!feedPath) return empty;
    // Guard the parameter: a caller passing undefined must not collapse the
    // slice to a single entry.
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Number.MAX_SAFE_INTEGER;
    try {
      const info = statSync(feedPath);
      if (info.size === 0) return empty;
      const byteCap = 2 * 1024 * 1024;
      let text;
      let truncated = false;
      if (info.size <= byteCap) {
        text = readFileSync(feedPath, 'utf8');
      } else {
        const all = readFileSync(feedPath, 'utf8');
        text = all.slice(all.length - byteCap);
        truncated = true;
      }
      const lines = text.split('\n');
      // when truncated, the first line is a fragment and must be dropped
      if (truncated && lines.length > 1) lines.shift();
      // Drop empty lines BEFORE slicing. A trailing newline otherwise adds a
      // phantom element, so "last N elements" returns N-1 real records.
      const records = lines.filter((l) => l.length > 0);
      const total = records.length;
      const slice = records.length <= cap ? records : records.slice(records.length - cap);
      const entries = [];
      for (const line of slice) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed));
        } catch {
          // a torn final write; skip it rather than failing the whole read
        }
      }
      return { entries, total, buffered: total };
    } catch {
      return empty;
    }
  }

  function readExec(execution) {
    const id = execution?.agent?.id;
    return {
      name: typeof execution?.name === 'string' ? execution.name : 'unknown',
      callId: execution?.callId === undefined ? undefined : String(execution.callId),
      agent: id === undefined ? undefined : String(id),
    };
  }

  // --- listener fire counters ---
  //
  // A listener that never fires is indistinguishable from a plugin that failed
  // to load, unless the listener itself reports. These counters make the
  // difference observable from control.log alone: a timer proves apply() ran,
  // and the per-event counts prove whether dispatch reaches this plugin.
  const fired = { tool: 0, dispatch: 0, approval: 0 };
  const heartbeat = config.heartbeat === true;
  let heartbeatTimer = null;
  if (heartbeat) {
    heartbeatTimer = setInterval(() => {
      control(
        `heartbeat: dispatch=${fired.dispatch} result=${fired.tool} approval=${fired.approval} `
        + `workspace=${workspace ?? '(unresolved)'}`,
      );
    }, 15000);
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }

  // --- every tool dispatch: the reliable, scope-independent hook ---
  //
  // `tools/result` is scope-filtered (keyed by exec.agent), so a listener on
  // the root scope never sees agent-scoped calls: a live run reported
  // approval=1 while dozens of tool calls produced result=0. `tools/execute`
  // wraps every dispatch regardless of scope, which is what a monitor needs.
  //
  // It is a WATERFALL: next() must run or the tool call stalls. The record is
  // written before next() so a throw in our own code cannot skip it, and the
  // whole body is wrapped so a logging failure cannot break tool dispatch.
  ctx.on('tools/execute', (execution, next) => {
    try {
      fired.dispatch += 1;
      const { name: toolName, callId, agent } = readExec(execution);
      ensureBound(agent);
      record({
        t: Date.now(),
        kind: 'tool',
        phase: 'dispatch',
        name: toolName,
        cls: classify(toolName),
        callId,
        agent,
        args: summarizeArgs(execution?.arguments),
      });
    } catch {
      // contained: never let the monitor break a tool call
    }
    return next();
  });

  // --- tool outcome, when it reaches this scope ---
  //
  // Kept because it carries the error detail. On a root-scope mount it may
  // never fire; the dispatch hook above is the one that always does.
  ctx.on('tools/result', (execution, result) => {
    try {
      fired.tool += 1;
      const { name: toolName, callId, agent } = readExec(execution);
      ensureBound(agent);
      const isError = result?.isError === true;
      record({
        t: Date.now(),
        kind: 'tool',
        phase: 'result',
        name: toolName,
        cls: classify(toolName),
        callId,
        agent,
        args: summarizeArgs(execution?.arguments),
        isError,
        error: isError ? truncate(result?.error?.message ?? 'unknown error', 300) : undefined,
      });
    } catch {
      // contained: a listener failure must not break tool dispatch
    }
  });

  // --- approval requests: the moment the agent is waiting on the user ---
  ctx.on('approval/request', (req, next) => {
    try {
      fired.approval += 1;
      record({
        t: Date.now(),
        kind: 'approval',
        name: typeof req?.toolName === 'string' ? req.toolName : 'approval',
        cls: 'approval',
        args: truncate(req?.reason ?? req?.description ?? '', 300),
      });
    } catch {
      // ignore
    }
    // waterfall event: not calling next() would stall the approval flow
    return next();
  });

  function snapshot(limit = 200) {
    const n = Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LINES) : 200;
    if (!opsDir) ensureBound(undefined);
    const feed = readFeed(n);
    return {
      entries: feed.entries,
      total: feed.total,
      buffered: feed.buffered,
      startedAt,
      workspace,
      workspaceResolvedFrom: resolvedFrom,
      feedPath,
    };
  }

  // RPC surface for the browser half. Method name matches host.call('feed').
  if (typeof ctx.provide === 'function') {
    ctx.provide('feed', (args) => snapshot(Number(args?.limit)));
  }

  // HTTP surface for external scripts.
  //
  // `webServer` only exists under a web composition and may not be resolvable
  // synchronously at load time, so this walks a short retry ladder and records
  // every attempt. Walking the ladder is what makes a failure diagnosable from
  // control.log alone, rather than one opaque "unavailable" line.
  let httpState = 'not attempted';

  function registerHttp(webServer) {
    if (httpState === 'registered') return;
    try {
      webServer.register({
        name: 'dsh-ops-feed',
        kind: 'exact',
        path: '/ops-feed',
        handler: (req, res) => {
          const send = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(body));
          };
          try {
            if (req.method !== 'GET') {
              res.writeHead(405).end();
              return;
            }
            let limit = 200;
            try {
              const raw = new URL(req.url, 'http://localhost').searchParams.get('limit');
              const parsed = Number.parseInt(raw ?? '', 10);
              if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
            } catch {
              // keep the default
            }
            send(200, snapshot(limit));
          } catch (error) {
            send(500, { error: String(error?.message ?? error) });
          }
        },
      });
      httpState = 'registered';
      control('web route /ops-feed registered');
    } catch (error) {
      httpState = 'register threw: ' + String(error?.message ?? error);
      control(httpState);
    }
  }

  function mountRoute() {
    const direct = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
    if (direct && typeof direct.register === 'function') {
      registerHttp(direct);
      return true;
    }
    if (typeof ctx.inject === 'function') {
      let ran = false;
      try {
        ctx.inject(['webServer'], (scope) => {
          ran = true;
          const svc = scope?.webServer
            ?? (typeof scope?.get === 'function' ? scope.get('webServer') : undefined);
          if (svc && typeof svc.register === 'function') registerHttp(svc);
          else httpState = 'inject ran but webServer absent in scope';
        });
      } catch (error) {
        httpState = 'inject threw: ' + String(error?.message ?? error);
      }
      if (ran) return true;
    }
    if (httpState === 'not attempted') httpState = 'webServer not resolvable yet';
    return false;
  }

  const maxAttempts = 8;
  let attempt = 0;
  function tryMount() {
    attempt += 1;
    if (mountRoute()) return;
    control(`webServer attempt ${attempt}/${maxAttempts}: ${httpState}`);
    if (attempt < maxAttempts) {
      const t = setTimeout(tryMount, 400);
      if (t && typeof t.unref === 'function') t.unref();
    } else {
      control(`webServer never available after ${maxAttempts} attempts; RPC still active`);
    }
  }

  // An explicitly configured workspace is bound immediately. Otherwise the
  // workspace stays unresolved until the first tool call tells us which
  // session (and therefore which cwd) this is.
  if (configured) bindWorkspace(configured);

  control(`host half loaded; workspace=${workspace ?? '(unresolved)'} from=${resolvedFrom}`);
  tryMount();
  control('ready: listeners=tools/result,approval/request rpc=feed');
}

export { summarizeArgs, classify };
