// Socket iterator preserves TCP fragmentation, coalesced handshakes and early payload.
export function nodeEndpoint(socket) {
  const iterator = socket[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  const reader = {
    async exact(n) {
      while (pending.length < n) {
        const { done, value } = await iterator.next();
        if (done) throw new Error('unexpected EOF');
        pending = Buffer.concat([pending, value]);
      }
      const result = pending.subarray(0, n); pending = pending.subarray(n); return result;
    },
    async read() {
      if (pending.length) { const value = pending; pending = Buffer.alloc(0); return { done: false, value }; }
      return iterator.next();
    }
  };
  const writer = {
    write(data) { return new Promise((resolve, reject) => socket.write(data, e => e ? reject(e) : resolve())); },
    close() { return new Promise((resolve, reject) => socket.end(e => e ? reject(e) : resolve())); }
  };
  return { reader, writer, close: () => socket.destroy() };
}
export async function socksHandshake(endpoint) {
  const r = endpoint.reader, w = endpoint.writer;
  const head = await r.exact(2);
  if (head[0] !== 5 || !head[1]) throw new Error('invalid SOCKS version');
  const methods = await r.exact(head[1]);
  if (!methods.includes(0)) { await w.write(Buffer.from([5,255])); throw new Error('auth method unsupported'); }
  await w.write(Buffer.from([5,0]));
  const req = await r.exact(4);
  if (req[0] !== 5 || req[2] !== 0) throw new Error('invalid SOCKS request');
  if (req[1] !== 1) { const e = new Error('TCP CONNECT only'); e.socksCode = 7; throw e; }
  let host;
  if (req[3] === 1) host = [...await r.exact(4)].join('.');
  else if (req[3] === 3) {
    const size = (await r.exact(1))[0];
    if (!size) throw new Error('empty hostname');
    host = new TextDecoder('utf-8', { fatal: true }).decode(await r.exact(size));
  } else { const e = new Error('address type unsupported'); e.socksCode = 8; throw e; }
  const port = (await r.exact(2)).readUInt16BE();
  return { host, port };
}
export const socksReply = code => Buffer.from([5,code,0,1,0,0,0,0,0,0]);
