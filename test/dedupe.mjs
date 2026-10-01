// Fix the two defects found in the live run:
//   1. the plugin was mounted twice (bundle list AND a profile patch row),
//      producing four instances with divergent in-memory buffers
//   2. the workspace fell back to the profile directory
//
// Resolution: keep ONE mount path -- the profile's own cordis.patch.yml row --
// and put the `workspace` config on that same row. The bundle list entry is
// removed.

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE = join(DSH_HOME, 'profiles', 'desktop');
const PKG = PROFILE + '\\package.json';
const PATCH = PROFILE + '\\cordis.patch.yml';
const WORKSPACE = 'D:\\DSH';

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + msg);
  if (!cond) failures++;
};

console.log('--- 1. package.json: drop the bundle entry (single mount path) ---');
{
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
  const before = (pkg.dsh?.profile?.bundles) || [];
  console.log('  bundles before: ' + JSON.stringify(before));
  pkg.dsh.profile.bundles = before.filter((b) => b !== 'dsh-ops-monitor');
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  const after = JSON.parse(readFileSync(PKG, 'utf8'));
  console.log('  bundles after : ' + JSON.stringify(after.dsh.profile.bundles));
  check(!after.dsh.profile.bundles.includes('dsh-ops-monitor'), 'bundle entry removed');
  check(after.dependencies['dsh-ops-monitor'] === 'file:D:/DSH/.dsh-plugins/dsh-ops-monitor',
    'dependency kept so the package still resolves');
  check(after.dsh.profile.patchReload === 'live', 'patchReload preserved');
}

console.log('--- 2. cordis.patch.yml: one row, with the workspace config ---');
{
  const before = readFileSync(PATCH, 'utf8');
  console.log('  before: ' + JSON.stringify(before.slice(-200)));
  const lines = before.split('\n');
  // drop every existing dsh-ops-monitor row (and its continuation lines)
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '- insert:') {
      // look ahead: skip this block if it belongs to dsh-ops-monitor
      const rest = lines.slice(i, i + 4).join('\n');
      if (rest.includes('dsh-ops-monitor')) {
        i += 3;
        continue;
      }
    }
    if (line.includes('dsh-ops-monitor') && /^\s{4,}(id|name):/.test(line)) continue;
    kept.push(line);
  }
  let body = kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  const row = [
    '',
    '- id: dsh-ops-monitor',
    "  name: 'dsh-ops-monitor'",
    '  config:',
    "    workspace: 'D:\\\\DSH'",
    '',
  ].join('\n');
  body = body + '\n' + row;
  writeFileSync(PATCH, body, 'utf8');
  const after = readFileSync(PATCH, 'utf8');
  console.log('  after : ' + JSON.stringify(after.slice(-220)));
  const occurrences = after.split('dsh-ops-monitor').length - 1;
  check(occurrences === 2, 'exactly one row (id + name), got ' + occurrences + ' mentions');
  check(after.includes('workspace:'), 'workspace config present');
}

console.log('');
console.log(failures ? 'RESULT: ' + failures + ' FAILURE(S)' : 'RESULT: SINGLE MOUNT PATH + WORKSPACE CONFIGURED');
process.exitCode = failures ? 1 : 0;
