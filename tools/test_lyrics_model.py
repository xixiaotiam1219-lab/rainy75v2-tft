"""Execute the locally built ARM image with modeled FatFs/LCD/UART/allocator.
No HID, device writes, media requests, vendor input distribution or physical claims.
SPDX-License-Identifier: MIT
"""
import argparse,json,struct,hashlib
from pathlib import Path
from PIL import Image
from unicorn import Uc,UC_ARCH_ARM,UC_MODE_THUMB,UC_MODE_MCLASS,UC_HOOK_CODE,UC_HOOK_MEM_WRITE
from unicorn.arm_const import UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3,UC_ARM_REG_LR,UC_ARM_REG_PC,UC_ARM_REG_SP
from build import elf,require
from assets import ROOT,load,preview_frame,rgb565
from fontpack import Font20

def main():
 p=argparse.ArgumentParser();p.add_argument('--build',type=Path,default=ROOT/'build/ips-lyrics');p.add_argument('--preview',type=Path);a=p.parse_args();folder=a.build
 image=(folder/'rainy75v2-ips.bin').read_bytes();manifest=load(folder/'manifest.json');require(manifest.get('variant')=='lyrics-v1' and hashlib.sha256(image).hexdigest()==manifest['sha256'],'Wrong model build')
 _,_,_,symbols,_=elf((folder/'module.elf').read_bytes());data=(folder/'FONT.BIN').read_bytes();font=Font20(data)
 u=Uc(UC_ARCH_ARM,UC_MODE_THUMB|UC_MODE_MCLASS);u.mem_map(0x08000000,0x100000);u.mem_write(0x08004000,image);u.mem_map(0x20000000,0x60000);u.mem_map(0x1ffff000,0x1000);u.mem_map(0x40000000,0x40000)
 surface,object_at,stack,stop=0x20010000,0x20006000,0x2005e000,0x08001000
 allocs={};files={};ctx={'now':1000,'reads':0,'fail':False,'uart':[]}
 def put(at,v,n=4):u.mem_write(at,int(v).to_bytes(n,'little'))
 def get(at,n=4):return int.from_bytes(u.mem_read(at,n),'little')
 def ret(v=0):u.reg_write(UC_ARM_REG_R0,v);u.reg_write(UC_ARM_REG_PC,u.reg_read(UC_ARM_REG_LR))
 def code(cpu,at,size,_):
  r0,r1,r2,r3=[cpu.reg_read(r)for r in [UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3]]
  if at==0x0803a2ba:ret(ctx['now'])
  elif at==0x08025c08:
   if ctx['fail']:ret(0);return
   n=(r0+7)&~7;address=0x2003f000
   for old,used in sorted(allocs.items()):
    if address+n<=old:break
    address=max(address,old+used)
   assert address+n<=0x2005d000,'Model heap exhausted';allocs[address]=n;u.mem_write(address,b'\xa5'*n);ret(address)
  elif at==0x0802ab34:assert r0 in allocs,'Invalid/shared free';del allocs[r0];ret()
  elif at==0x0803c804:
   assert bytes(u.mem_read(r1,9))==b'FONT.BIN\0' and r2==1;assert not get(0x20001c6c);files[r0]=0;put(r0+12,len(data));ret()
  elif at==0x0803d098:assert r0 in files and not get(0x20001c6c);files[r0]=r1;ret()
  elif at==0x0803ccc8:
   assert r0 in files and not get(0x20001c6c);assert r2 in [52,256];chunk=data[files[r0]:files[r0]+r2];u.mem_write(r1,chunk);put(r3,len(chunk));files[r0]+=len(chunk);ctx['reads']+=1;ret()
  elif at==0x0803d074:assert r0 in files;del files[r0];ret()
  elif at==0x0805d6f2:put(0x20001c6c,1);ret()
  else:ret() # Original GUI/callback bodies are external to this unit model.
 for at in [0x0803a2ba,0x08025c08,0x0802ab34,0x0803c804,0x0803d098,0x0803ccc8,0x0803d074,0x0805d6f2,0x0807a600,0x0805ac72,0x0805ae0a,0x0805b244,0x0802dca8,0x0805b030]:u.hook_add(UC_HOOK_CODE,code,begin=at,end=at)
 def write(cpu,access,address,size,value,_):
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
 def q(f):status,value=request(22,f);assert status==0xc0+f;return value
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
 assert request(11,1)==(0xb1,0);assert request(11,14)==(0xbe,1024);assert request(11,15)==(0xbf,13)
 put(0x2003ede8,object_at);put(object_at+0x658,surface)
 for at,v in [(0x2003edba,320),(0x2003edbc,172),(0x2003edbe,0),(0x2003edc0,0)]:put(at,v,2)
 theme=load(ROOT/'profiles/themes.json')[manifest['theme']];base=preview_frame(theme,load(ROOT/'profiles/keys.json'))
 rgb=bytearray()
 for color in base.getdata():rgb+=struct.pack('<H',rgb565('#%02x%02x%02x'%color))
 u.mem_write(surface,bytes(rgb));call('rainy_hook_native_status',84,0,1);u.mem_write(0x20000100,bytes([0xbe,0x1a,8,13,0x8c,34,56,0xed]));call('rainy_hook_ips',0x20000100,8);draw()
 call('rainy_hook_native_key',46,0,0);draw();plain=bytes(u.mem_read(surface,110080));call('rainy_hook_native_key',46,0,1);draw();shifted=bytes(u.mem_read(surface,110080));assert plain!=shifted
 assert request(24,1)==(0xa6,0x4c59);tick();assert q(0)==1 and q(7)==96
 stage(10,'雨后的像素电台','把小小的屏幕点亮','文字跟着旋律慢慢滚动');assert request(23,11,b'\1')==(1,11);draw();assert q(1)==1
 if a.preview:
  values=struct.unpack('<55040H',bytes(u.mem_read(surface,110080)));im=Image.new('RGB',(320,172));im.putdata([(((v>>11)&31)*255//31,((v>>5)&63)*255//63,(v&31)*255//31)for v in values]);a.preview.parent.mkdir(parents=True,exist_ok=True);im.resize((960,516),Image.Resampling.NEAREST).save(a.preview)
 reads=ctx['reads'];stage(12,'雨后的像素电台','文字跟着旋律慢慢滚动','新句');assert ctx['reads']-reads==4
 long='标题超过十六个字仍需独立滚动且不被歌词换句打断';stage(13,long,'当前句','下一句');draw();initial=bytes(u.mem_read(surface+51*640,20*640))
 for _ in range(90):tick(33)
 assert bytes(u.mem_read(surface+51*640,20*640))!=initial;stage(14,long,'另一句','下一句');assert request(25,15,struct.pack('<IIBII',87000,222000,0,0,15000))==(1,15);draw();assert bytes(u.mem_read(surface+51*640,20*640))!=initial
 old=dict(allocs);ctx['fail']=True
 for k,text in enumerate([long,'另一句','下一句']):
  ids=[font.lookup.get(ord(c),font.fallback)for c in text];assert request(20,16,bytes([k,len(ids)])+struct.pack('<'+'H'*len(ids),*ids))==(1,16)
 assert request(21,16,struct.pack('<IIB',0,0,0))==(0,16);tick();assert q(3)==14 and q(2)!=0 and allocs==old;ctx['fail']=False
 stage(17,'甲乙丙丁'*24,'繁體簡體'*24,'日本語歌'*24);assert not q(2)
 put(0x20001c6c,1);before=bytes(u.mem_read(surface,110080));reads=ctx['reads'];ctx['now']+=100;call('rainy_hook_image');assert before==bytes(u.mem_read(surface,110080))and ctx['reads']==reads;finish()
 assert request(23,18,b'\0')==(1,18);u.mem_write(surface,bytes(rgb));draw();assert q(1)==0
 call('rainy_hook_native_key',4,0,0);draw();tick(20000);assert request(11,1)==(0xb1,4)
 assert request(2,19)==(2,19);tick();assert request(2,19)==(1,19);assert not allocs and not files
 report={'passed':True,'physicalHardwareAccessed':False,'sha256':manifest['sha256'],'checks':['read-only silicon queries','native shift symbol and retained key','R75F/2 initialization and independent 96-char title','cached title/next reuse and four-read GUI budget','allocation failure preserves live ownership','maximum three fields','DMA busy leaves pixels and file IO untouched','mode return and upload suspend release all allocations'],'limits':['Original callback bodies/FatFs/allocator/LCD/UART are modeled','Not physical input latency, scanout, recovery or full original startup verification']}
 (folder/'model-validation.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8');print(json.dumps(report))
if __name__=='__main__':main()
