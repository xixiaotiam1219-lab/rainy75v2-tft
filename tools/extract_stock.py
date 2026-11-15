"""Extract matching local factory HTML inputs without executing JavaScript.
SPDX-License-Identifier: MIT. Original inputs/outputs keep their owners' rights.
"""
import argparse,base64,re,hashlib,json,struct
from pathlib import Path
EXPECTED={'ips':{'32defab7902e57eb972a577fc6cbf3a7e57bc772d59b99f11038370412b77f41'},'kbd':{'bc575a6d7b19042048705248715a43a67a23c7f217ba0ac464c539a390f4d23b','31a9eb80752c1f8c94951dd6e2e6776eeb216f47ba58919ca36f6e6d26f0e476'}}

def checked(data,kind):
 if hashlib.sha256(data).hexdigest()not in EXPECTED[kind]:raise ValueError('Extracted firmware is not a supported revision; nothing written')
 return data

def extract_asar(path,kind,release='20261113-1'):
 if release!='20261113-1':raise ValueError('Unsupported ASAR release')
 with Path(path).open('rb')as f:
  head=f.read(16)
  if len(head)!=16:raise ValueError('Truncated ASAR')
  tag,size,_,n=struct.unpack('<4I',head);start=8+size;total=Path(path).stat().st_size
  if tag!=4 or n>16*1024*1024 or n<2 or start<16+n or start>total:raise ValueError('Invalid ASAR bounds')
  entry=json.loads(f.read(n))
  for part in ('app/firmware/rainy75v2/'+release+'/'+('ips.bin'if kind=='ips'else'main-core.bin')).split('/'):entry=entry['files'][part]
  offset=entry.get('offset');length=entry.get('size')
  if entry.get('unpacked')or entry.get('link')or not isinstance(offset,str)or not offset.isdecimal()or not isinstance(length,int)or not 0<length<=1024*1024 or start+int(offset)+length>total:raise ValueError('Invalid ASAR firmware entry')
  f.seek(start+int(offset));return checked(f.read(length),kind)
def object_text(text,start):
 depth=0;quote=None;escape=False
 for i in range(start,len(text)):
  c=text[i]
  if quote:
   if escape:escape=False
   elif c=='\\':escape=True
   elif c==quote:quote=None
  elif c in ['"',"'"]:quote=c
  elif c=='{':depth+=1
  elif c=='}':
   depth-=1
   if depth==0:return text[start:i+1]
 raise ValueError('Incomplete firmware object')
def extract(text,kind):
 begin=re.search(r'const\s+FIRMWARE\s*=\s*\{',text)
 if not begin:raise ValueError('Supported FIRMWARE table not found')
 table=object_text(text,text.index('{',begin.start()));match=re.search(r'\b'+kind+r'\s*:\s*\{',table)
 if not match:raise ValueError('Requested firmware not found')
 obj=object_text(table,table.index('{',match.start()));seed=re.search(r'\bseed\s*:\s*(0x[0-9a-fA-F]+|[0-9]+)',obj);data=re.search(r'\bb64\s*:\s*[\'"]([A-Za-z0-9+/=\s]+)[\'"]',obj)
 if not seed or not data:raise ValueError('Unsupported seed/base64 format')
 x=int(seed[1],0);result=bytearray(base64.b64decode(re.sub(r'\s+','',data[1]),validate=True))
 for i,v in enumerate(result):x=(x*1103515245+12345)&0xffffffff;result[i]=v^((x>>16)&255)
 return checked(result,kind)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('source',type=Path,help='Factory HTML or WOBHub app.asar');p.add_argument('--out',type=Path,default=Path('inputs'));p.add_argument('--kind',choices=['ips','kbd','both'],default='both');a=p.parse_args();kinds=['ips','kbd'] if a.kind=='both' else [a.kind]
 if a.source.suffix.lower()=='.asar':data={k:extract_asar(a.source,k)for k in kinds}
 else:
  text=a.source.read_text(encoding='utf-8-sig');data={k:extract(text,k)for k in kinds}
 a.out.mkdir(parents=True,exist_ok=True)
 for k,v in data.items():target=a.out/('ips-stock.bin' if k=='ips' else 'main-stock.bin');target.write_bytes(v);print(target.name,len(v),hashlib.sha256(v).hexdigest())
