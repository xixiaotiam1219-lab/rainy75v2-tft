// SPDX-License-Identifier: MIT; offline demo only, no HID or player access.
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),data=path.join(root,'build/console-browser-demo');await mkdir(data,{recursive:true});
const child=spawn(process.execPath,[path.join(root,'desktop/bridge.cjs'),'--demo'],{env:{...process.env,RAINY75_DATA:data},windowsHide:true,stdio:['ignore','pipe','pipe']});let browser,service;const errors=[];
try{
 const start=Date.now();while(Date.now()-start<6000){try{service=JSON.parse(await readFile(path.join(data,'background-service.json'),'utf8'));if(service.pid===child.pid)break;}catch{}await new Promise(r=>setTimeout(r,50));}assert.equal(service?.pid,child.pid);
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});const page=await browser.newPage({viewport:{width:900,height:1100},deviceScaleFactor:1});page.on('pageerror',e=>errors.push(e.message));await page.goto(service.url);await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('离线演示'));
 assert((await page.locator('#title').textContent()).includes('雨后的像素电台'));
 await page.locator('#earlier').click();await page.waitForFunction(()=>document.querySelector('#offsetValue').textContent.includes('提前 0.5'));
 await page.locator('#later').click();await page.waitForFunction(()=>document.querySelector('#offsetValue').textContent==='0.0 秒');
 await page.locator('#offsetNumber').fill('-1.2');await page.locator('#offsetNumber').press('Tab');await page.waitForFunction(()=>document.querySelector('#offsetValue').textContent.includes('延后 1.2'));
 await page.locator('#resetOffset').click();await page.waitForFunction(()=>document.querySelector('#offsetValue').textContent==='0.0 秒');
 await page.locator('#keys').click();await page.waitForFunction(()=>document.querySelector('#keys').classList.contains('active'));await page.locator('#player').click();await page.waitForFunction(()=>document.querySelector('#player').classList.contains('active'));
 await page.locator('#layout20').click();await page.waitForFunction(()=>document.querySelector('#layout20').classList.contains('active'));await page.locator('#layout40').click();await page.waitForFunction(()=>document.querySelector('#layout40').classList.contains('active'));
 await page.screenshot({path:path.join(root,'assets/lyrics-console.png'),fullPage:true});await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
 await writeFile(path.join(root,'build/lyrics-browser-validation.json'),JSON.stringify({passed:true,physicalHardwareAccessed:false,checks:['offline demo only','offset buttons and numeric input/reset','page selection','desktop/mobile layout'],pageErrors:errors},null,2));console.log('Lyrics console browser check passed; no HID/media access.');
}finally{await browser?.close();if(service?.pid===child.pid)try{await fetch(service.url+'/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});}catch{}if(child.exitCode===null)child.kill();}
