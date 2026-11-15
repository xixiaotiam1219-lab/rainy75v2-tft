// SPDX-License-Identifier: MIT
'use strict';
const path=require('node:path'),{spawn}=require('node:child_process'),{createInterface}=require('node:readline');
class Volume{
 constructor({clock=Date.now,spawnHelper=spawn}={}){this.clock=clock;this.spawnHelper=spawnHelper;this.child=null;this.available=false;this.level=null;this.muted=false;this.error=null;this.version=0;this.event=null;this.retryAt=0;}
 accept(data){if(!data||typeof data!=='object')return;if(data.event==='error'){this.available=false;this.error='系统音量暂不可用';return;}if(data.event!=='volume'||!Number.isInteger(data.level)||data.level<0||data.level>100||typeof data.muted!=='boolean'||data.initial!==undefined&&typeof data.initial!=='boolean')return;
  const changed=this.level!==data.level||this.muted!==data.muted;this.level=data.level;this.muted=data.muted;this.available=true;this.error=null;if(changed&&!data.initial)this.event={level:this.level,muted:this.muted,at:this.clock(),version:++this.version};
 }
 start(){if(this.child||this.clock()<this.retryAt)return;const p=this.spawnHelper('powershell.exe',['-Mta','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'volume.ps1'),'-Watch'],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=p;
  const ended=()=>{if(this.child===p){this.child=null;this.available=false;this.retryAt=this.clock()+5000;}};
  createInterface({input:p.stdout}).on('line',line=>{try{this.accept(JSON.parse(line.replace(/^\uFEFF/,'')));}catch{}});p.stderr.on('data',()=>{});p.on('error',()=>{this.error='系统音量读取失败';ended();});p.on('close',ended);p.stdin.on('error',()=>{});
 }
 preview(){if(!this.available)throw Error('尚未读到系统音量');this.event={level:this.level,muted:this.muted,at:this.clock(),version:++this.version};return this.event;}
 state(){return{available:this.available,level:this.level,muted:this.muted,error:this.error};}
 async stop(){const p=this.child;this.child=null;if(!p)return;p.stdin.end();await Promise.race([new Promise(resolve=>p.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,600))]);if(p.exitCode===null)p.kill();p.stdout.destroy();p.stderr.destroy();p.unref();}
}
// Called only by the bridge's serial HID loop and its cooperative yields.
// HTTP handlers mutate settings/events; they never send device packets.
class VolumeDispatcher{
 constructor(source,{clock=Date.now}={}){this.source=source;this.clock=clock;this.link=null;this.signature='';this.version=0;this.lastAt=-Infinity;this.error=null;}
 async pump(link,settings,{signal}={}){
  const e=this.source.event;if(!link?.volumeSupported){this.version=e?.version||0;return;}
  const signature=JSON.stringify([settings.volumeEnabled,settings.volumeScope,settings.volumeStyle,settings.volumeHoldMs,link.mode,link.layout]);
  try{
   if(this.link!==link||this.signature!==signature){if(this.link!==link)this.version=e?.version||0;this.link=link;this.signature=signature;await link.setVolume(null,{signal});this.error=null;}
   if(!e||e.version<=this.version)return;
   if(!settings.volumeEnabled||!settings.volumeScope&&!(link.mode===1&&link.layout===4)||this.clock()-e.at>2000){this.version=e.version;return;}
   if(this.clock()-this.lastAt<80)return;
   this.lastAt=this.clock();this.version=e.version;await link.setVolume(e,{scope:settings.volumeScope,style:settings.volumeStyle,holdMs:settings.volumeHoldMs,signal});this.error=null;
  }catch(err){if(err.name==='AbortError'){this.signature='';return;}this.error='音量提示：'+err.message;this.version=e?.version||0;}
 }
}
module.exports={Volume,VolumeDispatcher};
