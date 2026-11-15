// SPDX-License-Identifier: MIT
'use strict';
const fs=require('node:fs'),{FONT}=require('./config.cjs'),{validateFont,crc32}=require('./font.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class LyricLink{
 constructor(client,font=fs.readFileSync(FONT)){
  validateFont(font);
  this.c=client;this.crc=font.readUInt32LE(36);this.lookup=new Map;const count=font.readUInt32LE(16);for(let i=0;i<count;i++)this.lookup.set(font.readUInt32LE(256+i*4),i);this.fallback=font.readUInt32LE(28);this.revision=1000;this.mode=0;this.titleLimit=16;this.layout=0;this.layoutSupported=false;this.layoutCount=0;
 }
 async q(field,{signal}={}){return(await this.c.request(22,field,[],a=>a.status===0xc0+(field&15),{signal,retryMs:150})).value;}
 async ready(){
  await this.c.request(24,1,[],a=>a.status===0xa6&&a.value===0x4c59);
  const started=Date.now();while(Date.now()-started<7000){const ready=await this.q(0),error=await this.q(2);if(ready===1)break;if(error)throw Error('屏幕字库初始化失败，状态 '+error);await sleep(50);}
  if(await this.q(0)!==1)throw Error('屏幕字库未就绪');
  if(((await this.q(6))*65536+(await this.q(5)))!==this.crc)throw Error('屏幕与电脑使用的字库不同');
  const until=Date.now()+7000;while(await this.q(4)){if(Date.now()>until)throw Error('等待已有字形任务完成超时');await sleep(30);}this.revision=await this.q(3);
  try{const limit=await this.q(7);if(limit>=16&&limit<=96)this.titleLimit=limit;}catch{}
  try{const layout=await this.q(8);if(Number.isInteger(layout)&&layout>=0&&layout<5){this.layout=layout;this.layoutSupported=true;this.layoutCount=2;}}catch(e){if(!e.status)throw e;}
  if(this.layoutSupported)try{const count=await this.q(11);if(Number.isInteger(count)&&count>=2&&count<=5)this.layoutCount=count;}catch(e){if(!e.status)throw e;}
  this.coverSupported=false;if(this.layoutCount>=5)try{this.coverSupported=await this.q(12)===0x4341;}catch(e){if(!e.status)throw e;}
  this.coverIndexed=false;if(this.coverSupported)try{const formats=await this.q(16);this.coverIndexed=!!(formats&1);this.coverSmall=!!(formats&2);}catch(e){if(!e.status)throw e;}
  this.textSupported=false;if(this.coverSupported)try{const size=await this.q(21),style=await this.q(22);if([20,30,40].includes(size)&&(style===0||style===1)){this.textSize=size;this.textStyle=style;this.textSupported=true;}}catch(e){if(!e.status)throw e;}
  this.volumeSupported=false;try{this.volumeSupported=await this.q(23)===0x564f;}catch(e){if(!e.status)throw e;}
  this.mode=await this.q(1);return this.mode;
 }
 ids(text,max){const chars=[...String(text||'').normalize('NFC').replace(/[\x00-\x1f\x7f]/g,' ')];if(chars.length>max){chars.length=max;chars[max-1]='…';}return chars.map(c=>this.lookup.get(c.codePointAt(0))??this.fallback);}
 timing(frame){const b=Buffer.alloc(17);const duration=Math.max(0,Math.min(86400000,Math.round(frame.durationMs||0))),position=Math.max(0,Math.min(duration,Math.round(frame.positionMs||0)));b.writeUInt32LE(position,0);b.writeUInt32LE(duration,4);b[8]=frame.playing?1:0;b.writeUInt32LE(Math.max(0,Math.min(600000,Math.round(frame.lineElapsedMs||0))),9);b.writeUInt32LE(Math.max(0,Math.min(600000,Math.round(frame.lineDurationMs||0))),13);return b;}
 async setFrame(frame,{signal}={}){
  signal?.throwIfAborted();
  // A cancelled wait may have already queued OP21. Let that GUI job finish
  // before replacing its incoming fields; controls still run at each yield.
  if(this.pendingFrame!==undefined){const started=Date.now();while(await this.q(4,{signal})){if(this.onYield)await this.onYield();signal?.throwIfAborted();if(Date.now()-started>7000)throw Error('等待已有字形任务完成超时');await sleep(25);}this.pendingFrame=undefined;}
  const rev=++this.revision&65535;
  for(const [kind,text]of [[0,frame.title],[1,frame.current],[2,frame.next]]){signal?.throwIfAborted();const ids=this.ids(text,kind?96:this.titleLimit),p=Buffer.alloc(2+2*ids.length);p[0]=kind;p[1]=ids.length;ids.forEach((id,i)=>p.writeUInt16LE(id,2+2*i));await this.c.request(20,rev,p,undefined,{signal});if(this.onYield)await this.onYield();}
  signal?.throwIfAborted();this.pendingFrame=rev;
  try{await this.c.request(21,rev,this.timing(frame),a=>(a.status===0||a.status===1)&&a.value===rev,{signal});}catch(e){if(e.name==='AbortError')throw e;if(await this.q(3,{signal})!==rev&&!await this.q(4,{signal}))throw e;}
  const started=Date.now();while(Date.now()-started<7000){signal?.throwIfAborted();if(this.onYield)await this.onYield();if(await this.q(3,{signal})===rev){this.pendingFrame=undefined;return rev;}const error=await this.q(2,{signal});if(error)throw Error('字形缓存生成失败，状态 '+error);await sleep(25);}throw Error('字形缓存提交超时');
 }
 async sync(frame,{signal}={}){signal?.throwIfAborted();const id=++this.revision&65535;await this.c.request(25,id,this.timing(frame),undefined,{signal});if(this.onYield)await this.onYield();if(this.coverSmall){const paintMs=await this.q(17,{signal});if(this.onYield)await this.onYield();const paintMaxMs=await this.q(18,{signal});if(this.onYield)await this.onYield();this.paint={paintMs,paintMaxMs,backgroundCached:await this.q(19,{signal})===1};}}
 async setTypography(size,style){if(![20,30,40].includes(size)||!Number.isInteger(style)||style<0||style>1)throw Error('无效歌词字体设置');if(!this.textSupported)throw Error('当前固件不支持字体调整');await this.c.request(29,++this.revision&65535,[size,style],undefined,{retryMs:150});if(await this.q(21)!==size||await this.q(22)!==style)throw Error('字体设置读回不一致');this.textSize=size;this.textStyle=style;}
 async setVolume(event,options={}){
  if(!this.volumeSupported)throw Error('屏幕不支持系统音量动画');const {scope=0,style=0,holdMs=1000,signal}=options;
  if(!Number.isInteger(scope)||scope<0||scope>1||!Number.isInteger(style)||style<0||style>1||!Number.isInteger(holdMs)||holdMs<400||holdMs>3000)throw Error('无效音量动画设置');
  if(event&&(!Number.isInteger(event.level)||event.level<0||event.level>100||typeof event.muted!=='boolean'))throw Error('无效系统音量');
  const p=Buffer.alloc(6);p[0]=event?event.level:255;p[1]=event?.muted?1:0;p[2]=scope;p[3]=style;p.writeUInt16LE(holdMs,4);await this.c.request(30,++this.revision&65535,p,undefined,{pollMs:3,signal});
 }
 async setCover(cover,{signal}={}){
  signal?.throwIfAborted();
  if(!this.coverSupported)throw Error('屏幕不支持临时封面');
  if(cover&&(!Buffer.isBuffer(cover.bytes)||cover.bytes.length!==8192||!Buffer.isBuffer(cover.palette)||cover.palette.length!==8))throw Error('封面格式不匹配');
  const rev=++this.revision&65535,send=async(p,queued=false)=>{signal?.throwIfAborted();const id=++this.revision&65535;return this.c.request(28,id,p,a=>a.value===id&&a.status===(queued?0:1),{pollMs:3,signal});};
  const small=this.coverSmall&&cover?.compact?.length===1856,packed=this.coverIndexed&&cover?.packed?.length===3200,format=small?3:packed?2:1,body=cover?(small?cover.compact:packed?cover.packed:cover.bytes):null;
  if(cover){const begin=Buffer.alloc(18);begin[0]=0;begin.writeUInt16LE(rev,1);begin.set([small?48:64,small?48:64,format],3);begin.writeUInt32LE(crc32(body),6);cover.palette.copy(begin,10);await send(begin);
   for(let at=0;at<body.length;at+=224){const chunk=body.subarray(at,at+224),p=Buffer.alloc(5+chunk.length);p[0]=1;p.writeUInt16LE(rev,1);p.writeUInt16LE(at,3);chunk.copy(p,5);await send(p);if(this.onYield)await this.onYield();}
  }
  const commit=Buffer.alloc(3);commit[0]=cover?2:3;commit.writeUInt16LE(rev,1);await send(commit,true);
  const start=Date.now();while(true){signal?.throwIfAborted();if(this.onYield)await this.onYield();const state=await this.q(13,{signal}),committed=await this.q(14,{signal});if(state===1&&committed===rev)break;if(Date.now()-start>3000)throw Error('封面发布超时');if(state===7)throw Error('封面完整性校验失败');await sleep(25);}
  return{bytes:body?.length||0,format};
 }
 async setMode(mode){const value=mode?1:0;await this.c.request(23,++this.revision&65535,[value],undefined,{retryMs:150});const start=Date.now();while(Date.now()-start<2500){if(await this.q(1)===value){this.mode=value;return;}await sleep(30);}throw Error('等待缓存动画新帧以切换界面超时');}
 async setLayout(value){if(!Number.isInteger(value)||value<0||value>=5)throw Error('无效播放器模板');if(!this.layoutSupported||value>=this.layoutCount)throw Error('当前屏幕固件不支持此模板');await this.c.request(26,++this.revision&65535,[value],undefined,{retryMs:150});if(await this.q(8)!==value)throw Error('歌词字号读回不一致');this.layout=value;}
}
module.exports={LyricLink};
