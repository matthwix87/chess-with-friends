// App controller: wires the board, game model, clocks, engine and network
// together and keeps the side panel in sync.

import { Chess } from '../vendor/chess.js';
import { GameSession, TC_LABEL, formatClock, other, colorName } from './game.js';
import { BoardView, pieceUrl } from './board.js';
import { Engine } from './engine.js';
import { NetSession, randomRoomId, isValidRoomId } from './net.js';
import { playSound, setSoundEnabled, unlockAudio } from './sound.js';
import { load, save, remove } from './storage.js';
import { $, $$, escapeHtml, showModal, closeModal, toast } from './ui.js';

const LEVEL_NAMES = { 1: 'Easy', 2: 'Medium', 3: 'Hard', 4: 'Expert' };
const DEFAULTS = { theme: 'dark', board: 'sage', sound: true, name: '', tc: '5+0', color: 'random', level: 2, mode: 'online' };

class App {
  constructor() {
    this.settings = { ...DEFAULTS, ...load('settings', {}) };
    this.mode = null;        // 'local' | 'computer' | 'online'
    this.game = null;
    this.myColor = null;     // null = both sides (pass and play)
    this.names = { w: 'White', b: 'Black' };
    this.viewPly = null;     // null = live position, else a past ply being reviewed
    this.engine = new Engine();
    this.engineBusy = false;
    this.net = null;
    this.online = null;      // online-only state, see hostOnline()/joinOnline()
    this.lowTimeWarned = false;
    this.endShown = false;

    this.board = new BoardView($('#board'), {
      getLegalMoves: (sq) => (this.game ? this.game.legalMovesFrom(sq) : []),
      canMove: (color) => this.canMove(color),
      onMove: (from, to, promotion, info) => this.userMove({ from, to, promotion }, info),
    });

    this.applySettings();
    this.bindUi();
    this.showIdleBoard();
    setInterval(() => this.tick(), 100);
    this.route();
  }

  // ---------------------------------------------------------------- settings
  saveSettings() { save('settings', this.settings); }

  applySettings() {
    const s = this.settings;
    document.documentElement.dataset.theme = s.theme;
    document.documentElement.dataset.board = s.board;
    $('#btnTheme').textContent = s.theme === 'dark' ? '☾' : '☀';
    $('#btnSound').textContent = s.sound ? '♫' : '✕';
    $('#btnSound').title = s.sound ? 'Sound on' : 'Sound off';
    $('#boardTheme').value = s.board;
    setSoundEnabled(s.sound);
    $('#inpName').value = s.name;
    $$('#tcGrid button').forEach((b) => b.classList.toggle('active', b.dataset.tc === s.tc));
    $$('#segColor button').forEach((b) => b.classList.toggle('active', b.dataset.color === s.color));
    $$('#segLevel button').forEach((b) => b.classList.toggle('active', Number(b.dataset.level) === Number(s.level)));
    $$('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === s.mode));
    $('#fieldColor').classList.toggle('hidden', s.mode === 'local');
    $('#fieldLevel').classList.toggle('hidden', s.mode !== 'computer');
    $('#btnStart').textContent = { online: 'Play a friend', computer: 'Play the computer', local: 'Start pass and play' }[s.mode];
  }

  bindUi() {
    document.addEventListener('pointerdown', () => unlockAudio(), { once: true });
    $('#btnTheme').onclick = () => { this.settings.theme = this.settings.theme === 'dark' ? 'light' : 'dark'; this.saveSettings(); this.applySettings(); };
    $('#btnSound').onclick = () => { this.settings.sound = !this.settings.sound; this.saveSettings(); this.applySettings(); if (this.settings.sound) playSound('move'); };
    $('#boardTheme').onchange = (e) => { this.settings.board = e.target.value; this.saveSettings(); this.applySettings(); };
    $('#inpName').oninput = (e) => { this.settings.name = e.target.value.trim().slice(0, 24); this.saveSettings(); };
    $$('#tcGrid button').forEach((b) => (b.onclick = () => { this.settings.tc = b.dataset.tc; this.saveSettings(); this.applySettings(); }));
    $$('#segColor button').forEach((b) => (b.onclick = () => { this.settings.color = b.dataset.color; this.saveSettings(); this.applySettings(); }));
    $$('#segLevel button').forEach((b) => (b.onclick = () => { this.settings.level = Number(b.dataset.level); this.saveSettings(); this.applySettings(); }));
    $$('.mode-btn').forEach((b) => (b.onclick = () => { this.settings.mode = b.dataset.mode; this.saveSettings(); this.applySettings(); }));
    $$('.tab').forEach((t) => (t.onclick = () => this.showTab(t.dataset.tab)));
    $('#btnStart').onclick = () => this.startFromPanel();
    $('#btnCopy').onclick = () => this.copyLink();
    $('#btnCancelRoom').onclick = () => this.leaveOnline(true);
    $('#btnFlip').onclick = () => { this.board.flip(); this.render(); };
    $('#btnResign').onclick = () => this.resign();
    $('#btnDraw').onclick = () => this.offerDraw();
    $('#btnRematch').onclick = () => this.rematch();
    $('#btnNewGame').onclick = () => this.showTab('new');
    $('#btnOfferYes').onclick = () => this.answerOffer(true);
    $('#btnOfferNo').onclick = () => this.answerOffer(false);
    $$('[data-nav]').forEach((b) => (b.onclick = () => this.navigate(b.dataset.nav)));
    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, select, textarea')) return;
      const map = { ArrowLeft: 'prev', ArrowRight: 'next', ArrowUp: 'start', ArrowDown: 'end', Home: 'start', End: 'end' };
      if (map[e.key]) { e.preventDefault(); this.navigate(map[e.key]); }
      else if (e.key === 'f') { this.board.flip(); this.render(); }
    });
  }

  showTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $('#panelNew').classList.toggle('hidden', name !== 'new');
    $('#panelGame').classList.toggle('hidden', name !== 'game');
  }

  myName() { return this.settings.name || 'You'; }

  // ---------------------------------------------------------------- routing
  /** Look at ?room= in the URL: rejoin as host after a reload, or join as guest. */
  route() {
    const room = new URLSearchParams(location.search).get('room');
    if (!room) return;
    if (!isValidRoomId(room)) { toast('That invite link is not valid.'); this.clearUrl(); return; }
    const hostState = load('host', null, 'session');
    // window.name survives reloads of this tab but is not copied to new tabs, so
    // opening your own invite link in another tab joins as a guest instead.
    if (hostState && hostState.roomId === room && window.name === 'rookery-host-' + room) this.hostOnline(hostState);
    else this.promptJoin(room);
  }

  setUrlRoom(roomId) {
    try { history.replaceState(null, '', `${location.pathname}?room=${roomId}`); } catch { /* ignore */ }
  }

  clearUrl() {
    try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  }

  inviteLink(roomId) { return `${location.origin}${location.pathname}?room=${roomId}`; }

  // ---------------------------------------------------------------- starting games
  async startFromPanel() {
    unlockAudio();
    if (!(await this.confirmAbandon())) return;
    const s = this.settings;
    if (s.mode === 'local') this.startLocal(s.tc);
    else if (s.mode === 'computer') this.startComputer(s.tc, s.color, s.level);
    else this.hostOnline();
  }

  /** Ask before throwing away a game in progress. */
  async confirmAbandon() {
    if (!this.game || this.game.over || this.game.ply === 0) { this.leaveOnline(false); return true; }
    const msg = this.mode === 'online' ? 'Leaving counts as abandoning the current online game.' : 'The current game will be lost.';
    const ok = await showModal({ title: 'Start a new game?', text: msg, buttons: [{ label: 'Start new game', value: true, primary: true }, { label: 'Cancel', value: false }] });
    if (ok) {
      if (this.mode === 'online' && this.net) this.net.send({ t: 'resign', gameId: this.online.gameId });
      this.leaveOnline(false);
    }
    return !!ok;
  }

  resetCommon(mode, tc) {
    this.engine.stop();
    this.engineBusy = false;
    this.board.cancelPromotion();
    this.mode = mode;
    this.game = new GameSession(tc);
    this.viewPly = null;
    this.lowTimeWarned = false;
    this.endShown = false;
    this.hideOffer();
  }

  startLocal(tc) {
    this.resetCommon('local', tc);
    this.myColor = null;
    this.names = { w: 'White', b: 'Black' };
    this.board.setOrientation('w');
    this.afterStart();
  }

  startComputer(tc, colorPref, level) {
    this.resetCommon('computer', tc);
    this.level = Number(level) || 2;
    this.myColor = colorPref === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : colorPref;
    this.names = { [this.myColor]: this.myName(), [other(this.myColor)]: `Computer (${LEVEL_NAMES[this.level]})` };
    this.board.setOrientation(this.myColor);
    this.afterStart();
    this.maybeEngineMove();
  }

  afterStart() {
    playSound('start');
    this.showTab('game');
    this.render();
  }

  showIdleBoard() {
    this.render();
  }

  // ---------------------------------------------------------------- moves
  canMove(color) {
    const g = this.game;
    if (!g || g.over || this.viewPly !== null || g.turn !== color) return false;
    if (this.mode === 'local') return true;
    if (color !== this.myColor) return false;
    if (this.mode === 'computer') return !this.engineBusy;
    if (this.mode === 'online') return !!this.net && this.net.connected && !!this.online.started;
    return false;
  }

  /** A move made on this device via the board. */
  userMove(mv, info = {}) {
    if (!this.canMove(this.game.turn)) return;
    const ply = this.game.ply;
    const m = this.playMove(mv, { animate: !info.dragged });
    if (!m) return;
    if (this.mode === 'online') {
      const msg = { t: 'move', gameId: this.online.gameId, ply, from: m.from, to: m.to, promotion: m.promotion || null };
      if (this.online.role === 'host') msg.clocks = this.clockSnapshot();
      this.net.send(msg);
      if (this.online.role === 'host') this.persistHost();
      // Any pending draw offer is void once a move is played.
      if (this.online.drawOffer === 'received') { this.online.drawOffer = null; this.hideOffer(); }
    }
    if (this.mode === 'computer') this.maybeEngineMove();
  }

  /** Apply a move to the game, play sounds and redraw. Returns the move or null. */
  playMove(mv, { animate = true } = {}) {
    const m = this.game.applyMove(mv);
    if (!m) {
      this.render();
      if (this.game.over) this.onGameOver();
      return null;
    }
    this.viewPly = null;
    const pairs = [[m.from, m.to]];
    if (m.flags.includes('k')) pairs.push(['h' + m.to[1], 'f' + m.to[1]]);
    if (m.flags.includes('q')) pairs.push(['a' + m.to[1], 'd' + m.to[1]]);
    this.render(animate ? pairs : null);
    if (this.game.over) { this.onGameOver(); return m; }
    if (this.game.chess.inCheck()) playSound('check');
    else if (m.flags.includes('p')) playSound('promote');
    else if (m.captured) playSound('capture');
    else if (m.flags.includes('k') || m.flags.includes('q')) playSound('castle');
    else playSound('move');
    return m;
  }

  async maybeEngineMove() {
    const g = this.game;
    if (this.mode !== 'computer' || !g || g.over || g.turn === this.myColor) return;
    this.engineBusy = true;
    this.render();
    const started = performance.now();
    let mv = null;
    try { mv = await this.engine.bestMove(g.chess.fen(), this.level); } catch (e) { console.error(e); }
    // A tiny minimum delay so instant replies don't feel jarring.
    const wait = Math.max(0, 250 - (performance.now() - started));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (g !== this.game || g.over) return; // game changed while thinking
    this.engineBusy = false;
    if (mv) this.playMove(mv);
    else this.render();
  }

  // ---------------------------------------------------------------- clocks
  clockSnapshot() {
    return { w: this.game.remaining('w'), b: this.game.remaining('b') };
  }

  tick() {
    const g = this.game;
    if (!g || !g.tc) return;
    const authoritative = this.mode !== 'online' || (this.online && this.online.role === 'host');
    if (authoritative && !g.over && g.checkFlag()) {
      if (this.mode === 'online') {
        this.net.send({ t: 'end', gameId: this.online.gameId, result: g.result, clocks: this.clockSnapshot() });
        this.persistHost();
      }
      this.engine.stop();
      this.engineBusy = false;
      this.render();
      this.onGameOver();
      return;
    }
    // Host: periodic clock sync so the guest's display never drifts far.
    if (this.mode === 'online' && this.online.role === 'host' && !g.over && g.clockRunning) {
      const t = performance.now();
      if (!this.lastSync || t - this.lastSync > 3000) {
        this.lastSync = t;
        this.net.send({ t: 'clock', gameId: this.online.gameId, ply: g.ply, clocks: this.clockSnapshot() });
      }
    }
    this.renderClocks();
  }

  renderClocks() {
    const g = this.game;
    for (const bar of [$('#barTop'), $('#barBottom')]) {
      const color = bar.dataset.color;
      const el = bar.querySelector('[data-clock]');
      if (!g || !color) { el.textContent = '--:--'; el.className = 'clock'; continue; }
      const ms = g.remaining(color);
      el.textContent = g.tc ? formatClock(ms) : '∞';
      el.classList.toggle('active', !g.over && g.turn === color && (g.clockRunning || !g.tc));
      el.classList.toggle('low', !!g.tc && ms < 20_000);
      el.classList.toggle('flagged', !!g.tc && ms <= 0);
      // One beep when your own clock drops under 10 seconds.
      if (g.tc && !g.over && color === this.myColor && g.turn === color && ms < 10_000 && !this.lowTimeWarned && g.tc.base > 30_000) {
        this.lowTimeWarned = true;
        playSound('lowtime');
      }
    }
  }

  // ---------------------------------------------------------------- rendering
  render(animate = null) {
    const g = this.game;
    const orient = this.board.orientation;
    // Board position (live or reviewed ply).
    if (!g) {
      this.board.setBoardArray(new Chess().board());
    } else {
      const ply = this.viewPly === null ? g.ply : this.viewPly;
      const view = ply === g.ply ? g.chess : new Chess(g.fens[ply]);
      const last = ply > 0 ? g.moves[ply - 1] : null;
      let check = null;
      if (view.inCheck()) {
        const k = view.board().flat().find((p) => p && p.type === 'k' && p.color === view.turn());
        check = k && k.square;
      }
      this.board.setBoardArray(view.board(), { lastMove: last && { from: last.from, to: last.to }, check, animate: this.viewPly === null ? animate : null });
    }
    this.board.refresh();

    // Player bars: bottom shows the board's orientation color.
    const bottom = orient, top = other(orient);
    this.renderBar($('#barBottom'), bottom);
    this.renderBar($('#barTop'), top);
    this.renderClocks();
    this.renderMoves();
    this.renderStatus();
  }

  renderBar(bar, color) {
    bar.dataset.color = this.game ? color : '';
    const nameEl = bar.querySelector('[data-name]');
    const g = this.game;
    if (!g) {
      nameEl.textContent = color === this.board.orientation ? this.myName() : 'Opponent';
      bar.querySelector('[data-captured]').innerHTML = '';
      bar.querySelector('[data-avatar]').style.backgroundImage = `url(${pieceUrl(color, 'k')})`;
      return;
    }
    let tag = '';
    if (this.mode !== 'local' && color === this.myColor) tag = '<span class="tag">(you)</span>';
    if (this.mode === 'online' && color !== this.myColor && this.online && !this.online.peerConnected && this.online.started) tag = '<span class="tag">(disconnected)</span>';
    nameEl.innerHTML = escapeHtml(this.names[color] || colorName(color)) + tag;
    bar.querySelector('[data-avatar]').style.backgroundImage = `url(${pieceUrl(color, this.mode === 'computer' && color !== this.myColor ? 'n' : 'k')})`;
    // Captured pieces (pieces of the opposite color this side has taken).
    const { capturedBy, diff } = g.material();
    const taken = capturedBy[color];
    const opp = other(color);
    let html = '';
    for (const t of ['p', 'n', 'b', 'r', 'q']) {
      if (!taken[t]) continue;
      html += '<span class="grp">' + `<img src="${pieceUrl(opp, t)}" alt="">`.repeat(taken[t]) + '</span>';
    }
    const adv = color === 'w' ? diff : -diff;
    if (adv > 0) html += `<span class="adv">+${adv}</span>`;
    bar.querySelector('[data-captured]').innerHTML = html;
  }

  renderMoves() {
    const list = $('#moveList');
    const g = this.game;
    if (!g) { list.innerHTML = ''; return; }
    const cur = this.viewPly === null ? g.ply : this.viewPly;
    let html = '';
    for (let i = 0; i < g.moves.length; i += 2) {
      const w = g.moves[i], b = g.moves[i + 1];
      html += `<div class="move-row"><span class="move-no">${i / 2 + 1}.</span>`
        + `<span class="mv${cur === i + 1 ? ' current' : ''}" data-ply="${i + 1}">${escapeHtml(w.san)}</span>`
        + (b ? `<span class="mv${cur === i + 2 ? ' current' : ''}" data-ply="${i + 2}">${escapeHtml(b.san)}</span>` : '<span></span>')
        + '</div>';
    }
    if (g.over) html += `<div class="move-row"><span></span><span class="move-no">${this.resultScore()}</span></div>`;
    list.innerHTML = html;
    $$('.mv', list).forEach((el) => (el.onclick = () => this.setView(Number(el.dataset.ply))));
    if (this.viewPly === null) list.scrollTop = list.scrollHeight;
  }

  resultScore() {
    const r = this.game.result;
    if (!r) return '';
    return r.winner === 'w' ? '1-0' : r.winner === 'b' ? '0-1' : '½-½';
  }

  resultText() {
    const r = this.game.result;
    if (!r.winner) return `Draw by ${r.reason}`;
    const who = this.mode === 'local' ? colorName(r.winner) : (this.names[r.winner] || colorName(r.winner));
    return `${who} won by ${r.reason}`;
  }

  renderStatus() {
    const g = this.game;
    const status = $('#statusLine');
    const draw = $('#btnDraw'), resign = $('#btnResign'), rematch = $('#btnRematch'), newGame = $('#btnNewGame');
    if (!g) {
      status.textContent = !this.online ? 'No game in progress' : this.online.role === 'host' ? 'Waiting for your friend to join...' : 'Joining game...';
      draw.disabled = resign.disabled = true;
      rematch.classList.add('hidden');
      newGame.classList.add('hidden');
      return;
    }
    const tcLabel = TC_LABEL[g.tcKey];
    if (g.over) status.textContent = this.resultText();
    else if (this.mode === 'computer' && this.engineBusy) status.textContent = 'Computer is thinking...';
    else if (this.mode === 'local') status.textContent = `${colorName(g.turn)} to move - ${tcLabel}`;
    else status.textContent = (g.turn === this.myColor ? 'Your move' : "Opponent's move") + ` - ${tcLabel}`;

    const live = !g.over;
    resign.disabled = !live || (this.mode === 'online' && !this.online.started);
    draw.disabled = !live || this.mode === 'local' || this.mode === 'computer' || (this.online && this.online.drawOffer === 'sent');
    draw.classList.toggle('hidden', this.mode !== 'online');
    rematch.classList.toggle('hidden', live);
    newGame.classList.toggle('hidden', live);
    rematch.disabled = this.mode === 'online' && this.online && (this.online.rematch === 'sent' || !this.online.peerConnected);
    rematch.textContent = this.mode === 'online' && this.online && this.online.rematch === 'sent' ? 'Rematch sent' : '↻ Rematch';
  }

  // ---------------------------------------------------------------- history navigation
  setView(ply) {
    const g = this.game;
    if (!g) return;
    ply = Math.max(0, Math.min(g.ply, ply));
    this.viewPly = ply === g.ply ? null : ply;
    this.board.deselect();
    this.render();
  }

  navigate(dir) {
    const g = this.game;
    if (!g) return;
    const cur = this.viewPly === null ? g.ply : this.viewPly;
    if (dir === 'start') this.setView(0);
    else if (dir === 'prev') this.setView(cur - 1);
    else if (dir === 'next') this.setView(cur + 1);
    else this.setView(g.ply);
  }

  // ---------------------------------------------------------------- game end, resign, draw, rematch
  onGameOver() {
    if (this.endShown || !this.game || !this.game.over) return;
    this.endShown = true;
    this.board.cancelPromotion();
    this.hideOffer();
    playSound('end');
    this.render();
    const r = this.game.result;
    let title;
    if (!r.winner) title = 'Draw';
    else if (this.mode === 'local') title = `${colorName(r.winner)} wins`;
    else title = r.winner === this.myColor ? 'You won!' : 'You lost';
    const reason = `by ${r.reason}`;
    const g = this.game;
    setTimeout(() => {
      if (g !== this.game) return; // a new game already started (e.g. quick rematch)
      showModal({
        title, text: reason,
        buttons: [{ label: 'Rematch', value: 'rematch', primary: true }, { label: 'New game', value: 'new' }, { label: 'Review game', value: 'close' }],
      }).then((v) => {
        if (v === 'rematch') this.rematch();
        else if (v === 'new') this.showTab('new');
      });
    }, 350);
  }

  async resign() {
    const g = this.game;
    if (!g || g.over) return;
    const ok = await showModal({ title: 'Resign?', text: 'Are you sure you want to resign this game?', buttons: [{ label: 'Resign', value: true, primary: true }, { label: 'Cancel', value: false }] });
    if (!ok || g !== this.game || g.over) return;
    const loser = this.mode === 'local' ? g.turn : this.myColor;
    g.end({ winner: other(loser), reason: 'resignation' });
    if (this.mode === 'online') {
      this.net.send({ t: 'resign', gameId: this.online.gameId });
      this.persistHost();
    }
    this.engine.stop();
    this.engineBusy = false;
    this.onGameOver();
  }

  offerDraw() {
    if (this.mode !== 'online' || !this.game || this.game.over) return;
    if (this.online.drawOffer === 'received') { this.answerOffer(true); return; }
    this.online.drawOffer = 'sent';
    this.net.send({ t: 'draw', action: 'offer', gameId: this.online.gameId });
    toast('Draw offer sent');
    this.render();
  }

  showOffer(kind) {
    this.offerKind = kind;
    $('#offerText').textContent = kind === 'draw' ? 'Your opponent offers a draw' : 'Your opponent wants a rematch';
    $('#offerBox').classList.remove('hidden');
    playSound('notify');
  }

  hideOffer() { $('#offerBox').classList.add('hidden'); this.offerKind = null; }

  answerOffer(yes) {
    const kind = this.offerKind;
    this.hideOffer();
    if (!this.online) return;
    if (kind === 'draw') {
      this.online.drawOffer = null;
      this.net.send({ t: 'draw', action: yes ? 'accept' : 'decline', gameId: this.online.gameId });
      if (yes && this.game && !this.game.over) { this.game.end({ winner: null, reason: 'agreement' }); this.persistHost(); this.onGameOver(); }
    } else if (kind === 'rematch') {
      this.online.rematch = null;
      if (yes) {
        closeModal(null);
        if (this.online.role === 'host') this.hostNewGame(true);
        else this.net.send({ t: 'rematch', action: 'accept' });
      } else {
        this.net.send({ t: 'rematch', action: 'decline' });
      }
    }
    this.render();
  }

  rematch() {
    closeModal(null);
    if (!this.game) return;
    if (this.mode === 'local') return this.startLocal(this.game.tcKey);
    if (this.mode === 'computer') {
      this.startComputer(this.game.tcKey, other(this.myColor), this.level);
      return;
    }
    if (this.mode === 'online') {
      if (!this.game.over) return;
      if (this.online.rematch === 'received') { this.offerKind = 'rematch'; this.answerOffer(true); return; }
      this.online.rematch = 'sent';
      this.net.send({ t: 'rematch', action: 'offer' });
      toast('Rematch offer sent');
      this.render();
    }
  }

  // ---------------------------------------------------------------- online play
  /**
   * Become the host of a room. With `restore` (from sessionStorage) the host
   * reclaims the same room after a page reload and keeps the game.
   */
  hostOnline(restore = null) {
    this.leaveOnline(false);
    const roomId = restore ? restore.roomId : randomRoomId();
    const s = this.settings;
    this.mode = 'online';
    this.game = null;
    this.online = {
      role: 'host', roomId, started: false, peerConnected: false,
      tcKey: restore ? restore.tcKey : s.tc,
      colorPref: restore ? restore.colorPref : s.color,
      hostName: restore ? restore.hostName : this.myName(),
      guestName: restore ? restore.guestName : 'Friend',
      guestToken: restore ? restore.guestToken : null,
      hostColor: restore ? restore.hostColor : null,
      gameId: restore ? restore.gameId : null,
      drawOffer: null, rematch: null,
    };
    if (restore && restore.snap) {
      try {
        this.game = GameSession.fromSnapshot(restore.snap);
        this.myColor = this.online.hostColor;
        this.names = { [this.myColor]: this.online.hostName, [other(this.myColor)]: this.online.guestName };
        this.online.started = true;
        this.endShown = !!this.game.result;
        this.board.setOrientation(this.myColor);
      } catch (e) {
        console.error('Could not restore game', e);
        this.game = null;
      }
    }
    this.setUrlRoom(roomId);
    window.name = 'rookery-host-' + roomId;
    this.persistHost();
    $('#shareLink').value = this.inviteLink(roomId);
    $('#sharePanel').classList.toggle('hidden', !!this.game);
    $('#shareStatus').textContent = 'Creating room...';
    this.showTab(this.game ? 'game' : 'new');
    this.net = new NetSession({
      role: 'host', roomId,
      onMessage: (m) => this.onNetMessage(m),
      onStatus: (st, info) => this.onNetStatus(st, info),
      acceptGuest: (hello, currentAlive) => this.acceptGuest(hello, currentAlive),
    });
    this.render();
  }

  acceptGuest(hello, currentAlive) {
    const o = this.online;
    const token = String(hello.token || '');
    if (!o.guestToken || token === o.guestToken || !currentAlive) {
      o.guestToken = token;
      return true;
    }
    return false; // someone else is already playing
  }

  /** Save the host's room + game to sessionStorage so a reload can resume it. */
  persistHost() {
    const o = this.online;
    if (!o || o.role !== 'host') return;
    save('host', {
      roomId: o.roomId, tcKey: o.tcKey, colorPref: o.colorPref, hostName: o.hostName, guestName: o.guestName,
      guestToken: o.guestToken, hostColor: o.hostColor, gameId: o.gameId, snap: this.game ? this.game.snapshot() : null,
    }, 'session');
  }

  /** Host: start a (new) game with the connected guest and send it over. */
  hostNewGame(swapColors) {
    const o = this.online;
    if (swapColors && o.hostColor) o.hostColor = other(o.hostColor);
    else o.hostColor = o.colorPref === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : o.colorPref;
    o.gameId = randomRoomId();
    o.started = true;
    o.drawOffer = null;
    o.rematch = null;
    this.resetCommon('online', o.tcKey);
    this.myColor = o.hostColor;
    this.names = { [o.hostColor]: o.hostName, [other(o.hostColor)]: o.guestName };
    this.board.setOrientation(this.myColor);
    $('#sharePanel').classList.add('hidden');
    this.sendState();
    this.persistHost();
    this.afterStart();
  }

  sendState() {
    const o = this.online;
    if (!this.game) return;
    this.net.send({
      t: 'state', gameId: o.gameId, hostColor: o.hostColor, tcKey: o.tcKey,
      names: { host: o.hostName, guest: o.guestName }, snap: this.game.snapshot(),
    });
  }

  promptJoin(roomId) {
    showModal({
      title: "You're invited to a game",
      text: 'Enter your name and join your friend.',
      input: { value: this.settings.name, placeholder: 'Your name' },
      buttons: [{ label: 'Join game', value: 'join', primary: true }, { label: 'Cancel', value: 'cancel' }],
      dismissable: false,
    }).then((res) => {
      if (!res || res.value !== 'join') { this.clearUrl(); return; }
      if (res.text) { this.settings.name = res.text.slice(0, 24); this.saveSettings(); this.applySettings(); }
      unlockAudio();
      this.joinOnline(roomId);
    });
  }

  joinOnline(roomId) {
    this.leaveOnline(false);
    let token = load('guest:' + roomId, null, 'session');
    if (!token) { token = randomRoomId(); save('guest:' + roomId, token, 'session'); }
    this.mode = 'online';
    this.game = null;
    this.online = { role: 'guest', roomId, token, started: false, peerConnected: false, gameId: null, drawOffer: null, rematch: null };
    this.showTab('game');
    this.net = new NetSession({
      role: 'guest', roomId,
      onMessage: (m) => this.onNetMessage(m),
      onStatus: (st, info) => this.onNetStatus(st, info),
      hello: () => ({ t: 'hello', token, name: this.myName(), gameId: this.online.gameId, ply: this.game ? this.game.ply : 0 }),
    });
    this.render();
  }

  /** Leave/cancel any online session. `clear` also forgets the hosted room. */
  leaveOnline(clear = true) {
    if (this.net) { this.net.destroy(); this.net = null; }
    if (this.online && this.online.role === 'host') { remove('host', 'session'); window.name = ''; }
    if (this.online) this.clearUrl();
    this.online = null;
    $('#sharePanel').classList.add('hidden');
    $('#connLine').classList.add('hidden');
    if (this.mode === 'online') { this.mode = null; if (clear) { this.game = null; this.render(); } }
  }

  copyLink() {
    const input = $('#shareLink');
    const text = input.value;
    const done = () => toast('Invite link copied');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => { input.select(); document.execCommand('copy'); done(); });
    } else { input.select(); document.execCommand('copy'); done(); }
  }

  onNetStatus(state, info) {
    const o = this.online;
    if (!o) return;
    const line = $('#connLine');
    const wasConnected = o.peerConnected;
    o.peerConnected = state === 'connected';
    let text = '', cls = '';
    if (o.role === 'host') {
      if (state === 'waiting' || (state === 'connecting' && !o.started)) {
        $('#shareStatus').textContent = state === 'waiting' ? 'Waiting for your friend to join...' : (info || 'Creating room...');
        text = o.started ? 'Opponent disconnected. Waiting for them to come back...' : '';
        cls = 'bad';
      }
    }
    if (state === 'connected') { text = `Connected to ${o.role === 'host' ? o.guestName : (o.hostName || 'host')}`; cls = 'ok'; }
    else if (state === 'lost') { text = o.role === 'host' ? 'Opponent disconnected. Waiting for them to reconnect...' : 'Connection lost. Reconnecting...'; cls = 'bad'; }
    else if (state === 'connecting' && o.role === 'guest') { text = info || 'Connecting to your friend...'; cls = ''; }
    else if (state === 'error') { text = info || 'Network error'; cls = 'bad'; if (o.role === 'host' && !o.started) $('#shareStatus').textContent = text; }
    line.textContent = text;
    line.className = 'conn-line ' + cls;
    line.classList.toggle('hidden', !text);
    if (wasConnected && !o.peerConnected && o.started) toast('Opponent connection lost');
    if (!wasConnected && o.peerConnected && o.started) toast('Opponent connected');
    this.render();
  }

  /** Every message from the opponent goes through here and is validated. */
  onNetMessage(msg) {
    const o = this.online;
    if (!o || !msg || typeof msg.t !== 'string') return;
    const host = o.role === 'host';

    if (host && msg.t === 'hello') {
      o.guestName = String(msg.name || 'Friend').slice(0, 24);
      if (this.game && o.started) {
        this.names[other(o.hostColor)] = o.guestName;
        this.sendState(); // reconnect: resync the guest
        this.render();
      } else {
        this.hostNewGame(false);
      }
      return;
    }
    if (!host && msg.t === 'full') {
      this.leaveOnline(true);
      showModal({ title: 'Game is full', text: 'This game already has two players. Ask your friend for a new link.' });
      return;
    }
    if (!host && msg.t === 'state') return this.applyState(msg);
    if (host && msg.t === 'needState') return this.sendState();
    if (msg.t === 'rematch') return this.onRematchMsg(msg);

    const g = this.game;
    if (!g || msg.gameId !== o.gameId) return; // stale message from a previous game

    switch (msg.t) {
      case 'move': {
        const theirColor = other(this.myColor);
        if (msg.ply < g.ply) return; // duplicate
        if (msg.ply !== g.ply || g.turn !== theirColor || g.over) { this.requestResync(); return; }
        const legal = g.legalMovesFrom(msg.from).some((m) => m.to === msg.to && (m.promotion || null) === (msg.promotion || null));
        if (!legal) { console.warn('Rejected illegal move from opponent', msg); this.requestResync(); return; }
        const m = this.playMove({ from: msg.from, to: msg.to, promotion: msg.promotion || undefined });
        if (!m) {
          if (host && g.over) { this.net.send({ t: 'end', gameId: o.gameId, result: g.result, clocks: this.clockSnapshot() }); this.sendState(); this.persistHost(); }
          return;
        }
        if (o.drawOffer === 'sent') o.drawOffer = null;
        if (host) {
          this.net.send({ t: 'clock', gameId: o.gameId, ply: g.ply, clocks: this.clockSnapshot() });
          this.persistHost();
        } else if (msg.clocks) {
          g.setClocks(msg.clocks.w, msg.clocks.b);
        }
        break;
      }
      case 'clock':
        if (!host && msg.clocks && msg.ply === g.ply && !g.over) g.setClocks(msg.clocks.w, msg.clocks.b);
        break;
      case 'end':
        if (!host && !g.over && msg.result) {
          if (msg.clocks) g.setClocks(msg.clocks.w, msg.clocks.b);
          g.end(msg.result);
          this.onGameOver();
        }
        break;
      case 'resign':
        if (!g.over) {
          g.end({ winner: this.myColor, reason: 'resignation' });
          this.persistHost();
          this.onGameOver();
        }
        break;
      case 'draw':
        if (g.over) return;
        if (msg.action === 'offer') {
          if (o.drawOffer === 'sent') { // both offered: agree
            this.net.send({ t: 'draw', action: 'accept', gameId: o.gameId });
            g.end({ winner: null, reason: 'agreement' }); this.persistHost(); this.onGameOver();
          } else { o.drawOffer = 'received'; this.showOffer('draw'); }
        } else if (msg.action === 'accept' && o.drawOffer === 'sent') {
          o.drawOffer = null;
          g.end({ winner: null, reason: 'agreement' }); this.persistHost(); this.onGameOver();
        } else if (msg.action === 'decline') {
          o.drawOffer = null; toast('Draw offer declined');
        }
        this.render();
        break;
      default:
        break;
    }
  }

  requestResync() {
    if (this.online.role === 'guest') this.net.send({ t: 'needState' });
    else this.sendState();
  }

  onRematchMsg(msg) {
    const o = this.online;
    if (!this.game || !this.game.over) return;
    if (msg.action === 'offer') {
      if (o.rematch === 'sent') { // both asked
        if (o.role === 'host') this.hostNewGame(true);
        else this.net.send({ t: 'rematch', action: 'accept' });
        return;
      }
      o.rematch = 'received';
      this.showOffer('rematch');
      toast('Your opponent wants a rematch');
    } else if (msg.action === 'accept') {
      if (o.role === 'host') { closeModal(null); this.hostNewGame(true); }
    } else if (msg.action === 'decline') {
      o.rematch = null;
      toast('Rematch declined');
    }
    this.render();
  }

  /** Guest: adopt the authoritative game state sent by the host. */
  applyState(msg) {
    const o = this.online;
    let g;
    try { g = GameSession.fromSnapshot(msg.snap); } catch (e) {
      console.error('Bad state from host', e);
      toast('Received an invalid game state');
      return;
    }
    const newGame = msg.gameId !== o.gameId;
    const prevPly = this.game ? this.game.ply : -1;
    g.flagEnabled = false; // the host decides timeouts
    o.gameId = msg.gameId;
    o.hostColor = msg.hostColor === 'b' ? 'b' : 'w';
    o.hostName = String((msg.names && msg.names.host) || 'Host').slice(0, 24);
    o.started = true;
    if (newGame) { o.drawOffer = null; o.rematch = null; this.hideOffer(); closeModal(null); }
    this.engine.stop();
    this.game = g;
    this.myColor = other(o.hostColor);
    this.names = { [o.hostColor]: o.hostName, [this.myColor]: this.myName() };
    this.viewPly = null;
    if (newGame) {
      this.endShown = !!g.result;
      this.lowTimeWarned = false;
      this.board.setOrientation(this.myColor);
      this.afterStart();
    } else {
      this.render();
      if (g.ply !== prevPly) playSound('move');
      if (g.over && !this.endShown) this.onGameOver();
    }
  }
}

window.app = new App();
