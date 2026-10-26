import { Mux } from '../shared/mux.mjs';
import { parsePorts, validateTarget, publicHost } from '../shared/target.mjs';
export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
} });

export class TunnelController {
  constructor(state, env, { connect, fetchWebSocket }) {
    this.state = state; this.env = env; this.connect = connect; this.fetchWebSocket = fetchWebSocket;
    this.ws = null; this.mux = null; this.dialing = false; this.generation = 0;
    this.enabled = false; this.slot = null; this.lastError = null; this.connectedAt = null; this.failures = 0;
    this.nextAttempt = 0; this.stoppedBytes = { sent: 0, received: 0 };
    this.ready = state.storage.get('config').then(c => { if (c) { this.enabled = c.enabled; this.slot = c.slot; } });
  }
  async fetch(req) {
    await this.ready;
    const u = new URL(req.url), op = u.pathname;
    if (op === '/status') return json(this.status());
    if (op === '/start') {
      const slot = Number(u.searchParams.get('slot'));
      if (!Number.isInteger(slot) || slot < 0 || slot >= Number(this.env.CHANNELS || 1)) return json({ error: 'invalid slot' }, 400);
      this.enabled = true; this.slot = slot; this.nextAttempt = 0;
      await this.state.storage.put('config', { enabled: true, slot });
      await this.ensure(); return json(this.status());
    }
    if (op === '/stop') {
      this.enabled = false; this.generation++; this.disconnect();
      await this.state.storage.put('config', { enabled: false, slot: this.slot });
      await this.state.storage.deleteAlarm(); return json(this.status());
    }
    if (op === '/ensure') { await this.ensure(); return json(this.status()); }
    return json({ error: 'not found' }, 404);
  }
  status() {
    return { slot: this.slot, enabled: this.enabled, connected: !!this.mux && !this.mux.closed,
      connecting: this.dialing, activeStreams: this.mux?.streams.size || 0, maxStreams: 4,
      connectedAt: this.connectedAt, lastError: this.lastError, nextAttempt: this.nextAttempt,
      // Diagnostic counters only: reset after DO eviction/deployment; user accounting remains in 3x-ui.
      bytesToInternet: this.stoppedBytes.received + (this.mux?.bytesReceived || 0),
      bytesFromInternet: this.stoppedBytes.sent + (this.mux?.bytesSent || 0) };
  }
  disconnect() {
    const m = this.mux; this.mux = null; this.ws = null;
    if (m) { this.stoppedBytes.sent += m.bytesSent; this.stoppedBytes.received += m.bytesReceived; m.shutdown(); }
  }
  async ensure() {
    if (!this.enabled || this.dialing) return;
    if (this.mux && !this.mux.closed && Date.now() - this.mux.lastReceived < 60000) {
      this.mux.sweep(); this.mux.ping();
      await this.state.storage.setAlarm(Date.now() + 20000); return;
    }
    this.disconnect();
    if (Date.now() < this.nextAttempt) { await this.state.storage.setAlarm(this.nextAttempt); return; }
    this.dialing = true;
    const generation = this.generation;
    try {
      const url = new URL(this.env.IRAN_RELAY_URL);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/reverse' || !publicHost(url.hostname)) throw new Error('IRAN_RELAY_URL must be https://public-host/reverse');
      if (typeof this.env.TUNNEL_TOKEN !== 'string' || this.env.TUNNEL_TOKEN.length < 32) throw new Error('TUNNEL_TOKEN must be at least 32 characters');
      const ports = parsePorts(this.env.ALLOWED_PORTS);
      const ws = await this.fetchWebSocket(url.href, {
        headers: { Upgrade: 'websocket', 'x-tunnel-token': this.env.TUNNEL_TOKEN, 'x-cfr-version': '2', 'x-cfr-channel': String(this.slot) },
        redirect: 'manual', signal: AbortSignal.timeout(12000)
      });
      if (!this.enabled || generation !== this.generation) { ws.close(1000, 'stopped'); return; }
      ws.binaryType = 'arraybuffer'; ws.accept();
      this.ws = ws;
      const mux = new Mux({ send: bytes => ws.send(bytes), closeTransport: () => { try { ws.close(1000, 'channel closed'); } catch {} },
        connectTarget: target => this.openTarget(target, ports) });
      this.mux = mux;
      ws.addEventListener('message', ev => {
        if (this.mux !== mux) return;
        if (!(ev.data instanceof ArrayBuffer)) mux.shutdown('binary required'); else mux.receive(ev.data);
      });
      const closed = () => { if (this.mux === mux) { this.lastError = 'Channel disconnected; waiting for reconnect'; this.disconnect(); } };
      ws.addEventListener('close', closed); ws.addEventListener('error', closed);
      this.connectedAt = new Date().toISOString(); this.lastError = null; this.failures = 0; this.nextAttempt = 0;
      mux.ping();
    } catch (e) {
      this.lastError = String(e.message || e).slice(0, 160);
      this.failures++;
      this.nextAttempt = Date.now() + Math.min(60000, 2000 * 2 ** Math.min(this.failures, 5));
    } finally {
      this.dialing = false;
      if (this.enabled) await this.state.storage.setAlarm(Math.max(Date.now() + 20000, this.nextAttempt));
    }
  }
  async openTarget(target, ports) {
    const address = validateTarget(target, ports);
    const socket = this.connect(address, { secureTransport: 'off', allowHalfOpen: true });
    // Catch the closed promise immediately; failed connects must not cause unhandled rejections.
    socket.closed?.catch(() => {});
    let timer;
    try {
      await Promise.race([socket.opened, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TCP connect timeout')), 10000); })]);
      return { reader: socket.readable.getReader(), writer: socket.writable.getWriter(), close: () => socket.close() };
    } catch (e) { try { await socket.close(); } catch {} throw e; }
    finally { clearTimeout(timer); }
  }
  async alarm() { await this.ready; await this.ensure(); }
}
