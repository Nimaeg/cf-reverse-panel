import net from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createAgent } from '../agent/server.mjs';
import { nodeEndpoint } from '../agent/io.mjs';
import { TunnelController } from '../worker/controller.mjs';
export const TOKEN = 'test-only-token-0123456789-abcdefghijklmnopqrstuvwxyz';
export const sleep = ms => new Promise(r => setTimeout(r,ms));
export function memoryState() {
  const data = new Map();
  return { data, storage: { get: async k => data.get(k), put: async (k,v) => data.set(k,v), setAlarm: async t => data.set('alarm',t), deleteAlarm: async () => data.delete('alarm') } };
}
export async function fixture(t, { targetHandler, channels = 1 } = {}) {
  const sockets = new Set();
  const target = net.createServer({ allowHalfOpen: true }, s => {
    sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {});
    if (targetHandler) targetHandler(s); else { s.on('data', b => s.write(b)); s.on('end', () => s.end()); }
  });
  target.listen(0,'127.0.0.1'); await once(target,'listening');
  const agent = createAgent({ token: TOKEN, httpPort: 0, socksPort: 0, channels, heartbeatMs: 1000 });
  const addresses = await agent.start();
  const env = { IRAN_RELAY_URL: 'https://relay.example.com/reverse', TUNNEL_TOKEN: TOKEN, ALLOWED_PORTS: String(target.address().port), CHANNELS: String(channels) };
  const controllers = [];
  const deps = {
    async fetchWebSocket(url, opts) {
      const ws = new WebSocket(`ws://127.0.0.1:${addresses.httpPort}/reverse`, { headers: opts.headers });
      await once(ws,'open'); ws.accept = () => {}; return ws;
    },
    connect(address, options) {
      // Only the provider adapter is simulated: a public test hostname maps to our local TCP target.
      const s = net.connect({ host: '127.0.0.1', port: address.port, allowHalfOpen: options.allowHalfOpen });
      s.on('error', () => {}); const ep = nodeEndpoint(s);
      return { opened: once(s,'connect'), closed: new Promise(r => s.once('close', r)),
        readable: { getReader: () => ep.reader }, writable: { getWriter: () => ep.writer }, close: () => s.destroy() };
    }
  };
  for (let i = 0; i < channels; i++) controllers.push(new TunnelController(memoryState(),env,deps));
  t.after(async () => {
    for (const c of controllers) await c.fetch(new Request('https://internal/stop', { method: 'POST' }));
    await agent.close(); for (const s of sockets) s.destroy();
    await new Promise(r => target.close(r));
  });
  return { agent, addresses, controllers, port: target.address().port,
    start: async () => { for (let i = 0; i < channels; i++) await controllers[i].fetch(new Request(`https://internal/start?slot=${i}`,{method:'POST'})); }
  };
}
export function requestBytes(host, port, cmd = 1) {
  const name = Buffer.from(host), req = Buffer.alloc(7+name.length);
  req.set([5,cmd,0,3,name.length]); name.copy(req,5); req.writeUInt16BE(port,5+name.length); return req;
}
export async function socksClient(f, { host = 'echo.example.com', early = Buffer.alloc(0), fragment = false, command = 1 } = {}) {
  const s = net.connect({ host:'127.0.0.1',port:f.addresses.socksPort,allowHalfOpen:true });
  s.on('error', () => {}); await once(s,'connect'); const ep = nodeEndpoint(s);
  const bytes = Buffer.concat([Buffer.from([5,1,0]),requestBytes(host,f.port,command),early]);
  if (fragment) for (const b of bytes) { await ep.writer.write(Buffer.from([b])); await sleep(1); }
  else await ep.writer.write(bytes);
  const auth = await ep.reader.exact(2), response = await ep.reader.exact(10);
  return { s, ep, auth, response };
}
