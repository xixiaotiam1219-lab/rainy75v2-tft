// SPDX-License-Identifier: MIT
'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{DATA}=require('./config.cjs');
(async()=>{
 if(process.platform!=='win32')throw Error('实时媒体同步目前需要 Windows；离线控制台可运行 npm run lyrics:demo');
 fs.mkdirSync(DATA,{recursive:true});const bridge=path.join(__dirname,'bridge.cjs'),state=path.join(DATA,'background-service.json'),runtimePath=path.join(DATA,'background-runtime.json');
 const runtimeInfo=JSON.stringify({nodeExecutable:process.execPath,launcher:__filename,dataDirectory:DATA},null,2);
 try{const old=JSON.parse(fs.readFileSync(state));if(old.script===bridge&&/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(old.url)){const r=await fetch(old.url+'/state',{signal:AbortSignal.timeout(700)}),s=await r.json();if(r.ok&&s.pid===old.pid){fs.writeFileSync(runtimePath,runtimeInfo);console.log(old.url);return;}}}catch{}
 const lock=path.join(DATA,'background-launch.lock');let owned=false;
 try{
  try{fs.writeFileSync(lock,String(process.pid),{flag:'wx'});owned=true;}catch{if(Date.now()-fs.statSync(lock).mtimeMs<20000)throw Error('后台正在启动，请稍后再试');fs.unlinkSync(lock);fs.writeFileSync(lock,String(process.pid),{flag:'wx'});owned=true;}
  fs.writeFileSync(runtimePath,runtimeInfo);
  const out=fs.openSync(path.join(DATA,'background.log'),'a'),err=fs.openSync(path.join(DATA,'background-error.log'),'a');
  const child=spawn(process.execPath,[bridge],{cwd:__dirname,detached:true,windowsHide:true,stdio:['ignore',out,err]});let exited=false;child.once('exit',()=>{exited=true;});child.unref();fs.closeSync(out);fs.closeSync(err);
  const start=Date.now();while(Date.now()-start<15000){try{const s=JSON.parse(fs.readFileSync(state));if(s.pid===child.pid){console.log(s.url);return;}}catch{}if(exited)break;await new Promise(r=>setTimeout(r,100));}throw Error('后台启动失败，请查看 '+path.join(DATA,'background-error.log'));
 }finally{if(owned&&fs.existsSync(lock)&&fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
