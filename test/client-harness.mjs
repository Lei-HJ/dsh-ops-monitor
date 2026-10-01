// Validate the client half without a browser.
// client.js expects window.__ModuleLoader__.load({id, factory}); this stubs
// that global, loads the file, and asserts the plugin exports and registration
// call shape. It also stubs a mock `ctx` so apply() runs end to end.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CLIENT = 'D:/DSH/.dsh-plugins/dsh-ops-monitor/dsh/client.js';
const source = readFileSync(CLIENT, 'utf8');

let loaded = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(spec) { loaded = spec; },
    },
  },
  console,
  setInterval() { return 0; },
  clearInterval() {},
  fetch() { return Promise.reject(new Error('no network in test')); },
  Date,
  String,
  Array,
  Object,
  JSON,
  Promise,
  Error,
};
sandbox.globalThis = sandbox;

function fail(msg) { console.log('FAIL: ' + msg); process.exitCode = 1; }
function ok(msg) { console.log('ok  : ' + msg); }

console.log('--- 1. load protocol ---');
vm.createContext(sandbox);
try {
  vm.runInContext(source, sandbox, { filename: 'client.js' });
} catch (err) {
  fail('client.js threw while loading: ' + err.message);
  process.exit(1);
}
if (!loaded) { fail('__ModuleLoader__.load was never called'); process.exit(1); }
ok('__ModuleLoader__.load invoked');
if (loaded.id !== 'dsh-ops-monitor') fail('bundle id is ' + loaded.id);
else ok('bundle id = dsh-ops-monitor');
if (typeof loaded.factory !== 'function') { fail('factory is not a function'); process.exit(1); }
ok('factory is a function');

console.log('--- 2. factory exports ---');
let mod;
try {
  mod = loaded.factory(function () { throw new Error('no requires expected'); });
} catch (err) {
  fail('factory threw: ' + err.message);
  process.exit(1);
}
if (!mod) { fail('factory returned nothing'); process.exit(1); }
console.log('  exports = ' + Object.keys(mod).join(', '));
for (const k of ['name', 'inject', 'apply']) {
  if (!(k in mod)) fail('missing export: ' + k);
  else ok('exports.' + k + ' present');
}

console.log('--- 3. apply() registers into shell.overlay ---');
const calls = { inject: [], slotInject: [], register: [] };

const mockSlots = {
  inject(name, factory) {
    calls.slotInject.push(name);
    const it = factory();
    // drive the generator so register() actually runs
    let r = it.next();
    while (!r.done) r = it.next();
    return function () {};
  },
  register(descriptor, component) {
    calls.register.push({ descriptor, component });
    return function () {};
  },
};

const mockScope = {
  slots: mockSlots,
  React: {
    createElement() { return {}; },
    useState(initial) { return [initial, function () {}]; },
    useEffect() {},
    useRef() { return { current: null }; },
  },
};

const mockCtx = {
  inject(services, cb) {
    calls.inject.push(services);
    cb(mockScope);
  },
};

try {
  mod.apply(mockCtx);
} catch (err) {
  fail('apply() threw: ' + err.message);
  process.exit(1);
}

if (calls.inject.length !== 1 || calls.inject[0][0] !== 'slots') {
  fail('did not inject ["slots"]; got ' + JSON.stringify(calls.inject));
} else ok('injected ["slots"]');

if (calls.slotInject.length !== 1 || calls.slotInject[0] !== 'shell.overlay') {
  fail('did not inject slot shell.overlay; got ' + JSON.stringify(calls.slotInject));
} else ok('injected slot shell.overlay');

if (calls.register.length !== 1) {
  fail('register() called ' + calls.register.length + ' times, expected 1');
} else {
  const d = calls.register[0].descriptor;
  console.log('  descriptor = ' + JSON.stringify(d));
  if (d.name !== 'shell.overlay') fail('descriptor.name is ' + d.name);
  else ok('descriptor.name = shell.overlay');
  if (typeof d.id !== 'string' || !d.id) fail('descriptor.id must be a non-empty string');
  else ok('descriptor.id = ' + d.id);
  if (typeof d.order !== 'number') fail('descriptor.order must be a number');
  else ok('descriptor.order = ' + d.order);
  if (typeof calls.register[0].component !== 'function') fail('component is not a function');
  else ok('component is a function');
}

console.log('--- 4. apply() tolerates a context without inject ---');
try {
  mod.apply({});
  ok('no throw when ctx.inject is absent');
} catch (err) {
  fail('apply({}) threw: ' + err.message);
}

console.log(process.exitCode ? 'RESULT: FAILURES PRESENT' : 'RESULT: ALL CHECKS PASSED');
