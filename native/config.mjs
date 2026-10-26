import { publicHost } from '../shared/target.mjs';
export class ConfigError extends Error {}
const fail = message => { throw new ConfigError(message); };
export function parseConfig(input, reverseTag) {
  if (typeof input !== 'string' || !input.trim() || input.length > 65536) fail('یک لینک VLESS یا JSON خروجی Xray وارد کن.');
  if (typeof reverseTag !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(reverseTag)) fail('Reverse Tag باید ۱ تا ۶۴ حرف انگلیسی، عدد، نقطه، خط تیره یا زیرخط باشد.');
  let c;
  if (input.trim().startsWith('vless://')) {
    let u; try { u = new URL(input.trim()); } catch { fail('ساختار لینک VLESS معتبر نیست.'); }
    if (u.password) fail('لینک VLESS نباید بخش password داشته باشد.');
    const p = u.searchParams;
    for (const key of new Set(p.keys())) if (p.getAll(key).length > 1) fail('پارامتر تکراری در لینک قابل پذیرش نیست.');
    let uuid;try{uuid=decodeURIComponent(u.username);}catch{fail('شناسهٔ لینک معتبر نیست.');}
    c = { address: u.hostname.toLowerCase(), port: Number(u.port || 443), uuid,
      network: p.get('type') || 'tcp', security: p.get('security') || 'none', encryption: p.get('encryption') || 'none',
      flow: p.get('flow') || '', sni: p.get('sni') || p.get('serverName') || '', host: p.get('host') || '', path: p.get('path') || '/',
      insecure: p.get('allowInsecure') || p.get('insecure'), headerType: p.get('headerType') || 'none',
      earlyData: p.get('ed'), alpn: p.get('alpn') || '', fingerprint: p.get('fp') || '' };
    if (p.has('ech') || p.has('echConfig')) fail('ECH در این نسخه پشتیبانی نمی‌شود.');
  } else {
    let value; try { value = JSON.parse(input); } catch { fail('JSON معتبر نیست؛ لینک vless:// هم پذیرفته می‌شود.'); }
    if (!value || typeof value !== 'object') fail('JSON باید یک outbound باشد.');
    if(value.outbounds&&!Array.isArray(value.outbounds))fail('outbounds باید آرایه باشد.');
    const candidates = value.outbounds?.filter(x => x?.protocol === 'vless');
    if (candidates && candidates.length !== 1) fail('JSON باید دقیقاً یک خروجی VLESS داشته باشد.');
    const o = candidates ? candidates[0] : value;
    if (o.protocol !== 'vless') fail('فقط لینک VLESS یا JSON خروجی VLESS پشتیبانی می‌شود؛ JSON inbound آدرس اتصال را مشخص نمی‌کند.');
    const s = o.settings || {}, v = s.vnext?.[0], user = v?.users?.[0] || s;
    if ((s.vnext && s.vnext.length !== 1) || (v?.users && v.users.length !== 1)) fail('فقط یک سرور و یک UUID در هر کانفیگ مجاز است.');
    const st = o.streamSettings || {}, tls = st.tlsSettings || {}, ws = st.wsSettings || {};
    if (o.proxySettings || o.sendThrough || st.sockopt || st.finalmask || st.finalMask) fail('گزینه‌های اتصال زنجیره‌ای و sockopt/finalmask در این نسخه پشتیبانی نمی‌شوند.');
    if (tls.echConfigList || tls.echServerKeys || tls.echForceQuery || tls.pinnedPeerCertificateChainSha256 || tls.certificates?.length) fail('تنظیمات TLS سفارشی این JSON پشتیبانی نمی‌شود.');
    const headers = ws.headers || {};
    if (Object.keys(headers).some(k => k.toLowerCase() !== 'host')) fail('فقط هدر Host برای WebSocket قابل وارد کردن است.');
    c = { address: v?.address || s.address, port: v?.port || s.port, uuid: user.id, network: st.network || 'tcp',
      security: st.security || 'none', encryption: user.encryption || 'none', flow: user.flow || '', sni: tls.serverName || '',
      host: ws.host || headers.Host || headers.host || '', path: ws.path || '/', insecure: tls.allowInsecure,
      headerType: st.tcpSettings?.header?.type || st.rawSettings?.header?.type || 'none', earlyData: ws.maxEarlyData,
      alpn: Array.isArray(tls.alpn) ? tls.alpn.join(',') : '', fingerprint: tls.fingerprint || '' };
  }
  if (!['tcp','raw','ws'].includes(c.network)) fail('این نسخه فقط VLESS روی TCP/RAW یا WebSocket را می‌پذیرد؛ gRPC و XHTTP پشتیبانی نمی‌شوند.');
  if (c.security !== 'tls') fail('برای این پنل کانفیگ TLS معتبر لازم است؛ REALITY و اتصال بدون TLS پشتیبانی نمی‌شوند.');
  if (c.encryption !== 'none' || c.flow) fail('برای این نسخه encryption=none و Flow خالی لازم است؛ Vision و VLESS Encryption پشتیبانی نمی‌شوند.');
  if (c.insecure && !['0','false'].includes(String(c.insecure))) fail('اعتبارسنجی گواهی TLS نباید غیرفعال شود.');
  if (c.headerType !== 'none' || Number(c.earlyData || 0) !== 0) fail('HTTP header disguise و WebSocket early data در این نسخه پشتیبانی نمی‌شوند.');
  if (c.alpn && c.alpn !== 'http/1.1') fail('ALPN سفارشی پشتیبانی نمی‌شود؛ ALPN را خالی بگذار یا http/1.1 انتخاب کن.');
  if (typeof c.address !== 'string' || !publicHost(c.address)) fail('آدرس عمومی IPv4 یا دامنهٔ معتبر برای سرور ایران لازم است.');
  c.address = c.address.toLowerCase();
  if (c.sni && c.sni.toLowerCase() !== c.address) fail('در این نسخه آدرس سرور و SNI باید یکسان باشند؛ از دامنهٔ DNS-only همان سرور در هر دو استفاده کن.');
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535 || c.port === 25) fail('پورت سرور معتبر نیست.');
  if (typeof c.uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.uuid)) fail('UUID معتبر لازم است؛ شناسه‌های متنی سفارشی را ابتدا به UUID تبدیل کن.');
  if (typeof c.path !== 'string' || !c.path.startsWith('/') || c.path.startsWith('//') || c.path.length > 2048 || /[^\x21-\x7e]|#/.test(c.path)) fail('مسیر WebSocket معتبر نیست؛ مسیر باید URL-encoded باشد.');
  if (new URL('https://placeholder.invalid'+c.path).searchParams.has('ed')) fail('پارامتر ed در مسیر WebSocket پشتیبانی نمی‌شود.');
  if (c.host && (typeof c.host !== 'string' || !/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/.test(c.host))) fail('هدر Host معتبر نیست.');
  return { version: 1, protocol: 'vless', address: c.address, port: c.port, uuid: c.uuid.toLowerCase(),
    network: c.network === 'raw' ? 'tcp' : c.network, security: 'tls', path: c.path,
    host: c.host || (c.address + (c.port === 443 ? '' : ':'+c.port)), reverseTag,
    warnings: c.fingerprint ? ['اثر انگشت سفارشی TLS اعمال نمی‌شود؛ TLS استاندارد Worker استفاده می‌شود.'] : [] };
}
export function summary(c) {
  if (!c) return null;
  return { address: c.address, port: c.port, network: c.network, reverseTag: c.reverseTag, warnings: c.warnings || [] };
}
async function key(secret) {
  if (!secret || secret.length < 32) throw new Error('ADMIN_TOKEN is required');
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', new TextEncoder().encode('CFR3/config/'+secret)), 'AES-GCM', false, ['encrypt','decrypt']);
}
export async function seal(config, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(secret),new TextEncoder().encode(JSON.stringify(config)));
  return { iv: [...iv], data: [...new Uint8Array(data)] };
}
export async function unseal(record, secret) {
  const plain = await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(record.iv)},await key(secret),new Uint8Array(record.data));
  return JSON.parse(new TextDecoder().decode(plain));
}
