// SPDX-License-Identifier: MIT
'use strict';
const fs=require('node:fs'),{FONT}=require('./config.cjs'),{validateFont}=require('./font.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class LyricLink{
 constructor(client,font=fs.readFileSync(FONT)){
  validateFont(font);
  this.c=client;this.crc=font.readUInt32LE(36);this.lookup=new Map;const count=font.readUInt32LE(16);for(let i=0;i<count;i++)this.lookup.set(font.readUInt32LE(256+i*4),i);this.fallback=font.readUInt32LE(28);this.revision=1000;this.mode=0;this.titleLimit=16;this.layout=0;this.layoutSupported=false;
 }
 async q(field){return(await this.c.request(22,field,[],a=>a.status===0xc0+(field&15))).value;}
 async ready(){
  await this.c.request(24,1,[],a=>a.status===0xa6&&a.value===0x4c59);
  const started=Date.now();while(Date.now()-started<7000){const ready=await this.q(0),error=await this.q(2);if(ready===1)break;if(error)throw Error('屏幕字库初始化失败，状态 '+error);await sleep(50);}
  if(await this.q(0)!==1)throw Error('屏幕字库未就绪');
  if(((await this.q(6))*65536+(await this.q(5)))!==this.crc)throw Error('屏幕与电脑使用的字库不同');
  const until=Date.now()+7000;while(await this.q(4)){if(Date.now()>until)throw Error('等待已有字形任务完成超时');await sleep(30);}this.revision=await this.q(3);
  try{const limit=await this.q(7);if(limit>=16&&limit<=96)this.titleLimit=limit;}catch{}
  try{const layout=await this.q(8);if(layout===0||layout===1){this.layout=layout;this.layoutSupported=true;}}catch(e){if(!e.status)throw e;}
  this.mode=await this.q(1);return this.mode;
 }
 ids(text,max){const chars=[...String(text||'').normalize('NFC').replace(/[\x00-\x1f\x7f]/g,' ')];if(chars.length>max){chars.length=max;chars[max-1]='…';}return chars.map(c=>this.lookup.get(c.codePointAt(0))??this.fallback);}
 timing(frame){const b=Buffer.alloc(17);const duration=Math.max(0,Math.min(86400000,Math.round(frame.durationMs||0))),position=Math.max(0,Math.min(duration,Math.round(frame.positionMs||0)));b.writeUInt32LE(position,0);b.writeUInt32LE(duration,4);b[8]=frame.playing?1:0;b.writeUInt32LE(Math.max(0,Math.min(600000,Math.round(frame.lineElapsedMs||0))),9);b.writeUInt32LE(Math.max(0,Math.min(600000,Math.round(frame.lineDurationMs||0))),13);return b;}
 async setFrame(frame){const rev=++this.revision&65535;
  for(const [kind,text]of [[0,frame.title],[1,frame.current],[2,frame.next]]){const ids=this.ids(text,kind?96:this.titleLimit),p=Buffer.alloc(2+2*ids.length);p[0]=kind;p[1]=ids.length;ids.forEach((id,i)=>p.writeUInt16LE(id,2+2*i));await this.c.request(20,rev,p);}
  try{await this.c.request(21,rev,this.timing(frame),a=>(a.status===0||a.status===1)&&a.value===rev);}catch(e){if(await this.q(3)!==rev&&!await this.q(4))throw e;}
  const started=Date.now();while(Date.now()-started<7000){if(await this.q(3)===rev)return rev;const error=await this.q(2);if(error)throw Error('字形缓存生成失败，状态 '+error);await sleep(25);}throw Error('字形缓存提交超时');
 }
 async sync(frame){const id=++this.revision&65535;await this.c.request(25,id,this.timing(frame));}
 async setMode(mode){const value=mode?1:0;await this.c.request(23,++this.revision&65535,[value]);const start=Date.now();while(Date.now()-start<2500){if(await this.q(1)===value){this.mode=value;return;}await sleep(30);}throw Error('等待缓存动画新帧以切换界面超时');}
 async setLayout(value){if(value!==0&&value!==1)throw Error('无效歌词字号');if(!this.layoutSupported)throw Error('当前屏幕固件不支持字号切换');await this.c.request(26,++this.revision&65535,[value]);if(await this.q(8)!==value)throw Error('歌词字号读回不一致');this.layout=value;}
}
module.exports={LyricLink};
