// SPDX-License-Identifier: MIT
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),{EventEmitter}=require('node:events');
const {fontFixture}=require('./font-fixture.cjs'),{validateFont}=require('../desktop/font.cjs'),{usb}=require('../desktop/transport.cjs');
test('browser and desktop agree on font validation; corrupt packs are rejected',async()=>{
 const web=await import('../web/font.mjs'),font=fontFixture(),original=Buffer.from(font);assert.equal(web.validateFont(font).bodyCrc,validateFont(font).crc);assert.deepEqual(font,original);
 for(const at of [0,40,256,font.length-1]){const corrupt=Buffer.from(font);corrupt[at]^=1;assert.throws(()=>validateFont(corrupt));assert.throws(()=>web.validateFont(corrupt));}
});
test('reconnect adopts the actual device mode and committed revision before switching',async()=>{
 const {LyricLink}=require('../desktop/lyric-link.cjs'),font=fontFixture(),crc=validateFont(font).crc;let mode=1;
 const client={request:async(op,id,p)=>{if(op===24)return{status:0xa6,value:0x4c59};if(op===23){mode=p[0];return{status:1,value:id};}assert.equal(op,22);return{status:0xc0+id,value:({0:1,1:mode,2:0,3:42,4:0,5:crc&65535,6:crc>>>16,7:96})[id]};}};
 const link=new LyricLink(client,font);await link.ready();assert.equal(link.mode,1);assert.equal(link.revision,42);assert.equal(link.titleLimit,96);await link.setMode(0);assert.equal(mode,0);
});
test('USB adapter verifies descriptor before opening and pads report ID without accepting receivers',async()=>{
 const handle=new EventEmitter;let opened=0,closed=0,writes=[],ackId=0;
 handle.close=async()=>{closed++;};handle.write=async raw=>{writes.push(raw);assert.equal(raw.length,257);assert.equal(raw[0],0);const p=raw.slice(1);
  if(p[1]===0x1a)ackId=p[5]|p[6]<<8;
  if(p[1]===0xe4){const reply=Buffer.alloc(257);reply.set([0,0xbe,0xe4,14,0x84,4,0,0,13,1,ackId&255,ackId>>>8,0,0,0xed]);const sum=reply.subarray(1,12).reduce((a,b)=>a+b,0);reply[12]=sum&255;reply[13]=sum>>>8;queueMicrotask(()=>{handle.emit('data',Buffer.alloc(10));handle.emit('data',reply);});}return raw.length;};
 const hid={devicesAsync:async()=>[{vendorId:0x36b0,productId:0x3075,usagePage:0xff60,usage:0x61,path:'test-interface'}],HIDAsync:{open:async()=>{opened++;return handle;}}},caps={Usage:0x61,UsagePage:0xff60,InputReportByteLength:257,OutputReportByteLength:257};
 await assert.rejects(()=>usb({hid,readCaps:async()=>({...caps,OutputReportByteLength:65})}),/descriptor/);assert.equal(opened,0);
 const c=await usb({hid,readCaps:async()=>caps});assert.equal((await c.request(20,123,[0,0])).value,123);await c.close();assert.equal(closed,1);assert(writes.length>=2);
 const receiver={...hid,devicesAsync:async()=>[{vendorId:0x36b0,productId:0x3071,usagePage:0xff60,usage:0x61,path:'receiver'}]};await assert.rejects(()=>usb({hid:receiver,readCaps:async()=>caps}),/USB/);assert.equal(opened,1);
});
test('font upload is explicit, verifies format, and writes only the FONT.BIN asset',async()=>{
 const {AppClient}=await import('../web/hid.mjs'),c=new AppClient({});const commands=[],packets=[],fontCrc=validateFont(fontFixture()).crc;c.request=async(op,id,p,accept)=>{if(op===24)return{status:0xa6,value:0x4c59};assert.equal(op,22);return{status:0xc0+id,value:id===5?fontCrc&65535:fontCrc>>>16};};c.control=async op=>commands.push(op);c.stock=async(sub,a,b,d,p)=>{packets.push({sub,a,b,p:Buffer.from(p)});return{status:0};};
 await assert.rejects(()=>c.uploadFont(fontFixture()),/确认/);const bad=fontFixture();bad[256]^=1;await assert.rejects(()=>c.uploadFont(bad,{replaceConfirmed:true}),/CRC/);assert.equal(commands.length,0);
 const font=fontFixture();await c.uploadFont(font,{replaceConfirmed:true});assert.deepEqual(commands,[2,5]);assert.equal(packets[0].p.subarray(0,11).toString(),'FONT    BIN');assert.deepEqual(Buffer.concat(packets.filter(p=>p.sub===2).map(p=>p.p)),font);assert.equal(packets.at(-1).sub,3);
});
test('extended image requires a physical preflight and verifies every byte within Bank2 limits',async()=>{
 const {validateBuild,sha256}=await import('../web/protocol.mjs'),{FlashClient,AppClient}=await import('../web/hid.mjs');
 const bytes=Uint8Array.from({length:540672},(_,i)=>i*17&255),m={format:'rainy75v2-tft/build-v1',target:'ips',variant:'lyrics-v1',bytes:bytes.length,sha256:await sha256(bytes),applicationBase:0x4000,iapPid:0x3078,requiredFlashKiB:1024,requiredSeries:13,codeStart:0x08080000,imageEnd:0x08088000,iapEraseEnd:0x080c0000};
 await assert.rejects(()=>validateBuild(bytes,{...m,requiredFlashKiB:512}),/边界/);const plan=await validateBuild(bytes,m),report={reportId:0,items:[{reportSize:8,reportCount:64}]},memory=new Uint8Array(1048576).fill(255),coverage=new Uint8Array(bytes.length);let pos=0x4000,erases=0;
 memory[0xfc000]=37;const io={device:{vendorId:0x36b0,productId:0x3078,collections:[{usagePage:0xff60,usage:0x61,inputReports:[report],outputReports:[report]}]},close:async()=>{},send:async p=>assert.equal(p[0],0x83),exchange:async p=>{
  if(p[0]===0x81){erases++;assert.equal(new DataView(p.buffer).getUint32(2,true),0x4000);memory.fill(255,0x4000,0xc0000);}
  else if(p[0]===0x80){assert(pos+p[1]<=0x88000);memory.set(p.slice(2,2+p[1]),pos);pos+=p[1];}
  else if(p[0]===0x82){const at=new DataView(p.buffer).getUint32(2,true);assert.deepEqual(memory.slice(at,at+56),p.slice(6,62));coverage.fill(1,at-0x4000,at-0x4000+56);}return new Uint8Array(2);
 }};
 await assert.rejects(()=>new FlashClient(io,plan).flash(),/芯片/);assert.equal(erases,0);
 const c=new AppClient({});c.queryMain=async()=>0x4350;c.queryIps=async f=>f===0?0x5536:f===14?512:13;await assert.rejects(()=>c.probeLyricsTarget(),/1024/);c.queryIps=async f=>f===0?0x5536:f===14?1024:13;assert.equal((await c.probeLyricsTarget()).flashKiB,1024);
 plan.hardwareChecked=true;await new FlashClient(io,plan,{pause:async()=>{}}).flash();assert.equal(erases,1);assert(coverage.every(v=>v===1));assert.equal(memory[0xfc000],37);assert.equal(pos,0x88000);
});
test('offline console never opens hardware and persists offset, switches pages, rejects foreign origin',async()=>{
 const base=path.resolve(os.tmpdir()),dir=fs.mkdtempSync(path.join(base,'rainy75-lyrics-test-')),child=spawn(process.execPath,[path.resolve(__dirname,'../desktop/bridge.cjs'),'--demo'],{env:{...process.env,RAINY75_DATA:dir},windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 try{
  const start=Date.now();let service;while(Date.now()-start<6000){try{service=JSON.parse(fs.readFileSync(path.join(dir,'background-service.json')));break;}catch{}await new Promise(r=>setTimeout(r,50));}assert(service,output);
  const post=(p,body,headers={})=>fetch(service.url+p,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const html=await(await fetch(service.url)).text();assert(html.includes('提前 0.5 秒'));assert(html.includes('恢复默认'));
  let s=await(await fetch(service.url+'/state')).json();assert(s.demo);assert.equal(s.connected,false);assert.equal(s.hotkey.ready,false);
  assert.equal((await post('/settings',{offsetMs:700})).status,200);assert.equal((await post('/settings',{offsetMs:10001})).status,400);assert.equal((await post('/settings',{offsetMs:0},{Origin:'https://unrelated.invalid'})).status,403);
  assert.equal((await post('/startup',{enabled:true})).status,400);await post('/mode',{mode:0});s=await(await fetch(service.url+'/state')).json();assert.equal(s.wantedMode,0);assert.equal(s.settings.offsetMs,700);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'background-settings.json'))).offsetMs,700);
  const raw=Buffer.from(JSON.stringify({text:'[00:00]甲乙'})),split=raw.indexOf(Buffer.from('甲'))+1;
  const body=new ReadableStream({start(controller){controller.enqueue(raw.subarray(0,split));setTimeout(()=>{controller.enqueue(raw.subarray(split));controller.close();},10);}});
  assert.equal((await fetch(service.url+'/lrc',{method:'POST',headers:{'Content-Type':'application/json'},body,duplex:'half'})).status,200);s=await(await fetch(service.url+'/state')).json();assert.equal(s.frame.current,'甲乙');await post('/stop',{});
 }finally{
  if(child.exitCode===null){await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,1000))]);if(child.exitCode===null)child.kill();}
  assert.equal(path.dirname(path.resolve(dir)),base);assert(path.basename(dir).startsWith('rainy75-lyrics-test-'));fs.rmSync(dir,{recursive:true,force:true});
 }
});
