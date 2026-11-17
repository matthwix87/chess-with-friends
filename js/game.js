// Game model: wraps chess.js for the rules and adds clocks + game result.
// It is UI-agnostic so the same code runs in the app, in tests and when
// replaying a snapshot received from an online opponent.

import { Chess } from '../vendor/chess.js';

export const TIME_CONTROLS = {
  '1+0': { base: 60_000, inc: 0 },
  '3+0': { base: 180_000, inc: 0 },
  '5+0': { base: 300_000, inc: 0 },
  '10+0': { base: 600_000, inc: 0 },
  '10+5': { base: 600_000, inc: 5_000 },
  'none': null,
};

export const TC_LABEL = {
  '1+0': '1 min Bullet', '3+0': '3 min Blitz', '5+0': '5 min Blitz',
  '10+0': '10 min Rapid', '10+5': '10 | 5 Rapid', 'none': 'Unlimited',
};

const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const now = () => performance.now();

export const other = (c) => (c === 'w' ? 'b' : 'w');
export const colorName = (c) => (c === 'w' ? 'White' : 'Black');

export class GameSession {
  constructor(tcKey = 'none') {
    this.tcKey = TIME_CONTROLS[tcKey] !== undefined ? tcKey : 'none';
    this.tc = TIME_CONTROLS[this.tcKey];
    this.chess = new Chess();
    this.moves = [];                     // verbose move records
    this.fens = [this.chess.fen()];      // fens[i] = position after i plies
    this.clocks = { w: this.tc ? this.tc.base : Infinity, b: this.tc ? this.tc.base : Infinity };
    this.clockRunning = false;           // clocks start after White's first move
    this.turnStart = 0;
    this.result = null;                  // { winner: 'w'|'b'|null, reason }
    this.flagEnabled = true;             // may this session decide timeouts?
  }

  get turn() { return this.chess.turn(); }
  get ply() { return this.moves.length; }
  get over() { return !!this.result; }

  legalMovesFrom(square) {
    if (this.result) return [];
    return this.chess.moves({ square, verbose: true });
  }

  /** True if from->to is a legal pawn move that needs a promotion choice. */
  isPromotion(from, to) {
    return this.legalMovesFrom(from).some((m) => m.to === to && m.promotion);
  }

  isLegal(from, to) {
    return this.legalMovesFrom(from).some((m) => m.to === to);
  }

  /**
   * Apply a move ({from, to, promotion?}). Returns the verbose move, or null
   * if illegal / game over. `at` lets callers pass a timestamp (tests).
   */
  applyMove({ from, to, promotion }, at = now()) {
    if (this.result) return null;
    // Online guests leave flag decisions to the host (flagEnabled = false).
    if (this.tc && this.flagEnabled) this.checkFlag(at);
    if (this.result) return null;
    let m;
    try {
      m = this.chess.move({ from, to, promotion: promotion || undefined });
    } catch {
      return null; // chess.js throws on illegal moves
    }
    if (!m) return null;

    if (this.tc) {
      if (this.clockRunning) {
        this.clocks[m.color] -= at - this.turnStart;
        this.clocks[m.color] += this.tc.inc;
      }
      this.clockRunning = true;
      this.turnStart = at;
    }

    this.moves.push(m);
    this.fens.push(this.chess.fen());
    this._detectEnd(m.color);
    return m;
  }

  _detectEnd(mover) {
    const c = this.chess;
    if (c.isCheckmate()) this.end({ winner: mover, reason: 'checkmate' });
    else if (c.isStalemate()) this.end({ winner: null, reason: 'stalemate' });
    else if (c.isInsufficientMaterial()) this.end({ winner: null, reason: 'insufficient material' });
    else if (c.isThreefoldRepetition()) this.end({ winner: null, reason: 'threefold repetition' });
    else if (c.isDrawByFiftyMoves()) this.end({ winner: null, reason: '50-move rule' });
  }

  /** Remaining time in ms for a color at time `at`. */
  remaining(color, at = now()) {
    if (!this.tc) return Infinity;
    let t = this.clocks[color];
    if (this.clockRunning && !this.result && this.turn === color) t -= at - this.turnStart;
    return Math.max(0, t);
  }

  /** Ends the game on time if the side to move has run out. */
  checkFlag(at = now()) {
    if (!this.tc || !this.clockRunning || this.result) return false;
    const side = this.turn;
    if (this.remaining(side, at) > 0) return false;
    this.clocks[side] = 0;
    this.clockRunning = false;
    if (!this.canMate(other(side))) this.result = { winner: null, reason: 'timeout vs insufficient material' };
    else this.result = { winner: other(side), reason: 'timeout' };
    return true;
  }

  /** Whether `color` has enough material to possibly deliver mate. */
  canMate(color) {
    const pieces = this.chess.board().flat().filter((p) => p && p.color === color && p.type !== 'k');
    if (pieces.length === 0) return false;
    if (pieces.length === 1 && (pieces[0].type === 'n' || pieces[0].type === 'b')) return false;
    return true;
  }

  /** Ends the game (resign, agreed draw, checkmate...). Freezes the clocks. */
  end(result, at = now()) {
    if (this.result) return;
    if (this.tc && this.clockRunning) {
      const side = this.turn;
      this.clocks[side] = this.remaining(side, at);
      this.clockRunning = false;
    }
    this.result = result;
  }

  /** Overwrite clocks (used by the online guest when the host syncs). */
  setClocks(w, b, at = now()) {
    if (!this.tc) return;
    this.clocks.w = w;
    this.clocks.b = b;
    this.turnStart = at;
  }

  /** Material on the board, captured pieces per side and the advantage. */
  material() {
    const count = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
    let score = { w: 0, b: 0 };
    for (const p of this.chess.board().flat()) {
      if (!p || p.type === 'k') continue;
      count[p.color][p.type]++;
      score[p.color] += VALUES[p.type];
    }
    // capturedBy[w] = black pieces White has taken (promotions can make the
    // naive count negative, so clamp at 0).
    const capturedBy = { w: {}, b: {} };
    for (const c of ['w', 'b']) {
      for (const t of ['p', 'n', 'b', 'r', 'q']) capturedBy[other(c)][t] = Math.max(0, START_COUNT[t] - count[c][t]);
    }
    return { capturedBy, diff: score.w - score.b };
  }

  /** Serializable snapshot (used for online resync and host reload). */
  snapshot(at = now()) {
    return {
      tcKey: this.tcKey,
      moves: this.moves.map((m) => ({ from: m.from, to: m.to, promotion: m.promotion || null })),
      clocks: { w: this.remaining('w', at), b: this.remaining('b', at) },
      clockRunning: this.clockRunning,
      result: this.result,
    };
  }

  /** Rebuild a session from a snapshot. Every move is re-validated. */
  static fromSnapshot(snap, at = now()) {
    const g = new GameSession(snap.tcKey);
    for (const mv of snap.moves || []) {
      let m;
      try { m = g.chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion || undefined }); } catch { m = null; }
      if (!m) throw new Error('Invalid move in snapshot');
      g.moves.push(m);
      g.fens.push(g.chess.fen());
    }
    if (g.tc && snap.clocks) {
      g.clocks = { w: snap.clocks.w, b: snap.clocks.b };
      g.clockRunning = !!snap.clockRunning;
      g.turnStart = at;
    }
    g.result = snap.result || null;
    if (!g.result && g.moves.length) g._detectEnd(g.moves[g.moves.length - 1].color);
    return g;
  }
}

/** Format milliseconds like a chess clock: m:ss, or s.t below 10 seconds. */
export function formatClock(ms) {
  if (!isFinite(ms)) return '--:--';
  ms = Math.max(0, ms);
  if (ms < 10_000) {
    const tenths = Math.floor(ms / 100);
    return `0:0${Math.floor(tenths / 10)}.${tenths % 10}`;
  }
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
