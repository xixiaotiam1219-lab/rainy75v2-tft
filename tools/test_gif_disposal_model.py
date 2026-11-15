"""Run the stock GIF disposal prefix; no HID or firmware writes. SPDX-License-Identifier: MIT.

The stock worker decodes indices in state 0, converts them to RGB565 in state 1,
and submits LCD DMA in state 2. This checks the RGB565 surface between decoding
and conversion, when native_ui.c may reuse it for a key/status dirty redraw.
It does not model the full GIF LZW decoder, LCD, or physical scheduling.
"""
import argparse,hashlib,struct
from pathlib import Path
from PIL import Image
from unicorn import Uc,UC_ARCH_ARM,UC_MODE_THUMB,UC_MODE_MCLASS,UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_PC,UC_ARM_REG_SP,UC_ARM_REG_R0
from assets import ROOT,rgb565
from build import IPS_SHA

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--stock',type=Path,required=True);a=p.parse_args()
 stock=a.stock.read_bytes()
 if hashlib.sha256(stock).hexdigest()!=IPS_SHA:raise ValueError('Unsupported stock SHA-256')
 cpu=Uc(UC_ARCH_ARM,UC_MODE_THUMB|UC_MODE_MCLASS)
 cpu.mem_map(0x08000000,0x100000);cpu.mem_map(0x20000000,0x80000);cpu.mem_map(0x40000000,0x30000)
 cpu.mem_write(0x08004000,stock)
 def startup(uc,address,size,user):
  if address==0x0807a600:uc.emu_stop()
  else:
   from unicorn.arm_const import UC_ARM_REG_LR
   uc.reg_write(UC_ARM_REG_PC,uc.reg_read(UC_ARM_REG_LR))
 for address in [0x0807a600,0x08079ff8,0x0807c9b8]:cpu.hook_add(UC_HOOK_CODE,startup,begin=address,end=address)
 cpu.reg_write(UC_ARM_REG_SP,int.from_bytes(stock[:4],'little'))
 cpu.emu_start(int.from_bytes(stock[4:8],'little'),0x08001000,count=5000000)
 assert cpu.reg_read(UC_ARM_REG_PC)==0x0807a600,'Stock initialization did not finish'
 obj,surface=0x20041000,0x20010000
 def put(offset,value,size=4):cpu.mem_write(obj+offset,value.to_bytes(size,'little'))
 for theme in ['pink','mint','mono']:
  path=ROOT/'assets'/f'robot-{theme}.gif';data=path.read_bytes()
  with Image.open(path) as gif:
   assert gif.disposal_method==1
   palette=bytes(gif.getpalette());frame=gif.convert('RGB')
  pixels=b''.join(struct.pack('<H',rgb565('#%02x%02x%02x'%color)) for color in frame.getdata())
  bg_index=data[11];bg=rgb565('#%02x%02x%02x'%tuple(palette[bg_index*3:bg_index*3+3]));blank=struct.pack('<H',bg)*(320*172)
  for disposal in [2,1]:
   cpu.mem_write(obj,bytes(0x166c));put(0x1c,320,2);put(0x2b,disposal,1)
   put(0x34,obj+0x33c);put(0x33c,len(palette)//3);cpu.mem_write(obj+0x340,palette)
   put(0x650,320,2);put(0x652,172,2);put(0x654,bg_index,1);put(0x658,surface)
   cpu.mem_write(surface,pixels);cpu.reg_write(UC_ARM_REG_SP,0x2005e000);cpu.reg_write(UC_ARM_REG_R0,obj)
   # Execute the real flash trampoline and RAM instructions, stopping before
   # any file read/LZW work at 0x2003ef2a. No decoder instructions are mocked.
   cpu.emu_start(0x0805a54d,0x2003ef2a,count=4000000)
   assert cpu.reg_read(UC_ARM_REG_PC)==0x2003ef2a
   result=bytes(cpu.mem_read(surface,len(pixels)))
   assert result==(blank if disposal==2 else pixels),(theme,disposal)
  print(f'{theme}: stock disposal=2 clears the entire RGB565 surface; disposal=1 retains it')
 print('PASS: original machine-code clearing window reproduced; no physical hardware accessed')

if __name__=='__main__':main()
