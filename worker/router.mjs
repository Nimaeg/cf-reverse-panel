import { json } from './controller.mjs';
import { HTML, CSS, SCRIPT } from './ui.mjs';
import { HTML as OLD_HTML, CSS as OLD_CSS, SCRIPT as OLD_SCRIPT } from './legacy-ui.mjs';
const security = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
async function authorized(req, token) {
  if (typeof token !== 'string' || token.length < 32) return false;
  const supplied = req.headers.get('authorization') || '';
  const encode = s => new TextEncoder().encode(s);
  const [a,b] = await Promise.all([crypto.subtle.digest('SHA-256', encode(supplied)), crypto.subtle.digest('SHA-256', encode(`Bearer ${token}`))]);
  const aa = new Uint8Array(a), bb = new Uint8Array(b); let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa[i] ^ bb[i];
  return difference === 0;
}
export function channelCount(env) {
  const n = Number(env.CHANNELS || 1);
  if (!Number.isInteger(n) || n < 1 || n > 8) throw new Error('CHANNELS must be 1..8');
  return n;
}
function stub(env, id) { return env.TUNNEL.get(env.TUNNEL.idFromName(`channel-${id}`)); }
export async function handleRequest(req, env) {
  const u = new URL(req.url);
  const assets = { '/': [HTML, 'text/html'], '/style.css': [CSS, 'text/css'], '/app.js': [SCRIPT, 'application/javascript'],
    '/legacy': [OLD_HTML.replace('/style.css','/legacy.css').replace('/app.js','/legacy.js'), 'text/html'],
    '/legacy.css': [OLD_CSS,'text/css'], '/legacy.js': [OLD_SCRIPT,'application/javascript'] };
  if (req.method === 'GET' && Object.hasOwn(assets, u.pathname)) {
    const [body, type] = assets[u.pathname]; return new Response(body, { headers: { ...security, 'content-type': `${type}; charset=utf-8` } });
  }
  if (!u.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
  if (!await authorized(req, env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401);
  if (req.headers.has('origin') && req.headers.get('origin') !== u.origin) return json({ error: 'origin denied' }, 403);
  try {
    const native = /^\/api\/reverse\/(status|connect|disconnect|reconnect|forget)$/.exec(u.pathname);
    if(native){
      const op=native[1];
      if(req.method!==(op==='status'?'GET':'POST'))return json({error:'method not allowed'},405);
      let body;
      if(op==='connect'){
        if(!req.headers.get('content-type')?.startsWith('application/json'))return json({error:'JSON required'},415);
        // Count actual bytes; Content-Length can be omitted or forged.
        const reader=req.body?.getReader(), chunks=[];let size=0;
        if(!reader)return json({error:'body required'},400);
        for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>70000){await reader.cancel();return json({error:'کانفیگ بیش از حد بزرگ است.'},413);}chunks.push(r.value);}
        const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}body=bytes;
      }
      const instance=env.NATIVE_REVERSE.get(env.NATIVE_REVERSE.idFromName('native-reverse'));
      return instance.fetch(new Request(`https://internal/${op}`,{method:req.method,body,headers:body?{'content-type':'application/json'}:undefined}));
    }
    const count = channelCount(env);
    if (u.pathname === '/api/status' && req.method === 'GET') {
      const channels = [];
      // Sequential calls avoid a shared top-level connection burst across service bindings.
      for (let i = 0; i < count; i++) {
        try { const res = await stub(env,i).fetch('https://internal/status'); channels.push({ ...await res.json(), slot: i }); }
        catch { channels.push({ slot: i, connected: false, lastError: 'Channel status unavailable' }); }
      }
      return json({ version: '0.2.0', iranRelayUrl: env.IRAN_RELAY_URL, channels, allowedPorts: env.ALLOWED_PORTS || '80,443' });
    }
    const match = /^\/api\/channels\/([0-7])\/(start|stop)$/.exec(u.pathname);
    if (match && req.method === 'POST' && Number(match[1]) < count) {
      return stub(env,Number(match[1])).fetch(new Request(`https://internal/${match[2]}?slot=${match[1]}`, { method: 'POST' }));
    }
    return json({ error: 'route or method not supported' }, 404);
  } catch { return json({ error: 'configuration or runtime error' }, 503); }
}
export async function scheduled(event, env, ctx) {
  // Cron is recovery only. Each enabled DO additionally has its own 20-second alarm.
  ctx.waitUntil((async () => {
    if(env.NATIVE_REVERSE)try{const res=await env.NATIVE_REVERSE.get(env.NATIVE_REVERSE.idFromName('native-reverse')).fetch('https://internal/ensure');await res.body?.cancel();}catch{}
    for (let i = 0; i < channelCount(env); i++) {
      try { const res = await stub(env,i).fetch('https://internal/ensure'); await res.body?.cancel(); } catch {}
    }
  })());
}
