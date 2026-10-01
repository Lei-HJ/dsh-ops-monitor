# dsh-ops-monitor

A real-time operation monitor for **DeepSeek Harness** (dsh): it shows every
tool call the agent makes on your machine, as it happens.

Built because the obvious approach does not work. A filesystem watcher only
sees the subset of agent activity that writes to disk. On a measured session
that was **roughly 13% of real operations** — every file read, every search,
every shell command, and every outbound fetch was invisible to it. This plugin
subscribes to the tool pipeline instead, so it sees all of them.

## What it shows

A floating panel over the dsh web UI, streaming one line per tool call:

```
17:42:03  pwsh   command=Get-ChildItem C:\work\demo  description=list files
17:42:05  read   file_path=C:\work\demo\report.md
17:42:07  write  file_path=C:\work\demo\summary.txt
17:42:09  grep   pattern=TODO  path=C:\work\demo
17:42:11  ✗ pwsh command=bad-command            command not found
17:42:12  ⚠ approval  edit  needs permission
```

Colour encodes the operation class. `exec` (shell commands) is deliberately
the loudest colour, because that is precisely the class a file watcher can
never observe.

Each entry carries the tool name, a compressed argument summary, an error flag,
and a timestamp. Bulk payloads are **not** recorded: a `write` call logs its
`file_path`, never the file body.

## Two data channels

| Channel | Consumer |
| --- | --- |
| RPC `feed` | the browser half (`dsh/client.js`) |
| `GET /ops-feed?limit=N` | any external script (curl, a Python watcher, ...) |

Both serve the same shape:

```json
{
  "entries": [
    { "t": 1759300000000, "kind": "tool", "name": "pwsh", "cls": "exec",
      "callId": "call-1", "agent": "session-...", "args": "command=...", "isError": false }
  ],
  "total": 42,
  "buffered": 42,
  "startedAt": 1759299000000,
  "feedPath": "C:\\work\\demo\\.dsh-ops\\feed.jsonl"
}
```

A durable copy is appended to `<workspace>/.dsh-ops/feed.jsonl`, and a
`control.log` records each load so "did the plugin actually load?" is an
observable fact rather than an assumption.

## Install

The package must be resolvable from the dsh profile that is actually running.

1. Copy this package into the profile's `node_modules`:

   ```
   <dsh-home>/profiles/<profile>/node_modules/dsh-ops-monitor/
   ```

2. Add it to that profile's `package.json`:

   ```json
   {
     "dependencies": { "dsh-ops-monitor": "file:/path/to/dsh-ops-monitor" },
     "dsh": { "profile": { "bundles": ["...", "dsh-ops-monitor"] } }
   }
   ```

3. Restart dsh.

`cordis.patch.yml` in this package carries the loader row used by the bundle
mechanism:

```yaml
- insert:
    - id: dsh-ops-monitor
      name: 'dsh-ops-monitor'
```

Add the same row to the profile's own `cordis.patch.yml` if you are installing
without the bundle list.

## Verify it loaded

```bash
cat <workspace>/.dsh-ops/control.log
```

```
2026-10-01T09:42:00.000Z  host half loaded  pid=1234
2026-10-01T09:42:00.010Z  web route /ops-feed registered
2026-10-01T09:42:00.020Z  ready: listeners=tools/result,approval/request rpc=feed http=/ops-feed
```

No `control.log` means the plugin was not loaded by the running profile.

## Tests

```
node test/harness.mjs          # host half against a mock cordis context
node test/client-harness.mjs   # client half against a stubbed module loader
```

Both are dependency-free and touch no real dsh state. The host harness drives
synthetic `tools/result` and `approval/request` events through a mock context
and asserts the recorded entries, the RPC surface, and the HTTP route. The
client harness stubs `window.__ModuleLoader__` and asserts that `apply()`
injects `shell.overlay` and registers a component.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `workspace` | resolved at runtime | where `.dsh-ops/feed.jsonl` and `control.log` are written |

**Workspace resolution order** (this matters — `process.cwd()` inside the dsh
host is the *profile* directory, not your project):

1. an explicit `workspace` config value
2. the `cwd` of the session that owns the first tool call, read through the
   `sessions` service (`binding(id)` / `scope(id)`)
3. `process.cwd()` as a last resort

Until step 2 happens, load markers go to
`<tmp>/dsh-ops-monitor-control.log` instead of into the profile directory.

## Known limits

- **The panel shows the tool-call stream, not your screen.** It tells you that
  `pwsh` ran with a given command; it cannot show a slide appearing inside
  PowerPoint. Screen content needs screen capture, which is a different tool.
- **Command output is not included.** Entries record that a tool ran and
  whether it failed, not the full stdout. This keeps the feed small.
- **Argument summaries are capped** at 400 characters, and bulk keys such as
  `content` are never recorded.
- **In-memory window is capped** at 5000 entries; the durable JSONL keeps
  growing until you delete it.
- **The HTTP route needs the `webServer` service.** Under a composition without
  it, the route is skipped and only the RPC channel remains. Every attempt is
  recorded in `control.log`.

## Status

Verified end-to-end against a live dsh desktop install (Windows, one machine):

- [x] Host half logic against a mock context (events, RPC, HTTP route)
- [x] Client half against a stubbed module loader (slot registration)
- [x] Loads in a live dsh profile - `control.log` records `host half loaded`
- [x] `GET /ops-feed` answers over HTTP - `HTTP 200`, correct totals
- [x] Single mount, correct workspace - `workspace=<configured> from=config`
- [x] **Records every tool call, in both an interactive session and a
      concurrent second session**, with real call ids and session ids
- [ ] Floating panel confirmed visible in the browser

### Why `tools/execute` and not `tools/result`

`tools/result` is scope-filtered (keyed by `exec.agent`). A listener mounted at
the root scope never sees agent-scoped calls: a live run reported
`approval=1` while dozens of tool calls produced `tool=0`. `approval/request`
is not scope-filtered, which is why the same plugin received it.

`tools/execute` wraps every dispatch regardless of scope, so it is the hook a
monitor needs. It is a **waterfall**, so `next()` must run or the tool call
stalls; the test suite asserts that, including when recording itself fails.

`tools/result` is still subscribed because it carries error detail, and it
fires whenever the plugin does end up agent-scoped.

### Bugs the live run exposed, all fixed and covered by tests

1. A pre-bind to `process.cwd()` short-circuited session-workspace resolution.
2. A trailing newline in the feed added a phantom element, so "the last N
   records" returned N-1.
3. Mounting as a bundle row *and* a patch row produced four instances with
   disagreeing in-memory buffers; the feed is now read from the durable file.
4. `dsh.bundle.workspace` was an invented field the loader ignores; the
   workspace belongs in the `insert:` row's `config`.
5. `tools/result` alone never fires at root scope - see above.

## License

MIT