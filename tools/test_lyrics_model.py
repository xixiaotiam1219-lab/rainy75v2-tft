"""Execute the locally built ARM image with modeled FatFs/LCD/UART/allocator.
No HID, device writes, media requests, vendor input distribution or physical claims.
SPDX-License-Identifier: MIT
"""
import argparse,json,struct,hashlib,base64
from pathlib import Path
from PIL import Image
from unicorn import Uc,UC_ARCH_ARM,UC_MODE_THUMB,UC_MODE_MCLASS,UC_HOOK_CODE,UC_HOOK_MEM_WRITE
from unicorn.arm_const import UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3,UC_ARM_REG_LR,UC_ARM_REG_PC,UC_ARM_REG_SP
from build import elf,require
from assets import ROOT,load,preview_frame,rgb565
from fontpack import Font20

def main():
 p=argparse.ArgumentParser();p.add_argument('--build',type=Path,default=ROOT/'build/ips-lyrics');p.add_argument('--preview',type=Path);p.add_argument('--cover',type=Path);a=p.parse_args();folder=a.build
 image=(folder/'rainy75v2-ips.bin').read_bytes();manifest=load(folder/'manifest.json');require(manifest.get('variant')=='lyrics-v1' and hashlib.sha256(image).hexdigest()==manifest['sha256'],'Wrong model build')
 _,_,_,symbols,_=elf((folder/'module.elf').read_bytes());data=(folder/'FONT.BIN').read_bytes();font=Font20(data)
 u=Uc(UC_ARCH_ARM,UC_MODE_THUMB|UC_MODE_MCLASS);u.mem_map(0x08000000,0x100000);u.mem_write(0x08004000,image);u.mem_map(0x20000000,0x60000);u.mem_map(0x1ffff000,0x1000);u.mem_map(0x40000000,0x40000)
 surface,object_at,stack,stop=0x20010000,0x20006000,0x2005e000,0x08001000
 allocs={};files={};ctx={'now':1000,'reads':0,'fail':False,'uart':[],'unlinks':0,'maxRequest':0,'peakHeap':0,'alignCheck':False}
 def put(at,v,n=4):u.mem_write(at,int(v).to_bytes(n,'little'))
 def get(at,n=4):return int.from_bytes(u.mem_read(at,n),'little')
 def ret(v=0):u.reg_write(UC_ARM_REG_R0,v);u.reg_write(UC_ARM_REG_PC,u.reg_read(UC_ARM_REG_LR))
 def code(cpu,at,size,_):
  r0,r1,r2,r3=[cpu.reg_read(r)for r in [UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3]]
  if at==0x0803a2ba:ret(ctx['now'])
  elif at==0x08025c08:
   ctx['maxRequest']=max(ctx['maxRequest'],r0)
   if ctx['fail']:ret(0);return
   n=(r0+7)&~7;address=0x2003f000
   for old,used in sorted(allocs.items()):
    if address+n<=old:break
    address=max(address,old+used)
   assert address+n<=0x2005d000,'Model heap exhausted';allocs[address]=n;ctx['peakHeap']=max(ctx['peakHeap'],sum(allocs.values()));u.mem_write(address,b'\xa5'*n);ret(address)
  elif at==0x0802ab34:assert r0 in allocs,'Invalid/shared free';del allocs[r0];ret()
  elif at==0x0803c804:
   assert bytes(u.mem_read(r1,9))==b'FONT.BIN\0' and r2==1;assert not get(0x20001c6c);files[r0]=0;put(r0+12,len(data));ret()
  elif at==0x0803d098:assert r0 in files and not get(0x20001c6c);files[r0]=r1;ret()
  elif at==0x0803ccc8:
   assert r0 in files and not get(0x20001c6c);assert r2 in [52,256];chunk=data[files[r0]:files[r0]+r2];u.mem_write(r1,chunk);put(r3,len(chunk));files[r0]+=len(chunk);ctx['reads']+=1;ret()
  elif at==0x0803d074:assert r0 in files;del files[r0];ret()
  elif at==0x0803dd04:assert bytes(u.mem_read(r0,9))==b'FONT.BIN\0' and not files and not get(0x20001c6c);ctx['unlinks']+=1;ret()
  elif at==0x0805d6f2:put(0x20001c6c,1);ret()
  else:ret() # Original GUI/callback bodies are external to this unit model.
 for at in [0x0803a2ba,0x08025c08,0x0802ab34,0x0803c804,0x0803d098,0x0803ccc8,0x0803d074,0x0803dd04,0x0805d6f2,0x0807a600,0x0805ac72,0x0805ae0a,0x0805b244,0x0802dca8,0x0805b030]:u.hook_add(UC_HOOK_CODE,code,begin=at,end=at)
 def write(cpu,access,address,size,value,_):
  if ctx['alignCheck']and surface<=address<surface+110080 and size>=4:assert address%4==0,'Unaligned frame word store'
  assert not 0x40023c00<=address<0x40023d00,'Unexpected Flash-controller write'
  if address==0x40004c04:ctx['uart'].append(value&255)
 u.hook_add(UC_HOOK_MEM_WRITE,write,begin=0x40000000,end=0x4003ffff)
 def call(name,*args):
  for i,r in enumerate([UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3]):u.reg_write(r,args[i]if i<len(args)else 0)
  for i,v in enumerate(args[4:]):put(stack+i*4,v)
  u.reg_write(UC_ARM_REG_SP,stack);u.reg_write(UC_ARM_REG_LR,stop|1);u.emu_start(symbols[name]|1,stop,count=5000000);assert u.reg_read(UC_ARM_REG_PC)&~1==stop,name;return u.reg_read(UC_ARM_REG_R0)
 def finish():put(0x20001c6c,0)
 def tick(dt=2):ctx['now']+=dt;before=ctx['reads'];call('rainy_hook_image');assert ctx['reads']-before<=4;finish()
 def packet(op,seq=0,payload=b''):
  b=bytearray([0xbe,0x1a,11+len(payload),13,op,seq&255,seq>>8,0])+payload;return bytes(b)+struct.pack('<H',sum(b[3:])&65535)+b'\xed'
 def request(op,seq=0,payload=b''):
  b=packet(op,seq,payload);u.mem_write(0x20000100,b);ctx['uart']=[];call('rainy_hook_ips',0x20000100,len(b));r=bytes(ctx['uart']);assert len(r)==8 and r[:4]==bytes([0xbe,0x1a,8,13]),r;return r[4],int.from_bytes(r[5:7],'little')
 def q(f):status,value=request(22,f);assert status==0xc0+(f&15);return value
 def draw():finish();call('rainy_hook_cached_draw',0,0,320,172,surface);finish()
 def stage(rev,title,current,nextline):
  for k,text in enumerate([title,current,nextline]):
   ids=[font.lookup.get(ord(c),font.fallback)for c in text];assert request(20,rev,bytes([k,len(ids)])+struct.pack('<'+'H'*len(ids),*ids))==(1,rev)
  assert request(21,rev,struct.pack('<IIBII',86000,222000,1,2000,15000))==(0,rev)
  for _ in range(1000):
   tick()
   if q(3)==rev:return
  raise AssertionError('Job did not commit')
 put(0x40004c00,0x40);put(0x1ffff7e0,1024,2);put(0x1ffff7f3,13,1);call('rainy_hook_start')
 assert request(11,1)==(0xb1,0)
 if manifest['format']=='rainy75v2-tft/build-v1':assert request(11,14)==(0xbe,1024) and request(11,15)==(0xbf,13)
 put(0x2003ede8,object_at);put(object_at+0x658,surface)
 for at,v in [(0x2003edba,320),(0x2003edbc,172),(0x2003edbe,0),(0x2003edc0,0)]:put(at,v,2)
 theme=load(ROOT/'profiles/themes.json')[manifest['theme']];base=preview_frame(theme,load(ROOT/'profiles/keys.json'))
 rgb=bytearray()
 for color in base.getdata():rgb+=struct.pack('<H',rgb565('#%02x%02x%02x'%color))
 u.mem_write(surface,bytes(rgb));call('rainy_hook_native_status',84,0,1);u.mem_write(0x20000100,bytes([0xbe,0x1a,8,13,0x8c,34,56,0xed]));call('rainy_hook_ips',0x20000100,8);draw()
 call('rainy_hook_native_key',46,0,0);draw();plain=bytes(u.mem_read(surface,110080));call('rainy_hook_native_key',46,0,1);draw();shifted=bytes(u.mem_read(surface,110080));assert plain!=shifted
 assert request(24,1)==(0xa6,0x4c59);tick();assert q(0)==1 and q(7)==96
 assert q(8)==1 and q(11)==5;assert request(26,9,b'\0')==(1,9);assert q(8)==0
 stage(10,'雨后的像素电台','把小小的屏幕点亮','文字跟着旋律慢慢滚动');assert request(23,11,b'\1')==(1,11);draw();assert q(1)==1
 reads=ctx['reads'];stage(12,'雨后的像素电台','文字跟着旋律慢慢滚动','新句');assert ctx['reads']-reads==4
 long='标题超过十六个字仍需独立滚动且不被歌词换句打断';stage(13,long,'当前句','下一句');draw();initial=bytes(u.mem_read(surface+51*640,20*640))
 for _ in range(90):tick(33)
 assert bytes(u.mem_read(surface+51*640,20*640))!=initial;stage(14,long,'另一句','下一句');assert request(25,15,struct.pack('<IIBII',87000,222000,0,0,15000))==(1,15);draw();assert bytes(u.mem_read(surface+51*640,20*640))!=initial
 old=dict(allocs);ctx['fail']=True
 for k,text in enumerate([long,'另一句','下一句']):
  ids=[font.lookup.get(ord(c),font.fallback)for c in text];assert request(20,16,bytes([k,len(ids)])+struct.pack('<'+'H'*len(ids),*ids))==(1,16)
 assert request(21,16,struct.pack('<IIB',0,0,0))==(0,16);tick();assert q(3)==14 and q(2)!=0 and allocs==old;ctx['fail']=False
 stage(17,'甲乙丙丁'*24,'繁體簡體'*24,'日本語歌'*24);assert not q(2)
 stage(30,'雨后的像素电台','把小小的屏幕点亮','文字跟着旋律慢慢滚动');tick(300);draw()
 if a.preview:
  values=struct.unpack('<55040H',bytes(u.mem_read(surface,110080)));im=Image.new('RGB',(320,172));im.putdata([(((v>>11)&31)*255//31,((v>>5)&63)*255//63,(v&31)*255//31)for v in values]);a.preview.parent.mkdir(parents=True,exist_ok=True);im.resize((960,516),Image.Resampling.NEAREST).save(a.preview.with_name(a.preview.stem+'-20'+a.preview.suffix))
 reads=ctx['reads'];old=dict(allocs);assert request(26,31,b'\1')==(1,31);assert q(8)==1 and allocs==old and ctx['reads']==reads
 stage(32,'晚风与星光','星光','这行不显示');tick(300);draw();caption=bytes(u.mem_read(surface,110080));ink=rgb565(theme['ink']);bg=rgb565(theme['background'])
 expected=set()
 for text,scale,y0,field,x0 in [('晚风与星光',1,43,286,17),('星光',2,90,288,16)]:
  x0+=(field-sum(font.glyph(ch)[0]*scale for ch in text))//2
  for ch in text:
   advance,bits=font.glyph(ch)
   for yy in range(20):
    for xx in range(advance):
     bit=yy*20+xx
     if bits[bit>>3]&(128>>(bit&7)):
      for dy in range(scale):
       for dx in range(scale):expected.add((x0+xx*scale+dx,y0+yy*scale+dy))
   x0+=advance*scale
 def color(raw,x,y):return int.from_bytes(raw[(y*320+x)*2:(y*320+x)*2+2],'little')
 for y0,y1 in [(43,63),(78,143)]:
  for y in range(y0,y1):
   for x in range(16,304):assert (color(caption,x,y)==ink)==((x,y)in expected)
 assert color(caption,22,39)==bg
 assert request(26,33,b'\5')==(5,33) and q(8)==1
 if a.preview:
  stage(34,'雨后的像素电台','星光正好','下一句');tick(300);draw();values=struct.unpack('<55040H',bytes(u.mem_read(surface,110080)));im=Image.new('RGB',(320,172));im.putdata([(((v>>11)&31)*255//31,((v>>5)&63)*255//63,(v&31)*255//31)for v in values]);im.resize((960,516),Image.Resampling.NEAREST).save(a.preview)
 for layout in [2,3]:
  reads=ctx['reads'];saved=dict(allocs);assert request(26,40+layout,bytes([layout]))==(1,40+layout);assert q(8)==layout and reads==ctx['reads']and allocs==saved
  stage(60+layout,'雨后的像素电台','春夏秋冬山川湖海星光明月清风细雨'if layout==3 else'星光正好','下一句也有新的好心情');assert request(25,70+layout,struct.pack('<IIBII',86000,222000,0,0,20000))==(1,70+layout);tick(300);draw()
  first=bytes(u.mem_read(surface,110080));assert color(first,22,39)==bg
  if a.preview:
   im=Image.new('RGB',(320,172));values=struct.unpack('<55040H',first);im.putdata([(((v>>11)&31)*255//31,((v>>5)&63)*255//63,(v&31)*255//31)for v in values]);im.resize((960,516),Image.Resampling.NEAREST).save(a.preview.with_name(a.preview.stem+('-focus'if layout==2 else'-double')+a.preview.suffix))
  if layout==3:
   reads=ctx['reads'];saved=dict(allocs);assert request(25,75,struct.pack('<IIBII',86000,222000,0,15000,20000))==(1,75);tick(33);draw();last=bytes(u.mem_read(surface,110080));assert first[74*640:158*640]!=last[74*640:158*640]and reads==ctx['reads']and allocs==saved
 # A temporary cover never opens/writes an asset or publishes a partial image.
 import zlib
 assert q(12)==0x4341
 assert request(26,80,b'\4')==(1,80)
 stage(81,'云端来信','风从远方来','把夜色轻轻吹开');tick(300);draw()
 pixels=b''.join(struct.pack('<H',((x//2)<<11)|((y//1)<<5)|((x+y)//4))for y in range(64)for x in range(64))
 palette=struct.pack('<4H',0x194a,0x3906,0x2104,0x2a28)
 if a.cover:
  art=json.loads(a.cover.read_text(encoding='utf8'));pixels=base64.b64decode(art['pixelsBase64'],validate=True);palette=base64.b64decode(art['paletteBase64'],validate=True);assert len(pixels)==8192 and len(palette)==8
 begin=b'\0'+struct.pack('<HBBBI',82,64,64,1,zlib.crc32(pixels))+palette
 reads=ctx['reads'];before=bytes(u.mem_read(surface,110080));saved=dict(allocs)
 assert request(28,82,begin)==(1,82)
 assert request(28,83,b'\1'+struct.pack('<HH',82,2)+pixels[:2])==(5,83)
 assert request(28,84,b'\2'+struct.pack('<H',82))==(5,84)
 for at in range(0,8192,224):
  assert request(28,100+at//224,b'\1'+struct.pack('<HH',82,at)+pixels[at:at+224])==(1,100+at//224)
 assert bytes(u.mem_read(surface,110080))==before and ctx['reads']==reads and saved==allocs
 assert request(28,140,b'\2'+struct.pack('<H',82))==(0,140) and q(13)==2
 put(0x20001c6c,1);call('rainy_hook_image');assert q(14)!=82;finish();tick();assert q(14)==82 and q(13)==1;draw()
 immersive=bytes(u.mem_read(surface,110080));assert immersive!=before and color(immersive,22,39)!=color(bytes(rgb),22,39)
 for x,y in[(5,5),(24,24),(42,42)]:assert color(immersive,16+x,14+y)==int.from_bytes(pixels[((y*4//3)*64+x*4//3)*2:((y*4//3)*64+x*4//3)*2+2],'little')
 if a.preview:
  im=Image.new('RGB',(320,172));values=struct.unpack('<55040H',immersive);im.putdata([(((v>>11)&31)*255//31,((v>>5)&63)*255//63,(v&31)*255//31)for v in values]);im.resize((960,516),Image.Resampling.NEAREST).save(a.preview.with_name(a.preview.stem+'-immersive'+a.preview.suffix))
 bad=bytearray(begin);bad[6]^=1;assert request(28,141,bytes(bad))==(1,141)
 for at in range(0,8192,224):assert request(28,150+at//224,b'\1'+struct.pack('<HH',82,at)+pixels[at:at+224])==(1,150+at//224)
 assert request(28,190,b'\2'+struct.pack('<H',82))==(7,190);tick();draw();assert bytes(u.mem_read(surface,110080))==immersive and q(14)==82
 assert q(16)==3
 colors=[((i%32)<<11)|(i<<5)|(i%32)for i in range(64)];packed=bytearray(struct.pack('<64H',*colors)+bytes(3072));indices=[(i*17+i//64)%64 for i in range(4096)]
 for i,index in enumerate(indices):
  bit=i*6;at=128+(bit>>3);shift=bit&7;packed[at]|=(index<<shift)&255
  if shift>2:packed[at+1]|=index>>(8-shift)
 begin2=b'\0'+struct.pack('<HBBBI',84,64,64,2,zlib.crc32(packed))+palette;assert request(28,192,begin2)==(1,192)
 for at in range(0,3200,224):assert request(28,193+at//224,b'\1'+struct.pack('<HH',84,at)+packed[at:at+224])==(1,193+at//224)
 assert request(28,210,b'\2'+struct.pack('<H',84))==(0,210);tick();draw();indexed=bytes(u.mem_read(surface,110080));assert q(14)==84
 for y in range(48):
  for x in range(48):
   if 3<=x<45 and 3<=y<45 and (x+16,y+14)!=(22,39):assert color(indexed,16+x,14+y)==colors[indices[(y*4//3)*64+x*4//3]]
 assert request(28,211,b'\3'+struct.pack('<H',85))==(0,211);tick();assert q(14)==85
 compact=packed[:1856];begin3=b'\0'+struct.pack('<HBBBI',86,48,48,3,zlib.crc32(compact))+palette;draw();receiving=bytes(u.mem_read(surface,110080));assert request(28,212,begin3)==(1,212)
 for at in range(0,1856,224):
  assert request(28,213+at//224,b'\1'+struct.pack('<HH',86,at)+compact[at:at+224])==(1,213+at//224)
  assert request(30,600,bytes([50,0,0,0])+struct.pack('<H',1000))==(1,600)
  assert request(30,601,bytes([255,0,0,0])+struct.pack('<H',1000))==(1,601)
  tick(33);draw();assert bytes(u.mem_read(surface,110080))==receiving,'Compact staging overwrote the live scene cache'
 assert request(28,230,b'\2'+struct.pack('<H',86))==(0,230);tick();draw();small=bytes(u.mem_read(surface,110080));assert q(14)==86 and q(19)==1 and q(20)==1
 for y in range(3,45):
  for x in range(3,45):
   if(x+16,y+14)!=(22,39):assert color(small,16+x,14+y)==colors[indices[y*48+x]]
 for y in range(142,148):assert color(small,18,y)==0xffff and color(small,301,y)==0x738e
 tick(33);draw();assert bytes(u.mem_read(surface,110080))==small
 original_surface=surface;surface+=2;u.mem_write(surface,small);put(object_at+0x658,surface);ctx['alignCheck']=True;draw();ctx['alignCheck']=False;assert bytes(u.mem_read(surface,110080))==small;surface=original_surface;put(object_at+0x658,surface);u.mem_write(surface,small)
 assert q(21)==30 and q(22)==0
 saved=dict(allocs);reads=ctx['reads'];assert request(29,240,bytes([30,1]))==(1,240);draw();assert bytes(u.mem_read(surface,110080))!=small
 for size in[20,40,30]:assert request(29,240+size,bytes([size,0]))==(1,240+size);draw();assert q(21)==size and q(22)==0
 assert request(29,290,bytes([28,0]))==(5,290) and request(29,291,bytes([30,2]))==(5,291);assert saved==allocs and reads==ctx['reads'];draw();assert bytes(u.mem_read(surface,110080))==small
 assert ctx['reads']==reads and saved==allocs and not ctx['unlinks']
 # Volume is temporary RAM state; test entry-at-zero, easing, retrigger, mute,
 # cancellation and exact scene restoration without font reads or allocation.
 assert q(23)==0x564f
 assert request(25,602,struct.pack('<IIBII',86000,222000,0,0,15000))==(1,602);tick(300);draw();clean=bytes(u.mem_read(surface,110080));saved=dict(allocs);reads=ctx['reads'];events=q(25)
 def volume(level,muted=0,scope=0,style=0,hold=1000):return request(30,603,bytes([level,muted,scope,style])+struct.pack('<H',hold))
 for args in[(101,0,0,0,1000),(50,2,0,0,1000),(50,0,2,0,1000),(50,0,0,2,1000),(50,0,0,0,399),(50,0,0,0,3001)]:assert volume(*args)==(5,603)
 assert q(25)==events and volume(40)==(1,603);tick(0);assert q(27)==0;tick(60);draw();assert 120<=q(27)<=135
 tick(65);draw();assert q(27)==256 and bytes(u.mem_read(surface,110080))[54*640:126*640]!=clean[54*640:126*640]
 if a.preview:
  values=struct.unpack('<55040H',bytes(u.mem_read(surface,110080)));im=Image.new('RGB',(320,172));im.putdata([(((v>>11)&31)*255//31,((v>>5)&63)*255//63,(v&31)*255//31)for v in values]);im.resize((960,516),Image.Resampling.NEAREST).save(a.preview.with_name(a.preview.stem+'-volume'+a.preview.suffix))
 assert volume(60)==(1,603) and q(27)==256 and q(24)==60;tick(100);draw();assert volume(60,1)==(1,603);tick(150);draw();assert q(24)==316
 tick(1000);draw();assert 0<q(27)<256;tick(40);draw();assert q(27)==0 and bytes(u.mem_read(surface,110080))==clean
 assert volume(35,style=1)==(1,603);tick(150);draw();bar=bytes(u.mem_read(surface,110080));assert bar[54*640:126*640]==clean[54*640:126*640] and bar[142*640:]!=clean[142*640:]
 assert volume(255)==(1,603);tick();draw();assert q(27)==0 and bytes(u.mem_read(surface,110080))==clean
 assert saved==allocs and reads==ctx['reads'] and not ctx['unlinks']
 put(0x20001c6c,1);before=bytes(u.mem_read(surface,110080));reads=ctx['reads'];ctx['now']+=100;call('rainy_hook_image');assert before==bytes(u.mem_read(surface,110080))and ctx['reads']==reads;finish()
 assert request(23,18,b'\0')==(1,18);u.mem_write(surface,bytes(rgb));draw();assert q(1)==0
 call('rainy_hook_native_key',4,0,0);draw();tick(20000);assert request(11,1)==(0xb1,4)
 key_scene=bytes(u.mem_read(surface+37*640,135*640));saved=dict(allocs);reads=ctx['reads']
 assert volume(45)==(1,603);tick(150);draw();assert bytes(u.mem_read(surface+37*640,135*640))==key_scene
 assert volume(45,scope=1)==(1,603);tick(150);draw();assert bytes(u.mem_read(surface+37*640,135*640))!=key_scene and request(11,1)==(0xb1,4)
 put(0x20001c6c,1);before=bytes(u.mem_read(surface,110080));ctx['now']+=60;call('rainy_hook_image');assert before==bytes(u.mem_read(surface,110080));finish()
 tick(1200);draw();assert bytes(u.mem_read(surface+37*640,135*640))==key_scene and request(11,1)==(0xb1,4)
 assert saved==allocs and reads==ctx['reads'] and not ctx['unlinks']
 removal=b'FNT!'+struct.pack('<II',struct.unpack_from('<I',data,36)[0],len(data));assert request(27,50,removal)==(2,50) and ctx['unlinks']==0
 assert request(2,19)==(2,19);tick();assert request(2,19)==(1,19);assert not allocs and not files
 bad=bytearray(removal);bad[4]^=1;assert request(27,51,bytes(bad))==(0,51);assert ctx['unlinks']==0;tick();assert q(9)==7 and q(10)==254 and ctx['unlinks']==0 and not allocs and not files
 assert request(27,53,removal)==(0,53);assert request(5,54)==(1,54);tick();assert q(9)==7 and q(10)==253 and ctx['unlinks']==0
 assert request(2,55)==(1,55)
 assert request(27,52,removal)==(0,52);assert q(9)==2 and ctx['unlinks']==0
 put(0x20001c6c,1);reads=ctx['reads'];call('rainy_hook_image');assert ctx['reads']==reads and ctx['unlinks']==0;finish();tick();assert q(9)==1 and q(10)==0 and ctx['unlinks']==1 and not allocs and not files
 report={'passed':True,'physicalHardwareAccessed':False,'sha256':manifest['sha256'],'checks':['read-only silicon queries','native shift symbol and retained key','R75F/2 initialization and independent 96-char title','cached title/next reuse and four-read GUI budget','allocation failure preserves live ownership','maximum three fields','DMA busy leaves pixels and file IO untouched','mode return and upload suspend release all allocations','simultaneous bit-exact 20px title and 40px caption','four OP26 templates allocate and read no glyphs; focus and 40px double-line rendering', 'long cue glyph-boundary pagination changes without new font reads','OP27 fixed FONT guard, no UART IO, close before unlink, DMA deferral','mismatched old header is preserved; resume cancels queued replacement','64px cover chunks, CRC rejection, no partial publish, DMA deferral, no file IO'],'limits':['Original callback bodies/FatFs/allocator/LCD/UART are modeled','Not physical input latency, scanout, recovery or full original startup verification']}
 report['heap']={'largestRequestBytes':ctx['maxRequest'],'peakModeledBytes':ctx['peakHeap']};report['checks']+=['scene cache reuses inactive cover memory; receive/draw interleaving preserves pixels','native 48px compact cover and raised six-pixel progress bar','halfword-aligned framebuffer has no unaligned word writes','20/30/40 typography and crisp/soft switching without new font reads or allocations']
 report['checks']+=['OP30 bounded volume, zero-time entry, continuous retrigger, mute and cancel','central and progress HUD restore exact scene without allocations or font IO','all-page volume restores last native key and defers DMA-busy writes','volume events interleaved with cover chunks preserve CRC and live scene']
 (folder/'model-validation.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8');print(json.dumps(report))
if __name__=='__main__':main()
