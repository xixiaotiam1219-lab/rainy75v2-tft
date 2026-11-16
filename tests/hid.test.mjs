// SPDX-License-Identifier: MIT
import test from 'node:test';import assert from 'node:assert/strict';
import {AppClient,FlashClient,HidIO,validDevice} from '../web/hid.mjs';import {MAIN_CAP,IPS_CAP,ACK_READ,validateBuild,sha256,sum16} from '../web/protocol.mjs';
function device(pid,length){const r={reportId:0,items:[{reportSize:8,reportCount:length}]};return {vendorId:0x36b0,productId:pid,collections:[{usagePage:0xff60,usage:0x61,inputReports:[r],outputReports:[r]}]};}
test('FlashClient covers every byte, including a partial final verify block',async()=>{const b=Uint8Array.from({length:294912},(_,i)=>(i*31+17)&255),plan=await validateBuild(b,{format:'rainy75v2-tft/build-v1',target:'main',applicationBase:0x2000,iapPid:0x3079,bytes:b.length,sha256:await sha256(b)}),memory=new Uint8Array(b.length),coverage=new Uint8Array(b.length);let pos=0,erases=0,end=0;const io={device:device(0x3079,64),close:async()=>{},send:async p=>{assert.equal(p[0],0x83);end++;},exchange:async p=>{if(p[0]===0x81){assert.equal(new DataView(p.buffer).getUint32(2,true),0x2000);erases++;}else if(p[0]===0x80){memory.set(p.slice(2,2+p[1]),pos);pos+=p[1];}else if(p[0]===0x82){const off=new DataView(p.buffer).getUint32(2,true)-0x2000;assert.deepEqual(memory.slice(off,off+56),p.slice(6,62));coverage.fill(1,off,off+56);}else assert.fail('Unexpected command');return new Uint8Array(64);}};await new FlashClient(io,plan,{pause:async()=>{}}).flash();assert.equal(erases,1);assert.equal(end,1);assert.equal(pos,b.length);assert(coverage.every(v=>v===1));assert.deepEqual(memory,b);io.device=device(0x3078,64);await assert.rejects(()=>new FlashClient(io,plan).flash(),/目标错误/);assert.equal(erases,1);});
function appFixture(){let now=5000000,ack={sub:13,status:0,value:0},seconds=null,at=0,cap=MAIN_CAP,writes=0;const packets=[];const io={close:async()=>{},send:async p=>{packets.push(p);const op=p[4],id=p[5]|p[6]<<8,s=seconds===null?0xffffffff:(seconds+Math.floor((now-at)/1000))%86400;if(op===15){const f=p[5],v=f===9?cap:f===8?Number(seconds!==null):f===7?s>>>16:f===6?s&65535:0;ack={sub:13,status:0xd0+f,value:v};}else if(op===11){const f=p[5],bcd=s===0xffffffff?s:parseInt([Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(v=>String(v).padStart(2,'0')).join(''),16);ack={sub:13,status:0xb0+f,value:f===0?IPS_CAP:f===4?(s===0xffffffff?0x401:0x402):f===5?bcd&65535:f===6?bcd>>>16:f===2?83:f===3?1:40};}else if(op===18){const v=new DataView(p.buffer,p.byteOffset,p.byteLength);seconds=v.getUint32(8,true);assert.equal(v.getUint32(12,true),32000);at=now;writes++;ack={sub:13,status:1,value:id};}else assert.fail('Unexpected operation');},exchange:async p=>{assert.deepEqual(p,ACK_READ);const r=new Uint8Array([0xbe,0xe4,14,0x84,4,0,0,ack.sub,ack.status,ack.value&255,ack.value>>>8,0,0,0xed]),s=sum16(r.slice(0,11));r[11]=s&255;r[12]=s>>>8;return r;}};return {client:new AppClient(io,{now:()=>now,pause:async ms=>{now+=ms;}}),packets,writes:()=>writes,reset:()=>{seconds=null;},old:()=>{cap=0x434f;}};}
test('post-boot calibration can recover after counter loss without reflashing',async()=>{const f=appFixture();assert.equal((await f.client.status()).valid,false);const r=await f.client.calibrate({timeZone:'UTC'});assert(r.valid);assert(r.screenTime);assert.equal(f.writes(),1);f.reset();await f.client.calibrate({timeZone:'UTC'});assert.equal(f.writes(),2);assert(f.packets.every(p=>p[1]===0x1a));});
test('old firmware is refused before any write and upload needs explicit replacement',async()=>{const f=appFixture();f.old();await assert.rejects(()=>f.client.calibrate({timeZone:'UTC'}),/V7.1/);assert.equal(f.writes(),0);await assert.rejects(()=>f.client.upload(new Uint8Array(10)),/确认/);assert(validDevice(device(0x3075,256),0x3075,256));assert(!validDevice(device(0x3071,256),0x3075,256));});

test('IAP accepts a short status report while app replies retain exact length',async()=>{
 const listeners=new Set;let output;
 const d={sendReport:async(_,p)=>{output=p;queueMicrotask(()=>{for(const f of listeners){f({reportId:0,data:new DataView(new Uint8Array([0,0]).buffer)});f({reportId:0,data:new DataView(new Uint8Array(64).buffer)});}});},addEventListener:(_,f)=>listeners.add(f),removeEventListener:(_,f)=>listeners.delete(f)};
 const io=new HidIO(d,64);const short=await io.exchange(new Uint8Array([0x81]),()=>true,100,2);assert.equal(short.length,2);assert.equal(output.length,64);assert.equal(listeners.size,0);
 const exact=await io.exchange(new Uint8Array([0x82]),()=>true,100);assert.equal(exact.length,64);assert.equal(listeners.size,0);
});

test('erase has a longer timeout and failure stops before programming',async()=>{
 let calls=0;
 const io={device:device(0x3078,64),exchange:async(p,match,timeout,minLength)=>{calls++;assert.equal(p[0],0x81);assert.equal(timeout,20000);assert.equal(minLength,2);throw Error('设备应答超时');}};
 await assert.rejects(()=>new FlashClient(io,{pid:0x3078,base:0x4000,bytes:new Uint8Array(56)}).flash(),/擦除阶段.*未确认擦除结果/);assert.equal(calls,1);
});

test('asset commands wait past 255 and ignore an old DATA sequence',async()=>{
 let now=0,reads=0;const replies=[{sub:2,status:255,value:7},{sub:2,status:0,value:6},{sub:2,status:0,value:7}];
 const client=new AppClient({send:async()=>{}},{now:()=>now,pause:async ms=>{now+=ms;}});client.ack=async()=>{reads++;return replies.shift();};
 assert.equal((await client.stock(2,7,0,0,[1])).value,7);assert.equal(reads,3);
});

test('file listing parses validated fixed file names and refuses incomplete or duplicate rows',async()=>{
 for(const [text,count,valid] of [['S1.GIF 100\nFONT.BIN 2345\n',2,true],['FONT.BIN 2345\n',2,false],['FONT.BIN 1\nfont.bin 2\n',2,false]]){
  let now=0,packet;const data=new TextEncoder().encode(text);
  const c=new AppClient({send:async p=>{packet=p;}},{now:()=>now,pause:async ms=>{now+=ms;}});
  c.ack=async()=>{const sub=packet[3],at=packet[4];assert(now>=40);return{sub,status:0,value:sub===10?(count<<8)|data.length:data[at]|(data[at+1]||0)<<8};};
  if(valid)assert.deepEqual(await c.listFiles(),[{name:'S1.GIF',bytes:100},{name:'FONT.BIN',bytes:2345}]);
  else await assert.rejects(()=>c.listFiles(),/列表不完整/);
 }
});

test('storage-full replies preserve their status instead of becoming a generic timeout',async()=>{
 const c=new AppClient({send:async()=>{}});c.ack=async()=>({sub:1,status:4,value:0});
 await assert.rejects(()=>c.stock(1),e=>e.status===4&&e.assetCommand===1&&/存储空间不足/.test(e.message));
});

test('cancelling a silent HID read releases listeners but waits for its USB write before another exchange',async()=>{
 const listeners=new Set;let finishWrite;const signal=new AbortController;
 const d={sendReport:()=>new Promise(resolve=>{finishWrite=resolve;}),addEventListener:(_,f)=>listeners.add(f),removeEventListener:(_,f)=>listeners.delete(f)};
 const io=new HidIO(d,256),pending=io.exchange(ACK_READ,()=>true,2500,undefined,{signal:signal.signal});const rejected=assert.rejects(pending,{name:'AbortError'});
 signal.abort();await new Promise(resolve=>setImmediate(resolve));assert.equal(listeners.size,0);assert.equal(io.pending,true);
 await assert.rejects(()=>io.exchange(ACK_READ,()=>true),/Another exchange/);finishWrite();await rejected;assert.equal(io.pending,false);
});

test('an already-cancelled display request sends no packet or acknowledgement read',async()=>{
 const controller=new AbortController;controller.abort();const c=new AppClient({send:async()=>assert.fail('Cancelled request wrote to USB'),exchange:async()=>assert.fail('Cancelled request read from USB')});
 await assert.rejects(()=>c.request(28,42,[3,0,0],undefined,{signal:controller.signal}),{name:'AbortError'});
});

test('only idempotent display settings or queries can retry a dropped packet',async()=>{
 let now=0,sends=0;const c=new AppClient({send:async()=>{sends++;}},{now:()=>now,pause:async ms=>{now+=ms;}});c.ack=async()=>({sub:13,status:sends>=2?1:255,value:sends>=2?10:0});
 await c.request(23,10,[0],undefined,{retryMs:150});assert.equal(sends,2);assert(now>=150&&now<1000);
 for(const op of [18,20,21,25,27,28,30])await assert.rejects(()=>c.request(op,11,[],undefined,{retryMs:150}),/仅允许/);
 assert.equal(sends,2);await assert.rejects(()=>c.request(23,11,[0],undefined,{retryMs:99}),/仅允许/);
});
