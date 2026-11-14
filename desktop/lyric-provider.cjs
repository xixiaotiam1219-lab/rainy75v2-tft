// SPDX-License-Identifier: MIT
'use strict';
// Public catalogue metadata only. Never reads player accounts or credentials.
const provider=s=>/qqmusic/i.test(s)?'qq':/cloudmusic|netease/i.test(s)?'netease':null;
const clean=s=>decodeEntities(s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
function decodeEntities(value){
 let s=String(value??'');
 for(let i=0;i<2;i++)s=s.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,(all,key)=>{
  if(key[0]==='#'){const n=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):all;}
  return{amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '}[key.toLowerCase()];
 });return s;
}
function parseLrc(text,{media,credits=true}={}){
 const raw=decodeEntities(text).replace(/^\uFEFF/,''),offset=Number(/\[offset:([+-]?\d+)\]/i.exec(raw)?.[1]||0),lines=[];
 const credit=/^(?:词|曲|作词|作曲|编曲|演唱|歌手|制作人|制作|监制|录音|混音|母带|和声|发行|出品|词曲|原唱|音乐总监|录音师|混音师|OP|SP|Lyrics?(?:\s+by)?|Compos(?:er|ed\s+by)|Written\s+by|Arrang(?:er|ed\s+by)|Produced\s+by|Vocal(?:s)?)\s*[:：]/i;
 for(const row of raw.split(/\r?\n/)){
  const stamps=[...row.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
  const value=row.replace(/\[[^\]]*\]/g,'').replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g,'').trim();
  if(!value||credits&&credit.test(value))continue;
  for(const m of stamps){
   if(Number(m[2])>=60)continue;
   const at=Math.max(0,(Number(m[1])*60+Number(m[2]))*1000+Number((m[3]||'0').padEnd(3,'0'))+offset);
   // Timed title/artist banners are not sung lines. Keep genuine repeated titles.
   if(credits&&media&&at<15000&&/\s[-–—]\s/.test(value)&&clean(value)===clean(media.title)+clean(media.artist))continue;
   lines.push({at,text:[...value].slice(0,600).join('')});
  }
 }
 return lines.sort((a,b)=>a.at-b.at).filter((x,i,a)=>!i||x.at!==a[i-1].at||x.text!==a[i-1].text);
}
function artistTokens(value){return String(value||'').replace(/\b(?:feat\.?|ft\.?|featuring)\s+/gi,'/').split(/\s*(?:\/|&|、|，|,|;|；)\s*/).map(clean).filter(Boolean);}
function artistMatch(candidate,query){
 const want=artistTokens(query),have=artistTokens(candidate);if(!want.length||!have.length)return false;
 return want.every(q=>have.some(c=>c===q||(q.length>=3&&c.length>=3&&(c.includes(q)||q.includes(c)))));
}
const versionTests=[['remix',/\bremix\b|混音|混音版/i],['live',/\blive\b|现场|現場|演唱会|演唱會/i],['instrumental',/\binstrumental\b|\baccompaniment\b|伴奏|纯音乐|純音樂/i],['acoustic',/\bacoustic\b|\bunplugged\b|不插电|不插電/i],['edit',/\bradio\s+edit\b|\bradio\s+version\b|\bedit\b/i],['sped',/\bsped\s*up\b|加速/i],['slowed',/\bslowed\b|慢速|降速/i],['remaster',/\bremaster(?:ed)?\b|重制|重製/i]];
function versions(s){return new Set(versionTests.filter(([,re])=>re.test(s)).map(([name])=>name));}
function baseTitle(s){return String(s||'').replace(/[（(\[]([^）)\]]*)[）)\]]/g,(all,inside)=>versions(inside).size?'':all).trim();}
function rankCandidates(candidates,media,{cross=false}={}){
 const title=clean(media.title),base=clean(baseTitle(media.title)),requested=versions([media.title,media.albumTitle].filter(Boolean).join(' ')),duration=Number(media.durationMs)||0;
 return candidates.map(c=>{
  if(!c.id||!artistMatch(c.artist,media.artist))return null;
  const exact=clean(c.title)===title;if(!exact&&clean(baseTitle(c.title))!==base)return null;
  const variant=versions(c.title+' '+(c.album||''));if([...variant].some(v=>!requested.has(v))||[...requested].some(v=>!variant.has(v)))return null;
  const delta=duration&&c.durationMs?Math.abs(duration-c.durationMs):null;
  const tolerance=cross?Math.max(1500,Math.min(3000,duration*.008)):Math.max(2500,Math.min(4000,duration*.015));
  if(cross&&delta===null||delta!==null&&delta>tolerance)return null;
  const album=media.albumTitle&&clean(c.album)===clean(media.albumTitle);
  return{...c,durationDeltaMs:delta,score:(exact?100:90)+40+(delta===null?0:30-delta/250)+(album?15:0)};
 }).filter(Boolean).sort((a,b)=>b.score-a.score);
}
function parseJson(text){
 let s=String(text).replace(/^\uFEFF/,'').trim();
 if(!s.startsWith('{')&&!s.startsWith('[')){const m=/^[\w.$]+\s*\(([\s\S]*)\)\s*;?$/.exec(s);if(m)s=m[1];}
 return JSON.parse(s);
}
async function json(url,options={}){
 const response=await fetch(url,{...options,signal:AbortSignal.any([AbortSignal.timeout(6000),...(options.signal?[options.signal]:[])]),headers:{'User-Agent':'Mozilla/5.0',...options.headers}});
 if(!response.ok)throw Error('歌词服务暂不可用 HTTP '+response.status);
 const text=await response.text();if(text.length>2097152)throw Error('歌词响应过大');return parseJson(text);
}
function rawLrc(value){let s=decodeEntities(value);if(s&&!s.includes('[')&&/^[A-Za-z0-9+/=\s]+$/.test(s))s=Buffer.from(s,'base64').toString('utf8');return s;}
async function search(kind,media,query,request){
 if(kind==='qq'){
  const data={comm:{format:'json',ct:19,cv:0},req_0:{module:'music.search.SearchCgiService',method:'DoSearchForQQMusicDesktop',param:{query,num_per_page:30,page_num:1,search_type:0}}};
  const r=await request('https://u.y.qq.com/cgi-bin/musicu.fcg?data='+encodeURIComponent(JSON.stringify(data)),{headers:{Referer:'https://y.qq.com/'}});
  return(r.req_0?.data?.body?.song?.list||[]).map(s=>({id:s.mid,title:s.title||s.name,artist:(s.singer||[]).map(a=>a.name).join('/'),album:s.album?.title||s.album?.name||'',durationMs:Number(s.interval)*1000||0}));
 }
 const r=await request('https://music.163.com/api/search/get/web?csrf_token=',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Referer:'https://music.163.com/'},body:new URLSearchParams({s:query,type:'1',offset:'0',limit:'30'})});
 return(r.result?.songs||[]).map(s=>({id:String(s.id),title:s.name,artist:(s.artists||s.ar||[]).map(a=>a.name).join('/'),album:(s.album||s.al)?.name||'',durationMs:Number(s.duration||s.dt)||0}));
}
async function lyric(kind,id,media,request){
 let r;if(kind==='qq')r=await request('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?'+new URLSearchParams({songmid:id,format:'json',nobase64:'1',g_tk:'5381',platform:'yqq.json',inCharset:'utf8',outCharset:'utf-8',needNewCode:'0'}),{headers:{Referer:'https://y.qq.com/'}});
 else r=await request('https://music.163.com/api/song/lyric?'+new URLSearchParams({id,lv:'1',kv:'1',tv:'-1'}),{headers:{Referer:'https://music.163.com/'}});
 const lines=parseLrc(rawLrc(kind==='qq'?r.lyric:r.lrc?.lyric),{media});
 if(!lines.length||media.durationMs&&lines.at(-1).at>media.durationMs+10000)throw Error('此版本未返回有效的时间轴歌词');return lines;
}
async function fetchLines(media,{request=json,signal}={}){
 const primary=provider(media.source);if(!primary)throw Error('当前播放器暂不支持');
 const bounded=AbortSignal.any([AbortSignal.timeout(22000),...(signal?[signal]:[])]),ask=(url,options={})=>request(url,{...options,signal:bounded});
 const attempts=[];
 if(primary==='netease'&&/^\d{1,20}$/.test(media.songId||'')){
  const lines=await lyric(primary,media.songId,media,ask);return{lines,provider:primary,match:{id:media.songId,title:media.title,artist:media.artist,durationMs:media.durationMs,method:'player-song-id'},attempts};
 }
 for(const kind of [primary,primary==='qq'?'netease':'qq']){
  const cross=kind!==primary,seen=new Set;
  for(const query of [...new Set([media.title+' '+(media.artist||'').replace(/\//g,' '),media.title])]){
   let candidates;try{candidates=rankCandidates(await search(kind,media,query,ask),media,{cross});}catch(e){if(signal?.aborted)throw e;attempts.push({provider:kind,stage:'search',error:e.message});continue;}
   for(const c of candidates.filter(c=>!seen.has(c.id)).slice(0,4)){
    seen.add(c.id);
    try{const lines=await lyric(kind,c.id,media,ask);return{lines,provider:cross?kind+'-match':kind,match:{id:c.id,title:c.title,artist:c.artist,album:c.album,durationMs:c.durationMs,durationDeltaMs:c.durationDeltaMs,method:cross?'cross-platform-version-match':'same-platform-version-match'},attempts};}
    catch(e){if(signal?.aborted)throw e;attempts.push({provider:kind,id:c.id,stage:'lyric',error:e.message});}
   }
  }
 }
 const error=Error('暂未找到同歌手、同版本的可用歌词，稍后会自动重试。');error.attempts=attempts;throw error;
}
module.exports={provider,parseLrc,decodeEntities,artistMatch,rankCandidates,parseJson,rawLrc,fetchLines};
