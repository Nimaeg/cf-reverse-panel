import { createAgent } from './server.mjs';
const agent = createAgent({ token: process.env.TUNNEL_TOKEN, httpPort: Number(process.env.HTTP_PORT || 8765),
  socksPort: Number(process.env.SOCKS_PORT || 10808), channels: Number(process.env.CHANNELS || 1) });
const address = await agent.start();
console.log(`CF Reverse v0.2.0 | relay 127.0.0.1:${address.httpPort} | SOCKS 127.0.0.1:${address.socksPort}`);
console.log('Waiting for Cloudflare-initiated connections. No outbound Worker dialer exists in this agent.');
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await agent.close(); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
