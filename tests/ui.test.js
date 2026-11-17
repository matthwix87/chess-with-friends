// Drives the real app inside iframes with synthetic pointer events.
import { test, assert, eq, run, sleep, waitFor } from './harness.js';

let win, doc, app;

function load(frameId, url = '../index.html') {
  return new Promise((resolve) => {
    const f = document.getElementById(frameId);
    f.onload = async () => {
      await waitFor(() => f.contentWindow.app, 5000, 'app');
      resolve(f.contentWindow);
    };
    f.src = url;
  });
}

function use(w) { win = w; doc = w.document; app = w.app; }

function center(sq) {
  const r = doc.querySelector(`#board [data-square="${sq}"]`).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function pointer(type, x, y) {
  const ev = new win.PointerEvent(type, { clientX: x, clientY: y, pointerId: 7, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true });
  doc.getElementById('board').dispatchEvent(ev);
}

function clickSq(sq) {
  const { x, y } = center(sq);
  pointer('pointerdown', x, y);
  pointer('pointerup', x, y);
}

async function drag(from, to) {
  const a = center(from), b = center(to);
  pointer('pointerdown', a.x, a.y);
  for (let i = 1; i <= 6; i++) { pointer('pointermove', a.x + ((b.x - a.x) * i) / 6, a.y + ((b.y - a.y) * i) / 6); await sleep(10); }
  pointer('pointerup', b.x, b.y);
}

const cls = (sq) => doc.querySelector(`#board [data-square="${sq}"]`).className;
const click = (sel) => doc.querySelector(sel).click();
const lastSan = () => app.game.moves[app.game.moves.length - 1].san;

async function startLocal(tc = 'none') {
  doc.querySelector('.mode-btn[data-mode="local"]').click();
  doc.querySelector(`#tcGrid [data-tc="${tc}"]`).click();
  click('#btnStart');
  await sleep(50);
  // If a confirm dialog appeared, accept it.
  const modal = doc.getElementById('modal');
  if (!modal.classList.contains('hidden')) { modal.querySelector('.btn-primary').click(); await sleep(50); }
  eq(app.mode, 'local');
}

test('loads without errors and shows the start position', async () => {
  use(await load('desk'));
  eq(doc.querySelectorAll('#board .sq').length, 64);
  eq(doc.querySelectorAll('#board .piece').length, 32);
  assert(doc.querySelector('[data-square="e1"] .piece').dataset.piece === 'wk');
});

test('click-to-move shows legal dots and moves', async () => {
  await startLocal();
  clickSq('e2');
  assert(cls('e2').includes('selected'), 'selected');
  assert(cls('e3').includes('move') && cls('e4').includes('move'), 'dots on e3/e4');
  assert(!cls('e5').includes('move'), 'no dot on e5');
  clickSq('e4');
  eq(app.game.ply, 1);
  assert(cls('e2').includes('last') && cls('e4').includes('last'), 'last move highlight');
});

test('drag-and-drop moves a piece', async () => {
  await drag('g8', 'f6');
  eq(app.game.ply, 2);
  eq(lastSan(), 'Nf6');
  assert(!doc.querySelector('.drag-ghost'), 'ghost removed');
});

test('illegal drop snaps back; clicking a selected piece deselects', async () => {
  await drag('e4', 'e6');
  eq(app.game.ply, 2);
  assert(doc.querySelector('[data-square="e4"] .piece'), 'pawn still on e4');
  clickSq('d2'); assert(cls('d2').includes('selected'));
  clickSq('d2'); assert(!cls('d2').includes('selected'), 'deselected');
});

test('capture ring and move list', async () => {
  clickSq('d2'); clickSq('d4');
  clickSq('f6');
  assert(cls('e4').includes('capture'), 'capture ring on e4');
  clickSq('e4');
  eq(lastSan(), 'Nxe4');
  const sans = [...doc.querySelectorAll('#moveList .mv')].map((e) => e.textContent);
  eq(sans, ['e4', 'Nf6', 'd4', 'Nxe4']);
  assert(doc.querySelector('#barTop [data-captured] img'), 'black (top bar) shows the captured pawn');
});

test('history navigation is view-only', async () => {
  click('[data-nav="prev"]');
  eq(app.viewPly, 3);
  assert(doc.querySelector('[data-square="e4"] .piece').dataset.piece === 'wp', 'old position');
  clickSq('e2'); // white pawn, but black to move and we're reviewing
  assert(!cls('e2').includes('selected'));
  click('[data-nav="end"]');
  eq(app.viewPly, null);
});

test('promotion picker (under-promote to knight)', async () => {
  await startLocal();
  for (const [f, t] of [['a2', 'a4'], ['h7', 'h5'], ['a4', 'a5'], ['h5', 'h4'], ['a5', 'a6'], ['h4', 'h3'], ['a6', 'b7'], ['h3', 'g2']]) { clickSq(f); clickSq(t); }
  eq(app.game.ply, 8);
  clickSq('b7'); clickSq('a8');
  await sleep(30);
  assert(!doc.getElementById('boardOverlay').classList.contains('hidden'), 'picker open');
  doc.querySelector('.promo [data-promo="n"]').click();
  await sleep(30);
  eq(lastSan(), 'bxa8=N');
  // black promotes with drag, picks queen
  await drag('g2', 'h1');
  await sleep(30);
  doc.querySelector('.promo [data-promo="q"]').click();
  await sleep(30);
  eq(lastSan(), 'gxh1=Q');
});

test("scholar's mate via UI: check highlight + game over dialog", async () => {
  await startLocal();
  for (const [f, t] of [['e2', 'e4'], ['e7', 'e5'], ['f1', 'c4'], ['b8', 'c6'], ['d1', 'h5'], ['g8', 'f6'], ['h5', 'f7']]) { clickSq(f); clickSq(t); }
  eq(app.game.result, { winner: 'w', reason: 'checkmate' });
  assert(cls('e8').includes('check'), 'king in check highlight');
  await sleep(500);
  assert(!doc.getElementById('modal').classList.contains('hidden'), 'modal');
  eq(doc.getElementById('modalTitle').textContent, 'White wins');
  doc.querySelector('#modal [data-value="close"]').click();
  assert(doc.getElementById('statusLine').textContent.includes('checkmate'));
});

test('flip board and coordinates', async () => {
  click('#btnFlip');
  eq(doc.querySelector('#board .sq').dataset.square, 'h1');
  eq(app.board.orientation, 'b');
  click('#btnFlip');
  eq(doc.querySelector('#board .sq').dataset.square, 'a8');
  eq(doc.querySelectorAll('#board .coord').length, 16);
});

test('clocks run (1+0) and show the active side', async () => {
  await startLocal('1+0');
  clickSq('e2'); clickSq('e4');
  await sleep(1300);
  const ms = app.game.remaining('b');
  assert(ms < 59000 && ms > 55000, 'black clock ran: ' + ms);
  eq(app.game.remaining('w'), 60000);
  const topClock = doc.querySelector('#barTop [data-clock]');
  assert(topClock.classList.contains('active'), 'black clock active');
  assert(/^0:5\d$/.test(topClock.textContent), 'display ' + topClock.textContent);
});

test('resign flow', async () => {
  click('#btnResign');
  await sleep(30);
  doc.querySelector('#modal .btn-primary').click();
  await sleep(30);
  eq(app.game.result, { winner: 'w', reason: 'resignation' }); // black (to move) resigned
  doc.querySelector('#modal [data-value="close"]') && (await sleep(400), doc.querySelector('#modal [data-value="close"]').click());
});

test('vs computer: engine replies, settings persist', async () => {
  doc.querySelector('.mode-btn[data-mode="computer"]').click();
  doc.querySelector('#segColor [data-color="w"]').click();
  doc.querySelector('#segLevel [data-level="1"]').click();
  doc.querySelector('#tcGrid [data-tc="none"]').click();
  click('#btnStart');
  await sleep(50);
  const modal = doc.getElementById('modal');
  if (!modal.classList.contains('hidden')) { modal.querySelector('.btn-primary').click(); await sleep(50); }
  eq(app.mode, 'computer');
  eq(app.myColor, 'w');
  clickSq('e2'); clickSq('e4');
  await waitFor(() => app.game.ply === 2, 8000, 'engine reply');
  // can't move black pieces
  clickSq('a7'); assert(!cls('a7').includes('selected'));
  const saved = JSON.parse(win.localStorage.getItem('rookery:settings'));
  eq([saved.mode, saved.color, saved.level], ['computer', 'w', 1]);
});

test('theme + board color toggles persist', async () => {
  const before = doc.documentElement.dataset.theme;
  click('#btnTheme');
  assert(doc.documentElement.dataset.theme !== before);
  const sel = doc.getElementById('boardTheme');
  sel.value = 'walnut'; sel.dispatchEvent(new win.Event('change'));
  eq(doc.documentElement.dataset.board, 'walnut');
  const saved = JSON.parse(win.localStorage.getItem('rookery:settings'));
  eq(saved.board, 'walnut');
  click('#btnTheme');
  sel.value = 'sage'; sel.dispatchEvent(new win.Event('change'));
});

test('phone width: no horizontal overflow, board fits', async () => {
  use(await load('phone'));
  const w = doc.documentElement.clientWidth;
  assert(doc.documentElement.scrollWidth <= w, `scrollWidth ${doc.documentElement.scrollWidth} > ${w}`);
  const r = doc.getElementById('board').getBoundingClientRect();
  assert(r.left >= 15 && r.right <= w - 15, `board ${r.left}-${r.right} in ${w}`);
  await startLocal();
  await drag('e2', 'e4');
  eq(app.game.ply, 1);
});

run('ui');
