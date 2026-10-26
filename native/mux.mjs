// Original implementation of Xray's VLESS command 4 and TCP mux wire format.
import { ByteReader, serialWriter } from './io.mjs';
export function deadline(promise, ms, message = 'operation timed out') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}
export function vlessHeader(uuid) {
  const b = new Uint8Array(19), hex = uuid.replaceAll('-', '');
  for (let i = 0; i < 16; i++) b[i + 1] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  b[18] = 4; return b; // version, UUID, no addons, reverse command; no destination
}
export function frame(id, status, data, error = false) {
  const n = data?.length || 0;
  if (n > 65535) throw new Error('frame too large');
  const b = new Uint8Array(6 + (data ? 2 + n : 0)), v = new DataView(b.buffer);
  v.setUint16(0, 4); v.setUint16(2, id); b[4] = status; b[5] = (data ? 1 : 0) | (error ? 2 : 0);
  if (data) { v.setUint16(6, n); b.set(data, 8); } return b;
}
export function metadata(b) {
  if (b.length < 4) throw new Error('short mux metadata');
  const m = { id: (b[0] << 8) | b[1], status: b[2], options: b[3] };
  if (m.status < 1 || m.status > 4 || m.options & ~3) throw new Error('invalid mux metadata');
  if (m.status === 1) {
    if (b.length < 8) throw new Error('short destination');
    m.network = b[4]; m.port = (b[5] << 8) | b[6];
    if (b[7] === 1 && b.length >= 12) m.host = [...b.subarray(8,12)].join('.');
    else if (b[7] === 2 && b.length >= 9 + b[8] && b[8]) m.host = new TextDecoder('utf-8', {fatal:true}).decode(b.subarray(9,9+b[8]));
    else if (b[7] === 3 && b.length >= 24) m.host = [...b.subarray(8,24)].map(x=>x.toString(16).padStart(2,'0')).join(':'); // rejected by target policy
    else throw new Error('invalid destination');
  }
  return m;
}
export function controlState(bytes) {
  let i = 0, state = 0;
  function varint() {
    let n = 0, factor = 1;
    for (let j = 0; j < 8; j++) { if (i >= bytes.length) throw new Error('truncated control'); const v=bytes[i++]; n+=(v&127)*factor; if (!(v&128)) { if (!Number.isSafeInteger(n)) throw new Error('control overflow'); return n; } factor*=128; }
    throw new Error('control overflow');
  }
  if (bytes.length > 4096) throw new Error('control too large');
  while (i < bytes.length) {
    const tag=varint(), field=Math.floor(tag/8), wire=tag&7;
    if (!field) throw new Error('invalid control tag');
    if (wire === 0) { const value=varint(); if(field===1)state=value; }
    else if (wire === 2) { const length=varint(); i+=length; }
    else if (wire === 1) i+=8;
    else if (wire === 5) i+=4;
    else throw new Error('unsupported control wire type');
    if(i>bytes.length)throw new Error('truncated control');
  }
  if(state!==0&&state!==1)throw new Error('invalid control state');
  return state;
}
const close = ep => { try { Promise.resolve(ep?.close()).catch(()=>{}); } catch {} };
export class NativeReverse {
  constructor(endpoint, { uuid, connectTarget, onClose = () => {} }) {
    this.endpoint=endpoint; this.reader=new ByteReader(endpoint.reader); this.writer=serialWriter(endpoint.writer);
    this.uuid=uuid; this.connectTarget=connectTarget; this.onClose=onClose;
    this.streams=new Map(); this.closed=false; this.connected=false; this.draining=false; this.controlId=null;
    this.bytesToInternet=0; this.bytesFromInternet=0; this.rejected=0; this.lastHeartbeat=Date.now();
    this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
    this.ready.catch(()=>{});
  }
  start() {
    if(this.done)return this.ready;
    this.done=this.run().catch(e=>this.shutdown(e.message));
    return this.ready;
  }
  async send(id,status,data,error=false) { if(this.closed)throw new Error('channel closed'); await deadline(this.writer.write(frame(id,status,data,error)),15000,'tunnel write timeout'); }
  async run() {
    await this.writer.write(vlessHeader(this.uuid));
    const header=await this.reader.exact(2);
    if(header[0]!==0)throw new Error('VLESS response rejected');
    await this.reader.exact(header[1]);
    while(!this.closed) {
      const size=await this.reader.exact(2), length=(size[0]<<8)|size[1];
      if(length<4||length>512)throw new Error('mux metadata limit');
      const m=metadata(await this.reader.exact(length));
      let payload=null;
      if(m.options&1){const b=await this.reader.exact(2);payload=await this.reader.exact((b[0]<<8)|b[1]);}
      await this.receive(m,payload);
    }
  }
  async receive(m,payload) {
    if(m.status===4)return;
    if(m.status===1 && m.network===2 && m.host==='reverse' && m.port===0) {
      if(this.controlId!==null||this.streams.has(m.id))throw new Error('duplicate control channel');
      this.controlId=m.id;
    }
    if(m.id===this.controlId) {
      if(m.status===3){if(!this.draining)throw new Error('reverse control closed');this.checkDrain();return;}
      if(payload){
        const state=controlState(payload);this.lastHeartbeat=Date.now();
        if(state===1){this.draining=true;this.checkDrain();}
        else if(!this.connected&&!this.draining){this.connected=true;this.resolveReady();}
      }
      return;
    }
    if(m.status===3){this.drop(m.id);return;}
    if(m.status===1) {
      if(this.streams.has(m.id))throw new Error('duplicate stream id');
      if(!this.connected||this.draining||m.network!==1||this.streams.size>=4){this.rejected++;await this.send(m.id,3,null,true);return;}
      let ep;
      try { ep=await this.connectTarget({host:m.host,port:m.port}); }
      catch { this.rejected++;await this.send(m.id,3,null,true);return; }
      if(this.closed){close(ep);return;}
      const s={ep,lastActivity:Date.now()};this.streams.set(m.id,s);
      // Reading and writing run concurrently, each await preserves socket backpressure.
      this.pump(m.id,s).catch(()=>{});
    }
    const s=this.streams.get(m.id);
    if(!s){if(m.status===2)await this.send(m.id,3,null,true);return;}
    if(payload?.length){
      try { await deadline(s.ep.writer.write(payload),15000,'destination write timeout');this.bytesToInternet+=payload.length;s.lastActivity=Date.now(); }
      catch { this.drop(m.id);await this.send(m.id,3,null,true); }
    }
  }
  async pump(id,s) {
    let failed=false;
    try {
      while(!this.closed&&this.streams.get(id)===s){
        const r=await s.ep.reader.read();if(r.done)break;
        for(let at=0;at<r.value.length;at+=8192){
          if(this.closed||this.streams.get(id)!==s)return;
          const chunk=r.value.subarray(at,at+8192);await this.send(id,2,chunk);this.bytesFromInternet+=chunk.length;s.lastActivity=Date.now();
        }
      }
    }catch{failed=true;}
    if(this.streams.get(id)===s){this.drop(id);if(!this.closed)try{await this.send(id,3,null,failed);}catch(e){this.shutdown(e.message);}}
  }
  drop(id){const s=this.streams.get(id);if(s){this.streams.delete(id);close(s.ep);}this.checkDrain();}
  checkDrain(){if(this.draining&&!this.streams.size)this.shutdown('reverse channel retired');}
  sweep(){
    if(!this.draining&&Date.now()-this.lastHeartbeat>45000){this.shutdown('reverse heartbeat timed out');return;}
    for(const [id,s] of this.streams)if(Date.now()-s.lastActivity>120000){this.drop(id);if(!this.closed)this.send(id,3,null,true).catch(e=>this.shutdown(e.message));}
  }
  shutdown(reason='channel stopped'){
    if(this.closed)return;this.closed=true;this.connected=false;this.rejectReady(new Error(reason));
    for(const s of this.streams.values())close(s.ep);this.streams.clear();close(this.endpoint);this.onClose(reason);
  }
}
