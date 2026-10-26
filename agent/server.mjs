import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Mux, CHUNK } from '../shared/mux.mjs';
import { nodeEndpoint, socksHandshake, socksReply } from './io.mjs';

export function createAgent({ token, httpPort = 8765, socksPort = 10808, channels = 1, maxStreams = 4,
  handshakeTimeout = 15000, heartbeatMs = 10000, staleMs = 45000, idleTimeout = 300000 } = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('TUNNEL_TOKEN must be at least 32 characters');
  if (!Number.isInteger(channels) || channels < 1 || channels > 8 || maxStreams !== 4) throw new Error('channels must be 1..8; streams per channel is 4');
  const links = new Map(), clients = new Set();
  const expected = Buffer.from(token);
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ version: '0.2.0', connectedChannels: links.size, activeStreams: [...links.values()].reduce((n,l) => n + l.mux.streams.size, 0) }));
    } else res.writeHead(404).end();
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: CHUNK + 5, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const supplied = Buffer.from(typeof req.headers['x-tunnel-token'] === 'string' ? req.headers['x-tunnel-token'] : '');
    const idText = req.headers['x-cfr-channel'];
    const id = Number(idText);
    let status = 0;
    if (req.url !== '/reverse' || req.headers['x-cfr-version'] !== '2') status = 400;
    else if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) status = 401;
    else if (typeof idText !== 'string' || !/^[0-7]$/.test(idText) || id >= channels) status = 400;
    else if (links.has(id)) status = 409;
    if (status) { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const mux = new Mux({ maxStreams, idleTimeout, send: bytes => {
        if (ws.readyState !== 1 || ws.bufferedAmount > 2 * 1024 * 1024) throw new Error('channel congested');
        ws.send(bytes, { binary: true });
      }, closeTransport: () => ws.terminate() });
      const link = { ws, mux };
      links.set(id, link);
      ws.on('message', (data, binary) => binary ? mux.receive(data) : mux.shutdown('binary protocol required'));
      const cleanup = () => { mux.shutdown(); if (links.get(id) === link) links.delete(id); };
      ws.on('close', cleanup); ws.on('error', cleanup);
      mux.ping();
    });
  });
  const socks = net.createServer({ allowHalfOpen: true, highWaterMark: CHUNK }, socket => {
    if (clients.size >= 256) { socket.destroy(); return; }
    clients.add(socket); socket.setNoDelay(true);
    socket.on('error', () => {});
    const endpoint = nodeEndpoint(socket);
    let selected, streamId, ready = false;
    socket.on('close', () => {
      clients.delete(socket);
      // streamId is assigned after the success reply; pending open is cleaned by timeout/channel close.
      if (selected && streamId) selected.drop(selected.streams.get(streamId), true);
    });
    const timer = setTimeout(() => socket.destroy(), handshakeTimeout);
    (async () => {
      const target = await socksHandshake(endpoint);
      const candidates = [...links.values()].map(l => l.mux).filter(m => !m.closed && m.streams.size < maxStreams);
      candidates.sort((a,b) => a.streams.size - b.streams.size);
      selected = candidates[0];
      if (!selected) throw new Error('no tunnel capacity');
      streamId = await selected.open(target, { ...endpoint, close: () => { if (ready) socket.destroy(); } }, async () => {
        await endpoint.writer.write(socksReply(0)); ready = true; clearTimeout(timer);
      });
      if (socket.destroyed) selected.drop(selected.streams.get(streamId), true);
    })().catch(async error => {
      if (!ready && !socket.destroyed) {
        try { await endpoint.writer.write(socksReply(error.socksCode || 1)); socket.end(); } catch { socket.destroy(); }
      } else socket.destroy();
    }).finally(() => clearTimeout(timer));
  });
  const heartbeat = setInterval(() => {
    for (const { mux } of links.values()) {
      if (Date.now() - mux.lastReceived > staleMs) mux.shutdown('heartbeat timeout');
      else { mux.sweep(); mux.ping(); }
    }
  }, heartbeatMs);
  heartbeat.unref();
  return {
    links, server, socks,
    async start() {
      // Loopback binding is intentional and cannot be changed by an environment variable.
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(httpPort, '127.0.0.1', resolve); });
      try { await new Promise((resolve, reject) => { socks.once('error', reject); socks.listen(socksPort, '127.0.0.1', resolve); }); }
      catch (e) { await this.close(); throw e; }
      return { httpPort: server.address().port, socksPort: socks.address().port };
    },
    async close() {
      clearInterval(heartbeat);
      for (const l of links.values()) l.mux.shutdown();
      for (const s of clients) s.destroy();
      server.closeAllConnections();
      await Promise.all([new Promise(r => server.close(r)), new Promise(r => socks.close(r)), new Promise(r => wss.close(r))]);
    }
  };
}
