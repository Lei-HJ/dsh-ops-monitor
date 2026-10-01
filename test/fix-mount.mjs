// Correct the mount after a wrong turn.
//
// Timeline of what the live runs actually showed:
//   bundle + insert row  -> loaded (duplicated) and the HTTP route registered
//   patch row only       -> did NOT load at all; /ops-feed returned 404
//
// So a `- id:` / `name:` row targets an EXISTING entry (override), while
// `insert:` is what adds a NEW one. Using the override form silently dropped
// the plugin. The bundle list is the verified NEW-entry path, so this restores
// it as the single mount and removes the patch row.
//
// The workspace is configured on the profile's own copy of the package instead
// of through a loader row, because that copy is what the profile actually
// resolves.

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE = join(DSH_HOME, 'profiles', 'desktop');
const PKG = PROFILE + '\\package.json';
const PATCH = PROFILE + '\\cordis.patch.yml';
const DEST_PKG = PROFILE + '\\node_modules\\dsh-ops-monitor\\package.json';

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + msg);
  if (!cond) failures++;
};

console.log('--- 1. remove the override row from cordis.patch.yml ---');
{
  const lines = readFileSync(PATCH, 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^- id: dsh-ops-monitor\s*$/.test(line)) {
      // skip this row and its indented continuation lines
      i++;
      while (i < lines.length && /^\s+\S/.test(lines[i])) i++;
      i--;
      continue;
    }
    out.push(line);
  }
  const body = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  writeFileSync(PATCH, body, 'utf8');
  const after = readFileSync(PATCH, 'utf8');
  check(!after.includes('dsh-ops-monitor'), 'plugin row removed from the patch file');
}

console.log('--- 2. restore the bundle entry (verified NEW-entry path) ---');
{
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
  if (!pkg.dsh.profile.bundles.includes('dsh-ops-monitor')) {
    pkg.dsh.profile.bundles.push('dsh-ops-monitor');
  }
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies['dsh-ops-monitor'] = 'file:D:/DSH/.dsh-plugins/dsh-ops-monitor';
  if (!pkg.dsh.profile.patchReload) pkg.dsh.profile.patchReload = 'live';
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  const after = JSON.parse(readFileSync(PKG, 'utf8'));
  console.log('  bundles = ' + JSON.stringify(after.dsh.profile.bundles));
  check(after.dsh.profile.bundles.includes('dsh-ops-monitor'), 'bundle entry present');
  check(after.dependencies['dsh-ops-monitor'] !== undefined, 'dependency present');
}

console.log('--- 3. put the workspace config on the profile-resolved package ---');
{
  const pkg = JSON.parse(readFileSync(DEST_PKG, 'utf8'));
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.bundle = pkg.dsh.bundle || { patch: './cordis.patch.yml' };
  // dsh reads loader config from the package's own bundle declaration when the
  // mount comes from the bundle list.
  pkg.dsh.bundle.workspace = 'D:\\DSH';
  writeFileSync(DEST_PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  const after = JSON.parse(readFileSync(DEST_PKG, 'utf8'));
  console.log('  ' + JSON.stringify(after.dsh.bundle));
  check(after.dsh.bundle.workspace === 'D:\\DSH', 'workspace recorded on the bundle declaration');
}

console.log('');
console.log(failures ? 'RESULT: ' + failures + ' FAILURE(S)' : 'RESULT: BUNDLE MOUNT RESTORED');
process.exitCode = failures ? 1 : 0;
