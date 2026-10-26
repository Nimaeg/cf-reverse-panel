import { parseConfig, summary, seal, unseal, ConfigError } from './config.mjs';
import { webSocketOverSocket } from './io.mjs';
import { NativeReverse, deadline } from './mux.mjs';
import { parsePorts, validateTarget } from '../shared/target.mjs';
import { json } from '../worker/controller.mjs';
const quietlyClose=ep=>{try{Promise.resolve(ep?.close()).catch(()=>{});}catch{}};
export class NativeController {
  constructor(state,env,{connect}) {
    this.state=state;this.env=env;this.connect=connect;this.config=null;this.enabled=false;this.stage='empty';
    this.lastError=null;this.connectedAt=null;this.mux=null;this.transport=null;this.generation=0;this.dialing=false;this.busy=false;
    this.nextAttempt=0;this.failures=0;
    this.ready=state.storage.get('native-config').then(async record=>{
      if(!record)return;
      try{this.config=await unseal(record.sealed,env.ADMIN_TOKEN);this.enabled=record.enabled;this.stage=this.enabled?'waiting':'stopped';}
      catch{this.lastError='کانفیگ ذخیره‌شده قابل بازکردن نیست؛ پس از تغییر کلید مدیریت، دوباره کانفیگ را وارد کن.';this.stage='error';}
    });
  }
  status(){return {version:'0.3.0',configured:!!this.config,enabled:this.enabled,stage:this.stage,
    connected:!!this.mux?.connected&&!this.mux.closed,connecting:this.dialing,config:summary(this.config),
    connectedAt:this.connectedAt,lastError:this.lastError,nextAttempt:this.nextAttempt,
    activeStreams:this.mux?.streams.size||0,maxStreams:4,draining:this.mux?.draining||false,
    bytesToInternet:this.mux?.bytesToInternet||0,bytesFromInternet:this.mux?.bytesFromInternet||0,
    rejectedStreams:this.mux?.rejected||0,allowedPorts:this.env.ALLOWED_PORTS||'80,443'};}
  async persist(){
    const record={enabled:this.enabled,sealed:this.config?await seal(this.config,this.env.ADMIN_TOKEN):null};
    if(record.sealed)await this.state.storage.put('native-config',record);
    else await this.state.storage.delete('native-config');
  }
  cancel(){this.generation++;const m=this.mux;this.mux=null;m?.shutdown();quietlyClose(this.transport);this.transport=null;this.dialing=false;this.connectedAt=null;}
  async fetch(req){
    await this.ready;const op=new URL(req.url).pathname;
    if(op==='/status')return json(this.status());
    if(op==='/ensure'){await this.ensure();return json(this.status());}
    if(!['/connect','/disconnect','/reconnect','/forget'].includes(op)||req.method!=='POST')return json({error:'not found'},404);
    // Keep storage updates ordered; dial cancellation itself remains immediate.
    if(this.busy)return json({error:'درخواست قبلی در حال ذخیره شدن است؛ دوباره تلاش کن.'},409);
    this.busy=true;
    try{
      if(op==='/connect'){
        let body;try{body=await req.json();}catch{throw new ConfigError('بدنهٔ درخواست معتبر نیست.');}
        const config=parseConfig(body?.config,body?.reverseTag);
        this.cancel();this.config=config;this.enabled=true;this.stage='connecting';this.lastError=null;this.nextAttempt=0;
        await this.persist();
      }else if(op==='/disconnect'||op==='/forget'){
        this.enabled=false;this.cancel();if(op==='/forget')this.config=null;
        this.stage=this.config?'stopped':'empty';this.lastError=null;this.nextAttempt=0;
        await this.persist();await this.state.storage.deleteAlarm();return json(this.status());
      }else{
        if(!this.config)throw new ConfigError('ابتدا کانفیگ سرور را وارد کن.');
        this.cancel();this.enabled=true;this.stage='connecting';this.lastError=null;this.nextAttempt=0;await this.persist();
      }
    }catch(e){return json({error:e instanceof ConfigError?e.message:'ذخیرهٔ تنظیمات ناموفق بود.'},e instanceof ConfigError?400:503);}
    finally{this.busy=false;}
    await this.ensure();
    return json(this.status(),this.stage==='error'?502:200);
  }
  async endpoint(address,options){
    const socket=this.connect(address,options);socket.closed?.catch(()=>{});
    const ep={reader:socket.readable.getReader(),writer:socket.writable.getWriter(),close:()=>socket.close()};
    return {socket,ep};
  }
  async target(target,ports){
    const address=validateTarget(target,ports),{socket,ep}=await this.endpoint(address,{secureTransport:'off',allowHalfOpen:true});
    try{await deadline(socket.opened,8000,'destination connect timeout');return ep;}catch(e){quietlyClose(ep);throw e;}
  }
  async ensure(){
    if(!this.enabled||!this.config||this.dialing)return;
    if(this.mux&&!this.mux.closed){this.mux.sweep();if(!this.mux.closed){await this.state.storage.setAlarm(Date.now()+15000);return;}}
    if(Date.now()<this.nextAttempt){await this.state.storage.setAlarm(this.nextAttempt);return;}
    this.cancel();const generation=this.generation,config=this.config;
    this.dialing=true;this.stage='connecting';
    const current=()=>this.enabled&&generation===this.generation;
    try{
      await this.state.storage.setAlarm(Date.now()+25000);
      const ports=parsePorts(this.env.ALLOWED_PORTS);
      const {socket,ep}=await this.endpoint({hostname:config.address,port:config.port},{secureTransport:'on',allowHalfOpen:true});
      if(!current()){quietlyClose(ep);return;}this.transport=ep;
      const handshake=async()=>{
        await socket.opened;
        if(!current())throw new Error('cancelled');
        const transport=config.network==='ws'?await webSocketOverSocket(ep,config):ep;
        if(!current()){quietlyClose(transport);throw new Error('cancelled');}
        const mux=new NativeReverse(transport,{uuid:config.uuid,connectTarget:t=>this.target(t,ports),onClose:()=>{
          if(!current())return;
          this.stage='error';this.lastError='ارتباط ریورس قطع شد؛ اتصال مجدد به‌صورت خودکار انجام می‌شود.';
        }});
        this.mux=mux;await mux.start();
      };
      await deadline(handshake(),12000,'reverse handshake timeout');
      if(!current())return;
      if(this.mux?.closed)throw new Error('reverse closed after handshake');
      this.stage='ready';this.connectedAt=new Date().toISOString();this.lastError=null;this.failures=0;this.nextAttempt=0;
    }catch{
      if(!current())return;
      this.cancel();
      this.stage='error';this.lastError='سرور ریورس را تأیید نکرد. دسترسی به دامنه و پورت، گواهی TLS، UUID مخصوص ریورس و تنظیم reverse در Xray را بررسی کن.';
      this.failures++;this.nextAttempt=Date.now()+Math.min(60000,2000*2**Math.min(this.failures,5));
      await this.state.storage.setAlarm(this.nextAttempt);
    }finally{
      if(generation===this.generation){this.dialing=false;if(this.enabled)await this.state.storage.setAlarm(Math.max(Date.now()+15000,this.nextAttempt));}
    }
  }
  async alarm(){await this.ready;await this.ensure();}
}
