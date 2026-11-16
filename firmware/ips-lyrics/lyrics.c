/* SPDX-License-Identifier: MIT
 * Bounded local font reader and monochrome text masks. Font licenses are separate.
 * File operations run only from the GUI worker, never from UART/LCD callbacks.
 */
#include "lyrics.h"
#include "cache_font.h"
#include "lyrics_font_config.h"
#define REG32(a) (*(volatile u32*)(a))
#define FIL_BYTES 0x1028u
#define MAX_TEXT 96u
#define LAYOUTS 5u
#define COVER_PIXELS 4096u
#include "lyrics_theme.h"
static inline const RainyThemeSlot *theme_slot(void){const RainyThemeSlot *p=&r75_theme;__asm__("":"+r"(p));return p;}
typedef struct {u8 count,advance[MAX_TEXT];u16 ids[MAX_TEXT],width;u8 *bits;} Line;
typedef struct {
 u8 file[FIL_BYTES];
 Line live[3],build[3],previous;
 u16 incoming[3][MAX_TEXT],incoming_rev,job_rev,committed;
 u8 incoming_count[3],cached[3],fields,queued,job,phase,which,at,ready,opened,error,playing;
 u8 next_playing,mode,wanted,transition,layout;
 u32 position,duration,received,next_position,next_duration,changed,last_draw,last_second,line_motion,last_tick;
 u32 line_span,next_line_span,next_line_motion,title_motion;
 u16 cover[2][COVER_PIXELS],palette[4],next_palette[4],cover_rev,cover_committed,cover_received,cover_total,source_marker,drawn_marker;
 u32 cover_crc,cover_expected;
 u8 cover_index,cover_active,cover_state,cover_begun,marker_known,cover_format,cover_dim,background_ready;
 u16 paint_last,paint_max;
 u8 text_size,text_style;
 u32 volume_shown,volume_changed,volume_drawn;
 u16 volume_from,volume_hold,volume_events;
 u8 volume_level,volume_muted,volume_scope,volume_style,volume_active,volume_restore;
} Lyrics;
static Lyrics *l;
static u8 initialize,release,last_error;
static u8 remove_state,remove_result;
static u32 remove_crc,remove_bytes;
static void bytes_zero(u8 *p,unsigned n){while(n--)*p++=0;}
static void bytes_copy(u8 *d,const u8 *s,unsigned n){while(n--)*d++=*s++;}
static void *alloc(unsigned n){u32 a=(u32)((void *(*)(unsigned))0x08025c09)(n);if(!a)return 0;if(a<0x20000000u||a>0x2005f000u-n){((void(*)(void*))0x0802ab35)((void*)a);return 0;}return(void*)a;}
static void dealloc(void *p){if(p)((void(*)(void*))0x0802ab35)(p);}
static u16 le16(const u8 *p){return(u16)(p[0]|p[1]<<8);}
static u32 le32(const u8 *p){return p[0]|p[1]<<8|p[2]<<16|(u32)p[3]<<24;}
static unsigned volume_alpha(u32 now){u32 entry,tail;unsigned a,b;if(!l||!l->volume_active)return 0;entry=now-l->volume_shown;tail=now-l->volume_changed;a=entry>=120u?256u:entry*256u/120u;b=tail<=l->volume_hold?256u:tail>=l->volume_hold+180u?0u:(l->volume_hold+180u-tail)*256u/180u;return a<b?a:b;}
static u16 volume_progress(u32 now){u32 t;int target,diff;if(!l)return 0;t=now-l->volume_changed;if(t>100u)t=100u;target=l->volume_muted?0:(int)l->volume_level*256;diff=target-(int)l->volume_from;return(u16)((int)l->volume_from+diff*(int)(t*(200u-t))/10000);}
static int volume_allowed(u32 now){return l&&volume_alpha(now)&&(l->volume_scope||(l->mode&&l->layout==4));}
int lyrics_volume_key(u32 now,u16 *progress,u8 *level,u8 *muted,u16 *alpha){if(!l||l->mode||!l->volume_scope||!volume_alpha(now))return 0;*progress=volume_progress(now);*level=l->volume_level;*muted=l->volume_muted;*alpha=(u16)volume_alpha(now);return 1;}
unsigned lyrics_volume_icon(unsigned x,unsigned y,int muted){if(x<5&&y>=4&&y<=8)return 1;if(x>=5&&x<=9&&y>=9u-x&&y<=x+3u)return 1;if(muted)return x>=11&&x<=15&&y>=4&&y<=8&&((x-11u)==(y-4u)||(x-11u)==(8u-y));return(x==12&&y>=4&&y<=8)||(x==11&&(y==3||y==9))||(x==15&&y>=3&&y<=9)||(x==14&&(y==2||y==10))||(x==13&&(y==1||y==11));}
static u32 header_crc(const u8 *p){u32 crc=0xffffffffu;unsigned i,j;for(i=0;i<256;i++){crc^=i>=40&&i<44?0:p[i];for(j=0;j<8;j++)crc=(crc>>1)^((0u-(crc&1u))&0xedb88320u);}return~crc;}
static int read_at(u32 offset,u8 *p,unsigned n){unsigned read=0;if(((unsigned(*)(void*,u32))0x0803d099)(l->file,offset))return 0;return!((unsigned(*)(void*,void*,unsigned,unsigned*))0x0803ccc9)(l->file,p,n,&read)&&read==n;}
static void drop(Line *p){dealloc(p->bits);p->bits=0;p->width=0;p->count=0;}
static void drop_build(void){unsigned i;for(i=0;i<3;i++)drop(&l->build[i]);l->job=0;}
static int open_font(void){
 u8 h[256];unsigned i;
 last_error=FAULT;l=alloc(sizeof *l);if(!l)return 0;bytes_zero((u8*)l,sizeof *l);
 if(((unsigned(*)(void*,const char*,unsigned))0x0803c805)(l->file,"FONT.BIN",1))goto bad;
 l->opened=1;
 last_error=FORMAT;if(!read_at(0,h,256)||le32(h)!=0x46353752u||le16(h+4)!=2||le16(h+6)!=256||h[8]!=20||h[9]!=20||le16(h+10)!=50||le16(h+12)!=52||le16(h+14)!=1||le32(h+16)!=FONT_COUNT||le32(h+20)!=256||le32(h+24)!=FONT_DATA_OFFSET||le32(h+32)!=FONT_TOTAL_BYTES||le32(h+36)!=FONT_BODY_CRC||le32(h+40)!=header_crc(h)||REG32((u32)l->file+12)!=FONT_TOTAL_BYTES)goto bad;
 for(i=0;i<3;i++)l->incoming_count[i]=0;
 l->layout=1;l->text_size=30;l->ready=1;last_error=0;return 1;
bad:
 if(l->opened)((unsigned(*)(void*))0x0803d075)(l->file);
 dealloc(l);l=0;return 0;
}
int lyrics_suspend(void){if(!l){initialize=0;return 1;}release=1;return 0;}
static void close_all(void){unsigned i;if(!l)return;for(i=0;i<3;i++){drop(&l->live[i]);drop(&l->build[i]);}drop(&l->previous);if(l->opened)((unsigned(*)(void*))0x0803d075)(l->file);dealloc(l);l=0;}
int lyrics_request(const u8 *p,u16 n,unsigned *status,u16 *value){
 unsigned op=p[4],kind,count,i;u16 seq=le16(p+5);*status=FORMAT;*value=seq;
 if(op<20||op>30)return 0;
 if(op==24&&n==11){initialize=1;*status=0xa6;*value=0x4c59;return 1;}
 if(op==22&&n==11){
  *status=0xc0+(seq&15u);
  switch(seq){case 0:*value=l?l->ready:initialize?2:0;break;case 1:*value=l?l->mode:0;break;case 2:*value=l?l->error:last_error;break;case 3:*value=l?l->committed:0;break;case 4:*value=l?(l->job|l->queued<<8):0;break;case 5:*value=FONT_BODY_CRC&65535u;break;case 6:*value=FONT_BODY_CRC>>16;break;case 7:*value=MAX_TEXT;break;case 8:*value=l?l->layout:1;break;case 9:*value=remove_state;break;case 10:*value=remove_result;break;case 11:*value=LAYOUTS;break;case 12:*value=0x4341;break;case 13:*value=l?l->cover_state:0;break;case 14:*value=l?l->cover_committed:0;break;case 15:*value=l?l->cover_received:0;break;case 16:*value=3;break;case 17:*value=l?l->paint_last:0;break;case 18:*value=l?l->paint_max:0;break;case 19:*value=l?l->background_ready:0;break;case 20:*value=1;break;case 21:*value=l?l->text_size:30;break;case 22:*value=l?l->text_style:0;break;case 23:*value=0x564f;break;case 24:*value=l?(l->volume_level|l->volume_muted<<8):0;break;case 25:*value=l?l->volume_events:0;break;case 26:*value=l?(l->volume_scope|l->volume_style<<8):0;break;case 27:*value=(u16)volume_alpha(((u32(*)(void))0x0803a2bb)());break;case 28:*value=l?l->volume_hold:0;break;default:*status=RANGE;}
  return 1;
 }
 if(op==27&&n==23&&le32(p+8)==0x21544e46u){
  if(l||initialize||remove_state==BUSY){*status=BUSY;return 1;}
  if(le32(p+16)<256||le32(p+16)>4194304u){*status=RANGE;return 1;}
  remove_crc=le32(p+12);remove_bytes=le32(p+16);remove_result=0;remove_state=BUSY;*status=QUEUED;return 1;
 }
 if(!l||!l->ready){initialize=1;*status=BUSY;return 1;}
 if(op==30&&n==17){
  u32 now=((u32(*)(void))0x0803a2bb)();unsigned alpha=volume_alpha(now);
  if(p[8]==255){l->volume_active=0;l->volume_restore=1;*status=DONE;return 1;}
  if(p[8]>100||p[9]>1||p[10]>1||p[11]>1||le16(p+12)<400||le16(p+12)>3000){*status=RANGE;return 1;}
  l->volume_from=volume_progress(now);if(!alpha)l->volume_shown=now;else if(alpha<256)l->volume_shown=now-alpha*120u/256u;
  l->volume_level=p[8];l->volume_muted=p[9];l->volume_scope=p[10];l->volume_style=p[11];l->volume_hold=le16(p+12);l->volume_changed=now;l->volume_active=1;l->volume_restore=0;l->volume_events++;*status=DONE;return 1;
 }
 if(op==29&&n==13){if((p[8]!=20&&p[8]!=30&&p[8]!=40)||p[9]>1){*status=RANGE;return 1;}l->text_size=p[8];l->text_style=p[9];*status=DONE;return 1;}
 if(op==28&&n>=14){
  u8 action=p[8];u16 rev=le16(p+9);u8 *target=(u8*)l->cover[l->cover_index^1u];
  if(l->cover_state==BUSY){*status=BUSY;return 1;}
  if(action==3&&n==14){l->cover_rev=rev;l->cover_begun=0;l->cover_received=0;l->cover_state=BUSY;*status=QUEUED;return 1;}
  if(action==0&&n==29&&((p[11]==64&&p[12]==64&&(p[13]==1||p[13]==2))||(p[11]==48&&p[12]==48&&p[13]==3))){
   l->cover_format=p[13];l->cover_total=p[13]==1?8192u:p[13]==2?3200u:1856u;
   if(p[13]<3)l->background_ready=0;
   l->cover_rev=rev;l->cover_received=0;l->cover_expected=le32(p+14);l->cover_crc=0xffffffffu;l->cover_state=0;l->cover_begun=1;
   for(i=0;i<4;i++)l->next_palette[i]=le16(p+18+i*2);*status=DONE;return 1;
  }
  if(!l->cover_begun||rev!=l->cover_rev||l->cover_state!=0){*status=RANGE;return 1;}
  if(action==1&&n>=18){
   unsigned offset=le16(p+11),bytes=n-16u,j;u32 crc=l->cover_crc;
   if((offset|bytes)&1u||offset!=l->cover_received||bytes>224u||offset+bytes>l->cover_total){*status=RANGE;return 1;}
   if(l->cover_format==3)target+=6144u;
   for(i=0;i<bytes;i++){u8 b=p[13+i];target[offset+i]=b;crc^=b;for(j=0;j<8;j++)crc=(crc>>1)^((0u-(crc&1u))&0xedb88320u);}
   l->cover_crc=crc;l->cover_received=(u16)(offset+bytes);*status=DONE;return 1;
  }
  if(action==2&&n==14){
   if(l->cover_received!=l->cover_total){*status=RANGE;return 1;}
   if(~l->cover_crc!=l->cover_expected){l->cover_state=FAULT;*status=FAULT;return 1;}
   l->cover_state=BUSY;*status=QUEUED;return 1;
  }
  return 1;
 }
 if(op==26&&n==12){if(p[8]>=LAYOUTS){*status=RANGE;return 1;}l->layout=p[8];*status=DONE;return 1;}
 if(op==25&&(n==20||n==28)&&p[16]<2){u32 pos=le32(p+8),duration=le32(p+12);if(duration>86400000u||pos>duration){*status=RANGE;return 1;}l->position=pos;l->duration=duration;l->playing=p[16];l->received=((u32(*)(void))0x0803a2bb)();if(n==28){l->line_motion=le32(p+17);l->line_span=le32(p+21);if(l->line_span>600000u)l->line_span=600000u;if(l->line_motion>600000u)l->line_motion=600000u;}*status=DONE;return 1;}
 if((op==20||op==21)&&(l->queued||l->job)){*status=BUSY;return 1;}
 if(op==23&&n==12&&p[8]<2){l->wanted=p[8];*status=DONE;return 1;}
 if(op==20&&n>=13){
  kind=p[8];count=p[9];if(kind>2||count>MAX_TEXT||n!=13u+count*2u){*status=RANGE;return 1;}
  for(i=0;i<count;i++)if(le16(p+10+i*2)>=FONT_COUNT){*status=RANGE;return 1;}
  if(seq!=l->incoming_rev){l->incoming_rev=seq;l->fields=0;}
  l->incoming_count[kind]=(u8)count;for(i=0;i<count;i++)l->incoming[kind][i]=le16(p+10+i*2);l->fields|=(u8)(1u<<kind);*status=DONE;return 1;
 }
 if(op==21&&(n==20||n==28)&&l->fields==7&&seq==l->incoming_rev&&p[16]<2){
  u32 pos=le32(p+8),duration=le32(p+12);if(duration>86400000u||pos>duration){*status=RANGE;return 1;}
  l->next_position=pos;l->next_duration=duration;l->next_playing=p[16];l->next_line_motion=n==28?le32(p+17):0;l->next_line_span=n==28?le32(p+21):0;if(l->next_line_motion>600000u)l->next_line_motion=600000u;if(l->next_line_span>600000u)l->next_line_span=600000u;l->job_rev=seq;l->queued=1;*status=QUEUED;return 1;
 }
 return 1;
}
static void mask_dot(Line *p,unsigned x,unsigned y){unsigned bit;if(x>=p->width||y>=20)return;bit=y*p->width+x;p->bits[bit>>3]|=(u8)(128u>>(bit&7));}
static void begin(void){unsigned k,i,j,same,bytes;Line *p,*old;
 drop_build();l->queued=0;l->error=0;
 for(k=0;k<3;k++){
  l->cached[k]=0;p=&l->build[k];p->count=l->incoming_count[k];for(i=0;i<p->count;i++)p->ids[i]=l->incoming[k][i];
  /* The old next line is normally the new current line. Clone its immutable
   * mask, without reopening/re-reading glyphs or sharing allocation ownership. */
  for(j=0;j<3;j++){
   old=&l->live[j];same=p->count&&p->count==old->count;
   for(i=0;same&&i<p->count;i++)if(p->ids[i]!=old->ids[i])same=0;
   if(same&&old->bits){
    p->width=old->width;bytes=(p->width*20u+7u)/8u;p->bits=alloc(bytes);
    if(!p->bits){drop_build();l->error=FAULT;return;}
    bytes_copy(p->bits,old->bits,bytes);bytes_copy(p->advance,old->advance,p->count);l->cached[k]=1;break;
   }
  }
 }
 l->job=1;l->which=l->at=l->phase=0;
}
static int prepare_one(void){
 Line *p;u8 glyph[52];unsigned k,x,y,advance,offset=0,bit,bytes;
 while(l->which<3&&(l->cached[l->which]||l->at>=l->build[l->which].count)){l->which++;l->at=0;}
 if(l->which>=3){
  if(!l->phase){
   for(k=0;k<3;k++){p=&l->build[k];bytes=(p->width*20u+7u)/8u;if(bytes&&!l->cached[k]){p->bits=alloc(bytes);if(!p->bits)return-1;bytes_zero(p->bits,bytes);}}
   l->phase=1;l->which=l->at=0;return 0;
  }
  return 1;
 }
 p=&l->build[l->which];
 if(!read_at(FONT_DATA_OFFSET+(u32)p->ids[l->at]*52u,glyph,52)||!glyph[0]||glyph[0]>20||glyph[1]&~1u)return-1;
 advance=glyph[0];
 if(!l->phase){p->advance[l->at]=(u8)advance;p->width=(u16)(p->width+advance);l->at++;return 0;}
 for(k=0;k<l->at;k++)offset+=p->advance[k];
 for(y=0;y<20;y++)for(x=0;x<advance;x++){bit=y*20+x;if(glyph[2+(bit>>3)]&(128u>>(bit&7)))mask_dot(p,offset+x,y);}
 l->at++;return 0;
}
static void publish(u32 now){unsigned i,same=l->live[0].count==l->build[0].count;
 for(i=0;same&&i<l->live[0].count;i++)if(l->live[0].ids[i]!=l->build[0].ids[i])same=0;
 if(!same)l->title_motion=0;
 drop(&l->previous);bytes_copy((u8*)&l->previous,(const u8*)&l->live[1],sizeof(Line));l->live[1].bits=0;
 for(i=0;i<3;i++){drop(&l->live[i]);bytes_copy((u8*)&l->live[i],(const u8*)&l->build[i],sizeof(Line));l->build[i].bits=0;l->build[i].width=0;}
 l->position=l->next_position;l->duration=l->next_duration;l->playing=l->next_playing;l->received=now;l->committed=l->job_rev;l->job=0;l->changed=now;l->line_motion=l->next_line_motion;l->line_span=l->next_line_span;l->transition=l->previous.bits!=0;
}
static void make_background(void);
static void unpack_cover(void){
 u8 prefix[256],*raw=(u8*)l->cover[l->cover_index^1u];unsigned i,bit,at,shift,index;u16 *dest=l->cover[l->cover_index^1u];
 if(l->cover_format==3)raw+=6144u;
 bytes_copy(prefix,raw,256);
 /* Backward expansion is safe above byte256. The prefix protects the
  * palette and the early packed indices when source/destination overlap. */
 for(i=l->cover_format==3?2304u:COVER_PIXELS;i-->0;){bit=i*6u;at=128u+(bit>>3);shift=bit&7u;index=(at<256?prefix[at]:raw[at])>>shift;if(shift>2u)index|=(at+1u<256?prefix[at+1u]:raw[at+1u])<<(8u-shift);dest[i]=le16(prefix+(index&63u)*2u);}
}
int lyrics_tick(u32 now){int done,cover_done=0,volume_dirty=0;u32 dt;unsigned budget;
 if(release){close_all();release=initialize=0;return 1;}
 if(initialize&&!l){initialize=0;open_font();}
 if(!l)return 0;
 if(l->volume_restore){l->volume_restore=0;volume_dirty=1;}
 if(l->volume_active){if((u32)(now-l->volume_changed)>=l->volume_hold+180u){l->volume_active=0;volume_dirty=1;}else if((u32)(now-l->volume_drawn)>=33u){l->volume_drawn=now;volume_dirty=volume_allowed(now);}}
 if(l->cover_state==BUSY){if(l->cover_begun){if(l->cover_format>=2)unpack_cover();l->cover_index^=1u;l->cover_dim=l->cover_format==3?48:64;for(budget=0;budget<4;budget++)l->palette[budget]=l->next_palette[budget];}l->cover_active=l->cover_begun;cover_done=1;l->background_ready=0;l->paint_max=0;}
 if(l->layout==4&&!l->background_ready&&!(l->cover_begun&&l->cover_state==0&&l->cover_format<3))make_background();
 if(cover_done){l->cover_committed=l->cover_rev;l->cover_state=DONE;}
 if(l->playing&&(u32)(now-l->received)>5000u){l->position+=5000u;if(l->position>l->duration)l->position=l->duration;l->playing=0;}
 dt=now-l->last_tick;l->last_tick=now;if(dt<1000u){l->title_motion+=dt;if(l->playing)l->line_motion+=dt;}
 if(l->queued)begin();
 /* At most four 52-byte glyph reads per GUI turn. UART/key handlers still do
  * no filesystem work, and the caller skips this worker while LCD DMA is busy. */
 for(budget=0;budget<4&&l->job;budget++){done=prepare_one();if(done<0){drop_build();l->error=FAULT;}else if(done)publish(now);}
 if(l->transition&&(u32)(now-l->changed)>=280u){l->transition=0;drop(&l->previous);}
 if(l->mode&&(u32)(now-l->last_draw)>=33u){l->last_draw=now;return 1;}
 return volume_dirty;
}
int lyrics_mode(void){return l&&l->mode;}
void lyrics_cancel_maintenance(void){if(remove_state==BUSY){remove_state=FAULT;remove_result=0xfdu;}}
void lyrics_maintenance(int suspended){
 u8 *file,h[256];unsigned read=0,result,opened=0;
 if(remove_state!=BUSY||!suspended||l||initialize)return;
 remove_state=FAULT;remove_result=0xfcu;file=alloc(FIL_BYTES);if(!file)return;
 result=((unsigned(*)(void*,const char*,unsigned))0x0803c805)(file,"FONT.BIN",1);
 if(!result){
  opened=1;result=((unsigned(*)(void*,void*,unsigned,unsigned*))0x0803ccc9)(file,h,256,&read);
  if(!result&&(read!=256||REG32((u32)file+12)!=remove_bytes||le32(h)!=0x46353752u||le16(h+4)!=2||le32(h+32)!=remove_bytes||le32(h+36)!=remove_crc||le32(h+40)!=header_crc(h)))result=0xfe;
 }
 if(opened){unsigned closed=((unsigned(*)(void*))0x0803d075)(file);if(!result)result=closed;}
 dealloc(file);
 /* Fixed filename only. The native FatFs unlink is evidenced by the stock
  * upload-finalize path; it runs here only with decoder and font suspended. */
 if(!result)result=((unsigned(*)(const char*))0x0803dd05)("FONT.BIN");
 remove_result=(u8)result;if(!result)remove_state=DONE;
}
static void pixel(u8 *p,unsigned x,unsigned y,unsigned color){unsigned at=(y*320u+x)*2u;if(x>=320||y>=172)return;p[at]=(u8)color;p[at+1]=(u8)(color>>8);}
static void blend_pixel(u8 *p,unsigned x,unsigned y,unsigned color,unsigned alpha){unsigned old,r,g,b;if(!alpha||x>=320||y>=172)return;if(alpha>=256){pixel(p,x,y,color);return;}old=le16(p+(y*320u+x)*2u);r=((old>>11)*(256u-alpha)+(color>>11)*alpha)>>8;g=(((old>>5&63u)*(256u-alpha))+((color>>5&63u)*alpha))>>8;b=(((old&31u)*(256u-alpha))+((color&31u)*alpha))>>8;pixel(p,x,y,(r<<11)|(g<<5)|b);}
void lyrics_prepare(u8 *pixels,int fresh,u32 now){unsigned at=(39u*320u+22u)*2u,raw;u16 bg=theme_slot()->bg;(void)fresh;(void)now;if(!l)return;
 /* The supported cache GIF restores this border pixel on EVERY full frame.
  * The player compositor clears it. The original decoder can finish BEFORE
  * a GUI-owned repaint, so a caller label alone cannot identify fresh RGB.
  * This is verified against every frame of the installed cache asset. */
 raw=(unsigned)(pixels[at]|pixels[at+1]<<8);
 if(!l->marker_known&&raw!=bg){l->source_marker=(u16)raw;l->marker_known=1;}
 raw=raw!=(l->mode&&l->layout==4?l->drawn_marker:bg);
 if(l->wanted||raw)l->mode=l->wanted;
}
static int mono(const Line *p,unsigned x,unsigned y){unsigned bit=y*p->width+x;return p->bits&&(p->bits[bit>>3]&(128u>>(bit&7)));}
static void draw_from(u8 *pixels,const Line *p,int y,unsigned field,u32 motion,unsigned color,int clip0,int clip1,unsigned scale,unsigned left){
 unsigned x,yy,scroll=0,bitx,width=p->width*scale,cycle,speed=p==&l->live[0]?30u:15u;
 if(!p->bits)return;
 if(width<field)left+=(field-width)/2;else{if(l->line_span&&p!=&l->live[0]){cycle=l->line_span>3000u?l->line_span-3000u:1000u;if(motion>1500u){motion-=1500u;if(motion>cycle)motion=cycle;scroll=motion*(width-field)/cycle;}}else{cycle=(width-field)*1000u/speed+4000u;motion%=cycle;if(motion>1500u)scroll=(motion-1500u)*speed/1000u;if(scroll>width-field)scroll=width-field;}}
 for(yy=0;yy<20u*scale;yy++){if(y+(int)yy<clip0||y+(int)yy>=clip1)continue;for(x=0;x<field&&scroll+x<width;x++){bitx=(scroll+x)/scale;if(mono(p,bitx,yy/scale))pixel(pixels,left+x,(unsigned)(y+(int)yy),color);}}
}
static void draw_line(u8 *pixels,const Line *p,int y,unsigned field,u32 motion,unsigned color,int clip0,int clip1,unsigned scale){draw_from(pixels,p,y,field,motion,color,clip0,clip1,scale,scale==2?16u:17u);}
static void ascii_color(u8 *p,const u8 *s,unsigned n,unsigned x,unsigned y,unsigned color){unsigned i,xx,yy;for(i=0;i<n;i++)for(yy=0;yy<7;yy++)for(xx=0;xx<5;xx++)if(cache_font[glyph_index(s[i])][yy]&(16u>>xx))pixel(p,x+i*6+xx,y+yy,color);}
static void ascii(u8 *p,const u8 *s,unsigned n,unsigned x,unsigned y){ascii_color(p,s,n,x,y,theme_slot()->ink);}
static void overlay_ascii(u8 *p,const u8 *s,unsigned n,unsigned x,unsigned y,unsigned scale,unsigned color,unsigned alpha){unsigned i,xx,yy,dx,dy;for(i=0;i<n;i++)for(yy=0;yy<7;yy++)for(xx=0;xx<5;xx++)if(cache_font[glyph_index(s[i])][yy]&(16u>>xx))for(dy=0;dy<scale;dy++)for(dx=0;dx<scale;dx++)blend_pixel(p,x+(i*6u+xx)*scale+dx,y+yy*scale+dy,color,alpha);}
static void stamp(u8 *p,u32 ms,unsigned x,unsigned y){u32 s=ms/1000u,m=s/60u;u8 t[5];if(m>99)m=99;t[0]=(u8)('0'+m/10u);t[1]=(u8)('0'+m%10u);t[2]=':';t[3]=(u8)('0'+s/10u%6u);t[4]=(u8)('0'+s%10u);ascii(p,t,5,x,y);}
static void card(u8 *p){
 static const u8 outer[7]={4,3,2,1,0,0,0},inner[5]={3,1,1,0,0};const RainyThemeSlot *t=theme_slot();unsigned x,y,edge,inset,border=t->lyricsBorder,panel=t->lyricsPanel;
 for(y=0;y<70;y++){edge=y<35?y:69-y;inset=edge<7?outer[edge]:0;for(x=inset;x<298-inset;x++)pixel(p,11+x,75+y,border);}
 for(y=0;y<66;y++){edge=y<33?y:65-y;inset=edge<5?inner[edge]:0;for(x=inset;x<294-inset;x++)pixel(p,13+x,77+y,panel);}
}
static void slice(u8 *pixels,const Line *p,unsigned start,unsigned width,unsigned y){
 unsigned x,yy,left=16u+(288u-width*2u)/2u,ink=theme_slot()->ink;
 if(!p->bits)return;
 for(yy=0;yy<40;yy++)for(x=0;x<width*2u;x++)if(mono(p,start+x/2u,yy/2u))pixel(pixels,left+x,y+yy,ink);
}
static void paged(u8 *pixels){
 const Line *p=&l->live[1];u16 starts[16],widths[16];unsigned i,rows=0,start=0,width=0,pages,page,row,ink=theme_slot()->ink;u8 label[3];
 /* At most 96 glyphs, each <=20px. A 144px row fits at least seven, so
  * fourteen rows suffice. Sixteen bounded slots leave a checked margin. */
 for(i=0;i<p->count;i++){
  if(width&&width+p->advance[i]>144u){if(rows>=16)return;starts[rows]=(u16)start;widths[rows++]=(u16)width;start+=width;width=0;}
  width+=p->advance[i];
 }
 if(width){if(rows>=16)return;starts[rows]=(u16)start;widths[rows++]=(u16)width;}
 pages=(rows+1u)/2u;if(!pages)pages=1;
 if(l->line_span){u32 motion=l->line_motion;if(motion>=l->line_span)motion=l->line_span-1u;page=motion*pages/l->line_span;}else page=(l->line_motion/6000u)%pages;
 draw_line(pixels,&l->live[0],43,pages>1?244u:286u,l->title_motion,ink,43,63,1);
 if(pages>1){label[0]=(u8)('1'+page);label[1]='/';label[2]=(u8)('0'+pages);ascii(pixels,label,3,278,49);}
 row=page*2u;if(row<rows){slice(pixels,p,starts[row],widths[row],row+1u<rows?74u:94u);if(row+1u<rows)slice(pixels,p,starts[row+1u],widths[row+1u],118);}
}
static void make_background(void){
 unsigned x,y,k,c[4][3],shifts[3]={11,5,0},masks[3]={31,63,31},color;int left[3],right[3],step[3],v[3];
 /* Four cover-derived corners are already darkened on the host. The device
  * draws a smooth gradient without a frame-sized cache or image file IO. */
 for(k=0;k<4;k++)for(x=0;x<3;x++)c[k][x]=((l->cover_active?l->palette[k]:0x2104u)>>shifts[x])&masks[x];
 /* 5760B scene cache reuses the inactive 8192B cover buffer. Compact cover
  * packets occupy only its tail at6144..7999, without touching the scene. */
 for(y=0;y<18;y++){
  for(k=0;k<3;k++){left[k]=((int)c[0][k]*(17-(int)y)+(int)c[2][k]*(int)y)*256/17;right[k]=((int)c[1][k]*(17-(int)y)+(int)c[3][k]*(int)y)*256/17;v[k]=left[k];step[k]=(right[k]-left[k])/79;}
  for(x=0;x<80;x++){unsigned fraction=0,at=(y*80u+x)*2u;color=0;for(k=0;k<3;k++){unsigned q=(unsigned)v[k]>>8;color|=q<<shifts[k];fraction|=(((unsigned)v[k]&255u)>>4)<<(8u-k*4u);v[k]+=step[k];}l->cover[l->cover_index^1u][at]=(u16)color;l->cover[l->cover_index^1u][at+1u]=(u16)fraction;}
 }
 l->background_ready=1;
}
static unsigned mask_safe(const Line *p,unsigned x,unsigned y){return x<p->width&&y<20u&&(unsigned)mono(p,x,y)!=0;}
static void draw30(u8 *pixels,const Line *p,int top,u32 motion,int low,int high){
 unsigned x,y,width=p->width*3u/2u,left=16,scroll=0,cycle;if(!p->bits)return;
 if(width<288u)left+=(288u-width)/2u;else{cycle=l->line_span>3000u?l->line_span-3000u:1000u;if(motion>1500u){motion-=1500u;if(motion>cycle)motion=cycle;scroll=motion*(width-288u)/cycle;}}
 if(!l->text_style){for(y=0;y<30;y++){if(top+(int)y<low||top+(int)y>=high)continue;for(x=0;x<288u&&scroll+x<width;x++)if(mask_safe(p,((scroll+x)*2u+1u)/3u,(y*2u+1u)/3u))pixel(pixels,left+x,(unsigned)(top+(int)y),0xffff);}return;}
 for(y=0;y<30;y++){
  unsigned sy=y? (y*4u-1u)/6u:0,fy=y?(y*4u-1u)%6u:0;if(top+(int)y<low||top+(int)y>=high)continue;
  for(x=0;x<288u&&scroll+x<width;x++){
   unsigned at=scroll+x,sx=at?(at*4u-1u)/6u:0,fx=at?(at*4u-1u)%6u:0;
   unsigned alpha=mask_safe(p,sx,sy)*(6u-fx)*(6u-fy)+mask_safe(p,sx+1u,sy)*fx*(6u-fy)+mask_safe(p,sx,sy+1u)*(6u-fx)*fy+mask_safe(p,sx+1u,sy+1u)*fx*fy;
   if(alpha){unsigned address=((unsigned)(top+(int)y)*320u+left+x)*2u,old=le16(pixels+address),r=old>>11,g=old>>5&63u,b=old&31u;r+=(31u-r)*alpha/36u;g+=(63u-g)*alpha/36u;b+=(31u-b)*alpha/36u;pixel(pixels,left+x,(unsigned)(top+(int)y),(r<<11)|(g<<5)|b);}
  }
 }
}
static void draw_current(u8 *pixels,const Line *p,int top,u32 motion){if(l->text_size==30)draw30(pixels,p,top,motion,68,110);else draw_line(pixels,p,top,288,motion,0xffff,68,110,l->text_size==40?2:1);}
static void immersive(u8 *p,u32 now){
 static const u8 noise[16]={0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5};
 unsigned x,y,k,progress=0;u32 pos=l->position,started=((u32(*)(void))0x0803a2bb)();
 for(y=0;y<172;y++){u8 *row=p+y*640u;for(x=0;x<80;x++){unsigned at=((y*18u/172u)*80u+x)*2u,base=l->background_ready?l->cover[l->cover_index^1u][at]:l->cover_active?l->palette[0]:0x2104u,fraction=l->background_ready?l->cover[l->cover_index^1u][at+1u]:0,r=fraction>>8,g=fraction>>4&15u,b=fraction&15u;for(k=0;k<4;k++){unsigned threshold=noise[(y&3u)*4u+k],value=base+((r>threshold)<<11)+((g>threshold)<<5)+(b>threshold);row[x*8u+k*2u]=(u8)value;row[x*8u+k*2u+1u]=(u8)(value>>8);}}}
 if(l->cover_active)for(y=0;y<48;y++)for(x=0;x<48;x++){
  if((x<3||x>44)&&(y<3||y>44)&&((x<3?3-x:x-44)+(y<3?3-y:y-44)>3))continue;
  pixel(p,16+x,14+y,l->cover[l->cover_index][l->cover_dim==48?y*48u+x:(y*4u/3u)*64u+x*4u/3u]);
 }
 draw_from(p,&l->live[0],28,224,l->title_motion,0xffff,28,48,1,80);
 {int top=l->text_size==40?68:l->text_size==20?80:74;if(l->transition){u32 elapsed=now-l->changed;if(elapsed>280u)elapsed=280u;unsigned offset=elapsed*44u/280u;draw_current(p,&l->previous,top-(int)offset,0);draw_current(p,&l->live[1],top+44-(int)offset,l->line_motion);}else draw_current(p,&l->live[1],top,l->line_motion);}
 draw_line(p,&l->live[2],113,286,l->line_motion,0xbdf7,113,133,1);
 if(l->playing)pos+=(u32)(now-l->received);if(pos>l->duration)pos=l->duration;
 if(l->duration/100u)progress=(pos/100u)*284u/(l->duration/100u);
 {unsigned alpha=volume_allowed(now)&&l->volume_style?256u-volume_alpha(now):256u;
 for(y=142;y<148;y++)for(x=18;x<302;x++)blend_pixel(p,x,y,x<18+progress?0xffff:0x738e,alpha);
 {u8 text[5];u32 times[2]={pos,l->duration},s,m;for(k=0;k<2;k++){s=times[k]/1000u;m=s/60u;if(m>99)m=99;text[0]=(u8)('0'+m/10u);text[1]=(u8)('0'+m%10u);text[2]=':';text[3]=(u8)('0'+s/10u%6u);text[4]=(u8)('0'+s%10u);overlay_ascii(p,text,5,k?272u:18u,153,1,0xbdf7,alpha);}}}
 /* Source-frame marker is constant across the supported full-frame GIF.
  * Remember our own pixel and avoid a collision by only one RGB565 bit;
  * the immersive view needs no visible theme-colored sentinel pixel. */
 {unsigned at=(39u*320u+22u)*2u;u16 mark=le16(p+at);if(!l->marker_known)mark=theme_slot()->bg;else if(mark==l->source_marker)mark^=1u;pixel(p,22,39,mark);l->drawn_marker=mark;}
 l->paint_last=(u16)(((u32(*)(void))0x0803a2bb)()-started);if(l->paint_last>l->paint_max)l->paint_max=l->paint_last;
}
static void draw_scene(u8 *p,u32 now){const RainyThemeSlot *t;unsigned x,y,progress=0,offset=0,bg,track,ink,muted,accent;u32 pos,elapsed;if(!l||!l->mode)return;
 if(l->layout==4){immersive(p,now);return;}
 t=theme_slot();bg=t->bg;track=t->shell;ink=t->ink;muted=t->muted;accent=t->accent;
 for(y=37;y<172;y++)for(x=0;x<320;x++)pixel(p,x,y,bg);
 for(x=16;x<304;x++)pixel(p,x,l->layout?37:40,track);
 if(l->layout==3)paged(p);
 else if(l->layout==2){
  draw_line(p,&l->live[0],43,286,l->title_motion,ink,43,63,1);
  if(l->transition){elapsed=now-l->changed;if(elapsed>280u)elapsed=280u;offset=elapsed*44u/280u;draw_line(p,&l->previous,79-(int)offset,288,0,ink,76,123,2);draw_line(p,&l->live[1],123-(int)offset,288,l->line_motion,ink,76,123,2);}else draw_line(p,&l->live[1],79,288,l->line_motion,ink,76,123,2);
  draw_line(p,&l->live[2],127,286,l->line_motion,muted,127,147,1);
 }else if(l->layout==1){
  draw_line(p,&l->live[0],43,286,l->title_motion,ink,43,63,1);card(p);
  if(l->transition){elapsed=now-l->changed;if(elapsed>280u)elapsed=280u;offset=elapsed*64u/280u;draw_line(p,&l->previous,90-(int)offset,288,0,ink,78,143,2);draw_line(p,&l->live[1],154-(int)offset,288,l->line_motion,ink,78,143,2);}else draw_line(p,&l->live[1],90,288,l->line_motion,ink,78,143,2);
 }else{
  draw_line(p,&l->live[0],51,286,l->title_motion,ink,48,75,1);
  if(l->transition){elapsed=now-l->changed;if(elapsed>280u)elapsed=280u;offset=elapsed*28u/280u;draw_line(p,&l->previous,86-(int)offset,286,0,ink,86,135,1);draw_line(p,&l->live[1],114-(int)offset,286,l->line_motion,ink,86,135,1);draw_line(p,&l->live[2],142-(int)offset,286,l->line_motion,muted,86,135,1);}else{draw_line(p,&l->live[1],86,286,l->line_motion,ink,86,135,1);draw_line(p,&l->live[2],114,286,l->line_motion,muted,86,135,1);}
 }
 pos=l->position;if(l->playing)pos+=(u32)(now-l->received);if(pos>l->duration)pos=l->duration;
 if(l->duration){u32 a=pos/100u,b=l->duration/100u;if(b)progress=a*285u/b;}
 if(l->layout==3){for(y=167;y<169;y++)for(x=18;x<303;x++)pixel(p,x,y,x<18+progress?accent:track);return;}
 offset=l->layout?11u:0u;
 for(y=143+offset;y<146+offset;y++)for(x=18;x<303;x++)pixel(p,x,y,x<18+progress?accent:track);
 for(y=142+offset;y<147+offset;y++)for(x=18+progress;x<21+progress&&x<305;x++)pixel(p,x,y,ink);
 stamp(p,pos,18,l->layout?162:155);stamp(p,l->duration,272,l->layout?162:155);
 offset=l->layout?8u:0u;
 for(y=0;y<9;y++)for(x=0;x<5;x++){if(l->playing?(x<2||x>=3):x<=((y<5?y:8-y)/2))pixel(p,155+x,153+offset+y,ink);}
 for(y=0;y<7;y++)for(x=0;x<5;x++){if(!x||x>=4u-(y<4?y:6u-y))pixel(p,133+x,154+offset+y,ink);if(x==4||x<=(y<4?y:6u-y))pixel(p,177+x,154+offset+y,ink);}
}
static void draw_volume(u8 *p,u32 now){
 static const u8 inset[10]={7,4,3,2,1,1,0,0,0,0};unsigned alpha,n=0,level,progress,x,y,k,dx,dy,shade,track,color,shift,edge,pad,left;u8 label[4];
 if(!l||!l->mode||!volume_allowed(now))return;alpha=volume_alpha(now);level=l->volume_level;progress=volume_progress(now);shift=(256u-alpha)*6u/256u;
 if(l->volume_muted){label[n++]='-';label[n++]='-';}else{if(level>=100){label[n++]='1';label[n++]='0';label[n++]='0';}else{if(level>=10)label[n++]=(u8)('0'+level/10u);label[n++]=(u8)('0'+level%10u);}label[n++]='%';}
 if(l->volume_style&&l->layout==4){
  for(y=142;y<148;y++)for(x=18;x<302;x++)blend_pixel(p,x,y,x<18u+progress*284u/25600u?0xffff:0x738e,alpha);
  for(y=0;y<13;y++)for(x=0;x<16;x++)if(lyrics_volume_icon(x,y,l->volume_muted||!level))blend_pixel(p,18+x,151+y,0xffff,alpha);
  overlay_ascii(p,label,n,303u-n*6u,153,1,0xffff,alpha);return;
 }
 color=l->layout==4&&l->cover_active?l->palette[0]:theme_slot()->ink;shade=((color>>11)/2u<<11)|((color>>5&63u)/2u<<5)|((color&31u)/2u);track=((shade>>11)+(31u-(shade>>11))/5u)<<11;track|=((shade>>5&63u)+(63u-(shade>>5&63u))/5u)<<5;track|=(shade&31u)+(31u-(shade&31u))/5u;
 for(y=0;y<72;y++){edge=y<36?y:71u-y;pad=edge<10?inset[edge]:0;for(x=pad;x<224u-pad;x++)blend_pixel(p,48+x,54+y+shift,shade,alpha);}
 left=160u-(32u+14u+(n*6u-1u)*4u)/2u;
 for(y=0;y<13;y++)for(x=0;x<16;x++)if(lyrics_volume_icon(x,y,l->volume_muted||!level))for(dy=0;dy<2;dy++)for(dx=0;dx<2;dx++)blend_pixel(p,left+x*2u+dx,68u+y*2u+dy+shift,0xffff,alpha);
 overlay_ascii(p,label,n,left+46u,67u+shift,4,0xffff,alpha);
 for(y=110;y<116;y++)for(k=0;k<176;k++)blend_pixel(p,72u+k,y+shift,k<progress*176u/25600u?0xffff:track,alpha);
}
void lyrics_draw(u8 *p,u32 now){u32 start=((u32(*)(void))0x0803a2bb)();draw_scene(p,now);draw_volume(p,now);if(l){l->paint_last=(u16)(((u32(*)(void))0x0803a2bb)()-start);if(l->paint_last>l->paint_max)l->paint_max=l->paint_last;}}
