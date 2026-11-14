// SPDX-License-Identifier: MIT
'use strict';
const path=require('node:path'),{execFile}=require('node:child_process'),{pathToFileURL}=require('node:url'),{ROOT}=require('./config.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms)),api=()=>import(pathToFileURL(path.join(ROOT,'web/hid.mjs')));
function inspect(devicePath){return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'hid-caps.ps1'),'-DevicePath',devicePath],{windowsHide:true,timeout:15000},(error,out)=>{if(error)return reject(Error('Cannot inspect USB HID descriptor'));try{resolve(JSON.parse(out));}catch{reject(Error('Invalid USB HID descriptor'));}}));}
async function usb({hid,readCaps=inspect}={}){
 const HID=hid||require('node-hid'),list=(await HID.devicesAsync()).filter(d=>d.vendorId===0x36b0&&d.productId===0x3075&&d.usagePage===0xff60&&d.usage===0x61);
 if(list.length!==1)throw Error('请用 USB 连接一把 Rainy75 V2，并切到有线模式');
 const caps=await readCaps(list[0].path);if(caps.UsagePage!==0xff60||caps.Usage!==0x61||caps.InputReportByteLength!==257||caps.OutputReportByteLength!==257)throw Error('Unexpected USB HID report descriptor');
 const handle=await HID.HIDAsync.open(list[0].path),listeners=new Set,report={reportId:0,items:[{reportSize:8,reportCount:256}]};
 const d={vendorId:0x36b0,productId:0x3075,opened:true,collections:[{usagePage:0xff60,usage:0x61,inputReports:[report],outputReports:[report]}],
  sendReport:async(id,p)=>{if(!d.opened||id!==0||p.length!==256)throw Error('USB interface closed or invalid report');if(await handle.write([0,...p])<256)throw Error('Short USB HID write');},
  addEventListener:(e,f)=>{if(e==='inputreport')listeners.add(f);},removeEventListener:(e,f)=>{if(e==='inputreport')listeners.delete(f);},
  close:async()=>{if(!d.opened&&d.closed)return;d.opened=false;d.closed=true;listeners.clear();await handle.close();}};
 handle.on('error',()=>{d.opened=false;});handle.on('data',raw=>{let b=Buffer.from(raw);if(b.length===257&&b[0]===0)b=b.subarray(1);if(b.length!==256||!d.opened)return;const p=Uint8Array.from(b);for(const f of listeners)f({reportId:0,data:new DataView(p.buffer)});});
 const {AppClient,HidIO}=await api();return new AppClient(new HidIO(d,256));
}
async function ready(c){if(await c.queryMain(9)!==0x4350)throw Error('需要主控 V7.1');if(await c.queryIps(0)!==0x5536)throw Error('需要屏幕 L6 与 LY1 歌词扩展');}
module.exports={ROOT,delay,api,usb,ready};
