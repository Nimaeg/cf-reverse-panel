import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { xrayFixture, UUID } from './native-xray-fixture.mjs';
import { NativeController } from '../native/controller.mjs';
import { deadline } from '../native/mux.mjs';
import { sleep } from './helpers.mjs';
const options={skip:!process.env.XRAY_BIN,timeout:45000};
for(const network of ['tcp','ws'])test(`real Xray: VLESS Reverse over ${network}+TLS, binary transfer, stop/reconnect`,options,async t=>{
  const f=await xrayFixture({network});t.after(()=>f.close());
  const response=await f.start(),status=await response.json();assert.equal(response.status,200,JSON.stringify(status)+' '+f.logs());assert.equal(status.connected,true);assert.equal(status.stage,'ready');
  assert.ok(!JSON.stringify(status).includes(UUID));assert.ok(!JSON.stringify([...f.state.data]).includes(UUID));
  const c=await f.client({early:Buffer.from('early-payload')});assert.equal((await deadline(c.ep.reader.exact(13),5000)).toString(),'early-payload');
  const data=randomBytes(8*1024*1024),digest=b=>createHash('sha256').update(b).digest('hex');
  const send=(async()=>{for(let at=0;at<data.length;at+=8192)await c.ep.writer.write(data.subarray(at,at+8192));})();
  const got=await deadline(c.ep.reader.exact(data.length),15000);await send;assert.equal(digest(got),digest(data));
  assert.equal(f.controller.status().bytesToInternet,data.length+13);
  await f.call('disconnect',{});assert.equal(f.controller.status().connected,false);assert.equal(f.controller.status().enabled,false);
  const closed=await deadline(c.ep.reader.read(),3000).catch(()=>({done:true}));assert.equal(closed.done,true);
  assert.equal((await (await f.call('reconnect',{})).json()).connected,true);
  const c2=await f.client({early:Buffer.from('again')});assert.equal((await deadline(c2.ep.reader.exact(5),3000)).toString(),'again');c2.s.destroy();
});
test('real Xray: ordinary VLESS UUID without reverse permission never reports connected',options,async t=>{
  const f=await xrayFixture();t.after(()=>f.close());const r=await f.call('connect',{config:f.normalLink,reverseTag:'iran-reverse'});const s=await r.json();assert.equal(r.status,502);assert.equal(s.connected,false);assert.equal(s.stage,'error');
});
test('real Xray: four active streams work, excess/private destinations fail closed',options,async t=>{
  const f=await xrayFixture();t.after(()=>f.close());await f.start();
  const clients=[];
  for(let i=0;i<4;i++){const c=await f.client({early:Buffer.from('live')});assert.equal((await deadline(c.ep.reader.exact(4),3000)).toString(),'live');clients.push(c);}
  assert.equal(f.controller.status().activeStreams,4);
  const fifth=await f.client({early:Buffer.from('denied')});await assert.rejects(deadline(fifth.ep.reader.exact(6),3000));assert.equal(f.controller.status().activeStreams,4);
  for(const c of clients)c.s.destroy();await sleep(100);
  const privateClient=await f.client({host:'127.0.0.1',early:Buffer.from('blocked')});await assert.rejects(deadline(privateClient.ep.reader.exact(7),3000));assert.equal(f.controller.status().activeStreams,0);assert.ok(f.controller.status().rejectedStreams>=2);
});
test('real Xray: encrypted saved configuration survives controller recreation',options,async t=>{
  const f=await xrayFixture();t.after(()=>f.close());await f.start();f.controller.cancel();
  const restored=new NativeController(f.state,f.env,f.deps);t.after(()=>restored.fetch(new Request('https://internal/disconnect',{method:'POST'})));
  await restored.alarm();assert.equal(restored.status().connected,true);assert.equal(restored.status().config.reverseTag,'iran-reverse');
  await restored.fetch(new Request('https://internal/forget',{method:'POST'}));assert.equal(f.state.data.has('native-config'),false);
});
