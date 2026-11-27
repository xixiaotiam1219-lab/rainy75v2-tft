// SPDX-License-Identifier: MIT
import {VID,APP_PID,MAIN_CAP,IPS_CAP,ACK_READ,parseAck,command,frame,crc16,localSeconds,timeDifference,decodeTime,validateGif,TARGETS} from './protocol.mjs';
import {validateFont} from './font.mjs';
export const wait=ms=>new Promise(r=>setTimeout(r,ms));
function abortIfRequested(signal){if(signal?.aborted){const error=new Error('显示传输已取消');error.name='AbortError';throw error;}}
export function reportLength(reports,length){return reports?.some(r=>r.reportId===0&&r.items.reduce((n,i)=>n+i.reportSize*i.reportCount,0)/8===length);}
export function validDevice(device,pid,length){return device?.vendorId===VID&&device.productId===pid&&device.collections?.some(c=>c.usagePage===0xff60&&c.usage===0x61&&reportLength(c.outputReports,length)&&reportLength(c.inputReports,length));}
export class HidIO{
 constructor(device,length){this.device=device;this.length=length;this.pending=false;}
 static async choose(pid,length){
  if(!globalThis.navigator?.hid)throw Error('请用支持 WebHID 的桌面 Chrome / Edge，并通过 localhost 或 HTTPS 打开');
  const list=await navigator.hid.requestDevice({filters:[{vendorId:VID,productId:pid,usagePage:0xff60,usage:0x61}]});const d=list.find(d=>validDevice(d,pid,length));if(!d)throw Error('设备型号或 HID 描述符不匹配');
  if(!d.opened)await d.open();return new HidIO(d,length);
 }
 async send(bytes){if(bytes.length>this.length)throw Error('Report too large');const p=new Uint8Array(this.length);p.set(bytes);await this.device.sendReport(0,p);}
 async exchange(bytes,match,timeout=2500,minLength=this.length,{signal}={}){
  if(this.pending)throw Error('Another exchange is pending');this.pending=true;let handler,timer,onAbort,sending;
  try{
   abortIfRequested(signal);
   const reply=new Promise((resolve,reject)=>{
    handler=e=>{if(e.reportId!==0||e.data.byteLength<minLength||e.data.byteLength>this.length)return;const p=new Uint8Array(e.data.buffer,e.data.byteOffset,e.data.byteLength);if(match(p))resolve(new Uint8Array(p));};
    this.device.addEventListener('inputreport',handler);timer=setTimeout(()=>reject(Error('设备应答超时')),timeout);
    if(signal){onAbort=()=>{try{abortIfRequested(signal);}catch(e){reject(e);}};signal.addEventListener('abort',onAbort,{once:true});}
   });
   sending=this.send(bytes);const [,result]=await Promise.all([sending,reply]);return result;
  }finally{clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);if(handler)this.device.removeEventListener('inputreport',handler);if(sending)await sending.catch(()=>{});this.pending=false;}
 }
 async close(){if(this.device.opened)await this.device.close();}
}
export class AppClient{
 constructor(io,{pause=wait,now=Date.now}={}){this.io=io;this.pause=pause;this.now=now;this.seq=Date.now()&65535;}
 static async connect(){return new AppClient(await HidIO.choose(APP_PID,256));}
 async close(){await this.io.close();}
 async ack({signal}={}){return parseAck(await this.io.exchange(ACK_READ,p=>p[0]===0xbe&&p[1]===0xe4&&p[3]===0x84,2500,undefined,{signal}));}
 async sendAwait(packet,accept,timeout=8000,pollMs=15,{signal,retryMs=0}={}){
  abortIfRequested(signal);
  await this.io.send(packet);const start=this.now();let last,lastSent=start;
  while(this.now()-start<timeout){abortIfRequested(signal);last=await this.ack({signal});abortIfRequested(signal);if(accept(last))return last;if(retryMs&&this.now()-lastSent>=retryMs){await this.io.send(packet);lastSent=this.now();}await this.pause(pollMs);}
  throw Error('指令应答超时：'+JSON.stringify(last));
 }
 async request(op,id=0,payload=[],test=a=>a.status===1&&a.value===id,{pollMs=15,signal,retryMs=0}={}){
  if(!Number.isInteger(pollMs)||pollMs<2||pollMs>100)throw Error('无效查询间隔');
  const canResend=[22,23,26,29].includes(op)||op===11&&id===0;
  if(retryMs&&(!canResend||!Number.isInteger(retryMs)||retryMs<100||retryMs>1000))throw Error('仅允许显示查询或幂等界面设置重试');
  const pending={op,id,startedAt:Date.now()};this.currentRequest=pending;let outcome='done';
  return this.sendAwait(command(op,id,payload),a=>{
   if(a.sub!==13)return false;if(test(a))return true;
   if(a.value===id&&a.status>=2&&a.status<=7)throw Object.assign(Error('设备拒绝指令，状态 '+a.status),{status:a.status});return false;
  },8000,pollMs,{signal,retryMs}).catch(e=>{outcome=e.name==='AbortError'?'cancelled':'error';if(e.name==='AbortError')throw e;throw Object.assign(new Error('OP'+op+' / ID'+id+'：'+e.message),{status:e.status,cause:e});}).finally(()=>{const elapsedMs=Date.now()-pending.startedAt;if(elapsedMs>=200)this.lastSlowRequest={...pending,elapsedMs,outcome};if(this.currentRequest===pending)this.currentRequest=null;});
 }
 async queryMain(f){return (await this.request(15,f,[],a=>a.status===0xd0+f)).value;}
 async queryIps(f,options){return (await this.request(11,f,[],a=>a.status===0xb0+f,options)).value;}
 async requireScreen(){
  try{
   if(await this.queryIps(0,{retryMs:300})!==IPS_CAP)throw Error('屏幕协议不匹配');
  }catch(cause){
   throw Object.assign(Error('未读到屏幕就绪应答，尚未开始写素材。',{cause}),{code:'IPS_NOT_READY'});
  }
 }
 async inspectFont({attempts=40}={}){
  await this.request(24,1,[],a=>a.status===0xa6&&a.value===0x4c59);
  const q=async f=>(await this.request(22,f,[],a=>a.status===0xc0+(f&15))).value;
  const low=await q(5),high=await q(6),expectedBodyCrc=(high*65536+low)>>>0;
  let readyState=0,error=0;
  for(let i=0;i<attempts;i++){
   readyState=await q(0);error=await q(2);
   if(readyState===1||readyState===0&&error!==0)return{ready:readyState===1,settled:true,readyState,error,expectedBodyCrc};
   await this.pause(75);
  }
  return{ready:false,settled:false,readyState,error,expectedBodyCrc};
 }
 async listFiles(){
  const word=async(sub,offset=0)=>{
   await this.io.send(frame(sub,offset));await this.pause(40);
   const start=this.now();
   while(this.now()-start<4000){const a=await this.ack();if(a.sub===sub&&a.status!==255){if(a.status!==0)throw Object.assign(Error('素材列表读取失败，状态 '+a.status),{status:a.status});return a.value;}await this.pause(20);}
   throw Error('素材列表读取超时，请退出其他驱动和后台后重新连接');
  };
  const header=await word(10),length=header&255,count=header>>>8,bytes=[];
  for(let at=0;at<length;at+=2){const v=await word(11,at);bytes.push(v&255);if(at+1<length)bytes.push(v>>>8);}
  const text=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(bytes)).trim();
  const rows=text?text.split(/\r?\n/).map(row=>{const m=/^([A-Za-z0-9_.-]+)\s+(\d+)$/.exec(row);if(!m)throw Error('素材列表格式不完整，未写入文件');return{name:m[1],bytes:Number(m[2])};}):[];
  if(rows.length!==count||new Set(rows.map(row=>row.name.toUpperCase())).size!==count)throw Error('素材列表不完整，未写入文件');
  return rows;
 }
 async probeLyricsTarget(){
  if(await this.queryMain(9)!==MAIN_CAP||await this.queryIps(0)!==IPS_CAP)throw Error('请先安装匹配的主控 V7.1 与本版普通 IPS');
  const flashKiB=await this.queryIps(14),series=await this.queryIps(15);
  if(flashKiB!==1024||series!==13)throw Error('歌词版只支持已读取确认的 1024KiB AT32F435');return{flashKiB,series};
 }
 async status(){
  const mainCap=await this.queryMain(9);if(mainCap!==MAIN_CAP)throw Error('主控不是支持的 V7.1，未进行写入');
  const ipsCap=await this.queryIps(0);if(ipsCap!==IPS_CAP)throw Error('屏幕不是支持的 L6，未进行写入');
  const valid=await this.queryMain(8),hi=await this.queryMain(7),lo=await this.queryMain(6),state=await this.queryIps(4),a=await this.queryIps(5),b=await this.queryIps(6),battery=await this.queryIps(2),mode=await this.queryIps(3),key=await this.queryIps(1);
  return {mainCap,ipsCap,valid:Boolean(valid),mainSeconds:(hi*65536+lo)>>>0,screenState:state,screenTime:decodeTime((b*65536+a)>>>0),battery:battery===65535?null:battery&255,mode,key};
 }
 async calibrate({timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone,rate=32000,rateMilliHz}={}){
  if(!Number.isInteger(rate)||rate<30000||rate>40000)throw Error('无效的计时频率');
  if(rateMilliHz!==undefined&&(!Number.isInteger(rateMilliHz)||rateMilliHz<30000000||rateMilliHz>40000000))throw Error('无效的精确计时频率');
  await this.status();
  if(rateMilliHz!==undefined){
   if(await this.queryMain(24)!==0x4346)throw Error('主控不支持精确校频');
   if(!await this.queryMain(25))throw Error('主控校时记录空间已用完');
  }
  await this.pause(1005-this.now()%1000);const seconds=localSeconds(this.now(),timeZone),id=++this.seq&65535,p=new Uint8Array(8),v=new DataView(p.buffer);v.setUint32(0,seconds,true);v.setUint32(4,rateMilliHz??rate,true);
  try{await this.request(18,id,p);}catch(e){if(e.status===7)throw Error('主控校时写入校验未通过，请保留 USB 连接');if(e.status===5&&rateMilliHz!==undefined)throw Error('主控校时记录空间已用完');throw e;}
  for(let i=0;i<35;i++){
   const s=await this.status(),now=localSeconds(this.now(),timeZone);
   if(s.valid&&s.screenState===0x402&&s.screenTime&&Math.abs(timeDifference(s.mainSeconds,now))<=2&&Math.abs(timeDifference(s.screenTime.seconds,now))<=2)return s;
   await this.pause(1000);
  }
  throw Error('校时指令已应答，但主控与屏幕读回未通过核对');
 }
 async control(op){const id=++this.seq&65535;for(let i=0;;i++)try{return await this.request(op,id);}catch(e){if(e.status!==2||i>=30)throw e;await this.pause(50);}}
 async stock(sub,a=0,b=0,c=0,payload=[]){
  return this.sendAwait(frame(sub,a,b,c,payload),ack=>{
   if(ack.sub!==sub||ack.status===255)return false;if(sub===2&&ack.value!==(a|b<<8))return false;
   if(ack.status!==0&&!(sub===1&&ack.status===6))throw Object.assign(Error(ack.status===4?'素材存储空间不足（状态 4）':'素材指令返回状态 '+ack.status),{status:ack.status,assetCommand:sub});return true;
  });
 }
 async upload(bytes,{replaceConfirmed=false,progress=()=>{}}={}){
  if(!replaceConfirmed)throw Error('请先确认覆盖素材槽位 S1');validateGif(bytes);await this.requireScreen();
  const crc=crc16(bytes),begin=new Uint8Array(17);begin.set(new TextEncoder().encode('S1      GIF'));new DataView(begin.buffer).setUint32(11,bytes.length,true);new DataView(begin.buffer).setUint16(15,crc,true);
  let ok=false,started=false,failure;
  try{
   await this.control(2);started=true;
   await this.stock(1,0,0,0,begin);
   for(let offset=0,seq=0;offset<bytes.length;offset+=232,seq++){await this.stock(2,seq&255,seq>>>8,0,bytes.subarray(offset,offset+232));progress(Math.min(1,(offset+232)/bytes.length));}
   await this.stock(3,0,0,0,[crc&255,crc>>>8]);ok=true;
  }catch(e){failure=e;throw e;}finally{if(started&&!ok)try{await this.stock(4);}catch{}try{await this.control(5);}catch(e){if(!failure)throw e;failure.cleanupError=e.message;}}
 }
 async _removeFont(previous){
  const query=async field=>(await this.request(22,field,[],a=>a.status===0xc0+field)).value;
  const p=new Uint8Array(12),v=new DataView(p.buffer);p.set(new TextEncoder().encode('FNT!'));v.setUint32(4,previous.bodyCrc,true);v.setUint32(8,previous.bytes,true);const id=++this.seq&65535;
  await this.request(27,id,p,a=>a.status===0&&a.value===id);
  const start=this.now();let state;while((state=await query(9))===2){if(this.now()-start>8000)throw Error('字库移除工作线程超时');await this.pause(25);}
  if(state!==1){const result=await query(10);throw Error(result===254?'旧字库不匹配，未移除':'字库移除失败，状态 '+result);}
 }
 async deleteFont(bytes,{deleteConfirmed=false}={}){
  if(deleteConfirmed!==true)throw Error('请先确认仅删除屏内 FONT.BIN');
  return this.deleteFontByIdentity(validateFont(bytes),{deleteConfirmed});
 }
 async deleteFontByIdentity(previous,{deleteConfirmed=false}={}){
  if(deleteConfirmed!==true)throw Error('请先确认仅删除屏内 FONT.BIN');
  if(!Number.isInteger(previous?.bodyCrc)||previous.bodyCrc<0||previous.bodyCrc>0xffffffff||
     !Number.isInteger(previous.bytes)||previous.bytes<256||previous.bytes>4194304)throw Error('字库校验信息无效');
  try{
   await this.request(24,1,[],a=>a.status===0xa6&&a.value===0x4c59);
   await this.request(22,9,[],a=>a.status===0xc9);
  }catch(cause){throw Error('当前屏幕固件未响应字库删除接口。切换到桌宠版前，请在支持字库管理的歌词固件上删除。',{cause});}
  let failure;
  try{await this.control(2);await this._removeFont(previous);return{deleted:true};}
  catch(error){failure=error;throw error;}
  finally{try{await this.control(5);}catch(error){if(!failure)throw error;failure.cleanupError=error.message;}}
 }
 async uploadFont(bytes,{replaceConfirmed=false,replaceExisting=false,previousFont,progress=()=>{}}={}){
  if(!replaceConfirmed)throw Error('请先确认写入或替换 FONT.BIN');const font=validateFont(bytes);
  if(replaceExisting&&!previousFont)throw Error('替换需要当前屏内版本的旧 FONT.BIN');
  if(!replaceExisting&&previousFont)throw Error('请明确选择替换已有字库');
  const previous=replaceExisting?validateFont(previousFont):null;
  await this.request(24,1,[],a=>a.status===0xa6&&a.value===0x4c59);
  const low=(await this.request(22,5,[],a=>a.status===0xc5)).value,high=(await this.request(22,6,[],a=>a.status===0xc6)).value;
  if(high*65536+low!==font.bodyCrc)throw Error('字库与屏幕固件不匹配，未写入');
  const query=async field=>(await this.request(22,field,[],a=>a.status===0xc0+field)).value;
  if(previous)try{await query(9);}catch{throw Error('当前歌词固件缺少字库替换接口，请先更新固件');}
  const crc=crc16(bytes),begin=new Uint8Array(17);begin.set(new TextEncoder().encode('FONT    BIN'));new DataView(begin.buffer).setUint32(11,bytes.length,true);new DataView(begin.buffer).setUint16(15,crc,true);
  let ok=false,started=false,failure;
  try{
   await this.control(2);
   if(previous)await this._removeFont(previous);
   started=true;
   await this.stock(1,0,0,0,begin);
   for(let offset=0,seq=0;offset<bytes.length;offset+=232,seq++){await this.stock(2,seq&255,seq>>>8,0,bytes.subarray(offset,offset+232));progress(Math.min(1,(offset+232)/bytes.length));}
   await this.stock(3,0,0,0,[crc&255,crc>>>8]);ok=true;
  }catch(e){failure=e;throw e;}finally{if(started&&!ok)try{await this.stock(4);}catch{}try{await this.control(5);}catch(e){if(!failure)throw e;failure.cleanupError=e.message;}}
 }
 async enterIap(target){const t=TARGETS[target];if(!t)throw Error('Unknown target');await this.io.send(new Uint8Array(t.boot));await this.close();}
}
export class FlashClient{
 constructor(io,plan,{pause=wait}={}){this.io=io;this.plan=plan;this.pause=pause;}
 static async connect(plan){return new FlashClient(await HidIO.choose(plan.pid,64),plan);}
 async ok(p,timeout=5000){const r=await this.io.exchange(p,()=>true,timeout,2);if(r.length<2||r[0]||r[1])throw Error('烧录应答失败：'+r[0]+','+r[1]);}
 async flash(progress=()=>{}){
  const {bytes,base,pid}=this.plan;if(!validDevice(this.io.device,pid,64))throw Error('目标错误，未擦除');
  if(['lyrics-v1','bongo-v1'].includes(this.plan.variant)&&!this.plan.hardwareChecked)throw Error('请先在 APP 模式读取并核对屏幕芯片信息，未擦除');
  const erase=new Uint8Array(6);erase[0]=0x81;new DataView(erase.buffer).setUint32(2,base,true);
  progress('擦除',0);
  try{await this.ok(erase,20000);}catch(e){throw Error('擦除阶段：'+e.message+'；设备可能仍在升级模式，未确认擦除结果。');}await this.pause(1200);
  for(let off=0;off<bytes.length;off+=62){const n=Math.min(62,bytes.length-off),p=new Uint8Array(n+2);p.set([0x80,n]);p.set(bytes.subarray(off,off+n),2);await this.ok(p);progress('写入',(off+n)/bytes.length);}
  await this.ok(new Uint8Array([0x80,0]));
  const verify=async off=>{const p=new Uint8Array(62);p.set([0x82,56]);new DataView(p.buffer).setUint32(2,base+off,true);p.set(bytes.subarray(off,off+56),6);await this.ok(p);};
  let off=0;for(;off+56<=bytes.length;off+=56){await verify(off);progress('校验',(off+56)/bytes.length);}if(off<bytes.length)await verify(bytes.length-56);
  await this.io.send(new Uint8Array([0x83,0]));await this.io.close().catch(()=>{});progress('完成',1);
 }
}
