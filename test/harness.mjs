// Local harness for dsh-ops-monitor.
// Runs the plugin's apply() against a mock cordis context: captures the event
// listeners and the web route it registers, fires synthetic events, then reads
// the feed file and calls the route handler to check the JSON it returns.
//
// This is the step that catches logic bugs before anything touches the user's
// real DSH profile.

import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mod = await import('file:///D:/DSH/.dsh-plugins/dsh-ops-monitor/dsh/index.js');

const work = mkdtempSync(join(tmpdir(), 'ops-monitor-test-'));
const listeners = new Map();
let route = null;
const logs = [];

const mockWebServer = {
  register(def) { route = def; return () => { route = null; }; },
};

const ctx = {
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(fn);
  },
  // webServer is fetched optionally, not injected: it only exists under the
  // web profile, and a hard dependency would break headless profiles.
  get(name) { return name === 'webServer' ? mockWebServer : undefined; },
  provide(name, value) { provided[name] = value; },
  logger: {
    info(msg) { logs.push(msg); },
  },
};
const provided = {};

function fail(msg) {
  console.log('FAIL: ' + msg);
  process.exitCode = 1;
}
function ok(msg) { console.log('ok  : ' + msg); }

console.log('--- 1. metadata ---');
console.log('  name   =', mod.name);
console.log('  inject =', JSON.stringify(mod.inject));
if (mod.name !== 'dsh-ops-monitor') fail('unexpected name');
else ok('name is dsh-ops-monitor');
if (!Array.isArray(mod.inject) || !mod.inject.includes('tools')) {
  fail('inject must include tools');
} else ok('inject includes tools');
if (mod.inject.includes('webServer')) {
  fail('webServer must NOT be a hard dependency (headless profiles would fail)');
} else ok('webServer is fetched optionally, not injected');

console.log('--- 2. apply() ---');
mod.apply(ctx, { workspace: work });
if (listeners.size === 0) fail('no event listeners registered');
else ok('registered ' + listeners.size + ' event(s): ' + [...listeners.keys()].join(', '));
if (!listeners.has('tools/result')) fail('tools/result listener missing');
else ok('tools/result listener present');
if (!listeners.has('tools/execute')) fail('tools/execute listener missing (the scope-independent hook)');
else ok('tools/execute listener present');
if (!listeners.has('approval/request')) fail('approval/request listener missing');
else ok('approval/request listener present');
if (!route) fail('web route was not registered');
else {
  ok('route registered: ' + route.kind + ' ' + route.path + ' (name=' + route.name + ')');
  if (route.path !== '/ops-feed') fail('route path should be /ops-feed');
  else ok('route path is /ops-feed');
}
if (logs.length) console.log('  plugin log: ' + logs.join(' | '));

console.log('--- 2b. tools/execute waterfall MUST call next() ---');
{
  const dispatchHandlers = listeners.get('tools/execute') || [];
  if (!dispatchHandlers.length) {
    fail('no tools/execute listener to test');
  } else {
    let nextCalls = 0;
    const execDispatch = {
      name: 'pwsh',
      callId: 'call-dispatch-1',
      agent: { id: 'session-test' },
      arguments: { command: 'echo dispatch', description: 'dispatch probe' },
    };
    for (const fn of dispatchHandlers) {
      const ret = fn(execDispatch, () => {
        nextCalls += 1;
        return Promise.resolve({ isError: false, value: 'ok', content: [] });
      });
      if (ret && typeof ret.then === 'function') await ret;
    }
    // a waterfall listener that skips next() stalls every tool call in the host
    if (nextCalls !== dispatchHandlers.length) {
      fail('tools/execute did not call next() (' + nextCalls + '/' + dispatchHandlers.length + ') - this would stall tool calls');
    } else {
      ok('tools/execute called next() for every listener');
    }
  }
}

console.log('--- 2c. tools/execute still calls next() when recording throws ---');
{
  const work2 = mkdtempSync(join(tmpdir(), 'ops-monitor-throw-'));
  const listeners2 = new Map();
  const ctx2 = {
    on(n, fn) { if (!listeners2.has(n)) listeners2.set(n, []); listeners2.get(n).push(fn); },
    get() { return undefined; },
    provide() {},
    sessions: {},
  };
  // a workspace path that cannot be created makes appendFileSync fail
  mod.apply(ctx2, { workspace: join(work2, 'x', '\u0000bad') });
  const handlers = listeners2.get('tools/execute') || [];
  let nextCalls = 0;
  for (const fn of handlers) {
    const ret = fn({ name: 'pwsh', callId: 'c', agent: { id: 's' }, arguments: { command: 'x' } },
      () => { nextCalls += 1; return Promise.resolve({ isError: false, value: 1, content: [] }); });
    if (ret && typeof ret.then === 'function') await ret.catch(() => {});
  }
  if (nextCalls !== handlers.length) fail('next() skipped when recording failed');
  else ok('next() called even when the record path is unwritable');
  rmSync(work2, { recursive: true, force: true });
}

console.log('--- 3. fire tools/result (success) ---');
const exec1 = {
  name: 'pwsh',
  callId: 'call-1',
  agent: { id: 'session-test' },
  arguments: { command: 'Get-ChildItem D:\\DSH', description: 'list files' },
};
for (const fn of listeners.get('tools/result') || []) {
  fn(exec1, { isError: false, value: 'ok', content: [] });
}
console.log('  fired pwsh success');

console.log('--- 4. fire tools/result (write) ---');
const exec2 = {
  name: 'write',
  callId: 'call-2',
  agent: { id: 'session-test' },
  arguments: { file_path: 'D:\\DSH\\out.txt', content: 'hello' },
};
for (const fn of listeners.get('tools/result') || []) {
  fn(exec2, { isError: false, value: 'ok', content: [] });
}

console.log('--- 5. fire tools/result (error) ---');
const exec3 = {
  name: 'pwsh',
  callId: 'call-3',
  agent: { id: 'session-test' },
  arguments: { command: 'this-will-fail' },
};
for (const fn of listeners.get('tools/result') || []) {
  fn(exec3, { isError: true, error: { message: 'command not found' }, content: [] });
}

console.log('--- 6. fire approval/request (waterfall: must call next) ---');
let nextCalled = false;
const approvalHandlers = listeners.get('approval/request') || [];
for (const fn of approvalHandlers) {
  const ret = fn({ toolName: 'write', reason: 'needs permission' }, () => {
    nextCalled = true;
    return Promise.resolve({ decision: 'allow' });
  });
  if (ret && typeof ret.then === 'function') await ret;
}
if (approvalHandlers.length && !nextCalled) fail('approval listener did not call next()');
else if (approvalHandlers.length) ok('approval listener called next()');
else fail('no approval listener to test');

console.log('--- 7. read the feed file it produced ---');
const feedPath = join(work, '.dsh-ops', 'feed.jsonl');
if (!existsSync(feedPath)) {
  fail('feed file was not created at ' + feedPath);
} else {
  const lines = readFileSync(feedPath, 'utf8').trim().split('\n').filter(Boolean);
  ok('feed file exists with ' + lines.length + ' line(s)');
  for (const [i, line] of lines.entries()) {
    let e;
    try { e = JSON.parse(line); } catch (err) { fail('line ' + i + ' is not valid JSON: ' + err.message); continue; }
    console.log('    [' + i + '] kind=' + e.kind + ' name=' + e.name + ' cls=' + e.cls +
      (e.isError ? ' ERROR' : '') +
      (e.args ? '  args=' + JSON.stringify(e.args).slice(0, 90) : ''));
  }
}

console.log('--- 8. call the route handler ---');
if (route) {
  const req = { method: 'GET', url: '/ops-feed?limit=10' };
  let status = null; let body = null;
  const res = {
    writeHead(code) { status = code; return this; },
    end(payload) { body = payload; },
  };
  await route.handler(req, res);
  console.log('  status = ' + status);
  if (status !== 200) fail('route returned ' + status);
  else ok('route returned 200');
  if (body) {
    const parsed = JSON.parse(body);
    console.log('  total    = ' + parsed.total);
    console.log('  buffered = ' + parsed.buffered);
    console.log('  entries  = ' + (parsed.entries ? parsed.entries.length : 'none'));
    if (parsed.total !== 5) fail('expected total 5 (1 dispatch + 3 results + 1 approval), got ' + parsed.total);
    else ok('total is 5 as expected');
    const kinds = (parsed.entries || []).map((e) => e.kind);
    console.log('  kinds    = ' + kinds.join(', '));
  } else {
    fail('route returned no body');
  }

  console.log('--- 9. route rejects non-GET ---');
  let s2 = null;
  const res2 = { writeHead(c) { s2 = c; return this; }, end() {} };
  await route.handler({ method: 'POST', url: '/ops-feed' }, res2);
  if (s2 === 405) ok('POST correctly rejected with 405');
  else fail('expected 405 for POST, got ' + s2);
}

console.log('--- 10. RPC surface (ctx.provide("feed")) ---');
if (typeof provided.feed !== 'function') {
  fail('ctx.provide("feed") was not called; the browser half would have no data');
} else {
  ok('feed was provided to the client');
  const snap = provided.feed({ limit: 2 });
  console.log('  snapshot total    = ' + snap.total);
  console.log('  snapshot buffered = ' + snap.buffered);
  console.log('  snapshot entries  = ' + snap.entries.length + ' (limit 2)');
  if (snap.total !== 5) fail('RPC total should be 5, got ' + snap.total);
  else ok('RPC total is 5');
  if (snap.entries.length !== 2) fail('RPC limit not honoured: got ' + snap.entries.length);
  else ok('RPC limit honoured');
  const noArg = provided.feed(undefined);
  if (!Array.isArray(noArg.entries)) fail('RPC must work without arguments');
  else ok('RPC works with no arguments (' + noArg.entries.length + ' entries)');
}

console.log('--- 11. classify() spot checks ---');
const cases = [['read', 'read'], ['write', 'write'], ['edit', 'edit'], ['pwsh', 'exec'],
  ['glob', 'search'], ['grep', 'search'], ['web_search', 'fetch'], ['subagent', 'delegate'],
  ['workflow', 'delegate'], ['something-else', 'other']];
for (const [input, want] of cases) {
  const got = mod.classify(input);
  if (got !== want) fail('classify(' + input + ') = ' + got + ', expected ' + want);
  else ok('classify(' + input + ') = ' + got);
}

console.log('--- 11. summarizeArgs() spot checks ---');
console.log('  ' + mod.summarizeArgs({ command: 'echo hi', description: 'greet' }));
console.log('  ' + mod.summarizeArgs({ file_path: 'D:\\a.txt', content: 'x'.repeat(500) }).slice(0, 120));
console.log('  ' + JSON.stringify(mod.summarizeArgs(null)));

rmSync(work, { recursive: true, force: true });
console.log('--- done; temp workspace removed ---');

console.log('--- 12. workspace resolution from a session cwd ---');
{
  const work2 = mkdtempSync(join(tmpdir(), 'ops-monitor-ws-'));
  const sessionCwd = join(work2, 'fake-session-workspace');
  mkdirSync(sessionCwd, { recursive: true });

  const listeners2 = new Map();
  const ctx2 = {
    on(n, fn) { if (!listeners2.has(n)) listeners2.set(n, []); listeners2.get(n).push(fn); },
    get() { return undefined; },
    provide() {},
    sessions: {
      binding(id) {
        return id === 'session-with-cwd' ? { session: { header: { cwd: sessionCwd } } } : undefined;
      },
      scope() { return undefined; },
    },
  };

  mod.apply(ctx2, {});   // no explicit workspace: it must come from the session
  const fired = listeners2.get('tools/result') || [];
  if (!fired.length) {
    fail('no tools/result listener in the resolution run');
  } else {
    fired[0](
      { name: 'read', callId: 'c9', agent: { id: 'session-with-cwd' }, arguments: { file_path: 'x' } },
      { isError: false },
    );
    const expected = join(sessionCwd, '.dsh-ops', 'feed.jsonl');
    if (!existsSync(expected)) {
      fail('feed not written to the session workspace: ' + expected);
    } else {
      ok('feed written to the session cwd workspace');
      const ctl = join(sessionCwd, '.dsh-ops', 'control.log');
      if (existsSync(ctl) && readFileSync(ctl, 'utf8').includes('workspace resolved from session cwd')) {
        ok('control.log records the session-cwd resolution');
      } else {
        fail('control.log does not record the resolution');
      }
    }
  }
  rmSync(work2, { recursive: true, force: true });
}

console.log('--- 13. fallback to cwd when no session cwd is available ---');
{
  const work3 = mkdtempSync(join(tmpdir(), 'ops-monitor-fb-'));
  const listeners3 = new Map();
  const ctx3 = {
    on(n, fn) { if (!listeners3.has(n)) listeners3.set(n, []); listeners3.get(n).push(fn); },
    get() { return undefined; },
    provide() {},
    sessions: { binding() { return undefined; }, scope() { return undefined; } },
  };
  const prevCwd = process.cwd();
  process.chdir(work3);
  try {
    mod.apply(ctx3, {});
    const fired = listeners3.get('tools/result') || [];
    fired[0]({ name: 'read', callId: 'c1', agent: { id: 'unknown-session' }, arguments: {} }, { isError: false });
    const expected = join(work3, '.dsh-ops', 'control.log');
    if (!existsSync(expected)) {
      fail('no control.log in the fallback workspace: ' + expected);
    } else if (readFileSync(expected, 'utf8').includes('fell back to process cwd')) {
      ok('control.log records the cwd fallback');
    } else {
      fail('fallback not recorded in control.log');
    }
  } finally {
    process.chdir(prevCwd);
    rmSync(work3, { recursive: true, force: true });
  }
}

console.log(process.exitCode ? 'RESULT: FAILURES PRESENT' : 'RESULT: ALL CHECKS PASSED');
