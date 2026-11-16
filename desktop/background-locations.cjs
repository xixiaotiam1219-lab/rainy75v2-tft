// SPDX-License-Identifier: MIT
'use strict';
const fs=require('node:fs'),path=require('node:path');
function defaultRegistryFile(env=process.env){
 if(env.RAINY75_REGISTRY)return path.resolve(env.RAINY75_REGISTRY);
 const root=env.LOCALAPPDATA||env.APPDATA;
 return root?path.join(root,'Rainy75V2-TFT','background-locations.json'):null;
}
function validServiceFile(value){return typeof value==='string'&&path.isAbsolute(value)&&!/^[/\\]{2}/.test(value)&&path.basename(value)==='background-service.json';}
function registeredServiceFiles(registry){
 if(!registry)return[];
 try{const raw=fs.readFileSync(registry,'utf8');if(raw.length>65536)return[];const data=JSON.parse(raw);return data.format==='rainy75v2/background-locations-v1'&&Array.isArray(data.serviceFiles)?data.serviceFiles.filter(validServiceFile).slice(0,32):[];}catch{return[];}
}
function registerServiceFile(registry,file){
 if(!registry||!validServiceFile(file))return;
 const files=[file,...registeredServiceFiles(registry).filter(old=>old!==file)].slice(0,32);
 fs.mkdirSync(path.dirname(registry),{recursive:true});
 const temporary=registry+'.'+process.pid+'.tmp';
 fs.writeFileSync(temporary,JSON.stringify({format:'rainy75v2/background-locations-v1',serviceFiles:files},null,2));
 fs.renameSync(temporary,registry);
}
function startupServiceFiles(startupDir){
 if(!startupDir)return[];
 try{const raw=fs.readFileSync(path.join(startupDir,'Rainy75V2-TFT-Lyrics.vbs'));
  const text=(raw[0]===255&&raw[1]===254?raw.toString('utf16le'):raw.toString('utf8')).replace(/^\uFEFF/,'');
  const match=/\("RAINY75_DATA"\)\s*=\s*"((?:""|[^"])*)"/.exec(text);
  if(!match)return[];const file=path.join(match[1].replace(/""/g,'"'),'background-service.json');
  return validServiceFile(file)?[file]:[];
 }catch{return[];}
}
module.exports={defaultRegistryFile,registeredServiceFiles,registerServiceFile,startupServiceFiles};
