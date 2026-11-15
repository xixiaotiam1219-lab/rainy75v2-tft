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
#include "lyrics_theme.h"
typedef struct {u8 count,advance[MAX_TEXT];u16 ids[MAX_TEXT],width;u8 *bits;} Line;
typedef struct {
 u8 file[FIL_BYTES];
 Line live[3],build[3],previous;
 u16 incoming[3][MAX_TEXT],incoming_rev,job_rev,committed;
 u8 incoming_count[3],cached[3],fields,queued,job,phase,which,at,ready,opened,error,playing;
 u8 next_playing,mode,wanted,transition,layout;
 u32 position,duration,received,next_position,next_duration,changed,last_draw,last_second,line_motion,last_tick;
 u32 line_span,next_line_span,next_line_motion,title_motion;
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
 l->layout=1;l->ready=1;last_error=0;return 1;
bad:
 if(l->opened)((unsigned(*)(void*))0x0803d075)(l->file);
 dealloc(l);l=0;return 0;
}
int lyrics_suspend(void){if(!l){initialize=0;return 1;}release=1;return 0;}
static void close_all(void){unsigned i;if(!l)return;for(i=0;i<3;i++){drop(&l->live[i]);drop(&l->build[i]);}drop(&l->previous);if(l->opened)((unsigned(*)(void*))0x0803d075)(l->file);dealloc(l);l=0;}
int lyrics_request(const u8 *p,u16 n,unsigned *status,u16 *value){
 unsigned op=p[4],kind,count,i;u16 seq=le16(p+5);*status=FORMAT;*value=seq;
 if(op<20||op>27)return 0;
 if(op==24&&n==11){initialize=1;*status=0xa6;*value=0x4c59;return 1;}
 if(op==22&&n==11){
  *status=0xc0+(seq&15u);
  switch(seq){case 0:*value=l?l->ready:initialize?2:0;break;case 1:*value=l?l->mode:0;break;case 2:*value=l?l->error:last_error;break;case 3:*value=l?l->committed:0;break;case 4:*value=l?(l->job|l->queued<<8):0;break;case 5:*value=FONT_BODY_CRC&65535u;break;case 6:*value=FONT_BODY_CRC>>16;break;case 7:*value=MAX_TEXT;break;case 8:*value=l?l->layout:1;break;case 9:*value=remove_state;break;case 10:*value=remove_result;break;default:*status=RANGE;}
  return 1;
 }
 if(op==27&&n==23&&le32(p+8)==0x21544e46u){
  if(l||initialize||remove_state==BUSY){*status=BUSY;return 1;}
  if(le32(p+16)<256||le32(p+16)>4194304u){*status=RANGE;return 1;}
  remove_crc=le32(p+12);remove_bytes=le32(p+16);remove_result=0;remove_state=BUSY;*status=QUEUED;return 1;
 }
 if(!l||!l->ready){initialize=1;*status=BUSY;return 1;}
 if(op==26&&n==12){if(p[8]>1){*status=RANGE;return 1;}l->layout=p[8];*status=DONE;return 1;}
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
int lyrics_tick(u32 now){int done;u32 dt;unsigned budget;
 if(release){close_all();release=initialize=0;return 1;}
 if(initialize&&!l){initialize=0;open_font();}
 if(!l)return 0;
 if(l->playing&&(u32)(now-l->received)>5000u){l->position+=5000u;if(l->position>l->duration)l->position=l->duration;l->playing=0;}
 dt=now-l->last_tick;l->last_tick=now;if(dt<1000u){l->title_motion+=dt;if(l->playing)l->line_motion+=dt;}
 if(l->queued)begin();
 /* At most four 52-byte glyph reads per GUI turn. UART/key handlers still do
  * no filesystem work, and the caller skips this worker while LCD DMA is busy. */
 for(budget=0;budget<4&&l->job;budget++){done=prepare_one();if(done<0){drop_build();l->error=FAULT;}else if(done)publish(now);}
 if(l->transition&&(u32)(now-l->changed)>=280u){l->transition=0;drop(&l->previous);}
 if(l->mode&&(u32)(now-l->last_draw)>=33u){l->last_draw=now;return 1;}
 return 0;
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
void lyrics_prepare(u8 *pixels,int fresh,u32 now){unsigned at=(39u*320u+22u)*2u,raw;(void)fresh;(void)now;if(!l)return;
 /* The supported cache GIF restores this border pixel on EVERY full frame.
  * The player compositor clears it. The original decoder can finish BEFORE
  * a GUI-owned repaint, so a caller label alone cannot identify fresh RGB.
  * This is verified against every frame of the installed cache asset. */
 raw=(unsigned)(pixels[at]|pixels[at+1]<<8)!=BG;
 if(l->wanted||raw)l->mode=l->wanted;
}
static int mono(const Line *p,unsigned x,unsigned y){unsigned bit=y*p->width+x;return p->bits&&(p->bits[bit>>3]&(128u>>(bit&7)));}
static void draw_line(u8 *pixels,const Line *p,int y,unsigned field,u32 motion,unsigned color,int clip0,int clip1,unsigned scale){
 unsigned x,yy,scroll=0,left=scale==2?16u:17u,bitx,width=p->width*scale,cycle,speed=p==&l->live[0]?30u:15u;
 if(!p->bits)return;
 if(width<field)left+=(field-width)/2;else{if(l->line_span&&p!=&l->live[0]){cycle=l->line_span>3000u?l->line_span-3000u:1000u;if(motion>1500u){motion-=1500u;if(motion>cycle)motion=cycle;scroll=motion*(width-field)/cycle;}}else{cycle=(width-field)*1000u/speed+4000u;motion%=cycle;if(motion>1500u)scroll=(motion-1500u)*speed/1000u;if(scroll>width-field)scroll=width-field;}}
 for(yy=0;yy<20u*scale;yy++){if(y+(int)yy<clip0||y+(int)yy>=clip1)continue;for(x=0;x<field&&scroll+x<width;x++){bitx=(scroll+x)/scale;if(mono(p,bitx,yy/scale))pixel(pixels,left+x,(unsigned)(y+(int)yy),color);}}
}
static void ascii(u8 *p,const u8 *s,unsigned n,unsigned x,unsigned y){unsigned i,xx,yy;for(i=0;i<n;i++)for(yy=0;yy<7;yy++)for(xx=0;xx<5;xx++)if(cache_font[glyph_index(s[i])][yy]&(16u>>xx))pixel(p,x+i*6+xx,y+yy,INK);}
static void stamp(u8 *p,u32 ms,unsigned x,unsigned y){u32 s=ms/1000u,m=s/60u;u8 t[5];if(m>99)m=99;t[0]=(u8)('0'+m/10u);t[1]=(u8)('0'+m%10u);t[2]=':';t[3]=(u8)('0'+s/10u%6u);t[4]=(u8)('0'+s%10u);ascii(p,t,5,x,y);}
static void card(u8 *p){
 static const u8 outer[7]={4,3,2,1,0,0,0},inner[5]={3,1,1,0,0};unsigned x,y,edge,inset;
 for(y=0;y<70;y++){edge=y<35?y:69-y;inset=edge<7?outer[edge]:0;for(x=inset;x<298-inset;x++)pixel(p,11+x,75+y,CARD);}
 for(y=0;y<66;y++){edge=y<33?y:65-y;inset=edge<5?inner[edge]:0;for(x=inset;x<294-inset;x++)pixel(p,13+x,77+y,PAPER);}
}
void lyrics_draw(u8 *p,u32 now){unsigned x,y,progress=0,offset=0;u32 pos,elapsed;if(!l||!l->mode)return;
 for(y=37;y<172;y++)for(x=0;x<320;x++)pixel(p,x,y,BG);
 for(x=16;x<304;x++)pixel(p,x,l->layout?37:40,TRACK);
 if(l->layout){
  draw_line(p,&l->live[0],43,286,l->title_motion,INK,43,63,1);card(p);
  if(l->transition){elapsed=now-l->changed;if(elapsed>280u)elapsed=280u;offset=elapsed*64u/280u;draw_line(p,&l->previous,90-(int)offset,288,0,INK,78,143,2);draw_line(p,&l->live[1],154-(int)offset,288,l->line_motion,INK,78,143,2);}else draw_line(p,&l->live[1],90,288,l->line_motion,INK,78,143,2);
 }else{
  draw_line(p,&l->live[0],51,286,l->title_motion,INK,48,75,1);
  if(l->transition){elapsed=now-l->changed;if(elapsed>280u)elapsed=280u;offset=elapsed*28u/280u;draw_line(p,&l->previous,86-(int)offset,286,0,INK,86,135,1);draw_line(p,&l->live[1],114-(int)offset,286,l->line_motion,INK,86,135,1);draw_line(p,&l->live[2],142-(int)offset,286,l->line_motion,MUTED,86,135,1);}else{draw_line(p,&l->live[1],86,286,l->line_motion,INK,86,135,1);draw_line(p,&l->live[2],114,286,l->line_motion,MUTED,86,135,1);}
 }
 pos=l->position;if(l->playing)pos+=(u32)(now-l->received);if(pos>l->duration)pos=l->duration;
 if(l->duration){u32 a=pos/100u,b=l->duration/100u;if(b)progress=a*285u/b;}
 offset=l->layout?11u:0u;
 for(y=143+offset;y<146+offset;y++)for(x=18;x<303;x++)pixel(p,x,y,x<18+progress?ACCENT:TRACK);
 for(y=142+offset;y<147+offset;y++)for(x=18+progress;x<21+progress&&x<305;x++)pixel(p,x,y,INK);
 stamp(p,pos,18,l->layout?162:155);stamp(p,l->duration,272,l->layout?162:155);
 offset=l->layout?8u:0u;
 for(y=0;y<9;y++)for(x=0;x<5;x++){if(l->playing?(x<2||x>=3):x<=((y<5?y:8-y)/2))pixel(p,155+x,153+offset+y,INK);}
 for(y=0;y<7;y++)for(x=0;x<5;x++){if(!x||x>=4u-(y<4?y:6u-y))pixel(p,133+x,154+offset+y,INK);if(x==4||x<=(y<4?y:6u-y))pixel(p,177+x,154+offset+y,INK);}
}
