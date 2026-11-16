# SPDX-License-Identifier: MIT
import sys,tempfile,unittest,json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from assets import generate,validate_keys,load,ROOT,rgb565,base_frame,validate_cache_gif,normalize_theme,theme_slot_bytes
from PIL import Image,ImageChops
class AssetsTest(unittest.TestCase):
 def test_all_themes_are_original_valid_gif_and_headers_fit(self):
  for theme in ['pink','mint','mono']:
   with self.subTest(theme=theme),tempfile.TemporaryDirectory() as d:
    p=generate(ROOT/'profiles/keys.json',theme,Path(d),Path(d)/'headers')
    with Image.open(p) as im:
     self.assertEqual(im.size,(320,172));self.assertEqual(im.n_frames,8)
     bg=rgb565(load(ROOT/'profiles/themes.json')[theme]['background'])
     for i in range(im.n_frames):
      im.seek(i);self.assertEqual(im.tile[0][1],(0,0,320,172));self.assertEqual(im.disposal_method,1);self.assertNotIn('transparency',im.info);self.assertEqual(im.info['duration'],120)
      frame=im.convert('RGB');color=frame.getpixel((22,39));self.assertNotEqual(rgb565('#%02x%02x%02x'%color),bg)
      self.assertIsNone(ImageChops.difference(frame,base_frame(load(ROOT/'profiles/themes.json')[theme],i)).getbbox())
    self.assertIn('UI_IDLE_MS 0u',(Path(d)/'headers/ui_assets.h').read_text())
 def test_shipped_robot_files_match_generator_and_cache_contract(self):
  for theme,colors in load(ROOT/'profiles/themes.json').items():
   with self.subTest(theme=theme),tempfile.TemporaryDirectory() as d:
    shipped=ROOT/'assets'/f'robot-{theme}.gif';validate_cache_gif(shipped,colors)
    generated=generate(ROOT/'profiles/keys.json',theme,Path(d))
    self.assertEqual(shipped.read_bytes(),generated.read_bytes())
 def test_cache_contract_rejects_clear_to_background_and_delta_frames(self):
  colors=load(ROOT/'profiles/themes.json')['mint'];frames=[base_frame(colors,i) for i in range(8)]
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'unsafe.gif'
   for disposal in [1,2]:
    frames[0].save(p,save_all=True,append_images=frames[1:],duration=120,disposal=disposal,optimize=False)
    with self.subTest(disposal=disposal),self.assertRaises(ValueError):validate_cache_gif(p,colors)
 def test_profile_rejects_duplicate_and_overflow(self):
  p=load(ROOT/'profiles/keys.json');p['glyphs'].append(p['glyphs'][0])
  with self.assertRaises(ValueError):validate_keys(p)
  p=load(ROOT/'profiles/keys.json');p['glyphs'][0]['rows']=['1'*17]
  with self.assertRaises(ValueError):validate_keys(p)
 def test_windows_cells_have_equal_margins(self):
  g=next(g for g in load(ROOT/'profiles/keys.json')['glyphs'] if g['key']==227)
  self.assertEqual(g['rows'],g['rows'][::-1]);self.assertTrue(all(r==r[::-1] for r in g['rows']))
 def test_normalize_theme_and_slot_headers(self):
  themes=load(ROOT/'profiles/themes.json')
  for name,raw in themes.items():
   norm=normalize_theme(name)
   self.assertEqual(rgb565(norm['muted']),rgb565(raw.get('muted',raw['accent'])))
   self.assertEqual(rgb565(norm['lyricsBorder']),rgb565(raw.get('lyricsBorder',raw['shell'])))
   self.assertEqual(rgb565(norm['lyricsPanel']),rgb565(raw.get('lyricsPanel',raw['panel'])))
  custom=normalize_theme({'background':'#112233','panel':'#223344','shell':'#334455','ink':'#AABBCC','accent':'#DDEEFF'})
  self.assertEqual(custom['ink'],'#aabbcc')
  self.assertEqual(custom['muted'],'#ddeeff')
  self.assertEqual(custom['lyricsBorder'],'#334455')
  self.assertEqual(custom['lyricsPanel'],'#223344')
  for bad in [{'background':'#123','panel':'#223344','shell':'#334455','ink':'#aabbcc','accent':'#ddeeff'},{'background':'#112233'}]:
   with self.assertRaises(ValueError):normalize_theme(bad)
  with tempfile.TemporaryDirectory() as d:
   generate(ROOT/'profiles/keys.json','mint',Path(d),Path(d)/'headers')
   ui_h=(Path(d)/'headers/ui_assets.h').read_text(encoding='utf8')
   ly_h=(Path(d)/'headers/lyrics_theme.h').read_text(encoding='utf8')
   _,_,crc=theme_slot_bytes('mint')
   self.assertIn(f'0x{crc:08x}u',ui_h);self.assertIn(f'0x{crc:08x}u',ly_h)
   self.assertIn('{40,57,0,1140,120,76,0},',ui_h);self.assertIn('{16,13,1140,165,94,14,1},',ui_h)
   self.assertNotIn('#define BG ',ly_h)
if __name__=='__main__':unittest.main()
