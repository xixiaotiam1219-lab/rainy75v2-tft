# SPDX-License-Identifier: MIT
"""Unit and integration tests for tools/release.py offline bundler, packager, and verifier."""

from __future__ import annotations

import base64
import gzip
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile
import zlib

ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = ROOT / 'tools'
if str(TOOLS_DIR) not in sys.path:
  sys.path.insert(0, str(TOOLS_DIR))

import assets as assets_tool  # noqa: E402
import fontpack as fontpack_tool  # noqa: E402
import release as release_tool  # noqa: E402


def make_synthetic_font_bin() -> bytes:
  header_sz = fontpack_tool.HEADER
  record_sz = fontpack_tool.RECORD
  codes = sorted([ord('?'), ord('A'), 0x6B4C])
  count = len(codes)
  index_off = header_sz
  data_off = index_off + count * 4
  total = data_off + count * record_sz

  body = bytearray()
  for cp in codes:
    body.extend(struct.pack('<I', cp))
  for _ in codes:
    body.append(12)  # advance
    body.append(0)   # flags
    body.extend(b'\x55' * (record_sz - 2))

  body_crc = zlib.crc32(body)
  pad = b'\x00' * (header_sz - 44)
  hdr_no_hcrc = (
      struct.pack(
          '<4sHHBBHHH7I',
          b'R75F',
          2,
          header_sz,
          20,
          20,
          50,
          record_sz,
          1,
          count,
          index_off,
          data_off,
          0,
          total,
          body_crc,
          0,
      )
      + pad
  )
  hcrc = zlib.crc32(hdr_no_hcrc)
  hdr = (
      struct.pack(
          '<4sHHBBHHH7I',
          b'R75F',
          2,
          header_sz,
          20,
          20,
          50,
          record_sz,
          1,
          count,
          index_off,
          data_off,
          0,
          total,
          body_crc,
          hcrc,
      )
      + pad
  )
  blob = hdr + bytes(body)
  fontpack_tool.Font20(blob)
  return blob


def make_theme_slot_dict(data_len: int = 4096, file_offset: int = 128) -> dict:
  return {
      'format': 'r75t/v1',
      'magic': 'R75T',
      'version': 1,
      'fileOffset': file_offset,
      'bytes': 28,
      'codeStart': 0x4000,
      'imageEnd': 0x4000 + data_len,
      'applicationBase': 0x4000,
      'fields': ['background', 'shell', 'panel', 'ink', 'accent'],
      'crc32': 0x12345678,
  }


def create_staged_fixture(staging_root: Path) -> dict[str, Path]:
  staging_root.mkdir(parents=True, exist_ok=True)
  font_dir = staging_root / 'font'
  font_dir.mkdir(parents=True, exist_ok=True)
  font_bin_path = font_dir / 'FONT.BIN'
  font_bin_path.write_bytes(make_synthetic_font_bin())
  shutil.copy2(ROOT / 'licenses' / 'OFL-1.1.txt', font_dir / 'OFL-1.1.txt')
  (font_dir / 'FONT-NOTICE.txt').write_text(
      'Synthetic Test Pixel 20\nDerived from Noto Sans CJK SC; SIL OFL-1.1.\n',
      encoding='utf-8',
  )

  targets_dir = staging_root / 'targets'
  targets_dir.mkdir(parents=True, exist_ok=True)

  def write_target(name: str, bin_name: str, payload: bytes, extra: dict) -> Path:
    d = targets_dir / name
    d.mkdir(parents=True, exist_ok=True)
    (d / bin_name).write_bytes(payload)
    manifest = {
        'target': extra.pop('target'),
        'bytes': len(payload),
        'sha256': release_tool.sha256_bytes(payload),
        **extra,
    }
    (d / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return d

  staged = {
      'main-064': write_target('main-064', 'rainy75v2-main.bin', b'M064' * 64, {'target': 'main', 'stockVersion': '0.64'}),
      'main-063beta1': write_target('main-063beta1', 'rainy75v2-main.bin', b'M063' * 64, {'target': 'main', 'stockVersion': '0.63-beta1'}),
      'ips-base': write_target(
          'ips-base',
          'rainy75v2-ips.bin',
          b'IPSB' * 1024,
          {'target': 'ips', 'theme': 'pink', 'themeSlot': make_theme_slot_dict()},
      ),
      'ips-lyrics': write_target(
          'ips-lyrics',
          'rainy75v2-ips.bin',
          b'IPSL' * 1024,
          {'target': 'ips', 'variant': 'lyrics-v1', 'theme': 'pink', 'themeSlot': make_theme_slot_dict()},
      ),
      'main-064-restore': write_target('main-064-restore', 'rainy75v2-main-restore.bin', b'R064' * 64, {'target': 'main-restore', 'stockVersion': '0.64'}),
      'main-063beta1-restore': write_target('main-063beta1-restore', 'rainy75v2-main-restore.bin', b'R063' * 64, {'target': 'main-restore', 'stockVersion': '0.63-beta1'}),
      'ips-restore': write_target('ips-restore', 'rainy75v2-ips-restore.bin', b'RIPS' * 64, {'target': 'ips-restore'}),
      'font-dir': font_dir,
      'font-bin': font_bin_path,
  }

  assets_dir = staging_root / 'assets'
  assets_dir.mkdir(parents=True, exist_ok=True)
  for theme_name in ('pink', 'mint', 'mono'):
    assets_tool.generate(ROOT / 'profiles' / 'keys.json', theme_name, assets_dir)
  staged['assets-dir'] = assets_dir
  return staged


def recompute_release_checksums(release_dir: Path) -> None:
  """Update SHA256SUMS.txt (and optionally file SHA records) in negative tamper tests."""
  sum_lines = []
  for p in sorted(release_dir.rglob('*')):
    if not p.is_file():
      continue
    rel = p.relative_to(release_dir).as_posix()
    if rel == 'SHA256SUMS.txt':
      continue
    sum_lines.append(f'{release_tool.sha256_file(p)} *{rel}')
  (release_dir / 'SHA256SUMS.txt').write_text('\n'.join(sum_lines) + '\n', encoding='utf-8')


class ReleasePackageTests(unittest.TestCase):
  def test_no_syntax_warnings_on_import(self):
    with warnings.catch_warnings(record=True) as caught:
      warnings.simplefilter('always', SyntaxWarning)
      # Compile source strictly to verify zero invalid escape sequences
      compile((ROOT / 'tools' / 'release.py').read_text('utf-8'), 'tools/release.py', 'exec')
      self.assertEqual([w for w in caught if issubclass(w.category, SyntaxWarning)], [])

  def test_bundle_html_es_modules_css_and_execute_in_node(self):
    node_exe = release_tool.resolve_node_exe(None)
    if node_exe is None:
      self.skipTest('node executable unavailable')

    with tempfile.TemporaryDirectory() as td:
      web_dir = Path(td) / 'fixture-web'
      sub_dir = web_dir / 'lib'
      sub_dir.mkdir(parents=True)

      (web_dir / 'tokens.css').write_text(':root { --ink: #a35479; }\n', encoding='utf-8')
      (web_dir / 'studio.css').write_text(
          '@import "./tokens.css";\nbody { color: var(--ink); }\n',
          encoding='utf-8',
      )
      (sub_dir / 'math.mjs').write_text(
          'export const A = 1, B = 2;\n'
          'export const { x, y: z = 9 } = { x: 10, y: 20 };\n'
          'export function double(v) { return /[^01]/.test(String(v)) ? v * 2 : v; }\n'
          'export default function tag(n) { return `v:${n + (1)}`; }\n',
          encoding='utf-8',
      )
      (sub_dir / 'barrel.mjs').write_text(
          'export * from "./math.mjs";\n'
          'export { default as tagFn } from "./math.mjs";\n',
          encoding='utf-8',
      )
      (web_dir / 'studio-app.mjs').write_text(
          'import { A, B, x, z, double, tagFn } from "./lib/barrel.mjs";\n'
          'import defTag, * as ns from "./lib/math.mjs";\n'
          'const out = [A, B, x, z, double(5), tagFn(3), defTag(4), ns.double(7)];\n'
          'globalThis.__TEST_OUT__ = out;\n',
          encoding='utf-8',
      )
      html_entry = web_dir / 'studio.html'
      html_entry.write_text(
          '<!doctype html><html><head>'
          '<link rel="stylesheet" href="studio.css">'
          '</head><body>'
          '<script type="module" src="studio-app.mjs"></script>'
          '</body></html>',
          encoding='utf-8',
      )

      bundled = release_tool.bundle_html(html_entry)
      self.assertIn(':root { --ink: #a35479; }', bundled)
      self.assertNotIn('@import', bundled)
      info = release_tool.verify_release_html(bundled, require_bundle_payload=False, check_node_syntax=True)
      self.assertEqual(info['moduleCount'], 1)

      # Extract bundled <script type="module"> and execute directly in Node!
      import re
      m = re.search(r'<script type="module">\s*([\s\S]*?)</script>', bundled)
      self.assertIsNotNone(m)
      run_mjs = Path(td) / 'exec_bundle.mjs'
      run_mjs.write_text(
          m.group(1) + '\nconsole.log(JSON.stringify(globalThis.__TEST_OUT__));\n',
          encoding='utf-8',
      )
      proc = subprocess.run([str(node_exe), str(run_mjs)], capture_output=True, text=True, check=True)
      self.assertEqual(json.loads(proc.stdout.strip()), [1, 2, 10, 20, 10, 'v:4', 'v:5', 14])

  def test_bundle_html_rejects_external_cdn_links(self):
    with tempfile.TemporaryDirectory() as td:
      web_dir = Path(td)
      bad_script_html = web_dir / 'bad1.html'
      bad_script_html.write_text('<html><script type="module" src="https://cdn.example.com/a.js"></script></html>', 'utf-8')
      with self.assertRaises(ValueError):
        release_tool.bundle_html(bad_script_html)

      bad_css_html = web_dir / 'bad2.html'
      bad_css_html.write_text('<html><head><link rel="stylesheet" href="https://cdn.example.com/a.css"></head></html>', 'utf-8')
      with self.assertRaises(ValueError):
        release_tool.bundle_html(bad_css_html)

      bad_mod_import = web_dir / 'bad3.html'
      (web_dir / 'entry.mjs').write_text('import x from "https://cdn.example.com/x.mjs";', 'utf-8')
      bad_mod_import.write_text('<html><script type="module" src="entry.mjs"></script></html>', 'utf-8')
      with self.assertRaises(ValueError):
        release_tool.bundle_html(bad_mod_import)

  def test_bundle_html_handles_repo_web_index(self):
    bundled = release_tool.bundle_html(ROOT / 'web' / 'index.html')
    info = release_tool.verify_release_html(bundled, require_bundle_payload=False, check_node_syntax=True)
    self.assertEqual(info['moduleCount'], 1)
    self.assertNotIn('src="app.mjs"', bundled)

  def test_bundle_html_handles_all_studio_mjs_modules_and_node_check(self):
    with tempfile.TemporaryDirectory() as td:
      web_copy = Path(td) / 'web'
      shutil.copytree(ROOT / 'web', web_copy)
      html_entry = web_copy / 'studio-harness.html'
      html_entry.write_text(
          '<!doctype html><html><body>'
          '<script type="module">'
          'import { planDeployment, DeploymentRunner } from "./deploy-wizard.mjs";'
          'import { patchIpsTheme, PRESET_THEMES } from "./theme-engine.mjs";'
          'import { composePetGifFrames, auditDeviceGif } from "./gif-studio.mjs";'
          'globalThis.__STUDIO_OK__ = Boolean(planDeployment && DeploymentRunner && patchIpsTheme && PRESET_THEMES && composePetGifFrames && auditDeviceGif);'
          '</script></body></html>',
          encoding='utf-8',
      )
      bundled = release_tool.bundle_html(html_entry)
      info = release_tool.verify_release_html(bundled, require_bundle_payload=False, check_node_syntax=True)
      self.assertEqual(info['moduleCount'], 1)
      node_exe = release_tool.resolve_node_exe(None)
      if node_exe is not None:
        import re
        m = re.search(r'<script type="module">\s*([\s\S]*?)</script>', bundled)
        self.assertIsNotNone(m)
        exec_mjs = Path(td) / 'studio_exec.mjs'
        exec_mjs.write_text(m.group(1) + '\nif(!globalThis.__STUDIO_OK__)process.exit(2);\n', encoding='utf-8')
        proc = subprocess.run([str(node_exe), str(exec_mjs)], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, msg=proc.stderr or proc.stdout)

  def test_full_assemble_verify_dir_zip_cmd_crlf_and_node_hid_in_chinese_space_dir(self):
    node_exe = release_tool.resolve_node_exe(None)
    self.assertIsNotNone(node_exe, 'node.exe is required for portable bundle tests')

    with tempfile.TemporaryDirectory(prefix='Rainy75 发布 测试-') as td:
      td_path = Path(td)
      staging = create_staged_fixture(td_path / 'staging')
      web_dir = td_path / 'fixture web'
      web_dir.mkdir()
      (web_dir / 'studio.css').write_text('body { margin: 0; }\n', encoding='utf-8')
      (web_dir / 'studio-app.mjs').write_text(
          'export const STUDIO_VERSION = "fixture";\n'
          'const b = globalThis.__RAINY75_RELEASE_BUNDLE__;\n',
          encoding='utf-8',
      )
      html_entry = web_dir / 'studio.html'
      html_entry.write_text(
          '<!doctype html><html><head><link rel="stylesheet" href="studio.css"></head>'
          '<body><script type="module" src="studio-app.mjs"></script></body></html>',
          encoding='utf-8',
      )

      out_dir = td_path / 'Rainy75V2-测试 发布包 1.0'
      release_tool.assemble_release(
          staging=staging,
          html_entry=html_entry,
          node_exe=node_exe,
          out_dir=out_dir,
          version='0.2.0-test',
          root=ROOT,
      )
      verified = release_tool.verify_release_dir(out_dir)
      self.assertEqual(verified['manifest']['targets']['ips-base']['themeSlot']['format'], 'r75t/v1')
      self.assertEqual(verified['manifest']['targets']['ips-lyrics']['themeSlot']['magic'], 'R75T')

      # Check top + backend .cmd files have CRLF and NO UTF-8 BOM
      cmd_paths = [out_dir / release_tool.LAUNCHER_CMD_NAME] + [
          out_dir / release_tool.BACKEND_DIR_NAME / name for name in release_tool.BACKEND_CMD_FILES
      ]
      for cmd_p in cmd_paths:
        raw = cmd_p.read_bytes()
        self.assertFalse(raw.startswith(b'\xef\xbb\xbf'), f'BOM found in {cmd_p}')
        self.assertIn(b'\r\n', raw, f'CRLF missing in {cmd_p}')
        self.assertIn(b'chcp 65001', raw, f'chcp 65001 missing in {cmd_p}')

      # Execute bundled portable runtime/node.exe inside Chinese + space folder to verify node-hid loads!
      if os.name == 'nt':
        portable_node = out_dir / release_tool.BACKEND_DIR_NAME / 'runtime' / 'node.exe'
        gui_srv = out_dir / release_tool.BACKEND_DIR_NAME / 'app' / 'desktop' / 'gui-server.cjs'
        check_proc = subprocess.run(
            [
                str(portable_node),
                '-e',
                'const HID=require("node-hid");const gs=require(process.argv[1]);'
                'if(typeof HID.devices!=="function"||typeof gs.createGuiServer!=="function")process.exit(2);'
                'console.log("PORTABLE_OK");',
                str(gui_srv),
            ],
            cwd=out_dir / release_tool.BACKEND_DIR_NAME / 'app',
            capture_output=True,
            text=True,
            encoding='utf-8',
        )
        self.assertEqual(check_proc.returncode, 0, msg=check_proc.stderr)
        self.assertIn('PORTABLE_OK', check_proc.stdout)

      # Write ZIP and verify ZIP integrity end-to-end
      zip_path = td_path / 'Rainy75V2-测试 发布包.zip'
      release_tool.write_release_zip(out_dir, zip_path)
      zip_verified = release_tool.verify_release_zip(zip_path)
      self.assertEqual(zip_verified['manifest']['version'], '0.2.0-test')

      # Verify LICENSE-NOTICE.txt and RESTORE-NOTICE.txt explicit wording
      lic_txt = (out_dir / 'LICENSE-NOTICE.txt').read_text('utf-8')
      self.assertIn('NOT released as a whole under the MIT License', lic_txt)
      rst_txt = (out_dir / release_tool.FIRMWARE_DIR_NAME / 'restore-images' / 'RESTORE-NOTICE.txt').read_text('utf-8')
      self.assertIn('NOT dumps or readbacks', rst_txt)

  def test_verifier_rejects_corrupted_artifacts_manifest_html_and_missing_notices(self):
    node_exe = release_tool.resolve_node_exe(None)
    self.assertIsNotNone(node_exe)

    with tempfile.TemporaryDirectory() as td:
      td_path = Path(td)
      staging = create_staged_fixture(td_path / 'staging')
      web_dir = td_path / 'web'
      web_dir.mkdir()
      (web_dir / 'entry.mjs').write_text('export const ok = true;\n', encoding='utf-8')
      html_entry = web_dir / 'index.html'
      html_entry.write_text('<!doctype html><html><body><script type="module" src="entry.mjs"></script></body></html>', 'utf-8')

      def build_clean(sub: str) -> Path:
        out = td_path / sub
        release_tool.assemble_release(
            staging=staging,
            html_entry=html_entry,
            node_exe=node_exe,
            out_dir=out,
            version='0.2.0-neg',
            root=ROOT,
        )
        return out

      # 1. Tamper firmware binary
      d1 = build_clean('case1')
      bin_p = d1 / release_tool.FIRMWARE_DIR_NAME / 'main-064' / 'rainy75v2-main.bin'
      data = bytearray(bin_p.read_bytes())
      data[0] ^= 0xFF
      bin_p.write_bytes(bytes(data))
      with self.assertRaises(ValueError):
        release_tool.verify_release_dir(d1)

      # 2. Corrupt embedded gzip JSON payload in HTML (even if SHA256SUMS updated, bundle validator must reject)
      d2 = build_clean('case2')
      html_p = d2 / release_tool.ONLINE_HTML_NAME
      html_raw = html_p.read_text('utf-8')
      # Flip payload inside rainy75-release-bundle
      html_tampered = html_raw.replace('"format":"rainy75v2-release-bundle/v1"', '"format":"tampered"')
      html_p.write_text(html_tampered, encoding='utf-8')
      manifest_p = d2 / 'RELEASE-MANIFEST.json'
      m_obj = json.loads(manifest_p.read_text('utf-8'))
      for f_rec in m_obj['files']:
        if f_rec['path'] == release_tool.ONLINE_HTML_NAME:
          f_rec['sha256'] = release_tool.sha256_file(html_p)
          f_rec['size'] = html_p.stat().st_size
      manifest_p.write_text(json.dumps(m_obj, ensure_ascii=False, indent=2), encoding='utf-8')
      recompute_release_checksums(d2)
      with self.assertRaises(ValueError):
        release_tool.verify_release_dir(d2)

      # 3. Missing license notice file
      d3 = build_clean('case3')
      (d3 / 'licenses' / 'Noto-OFL-1.1.txt').unlink()
      with self.assertRaises(ValueError):
        release_tool.verify_release_dir(d3)

      # 4. Missing RESTORE-NOTICE.txt
      d4 = build_clean('case4')
      (d4 / release_tool.FIRMWARE_DIR_NAME / 'restore-images' / 'RESTORE-NOTICE.txt').unlink()
      with self.assertRaises(ValueError):
        release_tool.verify_release_dir(d4)

      # 5. IPS manifest missing themeSlot in RELEASE-MANIFEST.json
      d5 = build_clean('case5')
      m5_p = d5 / 'RELEASE-MANIFEST.json'
      m5 = json.loads(m5_p.read_text('utf-8'))
      del m5['targets']['ips-base']['themeSlot']
      m5_p.write_text(json.dumps(m5, ensure_ascii=False, indent=2), encoding='utf-8')
      recompute_release_checksums(d5)
      with self.assertRaises(ValueError):
        release_tool.verify_release_dir(d5)

      # 6. Tamper ZIP entry -> verify_release_zip must raise ValueError
      d6 = build_clean('case6')
      z6 = td_path / 'tampered.zip'
      release_tool.write_release_zip(d6, z6)
      z6_bad = td_path / 'tampered2.zip'
      with zipfile.ZipFile(z6, 'r') as zin, zipfile.ZipFile(z6_bad, 'w') as zout:
        for item in zin.infolist():
          content = zin.read(item.filename)
          if item.filename.endswith('README-使用说明.md'):
            content = content + b'\nTAMPERED'
          zout.writestr(item, content)
      with self.assertRaises(ValueError):
        release_tool.verify_release_zip(z6_bad)


if __name__ == '__main__':
  unittest.main()
