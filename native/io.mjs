export const encode = s => new TextEncoder().encode(s);
export class ByteReader {
  constructor(reader) { this.reader=reader; this.buffer=new Uint8Array(); this.offset=0; }
  async exact(n) {
    if (!Number.isInteger(n) || n < 0 || n > 1048576) throw new Error('invalid read size');
    const out=new Uint8Array(n); let at=0;
    while(at<n){
      if(this.offset===this.buffer.length){const r=await this.reader.read();if(r.done)throw new Error('connection closed');this.buffer=r.value;this.offset=0;if(!this.buffer.length)continue;}
      const take=Math.min(n-at,this.buffer.length-this.offset);out.set(this.buffer.subarray(this.offset,this.offset+take),at);this.offset+=take;at+=take;
    }
    return out;
  }
  async untilHeader(){const bytes=[];while(bytes.length<8192){bytes.push((await this.exact(1))[0]);const n=bytes.length;if(n>=4&&bytes[n-4]===13&&bytes[n-3]===10&&bytes[n-2]===13&&bytes[n-1]===10)return new TextDecoder().decode(new Uint8Array(bytes));}throw new Error('HTTP header too large');}
  async read(){if(this.offset<this.buffer.length){const value=this.buffer.subarray(this.offset);this.offset=this.buffer.length;return{done:false,value};}return this.reader.read();}
}
export function serialWriter(writer) {
  let tail=Promise.resolve(), queued=0;
  return {write(bytes){
    if(queued+bytes.length>1048576)return Promise.reject(new Error('write queue limit'));
    queued+=bytes.length;const op=tail.then(()=>writer.write(bytes)).finally(()=>{queued-=bytes.length;});tail=op.catch(()=>{});return op;
  },close:()=>tail.then(()=>writer.close())};
}
const base64=b=>btoa(String.fromCharCode(...b));
export async function webSocketOverSocket(endpoint, config) {
  const reader=new ByteReader(endpoint.reader), raw=serialWriter(endpoint.writer);
  const key=base64(crypto.getRandomValues(new Uint8Array(16)));
  await raw.write(encode(`GET ${config.path} HTTP/1.1\r\nHost: ${config.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  const header=await reader.untilHeader(), lines=header.split('\r\n');
  if(!/^HTTP\/1\.1 101(?: |$)/.test(lines[0]))throw new Error('WebSocket upgrade rejected');
  const headers=new Map();for(const line of lines.slice(1)){const i=line.indexOf(':');if(i>0)headers.set(line.slice(0,i).toLowerCase(),line.slice(i+1).trim());}
  const expected=base64(new Uint8Array(await crypto.subtle.digest('SHA-1',encode(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11'))));
  if(headers.get('sec-websocket-accept')!==expected||headers.get('upgrade')?.toLowerCase()!=='websocket'||!headers.get('connection')?.toLowerCase().split(/\s*,\s*/).includes('upgrade')||headers.has('sec-websocket-extensions'))throw new Error('invalid WebSocket upgrade');
  let fragmented=false, ended=false, messageBytes=0;
  async function send(opcode,data){
    if(data.length>65535)throw new Error('WS write too large');
    const extra=data.length<126?0:2,b=new Uint8Array(2+extra+4+data.length),view=new DataView(b.buffer);
    b[0]=128|opcode;b[1]=128|(extra?126:data.length);if(extra)view.setUint16(2,data.length);
    const mask=crypto.getRandomValues(new Uint8Array(4)),pos=2+extra;b.set(mask,pos);
    for(let i=0;i<data.length;i++)b[pos+4+i]=data[i]^mask[i%4];
    await raw.write(b);
  }
  return {close:endpoint.close,writer:{write:b=>send(2,b),close:async()=>{if(!ended){ended=true;await send(8,new Uint8Array([3,232]));}await endpoint.close();}},reader:{async read(){
    while(!ended){
      const h=await reader.exact(2),fin=!!(h[0]&128),op=h[0]&15;
      if(h[0]&112||h[1]&128)throw new Error('invalid server WS frame');
      let size=h[1]&127;if(size===126){const b=await reader.exact(2);size=(b[0]<<8)|b[1];}else if(size===127){const b=await reader.exact(8),v=new DataView(b.buffer);if(v.getUint32(0))throw new Error('WS frame too large');size=v.getUint32(4);}
      if(size>1048576||op>=8&&(!fin||size>125))throw new Error('WS frame limit');
      const payload=await reader.exact(size);
      if(op===8){ended=true;await send(8,payload);return{done:true};}
      if(op===9){await send(10,payload);continue;}if(op===10)continue;
      if(op===2&&!fragmented){fragmented=!fin;messageBytes=size;}
      else if(op===0&&fragmented){fragmented=!fin;messageBytes+=size;}
      else throw new Error('unexpected WS opcode');
      if(messageBytes>1048576)throw new Error('WS message limit');
      if(payload.length)return{done:false,value:payload};
    }return{done:true};
  }}};
}
