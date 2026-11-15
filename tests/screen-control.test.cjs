// SPDX-License-Identifier: MIT; serial protocol fixtures, no HID access.
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{applyScreen}=require('../desktop/screen-control.cjs'),{LyricLink}=require('../desktop/lyric-link.cjs'),{fontFixture}=require('./font-fixture.cjs');
test('leaving player prioritizes mode and does not wait for layout or typography',async()=>{
 const calls=[],l={mode:1,layout:4,layoutSupported:true,textSupported:true,textSize:20,textStyle:1,async setMode(n){calls.push('mode');this.mode=n;},setLayout(){assert.fail('Unneeded layout change');},setTypography(){assert.fail('Unneeded font change');}};
 await applyScreen(l,()=>({mode:0,layout:0,textSize:30,textStyle:0}));assert.deepEqual(calls,['mode']);assert.equal(l.mode,0);
});
test('screen controls coalesce a new target arriving during an awaited packet',async()=>{
 let target={mode:1,layout:0,textSize:30,textStyle:0};const calls=[],l={mode:1,layout:4,layoutSupported:true,async setLayout(n){calls.push('layout '+n);this.layout=n;target={...target,mode:0};},async setMode(n){calls.push('mode '+n);this.mode=n;}};
 await applyScreen(l,()=>target);assert.deepEqual(calls,['layout 0','mode 0']);assert.equal(l.mode,0);
});
test('pending glyph preparation yields to screen switch before the glyph job commits',async()=>{
 let mode=1,committed=0,rev,field=0,desired=1,busy=false;const operations=[];
 const c={request:async(op,id,p)=>{assert(!busy,'Concurrent HID request');busy=true;await Promise.resolve();operations.push(op===22?'q'+id:op);let value=id;
  if(op===20){if(++field===1)desired=0;}
  else if(op===21)rev=id;
  else if(op===23){mode=p[0];}
  else if(op===22){if(id===1)value=mode;else if(id===3)value=committed=rev;else if(id===2)value=0;else assert.fail('Unexpected query');}
  busy=false;return{status:op===21?0:1,value};}};
 const l=new LyricLink(c,fontFixture());l.mode=1;l.layout=4;l.layoutSupported=true;l.onYield=()=>applyScreen(l,()=>({mode:desired,layout:4}));
 await l.setFrame({title:'A',current:'B',next:'C'});assert.equal(mode,0);assert(operations.indexOf(23)<operations.indexOf(21));assert.equal(committed,rev);
});
test('cover publish polling yields screen priority while preserving a single request stream',async()=>{
 let rev,actualLayout=4,targetLayout=4,polls=0,busy=false;const operations=[];
 const c={request:async(op,id,p)=>{assert(!busy);busy=true;await Promise.resolve();operations.push(op===22?'q'+id:op);let value=id,status=1;
  if(op===28){rev=p.readUInt16LE(1);status=0;}
  else if(op===26)actualLayout=p[0];
  else if(op===22){if(id===13){polls++;value=polls>=2?1:2;targetLayout=0;}else if(id===14)value=rev;else if(id===8)value=actualLayout;else assert.fail('Unexpected query');}
  busy=false;return{status,value};}};
 const l=new LyricLink(c,fontFixture());Object.assign(l,{coverSupported:true,mode:1,layout:4,layoutSupported:true,layoutCount:5});l.onYield=()=>applyScreen(l,()=>({mode:1,layout:targetLayout}));
 await l.setCover(null);assert.equal(actualLayout,0);assert(operations.indexOf(26)<operations.lastIndexOf('q13'));
});

test('a lost cover DATA reply is cancelled before the 8s timeout; a late reply cannot complete the next mode command',async()=>{
 const {AppClient}=await import('../web/hid.mjs'),{sum16}=await import('../web/protocol.mjs');let now=0,mode=1,ack,stale,reads=0;const ops=[],cancel=new AbortController;
 const io={send:async p=>{const op=p[4],id=p[5]|p[6]<<8;ops.push({op,kind:p[8]});if(op===28){ack=p[8]===1?{status:255,value:0}:{status:1,value:id};if(p[8]===1)stale={status:1,value:id};}else if(op===23){mode=p[8];ack={status:1,value:id};}else if(op===22){assert.equal(id,1);ack={status:0xc1,value:mode};}else assert.fail('Unexpected command');},exchange:async()=>{reads++;const a=ops.at(-1).op===23&&stale?stale:ack;if(a===stale)stale=null;const b=Uint8Array.from([0xbe,0xe4,14,0x84,4,0,0,13,a.status,a.value&255,a.value>>>8,0,0,0xed]),s=sum16(b.slice(0,11));b[11]=s&255;b[12]=s>>>8;return b;}};
 const c=new AppClient(io,{now:()=>now,pause:async ms=>{now+=ms;if(ops.at(-1).op===28)cancel.abort();}}),l=new LyricLink(c,fontFixture());Object.assign(l,{coverSupported:true,coverSmall:true,mode:1,layout:4});
 const art={bytes:Buffer.alloc(8192),palette:Buffer.alloc(8),compact:Buffer.alloc(1856)};
 await assert.rejects(()=>l.setCover(art,{signal:cancel.signal}),{name:'AbortError'});assert(now<100);assert.equal(ops.filter(x=>x.op===28).length,2);assert(!ops.some(x=>x.op===28&&x.kind===2));
 await l.setMode(0);assert.equal(l.mode,0);assert.equal(mode,0);assert(reads>=5);assert(ops.every(x=>[22,23,28].includes(x.op)));
});

test('a missing OP20 reply can be preempted, and the next frame restages all fields under a new revision',async()=>{
 const {AppClient}=await import('../web/hid.mjs'),{sum16}=await import('../web/protocol.mjs');let now=0,mode=1,ack,drop=true,rev,committed=0;const fields=new Set,ops=[],cancel=new AbortController;
 const c=new AppClient({send:async p=>{const op=p[4],id=p[5]|p[6]<<8;ops.push(op);ack={status:1,value:id};if(op===20){if(rev!==id){rev=id;fields.clear();}fields.add(p[8]);if(drop)ack={status:255,value:0};}else if(op===21){assert.equal(fields.size,3);committed=id;ack.status=0;}else if(op===23)mode=p[8];else if(op===22){ack={status:0xc0+(id&15),value:id===1?mode:id===3?committed:0};}else assert.fail('Unexpected command');},exchange:async()=>{const b=Uint8Array.from([0xbe,0xe4,14,0x84,4,0,0,13,ack.status,ack.value&255,ack.value>>>8,0,0,0xed]),s=sum16(b.slice(0,11));b[11]=s&255;b[12]=s>>>8;return b;}},{now:()=>now,pause:async ms=>{now+=ms;if(drop)cancel.abort();}}),l=new LyricLink(c,fontFixture());l.mode=1;
 await assert.rejects(()=>l.setFrame({title:'A',current:'B',next:'C'},{signal:cancel.signal}),{name:'AbortError'});assert(now<100);assert.equal(l.pendingFrame,undefined);assert.deepEqual(ops,[20]);const abandoned=rev;
 drop=false;await l.setMode(0);const current=await l.setFrame({title:'D',current:'E',next:'F'});assert.notEqual(current,abandoned);assert.equal(committed,current);assert.equal(fields.size,3);
});

test('cancelled OP21 wait preserves its queued job; restaging waits for that job to finish',async()=>{
 const cancel=new AbortController;let polls=0,queued=false,committed=0,first=true;const operations=[];
 const c={request:async(op,id,p)=>{operations.push(op===22?'q'+id:op);if(op===20){assert(!queued,'Overwrote a queued glyph job');return{status:1,value:id};}if(op===21){committed=id;if(first){first=false;queued=true;cancel.abort();}return{status:0,value:id};}if(op===22){if(id===4){polls++;if(polls>=2)queued=false;return{value:queued?1:0};}if(id===3)return{value:committed};if(id===2)return{value:0};}assert.fail('Unexpected request');}};
 const l=new LyricLink(c,fontFixture());await assert.rejects(()=>l.setFrame({title:'A',current:'B',next:'C'},{signal:cancel.signal}),{name:'AbortError'});assert.equal(l.pendingFrame,committed);
 const at=operations.length;await l.setFrame({title:'D',current:'E',next:'F'});assert(polls>=2);assert.deepEqual(operations.slice(at,at+2),['q4','q4']);assert.equal(l.pendingFrame,undefined);
});
