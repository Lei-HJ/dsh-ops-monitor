// Publish dsh-ops-monitor to GitHub using only the REST API.
//
// git and the gh CLI are not installed on this machine, so this talks to
// api.github.com directly with fetch (Node 18+).
//
// The token is read from GITHUB_TOKEN and is never printed, never written to
// disk, and never embedded in an argument list.
//
// Usage:
//   GITHUB_TOKEN=... node test/publish.mjs [--public] [--repo NAME]

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// Resolve the package root from this file's own location, so nothing in this
// script is tied to one machine's directory layout.
const ROOT = process.env.PUBLISH_ROOT
  || dirname(dirname(fileURLToPath(import.meta.url)));

const TOKEN = process.env.GITHUB_TOKEN;
// Owner defaults to whichever account the token belongs to, resolved from
// /user at run time, so a wrong guess can never create the repo elsewhere.
const OWNER = process.env.GITHUB_OWNER || null;
const DESC = 'Real-time operation monitor for DeepSeek Harness: see every tool call the agent makes on your machine. 0.1.0, not production-ready.';

const args = process.argv.slice(2);
const isPublic = args.includes('--public');
const repoArg = args.indexOf('--repo');
const REPO = repoArg >= 0 && args[repoArg + 1] ? args[repoArg + 1] : 'dsh-ops-monitor';

if (!TOKEN) {
  console.error('ERROR: GITHUB_TOKEN is not set. Refusing to run.');
  console.error('Set it in the environment for this single command only.');
  process.exit(2);
}

const API = 'https://api.github.com';
const headers = {
  Authorization: 'Bearer ' + TOKEN,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'dsh-ops-monitor-publisher',
  'Content-Type': 'application/json',
};

const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh-ops', 'live']);
const SKIP_EXT = new Set(['.log', '.tmp', '.bak']);
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml']);

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      collect(full, out);
      continue;
    }
    const ext = name.slice(name.lastIndexOf('.'));
    if (SKIP_EXT.has(ext) || SKIP_FILES.has(name)) continue;
    out.push(full);
  }
  return out;
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

console.log('=== 1. who am I ===');
let login = OWNER;
{
  const r = await api('GET', '/user');
  if (!r.ok) {
    console.error('  token rejected: HTTP ' + r.status + ' ' + (r.json?.message || r.text.slice(0, 200)));
    process.exit(3);
  }
  login = r.json.login;
  console.log('  authenticated as: ' + login);
  console.log('  account type    : ' + (r.json.type || 'unknown'));
  if (OWNER && OWNER !== login) {
    console.log('  note: GITHUB_OWNER said "' + OWNER + '" but the token belongs to "' + login + '"');
    console.log('        using the token owner');
  }
}
const OWNER_EFFECTIVE = login;

console.log('=== 2. create (or find) the repository ===');
{
  const r = await api('POST', '/user/repos', {
    name: REPO,
    description: DESC,
    private: !isPublic,
    auto_init: false,
    has_issues: true,
    has_wiki: false,
  });
  if (r.status === 201) {
    console.log('  created: ' + r.json.full_name + '  private=' + r.json.private);
  } else if (r.status === 422) {
    console.log('  already exists; reusing it');
    const g = await api('GET', '/repos/' + OWNER_EFFECTIVE + '/' + REPO);
    if (!g.ok) { console.error('  cannot read repo: HTTP ' + g.status); process.exit(4); }
    console.log('  found: ' + g.json.full_name + '  private=' + g.json.private);
  } else {
    console.error('  create failed: HTTP ' + r.status + ' ' + (r.json?.message || r.text.slice(0, 300)));
    process.exit(5);
  }
}

console.log('=== 3. upload files ===');
const files = collect(ROOT);
console.log('  ' + files.length + ' file(s) to upload');
let failures = 0;
for (const full of files) {
  const rel = relative(ROOT, full).split(sep).join('/');
  const content = readFileSync(full);
  const b64 = content.toString('base64');

  // an existing path needs its blob sha to be replaceable
  let sha;
  const head = await api('GET', '/repos/' + OWNER_EFFECTIVE + '/' + REPO + '/contents/' + rel);
  if (head.ok && head.json && head.json.sha) sha = head.json.sha;

  const body = { message: 'add ' + rel, content: b64 };
  if (sha) body.sha = sha;

  const put = await api('PUT', '/repos/' + OWNER_EFFECTIVE + '/' + REPO + '/contents/' + rel, body);
  if (put.ok || put.status === 201) {
    console.log('  ok   ' + rel + '  (' + content.length + ' bytes)');
  } else {
    failures++;
    console.log('  FAIL ' + rel + '  HTTP ' + put.status + '  ' + (put.json?.message || ''));
  }
}

console.log('=== 4. result ===');
if (failures) {
  console.log('  ' + failures + ' file(s) failed');
  process.exitCode = 1;
} else {
  const vis = isPublic ? 'public' : 'private';
  console.log('  repository: https://github.com/' + OWNER_EFFECTIVE + '/' + REPO + '  (' + vis + ')');
  console.log('  all ' + files.length + ' file(s) uploaded');
}
