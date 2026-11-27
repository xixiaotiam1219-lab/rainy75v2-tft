// SPDX-License-Identifier: MIT
export const VID=0x36b0,APP_PID=0x3075,MAIN_CAP=0x4350,IPS_CAP=0x5536;
export const sum16=b=>b.reduce((s,v)=>(s+v)&65535,0);
export function frame(sub,a=0,b=0,c=0,payload=[]){
 const p=new Uint8Array(11+payload.length);if(p.length>255)throw Error('Packet too large');
 p.set([0xbe,0x1a,p.length,sub,a,b,c,0]);p.set(payload,8);const sum=sum16(p.subarray(3,p.length-3));p[p.length-3]=sum&255;p[p.length-2]=sum>>>8;p[p.length-1]=0xed;return p;
}
export const command=(op,id=0,payload=[])=>frame(13,op,id&255,id>>>8,payload);
export const ACK_READ=new Uint8Array([0xbe,0xe4,10,0x84,4,0,0,0x34,2,0xed]);
export function parseAck(p,{allowLegacy=true}={}){
 if(p.length<14||p[0]!==0xbe||p[1]!==0xe4||p[2]!==14||p[3]!==0x84||p[4]!==4||p[5]||p[6]||p[13]!==0xed)throw Error('ACK format mismatch');
 const got=p[11]|p[12]<<8,valid=got===sum16(p.subarray(0,11));
 if(!valid&&!(allowLegacy&&got===0x0357))throw Error('ACK checksum mismatch');
 return {sub:p[7],status:p[8],value:p[9]|p[10]<<8,legacyChecksum:!valid};
}
export function crc16(bytes){let crc=65535;for(const v of bytes){crc^=v<<8;for(let i=0;i<8;i++)crc=(crc&32768?crc<<1^0x1021:crc<<1)&65535;}return crc;}
export function localSeconds(ms=Date.now(),timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone){const a=new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(ms)).split(':').map(Number);return a[0]*3600+a[1]*60+a[2];}
export const timeDifference=(a,b)=>((a-b+129600)%86400)-43200;
export function decodeTime(raw){if(raw===0xffffffff)return null;const s=raw.toString(16).padStart(6,'0');if(!/^\d{6}$/.test(s))return null;const h=+s.slice(0,2),m=+s.slice(2,4),v=+s.slice(4,6);return h<24&&m<60&&v<60?{seconds:h*3600+m*60+v,text:`${s.slice(0,2)}:${s.slice(2,4)}:${s.slice(4,6)}`}:null;}
export function validateGif(bytes){
 const signature=new TextDecoder().decode(bytes.subarray(0,6));
 if(!['GIF87a','GIF89a'].includes(signature)||bytes.length<13||bytes.length>4*1024*1024||((bytes[6]|bytes[7]<<8)!==320)||((bytes[8]|bytes[9]<<8)!==172))throw Error('请选择 320×172、大小不超过 4MiB 的 GIF');
}
export async function sha256(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
export const TARGETS={main:{pid:0x3079,base:0x2000,bytes:294912,boot:[0xbe,0xfc,4,0xed]},ips:{pid:0x3078,base:0x4000,bytes:507904,boot:[0xbe,0xfc,5,0,0xed]}};
export const BONGO_BUILDS=Object.freeze({
  0x4246:Object.freeze({firmware:'cfb28f99cfe00a5b1a8c96e9d04181ab89efdfaba3c10b583a129453b8feff0e',gif:'76bf75daa5044046d4416035587ff8967638a018e838d85ecb5fce931d003672'}),
  0x4247:Object.freeze({firmware:'62b8d3c4885dc924dcc26f0daa0c7a6936eb7ba9f68196ddb285b890ea07bec2',gif:'d336f8a0e057d5e9aa43a9b040c720c3e9a23e04668fae720710b5ed7be332a9'})
});
export async function validateBuild(bytes,m){
 const t=TARGETS[m?.target],lyrics=m?.target==='ips'&&m.variant==='lyrics-v1';
 const pet=m?.target==='ips'&&m.variant==='bongo-v1'&&m.pet==='bongocat-keymap'&&m.petEnabled===true&&m.sha256===BONGO_BUILDS[m.petIdentity]?.firmware;
 const bank2=lyrics||pet;
 if(bank2&&(m.requiredFlashKiB!==1024||m.requiredSeries!==13||m.codeStart!==0x08080000||m.imageEnd!==0x08088000||m.iapEraseEnd!==0x080c0000))throw Error('Bank2 硬件与地址边界不匹配');
 if(!t||m.format!=='rainy75v2-tft/build-v1'||m.applicationBase!==t.base||m.iapPid!==t.pid||bytes.length!==m.bytes||bytes.length!==(bank2?540672:t.bytes)||m.variant&&!bank2)throw Error('构建清单或目标不匹配');
 if(!/^[a-f0-9]{64}$/.test(m.sha256)||await sha256(bytes)!==m.sha256)throw Error('固件 SHA-256 不匹配，未擦除');
 return {...t,target:m.target,variant:bank2?m.variant:undefined,hardwareChecked:!bank2,bytes:new Uint8Array(bytes),sha256:m.sha256};
}
