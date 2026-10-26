// Generates a standalone TEST Xray server config. Never edits a running 3x-ui config.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { publicHost } from '../shared/target.mjs';
const {values:o}=parseArgs({options:{server:{type:'string'},tag:{type:'string',default:'iran-reverse'},transport:{type:'string',default:'tcp'},port:{type:'string',default:'443'},'users-port':{type:'string',default:'8443'},cert:{type:'string'},key:{type:'string'},out:{type:'string',default:'generated-native'},help:{type:'boolean'}}});
if(o.help){console.log('node scripts/native-server-config.mjs --server iran.example.com --cert /path/fullchain.pem --key /path/privkey.pem [--tag iran-reverse] [--transport tcp|ws] [--port 443] [--users-port 8443] [--out generated-native]');process.exit(0);}
if(!publicHost(o.server)||!o.cert||!o.key||!['tcp','ws'].includes(o.transport)||!/^[a-zA-Z0-9_.-]{1,64}$/.test(o.tag))throw new Error('Use --help; a public server hostname, certificate/key paths, valid tag and tcp|ws are required.');
const port=Number(o.port),usersPort=Number(o['users-port']);
if([port,usersPort].some(n=>!Number.isInteger(n)||n<1||n>65535||n===25)||port===usersPort)throw new Error('Use two distinct valid ports (not 25).');
const reverseId=randomUUID(),userId=randomUUID();
const tlsSettings={alpn:['http/1.1'],certificates:[{certificateFile:o.cert,keyFile:o.key}]};
const config={log:{loglevel:'warning'},inbounds:[
  {tag:'worker-reverse-listener',listen:'0.0.0.0',port,protocol:'vless',settings:{clients:[{id:reverseId,email:'worker-reverse',reverse:{tag:o.tag}}],decryption:'none'},streamSettings:{network:o.transport==='tcp'?'raw':'ws',security:'tls',tlsSettings,...(o.transport==='ws'?{wsSettings:{path:'/reverse'}}:{})}},
  {tag:'test-user-inbound',listen:'0.0.0.0',port:usersPort,protocol:'vless',settings:{clients:[{id:userId,email:'test-user'}],decryption:'none'},streamSettings:{network:'raw',security:'tls',tlsSettings}}
],outbounds:[{tag:'blocked',protocol:'blackhole'}],routing:{domainStrategy:'AsIs',rules:[
  {type:'field',inboundTag:['test-user-inbound'],network:'udp',outboundTag:'blocked'},
  {type:'field',inboundTag:['test-user-inbound'],network:'tcp',outboundTag:o.tag}
]}};
const link=(id,p,network)=>`vless://${id}@${o.server}:${p}?encryption=none&security=tls&type=${network}&sni=${encodeURIComponent(o.server)}${network==='ws'?'&path=%2Freverse':''}`;
const dir=resolve(o.out);await mkdir(dir,{recursive:false,mode:0o700});
await writeFile(join(dir,'xray-server.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
await writeFile(join(dir,'reverse-link.txt'),link(reverseId,port,o.transport)+'#Worker-Reverse\n',{mode:0o600,flag:'wx'});
await writeFile(join(dir,'test-user-link.txt'),link(userId,usersPort,'tcp')+'#Test-User\n',{mode:0o600,flag:'wx'});
await writeFile(join(dir,'reverse-tag.txt'),o.tag+'\n',{mode:0o600,flag:'wx'});
console.log(`Created ${dir}\nPaste reverse-link.txt + reverse-tag.txt into the Worker panel.\nUse test-user-link.txt in a VLESS client.\nThese files contain credentials; keep them private. The output directory must be new.`);
