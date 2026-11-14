// SPDX-License-Identifier: MIT
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {rankCandidates,parseLrc,parseJson,rawLrc,fetchLines}=require('../desktop/lyric-provider.cjs');
const {Music}=require('../desktop/music.cjs');
const media={source:'Tencent.QQMusic',title:'Wolves',artist:'Selena Gomez/Marshmello',durationMs:197993};
const song=(id,album,durationMs=197000,artist=media.artist)=>({id,title:'Wolves',artist,album,durationMs});
test('same-name remix, cover and wrong duration cannot replace the playing version',()=>{
 const result=rankCandidates([song('remix','Wolves (MOTi Remix)',184000),song('cover','Wolves',197000,'Other Singer'),song('wrong','Wolves',250000),song('original','Wolves')],media);
 assert.deepEqual(result.map(s=>s.id),['original']);assert.equal(result[0].durationDeltaMs,993);
 assert.deepEqual(rankCandidates([song('original','Wolves')],{...media,title:'Wolves (MOTi Remix)',durationMs:184000}),[]);
 assert.equal(rankCandidates([song('no-duration','Wolves',0)],media,{cross:true}).length,0);
});
test('radio edit suffix and artist aliases are matched without dropping version checks',()=>{
 const m={title:'The Ocean (Radio Edit)',artist:'Mike Perry/Shy Martin',durationMs:183414};
 assert.equal(rankCandidates([{id:'edit',title:'The Ocean',album:'The Ocean (Radio Edit)',artist:'Mike Perry/SHY Martin',durationMs:183000}],m).length,1);
 assert.equal(rankCandidates([{id:'full',title:'The Ocean',album:'The Ocean',artist:m.artist,durationMs:183000}],m).length,0);
});
test('LRC decoder handles numeric entities, JSONP/base64, credits and multiple timestamps',()=>{
 const raw='\uFEFF[ti:演示]\n[00:00.00]作词：某人\n[00:01.20][00:03.400]&#x4F60;&#22909; &amp;amp; 日本語\n[00:05.00]<00:05.10>Hello';
 const encoded=Buffer.from(raw).toString('base64');assert.equal(rawLrc(encoded),raw);
 assert.equal(parseJson('MusicJsonCallback('+JSON.stringify({lyric:encoded})+');').lyric,encoded);
 assert.deepEqual(parseLrc(raw).map(x=>[x.at,x.text]),[[1200,'你好 & 日本語'],[3400,'你好 & 日本語'],[5000,'Hello']]);
 assert.equal(parseLrc('[00:00]Wolves - Selena Gomez/Marshmello\n[00:12]Wolves',{media}).length,1);
});
test('an empty first QQ duplicate does not force cross-platform fallback',async()=>{
 const called=[];const result=await fetchLines(media,{request:async(url)=>{
  const u=new URL(url);called.push(u);
  if(u.hostname==='u.y.qq.com')return{req_0:{data:{body:{song:{list:[{mid:'empty',name:'Wolves',singer:[{name:'Selena Gomez'},{name:'Marshmello'}],interval:197,album:{name:'Wolves'}},{mid:'good',name:'Wolves',singer:[{name:'Selena Gomez'},{name:'Marshmello'}],interval:197,album:{name:'Wolves'}}]}}}}};
  assert.equal(u.hostname,'c.y.qq.com');return{lyric:u.searchParams.get('songmid')==='empty'?'':'[00:12.30]正文\n[00:14]下一句'};
 }});
 assert.equal(result.provider,'qq');assert.equal(result.match.id,'good');assert.equal(result.attempts.length,1);assert.equal(called.length,3);
});
test('title-only search recovers from overly specific artist search',async()=>{
 let searches=0;const result=await fetchLines(media,{request:async url=>{
  const u=new URL(url);if(u.hostname==='u.y.qq.com'){searches++;return{req_0:{data:{body:{song:{list:searches===1?[]:[{mid:'good',name:'Wolves',singer:[{name:'Selena Gomez'},{name:'Marshmello'}],interval:197,album:{name:'Wolves'}}]}}}}};}
  return{lyric:'[00:10]歌词'};
 }});assert.equal(result.match.id,'good');assert.equal(searches,2);
});
const info=(durationMs=197993)=>({sessions:[{...media,status:'Playing',positionAt:100000,positionMs:0,durationMs}],processes:[]});
test('same-track failure retries after backoff without repeating requests on each frame',async()=>{
 let now=100000,calls=0;const m=new Music({clock:()=>now,fetcher:async()=>{calls++;if(calls===1)throw Error('temporary');return{lines:[{at:0,text:'恢复'}],provider:'qq'};}});
 m.accept(info());await m.pending;assert.equal(calls,1);for(let i=0;i<10;i++)m.frame();assert.equal(calls,1);now+=5000;m.frame();await m.pending;assert.equal(calls,2);assert.equal(m.lines[0].text,'恢复');assert.equal(m.error,null);
});
test('same title with different duration has a separate version cache',async()=>{
 let calls=0;const m=new Music({clock:()=>100000,fetcher:async s=>({lines:[{at:0,text:String(s.durationMs)}],provider:'qq',match:{id:String(++calls)}})});
 m.accept(info());await m.pending;m.accept(info(184000));await m.pending;assert.equal(calls,2);assert.equal(m.lines[0].text,'184000');
});
test('local import wins over a pending retry and manual retry can replace it',async()=>{
 let resolve;const m=new Music({clock:()=>100000,fetcher:()=>new Promise(r=>resolve=r)});m.accept(info());m.local('[00:00]本地');resolve({lines:[{at:0,text:'迟来的在线'}],provider:'qq'});await m.pending;assert.equal(m.lines[0].text,'本地');m.retry();resolve({lines:[{at:0,text:'重新匹配'}],provider:'qq'});await m.pending;assert.equal(m.lines[0].text,'重新匹配');
});
