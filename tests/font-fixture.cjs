// SPDX-License-Identifier: MIT; synthetic glyphs for protocol tests only.
'use strict';
const {crc32}=require('../desktop/font.cjs');
function fontFixture(){
 const codes=[...new Set([...Array.from({length:95},(_,i)=>i+32),...[...'□ガé日本語の歌と简体中文繁體君声聞英'].map(c=>c.codePointAt(0))])].sort((a,b)=>a-b),offset=256+codes.length*4,b=Buffer.alloc(offset+codes.length*52);
 b.write('R75F');b.writeUInt16LE(2,4);b.writeUInt16LE(256,6);b[8]=b[9]=20;b.writeUInt16LE(50,10);b.writeUInt16LE(52,12);b.writeUInt16LE(1,14);b.writeUInt32LE(codes.length,16);b.writeUInt32LE(256,20);b.writeUInt32LE(offset,24);b.writeUInt32LE(codes.indexOf(0x25a1),28);b.writeUInt32LE(b.length,32);
 codes.forEach((cp,i)=>{b.writeUInt32LE(cp,256+i*4);b[offset+i*52]=cp<127?10:20;b[offset+i*52+1]=1;b.fill(i%2?0xaa:0x55,offset+i*52+2,offset+(i+1)*52);});b.writeUInt32LE(crc32(b.subarray(256)),36);b.writeUInt32LE(crc32(b.subarray(0,256)),40);return b;
}
module.exports={fontFixture};
