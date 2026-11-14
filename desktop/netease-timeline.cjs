// SPDX-License-Identifier: MIT
'use strict';
// Read-only current playback reconstruction. Byte mapping documented by the
// MIT netease-cloudmusic-detector ecosystem and dsh-pet-qqmusic/netease-elog.js.
// Upstream copyright and MIT text: licenses/netease-elog-MIT.txt.
// Only track ID/title/artist/duration, load/seek/pause events are retained.
// No log text, URLs, cookies, account data, or playback history is persisted.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const TABLE=Uint8Array.from({length:256},(_,b)=>{const hi=b>>4,lo=b&15;return(((hi^((lo+8)&15))*16)+(b>>6)*4+((~hi)&3))&255;});
const NEWLINE=TABLE.indexOf(10),up=()=>os.uptime()*1000;
function decode(buf){const out=Buffer.allocUnsafe(buf.length);for(let i=0;i<buf.length;i++)out[i]=TABLE[buf[i]];return out.toString('utf8');}
function encode(text){const inverse=new Int16Array(256).fill(-1);for(let i=0;i<256;i++)inverse[TABLE[i]]=i;return Buffer.from(Buffer.from(text).map(b=>inverse[b]));}
function track(obj){const t=obj?.track||obj;if(!t||typeof t!=='object'||!t.id||!t.name)return null;return{id:String(t.id),title:String(t.name).slice(0,300),artist:(t.artists||t.ar||[]).map(a=>String(a?.name||'')).join('/').slice(0,300),durationMs:Math.max(0,Number(t.duration??t.dt)||0)};}
function event(line,nowUp=up(),nowWall=Date.now()){
 const m=/^\[(\d+):\d+:\d{4}\/\d{6}:(\d+):/.exec(line);if(!m)return null;
 let at=Number(m[2]);const wrap=4294967296;if(nowUp-at>wrap/2)at+=Math.floor((nowUp-at+wrap/2)/wrap)*wrap;
 if(!Number.isFinite(at)||at<0||at>nowUp+3000)return null;
 const wall=/\]\s+\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/.exec(line);
 if(wall){const w=Date.parse(wall[1].replace(' ','T'));if(Number.isFinite(w)&&Math.abs(nowWall-(nowUp-at)-w)>6000)return null;}
 const base={pid:Number(m[1]),at};
 const json=()=>{const a=line.indexOf('{'),b=line.lastIndexOf('}');if(a<0||b<=a||b-a>65536)return null;try{return JSON.parse(line.slice(a,b+1));}catch{return null;}};
 if(line.includes('"checkPlayPrivilege"')||line.includes('"playOneTrackInPlayingList"')){const t=track(json());return t?{...base,type:'track',track:t}:null;}
 if(line.includes('"setPlayingPosition"')){const pos=/"setPlayingPosition"\s*,\s*(-?\d+(?:\.\d+)?)/.exec(line);return pos?{...base,type:'seek',position:Math.max(0,Number(pos[1])*1000)}:null;}
 if(line.includes('"native')&&line.includes('state"')){const s=/"native[^"]*state"\s*,\s*([12])(?:\D|$)/.exec(line);return s?{...base,type:'state',playing:s[1]==='1'}:null;}
 if(line.includes('"native')&&line.includes('load')&&line.includes('"songId"')){const d=json();return d?.songId?{...base,type:'load',id:String(d.songId)}:null;}
 if(line.includes('exitApp'))return{...base,type:'exit'};return null;
}
const clean=s=>String(s||'').normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
class Timeline{
 constructor({filename=path.join(os.homedir(),'AppData/Local/NetEase/CloudMusic/cloudmusic.elog'),clock=up}={}){this.filename=filename;this.clock=clock;this.active=new Map;this.offset=0;this.carry=Buffer.alloc(0);this.loaded=false;this.reset();}
 reset(){this.current=null;this.position=0;this.anchor=0;this.playing=false;this.known=false;this.last=0;this.pid=0;}
 positionAt(at){const p=this.position+(this.known&&this.playing?Math.max(0,at-this.anchor):0);return this.current?.durationMs?Math.min(p,this.current.durationMs):p;}
 accept(e){
  if(!e)return;const started=this.active.get(e.pid);if(started===undefined||e.at<started-2000||e.at<this.last)return;
  if(e.type==='exit'){if(e.pid===this.pid)this.reset();return;}
  if(e.type==='track'){
   if(this.current?.id!==e.track.id){this.known=false;this.position=0;this.anchor=e.at;this.playing=false;}
   this.current=e.track;this.pid=e.pid;
  }else if(!this.current)return;
  else if(e.type==='load'&&e.id===this.current.id){const p=this.positionAt(e.at);if(!this.known||p>=this.current.durationMs-500){this.position=0;this.anchor=e.at;this.playing=true;this.known=true;}}
  else if(e.type==='seek'){this.position=e.position;this.anchor=e.at;this.known=true;}
  else if(e.type==='state'){this.position=this.positionAt(e.at);this.anchor=e.at;this.playing=e.playing;}
  this.last=e.at;
 }
 poll(processes){
  const now=this.clock(),wall=Date.now();const entries=processes.filter(p=>/cloudmusic/i.test(p.source)).flatMap(p=>(p.instances||[]).map(x=>[x.pid,now-Math.max(0,wall-x.startedAt)]));
  this.active=new Map(entries);if(!entries.length){this.reset();return;}
  let st;try{st=fs.statSync(this.filename);}catch{return;}
  let skip=false;if(!this.loaded||st.size<this.offset){this.reset();this.offset=Math.max(0,st.size-4*1024*1024);this.carry=Buffer.alloc(0);skip=this.offset>0;this.loaded=true;}
  if(st.size===this.offset)return;
  let fd;try{fd=fs.openSync(this.filename,'r');let budget=4*1024*1024;
   while(this.offset<st.size&&budget>0){const n=Math.min(65536,st.size-this.offset,budget),buf=Buffer.allocUnsafe(n),read=fs.readSync(fd,buf,0,n,this.offset);if(!read)break;this.offset+=read;budget-=read;
    const joined=Buffer.concat([this.carry,buf.subarray(0,read)]),last=joined.lastIndexOf(NEWLINE);if(last<0){this.carry=joined.length>65536?Buffer.alloc(0):joined;continue;}
    let text=decode(joined.subarray(0,last+1));this.carry=Buffer.from(joined.subarray(last+1));if(skip){text=text.slice(text.indexOf('\n')+1);skip=false;}
    for(const line of text.split('\n'))this.accept(event(line,now,wall));
   }
  }finally{if(fd!==undefined)fs.closeSync(fd);}
 }
 resolve(session){if(!this.current||!this.known||clean(this.current.title)!==clean(session.title))return null;
  if(clean(session.artist)&&clean(this.current.artist)&&!clean(this.current.artist).includes(clean(session.artist))&&!clean(session.artist).includes(clean(this.current.artist)))return null;
  return{...session,status:this.playing?'Playing':'Paused',songId:this.current.id,positionMs:Math.round(this.positionAt(this.clock())),durationMs:this.current.durationMs,positionAt:Date.now(),timelineReady:true,positionSource:'netease-local-events'};
 }
}
module.exports={Timeline,event,track,decode,encode};
