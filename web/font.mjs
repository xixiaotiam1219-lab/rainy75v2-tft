// SPDX-License-Identifier: MIT
export function crc32(bytes){let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=crc>>>1^((0-(crc&1))&0xedb88320);}return(~crc)>>>0;}
export function validateFont(b){
 if(!(b instanceof Uint8Array)||b.length<256||b.length>4194304)throw Error('无效的字库大小');
 const v=new DataView(b.buffer,b.byteOffset,b.byteLength),u16=o=>v.getUint16(o,true),u32=o=>v.getUint32(o,true);
 if(new TextDecoder().decode(b.subarray(0,4))!=='R75F'||u16(4)!==2||u16(6)!==256||b[8]!==20||b[9]!==20||u16(10)!==50||u16(12)!==52||u16(14)!==1)throw Error('需要 R75F/2 20px 字库');
 const count=u32(16),offset=u32(24),header=Uint8Array.from(b.subarray(0,256));header.fill(0,40,44);
 if(!count||count>65535||u32(20)!==256||offset!==256+count*4||u32(28)>=count||u32(32)!==b.length||b.length!==offset+count*52||crc32(b.subarray(256))!==u32(36)||crc32(header)!==u32(40))throw Error('字库范围或 CRC 校验失败');
 let last=-1;for(let i=0;i<count;i++){const cp=u32(256+i*4),at=offset+i*52;if(cp<=last||cp>0x10ffff||cp>=0xd800&&cp<=0xdfff||b[at]<1||b[at]>20||b[at+1]&~1)throw Error('无效的字库索引或字形');last=cp;}
 return{count,bodyCrc:u32(36),bytes:b.length};
}
