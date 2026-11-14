"""Full source-font coverage at 20px; packed bits, sorted Unicode index. MIT code.

Font assets remain OFL-1.1. No hardware operations. SPDX-License-Identifier: MIT.
"""
from pathlib import Path
import argparse,hashlib,json,struct,zlib
from PIL import Image,ImageDraw,ImageFont
from fontTools.ttLib import TTFont
ROOT=Path(__file__).resolve().parents[1]
SOURCE_SHA='2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b'
HEADER=256;SIZE=20;BITMAP=50;RECORD=52

class Font20:
 def __init__(self,data):
  if len(data)<HEADER:raise ValueError('Truncated font')
  magic,ver,header,w,h,bits,record,flags=struct.unpack_from('<4sHHBBHHH',data)
  if (magic,ver,header,w,h,bits,record,flags)!=(b'R75F',2,HEADER,20,20,50,52,1):raise ValueError('Unsupported font')
  count,index,offset,fallback,total,crc,hcrc=struct.unpack_from('<7I',data,16)
  if not 1<=count<=65535 or index!=HEADER or offset!=index+count*4 or total!=offset+count*RECORD or total!=len(data) or fallback>=count:raise ValueError('Bad font bounds')
  if zlib.crc32(data[HEADER:])!=crc:raise ValueError('Font body CRC mismatch')
  if zlib.crc32(data[:40]+b'\0'*4+data[44:HEADER])!=hcrc:raise ValueError('Font header CRC mismatch')
  self.codes=struct.unpack_from('<'+str(count)+'I',data,index)
  if any(cp>0x10ffff or 0xd800<=cp<=0xdfff for cp in self.codes)or any(a>=b for a,b in zip(self.codes,self.codes[1:])):raise ValueError('Invalid Unicode index')
  if any(not 1<=data[offset+i*RECORD]<=20 or data[offset+i*RECORD+1]&~1 for i in range(count)):raise ValueError('Invalid glyph metrics')
  self.lookup={cp:i for i,cp in enumerate(self.codes)};self.offset=offset;self.data=data;self.fallback=fallback
 def glyph(self,ch):
  cp=ord(ch)if isinstance(ch,str)else ch;i=self.lookup.get(cp,self.fallback);at=self.offset+i*RECORD
  advance,flags=self.data[at:at+2];return advance,self.data[at+2:at+RECORD]
 def draw(self,text,scale=1):
  glyphs=[self.glyph(ch)for ch in text];im=Image.new('RGB',(max(1,sum(g[0]for g in glyphs)),20),'#fff1f6');d=ImageDraw.Draw(im);x=0
  for advance,pixels in glyphs:
   for y in range(20):
    for xx in range(min(advance,20)):
     bit=y*20+xx
     if pixels[bit>>3]&(128>>(bit&7)):d.point((x+xx,y),fill='#a35479')
   x+=advance
  return im.resize((im.width*scale,im.height*scale),Image.Resampling.NEAREST)

def build(source,out):
 source=Path(source);out=Path(out)
 if hashlib.sha256(source.read_bytes()).hexdigest()!=SOURCE_SHA:raise ValueError('Unsupported source font SHA; see docs/lyrics.md')
 font=ImageFont.truetype(str(source),20);tt=TTFont(source);cmap=tt.getBestCmap();codes=sorted(cp for cp,g in cmap.items()if g!='.notdef' and not 0xd800<=cp<=0xdfff)
 body=bytearray(struct.pack('<'+str(len(codes))+'I',*codes))
 for cp in codes:
  cell=Image.new('1',(20,20));d=ImageDraw.Draw(cell);d.fontmode='1';ch=chr(cp);box=font.getbbox(ch,anchor='ls');base=max(-box[1],min(18,20-box[3]));d.text((max(0,-box[0]),base),ch,font=font,fill=1,anchor='ls')
  bits=0
  for pixel in cell.getdata():bits=bits<<1|int(bool(pixel))
  advance=min(20,max(1,round(font.getlength(ch))))
  body.extend(bytes([advance,1]));body.extend(bits.to_bytes(50,'big'))
 header=bytearray(HEADER);struct.pack_into('<4sHHBBHHH',header,0,b'R75F',2,HEADER,20,20,50,52,1)
 struct.pack_into('<7I',header,16,len(codes),HEADER,HEADER+len(codes)*4,codes.index(0x25a1),HEADER+len(body),zlib.crc32(body),0)
 header[48:80]=hashlib.sha256(source.read_bytes()).digest();struct.pack_into('<I',header,40,zlib.crc32(header))
 data=bytes(header+body);pack=Font20(data);out.mkdir(parents=True,exist_ok=True);(out/'FONT.BIN').write_bytes(data)
 (out/'OFL-1.1.txt').write_bytes((ROOT/'licenses/OFL-1.1.txt').read_bytes())
 copyright_text='\n'.join(sorted({n.toUnicode()for n in tt['name'].names if n.nameID==0}))
 (out/'FONT-NOTICE.txt').write_text('Rainy Lyrics Pixel 20\nDerived from Noto Sans CJK SC; SIL OFL-1.1.\nhttps://github.com/notofonts/noto-cjk\n'+copyright_text+'\n',encoding='utf8')
 report={'format':'R75F/2','name':'Rainy Lyrics Pixel 20','license':'OFL-1.1','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'sourceCodepoints':len(codes),'supplementaryCodepoints':sum(cp>65535 for cp in codes),'size':[20,20],'bitmapBytes':50,'recordBytes':52,'unicodeIndexBytes':len(codes)*4,'fallback':'U+25A1','installed':False,'limitations':['Source font coverage, not all Unicode','No shaping engine; host NFC normalization required for decomposed kana/Latin']}
 (out/'font-manifest.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
 preview=Image.new('RGB',(1120,280),'#fff1f6')
 for i,line in enumerate(['简体中文  繁體中文','日本語：君の声が聞こえる','English: Hello, world!','生僻字：𠮷 𪚥  /  多语言混排']):preview.paste(pack.draw(line,3),(20,12+i*66))
 preview.save(out/'font20-preview.png');print(json.dumps(report))

if __name__=='__main__':
 p=argparse.ArgumentParser(description='Build local OFL R75F/2 font, no device writes');p.add_argument('--source',type=Path,required=True);p.add_argument('--out',type=Path,default=ROOT/'build/font');a=p.parse_args();build(a.source,a.out)
