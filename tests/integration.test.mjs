import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { fixture, socksClient, sleep, TOKEN } from './helpers.mjs';

test('real loopback sockets: fragmented SOCKS handshake and coalesced early payload', {timeout:15000}, async t => {
  const f = await fixture(t); await f.start();
  for (const fragment of [true,false]) {
    const data = Buffer.from('hello from Iran through reverse channel');
    const c = await socksClient(f,{fragment,early:data}); t.after(() => c.s.destroy());
    assert.deepEqual([...c.auth],[5,0]); assert.equal(c.response[1],0);
    assert.deepEqual(await c.ep.reader.exact(data.length),data); c.s.destroy();
  }
});
test('8 MiB binary payload has identical SHA-256 after round trip', {timeout:20000}, async t => {
  const f = await fixture(t); await f.start(); const c = await socksClient(f); t.after(() => c.s.destroy());
  assert.equal(c.response[1],0);
  const data = randomBytes(8*1024*1024);
  const receive = c.ep.reader.exact(data.length);
  await c.ep.writer.write(data);
  const output = await receive;
  const hash = b => createHash('sha256').update(b).digest('hex'); assert.equal(hash(data),hash(output));
});
test('TCP half-close preserves a response sent only after client EOF', {timeout:15000}, async t => {
  const f = await fixture(t,{targetHandler:s=>{let body='';s.on('data',b=>body+=b);s.on('end',()=>s.end('AFTER-EOF:'+body));}});
  await f.start(); const c = await socksClient(f); t.after(()=>c.s.destroy());
  await c.ep.writer.write(Buffer.from('request')); await c.ep.writer.close();
  assert.equal((await c.ep.reader.exact(17)).toString(),'AFTER-EOF:request');
});
test('SOCKS fails closed without a connected Worker', {timeout:10000}, async t => {
  const f = await fixture(t); const c = await socksClient(f); t.after(()=>c.s.destroy()); assert.notEqual(c.response[1],0);
});
test('SOCKS UDP ASSOCIATE is explicitly rejected', {timeout:10000}, async t => {
  const f = await fixture(t); await f.start(); const c = await socksClient(f,{command:3}); t.after(()=>c.s.destroy()); assert.equal(c.response[1],7);
});
test('public destination policy rejects private IPv4 even on a connected channel', {timeout:10000}, async t => {
  const f = await fixture(t); await f.start(); const c = await socksClient(f,{host:'127.0.0.1'}); t.after(()=>c.s.destroy()); assert.notEqual(c.response[1],0);
});
test('two channels distribute eight active streams and reject the ninth', {timeout:15000}, async t => {
  const f = await fixture(t,{channels:2}); await f.start(); const clients=[]; t.after(()=>clients.forEach(c=>c.s.destroy()));
  for(let i=0;i<8;i++){const c=await socksClient(f);clients.push(c);assert.equal(c.response[1],0);}
  assert.deepEqual(f.controllers.map(c=>c.mux.streams.size),[4,4]);
  const extra=await socksClient(f);clients.push(extra);assert.notEqual(extra.response[1],0);
});
test('stop severs active streams, start restores new streams', {timeout:15000}, async t => {
  const f=await fixture(t);await f.start();const c=await socksClient(f);t.after(()=>c.s.destroy());
  await f.controllers[0].fetch(new Request('https://internal/stop',{method:'POST'}));
  await sleep(40);assert.equal(f.agent.links.size,0);
  assert.equal((await c.ep.reader.read()).done,true);
  await f.start();const d=await socksClient(f);t.after(()=>d.s.destroy());assert.equal(d.response[1],0);
});
test('relay rejects wrong secret and duplicate channel without taking over live channel', {timeout:15000}, async t => {
  const f=await fixture(t);await f.start();
  async function rejected(token){return new Promise((resolve,reject)=>{
    const w=new WebSocket(`ws://127.0.0.1:${f.addresses.httpPort}/reverse`,{headers:{'x-tunnel-token':token,'x-cfr-version':'2','x-cfr-channel':'0'}});
    w.on('error',()=>{});w.on('unexpected-response',(_,res)=>{res.resume();resolve(res.statusCode);w.terminate();});w.on('open',()=>{w.terminate();reject(new Error('unexpected upgrade'));});
  });}
  assert.equal(await rejected('bad'),401);assert.equal(await rejected(TOKEN),409);assert.equal(f.agent.links.size,1);
});
