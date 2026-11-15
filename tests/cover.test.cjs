// SPDX-License-Identifier: MIT
const test=require('node:test'),assert=require('node:assert/strict'),{palette,packCover,Cover}=require('../desktop/cover.cjs'),{crc32}=require('../desktop/font.cjs'),{fontFixture}=require('./font-fixture.cjs'),{LyricLink}=require('../desktop/lyric-link.cjs');
test('temporary cover channel sends only bounded RAM chunks, verifies CRC, and waits for GUI publish',async()=>{
 const bytes=Buffer.alloc(8192);for(let i=0;i<4096;i++)bytes.writeUInt16LE(i*15&65535,i*2);const art={bytes,palette:palette(bytes)},events=[];let rev,received=0,committed=0,polls=0;
 const client={request:async(op,id,p)=>{events.push(op);if(op===22){if(id===14&&++polls>2)committed=rev;return{value:id===14?committed:committed===rev?1:2};}assert.equal(op,28);assert(p.length<=229);if(p[0]===0){rev=p.readUInt16LE(1);assert.deepEqual([...p.subarray(3,6)],[64,64,1]);assert.equal(p.readUInt32LE(6),crc32(bytes));assert.deepEqual(p.subarray(10),art.palette);}else if(p[0]===1){assert.equal(p.readUInt16LE(1),rev);assert.equal(p.readUInt16LE(3),received);assert.deepEqual(p.subarray(5),bytes.subarray(received,received+p.length-5));received+=p.length-5;}else{assert.equal(received,8192);return{status:0,value:id};}return{status:1,value:id};}};
 const link=new LyricLink(client,fontFixture());link.coverSupported=true;await link.setCover(art);assert.equal(received,8192);assert.equal(committed,rev);assert(events.every(op=>op===28||op===22));assert.equal(art.palette.length,8);await assert.rejects(()=>link.setCover({bytes:Buffer.alloc(2),palette:art.palette}),/格式/);
});
test('cover selection ignores late old songs and never starts parallel image helpers',async()=>{
 const pending=[],reader=media=>new Promise(resolve=>pending.push({media,resolve})),c=new Cover({reader});const a={source:'QQMusic',title:'A'},b={source:'QQMusic',title:'B'},flush=()=>new Promise(r=>setImmediate(r));
 c.update(a);c.update(b);assert.equal(pending.length,1);pending[0].resolve({hash:'old'});await flush();assert.equal(c.result,null);c.update(b);assert.equal(pending.length,2);pending[1].resolve({hash:'new'});await flush();assert.equal(c.result.hash,'new');c.update(b);assert.equal(pending.length,2);c.update(null);assert.equal(c.result,null);
});
test('six-bit cover packing preserves 64-color pixels at every byte boundary and shrinks to 3200 bytes',()=>{
 for(const varied of [false,true]){const raw=Buffer.alloc(8192),colors=Array.from({length:64},(_,i)=>(i%32)<<11|i<<5|i%32);for(let i=0;i<4096;i++)raw.writeUInt16LE(colors[varied?i%64:i?0:63],i*2);const packed=packCover(raw);assert.equal(packed.length,3200);
  for(let i=0;i<4096;i++){const bit=i*6,at=128+(bit>>>3),index=((packed[at]|(packed[at+1]||0)<<8)>>>(bit&7))&63;assert.equal(packed.readUInt16LE(index*2),raw.readUInt16LE(i*2));}
 }
});
test('native-size cover pack retains the exact displayed 48px samples in 1856 bytes',()=>{
 const raw=Buffer.alloc(8192);for(let i=0;i<4096;i++)raw.writeUInt16LE((i%32)<<11|(i%64)<<5|i%32,i*2);const p=packCover(raw,48);assert.equal(p.length,1856);
 for(let y=0;y<48;y++)for(let x=0;x<48;x++){const i=y*48+x,bit=i*6,at=128+(bit>>>3),index=((p[at]|(p[at+1]||0)<<8)>>>(bit&7))&63;assert.equal(p.readUInt16LE(index*2),raw.readUInt16LE((Math.floor(y*4/3)*64+Math.floor(x*4/3))*2));}
});
test('typography can change without uploading a font or changing the text masks',async()=>{
 let size=30,style=0;const ops=[],c={request:async(op,id,p)=>{ops.push(op);if(op===29){[size,style]=p;return{status:1,value:id};}assert.equal(op,22);return{value:id===21?size:style};}},link=new LyricLink(c,fontFixture());link.textSupported=true;
 for(const [s,t]of[[20,0],[30,1],[40,0],[30,0]]){await link.setTypography(s,t);assert.equal(link.textSize,s);assert.equal(link.textStyle,t);}assert(ops.every(op=>op===22||op===29));await assert.rejects(()=>link.setTypography(28,0),/无效/);await assert.rejects(()=>link.setTypography(30,2),/无效/);
});
