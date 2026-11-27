"""Execute hash-selected CH585 clock patches with modeled peripherals.
SPDX-License-Identifier: MIT. No HID, real Flash writes or vendor binaries shipped.
"""
from pathlib import Path
import argparse,hashlib,json,struct
from unicorn import Uc,UC_ARCH_RISCV,UC_MODE_RISCV32,UC_HOOK_CODE,UC_HOOK_MEM_READ,UC_HOOK_MEM_WRITE
from unicorn.riscv_const import UC_RISCV_REG_X0,UC_RISCV_REG_PC
from build import elf,require
from main_profiles import MAIN_PROFILES

def main():
 p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--stock',type=Path,required=True);a=p.parse_args();folder=a.build
 m=json.loads((folder/'manifest.json').read_text());image=(folder/'rainy75v2-main.bin').read_bytes();stock=a.stock.read_bytes();sha=hashlib.sha256(stock).hexdigest();profile=MAIN_PROFILES.get(sha)
 require(profile is not None and m['stockSha256']==sha and len(stock)==profile['bytes'],'Wrong factory input')
 require(len(image)==294912 and hashlib.sha256(image).hexdigest()==m['sha256']and m['mainProfile']==profile,'Wrong model image/profile')
 _,_,_,symbols,segments=elf((folder/'module.elf').read_bytes())
 journal=profile.get('journalStart');anchor=journal or 0x49000
 if not journal:
  isp=(folder/'isp.elf').read_bytes();_,sections,name,_,_=elf(isp);text=next(s for s in sections if name(s)=='.text');blob=isp[text[4]:text[4]+text[5]];blob_offset=m['isp']['entryOffset'];assert hashlib.sha256(blob).hexdigest()==m['isp']['sha256']
 patch_sites=[(profile['ipsHook']-0x2000,4),(profile['rtcHook']-0x2000,4)]
 patch_sites+=([(profile['collector']-0x20000000+4,8)] if journal else [(profile[k]-0x20000000+4,8) for k in ['workerA','workerB']])
 if journal:
  assert all(0x2000+len(stock)<=va<=va+n<=journal for kind,_,va,_,n,*_ in segments if kind==1 and n)
  assert image[journal-0x2000:]==b'\xff'*(0x4a000-journal)
 allowed={i for start,n in patch_sites for i in range(start,start+n)}
 assert image[:512]==stock[:512]and all(x==y or i in allowed for i,(x,y)in enumerate(zip(stock,image)))
 guard,stack,source,stop=anchor+(12 if journal else 24),0x2001fff0,0x20012000,0x1000;gp=profile['gp'];reg=lambda n:UC_RISCV_REG_X0+n
 def set_anchor(cpu,cycles=100000,seconds=86399,rate=32000,day=0):
  if journal:
   values=[cycles,(day<<17)|seconds,rate*1000 if rate<40001 else rate]
   values.append(((0x434c4b32^values[0]^values[1]^values[2])&0x3fffffff)|0x40000000)
  else:
   values=[0x434c4b31,cycles,seconds,rate,day];values.append(values[0]^values[1]^values[2]^values[3]^values[4])
  cpu.mem_write(anchor,struct.pack('<'+'I'*len(values),*values))
 def create(counter=132000,day=0,rx=None,busy=0,valid=True):
  u=Uc(UC_ARCH_RISCV,UC_MODE_RISCV32);u.mem_map(0,0x50000);u.mem_map(0x20000000,0x20000);u.mem_map(0x40001000,0x3000);u.mem_map(0xe000e000,0x1000);u.mem_map(0x7f000,0x1000)
  u.mem_write(0,b'\xff'*0x50000);u.mem_write(0x2000,image);u.mem_write(0x7f024,struct.pack('<I',9))
  # These ranges are separately checked by executing the real reset below.
  high_n=profile['highcodeEnd']-0x20000000;u.mem_write(0x20000000,image[4:4+high_n]);data_n=profile['dataEnd']-profile['highcodeEnd'];data_at=profile['dataSource']-0x2000;u.mem_write(profile['highcodeEnd'],image[data_at:data_at+data_n])
  u.reg_write(reg(3),gp);u.reg_write(reg(2),stack);set_anchor(u)
  if not valid:u.mem_write(guard,bytes(4))
  ctx={'csr':0x88,'counter':counter,'day':day,'cause':0,'uart':[],'uartPc':[],'writes':[],'erases':[],'programs':[],'spi':[],'wel':False,'word':0,'byte':0,'sdkCalls':0,'input':[rx]if rx else[],'dropCommit':False,'mockWorker':False,'seen':[],'coldArgs':[]}
  u.mem_write(gp+profile.get('screenEnabledOffset',0x17c),struct.pack('<I',1))
  if rx:u.mem_write(profile['rx'],rx)
  def ret(value=None):
   if value is not None:u.reg_write(reg(10),value)
   u.reg_write(UC_RISCV_REG_PC,u.reg_read(reg(1)))
  def code(cpu,pc,size,_):
   word=int.from_bytes(cpu.mem_read(pc,4),'little')
   if word&0x7f==0x73 and word>>20==0x800:
    rd,rs,f=(word>>7)&31,(word>>15)&31,(word>>12)&7;v=cpu.reg_read(reg(rs));old=ctx['csr'];assert f in [2,3];ctx['csr']=old|v if f==2 else old&~v
    if rd:cpu.reg_write(reg(rd),old)
    cpu.reg_write(UC_RISCV_REG_PC,pc+4);return
   if pc==0x200000a2:ret();return
   if pc==profile.get('usbTick',0x20004efe):ret(123456);return
   if pc==profile['rtcInit']:ctx['coldArgs'].append([cpu.reg_read(reg(r))for r in range(10,16)]);ctx['counter']=0;ret();return
   if pc==0x200010fe:
    data=ctx['input'].pop(0)if ctx['input']else b''
    if data:cpu.mem_write(cpu.reg_read(reg(10)),data)
    ret(len(data));return
   if pc in [profile['nextA'],profile['nextB']]:
    if ctx['mockWorker']:ctx['seen'].append([cpu.reg_read(reg(r))for r in range(10,18)])
    ret(0x5aa55aa5);return
   if pc==profile['collector']and ctx['mockWorker']:
    for r in range(10,18):cpu.reg_write(reg(r),0xabc000+r)
    ret();return
   if journal and pc==profile['ispProgram']:
    cmd,addr,buf,n=[cpu.reg_read(reg(r)) for r in range(10,14)]
    assert cmd==2 and journal<=addr and addr+n<=0x4a000 and (addr-journal)%16=={12:0,4:12}[n]
    assert 0x20000000<=buf<=0x20020000-n and not buf%4
    ctx['sdkCalls']+=1
   if not journal and profile['bssEnd']<=pc<0x20020000 and bytes(cpu.mem_read(pc,8))==blob[blob_offset:blob_offset+8]:
    cmd,addr,buf,n=[cpu.reg_read(reg(r))for r in range(10,14)];assert (cmd,addr,n)in[(1,anchor,4096),(2,anchor+4,24),(2,anchor,4),(2,guard,4)];assert bytes(cpu.mem_read(pc-blob_offset,len(blob)))==blob;ctx['sdkCalls']+=1
   h=word&65535;group=h&0xe003
   if group in [0x2000,0xa000]:
    rd,rs=8+((h>>2)&7),8+((h>>7)&7);offset=((h>>12)&1)|(((h>>5)&3)<<1)|(((h>>10)&3)<<3);at=(cpu.reg_read(reg(rs))+offset)&0xffffffff
    if group==0x2000:cpu.reg_write(reg(rd),cpu.mem_read(at,1)[0])
    else:
     v=cpu.reg_read(reg(rd))&255;cpu.mem_write(at,bytes([v]))
     if at==0x40003008:ctx['uart'].append(v);ctx['uartPc'].append(pc)
     elif 0x40000000<=at<0x60000000:raise AssertionError('Unexpected WCH peripheral store')
    cpu.reg_write(UC_RISCV_REG_PC,pc+2)
   elif word&0xfe00707f==0x20004033:
    rd,rs1,rs2=(word>>7)&31,(word>>15)&31,(word>>20)&31;cpu.reg_write(reg(rd),((cpu.reg_read(reg(rs1))<<2)+cpu.reg_read(reg(rs2)))&0xffffffff);cpu.reg_write(UC_RISCV_REG_PC,pc+4)
  def read(cpu,access,at,size,value,_):
   values={0x40001038:ctx['counter'],0x4000103c:ctx['day'],0x4000102f:0x8a,0x40001041:0x93,0x40001044:ctx['cause'],0x40001045:0x20,0x4000102c:3501,0x4000300b:busy,0x40001806:0,0x40001804:0}
   if at in values:cpu.mem_write(at,int(values[at]).to_bytes(size,'little'))
  def write(cpu,access,at,size,value,_):
   ctx['writes'].append((at,value));assert at in[0x40001040,0x40001044,0x40001800,0x40001804,0x40001806,0x40003008],hex(at)
   if at==0x40003008:ctx['uart'].append(value&255);ctx['uartPc'].append(cpu.reg_read(UC_RISCV_REG_PC))
   elif at==0x40001800:ctx['word']=value;ctx['byte']=0
   elif at==0x40001804:ctx['spi'].append(value&255)
   elif at==0x40001806:
    if value==21:ctx['spi'].append(ctx['word']>>(ctx['byte']*8)&255);ctx['byte']+=1
    if value==0:
     p=ctx['spi']
     if p:
      assert p[0]in[0xff,6,2,5,0x20],p
      if p[0]==6:ctx['wel']=True
      if p[0]==2:
       addr=int.from_bytes(bytes(p[1:4]),'big');data=bytes(p[4:]);assert ctx['wel']
       if journal:
        assert journal<=addr and addr+len(data)<=0x4a000 and (addr-journal)%16=={12:0,4:12}[len(data)],(hex(addr),len(data))
        if not(ctx['dropCommit'] and len(data)==4):cpu.mem_write(addr,bytes(a&b for a,b in zip(cpu.mem_read(addr,len(data)),data)))
       else:
        assert (addr,len(data))in[(guard,4),(anchor+4,24),(anchor,4)]
        if not(ctx['dropCommit']and addr==anchor):cpu.mem_write(addr,data)
       ctx['wel']=False;ctx['programs'].append((addr,data))
      if p[0]==0x20:
       addr=int.from_bytes(bytes(p[1:4]),'big');assert not journal and addr==anchor and len(p)==4 and ctx['wel'];cpu.mem_write(anchor,b'\xff'*4096);cpu.mem_write(guard,struct.pack('<I',0xf3f9bda9));ctx['wel']=False;ctx['erases'].append(addr)
     ctx['spi']=[]
  u.hook_add(UC_HOOK_CODE,code);u.hook_add(UC_HOOK_MEM_READ,read,begin=0x40001000,end=0x40003fff);u.hook_add(UC_HOOK_MEM_WRITE,write,begin=0x40001000,end=0x40003fff)
  return u,ctx
 def call(u,entry,*args):
  for i,v in enumerate(args,10):u.reg_write(reg(i),v)
  u.reg_write(reg(2),stack);u.reg_write(reg(1),stop);u.emu_start(symbols[entry]if isinstance(entry,str)else entry,stop,timeout=3000000,count=400000);assert u.reg_read(UC_RISCV_REG_PC)==stop
  return u.reg_read(reg(10))
 def packet(op,seq=0,payload=b''):
  b=bytearray([0xbe,0x1a,11+len(payload),13,op,seq&255,seq>>8,0])+payload;return bytes(b)+struct.pack('<H',sum(b[3:])&65535)+b'\xed'
 def request(u,op,seq=0,payload=b''):
  u.mem_write(source,packet(op,seq,payload));call(u,profile['usbDispatcher'],source);return bytes(u.mem_read(gp+profile.get('ackOffset',-0x160),4))
 # Real CRT execution proves ROM->RAM mapping and the new GP/BSS boundaries.
 u,ctx=create();u.mem_write(0x20000000,b'\xa5'*0x20000);w=int.from_bytes(stock[:4],'little');d=((w>>31)&1)<<20|((w>>21)&1023)<<1|((w>>20)&1)<<11|((w>>12)&255)<<12
 if d&(1<<20):d-=1<<21
 u.emu_start(0x2000+d,0x200001c2,timeout=10000000,count=1000000);assert u.reg_read(UC_RISCV_REG_PC)==0x200001c2 and u.reg_read(reg(3))==gp and u.reg_read(reg(2))==0x20020000
 hn=profile['highcodeEnd']-0x20000000;assert bytes(u.mem_read(0x20000000,hn))==image[4:4+hn];dn=profile['dataEnd']-profile['highcodeEnd'];at=profile['dataSource']-0x2000;assert bytes(u.mem_read(profile['highcodeEnd'],dn))==image[at:at+dn];assert bytes(u.mem_read(profile['bssStart'],profile['bssEnd']-profile['bssStart']))==bytes(profile['bssEnd']-profile['bssStart'])
 if journal:
  def empty(counter=132000):
   u,ctx=create(counter);u.mem_write(journal,b'\xff'*(0x4a000-journal));return u,ctx
  for day,counter,anchor_day,cycles,seconds,rate in [(0,132007,0,100000,86399,32006894),(1,12345,0,0xa8bffff0,12,31998000),(7,300000,2,123,3600,32006111),(16383,159,0,0,0,30000000)]:
   u,ctx=create(counter,day);set_anchor(u,cycles,seconds,rate,anchor_day)
   expected=(seconds+((day-anchor_day)*0xa8c00000+counter-cycles)*1000//rate)%86400
   assert call(u,'rainy_clock_value')==expected and not ctx['writes']
  u,ctx=empty();assert request(u,15,9)==bytes([13,0xd9,0x50,0x43]);assert request(u,15,24)==bytes([13,0xe8,0x46,0x43]);assert request(u,15,25)==bytes([13,0xe9,10,0]);assert request(u,15,8)==bytes([13,0xd8,0,0])
  before=bytes(u.mem_read(0x2000,journal-0x2000))
  for i in range(10):
   expected=[(journal+i*16,12),(journal+i*16+12,4)]
   rate=32007 if i==0 else 32006894
   assert request(u,18,0x7a12,struct.pack('<II',i*1000,rate))==bytes([13,1,0x12,0x7a])
   assert [(p,len(data))for p,data in ctx['programs'][-2:]]==expected
   assert request(u,15,25)==bytes([13,0xe9,9-i,0])
   assert call(u,'rainy_clock_value')==i*1000
  assert request(u,18,0x7a12,struct.pack('<II',12345,32006894))==bytes([13,5,0x12,0x7a])
  assert before==bytes(u.mem_read(0x2000,journal-0x2000)) and not ctx['erases'] and len(ctx['programs'])==20
  for seconds,rate in [(86400,32007),(0,29999),(0,40001000)]:
   u,ctx=empty();assert request(u,18,12,struct.pack('<II',seconds,rate))==bytes([13,3,12,0]) and not ctx['writes']
  u,ctx=create();ctx['dropCommit']=True
  assert request(u,18,12,struct.pack('<II',12345,32006894))==bytes([13,7,12,0]) and call(u,'rainy_clock_value')==0xffffffff
  u,ctx=create(99999);assert call(u,'rainy_clock_value')==0xffffffff and ctx['programs']==[(guard,bytes(4))]
  ctx['counter']=200000;assert call(u,'rainy_clock_value')==0xffffffff
  for cause in [0,1,2,3,4,5,6,7]:
   u,ctx=create();ctx['cause']=cause;args=[2020,1,1,0,0,0]
   for i,v in enumerate(args,10):u.reg_write(reg(i),v)
   u.emu_start(profile['rtcHook'],profile['rtcHook']+4,timeout=3000000,count=100000)
   assert ctx['coldArgs']==([] if cause in [0,2,3,5] else [args])
   assert (call(u,'rainy_clock_value')!=0xffffffff)==(cause in [0,2,3,5])
  for op in [0,11,24]:
   u,ctx=create();b=packet(op);request(u,op)
   assert bytes(u.mem_read(profile['txBuffer'],len(b)))==b and int.from_bytes(u.mem_read(gp+profile['sendPendingOffset'],4),'little')==1
   u.mem_write(gp+profile['uartGateOffset'],struct.pack('<I',1));call(u,profile['uartSend']);assert bytes(ctx['uart'])==b
  for busy,valid in [(0,True),(1,True),(0,False)]:
   u,ctx=create(rx=bytes.fromhex('be1d04ed'),busy=busy,valid=valid)
   u.mem_write(gp+profile['uartGateOffset'],struct.pack('<I',1));u.mem_write(gp-0x6a8,struct.pack('<I',0xffffffff))
   call(u,profile['collector']);own=bytes(v for v,pc in zip(ctx['uart'],ctx['uartPc'])if m['codeStart']<=pc<journal)
   expected=b'' if busy else bytes.fromhex('be1a080d800000ed') if valid else bytes.fromhex('be1a080d9f0000ed')
   assert own==expected and bytes(u.mem_read(profile['rx'],4))==bytes(4)
  report={'passed':True,'physicalHardwareAccessed':False,'stockVersion':'0.71','sha256':m['sha256'],
   'checks':['actual reset, real USB dispatcher, IPS request forwarding and shared UART collector','fractional RTC rate, RTC day rollover and cold invalidation','stock Flash program routine executed against modeled SPI; bounded append-only journal, failed commit, ten writes and full-journal guard'],
   'limits':['RTC/SPI/UART simulated','no physical USB, sleep/BLE or Flash validation']}
  (folder/'model-validation.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8');print(json.dumps(report));return
 for day,counter,ad,ac,seconds,rate in[(0,132000,0,100000,86399,32000),(1,12345,0,0xa8bffff0,12,32000),(7,300000,2,123,3600,32006)]:
  u,ctx=create(counter,day);set_anchor(u,ac,seconds,rate,ad);assert call(u,'rainy_clock_value')==(seconds+((day-ad)*0xa8c00000+counter-ac)//rate)%86400 and not ctx['writes']
 u,ctx=create(99999);assert call(u,'rainy_clock_value')==0xffffffff and ctx['programs']==[(guard,bytes(4))]and not ctx['erases'];ctx['counter']=500000;u.mem_write(0x2000f000,b'\xa5'*0x11000);assert call(u,'rainy_clock_value')==0xffffffff and len(ctx['programs'])==1
 for seconds,rate in[(0,32000),(54600,32007),(86399,32768)]:
  u,ctx=create(4321000,valid=False);u.mem_write(anchor,b'\xff'*4096);before=bytes(u.mem_read(0x2000,anchor-0x2000));assert request(u,18,0x7a12,struct.pack('<II',seconds,rate))==bytes([13,1,0x12,0x7a]);assert ctx['erases']==[anchor]and ctx['sdkCalls']==3 and [p[0]for p in ctx['programs']]==[anchor+4,anchor];assert bytes(u.mem_read(0x2000,anchor-0x2000))==before
  assert call(u,'rainy_clock_value')==seconds;ctx['counter']+=rate;assert call(u,'rainy_clock_value')==(seconds+1)%86400;u.mem_write(0x2000f000,b'\xa5'*0x11000);assert call(u,'rainy_clock_value')==(seconds+1)%86400
 for seconds,rate in[(86400,32000),(0,29999),(0,40001)]:
  u,ctx=create();assert request(u,18,123,struct.pack('<II',seconds,rate))==bytes([13,3,123,0])and not ctx['writes']
 u,ctx=create();ctx['dropCommit']=True;assert request(u,18,124,struct.pack('<II',23456,32007))==bytes([13,7,124,0])and call(u,'rainy_clock_value')==0xffffffff
 for field,value in[(8,1),(9,0x4350),(10,65535),(11,65535)]:
  u,ctx=create();assert request(u,15,field)==bytes([13,0xd0+field,value&255,value>>8])and not ctx['writes']
 for cause in range(8):
  for count in[0,123456,0xa8c00000,0xffffffff]:
   u,ctx=create(count);ctx['cause']=cause;args=[2020,1,1,0,0,0];saved={r:0x12340000+r for r in[8,9,*range(18,28)]}
   for r,v in saved.items():u.reg_write(reg(r),v)
   for r,v in enumerate(args,10):u.reg_write(reg(r),v)
   u.reg_write(reg(2),stack);u.emu_start(profile['rtcHook'],profile['rtcHook']+4,timeout=3000000,count=100000);preserve=cause in[0,2,3,5]and count<0xa8c00000
   assert ctx['coldArgs']==([]if preserve else[args])and u.reg_read(reg(2))==stack and u.reg_read(reg(3))==gp and all(u.reg_read(reg(r))==v for r,v in saved.items())
 for op in[0,11,24]:
  u,ctx=create();b=packet(op);request(u,op);assert bytes(u.mem_read(profile['txBuffer'],len(b)))==b and int.from_bytes(u.mem_read(gp-0x168,4),'little')==1
  u.mem_write(gp-0x698,struct.pack('<I',1));call(u,0x20006f58);assert bytes(ctx['uart'])==b
 for hook,next_addr in[(profile['workerA'],profile['nextA']),(profile['workerB'],profile['nextB'])]:
  u,ctx=create();ctx['mockWorker']=True;saved={r:0x12340000+r for r in[8,9,*range(18,28)]}
  for r,v in saved.items():u.reg_write(reg(r),v)
  u.reg_write(reg(2),stack);u.emu_start(hook,hook+8,timeout=3000000,count=10000);assert ctx['seen']==[[0xabc000+r for r in range(10,18)]]and u.reg_read(reg(10))==0x5aa55aa5 and u.reg_read(reg(2))==stack and all(u.reg_read(reg(r))==v for r,v in saved.items())
 for busy,valid in[(0,True),(1,True),(0,False)]:
  u,ctx=create(rx=bytes.fromhex('be1d04ed'),busy=busy,valid=valid);call(u,'rainy_clock_response');expected=b''if busy else bytes.fromhex('be1a080d800000ed')if valid else bytes.fromhex('be1a080d9f0000ed');assert bytes(ctx['uart'])==expected and bytes(u.mem_read(profile['rx'],4))==bytes(4)
 u,ctx=create(rx=bytes.fromhex('be1d04ed'));u.mem_write(gp-0x698,struct.pack('<I',1));u.mem_write(gp-0x6b4,struct.pack('<I',0xffffffff));u.reg_write(reg(2),stack);u.emu_start(profile['workerA'],profile['workerA']+8,timeout=3000000,count=10000)
 # Official .data can queue unrelated startup bytes before the received query.
 # Attribute writes by executing PC; the appended code must emit exactly 8B.
 own=bytes(v for v,pc in zip(ctx['uart'],ctx['uartPc'])if 0x47750<=pc<anchor);assert own==bytes.fromhex('be1a080d800000ed')and bytes(ctx['uart']).endswith(own)
 report={'passed':True,'physicalHardwareAccessed':False,'stockVersion':profile['stockVersion'],'sha256':m['sha256'],'checks':['exact four hash-selected hooks; factory prefix preserved','real reset highcode/data/BSS and live GP/SP','day/counter math and SRAM-independent calibration','actual copied SDK, fixed clock-page erase/program, magic-last failure','invalid calibration never writes; RTC rollback guard persists','32 reset-cause/boundary and callee-saved ABI cases','actual USB dispatcher and original UART forwarding','both RAM worker call-pair ABIs and real RX collector','busy UART drops snapshot for retry'],'limits':['RTC/SPI/UART modeled; cold RTC body intercepted','Not full BLE/keyboard input latency/power/recovery proof','Complete power-off RTC retention remains unsolved']}
 (folder/'model-validation.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8');print(json.dumps(report))
if __name__=='__main__':main()
