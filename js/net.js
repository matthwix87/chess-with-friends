// Peer-to-peer networking over WebRTC using PeerJS and its free public
// broker (only used for the initial handshake; game data flows directly
// between the two browsers).
//
// The host registers the peer id derived from the room id and waits; the
// guest connects to it. A heartbeat detects dead links, and the guest keeps
// retrying until it gets back in, so short drops and page reloads recover.

const ID_PREFIX = 'rookery-v1-';
const HEARTBEAT_MS = 2000;
const DEAD_AFTER_MS = 9000;
const RETRY_MS = 3000;

export function randomRoomId() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const a = new Uint8Array(10);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => abc[x % abc.length]).join('');
}

export const isValidRoomId = (s) => typeof s === 'string' && /^[a-z0-9]{6,20}$/.test(s);

export class NetSession {
  /**
   * @param {object} o
   *  role: 'host' | 'guest'
   *  roomId: string
   *  onMessage(msg)        - a message from the opponent
   *  onStatus(state, info) - 'connecting' | 'waiting' | 'connected' | 'lost' | 'error'
   *  acceptGuest(hello)    - host only: return true to accept a guest's hello
   *  hello()               - guest only: returns the hello payload to send on connect
   */
  constructor(o) {
    this.o = o;
    this.role = o.role;
    this.roomId = o.roomId;
    this.peer = null;
    this.conn = null;
    this.lastSeen = 0;
    this.state = 'idle';
    this.destroyed = false;
    this.timers = new Set();
    this._hb = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
    this._start();
  }

  _status(state, info) {
    this.state = state;
    try { this.o.onStatus && this.o.onStatus(state, info); } catch (e) { console.error(e); }
  }

  _later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.destroyed) fn(); }, ms);
    this.timers.add(t);
  }

  _start() {
    if (this.destroyed) return;
    if (typeof window.Peer !== 'function') {
      this._status('error', 'Networking library failed to load. Check your connection or ad blocker.');
      return;
    }
    this._status('connecting');
    const id = this.role === 'host' ? ID_PREFIX + this.roomId : undefined;
    const peer = new window.Peer(id, { debug: 1 });
    this.peer = peer;

    peer.on('open', () => {
      if (this.role === 'host') this._status(this.conn && this.conn.open ? 'connected' : 'waiting');
      else this._connectToHost();
    });

    peer.on('connection', (conn) => { if (this.role === 'host') this._incoming(conn); });

    peer.on('disconnected', () => {
      // Lost the broker (not necessarily the opponent). Re-register quietly.
      this._later(() => { if (this.peer === peer && !peer.destroyed) { try { peer.reconnect(); } catch { /* ignore */ } } }, 1500);
    });

    peer.on('error', (err) => {
      const type = err && err.type;
      if (type === 'unavailable-id') {
        // Host reloaded and the broker still remembers the old session; retry.
        this._status('connecting', 'Reclaiming room...');
        this._restartPeer(RETRY_MS);
      } else if (type === 'peer-unavailable') {
        // Guest: host not online (yet). Keep trying.
        this._status(this.conn ? 'lost' : 'connecting', 'Waiting for host...');
        this._later(() => this._connectToHost(), RETRY_MS);
      } else if (type === 'browser-incompatible') {
        this._status('error', 'This browser does not support WebRTC.');
      } else {
        console.warn('PeerJS error', type, err);
        this._status('lost', 'Network problem, retrying...');
        this._restartPeer(RETRY_MS * 2);
      }
    });
  }

  _restartPeer(ms) {
    try { if (this.peer) this.peer.destroy(); } catch { /* ignore */ }
    this.peer = null;
    this._later(() => this._start(), ms);
  }

  _connectToHost() {
    if (this.destroyed || !this.peer || this.peer.destroyed || this.peer.disconnected) return;
    if (this.conn && this.conn.open) return;
    if (this.conn) { try { this.conn.close(); } catch { /* ignore */ } }
    const conn = this.peer.connect(ID_PREFIX + this.roomId, { reliable: true, serialization: 'json' });
    this.conn = conn;
    const timeout = setTimeout(() => {
      // Connection attempt hung (e.g. ICE failure). Try again.
      if (this.conn === conn && !conn.open) { try { conn.close(); } catch { /* ignore */ } this._connectToHost(); }
    }, 12000);
    conn.on('open', () => {
      clearTimeout(timeout);
      if (this.conn !== conn) return;
      this.lastSeen = Date.now();
      this._wire(conn);
      conn.send(this.o.hello());
    });
    conn.on('error', () => clearTimeout(timeout));
  }

  _incoming(conn) {
    conn.on('open', () => {
      // Wait for the guest's hello before adopting the connection.
      conn.on('data', (msg) => {
        if (this.conn === conn) return; // already adopted; handled by _wire
        if (!msg || msg.t !== 'hello') return;
        const currentAlive = this.conn && this.conn.open && Date.now() - this.lastSeen < DEAD_AFTER_MS;
        if (!this.o.acceptGuest(msg, currentAlive)) {
          try { conn.send({ t: 'full' }); } catch { /* ignore */ }
          setTimeout(() => conn.close(), 500);
          return;
        }
        if (this.conn && this.conn !== conn) { try { this.conn.close(); } catch { /* ignore */ } }
        this.conn = conn;
        this.lastSeen = Date.now();
        this._wire(conn);
        this._deliver(msg);
      });
    });
  }

  _wire(conn) {
    conn.on('data', (msg) => {
      if (this.conn !== conn) return;
      this.lastSeen = Date.now();
      if (this.state !== 'connected') this._status('connected');
      // The host's first hello is delivered by _incoming, so ignore repeats here.
      if (!msg || typeof msg !== 'object' || msg.t === 'ping' || (this.role === 'host' && msg.t === 'hello')) return;
      this._deliver(msg);
    });
    conn.on('close', () => {
      if (this.conn !== conn || this.destroyed) return;
      this._status('lost');
      if (this.role === 'guest') this._later(() => this._connectToHost(), 1000);
    });
    this._status('connected');
  }

  _deliver(msg) {
    try { this.o.onMessage(msg); } catch (e) { console.error('message handler failed', e); }
  }

  _heartbeat() {
    if (this.destroyed || !this.conn || !this.conn.open) return;
    try { this.conn.send({ t: 'ping' }); } catch { /* ignore */ }
    if (this.state === 'connected' && Date.now() - this.lastSeen > DEAD_AFTER_MS) {
      this._status('lost');
      if (this.role === 'guest') { try { this.conn.close(); } catch { /* ignore */ } this._connectToHost(); }
    }
  }

  get connected() { return this.state === 'connected' && !!this.conn && this.conn.open; }

  send(msg) {
    if (!this.conn || !this.conn.open) return false;
    try { this.conn.send(msg); return true; } catch { return false; }
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this._hb);
    for (const t of this.timers) clearTimeout(t);
    try { if (this.conn) this.conn.close(); } catch { /* ignore */ }
    try { if (this.peer) this.peer.destroy(); } catch { /* ignore */ }
  }
}
