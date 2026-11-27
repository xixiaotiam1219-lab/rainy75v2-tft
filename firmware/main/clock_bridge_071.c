/* SPDX-License-Identifier: MIT */
typedef unsigned char u8;
typedef unsigned int u32;
#include "main_addresses.h"
#define R32(a) (*(volatile u32 *)(a))
#define R8(a) (*(volatile u8 *)(a))
#define RTC_MOD 0xa8c00000u
#define INVALID_TIME 0xffffffffu
enum {DONE=1,FAULT=7};

static u32 irq_lock(void){u32 old,mask=0x88u;__asm__ volatile("csrrc %0,0x800,%1":"=r"(old):"r"(mask):"memory");return old&mask;}
static void irq_unlock(u32 old){__asm__ volatile("csrrs zero,0x800,%0"::"r"(old):"memory");}
static void clock_push(u32 t);
#include "clock_journal.h"

static u32 gp_value(void){u32 gp;__asm__ volatile("mv %0,gp":"=r"(gp));return gp;}

static void clock_push(u32 time){
 if(R8(0x4000300b))return;
 u8 frame[8]={0xbe,0x1a,8,13,0x9f,0,0,0xed};
 if(time!=INVALID_TIME){frame[4]=0x80u+time/3600u;frame[5]=time/60u%60u;frame[6]=time%60u;}
 u32 old=irq_lock();
 if(!R8(0x4000300b))for(unsigned i=0;i<8;i++)R8(0x40003008)=frame[i];
 irq_unlock(old);
}

void rainy_main_rtc_init(u32 year,u32 month,u32 day,u32 hour,u32 minute,u32 second){
 unsigned cause=R8(0x40001044)&7u;
 if((cause==0||cause==2||cause==3||cause==5)&&R32(0x40001038)<RTC_MOD){
  (void)rainy_clock_value();
  return;
 }
 unsigned used=journal_depth();
 if(used)journal_revoke(records+used-1);
 ((void(*)(u32,u32,u32,u32,u32,u32))MAIN_RTC_INIT)(year,month,day,hour,minute,second);
}

static void bridge_ack(unsigned status,u32 value){
 volatile u8 *reply=(volatile u8*)(gp_value()+MAIN_ACK_OFFSET);
 reply[0]=13;reply[1]=(u8)status;reply[2]=(u8)value;reply[3]=(u8)(value>>8);
}

static u32 little32(const u8 *p){return p[0]|((u32)p[1]<<8)|((u32)p[2]<<16)|((u32)p[3]<<24);}

int rainy_main_rtc_probe(const u8 *p,u32 size){
 if((size==11||size==19)&&p[0]==0xbe&&p[1]==0x1a&&p[2]==size&&p[3]==13&&!p[7]&&p[size-1]==0xed){
  unsigned sum=0;
  for(unsigned i=3;i<size-3;i++)sum+=p[i];
  if(p[size-3]==(sum&255u)&&p[size-2]==(sum>>8)){
   unsigned field=p[5],op=p[4];
   if(op==18){bridge_ack(size==19?clock_store(little32(p+8),little32(p+12)):3,field|(p[6]<<8));return 0;}
   if(size==11&&op==15&&!p[6]&&field<=25){
    u32 value;
    if(field<=1){value=R32(0x40001038);if(field)value>>=16;}
    else if(field==2)value=R32(0x4000103c)&0x3fffu;
    else if(field==3)value=R8(0x4000102f);
    else if(field<6)value=0;
    else value=clock_query(field);
    bridge_ack(0xd0+field,value);
    return 0;
   }
  }
 }
 return ((int(*)(const u8*,u32))MAIN_IPS_HANDLER)(p,size);
}

void rainy_clock_collector(void){
 u32 gp=gp_value();
 if(!R32(gp+MAIN_SCREEN_ENABLED_OFFSET))return;
 /* Enter after the original eight-byte gate, before its stack prologue. */
 ((void(*)(void))MAIN_COLLECTOR_BODY)();
 volatile u8 *rx=(volatile u8*)MAIN_RX_BUFFER;
 if(R32(gp+MAIN_RX_LENGTH_OFFSET)||rx[0]!=0xbe||rx[1]!=0x1d||rx[2]!=4||rx[3]!=0xed)return;
 R32(MAIN_RX_BUFFER)=0;
 if(!R8(0x4000300b))clock_push(rainy_clock_value());
}
