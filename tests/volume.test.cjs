// SPDX-License-Identifier: MIT; simulated events only, no system/device writes.
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {Volume,VolumeDispatcher}=require('../desktop/volume.cjs'),{LyricLink}=require('../desktop/lyric-link.cjs');
test('volume snapshots are silent; changes deduplicate, mute and reject malformed data',()=>{
 let now=100;const v=new Volume({clock:()=>now});v.accept({event:'volume',level:30,muted:false,initial:true});assert.equal(v.event,null);assert(v.state().available);
 v.accept({event:'volume',level:31,muted:false});assert.equal(v.event.version,1);v.accept({event:'volume',level:31,muted:false});assert.equal(v.version,1);
 now++;v.accept({event:'volume',level:31,muted:true});assert.equal(v.event.version,2);assert(v.event.muted);assert.equal(v.event.at,101);
 for(const e of [null,{}, {event:'volume',level:-1,muted:false},{event:'volume',level:30.5,muted:false},{event:'volume',level:101,muted:false},{event:'volume',level:40,muted:1},{event:'volume',level:40,muted:false,initial:'true'}])v.accept(e);
 assert.equal(v.version,2);v.preview();assert.equal(v.version,3);assert.equal(v.level,31);v.accept({event:'volume',level:50,muted:false,initial:true});assert.equal(v.version,3);assert.equal(v.level,50);
});
test('helper spawn failure clears child and retries hidden after backoff',async()=>{
 let now=0,started=0,last;const v=new Volume({clock:()=>now,spawnHelper:(exe,args,opts)=>{started++;assert.equal(exe,'powershell.exe');assert(args.includes('-Mta'));assert(opts.windowsHide);const p=new EventEmitter;for(const s of ['stdin','stdout','stderr'])p[s]=new PassThrough;p.unref=()=>{};p.kill=()=>{};p.exitCode=null;last=p;return p;}});
 v.start();last.emit('error',Error('missing executable'));assert.equal(v.child,null);v.start();assert.equal(started,1);now=5001;v.start();assert.equal(started,2);last.exitCode=0;setImmediate(()=>last.emit('exit',0));await v.stop();assert.equal(v.child,null);
});
test('volume pump coalesces latest values, clears on scope changes and consumes stale/reconnect events',async()=>{
 let now=0;const v=new Volume({clock:()=>now}),d=new VolumeDispatcher(v,{clock:()=>now}),sent=[];let busy=false;
 const link={volumeSupported:true,mode:1,layout:4,async setVolume(e,o){assert(!busy);busy=true;await Promise.resolve();sent.push([e&&{...e},o]);busy=false;}},s={volumeEnabled:true,volumeScope:0,volumeStyle:0,volumeHoldMs:1000};
 await d.pump(link,s);assert.equal(sent.length,1);assert.equal(sent[0][0],null);
 v.accept({event:'volume',level:20,muted:false});await d.pump(link,s);assert.equal(sent.at(-1)[0].level,20);
 now=10;v.accept({event:'volume',level:21,muted:false});await d.pump(link,s);now=20;v.accept({event:'volume',level:22,muted:false});await d.pump(link,s);assert.equal(sent.length,2);
 now=85;await d.pump(link,s);assert.equal(sent.length,3);assert.equal(sent.at(-1)[0].level,22);
 now=170;v.accept({event:'volume',level:23,muted:false});now=2400;await d.pump(link,s);assert.equal(sent.length,3);
 link.mode=0;await d.pump(link,s);v.accept({event:'volume',level:24,muted:false});await d.pump(link,s);assert.equal(sent.at(-1)[0],null);
 s.volumeScope=1;await d.pump(link,s);now+=100;v.preview();await d.pump(link,s);assert.equal(sent.at(-1)[0].level,24);
 s.volumeEnabled=false;await d.pump(link,s);assert.equal(sent.at(-1)[0],null);v.accept({event:'volume',level:25,muted:false});await d.pump(link,s);assert.equal(sent.at(-1)[0],null);
 s.volumeEnabled=true;now+=100;const other={...link};await d.pump(other,s);assert.equal(sent.at(-1)[0],null);await d.pump(other,s);assert.equal(sent.at(-1)[0],null);
 other.setVolume=async()=>{throw Error('timeout');};v.preview();await d.pump(other,s);assert.match(d.error,/timeout/);
});
test('OP30 is six bounded bytes; rejects old firmware and never uploads assets',async()=>{
 const sent=[],l=Object.create(LyricLink.prototype);Object.assign(l,{volumeSupported:true,revision:1,c:{request:async(...a)=>sent.push(a)}});
 await l.setVolume({level:63,muted:false},{scope:1,style:1,holdMs:1000});assert.equal(sent[0][0],30);assert.deepEqual([...sent[0][2]],[63,0,1,1,232,3]);assert.equal(sent[0][4].pollMs,3);
 await l.setVolume(null);assert.equal(sent[1][2][0],255);
 for(const e of [{level:101,muted:false},{level:30,muted:0}])await assert.rejects(()=>l.setVolume(e),/无效/);
 for(const o of [{scope:2},{style:2},{holdMs:399},{holdMs:3001}])await assert.rejects(()=>l.setVolume({level:20,muted:false},o),/无效/);
 l.volumeSupported=false;await assert.rejects(()=>l.setVolume(null),/不支持/);assert.equal(sent.length,2);
});
test('cover yields insert volume into the same serial request stream without corrupting cover chunks',async()=>{
 const {packCover,palette}=require('../desktop/cover.cjs');
 const log=[],l=Object.create(LyricLink.prototype);let busy=false;
 Object.assign(l,{coverSupported:true,coverIndexed:true,coverSmall:true,volumeSupported:true,revision:5,c:{request:async(op,id,p)=>{assert(!busy);busy=true;await Promise.resolve();log.push({op,id,p:Buffer.from(p)});busy=false;return{value:id,status:1};}}});
 let revision;l.q=async f=>f===13?1:revision;l.onYield=async()=>{await l.setVolume({level:35,muted:false});};
 const pixels=Buffer.alloc(8192,127),art={bytes:pixels,palette:palette(pixels),compact:packCover(pixels,48)};const old=l.c.request;l.c.request=async(...a)=>{if(a[0]===28&&a[2][0]===0)revision=Buffer.from(a[2]).readUInt16LE(1);return old(...a);};
 const r=await l.setCover(art);assert.equal(r.bytes,1856);const chunks=log.filter(x=>x.op===28&&x.p[0]===1);assert.equal(chunks.length,9);assert(log.filter(x=>x.op===30).length>=chunks.length);assert(Buffer.concat(chunks.map(x=>x.p.subarray(5))).equals(art.compact));assert(log.every(x=>x.op===28||x.op===30));
});
