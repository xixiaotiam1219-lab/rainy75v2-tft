/* SPDX-License-Identifier: MIT */
#ifndef RAINY_LYRICS_H
#define RAINY_LYRICS_H
#include "native_ui.h"
#ifndef RAINY_THEME_SLOT_DEFINED
#define RAINY_THEME_SLOT_DEFINED
typedef struct {u32 magic;u16 version,size,bg,panel,shell,ink,accent,muted,lyricsBorder,lyricsPanel;u32 crc32;} RainyThemeSlot;
#endif
extern const RainyThemeSlot r75_theme;
int lyrics_request(const u8 *p,u16 n,unsigned *status,u16 *value);
int lyrics_tick(u32 now);
int lyrics_mode(void);
void lyrics_prepare(u8 *pixels,int fresh,u32 now);
void lyrics_draw(u8 *pixels,u32 now);
int lyrics_suspend(void);
void lyrics_maintenance(int suspended);
void lyrics_cancel_maintenance(void);
int lyrics_volume_key(u32 now,u16 *progress,u8 *level,u8 *muted,u16 *alpha);
unsigned lyrics_volume_icon(unsigned x,unsigned y,int muted);
#endif
