import { test, assert, eq, run } from './harness.js';
import { GameSession, formatClock } from '../js/game.js';
import { Engine } from '../js/engine.js';

const san = (g, list) => {
  for (const s of list) {
    const m = g.chess.moves({ verbose: true }).find((x) => x.san === s);
    assert(m, `move ${s} not legal at ply ${g.ply}`);
    assert(g.applyMove({ from: m.from, to: m.to, promotion: m.promotion }), `applyMove ${s} failed`);
  }
};
const fromFen = (fen, tc = 'none') => { const g = new GameSession(tc); g.chess.load(fen); g.fens = [fen]; return g; };
const at = (g, sq) => { const p = g.chess.get(sq); return p ? p.color + p.type : null; };

test("scholar's mate ends in checkmate for White", () => {
  const g = new GameSession();
  san(g, ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#']);
  eq(g.result, { winner: 'w', reason: 'checkmate' });
  assert(g.applyMove({ from: 'e8', to: 'f7' }) === null, 'no moves after mate');
});

test("fool's mate ends in checkmate for Black", () => {
  const g = new GameSession();
  san(g, ['f3', 'e5', 'g4', 'Qh4#']);
  eq(g.result, { winner: 'b', reason: 'checkmate' });
});

test('illegal moves are rejected', () => {
  const g = new GameSession();
  assert(g.applyMove({ from: 'e2', to: 'e5' }) === null);
  assert(g.applyMove({ from: 'e7', to: 'e5' }) === null, 'wrong side');
  assert(g.applyMove({ from: 'zz', to: 'e5' }) === null, 'garbage');
  eq(g.ply, 0);
});

test('kingside and queenside castling move king and rook', () => {
  const g = fromFen('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
  assert(g.isLegal('e1', 'g1') && g.isLegal('e1', 'c1'), 'both castles legal');
  g.applyMove({ from: 'e1', to: 'g1' });
  eq([at(g, 'g1'), at(g, 'f1'), at(g, 'h1')], ['wk', 'wr', null]);
  g.applyMove({ from: 'e8', to: 'c8' });
  eq([at(g, 'c8'), at(g, 'd8'), at(g, 'a8')], ['bk', 'br', null]);
  eq(g.moves.map((m) => m.san), ['O-O', 'O-O-O']);
});

test('cannot castle through or out of check, or after the king moved', () => {
  let g = fromFen('4k3/8/8/8/8/8/5r2/R3K2R w KQ - 0 1'); // f2 rook attacks... e1 in check? no: f2 attacks f1
  assert(!g.isLegal('e1', 'g1'), 'through attacked f1');
  g = fromFen('4k3/8/8/8/8/8/4r3/R3K2R w KQ - 0 1'); // in check from e2
  assert(!g.isLegal('e1', 'g1') && !g.isLegal('e1', 'c1'), 'out of check');
  g = fromFen('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  san(g, ['Kf1', 'Kd8', 'Ke1', 'Ke8']);
  assert(!g.isLegal('e1', 'g1'), 'king moved earlier');
});

test('en passant capture removes the pawn and is only allowed immediately', () => {
  const g = new GameSession();
  san(g, ['e4', 'a6', 'e5', 'd5']);
  assert(g.isLegal('e5', 'd6'), 'ep available');
  g.applyMove({ from: 'e5', to: 'd6' });
  eq([at(g, 'd6'), at(g, 'd5')], ['wp', null]);
  assert(g.moves[4].flags.includes('e'), 'flag e');
  const g2 = new GameSession();
  san(g2, ['e4', 'a6', 'e5', 'd5', 'Nf3', 'a5']);
  assert(!g2.isLegal('e5', 'd6'), 'ep expired');
});

test('promotion requires a choice and supports under-promotion', () => {
  const g = fromFen('8/4P1k1/8/8/8/8/6K1/8 w - - 0 1');
  assert(g.isPromotion('e7', 'e8'), 'detected');
  const m = g.applyMove({ from: 'e7', to: 'e8', promotion: 'n' });
  assert(m && m.san === 'e8=N+', 'san ' + (m && m.san));
  eq(at(g, 'e8'), 'wn');
  const g2 = fromFen('8/4P1k1/8/8/8/8/6K1/8 w - - 0 1');
  g2.applyMove({ from: 'e7', to: 'e8', promotion: 'q' });
  eq(at(g2, 'e8'), 'wq');
});

test('stalemate is a draw', () => {
  const g = fromFen('7k/4Q3/6K1/8/8/8/8/8 w - - 0 1');
  g.applyMove({ from: 'e7', to: 'f7' });
  eq(g.result, { winner: null, reason: 'stalemate' });
});

test('threefold repetition is a draw', () => {
  const g = new GameSession();
  san(g, ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1']);
  assert(!g.result, 'not yet');
  san(g, ['Ng8']);
  eq(g.result, { winner: null, reason: 'threefold repetition' });
});

test('50-move rule is a draw', () => {
  const g = fromFen('8/8/8/4k3/8/8/R7/4K3 w - - 99 80');
  g.applyMove({ from: 'a2', to: 'a3' });
  eq(g.result, { winner: null, reason: '50-move rule' });
});

test('insufficient material is a draw (K+B vs K)', () => {
  const g = fromFen('4k3/8/8/8/8/8/3r4/3BK3 w - - 0 1');
  g.applyMove({ from: 'e1', to: 'd2' });
  eq(g.result, { winner: null, reason: 'insufficient material' });
});

test('clocks: start after first move, deduct time, add increment', () => {
  const g = new GameSession('10+5');
  g.applyMove({ from: 'e2', to: 'e4' }, 1000);     // White's first move: no deduction, clock starts
  eq(g.clocks.w, 600000);
  eq(Math.round(g.remaining('b', 4000)), 597000);
  g.applyMove({ from: 'e7', to: 'e5' }, 4000);     // Black used 3s, +5s
  eq(g.clocks.b, 602000);
  g.applyMove({ from: 'g1', to: 'f3' }, 14000);    // White used 10s, +5s
  eq(g.clocks.w, 595000);
});

test('flag: running out of time loses', () => {
  const g = new GameSession('1+0');
  g.applyMove({ from: 'e2', to: 'e4' }, 0);
  assert(!g.checkFlag(59000), 'not yet');
  assert(g.checkFlag(60001), 'flagged');
  eq(g.result, { winner: 'w', reason: 'timeout' });
  eq(g.remaining('b'), 0);
});

test('flag vs insufficient material is a draw', () => {
  const g = fromFen('4k3/8/8/8/8/8/4P3/4K3 b - - 0 1', '1+0');
  g.clockRunning = true; g.turnStart = 0;           // Black to move; White has K+P? pawn can mate -> win
  g.checkFlag(61000);
  eq(g.result && g.result.winner, 'w', 'K+P can still win');
  const g2 = fromFen('4k3/8/8/8/8/8/8/3NK3 b - - 0 1', '1+0');
  g2.clockRunning = true; g2.turnStart = 0;
  g2.checkFlag(61000);
  eq(g2.result, { winner: null, reason: 'timeout vs insufficient material' });
});

test('guest sessions do not decide timeouts on move', () => {
  const g = new GameSession('1+0');
  g.flagEnabled = false;
  g.applyMove({ from: 'e2', to: 'e4' }, 0);
  assert(g.applyMove({ from: 'e7', to: 'e5' }, 70000), 'move accepted, host decides');
  assert(!g.result);
});

test('snapshot round-trip and tampered snapshot rejected', () => {
  const g = new GameSession('5+0');
  san(g, ['e4', 'e5', 'Nf3', 'Nc6']);
  const snap = JSON.parse(JSON.stringify(g.snapshot()));
  const g2 = GameSession.fromSnapshot(snap);
  eq(g2.chess.fen(), g.chess.fen());
  eq(g2.moves.map((m) => m.san), ['e4', 'e5', 'Nf3', 'Nc6']);
  snap.moves.push({ from: 'e1', to: 'e5' });
  let threw = false;
  try { GameSession.fromSnapshot(snap); } catch { threw = true; }
  assert(threw, 'tampered snapshot must throw');
});

test('material: captured pieces and advantage', () => {
  const g = new GameSession();
  san(g, ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qxg2']);
  const { capturedBy, diff } = g.material();
  eq(capturedBy.w.p, 1);
  eq(capturedBy.b.p, 2);
  eq(diff, -1);
});

test('formatClock', () => {
  eq(formatClock(300000), '5:00');
  eq(formatClock(61000), '1:01');
  eq(formatClock(9540), '0:09.5');
  eq(formatClock(Infinity), '--:--');
});

const engine = new Engine();
for (const level of [1, 2, 3, 4]) {
  test(`engine level ${level} returns a legal move from the start`, async () => {
    const g = new GameSession();
    const t = performance.now();
    const mv = await engine.bestMove(g.chess.fen(), level);
    assert(mv && g.isLegal(mv.from, mv.to), 'legal: ' + JSON.stringify(mv));
    assert(performance.now() - t < 6000, 'too slow');
  });
}
for (const level of [2, 3, 4]) {
  test(`engine level ${level} finds a back-rank mate in one`, async () => {
    const mv = await engine.bestMove('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', level);
    eq(mv && mv.from + mv.to, 'a1a8');
  });
}
test('engine (level 3) wins a hanging queen', async () => {
  const mv = await engine.bestMove('rnb1kbnr/pppp1ppp/8/4p1q1/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', 3);
  eq(mv && mv.from + mv.to, 'f3g5');
});
test('engine plays a full game against itself without errors', async () => {
  const g = new GameSession();
  for (let i = 0; i < 60 && !g.over; i++) {
    const mv = await engine.bestMove(g.chess.fen(), 1 + (i % 2));
    assert(mv, 'engine returned null at ply ' + g.ply);
    assert(g.applyMove(mv), 'engine move illegal at ply ' + g.ply + ' ' + JSON.stringify(mv));
  }
  assert(g.ply > 10);
});

run('rules');
