# SPDX-License-Identifier: MIT
import importlib.util,json,os,shutil,struct,subprocess,sys,tempfile,unittest,zlib
from pathlib import Path
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import assets
import build as fw_build
from fontpack import Font20

CUSTOM_THEME={
 'name':'Ocean Cobalt',
 'background':'#102030',
 'panel':'#182c40',
 'shell':'#284c70',
 'ink':'#f2f6fa',
 'accent':'#48b8e8',
 'muted':'#78a0c0',
 'lyricsBorder':'#386898',
 'lyricsPanel':'#142436',
}

def find_clang():
 return os.environ.get('CLANG')or shutil.which('clang')

def has_unicorn():
 return importlib.util.find_spec('unicorn')is not None

def run_arm_render(bin_bytes,elf_bytes,theme_colors,font_bytes=None):
 from unicorn import Uc,UC_ARCH_ARM,UC_MODE_THUMB,UC_MODE_MCLASS,UC_HOOK_CODE
 from unicorn.arm_const import UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3,UC_ARM_REG_LR,UC_ARM_REG_PC,UC_ARM_REG_SP
 _,_,_,symbols,_=fw_build.elf(elf_bytes)
 u=Uc(UC_ARCH_ARM,UC_MODE_THUMB|UC_MODE_MCLASS)
 u.mem_map(0x08000000,0x100000);u.mem_write(0x08004000,bin_bytes)
 u.mem_map(0x20000000,0x60000);u.mem_map(0x1ffff000,0x1000);u.mem_map(0x40000000,0x40000)
 surface,object_at,stack,stop=0x20010000,0x20006000,0x2005e000,0x08001000
 allocs={};files={};ctx={'now':1000}
 def put(at,v,n=4):u.mem_write(at,int(v).to_bytes(n,'little'))
 def get(at,n=4):return int.from_bytes(u.mem_read(at,n),'little')
 def ret(v=0):u.reg_write(UC_ARM_REG_R0,v);u.reg_write(UC_ARM_REG_PC,u.reg_read(UC_ARM_REG_LR))
 def code(cpu,at,size,_):
  r0,r1,r2,r3=[cpu.reg_read(r)for r in [UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3]]
  if at==0x0803a2ba:ret(ctx['now'])
  elif at==0x08025c08:
   n=(r0+7)&~7;address=0x2003f000
   for old,used in sorted(allocs.items()):
    if address+n<=old:break
    address=max(address,old+used)
   allocs[address]=n;u.mem_write(address,b'\xa5'*n);ret(address)
  elif at==0x0802ab34:del allocs[r0];ret()
  elif at==0x0803c804:files[r0]=0;put(r0+12,len(font_bytes));ret()
  elif at==0x0803d098:files[r0]=r1;ret()
  elif at==0x0803ccc8:chunk=font_bytes[files[r0]:files[r0]+r2];u.mem_write(r1,chunk);put(r3,len(chunk));files[r0]+=len(chunk);ret()
  elif at==0x0803d074:del files[r0];ret()
  elif at==0x0805d6f2:put(0x20001c6c,1);ret()
  else:ret()
 for at in [0x0803a2ba,0x08025c08,0x0802ab34,0x0803c804,0x0803d098,0x0803ccc8,0x0803d074,0x0805d6f2,0x0807a600,0x0805ac72,0x0805ae0a,0x0805b244,0x0802dca8,0x0805b030]:
  u.hook_add(UC_HOOK_CODE,code,begin=at,end=at)
 def call(name,*args):
  for i,r in enumerate([UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3]):u.reg_write(r,args[i]if i<len(args)else 0)
  for i,v in enumerate(args[4:]):put(stack+i*4,v)
  u.reg_write(UC_ARM_REG_SP,stack);u.reg_write(UC_ARM_REG_LR,stop|1)
  u.emu_start(symbols[name]|1,stop,count=5000000);assert u.reg_read(UC_ARM_REG_PC)&~1==stop,name;return u.reg_read(UC_ARM_REG_R0)
 def finish():put(0x20001c6c,0)
 def draw():finish();call('rainy_hook_cached_draw',0,0,320,172,surface);finish()
 put(0x40004c00,0x40);put(0x1ffff7e0,1024,2);put(0x1ffff7f3,13,1);call('rainy_hook_start')
 put(0x2003ede8,object_at);put(object_at+0x658,surface)
 for at,v in [(0x2003edba,320),(0x2003edbc,172),(0x2003edbe,0),(0x2003edc0,0)]:put(at,v,2)
 base_img=assets.preview_frame(theme_colors,assets.load(ROOT/'profiles/keys.json'))
 rgb=b''.join(struct.pack('<H',assets.rgb565('#%02x%02x%02x'%c))for c in base_img.getdata())
 u.mem_write(surface,rgb)
 call('rainy_hook_native_status',84,0,1)
 u.mem_write(0x20000100,bytes([0xbe,0x1a,8,13,0x8c,34,56,0xed]));call('rainy_hook_ips',0x20000100,8)
 call('rainy_hook_native_key',4,0,0)
 draw()
 native_buf=bytes(u.mem_read(surface,110080))
 assert native_buf!=rgb,'Cached draw did not update surface'
 frames={'native':native_buf}
 if font_bytes is not None:
  font=Font20(font_bytes)
  def packet(op,seq=0,payload=b''):
   b=bytearray([0xbe,0x1a,11+len(payload),13,op,seq&255,seq>>8,0])+payload
   return bytes(b)+struct.pack('<H',sum(b[3:])&65535)+b'\xed'
  def req(op,seq=0,payload=b''):
   b=packet(op,seq,payload);u.mem_write(0x20000100,b);call('rainy_hook_ips',0x20000100,len(b))
  req(24,1);ctx['now']+=2;call('rainy_hook_image');finish()
  for k,text in enumerate(['晚风与星光','星光正好','下一句也有好心情']):
   ids=[font.lookup.get(ord(c),font.fallback)for c in text]
   req(20,10,bytes([k,len(ids)])+struct.pack('<'+'H'*len(ids),*ids))
  req(21,10,struct.pack('<IIBII',86000,222000,1,2000,15000))
  for _ in range(200):ctx['now']+=2;call('rainy_hook_image');finish()
  req(23,11,b'\1')
  for layout in [0,1,2,3]:
   req(26,20+layout,bytes([layout]));ctx['now']+=40;call('rainy_hook_image');finish();draw()
   frames[f'layout{layout}']=bytes(u.mem_read(surface,110080))
 return frames

class ThemeBuildTests(unittest.TestCase):
 def test_normalize_theme_presets_custom_and_validation(self):
  pink=assets.normalize_theme('pink')
  self.assertEqual(assets.rgb565(pink['background']),65438)
  self.assertEqual(assets.rgb565(pink['panel']),65501)
  self.assertEqual(assets.rgb565(pink['shell']),63002)
  self.assertEqual(assets.rgb565(pink['ink']),41647)
  self.assertEqual(assets.rgb565(pink['accent']),54389)
  self.assertEqual(assets.rgb565(pink['muted']),54389)
  self.assertEqual(assets.rgb565(pink['lyricsBorder']),58874)
  self.assertEqual(assets.rgb565(pink['lyricsPanel']),65503)
  mint=assets.normalize_theme('mint')
  self.assertEqual(mint['muted'],mint['accent'])
  self.assertEqual(mint['lyricsBorder'],mint['shell'])
  self.assertEqual(mint['lyricsPanel'],mint['panel'])
  mono=assets.normalize_theme('mono')
  self.assertEqual(mono['muted'],mono['accent'])
  self.assertEqual(mono['lyricsBorder'],mono['shell'])
  self.assertEqual(mono['lyricsPanel'],mono['panel'])
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'ocean.json'
   minimal={k:CUSTOM_THEME[k]for k in ['background','panel','shell','ink','accent']}
   p.write_text(json.dumps(minimal),encoding='utf8')
   loaded=assets.normalize_theme(p)
   self.assertEqual(loaded['muted'],loaded['accent'])
   self.assertEqual(loaded['lyricsBorder'],loaded['shell'])
   self.assertEqual(loaded['lyricsPanel'],loaded['panel'])
   self.assertEqual(assets.normalize_theme(str(p)),loaded)
  for bad in ['missing-preset',{'background':'102030','panel':'#182c40','shell':'#284c70','ink':'#f2f6fa','accent':'#48b8e8'},{'background':'#102030','panel':'#182c40','shell':'#284c70','ink':'#f2f6fa','accent':'#48b8e8','muted':'#xyz123'}]:
   with self.assertRaises(ValueError):assets.normalize_theme(bad)

 def test_generate_custom_theme_json_gif_and_cli(self):
  with tempfile.TemporaryDirectory() as d:
   d=Path(d);theme_file=d/'ocean.json'
   theme_file.write_text(json.dumps(CUSTOM_THEME),encoding='utf8')
   out_dir=d/'out';hdr_dir=d/'hdr'
   gif=assets.generate(ROOT/'profiles/keys.json',theme_file,out_dir,hdr_dir)
   self.assertEqual(gif.name,'robot-ocean.gif')
   assets.validate_cache_gif(gif,CUSTOM_THEME)
   with Image.open(gif) as im:
    self.assertEqual(im.size,(320,172));self.assertEqual(im.n_frames,8)
    for i in range(im.n_frames):
     im.seek(i);self.assertEqual(im.disposal_method,1);self.assertEqual(im.tile[0][1],(0,0,320,172))
   self.assertTrue((out_dir/'preview-ocean.png').is_file())
   cli_out=d/'cli-out';cli_hdr=d/'cli-hdr'
   subprocess.run([sys.executable,str(ROOT/'tools/assets.py'),'--theme-file',str(theme_file),'--out',str(cli_out),'--headers',str(cli_hdr)],check=True)
   self.assertTrue((cli_out/'robot-ocean.gif').is_file())
   self.assertTrue((cli_out/'preview-ocean.png').is_file())
   bad=subprocess.run([sys.executable,str(ROOT/'tools/assets.py'),'--theme','pink','--theme-file',str(theme_file)],capture_output=True)
   self.assertNotEqual(bad.returncode,0)

 def test_patch_theme_slot_synthetic_error_checks(self):
  slot_bytes,_,crc=assets.theme_slot_bytes('pink')
  image=bytearray(507904)
  code_start=0x0807ec90;image_end=0x08080000;base=0x08004000
  offset=code_start-base+32
  image[offset:offset+28]=slot_bytes
  raw=bytes(image)
  manifest={
   'format':'rainy75v2-tft/build-v1',
   'target':'ips',
   'bytes':len(raw),
   'sha256':fw_build.digest(raw),
   'applicationBase':16384,
   'codeStart':code_start,
   'imageEnd':image_end,
   'theme':'pink',
   'themeColors':assets.normalize_theme('pink'),
   'themeSlot':{
    'format':'r75t/v1','magic':'R75T','version':1,'fileOffset':offset,'bytes':28,
    'codeStart':code_start,'imageEnd':image_end,'applicationBase':16384,
    'fields':list(assets.THEME_SLOT_FIELDS),'crc32':crc,
   },
  }
  patched,new_manifest=fw_build.patch_theme_slot(raw,manifest,CUSTOM_THEME)
  self.assertEqual(len(patched),len(raw))
  self.assertEqual(new_manifest['theme'],'custom')
  self.assertEqual(new_manifest['sha256'],fw_build.digest(patched))
  exp_bytes,_,exp_crc=assets.theme_slot_bytes(CUSTOM_THEME)
  self.assertEqual(patched[offset:offset+28],exp_bytes)
  self.assertEqual(new_manifest['themeSlot']['crc32'],exp_crc)

  bad_sha={**manifest,'sha256':'0'*64}
  with self.assertRaises(ValueError):fw_build.patch_theme_slot(raw,bad_sha,CUSTOM_THEME)
  bad_magic=json.loads(json.dumps(manifest));bad_magic['themeSlot']['magic']='XXXX'
  with self.assertRaises(ValueError):fw_build.patch_theme_slot(raw,bad_magic,CUSTOM_THEME)
  bad_crc=json.loads(json.dumps(manifest));bad_crc['themeSlot']['crc32']^=1
  with self.assertRaises(ValueError):fw_build.patch_theme_slot(raw,bad_crc,CUSTOM_THEME)
  bad_bin=bytearray(raw);bad_bin[offset+24]^=1
  rehashed={**manifest,'sha256':fw_build.digest(bytes(bad_bin))}
  with self.assertRaises(ValueError):fw_build.patch_theme_slot(bytes(bad_bin),rehashed,CUSTOM_THEME)
  bad_off=json.loads(json.dumps(manifest));bad_off['themeSlot']['fileOffset']=code_start-base-4
  with self.assertRaises(ValueError):fw_build.patch_theme_slot(raw,bad_off,CUSTOM_THEME)

 @unittest.skipUnless((ROOT/'inputs/ips-stock.bin').is_file() and (ROOT/'build/font/FONT.BIN').is_file() and find_clang() is not None and has_unicorn(),'Requires local stock IPS, FONT.BIN, clang, and unicorn')
 def test_real_builds_slot_bounds_patching_and_unicorn_equivalence(self):
  clang=find_clang()
  stock=ROOT/'inputs/ips-stock.bin'
  font_path=ROOT/'build/font/FONT.BIN'
  font_bytes=font_path.read_bytes()
  with tempfile.TemporaryDirectory() as d:
   d=Path(d);theme_file=d/'ocean.json';theme_file.write_text(json.dumps(CUSTOM_THEME),encoding='utf8')
   pink_out=d/'pink';custom_out=d/'custom'
   for args in [
    ['ips','--stock',str(stock),'--theme','pink','--out',str(pink_out),'--clang',clang],
    ['ips','--stock',str(stock),'--theme-file',str(theme_file),'--out',str(custom_out),'--clang',clang],
    ['ips','--stock',str(stock),'--lyrics','--font',str(font_path),'--theme','pink','--out',str(pink_out),'--clang',clang],
    ['ips','--stock',str(stock),'--lyrics','--font',str(font_path),'--theme-file',str(theme_file),'--out',str(custom_out),'--clang',clang],
   ]:
    subprocess.run([sys.executable,str(ROOT/'tools/build.py'),*args],check=True)

   for sub,limit in [('ips',4976),('ips-lyrics',32768)]:
    for root_dir,expected_label in [(pink_out,'pink'),(custom_out,'custom')]:
     folder=root_dir/sub
     manifest=json.loads((folder/'manifest.json').read_text(encoding='utf8'))
     bin_bytes=(folder/'rainy75v2-ips.bin').read_bytes()
     own=(folder/'module.elf').read_bytes()
     _,sections,name,_,_=fw_build.elf(own)
     rom_bytes=sum(s[5]for s in sections if (s[2]&2)and s[1]!=8)
     self.assertLessEqual(rom_bytes,limit)
     self.assertEqual(manifest['applicationBase'],16384)
     self.assertEqual(manifest['theme'],expected_label)
     slot=manifest['themeSlot']
     self.assertEqual(slot['format'],'r75t/v1');self.assertEqual(slot['magic'],'R75T')
     self.assertEqual(slot['version'],1);self.assertEqual(slot['bytes'],28)
     min_off=manifest['codeStart']-0x08004000;max_off=manifest['imageEnd']-0x08004000
     self.assertGreaterEqual(slot['fileOffset'],min_off)
     self.assertLessEqual(slot['fileOffset']+28,max_off)
     raw_slot=bin_bytes[slot['fileOffset']:slot['fileOffset']+28]
     magic,ver,sz=struct.unpack_from('<IHH',raw_slot,0)
     crc,=struct.unpack_from('<I',raw_slot,24)
     self.assertEqual((magic,ver,sz),(0x54353752,1,28))
     self.assertEqual(crc,zlib.crc32(raw_slot[:24])&0xffffffff)
     self.assertEqual(crc,slot['crc32'])

   # Error checks on real build manifest & binary
   pink_lyr_dir=pink_out/'ips-lyrics'
   pink_lyr_bin=(pink_lyr_dir/'rainy75v2-ips.bin').read_bytes()
   pink_lyr_man=json.loads((pink_lyr_dir/'manifest.json').read_text(encoding='utf8'))
   with self.assertRaises(ValueError):fw_build.patch_theme_slot(pink_lyr_bin,{**pink_lyr_man,'sha256':'f'*64},theme_file)
   bad_slot_man=json.loads(json.dumps(pink_lyr_man));bad_slot_man['themeSlot']['magic']='NOPE'
   with self.assertRaises(ValueError):fw_build.patch_theme_slot(pink_lyr_bin,bad_slot_man,theme_file)
   bad_crc_man=json.loads(json.dumps(pink_lyr_man));bad_crc_man['themeSlot']['crc32']^=0xffffffff
   with self.assertRaises(ValueError):fw_build.patch_theme_slot(pink_lyr_bin,bad_crc_man,theme_file)

   # Patch pink base IPS and compare Unicorn ARM render against custom-compiled base IPS
   pink_ips_bin=(pink_out/'ips/rainy75v2-ips.bin').read_bytes()
   pink_ips_man=json.loads((pink_out/'ips/manifest.json').read_text(encoding='utf8'))
   patched_ips_bin,_=fw_build.patch_theme_slot(pink_ips_bin,pink_ips_man,theme_file)
   custom_ips_bin=(custom_out/'ips/rainy75v2-ips.bin').read_bytes()

   pink_base_frames=run_arm_render(pink_ips_bin,(pink_out/'ips/module.elf').read_bytes(),assets.normalize_theme('pink'))
   custom_base_frames=run_arm_render(custom_ips_bin,(custom_out/'ips/module.elf').read_bytes(),CUSTOM_THEME)
   patched_base_frames=run_arm_render(patched_ips_bin,(pink_out/'ips/module.elf').read_bytes(),CUSTOM_THEME)
   self.assertEqual(patched_base_frames['native'],custom_base_frames['native'])
   self.assertNotEqual(patched_base_frames['native'],pink_base_frames['native'])

   # Patch pink ips-lyrics and compare Unicorn ARM render + test_lyrics_model against custom-compiled ips-lyrics
   patched_lyr_bin,patched_lyr_man=fw_build.patch_theme_slot(pink_lyr_bin,pink_lyr_man,theme_file)
   patched_lyr_dir=d/'patched-lyrics';shutil.copytree(pink_lyr_dir,patched_lyr_dir)
   (patched_lyr_dir/'rainy75v2-ips.bin').write_bytes(patched_lyr_bin)
   (patched_lyr_dir/'manifest.json').write_text(json.dumps(patched_lyr_man,indent=2)+'\n',encoding='utf8')

   custom_lyr_dir=custom_out/'ips-lyrics'
   custom_lyr_bin=(custom_lyr_dir/'rainy75v2-ips.bin').read_bytes()

   for test_dir in [custom_lyr_dir,patched_lyr_dir]:
    subprocess.run([sys.executable,str(ROOT/'tools/test_lyrics_model.py'),'--build',str(test_dir)],check=True)

   pink_lyr_frames=run_arm_render(pink_lyr_bin,(pink_lyr_dir/'module.elf').read_bytes(),assets.normalize_theme('pink'),font_bytes)
   custom_lyr_frames=run_arm_render(custom_lyr_bin,(custom_lyr_dir/'module.elf').read_bytes(),CUSTOM_THEME,font_bytes)
   patched_lyr_frames=run_arm_render(patched_lyr_bin,(pink_lyr_dir/'module.elf').read_bytes(),CUSTOM_THEME,font_bytes)
   for key in ['native','layout0','layout1','layout2','layout3']:
    self.assertEqual(patched_lyr_frames[key],custom_lyr_frames[key],f'Mismatch in {key}')
    self.assertNotEqual(patched_lyr_frames[key],pink_lyr_frames[key],f'Did not differ from pink in {key}')

   # Check actual theme colors in native and layout1 (caption40) rendered surfaces
   def px(buf,x,y):return int.from_bytes(buf[(y*320+x)*2:(y*320+x)*2+2],'little')
   fn=patched_base_frames['native']
   self.assertEqual(px(fn,40,57),assets.rgb565(CUSTOM_THEME['panel']))
   self.assertEqual(px(fn,16,13),assets.rgb565(CUSTOM_THEME['background']))
   f1=patched_lyr_frames['layout1']
   self.assertEqual(px(f1,22,39),assets.rgb565(CUSTOM_THEME['background']))
   self.assertEqual(px(f1,20,37),assets.rgb565(CUSTOM_THEME['shell']))
   self.assertEqual(px(f1,20,75),assets.rgb565(CUSTOM_THEME['lyricsBorder']))
   self.assertEqual(px(f1,20,80),assets.rgb565(CUSTOM_THEME['lyricsPanel']))
   self.assertEqual(px(f1,19,154),assets.rgb565(CUSTOM_THEME['accent']))

if __name__=='__main__':unittest.main()
