"""Strict, local-input-only firmware patch builder. SPDX-License-Identifier: MIT."""
import argparse,hashlib,json,os,shutil,struct,subprocess,zlib
from pathlib import Path
from assets import generate,ROOT,validate_cache_gif,resolve_theme,theme_slot_bytes,THEME_SLOT_FIELDS,THEME_SLOT_MAGIC,THEME_SLOT_SIZE,THEME_SLOT_VERSION
from main_profiles import MAIN_PROFILES

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
def far_tail(source,target):
 hi=(target-source+0x800)>>12;lo=target-source-hi*4096
 require(-2048<=lo<=2047,'Invalid far jump')
 return struct.pack('<II',((hi&0xfffff)<<12)|(5<<7)|0x17,((lo&0xfff)<<20)|(5<<15)|0x67)
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
def locate_theme_slot(target_elf,own,clang,low,high,base,image,theme_colors):
 _,sections,name,symbols,_=elf(own)
 limit=high-low
 text_sec=next((s for s in sections if name(s)=='.text'),None)
 data_sec=next((s for s in sections if name(s)=='.data'),None)
 bss_sec=next((s for s in sections if name(s)=='.bss'),None)
 rom_bytes=sum(s[5]for s in sections if (s[2]&2)and s[1]!=8)
 require(text_sec is not None and text_sec[5]<=limit and rom_bytes<=limit,f'IPS appended sections exceed {limit} bytes ({rom_bytes})')
 require((data_sec[5]if data_sec else 0)==0,'Unexpected IPS writable .data')
 require((bss_sec[5]if bss_sec else 0)<=4096,'IPS .bss exceeds 4096-byte state reservation')
 require('r75_theme' in symbols,'Missing r75_theme symbol in ELF')
 sym_va=symbols['r75_theme']
 require(low<=sym_va and sym_va+THEME_SLOT_SIZE<=high,'r75_theme symbol outside code reservation')
 nm=Path(clang).with_name('llvm-nm'+Path(clang).suffix)
 if nm.is_file():
  nm_out=subprocess.check_output([str(nm),str(target_elf)],text=True)
  nm_syms={}
  for line in nm_out.splitlines():
   parts=line.split()
   if len(parts)>=3 and parts[0]!='U':nm_syms[parts[-1]]=int(parts[0],16)
  require(nm_syms.get('r75_theme')==sym_va,'llvm-nm r75_theme mismatch')
 slot_bytes,_,slot_crc=theme_slot_bytes(theme_colors)
 region_start=low-base
 region_end=min(len(image),high-base)
 region=bytes(image[region_start:region_end])
 matches=[]
 pos=0
 while True:
  idx=region.find(slot_bytes,pos)
  if idx<0:break
  matches.append(region_start+idx);pos=idx+1
 require(len(matches)==1,f'Expected unique R75T slot in appended payload, found {len(matches)}')
 file_offset=matches[0]
 require(file_offset==sym_va-base,'R75T fileOffset does not match r75_theme symbol VA')
 return {'format':'r75t/v1','magic':'R75T','version':THEME_SLOT_VERSION,'fileOffset':file_offset,'bytes':THEME_SLOT_SIZE,'codeStart':low,'imageEnd':high,'applicationBase':base-0x08000000,'fields':list(THEME_SLOT_FIELDS),'crc32':slot_crc}
def patch_theme_slot(bin_bytes,manifest,theme_input):
 data=bytearray(bin_bytes)
 require(isinstance(manifest,dict),'Manifest must be an object')
 require(manifest.get('format')=='rainy75v2-tft/build-v1','Unsupported manifest format')
 require(manifest.get('target')=='ips','Only IPS images carry a theme slot')
 require(manifest.get('applicationBase')==0x4000,'Unexpected IPS applicationBase')
 require(len(data)==manifest.get('bytes'),'Firmware length does not match manifest')
 require(digest(bytes(data))==manifest.get('sha256'),'Firmware SHA-256 does not match manifest')
 slot=manifest.get('themeSlot')
 require(isinstance(slot,dict),'Manifest missing themeSlot')
 require(slot.get('format')=='r75t/v1' and slot.get('magic')=='R75T','Unsupported themeSlot format/magic')
 require(slot.get('version')==THEME_SLOT_VERSION and slot.get('bytes')==THEME_SLOT_SIZE,'Unsupported themeSlot version/size')
 require(slot.get('applicationBase')==0x4000,'Unexpected themeSlot applicationBase')
 require(tuple(slot.get('fields')or ())==THEME_SLOT_FIELDS,'Unexpected themeSlot fields')
 code_start=slot.get('codeStart');image_end=slot.get('imageEnd');file_offset=slot.get('fileOffset')
 require(isinstance(code_start,int)and isinstance(image_end,int)and isinstance(file_offset,int),'Invalid themeSlot offsets')
 if 'codeStart' in manifest:require(manifest['codeStart']==code_start,'Manifest codeStart mismatch')
 if 'imageEnd' in manifest:require(manifest['imageEnd']==image_end,'Manifest imageEnd mismatch')
 min_off=code_start-0x08004000;max_off=image_end-0x08004000
 require(min_off>=0 and file_offset>=min_off and file_offset+THEME_SLOT_SIZE<=max_off and file_offset+THEME_SLOT_SIZE<=len(data),'themeSlot offset out of bounds')
 existing=bytes(data[file_offset:file_offset+THEME_SLOT_SIZE])
 magic,ver,sz=struct.unpack_from('<IHH',existing,0)
 existing_crc,=struct.unpack_from('<I',existing,24)
 calc_crc=zlib.crc32(existing[:24])&0xffffffff
 require(magic==THEME_SLOT_MAGIC and ver==THEME_SLOT_VERSION and sz==THEME_SLOT_SIZE,'Invalid R75T slot header in binary')
 require(existing_crc==calc_crc and existing_crc==slot.get('crc32'),'R75T slot CRC-32 mismatch')
 theme_label,colors=resolve_theme(theme_input)
 new_slot,_,new_crc=theme_slot_bytes(colors)
 data[file_offset:file_offset+THEME_SLOT_SIZE]=new_slot
 patched=bytes(data)
 updated_manifest=json.loads(json.dumps(manifest))
 updated_manifest['sha256']=digest(patched)
 updated_manifest['theme']=theme_label
 updated_manifest['themeColors']=colors
 updated_manifest['themeSlot']['crc32']=new_crc
 return patched,updated_manifest
def build(a):
 theme_opt=getattr(a,'theme',None);theme_file=getattr(a,'theme_file',None)
 require(theme_opt is None or theme_file is None,'Pass either --theme or --theme-file, not both')
 if theme_file is not None:require(Path(theme_file).is_file(),f'Theme file not found: {theme_file}')
 theme_arg=Path(theme_file)if theme_file is not None else (theme_opt or 'pink')
 require(not a.lyrics or a.target=='ips' and not a.restore_stock,'--lyrics requires a normal IPS build')
 out=Path(a.out).resolve()/(a.target+'-restore' if a.restore_stock else 'ips-lyrics' if a.lyrics else a.target);out.mkdir(parents=True,exist_ok=True)
 if a.target=='ips':original=checked(a.stock,IPS_SHA);profile=None
 else:
  original=Path(a.stock).read_bytes();profile=MAIN_PROFILES.get(digest(original));require(profile is not None,'Main SHA-256 is not a supported revision');require(len(original)==profile['bytes'],'Main factory length mismatch')
 base=0x08004000 if a.target=='ips' else 0x2000;image=bytearray(original);patches=[];meta={}
 if a.restore_stock:
  size=507904 if a.target=='ips' else 294912;image.extend(b'\xff'*(size-len(image)));(out/f'rainy75v2-{a.target}-restore.bin').write_bytes(image)
  manifest={'format':'rainy75v2-tft/build-v1','target':a.target,'status':'user-supplied factory restore; not a device readback','bytes':size,'sha256':digest(image),'stockSha256':digest(original),'applicationBase':0x4000 if a.target=='ips' else 0x2000,'iapPid':0x3078 if a.target=='ips' else 0x3079,'appPid':0x3075}
  (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf8');print(json.dumps(manifest));return
 clang=compiler(a)
 if a.target=='ips':
  theme_label,theme_colors=resolve_theme(theme_arg)
  gif_path=generate(a.keys,theme_arg,out/'assets',out);linker=ROOT/'firmware/ips/linker.ld';sources=[ROOT/'firmware/ips/native_ui.c',ROOT/'firmware/ips/rtc.c']
  flags=['--target=arm-none-eabi','-mcpu=cortex-m4','-mthumb','-mfloat-abi=soft'];low,high=0x0807ec90,0x08080000
  if a.lyrics:
   from fontpack import Font20
   require(a.font,'--font is required with --lyrics');font=Path(a.font).read_bytes();pack=Font20(font)
   require(len(font)<=4194304,'Font exceeds the supported external storage capacity')
   (out/'FONT.BIN').write_bytes(font)
   for name in ['OFL-1.1.txt','FONT-NOTICE.txt']:
    notice=Path(a.font).parent/name;require(notice.is_file(),'Keep font license and notice beside FONT.BIN')
    if notice.resolve()!=(out/name).resolve():shutil.copy2(notice,out/name)
   count,index,offset,fallback,total,crc,hcrc=struct.unpack_from('<7I',font,16)
   (out/'lyrics_font_config.h').write_text(f'#define FONT_COUNT {count}u\n#define FONT_DATA_OFFSET {offset}u\n#define FONT_TOTAL_BYTES {total}u\n#define FONT_BODY_CRC {crc}u\n',encoding='utf8')
   validate_cache_gif(gif_path,theme_colors)
   linker=ROOT/'firmware/ips-lyrics/linker.ld';sources=[ROOT/'firmware/ips-lyrics/native_ui.c',ROOT/'firmware/ips/rtc.c',ROOT/'firmware/ips-lyrics/lyrics.c'];low,high=0x08080000,0x08088000
   meta.update(variant='lyrics-v1',protocol='L6+LY1',requiredFlashKiB=1024,requiredSeries=13,codeStart=low,imageEnd=high,iapEraseEnd=0x080c0000,preservedSettings=[0x080fc000,0x080fe000,0x080ff800],fontSha256=digest(font),fontBodyCrc=crc,titleMaxGlyphs=96,renderSizes=[20,30,40],defaultLayout=1,layouts=['classic20','caption40','focus40','double40','immersive48'],fontReplacementProtocol='fixed-font-v1',temporaryCoverProtocol='RAM48-v3',volumeProtocol='OP30-v1')
 else:
  fields=[('MAIN_IPS_HANDLER','ipsHandler'),('MAIN_RTC_INIT','rtcInit'),('MAIN_RX_BUFFER','rx'),('MAIN_WORKER_A_NEXT','nextA'),('MAIN_WORKER_B_NEXT','nextB')]
  journal=profile.get('journalStart')
  extra=''
  if journal is None:
   require(a.isp_lib,'--isp-lib is required for older main firmware');meta['isp']=isp_blob(Path(a.isp_lib).resolve(),out,clang)
  else:
   fields += [('MAIN_ISP_PROGRAM','ispProgram'),('MAIN_JOURNAL_START','journalStart'),('MAIN_IMAGE_LIMIT','imageLimit'),('MAIN_ACK_OFFSET','ackOffset'),('MAIN_SCREEN_ENABLED_OFFSET','screenEnabledOffset'),('MAIN_RX_LENGTH_OFFSET','rxLengthOffset')]
   extra=f'#define MAIN_COLLECTOR_BODY {profile["collector"]+8:#x}\n'
  (out/'main_addresses.h').write_text('/* SPDX-License-Identifier: MIT; exact hash-selected profile. */\n'+extra+''.join(f'#define {name} ({profile[key]:#x})\n' if profile[key]<0 else f'#define {name} {profile[key]:#x}\n' for name,key in fields),encoding='utf8')
  low=(0x2000+len(original)+15)&~15;high=journal or 0x49000;linker=out/'main.ld'
  require(low<high<=0x4a000 and profile.get('imageLimit',0x4a000)==0x4a000,'Main program/app bounds mismatch')
  linker.write_text(f'ENTRY(rainy_main_rtc_probe)\nPHDRS {{ probe PT_LOAD FLAGS(5); }}\nSECTIONS {{ . = 0x{low:x}; .text : {{ *(.text*) *(.rodata*) }} :probe .data : {{ *(.data*) }} .bss : {{ *(.bss*) *(COMMON) }} /DISCARD/ : {{ *(.eh_frame*) *(.comment*) *(.riscv.attributes*) }} }}\nASSERT(SIZEOF(.data)==0 && SIZEOF(.bss)==0,"Unexpected static RAM")\nASSERT(. <= 0x{high:x},"Code overlaps clock data")\n',encoding='utf8')
  sources=[ROOT/'firmware/main'/('clock_bridge_071.c' if journal else 'clock_bridge.c')];flags=['--target=riscv32-none-elf','-march='+a.riscv_march,'-mabi=ilp32','-mno-relax','-msmall-data-limit=0','-Wl,--no-relax']
  if journal:flags.append('-fno-jump-tables')
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
  theme_slot=locate_theme_slot(target,own,clang,low,high,base,image,theme_colors)
  pid=0x3078;meta.update(codeStart=low,imageEnd=high,theme=theme_label,themeColors=theme_colors,themeSlot=theme_slot,uiVersion='0.6.3',moduleRam='0x2005f000..0x20060000');meta.setdefault('protocol','L6')
 else:
  for addr,old,symbol,rd in [(profile['ipsHook'],profile['ipsHandler'],'rainy_main_rtc_probe',0),(profile['rtcHook'],profile['rtcInit'],'rainy_main_rtc_init',1)]:patch(addr-base,jal(addr,old,rd),jal(addr,symbols[symbol],rd))
  if journal:
   addr=profile['collector'];patch(addr-0x20000000+4,bytes.fromhex(profile['collectorEntry']),far_tail(addr,symbols['rainy_clock_collector']))
  else:
   for addr,following,symbol in [(profile['workerA'],profile['nextA'],'rainy_clock_worker_a'),(profile['workerB'],profile['nextB'],'rainy_clock_worker_b')]:patch(addr-0x20000000+4,jal(addr,profile['collector'],1)+jal(addr+4,following,1),far_call(addr,symbols[symbol]))
  require(len(image)+base<=high,'Code reaches clock data');image.extend(b'\xff'*(0x4a000-base-len(image)));pid=0x3079
  meta.update(protocol='V7.2' if journal else 'V7.1',capability='0x4350',stockVersion=profile['stockVersion'],mainProfile=profile)
  if journal:meta.update(codeStart=low,clockJournal={'start':journal,'endExclusive':0x4a000,'recordBytes':16,'slots':(0x4a000-journal)//16},clockRateUnit='millihertz')
  else:meta['clockDataPage']='0x49000..0x49fff'
 allowed={i for start,n in patches for i in range(start,start+n)}
 require(image[:512]==original[:512] and all(x==y or i in allowed for i,(x,y) in enumerate(zip(original,image))),'Unexpected factory modifications')
 binfile=out/f'rainy75v2-{a.target}.bin';binfile.write_bytes(image)
 manifest={'format':'rainy75v2-tft/build-v1','target':a.target,'status':'experimental; hardware validation incomplete','bytes':len(image),'sha256':digest(image),'stockSha256':digest(original),'applicationBase':0x4000 if a.target=='ips' else 0x2000,'iapPid':pid,'appPid':0x3075,'patches':[{'fileOffset':p,'bytes':n} for p,n in patches],**meta}
 (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf8');print(json.dumps(manifest))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('target',choices=['ips','main']);p.add_argument('--stock',type=Path,required=True);p.add_argument('--isp-lib',type=Path);p.add_argument('--restore-stock',action='store_true');p.add_argument('--clang');p.add_argument('--riscv-march',default='rv32imac_zicsr_zifencei');p.add_argument('--out',type=Path,default=ROOT/'build');p.add_argument('--keys',type=Path,default=ROOT/'profiles/keys.json');p.add_argument('--theme');p.add_argument('--theme-file',type=Path);p.add_argument('--lyrics',action='store_true');p.add_argument('--font',type=Path);build(p.parse_args())
