// Two-player online test: a host and a guest app in two iframes talk through
// the real PeerJS public broker + WebRTC.
import { test, assert, eq, run, sleep, waitFor } from './harness.js';

const frames = { host: document.getElementById('host'), guest: document.getElementById('guest') };
const errors = [];

function load(name, url) {
  return new Promise((resolve) => {
    const f = frames[name];
    f.onload = async () => {
      f.contentWindow.addEventListener('error', (e) => errors.push(`${name}: ${e.message}`));
      await waitFor(() => f.contentWindow.app, 5000, name + ' app');
      resolve(f.contentWindow);
    };
    f.src = url;
  });
}

let H, G; // iframe windows
const hApp = () => H.app, gApp = () => G.app;
let roomId;

async function joinGuest() {
  G = await load('guest', `../index.html?room=${roomId}`);
  // The join prompt asks for a name.
  await waitFor(() => !G.document.getElementById('modal').classList.contains('hidden'), 3000, 'join modal');
  G.document.querySelector('#modal .modal-input').value = 'Gina';
  G.document.querySelector('#modal .btn-primary').click();
}

test('host creates a room and gets an invite link', async () => {
  H = await load('host', '../index.html');
  H.localStorage.setItem('rookery:settings', JSON.stringify({ name: 'Hank', tc: '3+0', color: 'w', mode: 'online' }));
  H = await load('host', '../index.html');
  H.document.getElementById('btnStart').click();
  await waitFor(() => hApp().net && hApp().net.state === 'waiting', 20000, 'host registered with broker');
  const link = H.document.getElementById('shareLink').value;
  roomId = new URL(link).searchParams.get('room');
  assert(roomId && roomId.length === 10, 'room id in link: ' + link);
  assert(H.location.search.includes(roomId), 'host url updated');
});

test('guest joins via link; colors assigned, game starts on both', async () => {
  await joinGuest();
  await waitFor(() => gApp().game && hApp().game && gApp().online.started, 30000, 'game start on both sides');
  eq(hApp().myColor, 'w');
  eq(gApp().myColor, 'b');
  eq(gApp().board.orientation, 'b');
  eq(gApp().names.w, 'Hank');
  await waitFor(() => hApp().names.b === 'Gina', 3000, 'host sees guest name');
  eq(gApp().game.tcKey, '3+0');
});

test('moves are relayed both ways and validated', async () => {
  hApp().userMove({ from: 'e2', to: 'e4' });
  await waitFor(() => gApp().game.ply === 1, 5000, 'guest got e4');
  // guest cannot move white pieces
  eq(gApp().canMove('w'), false);
  gApp().userMove({ from: 'e7', to: 'e5' });
  await waitFor(() => hApp().game.ply === 2, 5000, 'host got e5');
  hApp().userMove({ from: 'g1', to: 'f3' });
  await waitFor(() => gApp().game.ply === 3, 5000);
  eq(gApp().game.chess.fen(), hApp().game.chess.fen());
});

test('clock sync: host authoritative, guest within 500ms', async () => {
  await sleep(1500); // black (guest) to move, its clock runs
  const h = hApp().game.remaining('b'), g = gApp().game.remaining('b');
  assert(Math.abs(h - g) < 500, `host ${h} vs guest ${g}`);
  assert(h < 180000 - 1000, 'black clock running on host: ' + h);
});

test('illegal / out-of-turn messages are rejected and trigger resync', async () => {
  const gid = gApp().online.gameId;
  // Guest (black) sends a bogus move straight over the wire.
  gApp().net.send({ t: 'move', gameId: gid, ply: 3, from: 'e8', to: 'e3', promotion: null });
  await sleep(800);
  eq(hApp().game.ply, 3, 'host ignored illegal move');
  // A legal move with the wrong ply also gets rejected
  gApp().net.send({ t: 'move', gameId: gid, ply: 7, from: 'b8', to: 'c6', promotion: null });
  await sleep(800);
  eq(hApp().game.ply, 3);
  eq(gApp().game.chess.fen(), hApp().game.chess.fen(), 'still in sync');
});

test('draw offer reaches the opponent and can be declined', async () => {
  gApp().offerDraw();
  await waitFor(() => !H.document.getElementById('offerBox').classList.contains('hidden'), 5000, 'host sees offer');
  H.document.getElementById('btnOfferNo').click();
  await waitFor(() => gApp().online.drawOffer === null, 5000, 'guest sees decline');
  eq(hApp().game.over, false);
});

test('guest reload reconnects and resyncs the same game', async () => {
  const fen = hApp().game.chess.fen();
  G = await load('guest', `../index.html?room=${roomId}`);
  await waitFor(() => !G.document.getElementById('modal').classList.contains('hidden'), 3000, 'join modal');
  G.document.querySelector('#modal .btn-primary').click();
  await waitFor(() => gApp().game && gApp().game.ply === 3, 30000, 'guest resynced');
  eq(gApp().game.chess.fen(), fen);
  eq(gApp().myColor, 'b');
  await waitFor(() => hApp().online.peerConnected, 10000, 'host sees reconnection');
  gApp().userMove({ from: 'b8', to: 'c6' });
  await waitFor(() => hApp().game.ply === 4, 5000, 'move after reconnect');
});

test('host reload reclaims the room and keeps the game', async () => {
  const fen = hApp().game.chess.fen();
  H.location.reload();
  await sleep(500);
  await waitFor(() => H.app && H.app.online && H.app.online.role === 'host' && H.app.game, 10000, 'host restored');
  eq(hApp().game.chess.fen(), fen);
  await waitFor(() => hApp().online.peerConnected && gApp().online.peerConnected, 60000, 'reconnected after host reload');
  hApp().userMove({ from: 'f1', to: 'b5' });
  await waitFor(() => gApp().game.ply === 5, 5000, 'move after host reload');
});

test('a third visitor is turned away while both players are connected', async () => {
  const w = document.createElement('iframe');
  w.width = 600; w.height = 500;
  document.body.appendChild(w);
  await new Promise((r) => { w.onload = r; w.src = `../index.html?room=${roomId}`; });
  // Different guest token: clear the shared sessionStorage token for this iframe only by giving it a fresh one
  const T = w.contentWindow;
  await waitFor(() => T.app, 5000);
  T.sessionStorage.removeItem('rookery:guest:' + roomId);
  T.app.joinOnline(roomId);
  await waitFor(() => T.document.getElementById('modalTitle').textContent === 'Game is full', 30000, 'full message');
  // restore guest token for the real guest (shared sessionStorage between same-origin iframes)
  G.sessionStorage.setItem('rookery:guest:' + roomId, JSON.stringify(gApp().online.token));
  w.remove();
  await sleep(500);
  eq(hApp().game.ply, 5);
});

test('resign ends the game on both sides', async () => {
  gApp().game.end({ winner: 'w', reason: 'resignation' });
  gApp().net.send({ t: 'resign', gameId: gApp().online.gameId });
  await waitFor(() => hApp().game.over, 5000, 'host sees resign');
  eq(hApp().game.result, { winner: 'w', reason: 'resignation' });
});

test('rematch swaps colors and starts a fresh game', async () => {
  hApp().rematch();
  await waitFor(() => gApp().online.rematch === 'received', 5000, 'guest sees rematch offer');
  gApp().rematch(); // accepting
  await waitFor(() => hApp().game.ply === 0 && gApp().game.ply === 0 && !gApp().game.over && !hApp().game.over, 8000, 'new game');
  eq(hApp().myColor, 'b');
  eq(gApp().myColor, 'w');
  gApp().userMove({ from: 'd2', to: 'd4' });
  await waitFor(() => hApp().game.ply === 1, 5000);
});

test('timeout decided by host reaches guest', async () => {
  // Force the host's view of white's (guest's) clock to almost zero.
  const g = hApp().game;
  g.clocks.w = 300; g.turnStart = performance.now();
  // Need clocks running: white has moved d4, black to move; give it to white first.
  hApp().userMove({ from: 'd7', to: 'd5' });
  hApp().game.clocks.w = 300;
  await waitFor(() => gApp().game.over, 8000, 'guest sees timeout');
  eq(gApp().game.result, { winner: 'b', reason: 'timeout' });
});

test('no page errors in either app', async () => {
  eq(errors, []);
});

run('online');
