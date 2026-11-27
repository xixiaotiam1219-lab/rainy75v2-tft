/* SPDX-License-Identifier: MIT */
/* 0.71 grows into the old erase page. Append short records to the explicitly
 * linked image tail using the stock RAM program routine, with no runtime erase. */
typedef unsigned long long u64;
typedef struct {u32 cycles,day_seconds,rate_mhz,check;} ClockRecord;
#define CLOCK_MAGIC 0x434c4b32u
#define CLOCK_SLOTS ((MAIN_IMAGE_LIMIT-MAIN_JOURNAL_START)/sizeof(ClockRecord))
#define records ((const volatile ClockRecord *)MAIN_JOURNAL_START)

static unsigned journal_depth(void){
 unsigned i=CLOCK_SLOTS;
 while(i){
  const volatile ClockRecord *r=records+i-1;
  if((r->cycles&r->day_seconds&r->rate_mhz&r->check)!=0xffffffffu)break;
  i--;
 }
 return i;
}

static u32 clock_check(u32 cycles,u32 day_seconds,u32 rate){
 return ((CLOCK_MAGIC^cycles^day_seconds^rate)&0x3fffffffu)|0x40000000u;
}

static int read_rtc(u32 *day,u32 *cycles){
 u32 old=irq_lock();
 *day=R32(0x4000103c)&0x3fffu;
 *cycles=R32(0x40001038);
 int valid=(R32(0x4000103c)&0x3fffu)==*day&&*cycles<RTC_MOD;
 irq_unlock(old);
 return valid;
}

static unsigned journal_program(u32 addr,const u32 *data,u32 size){
 /* Only calls with aligned, fixed journal records reach this function. */
 return ((u32(*)(u32,u32,const void*,u32))MAIN_ISP_PROGRAM)(2,addr,data,size);
}

static void journal_revoke(const volatile ClockRecord *r){
 u32 zero=0;
 if(r->check&&r->check!=0xffffffffu)(void)journal_program((u32)&r->check,&zero,sizeof zero);
}

static unsigned clock_store(u32 seconds,u32 rate){
 if(rate>=30000u&&rate<=40000u)rate*=1000u;
 if(seconds>=86400u||rate<30000000u||rate>40000000u)return 3;
 unsigned used=journal_depth();
 if(used>=CLOCK_SLOTS)return 5;

 u32 day,cycles;
 if(!read_rtc(&day,&cycles))return FAULT;
 u32 day_seconds=(day<<17)|seconds;
 ClockRecord v={cycles,day_seconds,rate,clock_check(cycles,day_seconds,rate)};
 const volatile ClockRecord *r=records+used;
 if(journal_program((u32)r,&v.cycles,12)||
    r->cycles!=cycles||r->day_seconds!=day_seconds||r->rate_mhz!=rate||
    journal_program((u32)&r->check,&v.check,4)||r->check!=v.check)return FAULT;
 clock_push(seconds);
 return DONE;
}

/* The maximum quotient is below 2^31 for the documented 14-bit day counter. */
static u32 divide_elapsed(u64 numerator,u32 denominator){
 u64 divisor=(u64)denominator<<30;
 u32 result=0,bit=1u<<30;
 while(bit){
  if(numerator>=divisor){numerator-=divisor;result|=bit;}
  divisor>>=1;
  bit>>=1;
 }
 return result;
}

u32 rainy_clock_value(void){
 unsigned used=journal_depth();
 if(!used)return INVALID_TIME;
 const volatile ClockRecord *r=records+used-1;
 u32 rate=r->rate_mhz,day_seconds=r->day_seconds,anchor_cycles=r->cycles;
 if(rate<30000000u||rate>40000000u||anchor_cycles>=RTC_MOD||(day_seconds>>31)||(day_seconds&0x1ffffu)>=86400u||
    r->check!=clock_check(anchor_cycles,day_seconds,rate))return INVALID_TIME;
 u32 anchor_day=day_seconds>>17,day,cycles;
 if(!read_rtc(&day,&cycles))return INVALID_TIME;
 if(day<anchor_day||(day==anchor_day&&cycles<anchor_cycles)){
  journal_revoke(r);
  return INVALID_TIME;
 }
 u64 ticks=(u64)(day-anchor_day)*RTC_MOD+cycles-anchor_cycles;
 return ((day_seconds&0x1ffffu)+divide_elapsed(ticks*1000u,rate))%86400u;
}

static unsigned clock_query(unsigned field){
 if(field==9)return 0x4350;
 if(field==24)return 0x4346; /* OP18 accepts millihertz. */
 if(field==25)return CLOCK_SLOTS-journal_depth();
 if(field>=10)return 0;
 u32 time=rainy_clock_value();
 return field==6?time&65535u:field==7?time>>16:time!=INVALID_TIME;
}
