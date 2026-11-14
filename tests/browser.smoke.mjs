// SPDX-License-Identifier: MIT
// Optional: install playwright separately; never opens real hardware.
import {createRequire} from 'node:module';import {spawn} from 'node:child_process';import {mkdir,writeFile,readFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import path from 'node:path';import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),port=18765,server=spawn(process.env.PYTHON||'python',['tools/serve.py','--port',String(port)],{cwd:root,windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));let browser;
try{
 for(let i=0;i<60;i++){try{if((await fetch(`http://127.0.0.1:${port}/web/`)).ok)break;}catch{}await delay(100);}
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
 const context=await browser.newContext({viewport:{width:1280,height:1080}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  const listeners=new Set;let ack=[13,0,0,0],seconds=null,at=0;const state={writes:0,cap:0x4350};
  const report={reportId:0,items:[{reportSize:8,reportCount:256}]};
  const d={vendorId:0x36b0,productId:0x3075,opened:false,collections:[{usagePage:0xff60,usage:0x61,inputReports:[report],outputReports:[report]}],open:async()=>{d.opened=true;},close:async()=>{d.opened=false;},addEventListener:(e,f)=>listeners.add(f),removeEventListener:(e,f)=>listeners.delete(f),sendReport:async(id,p)=>{
   if(id!==0||p.length!==256)throw Error('Unexpected report');
   const s=seconds===null?0xffffffff:(seconds+Math.floor((Date.now()-at)/1000))%86400;
   if(p[1]===0x1a){const op=p[4],f=p[5],seq=f|p[6]<<8;let v,status;
    if(op===15){status=0xd0+f;v=f===9?state.cap:f===8?Number(seconds!==null):f===7?s>>>16:f===6?s&65535:0;}
    else if(op===11){const bcd=s===0xffffffff?s:parseInt([Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(v=>String(v).padStart(2,'0')).join(''),16);status=0xb0+f;v=f===0?0x5536:f===4?(seconds===null?0x401:0x402):f===5?bcd&65535:f===6?bcd>>>16:f===2?84:f===3?1:40;}
    else if(op===18){seconds=new DataView(p.buffer,p.byteOffset).getUint32(8,true);at=Date.now();state.writes++;status=1;v=seq;}
    else throw Error('Unexpected command');ack=[13,status,v&255,v>>>8&255];return;
   }
   if(p[1]!==0xe4)throw Error('Factory write not allowed');const r=new Uint8Array(256);r.set([0xbe,0xe4,14,0x84,4,0,0,...ack,0,0,0xed]);const sum=r.slice(0,11).reduce((a,b)=>a+b,0);r[11]=sum&255;r[12]=sum>>>8;
   queueMicrotask(()=>listeners.forEach(f=>f({reportId:0,data:new DataView(r.buffer)})));
  }};Object.defineProperty(navigator,'hid',{value:{requestDevice:async()=>[d]},configurable:true});window.mockClock=state;
 });
 await page.goto(`http://127.0.0.1:${port}/web/`);await page.waitForFunction(()=>document.querySelectorAll('#key option').length>0);assert.equal(await page.locator('#sync').isDisabled(),true);
 await page.screenshot({path:path.join(root,'assets/studio.png')});
 await page.selectOption('#theme','mint');await page.selectOption('#key','227');await page.locator('#pixels').click({position:{x:90,y:50}});
 const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();const dl=await downloadPromise;await mkdir(path.join(root,'build'),{recursive:true});const target=path.join(root,'build/browser-keys.json');await dl.saveAs(target);assert(JSON.parse(await readFile(target,'utf8')).glyphs.length>0);
 await page.locator('#connect').click();await page.waitForFunction(()=>document.querySelector('#device-status').textContent.includes('V7.1'));
 await page.locator('#sync').click();await page.waitForFunction(()=>document.querySelector('#device-status').textContent.includes('校时通过'),null,{timeout:15000});assert.equal(await page.evaluate(()=>mockClock.writes),1);
 await page.locator('#disconnect').click();await page.evaluate(()=>{mockClock.cap=0x434f;});await page.locator('#connect').click();await page.waitForFunction(()=>document.querySelector('#device-status').textContent.includes('不是支持的 V7.1'));assert.equal(await page.evaluate(()=>mockClock.writes),1);
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
 await writeFile(path.join(root,'build/browser-validation.json'),JSON.stringify({passed:true,physicalHardwareAccessed:false,checks:['desktop/mobile layout','profile edit/export','own WebHID calibration flow','old firmware refused before write'],pageErrors:errors},null,2));console.log('Browser smoke passed; no real HID device accessed.');
}finally{await browser?.close();server.kill();}
