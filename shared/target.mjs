// Validate syntax and reject non-public IPv4 literals. Runtime also blocks private DNS results.
// IPv6 is deliberately unsupported in this release; there is no NAT64/ProxyIP workaround.
export function publicHost(host) {
  if (typeof host !== 'string' || host.length < 3 || host.length > 253) return false;
  const h = host.toLowerCase();
  if (h.includes(':') || h.endsWith('.') || /(?:^|\.)(?:localhost|local|internal|lan|onion|test|invalid)$/.test(h)) return false;
  if (/^[0-9.]+$/.test(h)) {
    const parts = h.split('.');
    if (parts.length !== 4 || parts.some(p => !/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255)) return false;
    const [a,b,c] = parts.map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  const labels = h.split('.');
  return labels.length >= 2 && /^[a-z][a-z0-9-]*$/.test(labels.at(-1)) &&
    labels.every(l => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}
export function validateTarget(target, ports) {
  if (!target || !publicHost(target.host) || !Number.isInteger(target.port) || !ports.includes(target.port)) throw new Error('destination denied');
  return { hostname: target.host, port: target.port };
}
export function parsePorts(value = '80,443') {
  const ports = value.split(',').map(s => Number(s.trim()));
  if (!ports.length || ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535 || p === 25)) throw new Error('invalid ALLOWED_PORTS');
  return [...new Set(ports)];
}
