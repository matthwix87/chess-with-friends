// Tiny test harness: runs async tests, shows results on the page and POSTs
// them to the local dev server (tests/serve.ps1 writes tests/out/log.txt).

const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }

export function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
export function eq(a, b, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, ms = 10000, what = 'condition') {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    try { if (await fn()) return true; } catch { /* keep waiting */ }
    await sleep(50);
  }
  throw new Error('timed out waiting for ' + what);
}

function log(line) {
  const pre = document.getElementById('out') || document.body.appendChild(Object.assign(document.createElement('pre'), { id: 'out' }));
  pre.textContent += line + '\n';
  // Chain the POSTs so lines arrive in order.
  chain = chain.then(() => fetch('/__log', { method: 'POST', body: line })).catch(() => {});
}
let chain = Promise.resolve();

export async function run(suite) {
  let pass = 0, fail = 0;
  log(`=== ${suite} (${new Date().toISOString()})`);
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      log(`PASS ${t.name}`);
    } catch (e) {
      fail++;
      log(`FAIL ${t.name}: ${e && e.message}`);
    }
  }
  log(`=== ${suite} DONE pass=${pass} fail=${fail}`);
  document.title = `${suite} done: ${pass} pass, ${fail} fail`;
}

window.addEventListener('error', (e) => log(`PAGE ERROR ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => log(`UNHANDLED REJECTION ${e.reason && e.reason.message}`));
