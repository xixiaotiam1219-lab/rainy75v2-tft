/* SPDX-License-Identifier: MIT */
#ifndef RAINY_NATIVE_UI_H
#define RAINY_NATIVE_UI_H
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef u8 live_u8;
enum {QUEUED=0,DONE=1,BUSY=2,FORMAT=3,RANGE=5,FAULT=7};
#ifndef RAINY_THEME_SLOT_DEFINED
#define RAINY_THEME_SLOT_DEFINED
typedef struct {u32 magic;u16 version,size,bg,panel,shell,ink,accent,muted,lyricsBorder,lyricsPanel;u32 crc32;} RainyThemeSlot;
#endif
void rtc_tick(u32 now);
unsigned rtc_schedule(const u8 *p,u16 seq,u32 now);
u32 rtc_value(void);
unsigned rtc_state(void);
int rtc_result(u16 *seq);
int rtc_receive(const u8 *p,u16 n,u32 now);
#endif
