# SPDX-License-Identifier: MIT
import sys,tempfile,unittest,json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from assets import generate,validate_keys,load,ROOT,rgb565
from PIL import Image
class AssetsTest(unittest.TestCase):
 def test_all_themes_are_original_valid_gif_and_headers_fit(self):
  for theme in ['pink','mint','mono']:
   with self.subTest(theme=theme),tempfile.TemporaryDirectory() as d:
    p=generate(ROOT/'profiles/keys.json',theme,Path(d),Path(d)/'headers')
    with Image.open(p) as im:
     self.assertEqual(im.size,(320,172));self.assertEqual(im.n_frames,8)
     bg=rgb565(load(ROOT/'profiles/themes.json')[theme]['background'])
     for i in range(im.n_frames):
      im.seek(i);self.assertEqual(im.tile[0][1],(0,0,320,172));color=im.convert('RGB').getpixel((22,39));self.assertNotEqual(rgb565('#%02x%02x%02x'%color),bg);im.load()
    self.assertIn('UI_IDLE_MS 0u',(Path(d)/'headers/ui_assets.h').read_text())
 def test_profile_rejects_duplicate_and_overflow(self):
  p=load(ROOT/'profiles/keys.json');p['glyphs'].append(p['glyphs'][0])
  with self.assertRaises(ValueError):validate_keys(p)
  p=load(ROOT/'profiles/keys.json');p['glyphs'][0]['rows']=['1'*17]
  with self.assertRaises(ValueError):validate_keys(p)
 def test_windows_cells_have_equal_margins(self):
  g=next(g for g in load(ROOT/'profiles/keys.json')['glyphs'] if g['key']==227)
  self.assertEqual(g['rows'],g['rows'][::-1]);self.assertTrue(all(r==r[::-1] for r in g['rows']))
if __name__=='__main__':unittest.main()
