// SPDX-License-Identifier: MIT
'use strict';
const path=require('node:path'),{spawn}=require('node:child_process'),{createInterface}=require('node:readline');
const {Timeline}=require('./netease-timeline.cjs'),{provider,parseLrc,fetchLines}=require('./lyric-provider.cjs');
function position(s,now){if(!s?.timelineReady)return null;const base=Number(s.positionMs)||0,p=base+(s.status==='Playing'?Math.max(0,now-(s.positionAt||s.observedAt||now)):0);return Math.min(Math.max(0,p),s.durationMs||p);}
function cueFrame(media,lines,now=Date.now(),loading=false,error=null,offsetMs=0){
 if(!media)return{title:'播放器',current:'等待播放音乐',next:'',durationMs:0,positionMs:0,playing:false,lineElapsedMs:0,lineDurationMs:15000};
 const pos=position(media,now),base={title:media.title,durationMs:Math.max(0,Math.min(86400000,media.durationMs||0)),positionMs:pos||0,playing:media.status==='Playing'&&pos!==null};
 if(pos===null)return{...base,current:'等待播放器进度',next:'',lineElapsedMs:0,lineDurationMs:15000};
 if(!lines.length)return{...base,current:loading?'正在读取歌词':error?'暂无可用歌词':'纯音乐或暂无歌词',next:'',lineElapsedMs:0,lineDurationMs:15000};
 const cuePosition=Math.max(0,pos+offsetMs);let i=-1;for(let j=0;j<lines.length&&lines[j].at<=cuePosition;j++)i=j;
 if(i<0)return{...base,current:'♪',next:lines[0]?.text||'',lineElapsedMs:0,lineDurationMs:Math.max(1000,lines[0]?.at||10000)};
 const cue=lines[i],end=Math.max(cue.at+1,lines[i+1]?.at??media.durationMs??cue.at+15000),parts=[];const chars=[...cue.text.normalize('NFC')];for(let at=0;at<chars.length;at+=96)parts.push(chars.slice(at,at+96).join(''));
 const span=(end-cue.at)/Math.max(1,parts.length),part=Math.min(parts.length-1,Math.floor((cuePosition-cue.at)/span));
 // Map real hold/travel time into the device's bounded scroll phase. Short
 // cues get a shorter hold; source position and the track progress stay exact.
 const hold=Math.min(1500,span/6),travel=Math.max(1,span-2*hold);
 return{...base,current:parts[part]||'',next:parts[part+1]||lines[i+1]?.text||'',lineElapsedMs:Math.max(0,cuePosition-cue.at-part*span)+1500-hold,lineDurationMs:travel+3000};
}
class Music{
 constructor({fetcher=fetchLines,clock=Date.now}={}){this.fetcher=fetcher;this.clock=clock;this.timeline=new Timeline;this.info={sessions:[],processes:[]};this.media=null;this.lines=[];this.key='';this.loading=false;this.error=null;this.lyricProvider=null;this.match=null;this.attempts=[];this.retryAt=0;this.failures=0;this.controller=null;this.generation=0;this.cache=new Map;this.pending=null;this.lastPoll=0;this.child=null;}
 start(){if(this.child)return;const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'media.ps1'),'-Watch'],{windowsHide:true,stdio:['ignore','pipe','pipe']});this.child=p;
  createInterface({input:p.stdout}).on('line',text=>{try{this.accept(JSON.parse(text.replace(/^\uFEFF/,'')));}catch{}});p.stderr.on('data',()=>{});p.on('error',()=>{this.error='系统媒体信息读取失败';});p.on('exit',()=>{if(this.child===p){this.child=null;this.error='媒体读取已停止';}});
 }
 stop(){this.generation++;this.controller?.abort();const p=this.child;this.child=null;if(p){p.stdout.destroy();p.stderr.destroy();p.kill();p.unref();}}
 accept(info){if(!Array.isArray(info.sessions)||!Array.isArray(info.processes))return;this.info=info;this.refresh();}
 refresh(){
  const now=this.clock();if(now-this.lastPoll>=300){this.lastPoll=now;try{this.timeline.poll(this.info.processes);}catch{}}
  const candidates=this.info.sessions.filter(s=>provider(s.source)&&s.title).map(s=>{
   const ready=Number.isFinite(s.positionMs)&&s.durationMs>0&&s.positionAt>0;
   if(!ready&&provider(s.source)==='netease'){const local=this.timeline.resolve(s);if(local)return local;}
   return{...s,timelineReady:ready,positionSource:ready?'windows-media-timeline':'unavailable'};
  });
  const playing=candidates.filter(s=>s.status==='Playing'),paused=candidates.filter(s=>s.status==='Paused');this.media=playing.find(s=>s.current)||playing[0]||paused.find(s=>s.current)||paused[0]||candidates[0]||null;
  const key=this.media?[this.media.source,this.media.songId||'',this.media.title,this.media.artist,this.media.albumTitle||'',Math.round((this.media.durationMs||0)/1000)].join('|'):'';
  if(key!==this.key){this.controller?.abort();this.key=key;this.lines=[];this.error=null;this.loading=false;this.lyricProvider=null;this.match=null;this.attempts=[];this.retryAt=0;this.failures=0;this.generation++;}
  if(!this.media)return;
  if(this.cache.has(key)){const entry=this.cache.get(key);this.lines=entry.lines;this.lyricProvider=entry.provider;this.match=entry.match||null;this.attempts=entry.attempts||[];return;}
  if(this.loading||now<this.retryAt)return;
  this.load();
 }
 load(){
  const generation=this.generation,media=this.media,key=this.key;this.loading=true;this.controller=new AbortController;const signal=this.controller.signal;
  this.pending=(async()=>{try{const result=await this.fetcher(media,{signal});if(!result.lines.length)throw Error('暂无可用歌词');if(signal.aborted||this.generation!==generation)return;
   this.cache.set(key,result);while(this.cache.size>20)this.cache.delete(this.cache.keys().next().value);this.lines=result.lines;this.lyricProvider=result.provider;this.match=result.match||null;this.attempts=result.attempts||[];this.error=null;this.retryAt=0;this.failures=0;
  }catch(e){if(this.generation===generation&&!signal.aborted){this.error=e.message;this.attempts=e.attempts||[];this.retryAt=this.clock()+[5000,15000,45000,120000][Math.min(this.failures++,3)];}}finally{if(this.generation===generation)this.loading=false;}})();
 }
 retry(){if(!this.media)throw Error('没有当前曲目');this.controller?.abort();this.generation++;this.cache.delete(this.key);this.retryAt=0;this.failures=0;this.error=null;this.load();}
 frame(offsetMs=0){this.refresh();return cueFrame(this.media,this.lines,this.clock(),this.loading,this.error,offsetMs);}
 local(text){if(!this.key)throw Error('没有当前曲目');const lines=parseLrc(text,{credits:false});if(!lines.length)throw Error('LRC 没有有效时间标签');this.controller?.abort();this.lines=lines;this.error=null;this.loading=false;this.generation++;this.retryAt=0;this.failures=0;this.match=null;this.attempts=[];this.lyricProvider='local';this.cache.set(this.key,{lines,provider:'local'});}
 state(){return{source:this.media?.source||null,title:this.media?.title||null,artist:this.media?.artist||null,albumTitle:this.media?.albumTitle||null,status:this.media?.status||null,timelineReady:!!this.media?.timelineReady,positionSource:this.media?.positionSource||null,lyricLines:this.lines.length,lyricProvider:this.lyricProvider,match:this.match,attempts:this.attempts,retryAt:this.retryAt,failures:this.failures,loading:this.loading,error:this.error};}
}
module.exports={Music,provider,position,cueFrame,fetchLines};
