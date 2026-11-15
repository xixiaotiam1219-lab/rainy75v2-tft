"""Synthetic ASAR fixtures only; no vendor firmware included. SPDX-License-Identifier: MIT."""
import hashlib,json,struct,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from tools import extract_stock

class AsarExtraction(unittest.TestCase):
 def test_hash_and_entry_bounds_without_executing_bundled_code(self):
  data=b'owned synthetic payload';entry={'size':len(data),'offset':'0'}
  def package(item):
   node={'files':{'ips.bin':item}}
   for part in reversed(['app','firmware','rainy75v2','20261113-1']):node={'files':{part:node}}
   raw=json.dumps(node,separators=(',',':')).encode();return struct.pack('<4I',4,len(raw)+8,len(raw)+4,len(raw))+raw+data
  with tempfile.TemporaryDirectory(prefix='rainy75-asar-test-')as folder:
   path=Path(folder)/'app.asar';path.write_bytes(package(entry))
   with self.assertRaises(ValueError):extract_stock.extract_asar(path,'ips')
   with patch.dict(extract_stock.EXPECTED,{'ips':{hashlib.sha256(data).hexdigest()}}):
    self.assertEqual(extract_stock.extract_asar(path,'ips'),data)
    for item in [{**entry,'offset':'999999'},{**entry,'unpacked':True},{**entry,'size':2000000}]:
     path.write_bytes(package(item))
     with self.assertRaises(ValueError):extract_stock.extract_asar(path,'ips')
   path.write_bytes(b'bad')
   with self.assertRaises(ValueError):extract_stock.extract_asar(path,'ips')
