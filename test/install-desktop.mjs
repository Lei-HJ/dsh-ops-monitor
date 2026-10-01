// Install dsh-ops-monitor into the profile that is ACTUALLY running.
//
// Diagnosis: the dsh desktop app is started with the `desktop` profile, and
// desktop/cordis.yml contains web-startup + webserver + web-runtime + the
// client `modules` table -- so this machine's web GUI is served by the desktop
// composition. Installing into `web` therefore did nothing.
//
// The desktop profile has no node_modules of its own, so a package-name loader
// row cannot resolve there. This script therefore does both things that can
// make the package resolvable:
//   1. copies the package into <profile>/node_modules/dsh-ops-monitor
//   2. records it in package.json dependencies AND in dsh.profile.bundles
//      (the bundle list is how modsearch is loaded in the web profile)
// and leaves the loader row in the profile's cordis.patch.yml.

import { cpSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SRC = 'D:\\DSH\\.dsh-plugins\\dsh-ops-monitor';
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE = join(DSH_HOME, 'profiles', 'desktop');
const DEST = join(PROFILE, 'node_modules', 'dsh-ops-monitor');
const PKG = join(PROFILE, 'package.json');
const PATCH = join(PROFILE, 'cordis.patch.yml');

let failures = 0;
function check(cond, msg) {
  console.log((cond ? '  ok   ' : '  FAIL ') + msg);
  if (!cond) failures++;
}

console.log('=== profile: ' + PROFILE + ' ===');
if (!existsSync(PROFILE)) {
  console.log('profile missing');
  process.exit(1);
}

console.log('--- 1. copy package into node_modules ---');
try {
  mkdirSync(join(PROFILE, 'node_modules'), { recursive: true });
  if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true });
  cpSync(SRC, DEST, { recursive: true, filter: (s) => !s.includes('node_modules') });
  for (const f of ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'dsh/index.js', 'dsh/client.js']) {
    check(existsSync(join(DEST, f)), f);
  }
} catch (err) {
  console.log('  FAIL copy: ' + err.message);
  failures++;
}

console.log('--- 2. package.json: dependency + bundle ---');
try {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies['dsh-ops-monitor'] = 'file:' + SRC.replace(/\\/g, '/');

  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
  if (!pkg.dsh.profile.bundles.includes('dsh-ops-monitor')) {
    pkg.dsh.profile.bundles.push('dsh-ops-monitor');
  }
  // keep the live reload behaviour the web profile already relies on
  if (!pkg.dsh.profile.patchReload) pkg.dsh.profile.patchReload = 'live';

  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  const after = JSON.parse(readFileSync(PKG, 'utf8'));
  check(after.dependencies['dsh-ops-monitor'] === 'file:' + SRC.replace(/\\/g, '/'), 'dependency recorded');
  check(after.dsh.profile.bundles.includes('dsh-ops-monitor'), 'bundle listed');
  console.log('  bundles = ' + JSON.stringify(after.dsh.profile.bundles));
  console.log('  patchReload = ' + after.dsh.profile.patchReload);
} catch (err) {
  console.log('  FAIL package.json: ' + err.message);
  failures++;
}

console.log('--- 3. cordis.patch.yml: remove any stale plugin row ---');
try {
  // The mount comes from the bundle list. The plugin carries its own
  // `cordis.patch.yml` (an `insert:` row with its config) inside the package,
  // which is the shape a known-working host-only plugin uses. The PROFILE's
  // patch file must therefore contain no row for this plugin: a `- id:` row
  // there is an override, and adding one previously broke the mount outright.
  const before = readFileSync(PATCH, 'utf8');
  if (before.includes('dsh-ops-monitor')) {
    const lines = before.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const window = lines.slice(i, i + 4).join('\n');
      if (/^- (id: dsh-ops-monitor|- insert:)\s*$/.test(lines[i]) && window.includes('dsh-ops-monitor')) {
        i++;
        while (i < lines.length && /^\s+\S/.test(lines[i])) i++;
        i--;
        continue;
      }
      out.push(lines[i]);
    }
    writeFileSync(PATCH, out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', 'utf8');
    console.log('  removed a stale plugin row');
  } else {
    console.log('  no plugin row present (correct)');
  }
  check(!readFileSync(PATCH, 'utf8').includes('dsh-ops-monitor'), 'profile patch file free of plugin rows');
} catch (err) {
  console.log('  FAIL cordis.patch.yml: ' + err.message);
  failures++;
}

console.log('--- 4. verify the package carries its own insert row with config ---');
try {
  const pkgPatch = readFileSync(join(DEST, 'cordis.patch.yml'), 'utf8');
  check(pkgPatch.includes('- insert:'), 'package patch uses insert');
  check(pkgPatch.includes('dsh-ops-monitor'), 'package patch names the plugin');
  check(pkgPatch.includes('workspace:'), 'workspace config travels with the package');
  console.log('  --- package cordis.patch.yml ---');
  for (const line of pkgPatch.split('\n')) console.log('    ' + line);
} catch (err) {
  console.log('  FAIL package patch: ' + err.message);
  failures++;
}

console.log('');
console.log(failures ? 'RESULT: ' + failures + ' FAILURE(S)' : 'RESULT: INSTALLED INTO desktop PROFILE');
process.exitCode = failures ? 1 : 0;
