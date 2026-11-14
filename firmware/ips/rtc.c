/* SPDX-License-Identifier: MIT */
#include "native_ui.h"
/* Main RTC snapshots at boot/every30s, local interpolation while awake.
 * No PC streaming, ERTC initialization, files or Flash writes. */
#define R(a) (*(volatile u32*)(a))
static struct {u32 seconds,received,requested;u8 valid,started;} clock;
static u32 now_ms(void){return ((u32(*)(void))0x0803a2bb)();}
void rtc_tick(u32 now){
 unsigned i,spins;static const u8 request[4]={0xbe,0x1d,4,0xed};
 if(clock.valid&&(u32)(now-clock.received)>90000u)clock.valid=0;
 if(clock.started&&(u32)(now-clock.requested)<(clock.valid?30000u:1000u))return;
 clock.started=1;clock.requested=now;
 for(i=0;i<4;i++){
  for(spins=0;spins<4096u;spins++)if(R(0x40004c00)&0x40u)break;
  if(spins==4096u)return;R(0x40004c04)=request[i];
 }
}
int rtc_receive(const u8 *p,u16 n,u32 now){
 unsigned h;
 if(n!=8||p[0]!=0xbe||p[1]!=0x1a||p[2]!=8||p[3]!=13||p[7]!=0xed)return 0;
 if(p[4]==0x9f){clock.valid=0;return 1;}
 if(p[4]<0x80||p[4]>0x97)return 0;
 h=p[4]&31u;if(p[5]>59||p[6]>59)return 1;
 clock.seconds=h*3600u+p[5]*60u+p[6];clock.received=now;clock.valid=1;return 1;
}
u32 rtc_value(void){
 u32 s,h,m;
 if(!clock.valid)return 0xffffffffu;
 s=(clock.seconds+(u32)(now_ms()-clock.received)/1000u)%86400u;h=s/3600u;m=s/60u%60u;s%=60u;
 return ((h/10u*16u+h%10u)<<16)|((m/10u*16u+m%10u)<<8)|(s/10u*16u+s%10u);
}
unsigned rtc_state(void){return 0x0400u|(clock.valid?2u:1u);}
unsigned rtc_schedule(const u8 *p,u16 seq,u32 now){(void)p;(void)seq;(void)now;return FORMAT;}
int rtc_result(u16 *seq){(void)seq;return 0;}
