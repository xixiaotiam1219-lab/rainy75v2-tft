// SPDX-License-Identifier: MIT
'use strict';
// Small local background bridge: global hotkey notifications, current media only,
// cached font glyph IDs on line changes, 17-byte timing snapshots once per second.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{spawn,execFile}=require('node:child_process'),{createInterface}=require('node:readline');
const T=require('./transport.cjs'),{LyricLink}=require('./lyric-link.cjs'),{Music}=require('./music.cjs'),{Cover}=require('./cover.cjs'),{Volume,VolumeDispatcher}=require('./volume.cjs');
const covers=new Cover;
const {applyScreen}=require('./screen-control.cjs');
const volume=new Volume,volumeDispatcher=new VolumeDispatcher(volume);
const {DATA:OUT}=require('./config.cjs'),DEMO=process.argv.includes('--demo');
if(!DEMO&&process.platform!=='win32')throw Error('Realtime media requires Windows; use --demo for an offline preview');
fs.mkdirSync(OUT,{recursive:true});const settingsPath=path.join(OUT,'background-settings.json');
let settings={offsetMs:0,mode:1,layout:1,textSize:30,textStyle:0,volumeEnabled:true,volumeScope:0,volumeStyle:0,volumeHoldMs:1000};try{Object.assign(settings,JSON.parse(fs.readFileSync(settingsPath)));}catch{}settings.offsetMs=Math.max(-10000,Math.min(10000,Number(settings.offsetMs)||0));settings.mode=settings.mode===0?0:1;settings.layout=Number.isInteger(settings.layout)&&settings.layout>=0&&settings.layout<5?settings.layout:1;settings.textSize=[20,30,40].includes(settings.textSize)?settings.textSize:30;settings.textStyle=settings.textStyle===1?1:0;
settings.volumeEnabled=settings.volumeEnabled!==false;settings.volumeScope=settings.volumeScope===1?1:0;settings.volumeStyle=settings.volumeStyle===1?1:0;settings.volumeHoldMs=Number.isInteger(settings.volumeHoldMs)&&settings.volumeHoldMs>=400&&settings.volumeHoldMs<=3000?settings.volumeHoldMs:1000;
const persist=()=>fs.writeFileSync(settingsPath,JSON.stringify(settings,null,2));
const music=new Music(DEMO?{fetcher:async()=>({provider:'demo',lines:[{at:0,text:'把小小的屏幕点亮'},{at:5000,text:'文字跟着旋律慢慢滚动'},{at:10000,text:'今天也有新的好心情'}]})}:{});let c=null,link=null,wantedMode=settings.mode,connected=false,error=null,stopping=false,connectAt=0,lastKey='',lastCover='',coverRetryAt=0,lastSync=0,hotkey={ready:false,error:null},helper;
let wire={revision:null,committedAt:null,commitMs:null,timingAt:null,titleLimit:null,layout:null,layoutSupported:false,layoutCount:0,coverMs:null,coverError:null,frame:null};
const state=()=>{const frame=music.frame(settings.offsetMs);return{pid:process.pid,demo:DEMO,connected,wantedMode,settings,hotkey,error,volume:{...volume.state(),error:volumeDispatcher.error||volume.error},artwork:covers.state(),music:music.state(),frame,wire};};
async function disconnect(){const old=c;c=null;link=null;connected=false;lastKey='';lastCover='';wire.layoutSupported=false;wire.layoutCount=0;wire.volumeSupported=false;if(old)await old.close().catch(()=>{});}
const pumpVolume=()=>volumeDispatcher.pump(link,settings);
async function pumpDisplay(){if(!link)return;await applyScreen(link,()=>({mode:wantedMode,layout:settings.layout,textSize:settings.textSize,textStyle:settings.textStyle}));wire.layout=link.layout;wire.mode=link.mode;await pumpVolume();}
async function loop(){
 while(!stopping){try{
  if(settings.volumeEnabled)volume.start();else if(volume.child)await volume.stop();
  if(!c){if(Date.now()<connectAt){await T.delay(150);continue;}connectAt=Date.now()+4000;c=await T.usb();await T.ready(c);link=new LyricLink(c);await link.ready();link.onYield=pumpDisplay;connected=true;error=null;lastKey='';wire.titleLimit=link.titleLimit;wire.layoutSupported=link.layoutSupported;wire.layoutCount=link.layoutCount;wire.volumeSupported=link.volumeSupported;}
  if(link.layoutSupported&&settings.layout>=link.layoutCount){settings.layout=link.layout;persist();}
  await pumpDisplay();wire.textSupported=link.textSupported;
  if(!wantedMode){error=null;await T.delay(25);continue;}
  const frame=music.frame(settings.offsetMs),key=JSON.stringify([frame.title,frame.current,frame.next]);
  if(key!==lastKey){const start=Date.now(),revision=await link.setFrame(frame),committedAt=Date.now();lastKey=key;wire={...wire,revision,committedAt,commitMs:committedAt-start,frame};
   // Font masks take time to prepare. Resample the real media timeline after
   // commit instead of leaving the display at the pre-render position.
   const fresh=music.frame(settings.offsetMs);if(wantedMode&&JSON.stringify([fresh.title,fresh.current,fresh.next])===key){await link.sync(fresh);Object.assign(wire,link.paint||{});wire.frame=fresh;wire.timingAt=Date.now();}lastSync=Date.now();}
  else if(Date.now()-lastSync>=1000){await link.sync(frame);Object.assign(wire,link.paint||{});lastSync=Date.now();wire.timingAt=lastSync;}
  await pumpDisplay();
  if(link.coverSupported&&wantedMode&&settings.layout===4){
   const cover=covers.update(music.media),identity=covers.key+'|'+(cover?.hash||'empty');
   if(identity!==lastCover&&Date.now()>=coverRetryAt){try{const started=Date.now();const transferred=await link.setCover(cover);wire.coverBytes=transferred.bytes;lastCover=identity;wire.coverMs=Date.now()-started;wire.coverError=null;}catch(e){wire.coverError=e.message;coverRetryAt=Date.now()+10000;}}
  }
  error=null;
 }catch(e){error=e.message;await disconnect();}await T.delay(100);}
}
function nextScreen(){const count=connected?wire.layoutCount:5;if(!count){wantedMode=wantedMode?0:1;}else if(!wantedMode){settings.layout=0;wantedMode=1;}else if(settings.layout+1<count){settings.layout++;}else wantedMode=0;settings.mode=wantedMode;persist();}
function startHotkey(){helper=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'toggle-hotkey.ps1')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 createInterface({input:helper.stdout}).on('line',line=>{try{const e=JSON.parse(line);if(e.event==='ready'){hotkey.ready=true;hotkey.error=null;}else if(e.event==='toggle'){nextScreen();}else if(e.event==='error'){hotkey.ready=false;hotkey.error=e.message;}}catch{}});helper.stderr.on('data',()=>{});helper.on('error',()=>{hotkey.error='快捷键注册失败';});helper.on('exit',()=>{hotkey.ready=false;});
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
  else if(url.pathname==='/layout'){if(!Number.isInteger(data.layout)||data.layout<0||data.layout>=5)throw Error('无效播放器模板');if(connected&&data.layout>=wire.layoutCount)throw Error('当前屏幕固件不支持此模板');settings.layout=data.layout;wantedMode=1;settings.mode=1;persist();reply(200,{ok:true});}
  else if(url.pathname==='/type'){if(![20,30,40].includes(data.size)||!Number.isInteger(data.style)||data.style<0||data.style>1)throw Error('无效字体设置');if(connected&&!wire.textSupported)throw Error('需要更新屏幕固件');settings.textSize=data.size;settings.textStyle=data.style;settings.layout=4;settings.mode=wantedMode=1;persist();reply(200,{ok:true});}
  else if(url.pathname==='/volume'){if(typeof data.enabled!=='boolean'||!Number.isInteger(data.scope)||data.scope<0||data.scope>1||!Number.isInteger(data.style)||data.style<0||data.style>1||!Number.isInteger(data.holdMs)||data.holdMs<400||data.holdMs>3000)throw Error('无效音量提示设置');if(!DEMO&&connected&&!wire.volumeSupported)throw Error('需要更新屏幕固件才能显示音量');Object.assign(settings,{volumeEnabled:data.enabled,volumeScope:data.scope,volumeStyle:data.style,volumeHoldMs:data.holdMs});persist();reply(200,{ok:true});}
  else if(url.pathname==='/volume/preview'){if(DEMO)throw Error('离线演示不读取系统音量或发送设备提示');if(!connected||!wire.volumeSupported)throw Error('请连接支持音量提示的屏幕');if(!settings.volumeEnabled)throw Error('请先开启音量提示');if(!settings.volumeScope&&!(wantedMode===1&&settings.layout===4))throw Error('当前设置仅在沉浸页显示，请切换到沉浸页');volume.preview();reply(200,{ok:true});}
  else if(url.pathname==='/screen/next'){nextScreen();reply(200,{ok:true});}
  else if(url.pathname==='/settings'){if(!Number.isInteger(data.offsetMs)||data.offsetMs< -10000||data.offsetMs>10000)throw Error('偏移超出范围');settings.offsetMs=data.offsetMs;persist();reply(200,{ok:true});}
  else if(url.pathname==='/retry'){music.retry();reply(200,{ok:true});}
  else if(url.pathname==='/lrc'){music.local(data.text);reply(200,{ok:true});}
  else if(url.pathname==='/startup'){if(DEMO)throw Error('演示模式不设置登录自启');if(typeof data.enabled!=='boolean')throw Error('无效设置');await startup(data.enabled);reply(200,{ok:true});}
  else if(url.pathname==='/stop'){reply(200,{ok:true});setTimeout(shutdown,100);}
  else reply(404,{error:'Not found'});
 }catch(e){reply(400,{error:e.message});}
});
async function shutdown(){if(stopping)return;stopping=true;music.stop();covers.stop();await volume.stop();if(helper){helper.stdout.destroy();helper.stderr.destroy();helper.kill();helper.unref();}await disconnect();server.close();setTimeout(()=>process.exit(0),100).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
server.listen(0,'127.0.0.1',()=>{const port=server.address().port;fs.writeFileSync(path.join(OUT,'background-service.json'),JSON.stringify({pid:process.pid,port,url:'http://127.0.0.1:'+port,script:__filename},null,2));if(DEMO){music.accept({sessions:[{source:'QQMusic-demo',title:'雨后的像素电台',artist:'示例',status:'Playing',durationMs:180000,positionMs:2000,positionAt:Date.now(),current:true}],processes:[]});hotkey.error='演示模式：不连接设备、不注册快捷键';}else{music.start();startHotkey();loop().catch(e=>{error=e.message;});}console.log('Native lyrics bridge ready on localhost:'+port);});
