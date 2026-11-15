"""Generate editable UI headers and original robot GIFs. SPDX-License-Identifier: MIT."""
import argparse,json
from pathlib import Path
from PIL import Image,ImageDraw,GifImagePlugin

ROOT=Path(__file__).resolve().parents[1]
REGIONS=[(40,57,120,76),(16,13,94,14),(233,12,16,16),(264,17,20,8),(287,17,23,7)]
ICONS=[
 [2016,1440,1440,2016,2016,4080,8184,8184,8184,8184,4080,384,384,384,384,384],
 [0,8196,16386,32769,33729,34785,18018,10212,2016,2016,2016,960,576,960,960,0],
 [768,896,9184,7024,3864,1816,944,992,832,944,1816,3864,7024,13280,896,768],
]
def load(path):return json.loads(Path(path).read_text(encoding='utf8'))
def rgb565(color):
 n=int(color.removeprefix('#'),16);return ((n>>19)&31)<<11|((n>>10)&63)<<5|((n>>3)&31)
def validate_keys(profile):
 seen=set()
 if profile.get('idleTimeoutMs')!=0:raise ValueError('This version retains the last key; idleTimeoutMs must be 0')
 for g in profile['glyphs']:
  rows=g['rows'];key=g['key']
  if key in seen or not isinstance(key,int) or not 1<=key<=65535:raise ValueError('Duplicate/invalid key')
  seen.add(key)
  if not rows or len(rows)>11 or not 1<=len(rows[0])<=16:raise ValueError('Glyph must be 1..16 x 1..11 cells')
  if any(len(row)!=len(rows[0]) or set(row)-{'0','1'} for row in rows):raise ValueError('Invalid glyph cells')
  if len(rows[0])*6>120 or len(rows)*6>76:raise ValueError('Glyph does not fit key region')
 return profile
def headers(keys,theme,out):
 out.mkdir(parents=True,exist_ok=True);font=load(ROOT/'profiles/font.json')
 chars=[chr(c) for c in range(32,97)]+list('{|}~')
 grids=[font['ascii'][c] for c in chars]+[g['rows'] for g in font['icons']]
 rows=['/* SPDX-License-Identifier: MIT; generated editable pixel cells. */','static const unsigned char cache_font[][7]={']
 rows+=[' {'+','.join(str(int(r,2)) for r in glyph)+'},' for glyph in grids]
 rows+=['};','static unsigned glyph_index(unsigned c){if(c>=97&&c<=122)c-=32;if(c>=128&&c<144)return 69+c-128;if(c>=32&&c<=126)return c-32-(c>=123?26:0);return 31;}']
 (out/'cache_font.h').write_text('\n'.join(rows)+'\n',encoding='utf8')
 rows=['/* SPDX-License-Identifier: MIT; generated from profiles. */','#define UI_IDLE_MS 0u','#define UI_USB_RAW 1','#define UI_RF_RAW 0','typedef struct {u16 x,y,fg,bg,offset,bytes;u8 w,h;} UiRegion;','static const UiRegion ui_geo[]={']
 offset=0
 for i,(x,y,w,h) in enumerate(REGIONS):
  size=(w*h+7)//8;bg=theme['panel'] if i==0 else theme['background']
  rows.append(' {'+','.join(map(str,[x,y,rgb565(theme['ink']),rgb565(bg),offset,size,w,h]))+'},');offset+=size
 rows+=['};','typedef struct {u16 key;u8 w,h;u16 rows[11];} BigGlyph;','static const BigGlyph big_glyphs[]={']
 for g in keys['glyphs']:
  rows.append(' {'+','.join(map(str,[g['key'],len(g['rows'][0]),len(g['rows'])]))+',{'+','.join(str(int(r,2)) for r in g['rows'])+'}},')
 rows+=['};','static const u16 connection_icons[3][16]={']+[' {'+','.join(map(str,r))+'},' for r in ICONS]+['};']
 if offset!=1378:raise ValueError('Unexpected mask allocation')
 (out/'ui_assets.h').write_text('\n'.join(rows)+'\n',encoding='utf8')
 (out/'lyrics_theme.h').write_text('/* SPDX-License-Identifier: MIT */\n'+''.join(f'#define {k} {rgb565(v)}u\n' for k,v in [('INK',theme['ink']),('BG',theme['background']),('MUTED',theme.get('muted',theme['accent'])),('TRACK',theme['shell']),('CARD',theme.get('lyricsBorder',theme['shell'])),('PAPER',theme.get('lyricsPanel',theme['panel'])),('ACCENT',theme['accent'])]),encoding='utf8')
def base_frame(theme,phase=0):
 im=Image.new('RGB',(320,172),theme['background']);d=ImageDraw.Draw(im)
 d.rounded_rectangle((7,37,312,165),radius=16,fill=theme['shell'])
 d.rounded_rectangle((12,42,307,160),radius=13,fill=theme['background'])
 d.rounded_rectangle((24,45,176,145),radius=13,fill=theme['ink'])
 d.rounded_rectangle((27,48,173,142),radius=10,fill=theme['panel'])
 # Original geometric robot: no third-party character/sprite source.
 bob=[0,0,-1,-1,0,1,1,0][phase%8];x,y=218,70+bob
 d.ellipse((205,143,297,151),fill=theme['shell'])
 d.line((x+37,y-12,x+37,y),fill=theme['ink'],width=3);d.rectangle((x+33,y-17,x+41,y-10),fill=theme['accent'])
 d.rounded_rectangle((x,y,x+74,y+50),radius=8,fill=theme['ink'])
 d.rounded_rectangle((x+3,y+3,x+71,y+47),radius=6,fill=theme['panel'])
 if phase==4:
  d.line((x+15,y+19,x+25,y+19),fill=theme['ink'],width=3);d.line((x+49,y+19,x+59,y+19),fill=theme['ink'],width=3)
 else:
  d.rectangle((x+17,y+13,x+24,y+22),fill=theme['ink']);d.rectangle((x+50,y+13,x+57,y+22),fill=theme['ink'])
 d.line((x+28,y+32,x+46,y+32),fill=theme['ink'],width=3)
 d.rectangle((x+20,y+51,x+55,y+68),fill=theme['accent'])
 d.rectangle((x+14,y+69,x+31,y+73),fill=theme['ink']);d.rectangle((x+44,y+69,x+61,y+73),fill=theme['ink'])
 d.line((x+14,y+54,x+5,y+62),fill=theme['ink'],width=3);d.line((x+61,y+54,x+70,y+60-(phase%3)),fill=theme['ink'],width=3)
 # Pixel label uses this project's cell grids, not a system font.
 font=load(ROOT/'profiles/font.json')['ascii']
 for i,c in enumerate('RAINY'):
  for yy,row in enumerate(font[c]):
   for xx,cell in enumerate(row):
    if cell=='1':d.point((73+i*6+xx,151+yy),fill=theme['ink'])
 return im
def preview_frame(theme,keys,key=227):
 im=base_frame(theme);d=ImageDraw.Draw(im);font=load(ROOT/'profiles/font.json')['ascii']
 def text(value,x,y,scale):
  for i,c in enumerate(value):
   for yy,row in enumerate(font[c]):
    for xx,cell in enumerate(row):
     if cell=='1':d.rectangle((x+(i*6+xx)*scale,y+yy*scale,x+(i*6+xx+1)*scale-1,y+(yy+1)*scale-1),fill=theme['ink'])
 text('12:34:56',16,13,2);text('84%',287,17,1)
 d.rectangle((264,17,280,24),outline=theme['ink']);d.rectangle((267,20,276,22),fill=theme['ink']);d.rectangle((281,19,282,22),fill=theme['ink'])
 for yy,row in enumerate(ICONS[0]):
  for xx in range(16):
   if row&(1<<(15-xx)):d.point((233+xx,12+yy),fill=theme['ink'])
 g=next(g for g in keys['glyphs'] if g['key']==key);x=40+(120-len(g['rows'][0])*6)//2;y=57+(76-len(g['rows'])*6)//2
 for yy,row in enumerate(g['rows']):
  for xx,cell in enumerate(row):
   if cell=='1':d.rectangle((x+xx*6,y+yy*6,x+xx*6+5,y+yy*6+5),fill=theme['ink'])
 return im

def save_cache_gif(frames,path):
 # Keep the previous surface while the native decoder prepares the next frame.
 # Image.save(disposal=1) crops later frames even with optimize=False. Encode
 # each image explicitly so every frame also restores the lyrics marker.
 indexed=[frame.quantize(colors=256) for frame in frames]
 header,_=GifImagePlugin.getheader(indexed[0],info={'loop':0})
 with Path(path).open('wb') as output:
  for block in header:output.write(block)
  for i,frame in enumerate(indexed):
   for block in GifImagePlugin.getdata(frame,duration=120,disposal=1,include_color_table=i>0):output.write(block)
  output.write(b';')

def validate_cache_gif(path,theme):
 bg=rgb565(theme['background'])
 with Image.open(path) as gif:
  if gif.size!=(320,172):raise ValueError('Cache GIF must be 320x172')
  for i in range(gif.n_frames):
   gif.seek(i)
   if not gif.tile or gif.tile[0][1]!=(0,0,320,172):raise ValueError('Cache GIF requires complete frames')
   if gif.disposal_method!=1:raise ValueError('Cache GIF must retain the previous frame (disposal=1)')
   if 'transparency' in gif.info:raise ValueError('Cache GIF frames must be opaque')
   color=gif.convert('RGB').getpixel((22,39))
   if rgb565('#%02x%02x%02x'%color)==bg:raise ValueError('Cache frame marker equals player background')
def generate(keys_path,theme_name,out,header_dir=None):
 keys=validate_keys(load(keys_path));themes=load(ROOT/'profiles/themes.json')
 if theme_name not in themes:raise ValueError('Unknown theme')
 theme=themes[theme_name];out=Path(out);out.mkdir(parents=True,exist_ok=True)
 if header_dir:headers(keys,theme,Path(header_dir))
 frames=[base_frame(theme,i) for i in range(8)]
 save_cache_gif(frames,out/f'robot-{theme_name}.gif')
 validate_cache_gif(out/f'robot-{theme_name}.gif',theme)
 preview_frame(theme,keys).save(out/f'preview-{theme_name}.png')
 return out/f'robot-{theme_name}.gif'
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--keys',type=Path,default=ROOT/'profiles/keys.json');p.add_argument('--theme',default='pink');p.add_argument('--out',type=Path,default=ROOT/'build/assets');p.add_argument('--headers',type=Path)
 a=p.parse_args();print(generate(a.keys,a.theme,a.out,a.headers))
