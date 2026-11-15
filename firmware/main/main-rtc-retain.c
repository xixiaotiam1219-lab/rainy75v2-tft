/* SPDX-License-Identifier: MIT */
/* Rainy75 V2 CH585 supported 0x3f/0x40: read-only RTC diagnostic.
 * Only sub13/op15 selectors0..3 are intercepted. All other frames tail into
 * the original IPS handler. No clock/GPIO/power/Flash registers are written.
 * The ACK descriptor is resolved from the live ABI GP register (gp-0x160),
 * never from the synthetic GP used by an isolated test fixture.
 */
typedef unsigned char u8;
typedef unsigned int u32;
#include "main_addresses.h"
#define R32(a) (*(volatile u32 *)(a))
#define R8(a) (*(volatile u8 *)(a))
int rainy_main_rtc_probe(const u8 *p,u32 n){
 unsigned sum=13u+15u;u32 value,gp;unsigned i,field;volatile u8 *ack;
 if(n!=11||p[0]!=0xbe||p[1]!=0x1a||p[2]!=11||p[3]!=13||p[4]!=15||p[6]||p[7]||p[10]!=0xed||p[5]>5)
  return ((int(*)(const u8*,u32))MAIN_IPS_HANDLER)(p,n);
 field=p[5];sum+=field;
 if(p[8]!=(sum&255u)||p[9]!=(sum>>8))return ((int(*)(const u8*,u32))MAIN_IPS_HANDLER)(p,n);
 if(field<2){
  value=R32(0x40001038);
  for(i=0;i<8;i++){u32 next=R32(0x40001038);if(next==value)break;value=next;}
  if(field)value>>=16;
 }else if(field==2)value=R32(0x4000103c)&0x3fffu;
 else if(field==3)value=R8(0x4000102f);
 else if(field==4)value=R8(0x40001044)&7u;
 else value=*(volatile unsigned short*)0x4000102c;
 __asm__ volatile("mv %0,gp":"=r"(gp));ack=(volatile u8*)(gp-0x160u);
 ack[0]=13;ack[1]=(u8)(0xd0u+field);
 ack[2]=(u8)value;ack[3]=(u8)(value>>8);
 return 0;
}

/* Original HAL calls RTC_InitTime(2020,1,1,0,0,0) at 0x134D8 on every
 * initialization. Keep an in-range counter on documented warm reset causes.
 * A true POR or invalid count still executes the original initialization.
 * No GPIO, oscillator tuning or BLE timing registers are changed here.
 */
void rainy_main_rtc_init(u32 year,u32 mon,u32 day,u32 hour,u32 min,u32 sec){
 unsigned cause=R8(0x40001044)&7u;
 if((cause==0u||cause==2u||cause==3u||cause==5u)&&R32(0x40001038)<0xa8c00000u)return;
 ((void(*)(u32,u32,u32,u32,u32,u32))MAIN_RTC_INIT)(year,mon,day,hour,min,sec);
}
