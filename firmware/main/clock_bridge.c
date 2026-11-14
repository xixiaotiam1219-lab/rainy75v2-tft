/* SPDX-License-Identifier: MIT */
/* USB calibration anchor + CH585 RTC -> cached IPS clock.
 * ROM clock mapping + one-way Flash revocation; no retained SRAM state.
 * The existing RX collector is consumed only for our complete BE/1D request.
 */
#define rainy_main_rtc_probe rainy_v3_probe
#define rainy_main_rtc_init rainy_v3_rtc_init
#include "main-rtc-retain.c"
#undef rainy_main_rtc_probe
#undef rainy_main_rtc_init
#define RTC_MOD 0xa8c00000u
#define INVALID_TIME 0xffffffffu
enum {DONE=1,FAULT=7};
static u32 irq_lock(void);
static void irq_unlock(u32 old);
#include "main-clock-isp-blob.h"
#define CLOCK_PAGE 0x49000u
#define CLOCK_MAGIC 0x434c4b31u
#define clock_guard R32(CLOCK_PAGE+24u)
typedef struct {u32 magic,cycles,seconds,rate,day,check;} ClockAnchor;
#define clock_anchor (*(const volatile ClockAnchor*)CLOCK_PAGE)
typedef u32(*IspFn)(u32,u32,const void*,u32);
static IspFn isp_load(u32 *code){
 u32 i;for(i=0;i<ISP_BLOB_SIZE;i++)((u8*)code)[i]=isp_blob[i];
 __asm__ volatile("fence.i":::"memory");
 return (IspFn)((u8*)code+ISP_CMD_OFFSET);
}
/* Only fixed, newly reserved clock-data addresses are writable. */
__attribute__((noinline)) static u32 clock_revoke(void){
 u32 code[(ISP_BLOB_SIZE+3)/4],zero=0,old,result;IspFn isp;
 if(clock_guard!=0xffffffffu)return 0;
 isp=isp_load(code);old=irq_lock();result=isp(2,CLOCK_PAGE+24u,&zero,4);irq_unlock(old);
 return result||clock_guard!=0?7u:0u;
}
static void clock_push(u32 t);
/* Commit the magic last. Interrupted writes leave an invalid record, never a
 * partly updated time. The dedicated4KiB page contains no executable code. */
__attribute__((noinline)) static unsigned clock_store(u32 seconds,u32 rate){
 u32 code[(ISP_BLOB_SIZE+3)/4],a[7],old,d2,result;IspFn isp;
 if(seconds>=86400u||rate<30000u||rate>40000u)return 3;
 isp=isp_load(code);old=irq_lock();
 a[0]=CLOCK_MAGIC;a[4]=R32(0x4000103c)&0x3fffu;a[1]=R32(0x40001038);d2=R32(0x4000103c)&0x3fffu;
 if(a[4]!=d2||a[1]>=RTC_MOD){irq_unlock(old);return FAULT;}
 a[2]=seconds;a[3]=rate;a[5]=a[0]^a[1]^a[2]^a[3]^a[4];a[6]=0xffffffffu;
 result=isp(1,CLOCK_PAGE,0,4096);
 if(!result)result=isp(2,CLOCK_PAGE+4,a+1,24);
 if(!result)result=isp(2,CLOCK_PAGE,a,4);
 irq_unlock(old);
 if(result||clock_guard!=0xffffffffu||clock_anchor.magic!=a[0]||clock_anchor.cycles!=a[1]||clock_anchor.seconds!=a[2]||clock_anchor.rate!=a[3]||clock_anchor.day!=a[4]||clock_anchor.check!=a[5])return FAULT;
 clock_push(seconds);return DONE;
}
static int anchor_valid(void){
 return clock_anchor.magic==0x434c4b31u&&clock_anchor.cycles<RTC_MOD&&clock_anchor.seconds<86400u&&clock_anchor.day<0x4000u&&clock_anchor.rate>=30000u&&clock_anchor.rate<=40000u&&
  clock_anchor.check==(clock_anchor.magic^clock_anchor.cycles^clock_anchor.seconds^clock_anchor.rate^clock_anchor.day);
}
u32 rainy_clock_value(void){
 u32 d,d2,c,days,part,rate,seconds,old;
 if(!anchor_valid()||clock_guard!=0xffffffffu)return INVALID_TIME;
 old=irq_lock();d=R32(0x4000103c)&0x3fffu;c=R32(0x40001038);d2=R32(0x4000103c)&0x3fffu;irq_unlock(old);
 if(d!=d2)return INVALID_TIME;
 if(c>=RTC_MOD||d<clock_anchor.day||(d==clock_anchor.day&&c<clock_anchor.cycles)){
  (void)clock_revoke();return INVALID_TIME;
 }
 days=d-clock_anchor.day;
 if(c<clock_anchor.cycles){days--;part=RTC_MOD-clock_anchor.cycles+c;}else part=c-clock_anchor.cycles;
 rate=clock_anchor.rate;
 seconds=days*(RTC_MOD/rate)+(days*(RTC_MOD%rate)+part)/rate;
 return (clock_anchor.seconds+seconds)%86400u;
}
static u32 irq_lock(void){u32 old,mask=0x88u;__asm__ volatile("csrrc %0,0x800,%1":"=r"(old):"r"(mask):"memory");return old&mask;}
static void irq_unlock(u32 old){__asm__ volatile("csrrs zero,0x800,%0"::"r"(old):"memory");}
/* Legacy validation does not modify the stored calibration. */
static unsigned clock_mark(void){return rainy_clock_value()==INVALID_TIME?FAULT:DONE;}
void rainy_main_rtc_init(u32 y,u32 m,u32 d,u32 h,u32 min,u32 sec){
 rainy_v3_rtc_init(y,m,d,h,min,sec);
 /* A reset below the ROM reference permanently revokes this mapping. */
 (void)rainy_clock_value();
}
static void bridge_ack(unsigned status,u32 value){u32 gp;volatile u8 *a;__asm__ volatile("mv %0,gp":"=r"(gp));a=(volatile u8*)(gp-0x160u);a[0]=13;a[1]=(u8)status;a[2]=(u8)value;a[3]=(u8)(value>>8);}
int rainy_main_rtc_probe(const u8 *p,u32 n){
 unsigned sum=0,i,field;u32 value;
 if((n==11||n==19)&&p[0]==0xbe&&p[1]==0x1a&&p[2]==n&&p[3]==13&&!p[7]&&p[n-1]==0xed){
  for(i=3;i<n-3;i++)sum+=p[i];
  if(p[n-3]==(sum&255u)&&p[n-2]==(sum>>8)){
   if(p[4]==18){
    u32 sec,rate;
    if(n!=19){bridge_ack(3,p[5]|(p[6]<<8));return 0;}
    sec=p[8]|((u32)p[9]<<8)|((u32)p[10]<<16)|((u32)p[11]<<24);
    rate=p[12]|((u32)p[13]<<8)|((u32)p[14]<<16)|((u32)p[15]<<24);
    bridge_ack(clock_store(sec,rate),p[5]|(p[6]<<8));return 0;
   }
   if(n!=11)return rainy_v3_probe(p,n);
   if(p[4]==17&&p[5]==0x7e&&p[6]==0xa1){bridge_ack(clock_mark(),0xa17e);return 0;}
   if(p[4]==15&&!p[6]&&(field=p[5])>=6&&field<=23){
    value=rainy_clock_value();
    if(field==6)value&=65535u;else if(field==7)value>>=16;else if(field==8)value=value!=INVALID_TIME;else if(field==9)value=0x4350;
    else if(field==10)value=clock_guard;else if(field==11)value=clock_guard>>16;
    else if(field==12)value=clock_anchor.cycles;else if(field==13)value=clock_anchor.cycles>>16;
    else if(field==14)value=clock_anchor.day;else if(field==15)value=clock_guard==0xffffffffu;
    else if(field==16)value=clock_anchor.magic;else if(field==17)value=clock_anchor.magic>>16;
    else if(field==18)value=clock_anchor.seconds;else if(field==19)value=clock_anchor.seconds>>16;
    else if(field==20)value=clock_anchor.rate;else if(field==21)value=clock_anchor.rate>>16;
    else if(field==22)value=clock_anchor.check;else value=clock_anchor.check>>16;
    bridge_ack(0xd0u+field,value);return 0;
   }
  }
 }
 return rainy_v3_probe(p,n);
}
static void clock_push(u32 t){
 u32 old;unsigned i;u8 p[8]={0xbe,0x1a,8,13,0x9f,0,0,0xed};
 if(R8(0x4000300b))return;
 if(t!=INVALID_TIME){p[4]=(u8)(0x80u+t/3600u);p[5]=(u8)(t/60u%60u);p[6]=(u8)(t%60u);}
 old=irq_lock();if(!R8(0x4000300b))for(i=0;i<8;i++)R8(0x40003008)=p[i];irq_unlock(old);
}
void rainy_clock_response(void){
 u32 gp;volatile u8 *rx=(volatile u8*)0x20016d28;
 __asm__ volatile("mv %0,gp":"=r"(gp));
 if(!R32(gp+0x17c)||R32(gp-0x1d0)||rx[0]!=0xbe||rx[1]!=0x1d||rx[2]!=4||rx[3]!=0xed)return;
 R32(0x20016d28)=0;if(R8(0x4000300b))return;
 clock_push(rainy_clock_value());
}
/* Replace two adjacent calls without losing the first call's output registers.
 * Original second-call arguments/return and callee-saved registers are kept.
 */
#define CLOCK_WORKER(name,next) \
__attribute__((naked)) void name(void){__asm__ volatile( \
 "addi sp,sp,-64\n sw ra,60(sp)\n li t0,0x20007000\n jalr ra,t0,0\n" \
 "sw a0,0(sp)\n sw a1,4(sp)\n sw a2,8(sp)\n sw a3,12(sp)\n sw a4,16(sp)\n sw a5,20(sp)\n sw a6,24(sp)\n sw a7,28(sp)\n" \
 "sw t0,32(sp)\n sw t1,36(sp)\n sw t2,40(sp)\n sw t3,44(sp)\n sw t4,48(sp)\n sw t5,52(sp)\n sw t6,56(sp)\n" \
 "call rainy_clock_response\n" \
 "lw a0,0(sp)\n lw a1,4(sp)\n lw a2,8(sp)\n lw a3,12(sp)\n lw a4,16(sp)\n lw a5,20(sp)\n lw a6,24(sp)\n lw a7,28(sp)\n" \
 "lw t0,32(sp)\n lw t1,36(sp)\n lw t2,40(sp)\n lw t3,44(sp)\n lw t4,48(sp)\n lw t5,52(sp)\n lw t6,56(sp)\n" \
 "lw ra,60(sp)\n addi sp,sp,64\n li t0," #next "\n jr t0\n");}
CLOCK_WORKER(rainy_clock_worker_a,0x2000752a)
CLOCK_WORKER(rainy_clock_worker_b,0x200091fa)
