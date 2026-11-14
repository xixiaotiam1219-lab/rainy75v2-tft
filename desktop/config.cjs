// SPDX-License-Identifier: MIT
'use strict';
const path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
module.exports={ROOT,DATA:path.resolve(process.env.RAINY75_DATA||path.join(ROOT,'local/lyrics')),FONT:path.resolve(process.env.RAINY75_FONT||path.join(ROOT,'build/ips-lyrics/FONT.BIN'))};
