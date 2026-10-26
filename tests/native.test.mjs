import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, seal, unseal } from '../native/config.mjs';
import { NativeController } from '../native/controller.mjs';
import { NativeReverse, frame, deadline } from '../native/mux.mjs';
import { handleRequest } from '../worker/router.mjs';
import { TOKEN, sleep } from './helpers.mjs';
const UUID='1c82551a-d494-4b89-bf2a-a1c8f1d0e9a6';
const LINK=`vless://${UUID}@iran.example.com:443?security=tls&type=ws&path=%2Freverse`;
const memory=()=>{const data=new Map();return{data,storage:{get:async k=>data.get(k),put:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k),setAlarm:async t=>data.set('alarm',t),deleteAlarm:async()=>data.delete('alarm')}};};
test('config import accepts link and Xray JSON; rejects unsupported or unsafe transports',()=>{
  assert.equal(parseConfig(LINK,'iran-reverse').network,'ws');
  const json={outbounds:[{protocol:'vless',settings:{vnext:[{address:'iran.example.com',port:443,users:[{id:UUID,encryption:'none'}]}]},streamSettings:{network:'raw',security:'tls'}}]};
  assert.equal(parseConfig(JSON.stringify(json),'iran-reverse').network,'tcp');
  for(const input of [LINK.replace('tls','reality'),LINK+'&flow=xtls-rprx-vision',LINK.replace('type=ws','type=grpc'),LINK.replace('type=ws','type=xhttp'),LINK+'&encryption=mlkem768x25519plus',LINK+'&allowInsecure=1',LINK+'&sni=other.example.com',LINK.replace('iran.example.com','127.0.0.1'),LINK+'&ed=2048',LINK+'&security=tls',LINK+'&host=x%0d%0aInjected:yes',LINK+'&ech=abc',LINK.replace(UUID,'%ff')])assert.throws(()=>parseConfig(input,'iran-reverse'),undefined,input);
  assert.throws(()=>parseConfig(LINK,'<script>'));assert.throws(()=>parseConfig(JSON.stringify({outbounds:{}}),'tag'));
});
test('stored config is authenticated encryption and cannot be opened with another admin key',async()=>{
  const c=parseConfig(LINK,'tag'),record=await seal(c,TOKEN);assert.ok(!JSON.stringify(record).includes(UUID));assert.deepEqual(await unseal(record,TOKEN),c);
  await assert.rejects(unseal(record,TOKEN+'changed'));record.data[0]^=1;await assert.rejects(unseal(record,TOKEN));
});
test('native endpoints enforce authentication, same origin, request size, method and redact UUID',async()=>{
  const controller=new NativeController(memory(),{ADMIN_TOKEN:TOKEN},{connect:()=>{throw new Error('unused');}});
  const env={ADMIN_TOKEN:TOKEN,NATIVE_REVERSE:{idFromName:n=>n,get:()=>({fetch:r=>controller.fetch(r)})}};
  const req=(path,options={})=>new Request('https://panel.example.com/api/reverse/'+path,options);
  assert.equal((await handleRequest(req('status'),env)).status,401);
  const headers={authorization:'Bearer '+TOKEN,'content-type':'application/json'};
  assert.equal((await handleRequest(req('status',{headers:{...headers,origin:'https://wrong.example.com'}}),env)).status,403);
  assert.equal((await handleRequest(req('connect',{headers}),env)).status,405);
  assert.equal((await handleRequest(req('connect',{headers,method:'POST',body:'x'.repeat(70001)}),env)).status,413);
  assert.equal((await handleRequest(req('connect',{headers,method:'POST',body:JSON.stringify({config:LINK.replace('tls','reality'),reverseTag:'tag'})}),env)).status,400);
  assert.equal((await handleRequest(req('connect',{headers,method:'POST',body:'null'}),env)).status,400);
  const s=await handleRequest(req('status',{headers}),env);assert.equal(s.status,200);assert.ok(!(await s.text()).includes(UUID));
});
test('stop during TLS dial prevents a late connection from resurrecting',async()=>{
  let resolveOpen,closed=0,writes=0;
  const opened=new Promise(r=>{resolveOpen=r;});
  const controller=new NativeController(memory(),{ADMIN_TOKEN:TOKEN,ALLOWED_PORTS:'80,443'},{connect:()=>({opened,closed:Promise.resolve(),readable:{getReader:()=>({read:async()=>({done:true})})},writable:{getWriter:()=>({write:async()=>{writes++;}})},close:()=>{closed++;}})});
  const pending=controller.fetch(new Request('https://internal/connect',{method:'POST',body:JSON.stringify({config:LINK,reverseTag:'tag'})}));
  for(let i=0;i<100&&!controller.transport;i++)await sleep(2);
  await controller.fetch(new Request('https://internal/disconnect',{method:'POST'}));resolveOpen();await pending;
  assert.equal(controller.status().enabled,false);assert.equal(controller.status().stage,'stopped');assert.equal(writes,0);assert.ok(closed>0);
});
function controlFrame(id,data){const name=new TextEncoder().encode('reverse'),meta=new Uint8Array(9+name.length);meta.set([id>>8,id&255,1,1,2,0,0,2,name.length]);meta.set(name,9);const out=new Uint8Array(2+meta.length+2+data.length),v=new DataView(out.buffer);v.setUint16(0,meta.length);out.set(meta,2);v.setUint16(2+meta.length,data.length);out.set(data,4+meta.length);return out;}
test('fragmented native handshake needs valid control, then drain retires the channel',async()=>{
  let enqueue;const readable=new ReadableStream({start(c){enqueue=c;}}),writes=[];
  const ep={reader:readable.getReader(),writer:{write:async b=>writes.push(b)},close:()=>{try{enqueue.close();}catch{}}};
  const m=new NativeReverse(ep,{uuid:UUID,connectTarget:async()=>{throw new Error('unused');}});const ready=m.start();
  enqueue.enqueue(new Uint8Array([0]));enqueue.enqueue(new Uint8Array([0]));await sleep(1);assert.equal(m.connected,false);
  const ctl=controlFrame(1,new Uint8Array([0x9a,0x06,1,123]));for(const b of ctl)enqueue.enqueue(new Uint8Array([b]));
  await deadline(ready,1000);assert.equal(m.connected,true);assert.equal(writes[0][18],4);
  enqueue.enqueue(frame(1,2,new Uint8Array([8,1])));await m.done;assert.equal(m.closed,true);
});
test('malformed mux length cannot mark a native connection ready',async()=>{
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array([0,0,255,255]));c.close();}});
  const m=new NativeReverse({reader:stream.getReader(),writer:{write:async()=>{}},close:()=>{}},{uuid:UUID,connectTarget:async()=>{}});
  await assert.rejects(m.start(),/metadata limit/);assert.equal(m.connected,false);assert.equal(m.closed,true);
});
