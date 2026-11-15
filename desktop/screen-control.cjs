// SPDX-License-Identifier: MIT
'use strict';
// Only called from the serial HID loop or its cooperative packet yields.
// Reading the target again after awaits coalesces rapid Ctrl+F8 requests.
async function applyScreen(link,target){
 for(let pass=0;pass<4;pass++){
  const t=target();
  if(!t.mode){if(link.mode!==0)await link.setMode(0);if(!target().mode)return;continue;}
  if(link.layoutSupported&&link.layout!==t.layout){await link.setLayout(t.layout);continue;}
  if(link.mode!==1){await link.setMode(1);continue;}
  if(t.layout===4&&link.textSupported&&(link.textSize!==t.textSize||link.textStyle!==t.textStyle)){await link.setTypography(t.textSize,t.textStyle);continue;}
  return;
 }
}
module.exports={applyScreen};
