// SPDX-License-Identifier: MIT
import {AppClient,FlashClient} from './hid.mjs';
import {validateBuild} from './protocol.mjs';
const $=id=>document.getElementById(id),readJson=async p=>{const r=await fetch(p);if(!r.ok)throw Error('无法读取 '+p);return r.json();};
let profile=await readJson('../profiles/keys.json'),themes=await readJson('../profiles/themes.json'),font=await readJson('../profiles/font.json'),client=null,plan=null,flasher=null;
for(const [id,t] of Object.entries(themes))$('theme').add(new Option(t.name,id));
const current=()=>profile.glyphs[$('key').selectedIndex];
function validateProfile(p){const seen=new Set();if(!p?.glyphs?.length||p.idleTimeoutMs!==0)throw Error('配置格式不匹配');for(const g of p.glyphs){if(!Number.isInteger(g.key)||g.key<1||g.key>65535||seen.has(g.key)||!g.rows?.length||g.rows.length>11||!g.rows[0].length||g.rows[0].length>16||g.rows.some(r=>r.length!==g.rows[0].length||/[^01]/.test(r)))throw Error('图标尺寸、键码或像素格式错误');seen.add(g.key);}return p;}
function keyOptions(){const id=current()?.key;$('key').replaceChildren();for(const g of profile.glyphs)$('key').add(new Option(`${g.name} / ${g.key}`,g.key));if(id)$('key').value=id;}
function cells(ctx,rows,x,y,s,color){ctx.fillStyle=color;rows.forEach((r,yy)=>[...r].forEach((v,xx)=>{if(v==='1')ctx.fillRect(x+xx*s,y+yy*s,s,s);}));}
function text(ctx,value,x,y,scale,color){[...value].forEach((c,i)=>cells(ctx,font.ascii[c]||font.ascii['?'],x+i*6*scale,y,scale,color));}
function draw(){
 const t=themes[$('theme').value],c=$('preview').getContext('2d');c.fillStyle=t.background;c.fillRect(0,0,320,172);
 c.fillStyle=t.shell;c.beginPath();c.roundRect(7,37,306,129,16);c.fill();c.fillStyle=t.background;c.beginPath();c.roundRect(12,42,296,119,13);c.fill();
 c.fillStyle=t.ink;c.beginPath();c.roundRect(24,45,153,101,13);c.fill();c.fillStyle=t.panel;c.beginPath();c.roundRect(27,48,147,95,10);c.fill();
 const g=current();cells(c,g.rows,40+(120-g.rows[0].length*6)/2,57+(76-g.rows.length*6)/2,6,t.ink);text(c,'12:34:56',16,13,2,t.ink);text(c,'84%',287,17,1,t.ink);text(c,'RAINY',73,151,1,t.ink);
 c.strokeStyle=t.ink;c.lineWidth=1;c.strokeRect(264.5,17.5,16,7);c.fillStyle=t.ink;c.fillRect(267,20,10,3);c.fillRect(281,20,2,3);
 c.fillRect(251,58,8,7);c.fillRect(254,64,3,8);c.fillStyle=t.ink;c.beginPath();c.roundRect(218,70,75,51,8);c.fill();c.fillStyle=t.panel;c.beginPath();c.roundRect(221,73,69,45,6);c.fill();c.fillStyle=t.ink;c.fillRect(235,83,8,10);c.fillRect(268,83,8,10);c.fillRect(246,102,19,3);c.fillStyle=t.accent;c.fillRect(238,121,36,18);c.fillStyle=t.ink;c.fillRect(232,139,18,5);c.fillRect(262,139,18,5);
 const grid=$('pixels').getContext('2d'),s=18,w=g.rows[0].length,h=g.rows.length,x=Math.floor((320-w*s)/2),y=Math.floor((220-h*s)/2);grid.fillStyle='#fffafc';grid.fillRect(0,0,320,220);
 g.rows.forEach((r,yy)=>[...r].forEach((v,xx)=>{grid.fillStyle=v==='1'?t.ink:'#f2dce6';grid.fillRect(x+xx*s,y+yy*s,s-1,s-1);}));
}
keyOptions();draw();$('theme').onchange=draw;$('key').onchange=draw;
$('pixels').onpointerdown=e=>{const g=current(),r=$('pixels').getBoundingClientRect(),px=(e.clientX-r.left)*320/r.width,py=(e.clientY-r.top)*220/r.height,s=18,x=Math.floor((320-g.rows[0].length*s)/2),y=Math.floor((220-g.rows.length*s)/2),xx=Math.floor((px-x)/s),yy=Math.floor((py-y)/s);if(yy<0||yy>=g.rows.length||xx<0||xx>=g.rows[0].length)return;const row=[...g.rows[yy]];row[xx]=row[xx]==='1'?'0':'1';g.rows[yy]=row.join('');draw();};
$('clear').onclick=()=>{current().rows=current().rows.map(r=>'0'.repeat(r.length));draw();};
$('export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(profile,null,2)+'\n'],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='keys.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('import').onchange=async()=>{try{profile=validateProfile(JSON.parse(await $('import').files[0].text()));keyOptions();draw();}catch(e){alert(e.message);}};
function connected(ok){for(const id of ['read','disconnect','sync','upload'])$(id).disabled=!ok;$('connect').disabled=ok;}
function show(s){$('device-status').textContent=`主控 V7.1 · 屏幕 L6\n时间：${s.screenTime?.text||'--:--:--'}\n电量：${s.battery===null?'--':s.battery+'%'} · 连接：${s.mode===1?'USB':s.mode===0?'2.4G':s.mode<=4?'蓝牙':'未知'} · 最近键码：${s.key}`;}
async function deviceTask(fn){try{if(!client)throw Error('请先连接键盘');for(const id of ['read','sync','upload'])$(id).disabled=true;await fn();}catch(e){$('device-status').textContent=e.message;}finally{connected(Boolean(client));}}
$('timezone').value=Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Shanghai';
$('connect').onclick=async()=>{try{client=await AppClient.connect();show(await client.status());connected(true);}catch(e){await client?.close().catch(()=>{});client=null;connected(false);$('device-status').textContent=e.message;}};
$('read').onclick=()=>deviceTask(async()=>show(await client.status()));
$('disconnect').onclick=async()=>{await client?.close().catch(()=>{});client=null;connected(false);$('device-status').textContent='已断开。';};
$('sync').onclick=()=>deviceTask(async()=>{ $('device-status').textContent='正在校时并核对主控与屏幕…';show(await client.calibrate({timeZone:$('timezone').value}));$('device-status').textContent+='\n校时通过，可以关闭网页。';});
$('upload').onclick=()=>deviceTask(async()=>{const file=$('gif').files[0];if(!file)throw Error('请选择 GIF');$('device-status').textContent='正在写入 S1 素材…';await client.upload(new Uint8Array(await file.arrayBuffer()),{replaceConfirmed:$('replace').checked,progress:p=>$('upload-progress').value=p});$('device-status').textContent='上传已应答，请查看键盘画面。';});
$('verify').onclick=async()=>{try{const bin=$('bin').files[0],manifest=$('manifest').files[0];if(!bin||!manifest)throw Error('请选择 BIN 和 manifest.json');plan=await validateBuild(new Uint8Array(await bin.arrayBuffer()),JSON.parse(await manifest.text()));$('flash-status').textContent=`目标：${plan.target==='main'?'键盘主控':'IPS 屏幕'}\n应用区：0x${plan.base.toString(16)}\n${plan.bytes.length} bytes\nSHA-256：${plan.sha256}`;$('enter').disabled=$('iap').disabled=false;$('flash-go').disabled=true;}catch(e){plan=null;for(const id of ['enter','iap','flash-go'])$(id).disabled=true;$('flash-status').textContent=e.message;}};
$('enter').onclick=async()=>{try{const app=client||await AppClient.connect();await app.enterIap(plan.target);client=null;connected(false);$('flash-status').textContent+='\n已发送升级命令；请点“选择升级设备”。';}catch(e){$('flash-status').textContent=e.message;}};
$('iap').onclick=async()=>{try{flasher=await FlashClient.connect(plan);$('flash-go').disabled=false;$('flash-status').textContent+='\n升级设备已连接。';}catch(e){$('flash-status').textContent=e.message;}};
$('flash-go').onclick=async()=>{for(const id of ['verify','enter','iap','flash-go'])$(id).disabled=true;try{await flasher.flash((phase,p)=>{$('flash-progress').value=p;$('flash-status').textContent=`${phase} ${Math.round(p*100)}%`;});$('flash-status').textContent='烧录和全部字节校验完成。主控首次使用请重新连接并校时。';}catch(e){await flasher?.io.close().catch(()=>{});$('flash-status').textContent=e.message+'\n请参照恢复文档处理。';}finally{$('verify').disabled=false;}};
