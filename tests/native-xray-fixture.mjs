// Integration fixture: a real, separately supplied Xray binary and loopback TLS/TCP.
// ONLY the Cloudflare sockets adapter / DO storage are substituted with Node equivalents.
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeEndpoint } from '../agent/io.mjs';
import { NativeController } from '../native/controller.mjs';
import { deadline } from '../native/mux.mjs';
import { requestBytes, TOKEN, sleep } from './helpers.mjs';
export const UUID='1c82551a-d494-4b89-bf2a-a1c8f1d0e9a6';
const NORMAL_UUID='798749ee-24cd-48f4-8138-aa414fcbe3a3';
async function port(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
export async function xrayFixture({network='tcp',binary=process.env.XRAY_BIN,targetHandler}={}) {
  if(!binary)throw new Error('XRAY_BIN is required');
  const dir=await mkdtemp(join(tmpdir(),'cfr-native-')),key=join(dir,'key.pem'),cert=join(dir,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=iran.example.com','-addext','subjectAltName=DNS:iran.example.com','-keyout',key,'-out',cert],{stdio:'ignore'});
  const ca=await readFile(cert),tlsPort=await port(),socksPort=await port();
  const sockets=new Set(),track=s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});return s;};
  const target=net.createServer({allowHalfOpen:true},s=>{track(s);if(targetHandler)targetHandler(s);else{s.on('data',b=>s.write(b));s.on('end',()=>s.end());}});
  target.listen(0,'127.0.0.1');await once(target,'listening');const targetPort=target.address().port;
  const config={log:{loglevel:'warning'},inbounds:[
    {tag:'reverse-listener',listen:'127.0.0.1',port:tlsPort,protocol:'vless',settings:{clients:[{id:UUID,reverse:{tag:'iran-reverse'}},{id:NORMAL_UUID}],decryption:'none'},streamSettings:{network:network==='tcp'?'raw':'ws',security:'tls',tlsSettings:{alpn:['http/1.1'],certificates:[{certificateFile:cert,keyFile:key}]},...(network==='ws'?{wsSettings:{path:'/reverse'}}:{})}},
    {tag:'test-users',listen:'127.0.0.1',port:socksPort,protocol:'socks',settings:{auth:'noauth',udp:false}}
  ],outbounds:[{tag:'blocked',protocol:'blackhole'}],routing:{rules:[{type:'field',inboundTag:['test-users'],outboundTag:'iran-reverse'}]}};
  const path=join(dir,'xray.json');await writeFile(path,JSON.stringify(config));
  execFileSync(binary,['run','-test','-c',path],{stdio:'pipe'});
  const child=spawn(binary,['run','-c',path],{stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',b=>{logs+=b;});child.stderr.on('data',b=>{logs+=b;});
  let started=false;
  for(let i=0;i<100;i++){
    if(child.exitCode!==null)throw new Error('Xray exited: '+logs);
    const s=net.connect({host:'127.0.0.1',port:socksPort});s.on('error',()=>{});
    try{await once(s,'connect');started=true;s.destroy();break;}catch{s.destroy();await sleep(20);}
  }
  if(!started)throw new Error('Xray did not start: '+logs);
  const data=new Map(),state={data,storage:{get:async k=>data.get(k),put:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k),setAlarm:async t=>data.set('alarm',t),deleteAlarm:async()=>data.delete('alarm')}};
  const env={ADMIN_TOKEN:TOKEN,ALLOWED_PORTS:String(targetPort)};
  const deps={connect(address,options){
    const secure=options.secureTransport==='on';
    if(secure&&(address.hostname!=='iran.example.com'||address.port!==tlsPort))throw new Error('unexpected TLS target');
    if(!secure&&(address.hostname!=='echo.example.com'||address.port!==targetPort))throw new Error('unexpected TCP target');
    const s=track(secure?tls.connect({host:'127.0.0.1',port:tlsPort,servername:'iran.example.com',ca,rejectUnauthorized:true,allowHalfOpen:true}):net.connect({host:'127.0.0.1',port:targetPort,allowHalfOpen:true}));
    const ep=nodeEndpoint(s);return{opened:once(s,secure?'secureConnect':'connect'),closed:new Promise(r=>s.once('close',r)),readable:{getReader:()=>ep.reader},writable:{getWriter:()=>ep.writer},close:()=>s.destroy()};
  }};
  const controller=new NativeController(state,env,deps);
  const link=`vless://${UUID}@iran.example.com:${tlsPort}?security=tls&type=${network}&encryption=none&path=%2Freverse`;
  const call=async(op,body)=>controller.fetch(new Request('https://internal/'+op,{method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)}));
  return{controller,state,env,deps,link,normalLink:link.replace(UUID,NORMAL_UUID),targetPort,logs:()=>logs,
    call,start:()=>call('connect',{config:link,reverseTag:'iran-reverse'}),
    async client({host='echo.example.com',port=targetPort,early=Buffer.alloc(0)}={}){
      const s=track(net.connect({host:'127.0.0.1',port:socksPort,allowHalfOpen:true}));await once(s,'connect');const ep=nodeEndpoint(s);
      await ep.writer.write(Buffer.from([5,1,0]));const auth=await ep.reader.exact(2);if(auth[1]!==0)throw new Error('SOCKS authentication failed');
      await ep.writer.write(Buffer.concat([requestBytes(host,port),early]));
      const reply=await deadline(ep.reader.exact(10),3000);if(reply[1]!==0)throw new Error('SOCKS connect failed');
      return{s,ep};
    },
    async close(){await call('disconnect',{});for(const s of sockets)s.destroy();child.kill('SIGTERM');if(child.exitCode===null)await once(child,'exit');await new Promise(r=>target.close(r));await rm(dir,{recursive:true,force:true});}
  };
}
