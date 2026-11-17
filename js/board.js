// Board view: renders a position and turns pointer input (mouse, touch, pen)
// into move requests. It knows nothing about the rules; the controller
// supplies legal moves through the `getLegalMoves` callback.

const FILES = 'abcdefgh';
export const pieceUrl = (color, type) => `pieces/${color}${type.toUpperCase()}.svg`;

export class BoardView {
  /**
   * @param {HTMLElement} el
   * @param {object} opts
   *   getLegalMoves(square) -> [{to, promotion?, captured?, flags}]
   *   onMove(from, to, promotion) -> called with a legal move
   *   canMove(color) -> whether the local user may move pieces of this color now
   */
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    this.orientation = 'w';
    this.pieces = {};          // square -> {type, color}
    this.selected = null;
    this.targets = [];         // legal moves of the selected piece
    this.lastMove = null;
    this.checkSquare = null;
    this.drag = null;
    this.promoPending = null;
    this.squares = {};         // square name -> element
    this._build();
    this._bindPointer();
  }

  _build() {
    this.el.innerHTML = '';
    this.cells = [];
    for (let i = 0; i < 64; i++) {
      const d = document.createElement('div');
      d.className = 'sq';
      this.el.appendChild(d);
      this.cells.push(d);
    }
    this._layout();
  }

  /** Assign square names/colors/coordinates to the 64 cells for the orientation. */
  _layout() {
    this.squares = {};
    this.cells.forEach((d, i) => {
      const r = Math.floor(i / 8), c = i % 8;
      const fileIdx = this.orientation === 'w' ? c : 7 - c;
      const rank = this.orientation === 'w' ? 8 - r : r + 1;
      const name = FILES[fileIdx] + rank;
      d.dataset.square = name;
      d.className = 'sq ' + ((fileIdx + rank) % 2 === 1 ? 'dark' : 'light');
      d.innerHTML = '';
      if (c === 0) d.insertAdjacentHTML('beforeend', `<span class="coord rank">${rank}</span>`);
      if (r === 7) d.insertAdjacentHTML('beforeend', `<span class="coord file">${FILES[fileIdx]}</span>`);
      this.squares[name] = d;
    });
    const old = this.pieces;
    this.pieces = {};
    this.setPieces(old);
  }

  setOrientation(color) {
    if (color === this.orientation) return;
    this.orientation = color;
    this._layout();
    this._paintMarks();
  }

  flip() { this.setOrientation(this.orientation === 'w' ? 'b' : 'w'); }

  /** Load a chess.js board() array (rank 8 first). */
  setBoardArray(arr, { lastMove = null, check = null, animate = null } = {}) {
    const map = {};
    for (const row of arr) for (const p of row) if (p) map[p.square] = { type: p.type, color: p.color };
    this.lastMove = lastMove;
    this.checkSquare = check;
    this.setPieces(map);
    if (animate) this._animate(animate);
    if (this.selected && !(this.pieces[this.selected] && this.opts.canMove(this.pieces[this.selected].color))) this.deselect();
    else if (this.selected) this.targets = this.opts.getLegalMoves(this.selected);
    this._paintMarks();
  }

  /** Diff the piece map against the DOM, reusing images where possible. */
  setPieces(map) {
    for (const sq of Object.keys(this.squares)) {
      const want = map[sq];
      const have = this.pieces[sq];
      const cell = this.squares[sq];
      if (want && have && want.type === have.type && want.color === have.color) continue;
      const oldImg = cell.querySelector('.piece');
      if (oldImg) oldImg.remove();
      if (want) {
        const img = document.createElement('img');
        img.className = 'piece';
        img.alt = '';
        img.draggable = false;
        img.src = pieceUrl(want.color, want.type);
        img.dataset.piece = want.color + want.type;
        cell.appendChild(img);
      }
    }
    this.pieces = { ...map };
  }

  /** Slide pieces from their old squares (pairs of [from, to]). */
  _animate(pairs) {
    for (const [from, to] of pairs) {
      const img = this.squares[to] && this.squares[to].querySelector('.piece');
      if (!img) continue;
      const [fx, fy] = this._xy(from), [tx, ty] = this._xy(to);
      img.style.transition = 'none';
      img.style.transform = `translate(${(fx - tx) * 100}%, ${(fy - ty) * 100}%)`;
      img.style.zIndex = 5;
      img.getBoundingClientRect(); // force reflow so the transition runs
      img.style.transition = 'transform 160ms ease-out';
      img.style.transform = '';
      setTimeout(() => { img.style.zIndex = ''; img.style.transition = ''; }, 200);
    }
  }

  /** Screen column/row (0..7) of a square for the current orientation. */
  _xy(sq) {
    const f = FILES.indexOf(sq[0]), r = Number(sq[1]);
    return this.orientation === 'w' ? [f, 8 - r] : [7 - f, r - 1];
  }

  _paintMarks() {
    const targetMap = new Map(this.targets.map((m) => [m.to, m]));
    for (const [sq, cell] of Object.entries(this.squares)) {
      const p = this.pieces[sq];
      cell.classList.toggle('last', !!this.lastMove && (this.lastMove.from === sq || this.lastMove.to === sq));
      cell.classList.toggle('check', this.checkSquare === sq);
      cell.classList.toggle('selected', this.selected === sq);
      const t = targetMap.get(sq);
      cell.classList.toggle('move', !!t && !p && !(t.flags || '').includes('e'));
      cell.classList.toggle('capture', !!t && (!!p || (t.flags || '').includes('e')));
      cell.classList.toggle('mine', !!p && this.opts.canMove(p.color));
    }
  }

  /** Re-evaluate which pieces are movable (after turn/mode changes). */
  refresh() {
    if (this.selected && !(this.pieces[this.selected] && this.opts.canMove(this.pieces[this.selected].color))) this.deselect();
    this.el.classList.toggle('interactive', true);
    this._paintMarks();
  }

  select(sq) {
    this.selected = sq;
    this.targets = this.opts.getLegalMoves(sq);
    this._paintMarks();
  }

  deselect() {
    this.selected = null;
    this.targets = [];
    this._paintMarks();
  }

  _squareAt(x, y) {
    const r = this.el.getBoundingClientRect();
    if (x < r.left || y < r.top || x >= r.right || y >= r.bottom) return null;
    const c = Math.floor(((x - r.left) / r.width) * 8);
    const row = Math.floor(((y - r.top) / r.height) * 8);
    const cell = this.cells[row * 8 + c];
    return cell ? cell.dataset.square : null;
  }

  _isTarget(sq) { return this.targets.some((m) => m.to === sq); }

  _bindPointer() {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    el.addEventListener('pointerup', (e) => this._up(e));
    el.addEventListener('pointercancel', () => this._cancelDrag());
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _down(e) {
    if (this.promoPending) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const sq = this._squareAt(e.clientX, e.clientY);
    if (!sq) return;
    e.preventDefault();
    if (this.selected && sq !== this.selected && this._isTarget(sq)) {
      this._tryMove(this.selected, sq, false);
      return;
    }
    const p = this.pieces[sq];
    if (p && this.opts.canMove(p.color)) {
      const wasSelected = this.selected === sq;
      this.select(sq);
      this.drag = { from: sq, x: e.clientX, y: e.clientY, started: false, wasSelected, id: e.pointerId };
      try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    } else {
      this.deselect();
    }
  }

  _move(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
      d.started = true;
      const p = this.pieces[d.from];
      const ghost = document.createElement('img');
      ghost.className = 'drag-ghost';
      ghost.src = pieceUrl(p.color, p.type);
      document.body.appendChild(ghost);
      d.ghost = ghost;
      this.squares[d.from].classList.add('dragging-from');
    }
    d.ghost.style.left = e.clientX + 'px';
    d.ghost.style.top = e.clientY + 'px';
    const over = this._squareAt(e.clientX, e.clientY);
    if (over !== d.over) {
      if (d.over && this.squares[d.over]) this.squares[d.over].classList.remove('hover');
      d.over = over;
      if (over && this._isTarget(over)) this.squares[over].classList.add('hover');
    }
  }

  _up(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const sq = this._squareAt(e.clientX, e.clientY);
    this._cancelDrag();
    if (d.started) {
      if (sq && sq !== d.from && this._isTarget(sq)) this._tryMove(d.from, sq, true);
    } else if (d.wasSelected && sq === d.from) {
      this.deselect(); // second click on the same piece toggles selection off
    }
  }

  _cancelDrag() {
    const d = this.drag;
    if (!d) return;
    if (d.ghost) d.ghost.remove();
    if (d.over && this.squares[d.over]) this.squares[d.over].classList.remove('hover');
    if (this.squares[d.from]) this.squares[d.from].classList.remove('dragging-from');
    this.drag = null;
  }

  async _tryMove(from, to, dragged) {
    const mv = this.targets.find((m) => m.to === to);
    this.deselect();
    if (!mv) return;
    let promotion;
    if (mv.promotion) {
      promotion = await this.askPromotion(to, this.pieces[from].color);
      if (!promotion) return;
    }
    this.opts.onMove(from, to, promotion, { dragged });
  }

  /** Show the promotion picker over the target file. Resolves to q/r/b/n or null. */
  askPromotion(to, color) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('boardOverlay');
      const [col, row] = this._xy(to);
      const fromTop = row === 0;
      overlay.innerHTML = '';
      overlay.classList.remove('hidden');
      const box = document.createElement('div');
      box.className = 'promo';
      box.style.left = `${col * 12.5}%`;
      box.style[fromTop ? 'top' : 'bottom'] = '0';
      if (!fromTop) box.style.flexDirection = 'column-reverse';
      const finish = (val) => {
        overlay.classList.add('hidden');
        overlay.innerHTML = '';
        this.promoPending = null;
        resolve(val);
      };
      for (const t of ['q', 'n', 'r', 'b']) {
        const b = document.createElement('button');
        b.dataset.promo = t;
        b.title = { q: 'Queen', n: 'Knight', r: 'Rook', b: 'Bishop' }[t];
        b.innerHTML = `<img src="${pieceUrl(color, t)}" alt="${b.title}">`;
        b.addEventListener('click', (ev) => { ev.stopPropagation(); finish(t); });
        box.appendChild(b);
      }
      const cancel = document.createElement('button');
      cancel.className = 'promo-cancel';
      cancel.textContent = 'x';
      cancel.title = 'Cancel';
      cancel.addEventListener('click', (ev) => { ev.stopPropagation(); finish(null); });
      box.appendChild(cancel);
      overlay.appendChild(box);
      overlay.onclick = () => finish(null);
      this.promoPending = finish;
    });
  }

  /** Close any open promotion picker (e.g. when the game ends). */
  cancelPromotion() { if (this.promoPending) this.promoPending(null); }
}

