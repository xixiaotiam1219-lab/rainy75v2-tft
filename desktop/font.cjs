// SPDX-License-Identifier: MIT
'use strict';
function crc32(bytes){let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=crc>>>1^((0-(crc&1))&0xedb88320);}return(~crc)>>>0;}
function validateFont(input){
 const b=Buffer.from(input);if(b.length<256||b.length>4194304||b.toString('ascii',0,4)!=='R75F'||b.readUInt16LE(4)!==2||b.readUInt16LE(6)!==256||b[8]!==20||b[9]!==20||b.readUInt16LE(10)!==50||b.readUInt16LE(12)!==52||b.readUInt16LE(14)!==1)throw Error('Unsupported R75F/2 font');
 const count=b.readUInt32LE(16),offset=b.readUInt32LE(24),fallback=b.readUInt32LE(28),crc=b.readUInt32LE(36),header=Buffer.from(b.subarray(0,256));header.fill(0,40,44);
 if(!count||count>65535||b.readUInt32LE(20)!==256||offset!==256+count*4||fallback>=count||b.readUInt32LE(32)!==b.length||b.length!==offset+count*52||crc32(b.subarray(256))!==crc||crc32(header)!==b.readUInt32LE(40))throw Error('Font bounds/CRC mismatch');
 let last=-1;for(let i=0;i<count;i++){const cp=b.readUInt32LE(256+i*4),at=offset+i*52;if(cp<=last||cp>0x10ffff||cp>=0xd800&&cp<=0xdfff||b[at]<1||b[at]>20||b[at+1]&~1)throw Error('Invalid font index or glyph');last=cp;}
 return{count,offset,fallback,crc};
}
module.exports={crc32,validateFont};
