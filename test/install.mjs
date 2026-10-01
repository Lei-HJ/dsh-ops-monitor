// Install dsh-ops-monitor into both local dsh profiles.
// The desktop app was started with the `desktop` profile, but the page at
// 127.0.0.1:19387 is served by the web composition, and it is not obvious
// which profile supplies the client plugin table. Installing into both
// removes the guess. Both profiles' config files were backed up beforehand.

import { cpSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'D:\\DSH\\.dsh-plugins\\dsh-ops-monitor';
// Only the web profile is targeted: it has node_modules and already resolves
// third-party plugins by package name (modsearch proves the mechanism). The
// desktop profile has no node_modules at all, so a package-name row cannot
// resolve there; it loads its UI plugins through direct patch entries instead,
// which is a different mechanism to be explored only if this one fails.
const PROFILES = [
  join(DSH_HOME, 'profiles', 'web'),
];

let failures = 0;

for (const PROFILE of PROFILES) {
  console.log('');
  console.log('############ ' + PROFILE + ' ############');
  if (!existsSync(PROFILE)) {
    console.log('  profile missing, skipped');
    continue;
  }

  const DEST = join(PROFILE, 'node_modules', 'dsh-ops-monitor');
  const PKG = join(PROFILE, 'package.json');
  const PATCH = join(PROFILE, 'cordis.patch.yml');

  console.log('--- 1. copy the package ---');
  try {
    if (existsSync(DEST)) {
      rmSync(DEST, { recursive: true, force: true });
      console.log('  removed previous copy');
    }
    cpSync(SRC, DEST, {
      recursive: true,
      filter: (src) => !src.includes('node_modules'),
    });
    for (const f of ['package.json', 'cordis.patch.yml', 'dsh/index.js', 'dsh/client.js']) {
      console.log('    ' + (existsSync(join(DEST, f)) ? 'ok  ' : 'MISS') + ' ' + f);
    }
  } catch (err) {
    console.log('  FAILED to copy: ' + err.message);
    failures++;
    continue;
  }

  console.log('--- 2. dependency in package.json ---');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(PKG, 'utf8'));
  } catch (err) {
    console.log('  package.json unreadable: ' + err.message);
    failures++;
    continue;
  }
  const before = JSON.stringify(pkg.dependencies);
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies['dsh-ops-monitor'] = 'file:' + SRC.replace(/\\/g, '/');
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  const after = JSON.stringify(JSON.parse(readFileSync(PKG, 'utf8')).dependencies);
  console.log('  before: ' + before);
  console.log('  after : ' + after);
  if (!after.includes('dsh-ops-monitor')) {
    console.log('  FAIL: dependency not persisted');
    failures++;
  }

  console.log('--- 3. loader row in cordis.patch.yml ---');
  const patchBefore = readFileSync(PATCH, 'utf8');
  console.log('  before: ' + JSON.stringify(patchBefore));
  if (patchBefore.includes('dsh-ops-monitor')) {
    console.log('  already present');
  } else {
    const insertLine = "\n- insert:\n    - id: dsh-ops-monitor\n      name: 'dsh-ops-monitor'\n";
    let body = patchBefore.trim();
    body = body === '[]' ? '[]' + insertLine : body + insertLine;
    writeFileSync(PATCH, body, 'utf8');
  }
  const patchAfter = readFileSync(PATCH, 'utf8');
  console.log('  after : ' + JSON.stringify(patchAfter));
  if (!patchAfter.includes('dsh-ops-monitor')) {
    console.log('  FAIL: loader row not persisted');
    failures++;
  } else {
    console.log('  ok');
  }
}

console.log('');
console.log(failures ? ('RESULT: ' + failures + ' FAILURE(S)') : 'RESULT: INSTALLED INTO ALL PROFILES');
process.exitCode = failures ? 1 : 0;
