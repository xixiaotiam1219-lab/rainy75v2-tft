// SPDX-License-Identifier: MIT
'use strict';
const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const portableRuntime=fs.existsSync(path.join(ROOT,'..','runtime','node.exe'));
const defaultData=portableRuntime?path.resolve(ROOT,'..','data'):path.join(ROOT,'local/lyrics');
const portableFont=path.join(ROOT,'FONT.BIN');
const defaultFont=fs.existsSync(portableFont)?portableFont:path.join(ROOT,'build/ips-lyrics/FONT.BIN');
const editionFile=path.join(ROOT,'edition.json');
let EDITION=null;
if(fs.existsSync(editionFile)){
 const edition=JSON.parse(fs.readFileSync(editionFile,'utf8'));
 if(edition.format!=='rainy75v2/edition-v1'||typeof edition.id!=='string'||
    !(edition.layout===null||Number.isInteger(edition.layout)&&edition.layout>=0&&edition.layout<=4)){
  throw Error('安装包版式配置无效');
 }
 EDITION=Object.freeze(edition);
}
module.exports={ROOT,EDITION,DATA:path.resolve(process.env.RAINY75_DATA||defaultData),FONT:path.resolve(process.env.RAINY75_FONT||defaultFont)};
