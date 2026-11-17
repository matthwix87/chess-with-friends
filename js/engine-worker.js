// Built-in chess engine (runs in a Web Worker so the UI never freezes).
// Negamax + alpha-beta, iterative deepening, quiescence search, MVV-LVA move
// ordering and piece-square tables. Modest strength, but plenty for casual play.
//
// For speed it uses chess.js internals (_moves/_makeMove/_undoMove/_board on
// the 0x88 board). That is safe here because chess.js is vendored at a pinned
// version (1.4.0).

import { Chess } from '../vendor/chess.js';

const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE = 100000;

// Piece-square tables, from White's point of view, index 0 = a8 ... 63 = h1.
// Values follow the widely used "simplified evaluation function" layout.
const PST = {
  p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
  kEnd: [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50],
};

// Difficulty presets: max depth, time budget (ms), random noise (centipawns), quiescence.
const LEVELS = {
  1: { depth: 1, time: 300, noise: 180, qs: false },
  2: { depth: 2, time: 800, noise: 40, qs: true },
  3: { depth: 3, time: 1500, noise: 8, qs: true },
  4: { depth: 6, time: 3000, noise: 0, qs: true },
};

let chess;
let nodes = 0;
let deadline = 0;
class Timeout extends Error {}

const sqName = (s) => 'abcdefgh'[s & 7] + (8 - (s >> 4));

/** Static evaluation from the side-to-move's perspective. */
function evaluate() {
  const board = chess._board;
  let score = 0, nonPawn = 0;
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    const p = board[s];
    if (p && p.type !== 'p' && p.type !== 'k') nonPawn += VAL[p.type];
  }
  const endgame = nonPawn <= 1300;
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    const p = board[s];
    if (!p) continue;
    const row = s >> 4, file = s & 7;
    const idx = p.color === 'w' ? row * 8 + file : (7 - row) * 8 + file;
    const table = p.type === 'k' && endgame ? PST.kEnd : PST[p.type];
    const v = VAL[p.type] + table[idx];
    score += p.color === 'w' ? v : -v;
  }
  return chess._turn === 'w' ? score : -score;
}

/** Order moves: promotions and captures (most valuable victim first). */
function order(moves, best) {
  for (const m of moves) {
    let k = 0;
    if (best && m.from === best.from && m.to === best.to && m.promotion === best.promotion) k = 1e6;
    if (m.captured) k += 10 * VAL[m.captured] - VAL[m.piece] + 1000;
    if (m.promotion) k += VAL[m.promotion] + 900;
    m._k = k;
  }
  moves.sort((a, b) => b._k - a._k);
  return moves;
}

function quiesce(alpha, beta, depth) {
  if ((++nodes & 1023) === 0 && performance.now() > deadline) throw new Timeout();
  const stand = evaluate();
  if (stand >= beta) return beta;
  if (alpha < stand) alpha = stand;
  if (depth <= 0) return alpha;
  const moves = order(chess._moves({ legal: true }).filter((m) => m.captured || m.promotion));
  for (const m of moves) {
    chess._makeMove(m);
    const score = -quiesce(-beta, -alpha, depth - 1);
    chess._undoMove();
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function negamax(depth, alpha, beta, ply, qs) {
  if ((++nodes & 1023) === 0 && performance.now() > deadline) throw new Timeout();
  const moves = chess._moves({ legal: true });
  if (moves.length === 0) return chess._isKingAttacked(chess._turn) ? -MATE + ply : 0;
  if (chess._halfMoves >= 100) return 0;
  if (depth <= 0) return qs ? quiesce(alpha, beta, 6) : evaluate();
  order(moves);
  for (const m of moves) {
    chess._makeMove(m);
    const score = -negamax(depth - 1, -beta, -alpha, ply + 1, qs);
    chess._undoMove();
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

/** Search the root with iterative deepening; returns the chosen internal move. */
function think(fen, levelNo) {
  const L = LEVELS[levelNo] || LEVELS[2];
  chess = new Chess(fen);
  const rootMoves = chess._moves({ legal: true });
  if (rootMoves.length === 0) return null;
  if (rootMoves.length === 1) return rootMoves[0];
  deadline = performance.now() + L.time;
  nodes = 0;
  let best = null;
  let scored = [];
  for (let depth = 1; depth <= L.depth; depth++) {
    const iter = [];
    try {
      order(rootMoves, best);
      let alpha = -Infinity;
      for (const m of rootMoves) {
        chess._makeMove(m);
        // Full window at the root so every move gets a comparable score (needed for noise).
        const score = -negamax(depth - 1, -Infinity, L.noise ? Infinity : -alpha, 1, L.qs);
        chess._undoMove();
        iter.push({ m, score });
        if (score > alpha) alpha = score;
      }
    } catch (e) {
      if (!(e instanceof Timeout)) throw e;
      // Restore the board: unwind any half-made moves from the aborted search.
      chess = new Chess(fen);
      break;
    }
    scored = iter;
    best = iter.reduce((a, b) => (b.score > a.score ? b : a)).m;
    if (Math.max(...iter.map((x) => x.score)) > MATE - 100) break; // found a mate
  }
  if (!scored.length) return best || rootMoves[0];
  // Add noise for lower levels so the computer makes human-like mistakes,
  // but never throw away a forced mate.
  let pick = null, pickScore = -Infinity;
  for (const { m, score } of scored) {
    const s = score > MATE - 100 ? score : score + (Math.random() * 2 - 1) * L.noise;
    if (s > pickScore) { pickScore = s; pick = m; }
  }
  return pick;
}

self.onmessage = (e) => {
  const { id, fen, level } = e.data;
  let move = null;
  try {
    const m = think(fen, level);
    if (m) move = { from: sqName(m.from), to: sqName(m.to), promotion: m.promotion || undefined };
  } catch (err) {
    self.postMessage({ id, error: String(err) });
    return;
  }
  self.postMessage({ id, move, nodes });
};
