// SPDX-License-Identifier: MIT; serial protocol fixtures, no HID access.
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{applyScreen}=require('../desktop/screen-control.cjs'),{LyricLink}=require('../desktop/lyric-link.cjs'),{fontFixture}=require('./font-fixture.cjs');
test('leaving player prioritizes mode and does not wait for layout or typography',async()=>{
 const calls=[],l={mode:1,layout:4,layoutSupported:true,textSupported:true,textSize:20,textStyle:1,async setMode(n){calls.push('mode');this.mode=n;},setLayout(){assert.fail('Unneeded layout change');},setTypography(){assert.fail('Unneeded font change');}};
 await applyScreen(l,()=>({mode:0,layout:0,textSize:30,textStyle:0}));assert.deepEqual(calls,['mode']);assert.equal(l.mode,0);
});
test('screen controls coalesce a new target arriving during an awaited packet',async()=>{
 let target={mode:1,layout:0,textSize:30,textStyle:0};const calls=[],l={mode:1,layout:4,layoutSupported:true,async setLayout(n){calls.push('layout '+n);this.layout=n;target={...target,mode:0};},async setMode(n){calls.push('mode '+n);this.mode=n;}};
 await applyScreen(l,()=>target);assert.deepEqual(calls,['layout 0','mode 0']);assert.equal(l.mode,0);
});
test('pending glyph preparation yields to screen switch before the glyph job commits',async()=>{
 let mode=1,committed=0,rev,field=0,desired=1,busy=false;const operations=[];
 const c={request:async(op,id,p)=>{assert(!busy,'Concurrent HID request');busy=true;await Promise.resolve();operations.push(op===22?'q'+id:op);let value=id;
  if(op===20){if(++field===1)desired=0;}
  else if(op===21)rev=id;
  else if(op===23){mode=p[0];}
  else if(op===22){if(id===1)value=mode;else if(id===3)value=committed=rev;else if(id===2)value=0;else assert.fail('Unexpected query');}
  busy=false;return{status:op===21?0:1,value};}};
 const l=new LyricLink(c,fontFixture());l.mode=1;l.layout=4;l.layoutSupported=true;l.onYield=()=>applyScreen(l,()=>({mode:desired,layout:4}));
 await l.setFrame({title:'A',current:'B',next:'C'});assert.equal(mode,0);assert(operations.indexOf(23)<operations.indexOf(21));assert.equal(committed,rev);
});
test('cover publish polling yields screen priority while preserving a single request stream',async()=>{
 let rev,actualLayout=4,targetLayout=4,polls=0,busy=false;const operations=[];
 const c={request:async(op,id,p)=>{assert(!busy);busy=true;await Promise.resolve();operations.push(op===22?'q'+id:op);let value=id,status=1;
  if(op===28){rev=p.readUInt16LE(1);status=0;}
  else if(op===26)actualLayout=p[0];
  else if(op===22){if(id===13){polls++;value=polls>=2?1:2;targetLayout=0;}else if(id===14)value=rev;else if(id===8)value=actualLayout;else assert.fail('Unexpected query');}
  busy=false;return{status,value};}};
 const l=new LyricLink(c,fontFixture());Object.assign(l,{coverSupported:true,mode:1,layout:4,layoutSupported:true,layoutCount:5});l.onYield=()=>applyScreen(l,()=>({mode:1,layout:targetLayout}));
 await l.setCover(null);assert.equal(actualLayout,0);assert(operations.indexOf(26)<operations.lastIndexOf('q13'));
});
