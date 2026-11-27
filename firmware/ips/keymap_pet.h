/* Native screen key notifications. Pose zero is idle, one is blink. */
#ifdef RAINY_BONGO
#include <keymap.h>
static struct { u32 last_ms; unsigned pose, shown; } pet;
static void bongo_key(u32 now,unsigned code){
 if(code>=0xfff8u)code=224+(code&7);
 pet.pose=0;
 for(unsigned i=0;i<sizeof keycodes/sizeof keycodes[0];i++)
  if(keycodes[i]==code){pet.pose=i+2;break;}
 pet.last_ms=now;
}
static unsigned current_pose(u32 now){
 if((u32)(now-pet.last_ms)>=100)pet.pose=0;
 return pet.pose?pet.pose:(now%4000>=3880);
}
static int bongo_tick(u32 now){
 unsigned pose=current_pose(now);if(pose==pet.shown)return 0;
 pet.shown=pose;return 1;
}
typedef struct {u8 *pixels;unsigned x,y,w,h;} PetFrame;
static void line(PetFrame *f,unsigned y,unsigned l,unsigned r,u16 color){
 if(y<f->y||y>=f->y+f->h||r<f->x||l>=f->x+f->w)return;
 if(l<f->x)l=f->x;
 if(r>=f->x+f->w)r=f->x+f->w-1;
 u8 *p=f->pixels+2*((y-f->y)*f->w+l-f->x);
 for(;l<=r;l++,p+=2){p[0]=color;p[1]=color>>8;}
}
static void background(PetFrame *f,unsigned id){
 const u16 *r=rects[id];
 for(unsigned dy=0;dy<r[3];dy++){
  unsigned y=r[1]+dy;if(y<f->y||y>=f->y+f->h)continue;
  unsigned i=row_offset[r[4]+dy],x=r[0];
  while(x<r[0]+r[2]){
   unsigned token=background_runs[i++],n=1+(token>>4);
   line(f,y,x,x+n-1,palette[token&15]);x+=n;
  }
 }
}
static void bongo_draw(u8 *p,unsigned x,unsigned y,unsigned w,unsigned h,const RainyThemeSlot *t,u32 now){
 (void)t;PetFrame frame={p,x,y,w,h};unsigned pose=current_pose(now);
 background(&frame,0);if(!pose)return;
 if(pose==1){background(&frame,3);return;}
 const u16 *shape=poses[pose-2];background(&frame,shape[4]);
 unsigned l=shape[5],top=shape[6],bottom=shape[8];
 for(unsigned row=top;row<=bottom;row++){
  const u8 *cap=cap_rows+2*(shape[9]+row-top);
  if(row<y||row>=y+h)continue;
  for(unsigned px=l+cap[0];px<=l+cap[1];px++){
   if(px<x||px>=x+w)continue;
   u8 *at=p+2*((row-y)*w+px-x);
   unsigned brightness=(((unsigned)at[1]<<8)|at[0])>>11;
   unsigned color=(brightness<<11)|((brightness/2)<<5)|(brightness/2);
   at[0]=color;at[1]=color>>8;
  }
 }
 static u8 decoded[512];unsigned count=0,at=shape[3],flags=0,bits=0;
 while(count<3*shape[2]){
  if(!bits){flags=paw_rows[at++];bits=8;}
  unsigned token=paw_rows[at++];
  if(flags&1)decoded[count++]=token;
  else{
   unsigned dist=1+((token&15)<<8)+paw_rows[at++],n=3+(token>>4);
   while(n--){decoded[count]=decoded[count-dist];count++;}
  }
  flags>>=1;bits--;
 }
 u8 accum[3]={0};
 for(unsigned dy=0;dy<shape[2];dy++){
  for(unsigned channel=0;channel<3;channel++)accum[channel]+=decoded[channel*shape[2]+dy];
  const u8 *s=accum;
  unsigned left=shape[0]+s[0],right=shape[0]+s[1],yy=shape[1]+dy;
  if(!(s[0]|s[1]|s[2]))continue;
  line(&frame,yy,left,right,0);
  if(s[2]!=255)line(&frame,yy,left+(s[2]>>4),right-(s[2]&15),0xffff);
 }
 /* A narrow cap rim stays visible when the fingertip covers its legend. */
 for(unsigned row=top;row<=bottom;row++){
  const u8 *cap=cap_rows+2*(shape[9]+row-top);
  if(cap[0]>cap[1])continue;
  unsigned px=l+cap[1];line(&frame,row,px,px,(31u<<11)|(15u<<5)|15u);
 }

}
#else
#define bongo_tick(now) 0
#define bongo_key(now,code) ((void)0)
#define bongo_draw(p,x,y,w,h,t,now) ((void)0)
#endif
