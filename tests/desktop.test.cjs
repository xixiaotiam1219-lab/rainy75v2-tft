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

test('20/40 layout discovery handles old firmware and switches without glyph upload',async()=>{
 const {LyricLink}=require('../desktop/lyric-link.cjs'),font=fontFixture(),crc=validateFont(font).crc;
 for(const count of [0,2,4,5]){
  const supported=count>0;
  let layout=1;const operations=[];const client={request:async(op,id,p)=>{operations.push(op);if(op===24)return{value:0x4c59};if(op===26){layout=p[0];return{value:id};}assert.equal(op,22);if(id===8&&!supported||id===11&&count===2)throw Object.assign(Error('unsupported'),{status:5});return{value:({0:1,1:1,2:0,3:42,4:0,5:crc&65535,6:crc>>>16,7:96,8:layout,11:count,12:0x4341})[id]};}};
  const link=new LyricLink(client,font);await link.ready();assert.equal(link.layoutSupported,supported);assert.equal(link.mode,1);
  if(supported){await link.setLayout(0);assert.equal(layout,0);await link.setLayout(1);assert.equal(layout,1);}else await assert.rejects(()=>link.setLayout(1),/不支持/);
  assert.equal(link.layoutCount,count);if(count>=4){await link.setLayout(2);await link.setLayout(3);assert.equal(layout,3);}else await assert.rejects(()=>link.setLayout(2),/不支持/);
  await assert.rejects(()=>link.setLayout(5),/无效/);assert.equal(operations.some(op=>op===20||op===21),false);
 }
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

test('font replacement validates the old pack and waits for a suspended fixed-file worker',async()=>{
 const {AppClient}=await import('../web/hid.mjs'),{crc32}=require('../desktop/font.cjs'),font=fontFixture(),previous=Buffer.from(font),offset=previous.readUInt32LE(24);
 previous[offset+2]^=1;previous.writeUInt32LE(crc32(previous.subarray(256)),36);previous.writeUInt32LE(0,40);previous.writeUInt32LE(crc32(previous.subarray(0,256)),40);const old=validateFont(previous),newCrc=validateFont(font).crc;
 for(const outcome of ['success','wrong-old','missing-cap','wrong-new','timeout','begin-failure']){
  const events=[];let now=0,queued=false,polls=0;const c=new AppClient({},{now:()=>now,pause:async ms=>{now+=ms;}});
  c.request=async(op,id,p)=>{events.push({op,id,p});if(op===24)return{value:0x4c59};if(op===27){assert.equal(events.some(e=>e.control===2),true);assert.equal(Buffer.from(p).subarray(0,4).toString(),'FNT!');assert.equal(new DataView(p.buffer).getUint32(4,true),old.crc);assert.equal(new DataView(p.buffer).getUint32(8,true),previous.length);queued=true;return{status:0,value:id};}assert.equal(op,22);if(id===5)return{value:(outcome==='wrong-new'?newCrc^1:newCrc)&65535};if(id===6)return{value:newCrc>>>16};if(id===10)return{value:254};assert.equal(id,9);if(outcome==='missing-cap')throw Error('unsupported');return{value:!queued?0:outcome==='wrong-old'?7:outcome==='timeout'?2:++polls<3?2:1};};
  c.control=async op=>events.push({control:op});c.stock=async(sub,a,b,d,p)=>{events.push({stock:sub,p});assert(queued&&polls>=3);if(outcome==='begin-failure'&&sub===1)throw Error('begin rejected');return{};};
  const options={replaceConfirmed:true,replaceExisting:true,previousFont:previous};
  if(outcome==='success'){await c.uploadFont(font,options);assert.equal(Buffer.from(events.find(e=>e.stock===1).p).subarray(0,11).toString(),'FONT    BIN');assert.equal(events.some(e=>e.stock===4),false);}
  else await assert.rejects(()=>c.uploadFont(font,options),outcome==='wrong-old'?/旧字库不匹配/:outcome==='missing-cap'?/缺少/:outcome==='wrong-new'?/固件不匹配/:outcome==='timeout'?/超时/:/begin rejected/);
  const changed=events.some(e=>e.control===2);assert.equal(changed,!['missing-cap','wrong-new'].includes(outcome));if(changed)assert.equal(events.at(-1).control,5);
  if(!['success','begin-failure'].includes(outcome))assert.equal(events.some(e=>e.stock!==undefined),false);
  if(outcome==='begin-failure')assert(events.some(e=>e.stock===4));
 }
 const c=new AppClient({});c.request=async()=>assert.fail('Invalid replacement reached device');
 await assert.rejects(()=>c.uploadFont(font,{replaceConfirmed:true,replaceExisting:true}),/旧 FONT/);
 const corrupt=Buffer.from(previous);corrupt[256]^=1;await assert.rejects(()=>c.uploadFont(font,{replaceConfirmed:true,replaceExisting:true,previousFont:corrupt}),/CRC/);
});

test('lost pause ACK resumes rendering without starting a transfer or masking the original error',async()=>{
 const {AppClient}=await import('../web/hid.mjs'),font=fontFixture(),crc=validateFont(font).crc;
 for(const cleanupFails of [false,true]){
  const c=new AppClient({}),controls=[],original=Error('OP2 / ID42188: timeout C1/0');
  c.request=async(op,id)=>({value:op===24?0x4c59:id===5?crc&65535:crc>>>16});
  c.control=async op=>{controls.push(op);if(op===2)throw original;if(cleanupFails)throw Error('resume timeout');};
  c.stock=async()=>assert.fail('No BEGIN, DATA or ABORT allowed before pause succeeds');
  await assert.rejects(()=>c.uploadFont(font,{replaceConfirmed:true}),e=>e===original);
  assert.deepEqual(controls,[2,5]);
  assert.equal(original.cleanupError,cleanupFails?'resume timeout':undefined);
 }
});
test('standalone font deletion is confirmed, guarded, resumes on failure, and never uploads an asset',async()=>{
 const {AppClient}=await import('../web/hid.mjs'),font=fontFixture(),crc=validateFont(font).crc;
 for(const outcome of ['success','wrong-old','missing-cap','timeout']){
  const events=[];let queued=false,polls=0,now=0;const c=new AppClient({},{now:()=>now,pause:async ms=>{now+=ms;}});
  c.request=async(op,id,p)=>{events.push({op,id,p});if(op===24)return{value:0x4c59};if(op===27){assert.equal(events.at(-2).control,2);assert.equal(new DataView(p.buffer).getUint32(4,true),crc);assert.equal(new DataView(p.buffer).getUint32(8,true),font.length);queued=true;return{status:0,value:id};}assert.equal(op,22);if(id===10)return{value:254};assert.equal(id,9);if(outcome==='missing-cap')throw Error('unsupported');return{value:!queued?0:outcome==='wrong-old'?7:outcome==='timeout'?2:++polls<2?2:1};};
  c.control=async op=>events.push({control:op});c.stock=async()=>assert.fail('Deletion must not start any upload');
  if(outcome==='success')assert.deepEqual(await c.deleteFont(font,{deleteConfirmed:true}),{deleted:true});else await assert.rejects(()=>c.deleteFont(font,{deleteConfirmed:true}),outcome==='wrong-old'?/不匹配/:outcome==='missing-cap'?/删除接口/:/超时/);
  assert.equal(events.some(e=>e.control===2),outcome!=='missing-cap');if(outcome!=='missing-cap')assert.equal(events.at(-1).control,5);
 }
 const c=new AppClient({});c.request=async()=>assert.fail('Invalid deletion reached device');
 for(const deleteConfirmed of [false,undefined,'true'])await assert.rejects(()=>c.deleteFont(font,{deleteConfirmed}),/确认/);
 const bad=Buffer.from(font);bad[256]^=1;await assert.rejects(()=>c.deleteFont(bad,{deleteConfirmed:true}),/CRC/);
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
  assert.equal(s.settings.layout,1);assert.equal((await post('/layout',{layout:5})).status,400);assert.equal((await post('/layout',{layout:'1'})).status,400);assert.equal((await post('/layout',{layout:3})).status,200);s=await(await fetch(service.url+'/state')).json();assert.equal(s.wantedMode,1);await post('/mode',{mode:0});
  assert.equal(s.volume.available,false);assert.equal(s.settings.volumeHoldMs,1000);assert.equal((await post('/volume/preview',{})).status,400);
  assert.equal((await post('/volume',{enabled:true,scope:1,style:1,holdMs:1500})).status,200);assert.equal((await post('/volume',{enabled:true,scope:1,style:1,holdMs:3001})).status,400);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'background-settings.json'))).volumeHoldMs,1500);
  for(const [mode,layout]of [[1,0],[1,1],[1,2],[1,3],[1,4],[0,4]]){assert.equal((await post('/screen/next',{})).status,200);s=await(await fetch(service.url+'/state')).json();assert.equal(s.wantedMode,mode);assert.equal(s.settings.layout,layout);}
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'background-settings.json'))).layout,4);
  const raw=Buffer.from(JSON.stringify({text:'[00:00]甲乙'})),split=raw.indexOf(Buffer.from('甲'))+1;
  const body=new ReadableStream({start(controller){controller.enqueue(raw.subarray(0,split));setTimeout(()=>{controller.enqueue(raw.subarray(split));controller.close();},10);}});
  assert.equal((await fetch(service.url+'/lrc',{method:'POST',headers:{'Content-Type':'application/json'},body,duplex:'half'})).status,200);s=await(await fetch(service.url+'/state')).json();assert.equal(s.frame.current,'甲乙');await post('/stop',{});
 }finally{
  if(child.exitCode===null){await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,1000))]);if(child.exitCode===null)child.kill();}
  assert.equal(path.dirname(path.resolve(dir)),base);assert(path.basename(dir).startsWith('rainy75-lyrics-test-'));fs.rmSync(dir,{recursive:true,force:true});
 }
});
