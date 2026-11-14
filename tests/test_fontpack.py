# SPDX-License-Identifier: MIT
import sys,struct,zlib,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from fontpack import Font20
def fixture():
 codes=[65,0x25a1];b=bytearray(256+len(codes)*56);struct.pack_into('<4sHHBBHHH',b,0,b'R75F',2,256,20,20,50,52,1)
 struct.pack_into('<7I',b,16,2,256,264,1,len(b),0,0);struct.pack_into('<2I',b,256,*codes)
 for i in range(2):b[264+i*52]=20;b[265+i*52]=1;b[266+i*52]=128
 struct.pack_into('<I',b,36,zlib.crc32(b[256:]));struct.pack_into('<I',b,40,zlib.crc32(b[:256]));return b
class FontTest(unittest.TestCase):
 def test_roundtrip_and_unknown_character_fallback(self):
  f=Font20(fixture());self.assertEqual(f.glyph('A')[0],20);self.assertEqual(f.glyph('𠮷'),f.glyph('□'))
 def test_bounds_crc_and_order_rejected(self):
  for at in [0,16,28,40,256,300]:
   with self.subTest(at=at):
    b=fixture();b[at]^=1
    with self.assertRaises(ValueError):Font20(b)
if __name__=='__main__':unittest.main()
