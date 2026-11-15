// SPDX-License-Identifier: MIT
'use strict';
const path=require('node:path'),{spawn}=require('node:child_process'),{createInterface}=require('node:readline'),{createHash}=require('node:crypto');
function palette(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length!==8192)throw Error('无效封面像素');const p=Buffer.alloc(8);
 for(let k=0;k<4;k++){const sum=[0,0,0];for(let y=0;y<32;y++)for(let x=0;x<32;x++){const v=bytes.readUInt16LE((((k>>1)*32+y)*64+(k%2)*32+x)*2);sum[0]+=(v>>>11)*255/31;sum[1]+=(v>>>5&63)*255/63;sum[2]+=(v&31)*255/31;}
  const c=sum.map(v=>Math.round(v/1024*.48)),value=(c[0]>>>3)<<11|(c[1]>>>2)<<5|c[2]>>>3;p.writeUInt16LE(value,k*2);
 }return p;
}
function packCover(bytes,size=64){
 if(!Buffer.isBuffer(bytes)||bytes.length!==8192)throw Error('无效封面像素');
 if(size!==64&&size!==48)throw Error('无效封面尺寸');if(size===48){const compact=Buffer.alloc(4608);for(let y=0;y<48;y++)for(let x=0;x<48;x++)compact.writeUInt16LE(bytes.readUInt16LE((Math.floor(y*4/3)*64+Math.floor(x*4/3))*2),(y*48+x)*2);bytes=compact;}
 const histogram=new Map;for(let i=0;i<bytes.length;i+=2){const v=bytes.readUInt16LE(i);histogram.set(v,(histogram.get(v)||0)+1);}
 const colors=[...histogram].map(([v,n])=>({v,n,c:[v>>>11,(v>>>5&63)/2,v&31]}));
 const box=items=>{const ranges=[0,1,2].map(k=>Math.max(...items.map(p=>p.c[k]))-Math.min(...items.map(p=>p.c[k]))),axis=ranges.indexOf(Math.max(...ranges)),weight=items.reduce((s,p)=>s+p.n,0);return{items,axis,weight,score:Math.max(...ranges)*weight};};
 const boxes=[box(colors)];while(boxes.length<64){const candidates=boxes.filter(b=>b.items.length>1);if(!candidates.length)break;const chosen=candidates.reduce((a,b)=>a.score>=b.score?a:b),items=chosen.items.sort((a,b)=>a.c[chosen.axis]-b.c[chosen.axis]);let weight=0,cut=1;for(;cut<items.length;cut++){weight+=items[cut-1].n;if(weight>=chosen.weight/2)break;}cut=Math.min(cut,items.length-1);boxes.splice(boxes.indexOf(chosen),1,box(items.slice(0,cut)),box(items.slice(cut)));}
 const output=Buffer.alloc(128+size*size*6/8),lookup=new Map;boxes.forEach((b,index)=>{const sum=[0,0,0];for(const p of b.items)for(let k=0;k<3;k++)sum[k]+=p.c[k]*p.n;const c=sum.map(v=>Math.round(v/b.weight)),value=c[0]<<11|Math.min(63,Math.round(sum[1]/b.weight*2))<<5|c[2];output.writeUInt16LE(value,index*2);for(const p of b.items)lookup.set(p.v,index);});
 for(let i=0;i<size*size;i++){const index=lookup.get(bytes.readUInt16LE(i*2)),bit=i*6,at=128+(bit>>>3),shift=bit&7;output[at]|=index<<shift;if(shift>2)output[at+1]|=index>>>(8-shift);}
 return output;
}
class CoverWorker{
 constructor(){this.child=null;this.pending=null;}
 read(media){if(this.pending)return Promise.reject(Error('封面请求仍在处理'));return new Promise((resolve,reject)=>{
  const fail=()=>{if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(Error('封面读取超时或失败'));this.pending=null;}};
  if(!this.child){const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'cover.ps1'),'-Watch'],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=p;
   createInterface({input:p.stdout}).on('line',line=>{if(this.child!==p||!this.pending)return;const waiting=this.pending;this.pending=null;clearTimeout(waiting.timer);try{const r=JSON.parse(line.replace(/^\uFEFF/,'').trim());if(!r.rgb565)return waiting.resolve(null);const bytes=Buffer.from(r.rgb565,'base64');if(r.version!==1||bytes.length!==8192)throw Error();waiting.resolve({bytes,packed:packCover(bytes),compact:packCover(bytes,48),palette:palette(bytes),hash:createHash('sha256').update(bytes).digest('hex')});}catch{waiting.reject(Error('封面数据无效'));}});
   p.stderr.on('data',()=>{});p.on('error',()=>{if(this.child===p){fail();this.child=null;}});p.on('exit',()=>{if(this.child===p){fail();this.child=null;}});p.stdin.on('error',()=>{if(this.child===p)fail();});
  }
  this.pending={resolve,reject,timer:setTimeout(()=>{fail();this.stop();},14000)};this.child.stdin.write(JSON.stringify({source:media.source,title:media.title,artist:media.artist||'',albumTitle:media.albumTitle||''})+'\n');
 });}
 stop(){const p=this.child;this.child=null;if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(Error('封面读取已停止'));this.pending=null;}if(p){p.stdin.destroy();p.stdout.destroy();p.stderr.destroy();p.kill();p.unref();}}
}

class Cover{
 constructor({reader,clock=Date.now}={}){this.worker=reader?null:new CoverWorker;this.reader=reader||(media=>this.worker.read(media));this.clock=clock;this.key='';this.result=null;this.loading=false;this.inflight=false;this.error=null;this.retryAt=0;this.generation=0;this.cache=new Map;}
 update(media){const key=media?[media.source,media.title,media.artist||'',media.albumTitle||''].join('|'):'';
  if(key!==this.key){this.key=key;this.result=null;this.error=null;this.retryAt=0;this.loading=false;this.generation++;}
  if(!key)return null;if(this.cache.has(key)){this.result=this.cache.get(key);return this.result;}
  if(!this.inflight&&this.clock()>=this.retryAt){this.loading=this.inflight=true;const generation=this.generation;this.reader({...media}).then(result=>{if(generation!==this.generation)return;this.result=result;this.retryAt=this.clock()+30000;if(result){this.cache.set(key,result);while(this.cache.size>10)this.cache.delete(this.cache.keys().next().value);}}).catch(e=>{if(generation===this.generation){this.error=e.message;this.retryAt=this.clock()+30000;}}).finally(()=>{this.inflight=false;if(generation===this.generation)this.loading=false;});}
  return this.result;
 }
 stop(){this.generation++;this.worker?.stop();}
 state(){return{loading:this.loading,ready:!!this.result,error:this.error,pixels:64,bytes:8192};}
}
module.exports={Cover,CoverWorker,palette,packCover};
