import test from 'node:test';
import assert from 'node:assert/strict';
import { Mux, TYPE, WINDOW, CHUNK, frame } from '../shared/mux.mjs';
import { publicHost, validateTarget, parsePorts } from '../shared/target.mjs';
import { sleep, memoryState, TOKEN } from './helpers.mjs';
import { TunnelController } from '../worker/controller.mjs';
import { handleRequest } from '../worker/router.mjs';

test('target parser rejects reserved, octal, malformed and IPv6 hosts',()=>{
  for(const h of ['127.0.0.1','10.0.0.1','100.64.0.1','169.254.169.254','192.168.1.1','198.18.0.1','192.0.2.1','203.0.113.1','224.0.0.1','0177.0.0.1','2130706433','0x7f000001','127.1','a.local','a.internal','a.onion','a.invalid','localhost','::1','[::1]','a.com/xx','a.com.'])assert.equal(publicHost(h),false,h);
  for(const h of ['8.8.8.8','www.google.com','checkip.amazonaws.com'])assert.equal(publicHost(h),true,h);
  assert.throws(()=>validateTarget({host:'google.com',port:22},[443]));assert.throws(()=>parsePorts('443,25'));assert.deepEqual(parsePorts('80,443'),[80,443]);
});
test('backpressure bounds unacknowledged bytes to WINDOW and resumes without loss', {timeout:15000},async()=>{
  let a,b,release;let writes=0;const transmitted=[];
  const gate=new Promise(r=>release=r);
  const reader=new ReadableStream({start(c){c.enqueue(new Uint8Array(WINDOW*3).fill(21));c.close();}}).getReader();
  const sink={reader:new ReadableStream().getReader(),writer:{async write(bytes){await gate;writes+=bytes.length;},async close(){}},close(){}};
  a=new Mux({send:bytes=>{transmitted.push(bytes);queueMicrotask(()=>b.receive(bytes));}});
  b=new Mux({send:bytes=>queueMicrotask(()=>a.receive(bytes)),connectTarget:async()=>sink});
  try{
    await a.open({host:'example.com',port:443},{reader,writer:{async write(){},async close(){}},close(){}});
    await sleep(30);assert.equal(a.bytesSent,WINDOW);assert.equal(writes,0);assert.equal(a.closed,false);
    release();await sleep(60);assert.equal(writes,WINDOW*3);assert.equal(a.bytesSent,WINDOW*3);
    assert.ok(transmitted.filter(b=>b[0]===TYPE.DATA).every(b=>b.length<=CHUNK+5));
  }finally{release();a.shutdown();b.shutdown();}
});
test('pending connects count toward capacity; late successful sockets are closed',async()=>{
  let resolve;let closed=0;const sent=[];
  const m=new Mux({maxStreams:1,send:b=>sent.push(b),connectTarget:()=>new Promise(r=>resolve=r)});
  const open=id=>frame(TYPE.OPEN,id,new TextEncoder().encode('{"host":"google.com","port":443}'));
  m.receive(open(1));m.receive(open(2));await sleep(1);assert.equal(m.streams.size,1);assert.equal(sent[0][0],TYPE.ERROR);
  m.shutdown();resolve({close(){closed++;}});await sleep(1);assert.equal(closed,1);
});
test('malformed credit and oversized frames close the channel',()=>{
  const m=new Mux({send(){}});m.receive(new Uint8Array(CHUNK+6));assert.equal(m.closed,true);
  const n=new Mux({send(){}});const s=n.create(1,{});s.ready=true;
  n.receive(frame(TYPE.ACK,1,new Uint8Array([0,0,0,1])));assert.equal(n.closed,true);
});
test('open timeout releases slot and rejects caller',async()=>{
  const m=new Mux({send(){},openTimeout:15});
  await assert.rejects(m.open({host:'google.com',port:443},{close(){}}),/timeout/);assert.equal(m.streams.size,0);m.shutdown();
});
test('idle stream cleanup frees its capacity',()=>{
  const m=new Mux({send(){},idleTimeout:10});const s=m.create(1,{close(){}});m.sweep(s.lastActive+20);assert.equal(m.streams.size,0);m.shutdown();
});
test('stop during an in-flight Worker dial cannot resurrect a stopped channel',async()=>{
  let resolve, closed=0;const state=memoryState();
  const c=new TunnelController(state,{IRAN_RELAY_URL:'https://relay.example.com/reverse',TUNNEL_TOKEN:TOKEN,CHANNELS:'1'},
    {connect(){},fetchWebSocket:()=>new Promise(r=>resolve=r)});
  const started=c.fetch(new Request('https://internal/start?slot=0',{method:'POST'}));await sleep(1);
  await c.fetch(new Request('https://internal/stop',{method:'POST'}));
  resolve({close(){closed++;}});await started;assert.equal(closed,1);assert.equal(c.status().connected,false);assert.equal(state.data.has('alarm'),false);
});
test('disabled state survives controller recreation and cron does not enable it',async()=>{
  const state=memoryState();await state.storage.put('config',{enabled:false,slot:0});let dials=0;
  const c=new TunnelController(state,{}, {fetchWebSocket(){dials++;}});await c.alarm();assert.equal(dials,0);
});
test('Worker API enforces authorization, origin, method and channel range',async()=>{
  let calls=0;const env={ADMIN_TOKEN:TOKEN,CHANNELS:'1',TUNNEL:{idFromName:x=>x,get:()=>({fetch:async()=>{calls++;return new Response('{}');}})}};
  assert.equal((await handleRequest(new Request('https://panel.example/api/status'),env)).status,401);
  const headers={Authorization:`Bearer ${TOKEN}`};
  assert.equal((await handleRequest(new Request('https://panel.example/api/channels/0/start',{headers}),env)).status,404);
  assert.equal((await handleRequest(new Request('https://panel.example/api/channels/0/start',{method:'POST',headers:{...headers,Origin:'https://evil.example'}}),env)).status,403);
  assert.equal((await handleRequest(new Request('https://panel.example/api/channels/7/start',{method:'POST',headers}),env)).status,404);
  assert.equal(calls,0);
  assert.equal((await handleRequest(new Request('https://panel.example/api/channels/0/start',{method:'POST',headers}),env)).status,200);
  assert.equal(calls,1);
});
