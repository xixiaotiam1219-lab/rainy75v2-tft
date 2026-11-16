// SPDX-License-Identifier: MIT
'use strict';
const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const portableRuntime=fs.existsSync(path.join(ROOT,'..','runtime','node.exe'));
const defaultData=portableRuntime?path.resolve(ROOT,'..','data'):path.join(ROOT,'local/lyrics');
const portableFont=path.join(ROOT,'FONT.BIN');
const defaultFont=fs.existsSync(portableFont)?portableFont:path.join(ROOT,'build/ips-lyrics/FONT.BIN');
module.exports={ROOT,DATA:path.resolve(process.env.RAINY75_DATA||defaultData),FONT:path.resolve(process.env.RAINY75_FONT||defaultFont)};
