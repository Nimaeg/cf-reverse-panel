// Original implementation. Same transport engine is used in Node and Workers.
export const TYPE = Object.freeze({ OPEN: 1, DATA: 2, FIN: 3, RESET: 4, OK: 5, ERROR: 6, ACK: 7, PING: 8, PONG: 9 });
export const CHUNK = 16384;
export const WINDOW = 131072;
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });
const validTypes = new Set(Object.values(TYPE));
export function frame(type, id, data = new Uint8Array()) {
  const b = new Uint8Array(5 + data.length);
  b[0] = type;
  new DataView(b.buffer).setUint32(1, id);
  b.set(data, 5);
  return b;
}
function number(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; }
function safeClose(endpoint) { try { Promise.resolve(endpoint?.close()).catch(() => {}); } catch {} }

export class Mux {
  constructor({ send, closeTransport = () => {}, connectTarget, maxStreams = 4, openTimeout = 12000, idleTimeout = 300000 }) {
    this.sendRaw = send; this.closeTransport = closeTransport; this.connectTarget = connectTarget;
    this.maxStreams = maxStreams; this.openTimeout = openTimeout; this.idleTimeout = idleTimeout;
    this.streams = new Map(); this.next = 1; this.closed = false;
    this.lastReceived = Date.now(); this.bytesSent = 0; this.bytesReceived = 0;
  }
  send(type, id, data) {
    if (this.closed) throw new Error('channel closed');
    this.sendRaw(frame(type, id, data));
  }
  create(id, endpoint, beforeStart) {
    const s = { id, endpoint, beforeStart, ready: false, sendCredit: WINDOW, recvCredit: WINDOW,
      localFin: false, remoteFin: false, remoteFinApplied: false, queue: Promise.resolve(), lastActive: Date.now() };
    this.streams.set(id, s);
    s.timer = setTimeout(() => this.drop(s, true, 'open timeout'), this.openTimeout);
    return s;
  }
  open(target, endpoint, beforeStart = async () => {}) {
    if (this.closed || this.streams.size >= this.maxStreams) return Promise.reject(new Error('no tunnel capacity'));
    // Never reuse stream IDs within one connection; late frames cannot target a new stream.
    if (this.next > 0xffffffff) return Promise.reject(new Error('stream IDs exhausted; reconnect channel'));
    const id = this.next++, s = this.create(id, endpoint, beforeStart);
    const result = new Promise((resolve, reject) => { s.resolve = resolve; s.reject = reject; });
    try { this.send(TYPE.OPEN, id, enc.encode(JSON.stringify(target))); }
    catch (e) { this.drop(s, false, e.message); }
    return result;
  }
  receive(input) {
    if (this.closed) return;
    try {
      const b = input instanceof Uint8Array ? input : new Uint8Array(input);
      if (b.length < 5 || b.length > CHUNK + 5 || !validTypes.has(b[0])) throw new Error('invalid frame');
      const type = b[0], id = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(1), data = b.subarray(5);
      this.lastReceived = Date.now();
      if (type === TYPE.PING || type === TYPE.PONG) {
        if (id !== 0 || data.length) throw new Error('invalid heartbeat');
        if (type === TYPE.PING) this.send(TYPE.PONG, 0);
        return;
      }
      if (id === 0) throw new Error('invalid stream ID');
      if (type === TYPE.OPEN) { this.accept(id, data); return; }
      const s = this.streams.get(id);
      if (!s) return; // Frames already in flight after a reset are harmless.
      s.lastActive = Date.now();
      if (type === TYPE.OK) {
        if (s.ready || this.connectTarget || data.length) throw new Error('unexpected OK');
        this.start(s); return;
      }
      if (type === TYPE.ERROR || type === TYPE.RESET) { this.drop(s, false, 'remote stream closed'); return; }
      if (!s.ready) { this.drop(s, true, 'stream not ready'); return; }
      if (type === TYPE.DATA) {
        if (s.remoteFin || !data.length || data.length > CHUNK || data.length > s.recvCredit) throw new Error('receive window exceeded');
        s.recvCredit -= data.length;
        const copy = data.slice(); this.bytesReceived += copy.length;
        s.queue = s.queue.then(async () => {
          if (!this.streams.has(id)) return;
          await s.endpoint.writer.write(copy);
          if (!this.streams.has(id)) return;
          s.recvCredit += copy.length;
          this.send(TYPE.ACK, id, number(copy.length));
        }).catch(e => this.drop(s, true, e.message));
      } else if (type === TYPE.ACK) {
        if (data.length !== 4) throw new Error('invalid ACK');
        const n = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
        if (n < 1 || s.sendCredit + n > WINDOW) throw new Error('invalid credit');
        s.sendCredit += n;
        s.wake?.(); s.wake = null;
      } else if (type === TYPE.FIN) {
        if (data.length || s.remoteFin) throw new Error('invalid FIN');
        s.remoteFin = true;
        s.queue = s.queue.then(async () => {
          if (!this.streams.has(id)) return;
          await s.endpoint.writer.close();
          s.remoteFinApplied = true;
          this.finish(s);
        }).catch(e => this.drop(s, true, e.message));
      }
    } catch { this.shutdown('protocol error'); }
  }
  accept(id, data) {
    if (!this.connectTarget || this.streams.has(id)) throw new Error('unexpected OPEN');
    if (this.streams.size >= this.maxStreams || data.length > 512) { this.send(TYPE.ERROR, id); return; }
    let target;
    try { target = JSON.parse(dec.decode(data)); } catch { this.send(TYPE.ERROR, id); return; }
    // Reserve the slot BEFORE awaiting DNS/connect, so pending opens count toward the cap.
    const s = this.create(id);
    Promise.resolve().then(() => this.connectTarget(target)).then(endpoint => {
      if (this.closed || this.streams.get(id) !== s) { safeClose(endpoint); return; }
      s.endpoint = endpoint;
      this.send(TYPE.OK, id);
      this.start(s);
    }).catch(() => {
      if (this.streams.get(id) === s) { try { this.send(TYPE.ERROR, id); } catch {} this.drop(s, false, 'connect failed'); }
    });
  }
  start(s) {
    clearTimeout(s.timer); s.ready = true;
    s.queue = Promise.resolve().then(() => s.beforeStart?.());
    s.queue.then(() => {
      if (this.streams.get(s.id) !== s) return;
      s.resolve?.(s.id); s.resolve = null; s.reject = null;
      this.pump(s).catch(e => this.drop(s, true, e.message));
    }).catch(e => this.drop(s, true, e.message));
  }
  async pump(s) {
    while (this.streams.get(s.id) === s) {
      const { done, value } = await s.endpoint.reader.read();
      if (this.streams.get(s.id) !== s) return;
      if (done) { s.localFin = true; this.send(TYPE.FIN, s.id); this.finish(s); return; }
      for (let offset = 0; offset < value.length;) {
        if (this.streams.get(s.id) !== s) return;
        if (!s.sendCredit) { await new Promise(resolve => { s.wake = resolve; }); continue; }
        const n = Math.min(CHUNK, s.sendCredit, value.length - offset);
        s.sendCredit -= n;
        this.send(TYPE.DATA, s.id, value.subarray(offset, offset + n));
        this.bytesSent += n; offset += n; s.lastActive = Date.now();
      }
    }
  }
  finish(s) { if (s.localFin && s.remoteFinApplied) this.drop(s, false); }
  drop(s, notify, reason = 'stream closed') {
    if (!s || this.streams.get(s.id) !== s) return;
    this.streams.delete(s.id); clearTimeout(s.timer);
    s.reject?.(new Error(reason)); s.reject = null; s.resolve = null;
    s.wake?.(); s.wake = null;
    if (notify && !this.closed) { try { this.send(TYPE.RESET, s.id); } catch {} }
    safeClose(s.endpoint);
  }
  sweep(now = Date.now()) {
    for (const s of this.streams.values()) if (now - s.lastActive > this.idleTimeout) this.drop(s, true, 'idle timeout');
  }
  ping() { try { this.send(TYPE.PING, 0); } catch { this.shutdown('send failed'); } }
  shutdown(reason = 'channel closed') {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.streams.values()) this.drop(s, false, reason);
    try { this.closeTransport(); } catch {}
  }
}
