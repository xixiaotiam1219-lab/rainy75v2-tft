// SPDX-License-Identifier: MIT
'use strict';
// Small local background bridge: global hotkey notifications, current media only,
// cached font glyph IDs on line changes, 17-byte timing snapshots once per second.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{spawn,execFile}=require('node:child_process'),{createInterface}=require('node:readline');
const T=require('./transport.cjs'),{LyricLink}=require('./lyric-link.cjs'),{Music}=require('./music.cjs');
const {DATA:OUT}=require('./config.cjs'),DEMO=process.argv.includes('--demo');
if(!DEMO&&process.platform!=='win32')throw Error('Realtime media requires Windows; use --demo for an offline preview');
fs.mkdirSync(OUT,{recursive:true});const settingsPath=path.join(OUT,'background-settings.json');
let settings={offsetMs:0,mode:1,layout:1};try{Object.assign(settings,JSON.parse(fs.readFileSync(settingsPath)));}catch{}settings.offsetMs=Math.max(-10000,Math.min(10000,Number(settings.offsetMs)||0));settings.mode=settings.mode===0?0:1;settings.layout=settings.layout===0?0:1;
const persist=()=>fs.writeFileSync(settingsPath,JSON.stringify(settings,null,2));
const music=new Music(DEMO?{fetcher:async()=>({provider:'demo',lines:[{at:0,text:'把小小的屏幕点亮'},{at:5000,text:'文字跟着旋律慢慢滚动'},{at:10000,text:'今天也有新的好心情'}]})}:{});let c=null,link=null,wantedMode=settings.mode,connected=false,error=null,stopping=false,connectAt=0,lastKey='',lastSync=0,hotkey={ready:false,error:null},helper;
let wire={revision:null,committedAt:null,commitMs:null,timingAt:null,titleLimit:null,layout:null,layoutSupported:false,frame:null};
const state=()=>{const frame=music.frame(settings.offsetMs);return{pid:process.pid,demo:DEMO,connected,wantedMode,settings,hotkey,error,music:music.state(),frame,wire};};
async function disconnect(){const old=c;c=null;link=null;connected=false;lastKey='';wire.layoutSupported=false;if(old)await old.close().catch(()=>{});}
async function loop(){
 while(!stopping){try{
  if(!c){if(Date.now()<connectAt){await T.delay(150);continue;}connectAt=Date.now()+4000;c=await T.usb();await T.ready(c);link=new LyricLink(c);await link.ready();connected=true;error=null;lastKey='';wire.titleLimit=link.titleLimit;wire.layoutSupported=link.layoutSupported;}
  if(link.layoutSupported&&link.layout!==settings.layout)await link.setLayout(settings.layout);wire.layout=link.layout;
  const frame=music.frame(settings.offsetMs),key=JSON.stringify([frame.title,frame.current,frame.next]);
  if(key!==lastKey){const start=Date.now(),revision=await link.setFrame(frame),committedAt=Date.now();lastKey=key;wire={...wire,revision,committedAt,commitMs:committedAt-start,frame};
   // Font masks take time to prepare. Resample the real media timeline after
   // commit instead of leaving the display at the pre-render position.
   const fresh=music.frame(settings.offsetMs);if(JSON.stringify([fresh.title,fresh.current,fresh.next])===key){await link.sync(fresh);wire.frame=fresh;wire.timingAt=Date.now();}lastSync=Date.now();}
  else if(Date.now()-lastSync>=1000){await link.sync(frame);lastSync=Date.now();wire.timingAt=lastSync;}
  if(link.mode!==wantedMode)await link.setMode(wantedMode);
  error=null;
 }catch(e){error=e.message;await disconnect();}await T.delay(100);}
}
function startHotkey(){helper=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'toggle-hotkey.ps1')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 createInterface({input:helper.stdout}).on('line',line=>{try{const e=JSON.parse(line);if(e.event==='ready'){hotkey.ready=true;hotkey.error=null;}else if(e.event==='toggle'){wantedMode=wantedMode?0:1;settings.mode=wantedMode;persist();}else if(e.event==='error'){hotkey.ready=false;hotkey.error=e.message;}}catch{}});helper.stderr.on('data',()=>{});helper.on('error',()=>{hotkey.error='快捷键注册失败';});helper.on('exit',()=>{hotkey.ready=false;});
}
function startup(enabled){return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'startup.ps1'),'-Action',enabled?'Enable':'Disable','-DataDirectory',OUT],{windowsHide:true,timeout:15000},(e,out)=>e?reject(Error('登录自启设置失败')):resolve(out.trim())));}
const server=http.createServer(async(req,res)=>{
 const reply=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 const url=new URL(req.url,'http://127.0.0.1');
 if(req.headers.host!=='127.0.0.1:'+server.address().port){reply(403,{error:'Invalid local host'});return;}
 if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(__dirname,'control.html')));return;}
 if(req.method==='GET'&&url.pathname==='/state'){reply(200,state());return;}
 if(req.method!=='POST'){reply(404,{error:'Not found'});return;}
 if(req.headers.origin&&req.headers.origin!=='http://127.0.0.1:'+server.address().port){reply(403,{error:'来源不匹配'});return;}
 try{let body='';req.setEncoding('utf8');for await(const chunk of req){body+=chunk;if(body.length>1048576)throw Error('请求过大');}const data=JSON.parse(body||'{}');
  if(url.pathname==='/mode'){if(data.mode!==0&&data.mode!==1)throw Error('无效界面');wantedMode=data.mode;settings.mode=wantedMode;persist();reply(200,{ok:true});}
  else if(url.pathname==='/layout'){if(data.layout!==0&&data.layout!==1)throw Error('无效歌词字号');if(connected&&!wire.layoutSupported)throw Error('当前屏幕固件不支持字号切换');settings.layout=data.layout;persist();reply(200,{ok:true});}
  else if(url.pathname==='/settings'){if(!Number.isInteger(data.offsetMs)||data.offsetMs< -10000||data.offsetMs>10000)throw Error('偏移超出范围');settings.offsetMs=data.offsetMs;persist();reply(200,{ok:true});}
  else if(url.pathname==='/retry'){music.retry();reply(200,{ok:true});}
  else if(url.pathname==='/lrc'){music.local(data.text);reply(200,{ok:true});}
  else if(url.pathname==='/startup'){if(DEMO)throw Error('演示模式不设置登录自启');if(typeof data.enabled!=='boolean')throw Error('无效设置');await startup(data.enabled);reply(200,{ok:true});}
  else if(url.pathname==='/stop'){reply(200,{ok:true});setTimeout(shutdown,100);}
  else reply(404,{error:'Not found'});
 }catch(e){reply(400,{error:e.message});}
});
async function shutdown(){if(stopping)return;stopping=true;music.stop();if(helper){helper.stdout.destroy();helper.stderr.destroy();helper.kill();helper.unref();}await disconnect();server.close();setTimeout(()=>process.exit(0),100).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
server.listen(0,'127.0.0.1',()=>{const port=server.address().port;fs.writeFileSync(path.join(OUT,'background-service.json'),JSON.stringify({pid:process.pid,port,url:'http://127.0.0.1:'+port,script:__filename},null,2));if(DEMO){music.accept({sessions:[{source:'QQMusic-demo',title:'雨后的像素电台',artist:'示例',status:'Playing',durationMs:180000,positionMs:2000,positionAt:Date.now(),current:true}],processes:[]});hotkey.error='演示模式：不连接设备、不注册快捷键';}else{music.start();startHotkey();loop().catch(e=>{error=e.message;});}console.log('Native lyrics bridge ready on localhost:'+port);});
