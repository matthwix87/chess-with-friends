// Promise wrapper around the engine Web Worker.

export class Engine {
  constructor() {
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
  }

  _ensure() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.move);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'engine error'));
      this.pending.clear();
    };
  }

  /** Ask for a move: resolves to {from, to, promotion} or null. */
  bestMove(fen, level) {
    this._ensure();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, fen, level });
    });
  }

  /** Abort any search in progress (e.g. new game) by restarting the worker. */
  stop() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.resolve(null);
    this.pending.clear();
  }
}
