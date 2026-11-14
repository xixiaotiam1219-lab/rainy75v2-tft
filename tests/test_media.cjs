// SPDX-License-Identifier: MIT
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Timeline,event,encode,decode}=require('../desktop/netease-timeline.cjs'),{LyricLink}=require('../desktop/lyric-link.cjs');
const {cueFrame,Music}=require('../desktop/music.cjs');
const line=(at,text,pid=50)=>'['+pid+':10:1114/210000:'+at+':INFO:main.cpp(1)] '+text;
test('elog maps bytes without retaining raw logs and reconstructs pause/seek from anchors',()=>{
 const s='日本語 / 简体 / 繁體 / English\n';assert.equal(decode(encode(s)),s);let now=1000;const t=new Timeline({clock:()=>now});t.active=new Map([[50,0]]);
 const apply=(at,text,pid=50)=>{now=at;t.accept(event(line(at,text,pid),now));};
 apply(1000,'"checkPlayPrivilege",{"id":1,"name":"测试曲目","artists":[{"name":"演示"}],"duration":100000}');
 assert.equal(t.resolve({title:'测试曲目',artist:'演示'}),null);
 apply(2000,'"native-player-load",{"songId":1}');now=5000;assert.equal(t.resolve({title:'测试曲目'}).positionMs,3000);
 apply(5500,'"setPlayingPosition",6');apply(6000,'"native-player-state",2');now=7000;assert.equal(t.resolve({title:'测试曲目'}).positionMs,6500);assert.equal(t.resolve({title:'测试曲目'}).status,'Paused');
 apply(8000,'"native-player-state",1');now=9000;assert.equal(t.resolve({title:'测试曲目'}).positionMs,7500);
 apply(9500,'"setPlayingPosition",80',99);now=10000;assert.equal(t.resolve({title:'测试曲目'}).positionMs,8500);assert.equal(t.resolve({title:'其他曲目'}),null);
 apply(11000,'exitApp');assert.equal(t.resolve({title:'测试曲目'}),null);
});

test('long cues keep all characters in timed segments, and offset does not change song progress',()=>{
 const now=100000,media={title:'演示',status:'Playing',timelineReady:true,positionMs:5000,durationMs:20000,positionAt:now};const lines=[{at:0,text:'甲'.repeat(200)},{at:12000,text:'乙'}];
 const middle=cueFrame(media,lines,now),advanced=cueFrame(media,lines,now,false,null,3000);assert.equal(middle.current.length,96);assert.equal(middle.next.length,8);assert.equal(advanced.current.length,8);assert.equal(middle.positionMs,5000);assert.equal(advanced.positionMs,5000);
 const paused=cueFrame({...media,status:'Paused'},lines,now+3000);assert.equal(paused.positionMs,5000);assert.equal(paused.playing,false);
});

test('late lyric response from the previous track cannot replace the new track',async()=>{
 const pending=new Map,m=new Music({fetcher:s=>new Promise(resolve=>pending.set(s.title,resolve)),clock:()=>100000});
 const info=title=>({sessions:[{source:'Tencent.QQMusic',title,artist:'演示',status:'Playing',positionMs:0,durationMs:10000,positionAt:100000}],processes:[]});
 m.accept(info('A'));m.accept(info('B'));pending.get('A')({lines:[{at:0,text:'旧歌词'}],provider:'qq'});await new Promise(r=>setImmediate(r));assert.equal(m.lines.length,0);pending.get('B')({lines:[{at:0,text:'新歌词'}],provider:'qq'});await m.pending;assert.equal(m.frame().current,'新歌词');
});
test('text channel normalizes Japanese/Latin and sends glyph indices with timing only updates',async()=>{
 let committed=0,mode=0;const sent=[];const client={request:async(op,id,payload,test)=>{sent.push({op,id,payload:Buffer.from(payload)});if(op===20)return{sub:13,status:1,value:id};if(op===21){committed=id;return{sub:13,status:0,value:id};}if(op===23){mode=payload[0];return{sub:13,status:1,value:id};}if(op===22){const value=id===0?1:id===1?mode:id===3?committed:id===4?0:id===5?link.crc&65535:id===6?link.crc>>>16:0;return{sub:13,status:0xc0+id,value};}if(op===24)return{sub:13,status:0xa6,value:0x4c59};return{sub:13,status:1,value:id};}};
 const link=new LyricLink(client,require('./font-fixture.cjs').fontFixture());await link.ready();assert.equal(link.titleLimit,16);link.titleLimit=96;assert.deepEqual(link.ids('カ\u3099',96),link.ids('ガ',96));assert.deepEqual(link.ids('e\u0301',96),link.ids('é',96));assert.deepEqual(link.ids('😀',96),[link.fallback]);
 const frame={title:'日本語の歌と简体中文繁體中文 English long title',current:'简体中文 繁體中文 English',next:'君の声が聞こえる',durationMs:200000,positionMs:42000,playing:true,lineElapsedMs:1000,lineDurationMs:10000};await link.setFrame(frame);await link.setMode(1);assert.equal(mode,1);assert.equal(sent.find(x=>x.op===20&&x.payload[0]===0).payload[1],[...frame.title].length);
 const count=sent.filter(x=>x.op===20).length;await link.sync({...frame,positionMs:43000});assert.equal(sent.filter(x=>x.op===20).length,count);const last=sent.at(-1);assert.equal(last.op,25);assert.equal(last.payload.length,17);assert.equal(last.payload.readUInt32LE(0),43000);assert(sent.filter(x=>x.op===20).every(x=>x.payload.length<=194));
});
