"""Strict, local-input-only firmware patch builder. SPDX-License-Identifier: MIT."""
import argparse,hashlib,json,os,shutil,struct,subprocess
from pathlib import Path
from assets import generate,ROOT

IPS_SHA='32defab7902e57eb972a577fc6cbf3a7e57bc772d59b99f11038370412b77f41'
MAIN_SHA='bc575a6d7b19042048705248715a43a67a23c7f217ba0ac464c539a390f4d23b'
ISP_SHA='8ede32a24e09344e86ecd74731069e19d6befa287bd6de2dd7c757c6f1d06a9e'
def require(ok,message):
 if not ok:raise ValueError(message)
def digest(data):return hashlib.sha256(data).hexdigest()
def checked(path,expected):
 data=Path(path).read_bytes();require(digest(data)==expected,'Input SHA-256 does not match the supported revision');return data
def elf(own):
 require(own[:4]==b'\x7fELF' and own[4:6]==bytes([1,1]),'Expected little-endian ELF32')
 h=struct.unpack_from('<16sHHIIIIIHHHHHH',own);sections=[struct.unpack_from('<10I',own,h[6]+i*h[11]) for i in range(h[12])]
 strings=sections[h[13]];names=own[strings[4]:strings[4]+strings[5]]
 name=lambda s:names[s[0]:names.find(b'\0',s[0])].decode();symbols={}
 for s in sections:
  if s[1]!=2:continue
  st=sections[s[6]];ss=own[st[4]:st[4]+st[5]]
  for i in range(s[4],s[4]+s[5],s[9]):
   n,v,size,info,other,idx=struct.unpack_from('<IIIBBH',own,i)
   if n:symbols[ss[n:ss.find(b'\0',n)].decode()]=v
 segments=[struct.unpack_from('<8I',own,h[5]+i*h[9]) for i in range(h[10])]
 return h,sections,name,symbols,segments
def run(args):subprocess.run([str(a) for a in args],check=True)
def compiler(a):
 result=a.clang or shutil.which('clang');require(result,'Clang not found; pass --clang');return result
def thumb_bl(source,target):
 diff=(target&~1)-source-4;require(diff%2==0 and -(1<<24)<=diff<(1<<24),'BL out of range')
 v=diff&0x1ffffff;s=(v>>24)&1;i1=(v>>23)&1;i2=(v>>22)&1
 return struct.pack('<HH',0xf000|s<<10|(v>>12)&1023,0xd000|((~(i1^s))&1)<<13|((~(i2^s))&1)<<11|(v>>1)&2047)
def jal(source,target,rd=0):
 d=target-source;require(d%2==0 and -(1<<20)<=d<(1<<20),'JAL out of range');v=d&0x1fffff
 return struct.pack('<I',((v>>20)&1)<<31|((v>>1)&1023)<<21|((v>>11)&1)<<20|((v>>12)&255)<<12|rd<<7|0x6f)
def far_call(source,target):
 d=target-source;hi=(d+0x800)>>12;lo=d-hi*4096;require(-2048<=lo<=2047,'Invalid far call')
 return struct.pack('<II',((hi&0xfffff)<<12)|(1<<7)|0x17,((lo&0xfff)<<20)|(1<<15)|(1<<7)|0x67)
def isp_blob(lib,out,clang):
 archive=checked(lib,ISP_SHA);require(archive[:8]==b'!<arch>\n','Expected SDK ar archive');p=8;obj=None
 while p<len(archive):
  head=archive[p:p+60];n=int(head[48:58]);data=archive[p+60:p+60+n]
  if data[:4]==b'\x7fELF':obj=data;break
  p+=60+n+(n&1)
 require(obj is not None,'SDK object not found');_,ss,name,_,_=elf(obj)
 symsec=next(s for s in ss if s[1]==2);symbols=[struct.unpack_from('<IIIBBH',obj,i) for i in range(symsec[4],symsec[4]+symsec[5],symsec[9])]
 for s in ss:
  if name(s) in ['.data','.bss']:require(s[5]==0,'Unexpected SDK static RAM')
  if s[1]==4:
   for i in range(s[4],s[4]+s[5],s[9]):
    _,info,_=struct.unpack_from('<IIi',obj,i);kind=info&255;require(kind in [16,18,44,45,51],'Non-relative SDK relocation')
    if kind!=51:
     index=symbols[info>>8][5];require(0<index<len(ss) and name(ss[index]).startswith('.highcode'),'SDK relocation leaves copied code')
 for n,_,_,_,_,index in symbols:require(not(n and index==0),'Unresolved SDK symbol')
 linker=out/'isp.ld';linker.write_text('ENTRY(FLASH_EEPROM_CMD)\nSECTIONS { . = 0; .text : { *(.highcode*) } .data : { *(.data*) } .bss : { *(.bss*) } /DISCARD/ : { *(.comment*) *(.riscv.attributes*) } }\nASSERT(SIZEOF(.data)==0 && SIZEOF(.bss)==0,"Unexpected SDK RAM")\n',encoding='utf8')
 target=out/'isp.elf';run([clang,'--target=riscv32-none-elf','-march=rv32imac','-nostdlib','-fuse-ld=lld','-Wl,--no-relax','-Wl,-u,FLASH_EEPROM_CMD','-Wl,-T,'+str(linker),lib,'-o',target])
 image=target.read_bytes();h,ss,name,_,_=elf(image);sec=next(s for s in ss if name(s)=='.text');blob=image[sec[4]:sec[4]+sec[5]]
 require(len(blob)<=1280 and 0<=h[4]<len(blob),'SDK blob bounds failed')
 (out/'main-clock-isp-blob.h').write_text('#define ISP_BLOB_SIZE '+str(len(blob))+'u\n#define ISP_CMD_OFFSET '+str(h[4])+'u\nstatic const u8 isp_blob[]={'+','.join(map(str,blob))+'};\n',encoding='utf8')
 return {'sha256':digest(blob),'librarySha256':ISP_SHA,'bytes':len(blob),'entryOffset':h[4]}
def build(a):
 require(not a.lyrics or a.target=='ips' and not a.restore_stock,'--lyrics requires a normal IPS build')
 out=Path(a.out).resolve()/(a.target+'-restore' if a.restore_stock else 'ips-lyrics' if a.lyrics else a.target);out.mkdir(parents=True,exist_ok=True)
 original=checked(a.stock,IPS_SHA if a.target=='ips' else MAIN_SHA);base=0x08004000 if a.target=='ips' else 0x2000;image=bytearray(original);patches=[];meta={}
 if a.restore_stock:
  size=507904 if a.target=='ips' else 294912;image.extend(b'\xff'*(size-len(image)));(out/f'rainy75v2-{a.target}-restore.bin').write_bytes(image)
  manifest={'format':'rainy75v2-tft/build-v1','target':a.target,'status':'user-supplied factory restore; not a device readback','bytes':size,'sha256':digest(image),'stockSha256':digest(original),'applicationBase':0x4000 if a.target=='ips' else 0x2000,'iapPid':0x3078 if a.target=='ips' else 0x3079,'appPid':0x3075}
  (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf8');print(json.dumps(manifest));return
 clang=compiler(a)
 if a.target=='ips':
  generate(a.keys,a.theme,out/'assets',out);linker=ROOT/'firmware/ips/linker.ld';sources=[ROOT/'firmware/ips/native_ui.c',ROOT/'firmware/ips/rtc.c']
  flags=['--target=arm-none-eabi','-mcpu=cortex-m4','-mthumb','-mfloat-abi=soft'];low,high=0x0807ec90,0x08080000
  if a.lyrics:
   from fontpack import Font20
   from PIL import Image
   require(a.font,'--font is required with --lyrics');font=Path(a.font).read_bytes();pack=Font20(font)
   require(len(font)<=4194304,'Font exceeds the supported external storage capacity')
   (out/'FONT.BIN').write_bytes(font)
   for name in ['OFL-1.1.txt','FONT-NOTICE.txt']:
    notice=Path(a.font).parent/name;require(notice.is_file(),'Keep font license and notice beside FONT.BIN')
    if notice.resolve()!=(out/name).resolve():shutil.copy2(notice,out/name)
   count,index,offset,fallback,total,crc,hcrc=struct.unpack_from('<7I',font,16)
   (out/'lyrics_font_config.h').write_text(f'#define FONT_COUNT {count}u\n#define FONT_DATA_OFFSET {offset}u\n#define FONT_TOTAL_BYTES {total}u\n#define FONT_BODY_CRC {crc}u\n',encoding='utf8')
   from assets import load,rgb565
   theme=load(ROOT/'profiles/themes.json')[a.theme]
   with Image.open(out/'assets'/f'robot-{a.theme}.gif') as gif:
    for i in range(gif.n_frames):
     gif.seek(i);require(gif.tile and gif.tile[0][1]==(0,0,320,172),'Lyrics requires complete cache GIF frames')
     color=gif.convert('RGB').getpixel((22,39));require(rgb565('#%02x%02x%02x'%color)!=rgb565(theme['background']),'Cache frame marker equals player background')
   linker=ROOT/'firmware/ips-lyrics/linker.ld';sources=[ROOT/'firmware/ips-lyrics/native_ui.c',ROOT/'firmware/ips/rtc.c',ROOT/'firmware/ips-lyrics/lyrics.c'];low,high=0x08080000,0x08088000
   meta.update(variant='lyrics-v1',protocol='L6+LY1',requiredFlashKiB=1024,requiredSeries=13,codeStart=low,imageEnd=high,iapEraseEnd=0x080c0000,preservedSettings=[0x080fc000,0x080fe000,0x080ff800],fontSha256=digest(font),fontBodyCrc=crc,titleMaxGlyphs=96)
 else:
  require(a.isp_lib,'--isp-lib is required for main firmware');meta['isp']=isp_blob(Path(a.isp_lib).resolve(),out,clang)
  low=(0x2000+len(original)+15)&~15;high=0x49000;linker=out/'main.ld'
  linker.write_text(f'ENTRY(rainy_main_rtc_probe)\nPHDRS {{ probe PT_LOAD FLAGS(5); }}\nSECTIONS {{ . = 0x{low:x}; .text : {{ *(.text*) *(.rodata*) }} :probe .data : {{ *(.data*) }} .bss : {{ *(.bss*) *(COMMON) }} /DISCARD/ : {{ *(.eh_frame*) *(.comment*) *(.riscv.attributes*) }} }}\nASSERT(SIZEOF(.data)==0 && SIZEOF(.bss)==0,"Unexpected static RAM")\nASSERT(. <= 0x49000,"Code overlaps clock data")\n',encoding='utf8')
  sources=[ROOT/'firmware/main/clock_bridge.c'];flags=['--target=riscv32-none-elf','-march='+a.riscv_march,'-mabi=ilp32','-mno-relax','-msmall-data-limit=0','-Wl,--no-relax']
 target=out/'module.elf';run([clang,*flags,'-ffreestanding','-fno-builtin','-Oz','-Wall','-Wextra','-Werror','-nostdlib','-fuse-ld=lld','-I',out,'-Wl,-T,'+str(linker),*sources,'-o',target])
 own=target.read_bytes();_,_,_,symbols,segments=elf(own)
 for kind,off,va,pa,n,memsize,flags,align in segments:
  if kind!=1 or not n:continue
  require(low<=va and va+n<=high,'Appended code escapes reservation');start=va-base
  require(start>=len(original),'New code overlaps factory input')
  if len(image)<start+n:image.extend(b'\xff'*(start+n-len(image)))
  image[start:start+n]=own[off:off+n]
 def patch(at,old,new):
  require(image[at:at+len(old)]==old,'Original instruction mismatch');image[at:at+len(old)]=new;patches.append((at,len(old)))
 if a.target=='ips':
  for addr,old,symbol in [(0x0807ca16,0x0807a600,'start'),(0x0805b5b8,0x080596ac,'ips'),(0x0807a73e,0x0802dca8,'gui'),(0x0807a760,0x0805b244,'image'),(0x0807a764,0x0805b030,'misc'),(0x0805b282,0x0805d6f2,'cached_draw'),(0x0805b462,0x0805ac72,'native_key'),(0x0805b53a,0x0805ae0a,'native_status')]:patch(addr-base,thumb_bl(addr,old),thumb_bl(addr,symbols['rainy_hook_'+symbol]))
  if a.lyrics:
   require(len(image)+base<=high,'Lyrics image exceeds audited interval');image.extend(b'\xff'*(high-base-len(image)))
  else:image.extend(b'\xff'*((-len(image))%512))
  pid=0x3078;meta.update(theme=a.theme,uiVersion='0.6.3',moduleRam='0x2005f000..0x20060000');meta.setdefault('protocol','L6')
 else:
  for addr,old,symbol,rd in [(0x24680,0x20392,'rainy_main_rtc_probe',0),(0x134d8,0x120b8,'rainy_main_rtc_init',1)]:patch(addr-base,jal(addr,old,rd),jal(addr,symbols[symbol],rd))
  for addr,following,symbol in [(0x2000a874,0x2000752a,'rainy_clock_worker_a'),(0x2000b49a,0x200091fa,'rainy_clock_worker_b')]:patch(addr-0x20000000+4,jal(addr,0x20007000,1)+jal(addr+4,following,1),far_call(addr,symbols[symbol]))
  require(len(image)+base<=0x49000,'Code reaches data page');image.extend(b'\xff'*(0x4a000-base-len(image)));pid=0x3079;meta.update(protocol='V7.1',capability='0x4350',clockDataPage='0x49000..0x49fff')
 allowed={i for start,n in patches for i in range(start,start+n)}
 require(image[:512]==original[:512] and all(x==y or i in allowed for i,(x,y) in enumerate(zip(original,image))),'Unexpected factory modifications')
 binfile=out/f'rainy75v2-{a.target}.bin';binfile.write_bytes(image)
 manifest={'format':'rainy75v2-tft/build-v1','target':a.target,'status':'experimental; hardware validation incomplete','bytes':len(image),'sha256':digest(image),'stockSha256':digest(original),'applicationBase':0x4000 if a.target=='ips' else 0x2000,'iapPid':pid,'appPid':0x3075,'patches':[{'fileOffset':p,'bytes':n} for p,n in patches],**meta}
 (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf8');print(json.dumps(manifest))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('target',choices=['ips','main']);p.add_argument('--stock',type=Path,required=True);p.add_argument('--isp-lib',type=Path);p.add_argument('--restore-stock',action='store_true');p.add_argument('--clang');p.add_argument('--riscv-march',default='rv32imac_zicsr_zifencei');p.add_argument('--out',type=Path,default=ROOT/'build');p.add_argument('--keys',type=Path,default=ROOT/'profiles/keys.json');p.add_argument('--theme',default='pink');p.add_argument('--lyrics',action='store_true');p.add_argument('--font',type=Path);build(p.parse_args())
