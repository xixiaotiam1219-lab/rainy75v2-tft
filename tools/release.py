# SPDX-License-Identifier: MIT
"""Repeatable Rainy75 V2 TFT release builder, offline bundler, and verifier."""

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
from datetime import datetime, timezone
import gzip
import hashlib
import html
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = ROOT / 'tools'
if str(TOOLS_DIR) not in sys.path:
  sys.path.insert(0, str(TOOLS_DIR))

from main_profiles import MAIN_PROFILES  # noqa: E402
import assets as assets_tool  # noqa: E402
import fontpack as fontpack_tool  # noqa: E402

THEME_NAMES = ('pink', 'mint', 'mono')
ONLINE_HTML_NAME = 'Rainy75V2-定制与部署工作台.html'
LAUNCHER_CMD_NAME = '1-打开工作台（推荐点我）.cmd'
BACKEND_DIR_NAME = 'Windows便携后台'
FIRMWARE_DIR_NAME = '固件与素材'
DOCS_DIR_NAME = '说明文档'

REQUIRED_LICENSE_FILES = (
    'LICENSE-MIT.txt',
    'WOB-STOCK-NOTICE.txt',
    'WCH-SDK-NOTICE.txt',
    'Noto-OFL-1.1.txt',
    'NodeJS-LICENSE.txt',
    'node-hid-LICENSE.txt',
    'netease-elog-MIT.txt',
)

BACKEND_CMD_FILES = (
    '启动歌词与音量后台.cmd',
    '打开歌词控制台.cmd',
    '开启开机自启.cmd',
    '取消开机自启.cmd',
    '退出后台.cmd',
)

EXPECTED_ISP_LIB_SHA = (
    '8ede32a24e09344e86ecd74731069e19d6befa287bd6de2dd7c757c6f1d06a9e'
)
EXPECTED_IPS_STOCK_SHA = (
    '32defab7902e57eb972a577fc6cbf3a7e57bc772d59b99f11038370412b77f41'
)
MAIN_SHA_063B1 = (
    'bc575a6d7b19042048705248715a43a67a23c7f217ba0ac464c539a390f4d23b'
)
MAIN_SHA_064 = (
    '31a9eb80752c1f8c94951dd6e2e6776eeb216f47ba58919ca36f6e6d26f0e476'
)

JS_REGEX_PREV_KEYWORDS = frozenset({
    'return', 'throw', 'case', 'default', 'typeof', 'void', 'delete',
    'await', 'yield', 'in', 'instanceof', 'new', 'else', 'do', 'of',
})
JS_REGEX_PREV_PUNCT = frozenset({
    '(', '[', '{', ',', ';', ':', '?', '=', '+=', '-=', '*=', '/=', '%=',
    '&=', '|=', '^=', '<<=', '>>=', '>>>=', '**=', '&&=', '||=', '??=',
    '=>', '!', '~', '&', '|', '^', '*', '/', '%', '+', '-', '<', '>',
    '==', '===', '!=', '!==', '<=', '>=', '&&', '||', '??', '**',
})
ASI_CONTINUATION_OPS = frozenset({
    '=', ',', '+', '-', '*', '/', '%', '**', '&', '|', '^', '&&', '||', '??',
    '?', ':', '.', '?.', '=>', '==', '===', '!=', '!==', '<', '>', '<=', '>=',
    '(', '[', '{',
})


@dataclass(frozen=True)
class JsToken:
  kind: str  # WS, NL, COMMENT, STRING, TEMPLATE, REGEX, IDENT, NUMBER, PUNCT
  text: str
  start: int
  end: int


def sha256_bytes(data: bytes) -> str:
  return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
  h = hashlib.sha256()
  with path.open('rb') as fh:
    while chunk := fh.read(65536):
      h.update(chunk)
  return h.hexdigest()


def write_crlf_cmd(path: Path, text: str) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  normalized = text.replace('\r\n', '\n').replace('\r', '\n').replace('\n', '\r\n')
  if not normalized.endswith('\r\n'):
    normalized += '\r\n'
  path.write_bytes(normalized.encode('utf-8'))


def read_package_version(root: Path = ROOT) -> str:
  pkg = json.loads((root / 'package.json').read_text('utf-8'))
  return str(pkg.get('version') or '0.0.0')


def utc_now_iso() -> str:
  epoch = os.environ.get('SOURCE_DATE_EPOCH')
  if epoch is not None and epoch.strip().isdigit():
    dt = datetime.fromtimestamp(int(epoch.strip()), tz=timezone.utc)
  else:
    dt = datetime.now(tz=timezone.utc).replace(microsecond=0)
  return dt.strftime('%Y-%m-%dT%H:%M:%SZ')


def _find_by_sha(candidates: list[Path], expected_sha: str) -> Path | None:
  for candidate in candidates:
    if candidate and candidate.is_file() and sha256_file(candidate) == expected_sha:
      return candidate.resolve()
  return None


def _scan_dir_for_sha(directory: Path, expected_sha: str) -> Path | None:
  if not directory.is_dir():
    return None
  for entry in sorted(directory.iterdir()):
    if entry.is_file() and entry.suffix.lower() in ('.bin', '.a', '.otf'):
      if sha256_file(entry) == expected_sha:
        return entry.resolve()
  return None


def resolve_clang(explicit: str | None) -> Path | None:
  candidates: list[Path] = []
  if explicit:
    p = Path(explicit)
    if not p.is_file():
      raise FileNotFoundError(f'Specified --clang not found: {p}')
    return p.resolve()
  for env_name in ('RAINY75_CLANG', 'RAINY_CLANG', 'CLANG'):
    val = os.environ.get(env_name)
    if val:
      candidates.append(Path(val))
  for cmd in ('clang', 'clang.exe'):
    found = shutil.which(cmd)
    if found:
      candidates.append(Path(found))
  llvm_home = os.environ.get('LLVM_HOME')
  if llvm_home:
    candidates.append(Path(llvm_home) / 'bin' / 'clang.exe')
    candidates.append(Path(llvm_home) / 'bin' / 'clang')
  for env_dir in ('ProgramFiles', 'ProgramFiles(x86)'):
    base = os.environ.get(env_dir)
    if base:
      candidates.append(Path(base) / 'LLVM' / 'bin' / 'clang.exe')
  for posix_path in ('/usr/bin/clang', '/usr/local/bin/clang'):
    candidates.append(Path(posix_path))
  for c in candidates:
    if c.is_file():
      return c.resolve()
  return None


def resolve_node_exe(explicit: str | None) -> Path | None:
  if explicit:
    p = Path(explicit)
    if not p.is_file():
      raise FileNotFoundError(f'Specified --node-exe not found: {p}')
    return p.resolve()
  env_val = os.environ.get('RAINY75_NODE_EXE')
  if env_val and Path(env_val).is_file():
    return Path(env_val).resolve()
  for name in ('node.exe', 'node'):
    found = shutil.which(name)
    if found and Path(found).is_file():
      return Path(found).resolve()
  return None


def resolve_inputs(args: argparse.Namespace, root: Path = ROOT) -> dict[str, Path | None]:
  inputs_dir = root / 'inputs'

  def resolve_required(
      explicit: str | None,
      env_name: str,
      preferred_names: tuple[str, ...],
      expected_sha: str | None,
      label: str,
  ) -> Path:
    if explicit:
      p = Path(explicit)
      if not p.is_file():
        raise FileNotFoundError(f'{label} not found: {p}')
      if expected_sha and sha256_file(p) != expected_sha:
        raise ValueError(f'{label} SHA-256 mismatch for {p}')
      return p.resolve()
    cands: list[Path] = []
    if os.environ.get(env_name):
      cands.append(Path(os.environ[env_name]))
    for rel in preferred_names:
      cands.append(root / rel)
    if expected_sha:
      matched = _find_by_sha(cands, expected_sha) or _scan_dir_for_sha(inputs_dir, expected_sha)
      if matched:
        return matched
    else:
      for c in cands:
        if c.is_file():
          return c.resolve()
    raise FileNotFoundError(
        f'Missing {label}. Pass the explicit CLI flag or place the matching file under inputs/.'
    )

  ips_stock = resolve_required(
      args.ips_stock,
      'RAINY75_IPS_STOCK',
      ('inputs/ips-stock.bin',),
      EXPECTED_IPS_STOCK_SHA,
      'stock IPS binary (--ips-stock)',
  )
  main_063b1 = resolve_required(
      args.main_063beta1,
      'RAINY75_MAIN_063BETA1',
      ('inputs/main-063beta1.bin', 'inputs/main-stock.bin'),
      MAIN_SHA_063B1,
      'stock 0.63-beta1 main binary (--main-063beta1)',
  )
  main_064 = resolve_required(
      args.main_064,
      'RAINY75_MAIN_064',
      ('inputs/main-064.bin', 'inputs/main-core.bin', 'inputs/main-stock-064.bin', 'inputs/main-stock.bin'),
      MAIN_SHA_064,
      'stock 0.64 main binary (--main-064)',
  )
  libisp585 = resolve_required(
      args.libisp585,
      'RAINY75_LIBISP585',
      ('inputs/libISP585.a', 'vendor/libISP585.a'),
      EXPECTED_ISP_LIB_SHA,
      'WCH libISP585.a (--libisp585)',
  )

  noto_otf: Path | None = None
  if args.noto_otf:
    p = Path(args.noto_otf)
    if not p.is_file():
      raise FileNotFoundError(f'Noto OTF not found: {p}')
    if sha256_file(p) != fontpack_tool.SOURCE_SHA:
      raise ValueError(f'Noto OTF SHA-256 mismatch for {p}')
    noto_otf = p.resolve()
  else:
    otf_cands = [
        Path(os.environ['RAINY75_NOTO_OTF']) if os.environ.get('RAINY75_NOTO_OTF') else None,
        root / 'inputs' / 'NotoSansMonoCJKsc-Regular.otf',
        root / 'assets' / 'NotoSansMonoCJKsc-Regular.otf',
    ]
    noto_otf = _find_by_sha([c for c in otf_cands if c is not None], fontpack_tool.SOURCE_SHA)

  font_bin: Path | None = None
  if args.font_bin:
    p = Path(args.font_bin)
    if not p.is_file():
      raise FileNotFoundError(f'FONT.BIN not found: {p}')
    font_bin = p.resolve()
  elif noto_otf is None:
    font_cands = [
        Path(os.environ['RAINY75_FONT_BIN']) if os.environ.get('RAINY75_FONT_BIN') else None,
        root / 'build' / 'font' / 'FONT.BIN',
        root / 'inputs' / 'FONT.BIN',
        root / 'build' / 'ips-lyrics' / 'FONT.BIN',
    ]
    for c in font_cands:
      if c is not None and c.is_file():
        font_bin = c.resolve()
        break

  if noto_otf is None and font_bin is None:
    raise FileNotFoundError(
        'Missing font source or FONT.BIN. Provide --noto-otf or --font-bin.'
    )

  if args.html_entry:
    html_entry = Path(args.html_entry).resolve()
  else:
    studio = root / 'web' / 'studio.html'
    html_entry = (studio if studio.is_file() else root / 'web' / 'index.html').resolve()
  if not html_entry.is_file():
    raise FileNotFoundError(f'HTML entry not found: {html_entry}')

  clang = resolve_clang(args.clang)
  if clang is None:
    raise FileNotFoundError('clang executable not found. Pass --clang <path>.')
  node_exe = resolve_node_exe(args.node_exe)
  if node_exe is None:
    raise FileNotFoundError('node executable not found. Pass --node-exe <path>.')

  return {
      'ips_stock': ips_stock,
      'main_063beta1': main_063b1,
      'main_064': main_064,
      'libisp585': libisp585,
      'noto_otf': noto_otf,
      'font_bin': font_bin,
      'html_entry': html_entry,
      'clang': clang,
      'node_exe': node_exe,
  }


def prepare_staged_font(
    staging_font_dir: Path,
    noto_otf: Path | None,
    font_bin: Path | None,
    root: Path = ROOT,
) -> Path:
  if staging_font_dir.exists():
    shutil.rmtree(staging_font_dir)
  staging_font_dir.mkdir(parents=True, exist_ok=True)

  if noto_otf is not None:
    fontpack_tool.build(noto_otf, staging_font_dir)
  elif font_bin is not None:
    data = font_bin.read_bytes()
    fontpack_tool.Font20(data)
    (staging_font_dir / 'FONT.BIN').write_bytes(data)
    src_ofl = font_bin.parent / 'OFL-1.1.txt'
    fallback_ofl = root / 'licenses' / 'OFL-1.1.txt'
    if src_ofl.is_file():
      shutil.copy2(src_ofl, staging_font_dir / 'OFL-1.1.txt')
    elif fallback_ofl.is_file():
      shutil.copy2(fallback_ofl, staging_font_dir / 'OFL-1.1.txt')
    else:
      raise FileNotFoundError('OFL-1.1.txt not found beside FONT.BIN or in licenses/')

    src_notice = font_bin.parent / 'FONT-NOTICE.txt'
    if src_notice.is_file():
      shutil.copy2(src_notice, staging_font_dir / 'FONT-NOTICE.txt')
    else:
      (staging_font_dir / 'FONT-NOTICE.txt').write_text(
          'Rainy Lyrics Pixel 20\n'
          'Derived from Noto Sans CJK SC; SIL OFL-1.1.\n'
          'https://github.com/notofonts/noto-cjk\n',
          encoding='utf-8',
      )
  else:
    raise FileNotFoundError('Either noto_otf or font_bin must be provided')

  staged_bin = staging_font_dir / 'FONT.BIN'
  fontpack_tool.Font20(staged_bin.read_bytes())
  return staged_bin


def _run_build(cmd: list[str], cwd: Path) -> None:
  proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
  if proc.returncode != 0:
    raise RuntimeError(
        f'Command failed ({proc.returncode}): {" ".join(cmd)}\n'
        f'STDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}'
    )


def _copy_dir_clean(src: Path, dst: Path) -> None:
  if dst.exists():
    shutil.rmtree(dst)
  shutil.copytree(src, dst)


def resolve_riscv_march(clang_path: Path, explicit: str | None) -> str:
  if explicit:
    return explicit
  for march in ('rv32imac_zicsr_zifencei', 'rv32imac'):
    proc = subprocess.run(
        [str(clang_path), '--target=riscv32-none-elf', f'-march={march}', '-mabi=ilp32', '-fsyntax-only', '-x', 'c', '-'],
        input='int probe_fn(void) { return 0; }\n',
        capture_output=True,
        text=True,
    )
    if proc.returncode == 0:
      return march
  return 'rv32imac_zicsr_zifencei'


def build_staging_artifacts(
    resolved: dict[str, Path | None],
    staging_dir: Path,
    root: Path = ROOT,
    riscv_march: str | None = None,
) -> dict[str, Path]:
  if staging_dir.exists():
    shutil.rmtree(staging_dir)
  staging_dir.mkdir(parents=True, exist_ok=True)

  staged_font_dir = staging_dir / 'font'
  staged_font_bin = prepare_staged_font(
      staged_font_dir,
      resolved['noto_otf'],
      resolved['font_bin'],
      root=root,
  )

  build_py = root / 'tools' / 'build.py'
  keys_json = root / 'profiles' / 'keys.json'
  raw_out = staging_dir / 'raw-build'
  targets_dir = staging_dir / 'targets'
  targets_dir.mkdir(parents=True, exist_ok=True)
  march = resolve_riscv_march(resolved['clang'], riscv_march)
  clang_flag = ['--clang', str(resolved['clang']), '--riscv-march', march]

  def call_build(build_args: list[str]) -> None:
    _run_build([sys.executable, str(build_py), *build_args, '--out', str(raw_out)], cwd=root)

  # 1. main-064 & restore
  call_build([
      'main', '--stock', str(resolved['main_064']),
      '--isp-lib', str(resolved['libisp585']), *clang_flag,
  ])
  _copy_dir_clean(raw_out / 'main', targets_dir / 'main-064')
  shutil.rmtree(raw_out / 'main')

  call_build(['main', '--stock', str(resolved['main_064']), '--restore-stock'])
  _copy_dir_clean(raw_out / 'main-restore', targets_dir / 'main-064-restore')
  shutil.rmtree(raw_out / 'main-restore')

  # 2. main-063beta1 & restore
  call_build([
      'main', '--stock', str(resolved['main_063beta1']),
      '--isp-lib', str(resolved['libisp585']), *clang_flag,
  ])
  _copy_dir_clean(raw_out / 'main', targets_dir / 'main-063beta1')
  shutil.rmtree(raw_out / 'main')

  call_build(['main', '--stock', str(resolved['main_063beta1']), '--restore-stock'])
  _copy_dir_clean(raw_out / 'main-restore', targets_dir / 'main-063beta1-restore')
  shutil.rmtree(raw_out / 'main-restore')

  # 3. ips-base (theme pink, carrying themeSlot)
  call_build([
      'ips', '--stock', str(resolved['ips_stock']),
      '--theme', 'pink', '--keys', str(keys_json), *clang_flag,
  ])
  _copy_dir_clean(raw_out / 'ips', targets_dir / 'ips-base')
  shutil.rmtree(raw_out / 'ips')

  # 4. ips-lyrics (theme pink, carrying themeSlot + FONT.BIN)
  call_build([
      'ips', '--stock', str(resolved['ips_stock']),
      '--theme', 'pink', '--keys', str(keys_json),
      '--lyrics', '--font', str(staged_font_bin), *clang_flag,
  ])
  _copy_dir_clean(raw_out / 'ips-lyrics', targets_dir / 'ips-lyrics')
  shutil.rmtree(raw_out / 'ips-lyrics')

  # 5. ips-restore
  call_build(['ips', '--stock', str(resolved['ips_stock']), '--restore-stock'])
  _copy_dir_clean(raw_out / 'ips-restore', targets_dir / 'ips-restore')
  shutil.rmtree(raw_out / 'ips-restore')

  # 6. Original robot assets & previews for pink, mint, mono
  assets_dir = staging_dir / 'assets'
  assets_dir.mkdir(parents=True, exist_ok=True)
  for theme_name in THEME_NAMES:
    gif_path = assets_tool.generate(keys_json, theme_name, assets_dir)
    assets_tool.validate_cache_gif(gif_path, assets_tool.load(ROOT / 'profiles' / 'themes.json')[theme_name])

  return {
      'main-064': targets_dir / 'main-064',
      'main-064-restore': targets_dir / 'main-064-restore',
      'main-063beta1': targets_dir / 'main-063beta1',
      'main-063beta1-restore': targets_dir / 'main-063beta1-restore',
      'ips-base': targets_dir / 'ips-base',
      'ips-lyrics': targets_dir / 'ips-lyrics',
      'ips-restore': targets_dir / 'ips-restore',
      'font-dir': staged_font_dir,
      'font-bin': staged_font_bin,
      'assets-dir': assets_dir,
  }


# ---------------------------------------------------------------------------
# JS Lexical Tokenizer & ES Module Bundler (zero relative imports / offline)
# ---------------------------------------------------------------------------

def _scan_string(src: str, i: int) -> int:
  quote = src[i]
  i += 1
  n = len(src)
  while i < n:
    ch = src[i]
    if ch == '\\':
      i += 2
      continue
    if ch == quote:
      return i + 1
    i += 1
  raise ValueError('Unterminated JS string literal')


def _scan_regex(src: str, i: int) -> int:
  i += 1
  n = len(src)
  in_class = False
  while i < n:
    ch = src[i]
    if ch == '\\':
      i += 2
      continue
    if ch == '[':
      in_class = True
    elif ch == ']' and in_class:
      in_class = False
    elif ch == '/' and not in_class:
      i += 1
      while i < n and (src[i].isalpha()):
        i += 1
      return i
    elif ch in '\r\n':
      raise ValueError('Unterminated JS regex literal')
    i += 1
  raise ValueError('Unterminated JS regex literal')


def tokenize_js(src: str) -> list[JsToken]:
  tokens: list[JsToken] = []
  n = len(src)
  i = 0
  # Stack holds template expression nesting brace counts so nested `{}` inside `${...}` resume template cleanly.
  template_brace_stack: list[int] = []
  brace_depth = 0
  last_sig: JsToken | None = None

  def is_regex_allowed() -> bool:
    if last_sig is None:
      return True
    if last_sig.kind == 'IDENT' and last_sig.text in JS_REGEX_PREV_KEYWORDS:
      return True
    if last_sig.kind == 'PUNCT' and last_sig.text in JS_REGEX_PREV_PUNCT:
      return True
    return False

  def scan_template_chunk(start_idx: int, idx: int) -> int:
    nonlocal brace_depth, last_sig
    while idx < n:
      ch = src[idx]
      if ch == '\\':
        idx += 2
        continue
      if ch == '$' and idx + 1 < n and src[idx + 1] == '{':
        idx += 2
        tok = JsToken('TEMPLATE', src[start_idx:idx], start_idx, idx)
        tokens.append(tok)
        last_sig = tok
        template_brace_stack.append(brace_depth)
        brace_depth += 1
        return idx
      if ch == '`':
        idx += 1
        tok = JsToken('TEMPLATE', src[start_idx:idx], start_idx, idx)
        tokens.append(tok)
        last_sig = tok
        return idx
      idx += 1
    raise ValueError('Unterminated JS template literal')

  multi_punct = (
      '>>>=', '===', '!==', '>>>', '<<=', '>>=', '**=', '&&=', '||=', '??=',
      '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '++', '--', '<<', '>>',
      '**', '?.', '...', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  )

  while i < n:
    ch = src[i]
    if ch in '\r\n':
      j = i + 2 if ch == '\r' and i + 1 < n and src[i + 1] == '\n' else i + 1
      tokens.append(JsToken('NL', src[i:j], i, j))
      i = j
      continue
    if ch in ' \t\f\v':
      j = i + 1
      while j < n and src[j] in ' \t\f\v':
        j += 1
      tokens.append(JsToken('WS', src[i:j], i, j))
      i = j
      continue
    if ch == '/' and i + 1 < n and src[i + 1] == '/':
      j = i + 2
      while j < n and src[j] not in '\r\n':
        j += 1
      tokens.append(JsToken('COMMENT', src[i:j], i, j))
      i = j
      continue
    if ch == '/' and i + 1 < n and src[i + 1] == '*':
      end = src.find('*/', i + 2)
      if end < 0:
        raise ValueError('Unterminated JS block comment')
      j = end + 2
      kind = 'COMMENT'
      tokens.append(JsToken(kind, src[i:j], i, j))
      i = j
      continue
    if ch == '/' and is_regex_allowed():
      j = _scan_regex(src, i)
      tok = JsToken('REGEX', src[i:j], i, j)
      tokens.append(tok)
      last_sig = tok
      i = j
      continue
    if ch in ('"', "'"):
      j = _scan_string(src, i)
      tok = JsToken('STRING', src[i:j], i, j)
      tokens.append(tok)
      last_sig = tok
      i = j
      continue
    if ch == '`':
      i = scan_template_chunk(i, i + 1)
      continue
    if ch == '}' and template_brace_stack and brace_depth - 1 == template_brace_stack[-1]:
      brace_depth -= 1
      template_brace_stack.pop()
      i = scan_template_chunk(i, i + 1)
      continue
    if ch.isdigit() or (ch == '.' and i + 1 < n and src[i + 1].isdigit()):
      j = i + 1
      while j < n and (src[j].isalnum() or src[j] in '._'):
        if src[j] in 'eE' and j + 1 < n and src[j + 1] in '+-':
          j += 2
        else:
          j += 1
      tok = JsToken('NUMBER', src[i:j], i, j)
      tokens.append(tok)
      last_sig = tok
      i = j
      continue
    if ch.isalpha() or ch in ('_', '$'):
      j = i + 1
      while j < n and (src[j].isalnum() or src[j] in ('_', '$')):
        j += 1
      tok = JsToken('IDENT', src[i:j], i, j)
      tokens.append(tok)
      last_sig = tok
      i = j
      continue

    matched = ch
    for mp in multi_punct:
      if src.startswith(mp, i):
        matched = mp
        break
    if matched == '{':
      brace_depth += 1
    elif matched == '}':
      brace_depth = max(0, brace_depth - 1)
    tok = JsToken('PUNCT', matched, i, i + len(matched))
    tokens.append(tok)
    last_sig = tok
    i += len(matched)

  return tokens


def _next_sig(tokens: list[JsToken], idx: int, *, stop_on_nl: bool = False) -> int:
  n = len(tokens)
  while idx < n:
    k = tokens[idx].kind
    if k in ('WS', 'COMMENT'):
      idx += 1
      continue
    if k == 'NL' and not stop_on_nl:
      idx += 1
      continue
    return idx
  return n


def _unquote_js_string(raw: str) -> str:
  q = raw[0]
  body = raw[1:-1]
  return body.replace(f'\\{q}', q).replace('\\\\', '\\')


def _extract_binding_names(tokens: list[JsToken], start_idx: int) -> tuple[list[str], int]:
  """Parse identifier or destructuring pattern and return (bound_names, next_idx)."""
  n = len(tokens)
  i = _next_sig(tokens, start_idx)
  if i >= n:
    return ([], i)
  tok = tokens[i]
  if tok.kind == 'IDENT':
    return ([tok.text], i + 1)
  if tok.text not in ('{', '['):
    return ([], i)

  names: list[str] = []
  stack: list[str] = [tok.text]
  # For `{`, track whether we are reading property key vs bound value or nested default expr.
  expect_prop_key = [tok.text == '{']
  default_depth = 0
  in_default_expr = False
  i += 1
  while i < n and stack:
    k = tokens[i].kind
    t = tokens[i].text
    if k in ('WS', 'COMMENT', 'NL'):
      i += 1
      continue
    if in_default_expr:
      if t in ('(', '[', '{'):
        default_depth += 1
      elif t in (')', ']', '}'):
        if default_depth > 0:
          default_depth -= 1
        elif t in ('}', ']'):
          stack.pop()
          expect_prop_key.pop()
          in_default_expr = False
      elif t == ',' and default_depth == 0:
        in_default_expr = False
        if stack[-1] == '{':
          expect_prop_key[-1] = True
      i += 1
      continue
    if t in ('{', '['):
      stack.append(t)
      expect_prop_key.append(t == '{')
      i += 1
      continue
    if t in ('}', ']'):
      stack.pop()
      expect_prop_key.pop()
      i += 1
      continue
    if t == '=':
      in_default_expr = True
      default_depth = 0
      i += 1
      continue
    if t == ',':
      if stack[-1] == '{':
        expect_prop_key[-1] = True
      i += 1
      continue
    if t == ':':
      if stack[-1] == '{':
        expect_prop_key[-1] = False
      i += 1
      continue
    if k == 'IDENT':
      # Check if this `{ a, b: c }` key is shorthand (`a` followed by `,`, `}`, or `=`)
      if stack[-1] == '{' and expect_prop_key[-1]:
        nxt = _next_sig(tokens, i + 1)
        if nxt < n and tokens[nxt].text in (',', '}', '='):
          names.append(t)
      else:
        names.append(t)
      i += 1
      continue
    i += 1
  return (names, i)


def _find_decl_body_open(tokens: list[JsToken], start_idx: int) -> int:
  """Find `{` opening a function/class body while skipping `(...)` / `[...]` headers."""
  n = len(tokens)
  paren_depth = 0
  bracket_depth = 0
  cur = start_idx
  while cur < n:
    t = tokens[cur].text
    if tokens[cur].kind == 'PUNCT':
      if t == '(':
        paren_depth += 1
      elif t == ')':
        paren_depth = max(0, paren_depth - 1)
      elif t == '[':
        bracket_depth += 1
      elif t == ']':
        bracket_depth = max(0, bracket_depth - 1)
      elif t == '{' and paren_depth == 0 and bracket_depth == 0:
        return cur
    cur += 1
  raise ValueError('Missing { body in JS function/class export declaration')


def _find_matching_brace(tokens: list[JsToken], open_idx: int) -> int:
  n = len(tokens)
  depth = 0
  i = open_idx
  while i < n:
    t = tokens[i].text
    if tokens[i].kind == 'PUNCT':
      if t == '{':
        depth += 1
      elif t == '}':
        depth -= 1
        if depth == 0:
          return i + 1
    i += 1
  raise ValueError('Unclosed { block in JS export declaration')


def _find_stmt_end(src: str, tokens: list[JsToken], start_idx: int) -> int:
  """Find end token index (past `;` if present) for an ASI-aware statement."""
  n = len(tokens)
  i = start_idx
  depth = 0
  last_sig: JsToken | None = None
  while i < n:
    tok = tokens[i]
    if tok.kind in ('WS', 'COMMENT'):
      i += 1
      continue
    if tok.kind == 'NL':
      if depth == 0 and last_sig is not None and last_sig.text not in ASI_CONTINUATION_OPS:
        nxt = _next_sig(tokens, i + 1)
        if nxt >= n or tokens[nxt].text not in ('.', '?.', '(', '[', ',', ';', '=', ':'):
          return i + 1
      i += 1
      continue
    if tok.kind == 'PUNCT':
      if tok.text in ('(', '[', '{'):
        depth += 1
      elif tok.text in (')', ']', '}'):
        if depth == 0 and tok.text == '}':
          return i
        depth = max(0, depth - 1)
      elif tok.text == ';' and depth == 0:
        return i + 1
    last_sig = tok
    i += 1
  return n


def rewrite_es_module(
    src: str,
    module_id: str,
    resolve_dep,
) -> tuple[str, list[str]]:
  """Rewrite top-level static imports/exports for offline single-file execution."""
  tokens = tokenize_js(src)
  n = len(tokens)
  deps: list[str] = []
  replacements: list[tuple[int, int, str]] = []
  counter = 0

  def add_dep(spec: str) -> str:
    dep_id = resolve_dep(spec)
    if dep_id not in deps:
      deps.append(dep_id)
    return dep_id

  def next_tmp(prefix: str) -> str:
    nonlocal counter
    counter += 1
    return f'__{prefix}_{counter}'

  i = 0
  depth = 0
  prev_sig: JsToken | None = None

  while i < n:
    tok = tokens[i]
    if tok.kind in ('WS', 'COMMENT', 'NL'):
      i += 1
      continue

    if tok.kind == 'PUNCT':
      if tok.text in ('{', '(', '['):
        depth += 1
      elif tok.text in ('}', ')', ']'):
        depth = max(0, depth - 1)
      prev_sig = tok
      i += 1
      continue

    is_member_prop = prev_sig is not None and prev_sig.text in ('.', '?.')
    if depth == 0 and not is_member_prop and tok.kind == 'IDENT' and tok.text == 'import':
      j = _next_sig(tokens, i + 1)
      # Skip dynamic import(...) and import.meta
      if j < n and tokens[j].text in ('(', '.'):
        prev_sig = tok
        i += 1
        continue
      stmt_start = tok.start
      if j < n and tokens[j].kind == 'STRING':
        dep_id = add_dep(_unquote_js_string(tokens[j].text))
        end_i = _next_sig(tokens, j + 1)
        end_pos = tokens[end_i].end if (end_i < n and tokens[end_i].text == ';') else tokens[j].end
        next_i = end_i + 1 if (end_i < n and tokens[end_i].text == ';') else j + 1
        replacements.append((stmt_start, end_pos, f'await __req({json.dumps(dep_id)});'))
        i = next_i
        prev_sig = JsToken('PUNCT', ';', end_pos - 1, end_pos)
        continue

      # Parse import clauses until `from '<spec>'`
      default_name: str | None = None
      ns_name: str | None = None
      named_specs: list[tuple[str, str]] = []
      cur = j
      if cur < n and tokens[cur].kind == 'IDENT' and tokens[cur].text != 'from':
        default_name = tokens[cur].text
        cur = _next_sig(tokens, cur + 1)
        if cur < n and tokens[cur].text == ',':
          cur = _next_sig(tokens, cur + 1)
      if cur < n and tokens[cur].text == '*':
        cur = _next_sig(tokens, cur + 1)
        if cur < n and tokens[cur].text == 'as':
          cur = _next_sig(tokens, cur + 1)
          ns_name = tokens[cur].text
          cur = _next_sig(tokens, cur + 1)
      elif cur < n and tokens[cur].text == '{':
        cur = _next_sig(tokens, cur + 1)
        while cur < n and tokens[cur].text != '}':
          if tokens[cur].kind == 'IDENT' or tokens[cur].kind == 'STRING':
            imported = _unquote_js_string(tokens[cur].text) if tokens[cur].kind == 'STRING' else tokens[cur].text
            cur = _next_sig(tokens, cur + 1)
            local = imported
            if cur < n and tokens[cur].text == 'as':
              cur = _next_sig(tokens, cur + 1)
              local = tokens[cur].text
              cur = _next_sig(tokens, cur + 1)
            named_specs.append((imported, local))
          if cur < n and tokens[cur].text == ',':
            cur = _next_sig(tokens, cur + 1)
        if cur < n and tokens[cur].text == '}':
          cur = _next_sig(tokens, cur + 1)

      if cur >= n or tokens[cur].text != 'from':
        raise ValueError(f'Unsupported ES import syntax in {module_id} near offset {stmt_start}')
      spec_tok_i = _next_sig(tokens, cur + 1)
      if spec_tok_i >= n or tokens[spec_tok_i].kind != 'STRING':
        raise ValueError(f'Expected string literal in ES import from {module_id}')
      dep_id = add_dep(_unquote_js_string(tokens[spec_tok_i].text))
      semi_i = _next_sig(tokens, spec_tok_i + 1)
      has_semi = semi_i < n and tokens[semi_i].text == ';'
      end_pos = tokens[semi_i].end if has_semi else tokens[spec_tok_i].end
      next_i = semi_i + 1 if has_semi else spec_tok_i + 1

      tmp = next_tmp('imp')
      parts = [f'const {tmp}=await __req({json.dumps(dep_id)});']
      if default_name:
        parts.append(f'const {default_name}={tmp}.default;')
      if ns_name:
        parts.append(f'const {ns_name}={tmp};')
      if named_specs:
        items = ', '.join(k if k == v else f'{k}: {v}' for k, v in named_specs)
        parts.append(f'const {{{items}}}={tmp};')
      replacements.append((stmt_start, end_pos, ''.join(parts)))
      i = next_i
      prev_sig = JsToken('PUNCT', ';', end_pos - 1, end_pos)
      continue

    if depth == 0 and not is_member_prop and tok.kind == 'IDENT' and tok.text == 'export':
      exp_start = tok.start
      j = _next_sig(tokens, i + 1)
      if j >= n:
        raise ValueError(f'Unexpected EOF after export in {module_id}')

      # Case 1: export * [as ns] from '...'
      if tokens[j].text == '*':
        cur = _next_sig(tokens, j + 1)
        as_name: str | None = None
        if cur < n and tokens[cur].text == 'as':
          cur = _next_sig(tokens, cur + 1)
          as_name = tokens[cur].text
          cur = _next_sig(tokens, cur + 1)
        if cur >= n or tokens[cur].text != 'from':
          raise ValueError(f'Unsupported export * syntax in {module_id}')
        spec_i = _next_sig(tokens, cur + 1)
        dep_id = add_dep(_unquote_js_string(tokens[spec_i].text))
        semi_i = _next_sig(tokens, spec_i + 1)
        has_semi = semi_i < n and tokens[semi_i].text == ';'
        end_pos = tokens[semi_i].end if has_semi else tokens[spec_i].end
        next_i = semi_i + 1 if has_semi else spec_i + 1
        if as_name:
          tmp = next_tmp('reexp')
          rep = f'const {tmp}=await __req({json.dumps(dep_id)});__exp(__ns,{json.dumps(as_name)},()=>{tmp});'
        else:
          tmp = next_tmp('reexp')
          rep = f'const {tmp}=await __req({json.dumps(dep_id)});__reexp(__ns,{tmp});'
        replacements.append((exp_start, end_pos, rep))
        i = next_i
        prev_sig = JsToken('PUNCT', ';', end_pos - 1, end_pos)
        continue

      # Case 2: export { a, b as c } [from '...']
      if tokens[j].text == '{':
        cur = _next_sig(tokens, j + 1)
        specs: list[tuple[str, str]] = []
        while cur < n and tokens[cur].text != '}':
          if tokens[cur].kind in ('IDENT', 'STRING'):
            local = _unquote_js_string(tokens[cur].text) if tokens[cur].kind == 'STRING' else tokens[cur].text
            cur = _next_sig(tokens, cur + 1)
            exported = local
            if cur < n and tokens[cur].text == 'as':
              cur = _next_sig(tokens, cur + 1)
              exported = _unquote_js_string(tokens[cur].text) if tokens[cur].kind == 'STRING' else tokens[cur].text
              cur = _next_sig(tokens, cur + 1)
            specs.append((local, exported))
          if cur < n and tokens[cur].text == ',':
            cur = _next_sig(tokens, cur + 1)
        after_brace = _next_sig(tokens, cur + 1)
        if after_brace < n and tokens[after_brace].text == 'from':
          spec_i = _next_sig(tokens, after_brace + 1)
          dep_id = add_dep(_unquote_js_string(tokens[spec_i].text))
          semi_i = _next_sig(tokens, spec_i + 1)
          has_semi = semi_i < n and tokens[semi_i].text == ';'
          end_pos = tokens[semi_i].end if has_semi else tokens[spec_i].end
          next_i = semi_i + 1 if has_semi else spec_i + 1
          tmp = next_tmp('reexp')
          re_parts = [f'const {tmp}=await __req({json.dumps(dep_id)});']
          for local, exported in specs:
            re_parts.append(f'__exp(__ns,{json.dumps(exported)},()=>{tmp}[{json.dumps(local)}]);')
          replacements.append((exp_start, end_pos, ''.join(re_parts)))
        else:
          semi_i = after_brace
          has_semi = semi_i < n and tokens[semi_i].text == ';'
          end_pos = tokens[semi_i].end if has_semi else tokens[cur].end
          next_i = semi_i + 1 if has_semi else cur + 1
          ex_parts = [f'__exp(__ns,{json.dumps(exported)},()=>{local});' for local, exported in specs]
          replacements.append((exp_start, end_pos, ''.join(ex_parts)))
        i = next_i
        prev_sig = JsToken('PUNCT', ';', end_pos - 1, end_pos)
        continue

      # Case 3: export default ...
      if tokens[j].kind == 'IDENT' and tokens[j].text == 'default':
        k = _next_sig(tokens, j + 1)
        is_async = k < n and tokens[k].kind == 'IDENT' and tokens[k].text == 'async'
        k2 = _next_sig(tokens, k + 1) if is_async else k
        if k2 < n and tokens[k2].kind == 'IDENT' and tokens[k2].text in ('function', 'class'):
          k_name = _next_sig(tokens, k2 + 1)
          if tokens[k2].text == 'function' and k_name < n and tokens[k_name].text == '*':
            k_name = _next_sig(tokens, k_name + 1)
          if k_name < n and tokens[k_name].kind == 'IDENT' and tokens[k_name].text != 'extends':
            local_name = tokens[k_name].text
            cur_b = _find_decl_body_open(tokens, k_name + 1)
            body_end_i = _find_matching_brace(tokens, cur_b)
            decl_src = src[tokens[k].start:tokens[body_end_i - 1].end]
            replacements.append((
                exp_start,
                tokens[body_end_i - 1].end,
                f'{decl_src};__exp(__ns,"default",()=>{local_name});',
            ))
            i = body_end_i
            prev_sig = JsToken('PUNCT', ';', tokens[body_end_i - 1].end - 1, tokens[body_end_i - 1].end)
            continue
        tmp = next_tmp('defexp')
        stmt_end_i = _find_stmt_end(src, tokens, j + 1)
        expr_end_pos = tokens[stmt_end_i - 1].end
        expr_src = src[tokens[k].start:expr_end_pos].rstrip()
        if expr_src.endswith(';'):
          expr_src = expr_src[:-1]
        replacements.append((
            exp_start,
            expr_end_pos,
            f'const {tmp}={expr_src};__exp(__ns,"default",()=>{tmp});',
        ))
        i = stmt_end_i
        prev_sig = JsToken('PUNCT', ';', expr_end_pos - 1, expr_end_pos)
        continue

      # Case 4: export [async] function / class
      is_async = tokens[j].kind == 'IDENT' and tokens[j].text == 'async'
      decl_kw_i = _next_sig(tokens, j + 1) if is_async else j
      if decl_kw_i < n and tokens[decl_kw_i].kind == 'IDENT' and tokens[decl_kw_i].text in ('function', 'class'):
        name_i = _next_sig(tokens, decl_kw_i + 1)
        if tokens[decl_kw_i].text == 'function' and name_i < n and tokens[name_i].text == '*':
          name_i = _next_sig(tokens, name_i + 1)
        if name_i >= n or tokens[name_i].kind != 'IDENT':
          raise ValueError(f'Expected exported declaration name in {module_id}')
        name = tokens[name_i].text
        cur_b = _find_decl_body_open(tokens, name_i + 1)
        body_end_i = _find_matching_brace(tokens, cur_b)
        body_end_pos = tokens[body_end_i - 1].end
        decl_src = src[tokens[j].start:body_end_pos]
        replacements.append((
            exp_start,
            body_end_pos,
            f'{decl_src};__exp(__ns,{json.dumps(name)},()=>{name});',
        ))
        i = body_end_i
        prev_sig = JsToken('PUNCT', ';', body_end_pos - 1, body_end_pos)
        continue

      # Case 5: export const / let / var ...
      if tokens[j].kind == 'IDENT' and tokens[j].text in ('const', 'let', 'var'):
        cur = j + 1
        bound_names: list[str] = []
        while cur < n:
          names_here, cur = _extract_binding_names(tokens, cur)
          bound_names.extend(names_here)
          cur = _next_sig(tokens, cur)
          if cur < n and tokens[cur].text == '=':
            # Skip initializer expression until top-level `,` or `;` or ASI newline
            cur += 1
            init_depth = 0
            last_init_sig: JsToken | None = None
            stopped_stmt = False
            while cur < n:
              t_tok = tokens[cur]
              if t_tok.kind in ('WS', 'COMMENT'):
                cur += 1
                continue
              if t_tok.kind == 'NL':
                if init_depth == 0 and last_init_sig is not None and last_init_sig.text not in ASI_CONTINUATION_OPS:
                  nxt = _next_sig(tokens, cur + 1)
                  if nxt >= n or tokens[nxt].text not in ('.', '?.', '(', '[', ',', ';', '=', ':'):
                    cur += 1
                    stopped_stmt = True
                    break
                cur += 1
                continue
              if t_tok.kind == 'PUNCT':
                if t_tok.text in ('(', '[', '{'):
                  init_depth += 1
                elif t_tok.text in (')', ']', '}'):
                  init_depth = max(0, init_depth - 1)
                elif init_depth == 0 and t_tok.text == ',':
                  cur += 1
                  break
                elif init_depth == 0 and t_tok.text == ';':
                  cur += 1
                  stopped_stmt = True
                  break
              last_init_sig = t_tok
              cur += 1
            if stopped_stmt:
              break
            continue
          if cur < n and tokens[cur].text == ',':
            cur += 1
            continue
          if cur < n and tokens[cur].text == ';':
            cur += 1
          break
        stmt_end_pos = tokens[cur - 1].end
        decl_src = src[tokens[j].start:stmt_end_pos]
        if not decl_src.rstrip().endswith(';'):
          decl_src = decl_src + ';'
        exp_calls = ''.join(f'__exp(__ns,{json.dumps(nm)},()=>{nm});' for nm in bound_names)
        replacements.append((exp_start, stmt_end_pos, decl_src + exp_calls))
        i = cur
        prev_sig = JsToken('PUNCT', ';', stmt_end_pos - 1, stmt_end_pos)
        continue

      raise ValueError(f'Unsupported ES export syntax in {module_id}: export {tokens[j].text}')

    prev_sig = tok
    i += 1

  if not replacements:
    return src, deps
  out: list[str] = []
  cursor = 0
  for start, end, rep in replacements:
    out.append(src[cursor:start])
    out.append(rep)
    cursor = end
  out.append(src[cursor:])
  return ''.join(out), deps


def _escape_inline_script(js_text: str) -> str:
  return re.sub(r'</(script)', r'<\/\1', js_text, flags=re.IGNORECASE)


def _escape_inline_style(css_text: str) -> str:
  return re.sub(r'</(style)', r'<\/\1', css_text, flags=re.IGNORECASE)


def _escape_inline_json(json_text: str) -> str:
  return json_text.replace('</', '<\\/')


def _check_no_external_urls(text: str, source_label: str) -> None:
  if re.search(r'(?:src|href)\s*=\s*["\']https?://', text, re.IGNORECASE):
    raise ValueError(f'Forbidden external http(s) src/href in {source_label}')
  if re.search(r'@import\s+(?:url\s*\(\s*)?["\']?https?://', text, re.IGNORECASE):
    raise ValueError(f'Forbidden external @import URL in {source_label}')
  if re.search(r'url\s*\(\s*["\']?https?://', text, re.IGNORECASE):
    raise ValueError(f'Forbidden external CSS url(...) in {source_label}')


def _inline_css_imports(css_path: Path, seen: set[Path] | None = None) -> str:
  seen = set() if seen is None else seen
  resolved = css_path.resolve()
  if resolved in seen:
    return ''
  seen.add(resolved)
  text = resolved.read_text('utf-8')
  _check_no_external_urls(text, str(resolved))

  def replace_import(match: re.Match[str]) -> str:
    rel = match.group(1).strip().strip('"').strip("'")
    if re.match(r'^https?://', rel, re.IGNORECASE):
      raise ValueError(f'Forbidden external CSS @import in {resolved}: {rel}')
    target = (resolved.parent / rel).resolve()
    if not target.is_file():
      raise FileNotFoundError(f'Missing imported CSS file {rel} from {resolved}')
    return _inline_css_imports(target, seen)

  return re.sub(
      r'@import\s+(?:url\s*\(\s*)?(["\'][^"\']+["\'])\s*\)?\s*;',
      replace_import,
      text,
      flags=re.IGNORECASE,
  )


def bundle_html(
    html_entry: Path,
    release_bundle: dict | None = None,
    profiles_data: dict[str, dict] | None = None,
) -> str:
  """Bundle entry HTML, local CSS stylesheets, local ES modules, and offline JSON payload into one HTML string."""
  entry_path = html_entry.resolve()
  html_dir = entry_path.parent
  raw_html = entry_path.read_text('utf-8')
  _check_no_external_urls(raw_html, str(entry_path))

  # 1. Inline <link rel="stylesheet" href="...">
  link_re = re.compile(r'<link\b([^>]*?)>', re.IGNORECASE)

  def replace_link(match: re.Match[str]) -> str:
    attrs = match.group(1)
    rel_m = re.search(r'\brel\s*=\s*["\']([^"\']*)["\']', attrs, re.IGNORECASE)
    href_m = re.search(r'\bhref\s*=\s*["\']([^"\']*)["\']', attrs, re.IGNORECASE)
    if not rel_m or 'stylesheet' not in rel_m.group(1).lower().split():
      return match.group(0)
    if not href_m:
      return match.group(0)
    href = href_m.group(1).strip()
    if re.match(r'^https?://', href, re.IGNORECASE):
      raise ValueError(f'Forbidden external stylesheet CDN link: {href}')
    css_file = (html_dir / href).resolve()
    if not css_file.is_file():
      raise FileNotFoundError(f'Missing stylesheet referenced in HTML: {href}')
    css_text = _inline_css_imports(css_file)
    return f'<style>\n/* bundled: {href} */\n{_escape_inline_style(css_text)}\n</style>'

  bundled_html = link_re.sub(replace_link, raw_html)

  # 1b. Inline local <img ... src="..."> assets as deterministic base64 data URIs
  img_mime_map = {
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
  }
  img_re = re.compile(r'<img\b([^>]*?)>', re.IGNORECASE)

  def replace_img(match: re.Match[str]) -> str:
    attrs = match.group(1)
    src_m = re.search(r'(\bsrc\s*=\s*)(["\'])([^"\']*)\2', attrs, re.IGNORECASE)
    if not src_m:
      return match.group(0)
    raw_src = src_m.group(3).strip()
    if raw_src.startswith(('data:', 'blob:')):
      return match.group(0)
    if re.match(r'^https?://', raw_src, re.IGNORECASE):
      raise ValueError(f'Forbidden external image URL in offline HTML: {raw_src}')
    asset_file = (html_dir / raw_src).resolve()
    if not asset_file.is_file():
      raise FileNotFoundError(f'Missing local image asset referenced in HTML: {raw_src}')
    mime = img_mime_map.get(asset_file.suffix.lower())
    if not mime:
      raise ValueError(f'Unsupported image format in offline bundle: {raw_src}')
    b64_data = base64.b64encode(asset_file.read_bytes()).decode('ascii')
    data_uri = f'data:{mime};base64,{b64_data}'
    replaced_attrs = attrs[:src_m.start(3)] + data_uri + attrs[src_m.end(3):]
    return f'<img{replaced_attrs}>'

  bundled_html = img_re.sub(replace_img, bundled_html)

  # 2. Gather and bundle all <script type="module" ...> entries into deterministic factories
  module_factories: dict[str, str] = {}
  visiting: set[str] = set()
  inline_counter = 0

  def bundle_file_module(mod_path: Path) -> str:
    resolved = mod_path.resolve()
    try:
      mod_id = resolved.relative_to(html_dir).as_posix()
    except ValueError:
      mod_id = resolved.name
    if mod_id in module_factories or mod_id in visiting:
      return mod_id
    if not resolved.is_file():
      raise FileNotFoundError(f'Missing ES module imported by bundle: {resolved}')
    visiting.add(mod_id)
    src = resolved.read_text('utf-8')

    def dep_resolver(spec: str) -> str:
      if re.match(r'^https?://', spec, re.IGNORECASE):
        raise ValueError(f'Forbidden external module import in {mod_id}: {spec}')
      if not spec.startswith('.'):
        raise ValueError(f'Unsupported bare ES module specifier in {mod_id}: {spec}')
      dep_path = (resolved.parent / spec).resolve()
      return bundle_file_module(dep_path)

    rewritten, _deps = rewrite_es_module(src, mod_id, dep_resolver)
    visiting.remove(mod_id)
    module_factories[mod_id] = rewritten
    return mod_id

  def bundle_inline_module(src: str) -> str:
    nonlocal inline_counter
    inline_counter += 1
    mod_id = f'__inline_entry_{inline_counter}'

    def dep_resolver(spec: str) -> str:
      if re.match(r'^https?://', spec, re.IGNORECASE):
        raise ValueError(f'Forbidden external inline module import: {spec}')
      if not spec.startswith('.'):
        raise ValueError(f'Unsupported bare ES module specifier in inline script: {spec}')
      return bundle_file_module((html_dir / spec).resolve())

    rewritten, _deps = rewrite_es_module(src, mod_id, dep_resolver)
    module_factories[mod_id] = rewritten
    return mod_id

  script_re = re.compile(
      r'<script\b([^>]*)>([\s\S]*?)</script\s*>',
      re.IGNORECASE,
  )
  entry_ids: list[str] = []
  last_script_placeholder = '__RAINY75_BUNDLED_MODULE_PLACEHOLDER__'
  placed_placeholder = False

  def replace_script(match: re.Match[str]) -> str:
    nonlocal placed_placeholder
    attrs = match.group(1)
    body = match.group(2)
    type_m = re.search(r'\btype\s*=\s*["\']([^"\']*)["\']', attrs, re.IGNORECASE)
    src_m = re.search(r'\bsrc\s*=\s*["\']([^"\']*)["\']', attrs, re.IGNORECASE)
    if src_m and re.match(r'^https?://', src_m.group(1).strip(), re.IGNORECASE):
      raise ValueError(f'Forbidden external script CDN URL: {src_m.group(1)}')

    is_module = type_m is not None and type_m.group(1).strip().lower() == 'module'
    if is_module:
      if src_m:
        src_rel = src_m.group(1).strip()
        entry_ids.append(bundle_file_module((html_dir / src_rel).resolve()))
      else:
        entry_ids.append(bundle_inline_module(body))
      if not placed_placeholder:
        placed_placeholder = True
        return last_script_placeholder
      return ''

    if src_m:
      src_rel = src_m.group(1).strip()
      js_file = (html_dir / src_rel).resolve()
      if not js_file.is_file():
        raise FileNotFoundError(f'Missing classic script referenced in HTML: {src_rel}')
      return f'<script>\n{_escape_inline_script(js_file.read_text("utf-8"))}\n</script>'
    return match.group(0)

  bundled_html = script_re.sub(replace_script, bundled_html)

  # 3. Assemble single inline runtime + embedded offline bundle JSON + profile fetch fallback
  runtime_lines: list[str] = []
  if release_bundle is not None:
    bundle_json = json.dumps(release_bundle, ensure_ascii=False, separators=(',', ':'))
    runtime_lines.append(
        f'<script id="rainy75-release-bundle" type="application/json">{_escape_inline_json(bundle_json)}</script>'
    )

  if entry_ids or module_factories:
    js_parts: list[str] = [
        '(function(){',
        'const __bundleEl=typeof document!=="undefined"?document.getElementById("rainy75-release-bundle"):null;',
        'if(__bundleEl&&typeof globalThis.fetch==="function"){',
        '  try{',
        '    const __parsed=JSON.parse(__bundleEl.textContent||"{}");',
        '    globalThis.__RAINY75_RELEASE_BUNDLE__=__parsed;',
        '    const __prof=__parsed&&__parsed.profiles;',
        '    if(__prof){',
        '      const __nativeFetch=globalThis.fetch.bind(globalThis);',
        '      const __map={"keys.json":__prof.keys,"themes.json":__prof.themes,"font.json":__prof.font};',
        '      globalThis.fetch=async function(input,init){',
        '        const u=typeof input==="string"?input:(input&&input.url)||"";',
        '        const m=/(?:^|[\\/])profiles[\\/](keys\\.json|themes\\.json|font\\.json)(?:[?#].*)?$/.exec(u);',
        '        if(m&&__map[m[1]]){',
        '          const okFile=typeof location!=="undefined"&&location.protocol==="file:";',
        '          if(okFile)return new Response(JSON.stringify(__map[m[1]]),{status:200,headers:{"content-type":"application/json"}});',
        '          try{const r=await __nativeFetch(input,init);if(r&&r.ok)return r;}catch{}',
        '          return new Response(JSON.stringify(__map[m[1]]),{status:200,headers:{"content-type":"application/json"}});',
        '        }',
        '        return __nativeFetch(input,init);',
        '      };',
        '    }',
        '  }catch{}',
        '}',
        '})();',
    ]
    if profiles_data and release_bundle is None:
      # Useful for HTML-only bundle calls without firmware payloads
      inline_prof = json.dumps(profiles_data, ensure_ascii=False, separators=(',', ':'))
      js_parts.append(
          f'globalThis.__RAINY75_EMBEDDED_PROFILES__={_escape_inline_script(inline_prof)};'
      )

    js_parts.extend([
        'const __modules=Object.create(null);',
        'const __cache=Object.create(null);',
        'function __def(id,factory){__modules[id]=factory;}',
        'function __exp(ns,name,getter){Object.defineProperty(ns,name,{enumerable:true,configurable:true,get:getter});}',
        'function __reexp(target,source){for(const k of Object.keys(source)){if(k==="default"||k==="__esModule")continue;Object.defineProperty(target,k,{enumerable:true,configurable:true,get:()=>source[k]});}}',
        'async function __req(id){',
        '  if(__cache[id])return __cache[id];',
        '  const factory=__modules[id];',
        '  if(!factory)throw new Error("Missing bundled module: "+id);',
        '  const ns=Object.create(null);',
        '  __cache[id]=ns;',
        '  await factory(ns,__req,__exp,__reexp);',
        '  return ns;',
        '}',
    ])
    for mod_id, code in module_factories.items():
      safe_code = _escape_inline_script(code)
      js_parts.append(
          f'__def({json.dumps(mod_id)},async(__ns,__req,__exp,__reexp)=>{{\n{safe_code}\n}});'
      )
    for eid in entry_ids:
      js_parts.append(f'await __req({json.dumps(eid)});')

    bundled_module_js = '\n'.join(js_parts)
    runtime_lines.append(f'<script type="module">\n{bundled_module_js}\n</script>')

  replacement_block = '\n'.join(runtime_lines)
  if placed_placeholder:
    bundled_html = bundled_html.replace(last_script_placeholder, replacement_block, 1)
  elif replacement_block:
    idx = bundled_html.rfind('</body>')
    if idx >= 0:
      bundled_html = bundled_html[:idx] + replacement_block + '\n' + bundled_html[idx:]
    else:
      bundled_html = bundled_html + '\n' + replacement_block

  return bundled_html


def verify_release_html(
    html_text: str,
    *,
    require_bundle_payload: bool = True,
    check_node_syntax: bool = True,
) -> dict:
  """Verify zero CDN links, no leftover relative module imports, valid JSON payload, and valid JS syntax."""
  _check_no_external_urls(html_text, 'offline HTML')

  if re.search(r'<script\b[^>]*\bsrc\s*=', html_text, re.IGNORECASE):
    raise ValueError('Offline HTML still contains an external <script src=...>')
  if re.search(r'<link\b[^>]*\brel\s*=\s*["\'][^"\']*stylesheet[^"\']*["\'][^>]*\bhref\s*=', html_text, re.IGNORECASE):
    raise ValueError('Offline HTML still contains an external <link rel="stylesheet" href=...>')
  for img_src in re.findall(r'<img\b[^>]*\bsrc\s*=\s*["\']([^"\']*)["\']', html_text, re.IGNORECASE):
    if not img_src.strip().startswith(('data:', 'blob:')):
      raise ValueError(f'Offline HTML still contains non-inlined <img src="{img_src}">')

  module_scripts = re.findall(
      r'<script\b[^>]*\btype\s*=\s*["\']module["\'][^>]*>([\s\S]*?)</script\s*>',
      html_text,
      re.IGNORECASE,
  )
  for ms in module_scripts:
    tokens = tokenize_js(ms)
    depth = 0
    for idx, tok in enumerate(tokens):
      if tok.kind == 'PUNCT':
        if tok.text in ('{', '(', '['):
          depth += 1
        elif tok.text in ('}', ')', ']'):
          depth = max(0, depth - 1)
      elif depth == 0 and tok.kind == 'IDENT' and tok.text in ('import', 'export'):
        nxt = _next_sig(tokens, idx + 1)
        if tok.text == 'import' and nxt < len(tokens) and tokens[nxt].text in ('(', '.'):
          continue
        raise ValueError(f'Offline HTML module script still contains unbundled ES {tok.text}')

  if check_node_syntax and module_scripts:
    node_exe = resolve_node_exe(None)
    if node_exe is not None:
      with tempfile.TemporaryDirectory() as td:
        for idx, ms in enumerate(module_scripts):
          tmp_mjs = Path(td) / f'bundle_{idx}.mjs'
          tmp_mjs.write_text(ms, encoding='utf-8')
          proc = subprocess.run([str(node_exe), '--check', str(tmp_mjs)], capture_output=True, text=True)
          if proc.returncode != 0:
            raise ValueError(f'Node syntax check failed for bundled module script: {proc.stderr or proc.stdout}')

  bundle_match = re.search(
      r'<script\b[^>]*\bid\s*=\s*["\']rainy75-release-bundle["\'][^>]*>([\s\S]*?)</script\s*>',
      html_text,
      re.IGNORECASE,
  )
  bundle_obj: dict = {}
  if require_bundle_payload:
    if not bundle_match:
      raise ValueError('Offline HTML missing <script id="rainy75-release-bundle"> payload')
    raw_json = bundle_match.group(1).replace('<\\/', '</')
    try:
      bundle_obj = json.loads(raw_json)
    except Exception as exc:
      raise ValueError(f'Corrupt rainy75-release-bundle JSON: {exc}') from exc
    if bundle_obj.get('format') != 'rainy75v2-release-bundle/v1':
      raise ValueError('Unexpected rainy75-release-bundle format')

    for section_name, key_field in (('firmware', 'binGzipBase64'), ('assets', 'gifGzipBase64')):
      section = bundle_obj.get(section_name)
      if not isinstance(section, dict) or not section:
        raise ValueError(f'Offline bundle missing {section_name} entries')
      for name, entry in section.items():
        raw_b64 = entry.get(key_field)
        if not raw_b64:
          raise ValueError(f'Offline bundle entry {section_name}.{name} missing {key_field}')
        try:
          decompressed = gzip.decompress(base64.b64decode(raw_b64))
        except Exception as exc:
          raise ValueError(f'Corrupt gzip payload in {section_name}.{name}: {exc}') from exc
        if sha256_bytes(decompressed) != entry.get('sha256') or len(decompressed) != entry.get('size'):
          raise ValueError(f'Decompressed payload mismatch in {section_name}.{name}')

    font_entry = bundle_obj.get('font')
    if not isinstance(font_entry, dict) or not font_entry.get('binGzipBase64'):
      raise ValueError('Offline bundle missing font payload')
    font_bytes = gzip.decompress(base64.b64decode(font_entry['binGzipBase64']))
    if sha256_bytes(font_bytes) != font_entry.get('sha256') or len(font_bytes) != font_entry.get('size'):
      raise ValueError('Offline bundle font payload SHA/size mismatch')
    fontpack_tool.Font20(font_bytes)

  return {'moduleCount': len(module_scripts), 'bundle': bundle_obj}


def _gz_b64(data: bytes) -> str:
  # mtime=0 makes gzip output byte-deterministic across rebuilds
  return base64.b64encode(gzip.compress(data, compresslevel=9, mtime=0)).decode('ascii')


def _load_target_entry(target_dir: Path, bin_name: str) -> dict:
  bin_path = target_dir / bin_name
  manifest_path = target_dir / 'manifest.json'
  if not bin_path.is_file() or not manifest_path.is_file():
    raise FileNotFoundError(f'Target directory incomplete: {target_dir}')
  data = bin_path.read_bytes()
  manifest = json.loads(manifest_path.read_text('utf-8'))
  actual_sha = sha256_bytes(data)
  if manifest.get('sha256') != actual_sha:
    raise ValueError(f'Manifest SHA mismatch in {manifest_path}')
  return {
      'manifest': manifest,
      'binGzipBase64': _gz_b64(data),
      'sha256': actual_sha,
      'size': len(data),
  }


def collect_licenses(out_licenses_dir: Path, node_exe: Path | None = None, root: Path = ROOT) -> None:
  out_licenses_dir.mkdir(parents=True, exist_ok=True)
  shutil.copy2(root / 'LICENSE', out_licenses_dir / 'LICENSE-MIT.txt')
  shutil.copy2(root / 'licenses' / 'OFL-1.1.txt', out_licenses_dir / 'Noto-OFL-1.1.txt')
  shutil.copy2(root / 'licenses' / 'netease-elog-MIT.txt', out_licenses_dir / 'netease-elog-MIT.txt')

  disclaimer_text = (root / 'DISCLAIMER.md').read_text('utf-8') if (root / 'DISCLAIMER.md').is_file() else ''
  notices_text = (root / 'THIRD_PARTY_NOTICES.md').read_text('utf-8') if (root / 'THIRD_PARTY_NOTICES.md').is_file() else ''

  (out_licenses_dir / 'WOB-STOCK-NOTICE.txt').write_text(
      'WOBKEY / Stock Factory Firmware Notice\n'
      '======================================\n\n'
      'Stock firmware binaries (0.63-beta1, 0.64, stock IPS) and any restore images\n'
      'reconstructed from matched factory inputs remain the property of their\n'
      'respective copyright holders and are NOT covered by the MIT License.\n\n'
      'Restore images included in this package are built from matched factory inputs,\n'
      'NOT device flash readbacks.\n\n'
      '--- Repository THIRD_PARTY_NOTICES.md excerpt ---\n'
      + notices_text.strip()
      + '\n\n--- Repository DISCLAIMER.md excerpt ---\n'
      + disclaimer_text.strip()
      + '\n',
      encoding='utf-8',
  )

  (out_licenses_dir / 'WCH-SDK-NOTICE.txt').write_text(
      'WCH CH58x ISP / USB SDK Notice (libISP585.a)\n'
      '============================================\n\n'
      'The WCH CH58x ISP static library (libISP585.a) linked into custom main\n'
      'controller builds is provided by Nanjing Qinheng Microelectronics Co., Ltd. (WCH)\n'
      'under its vendor SDK terms and is NOT licensed under the MIT License.\n',
      encoding='utf-8',
  )

  node_license_src = node_exe.parent / 'LICENSE' if node_exe is not None else None
  if node_license_src and node_license_src.is_file():
    shutil.copy2(node_license_src, out_licenses_dir / 'NodeJS-LICENSE.txt')
  else:
    (out_licenses_dir / 'NodeJS-LICENSE.txt').write_text(
        'Node.js Runtime License Notice\n'
        '==============================\n\n'
        'This bundle includes an unmodified Node.js binary runtime (Windows x64).\n'
        'Node.js is licensed for use as follows (MIT License, plus bundled third-party\n'
        'components including V8, OpenSSL, libuv, zlib, c-ares, nghttp2, llhttp):\n'
        'https://github.com/nodejs/node/blob/main/LICENSE\n\n'
        'Copyright Node.js contributors. All rights reserved.\n'
        'Permission is hereby granted, free of charge, to any person obtaining a copy\n'
        'of this software and associated documentation files (the "Software"), to\n'
        'deal in the Software without restriction, including without limitation the\n'
        'rights to use, copy, modify, merge, publish, distribute, sublicense, and/or\n'
        'sell copies of the Software, subject to the full Node.js LICENSE terms.\n',
        encoding='utf-8',
    )

  hid_parts: list[str] = [
      'Bundled node-hid, hidapi, and pkg-prebuilds Licenses\n'
      '===================================================\n'
  ]
  hid_license_candidates = (
      ('node-hid/LICENSE-bsd.txt', root / 'node_modules' / 'node-hid' / 'LICENSE-bsd.txt'),
      ('node-hid/hidapi/LICENSE-bsd.txt', root / 'node_modules' / 'node-hid' / 'hidapi' / 'LICENSE-bsd.txt'),
      ('node-hid/hidapi/LICENSE-orig.txt', root / 'node_modules' / 'node-hid' / 'hidapi' / 'LICENSE-orig.txt'),
      ('pkg-prebuilds/LICENSE', root / 'node_modules' / 'pkg-prebuilds' / 'LICENSE'),
  )
  for label, path in hid_license_candidates:
    if path.is_file():
      hid_parts.append(f'\n--- {label} ---\n' + path.read_text('utf-8').strip())
  (out_licenses_dir / 'node-hid-LICENSE.txt').write_text('\n'.join(hid_parts) + '\n', encoding='utf-8')


def write_license_notice(path: Path, version: str) -> None:
  path.write_text(
      f'Rainy75 V2 TFT Release {version} — Mixed License & Notice Summary\n'
      '=====================================================================\n\n'
      'IMPORTANT / 重要声明:\n'
      'This Release package contains mixed third-party licenses and proprietary\n'
      'vendor binary components. It is NOT released as a whole under the MIT License.\n'
      '本发布包包含多种混合第三方许可及原厂/SDK 二进制组件，整体并非单一 MIT 许可分发！\n\n'
      'Free Distribution / 免费获取声明:\n'
      '免费项目，严禁倒卖。请勿原包转售、简单改名收费或冒充项目作者、WOB 售卖。\n'
      'Project free download: https://github.com/xixiaotiam1219-lab/rainy75v2-tft/releases\n'
      'This author request does not add to or change the MIT License terms.\n'
      '此为作者立场，不增加或修改 MIT 许可限制；第三方组件保留各自许可。\n\n'
      'Included Components & Licenses (see licenses/ folder):\n'
      '- Repository source code (tools/, web/, desktop/, C patches): MIT License -> licenses/LICENSE-MIT.txt\n'
      '- Stock & matched-restore firmware inputs (0.63-beta1, 0.64, IPS stock): Vendor notices -> licenses/WOB-STOCK-NOTICE.txt\n'
      '- WCH CH58x ISP static library (libISP585.a): WCH SDK terms -> licenses/WCH-SDK-NOTICE.txt\n'
      '- Pixel bitmap font FONT.BIN (Noto Sans CJK SC derived): SIL OFL-1.1 -> licenses/Noto-OFL-1.1.txt\n'
      '- Portable Node.js runtime (runtime/node.exe): Node.js License -> licenses/NodeJS-LICENSE.txt\n'
      '- Windows x64 node-hid + hidapi + pkg-prebuilds: BSD-3-Clause / MIT / HIDAPI -> licenses/node-hid-LICENSE.txt\n'
      '- NetEase timeline helper notice: MIT -> licenses/netease-elog-MIT.txt\n\n'
      'Restore Image Notice:\n'
      'All *-restore.bin firmware images are reconstructed from matched factory\n'
      'firmware inputs and are NOT readbacks from any physical keyboard flash chip.\n',
      encoding='utf-8',
  )


def copy_portable_windows_backend(
    backend_dir: Path,
    node_exe: Path,
    font_dir: Path,
    root: Path = ROOT,
) -> None:
  if backend_dir.exists():
    shutil.rmtree(backend_dir)
  runtime_dir = backend_dir / 'runtime'
  app_dir = backend_dir / 'app'
  desktop_out = app_dir / 'desktop'
  web_out = app_dir / 'web'
  data_dir = backend_dir / 'data'

  runtime_dir.mkdir(parents=True, exist_ok=True)
  desktop_out.mkdir(parents=True, exist_ok=True)
  web_out.mkdir(parents=True, exist_ok=True)
  data_dir.mkdir(parents=True, exist_ok=True)
  (data_dir / '.keep').write_text('Portable Rainy75 V2 background data directory.\n', encoding='utf-8')

  shutil.copy2(node_exe, runtime_dir / 'node.exe')

  for entry in sorted((root / 'desktop').iterdir()):
    if entry.is_file() and entry.suffix.lower() in ('.cjs', '.ps1', '.html'):
      shutil.copy2(entry, desktop_out / entry.name)

  for web_name in ('hid.mjs', 'protocol.mjs', 'font.mjs'):
    shutil.copy2(root / 'web' / web_name, web_out / web_name)

  for f_name in ('FONT.BIN', 'OFL-1.1.txt', 'FONT-NOTICE.txt'):
    src = font_dir / f_name
    if not src.is_file():
      raise FileNotFoundError(f'Missing {f_name} in staged font dir {font_dir}')
    shutil.copy2(src, app_dir / f_name)

  # Trim node-hid & pkg-prebuilds to runtime files needed on Windows x64
  nm_out = app_dir / 'node_modules'
  node_hid_src = root / 'node_modules' / 'node-hid'
  node_hid_dst = nm_out / 'node-hid'
  for rel in (
      Path('package.json'),
      Path('nodehid.js'),
      Path('binding-options.js'),
      Path('prebuilds') / 'HID-win32-x64' / 'node-napi-v4.node',
      Path('LICENSE-bsd.txt'),
      Path('hidapi') / 'LICENSE-bsd.txt',
      Path('hidapi') / 'LICENSE-orig.txt',
  ):
    src = node_hid_src / rel
    if src.is_file():
      dst = node_hid_dst / rel
      dst.parent.mkdir(parents=True, exist_ok=True)
      shutil.copy2(src, dst)

  pkg_pb_src = root / 'node_modules' / 'pkg-prebuilds'
  pkg_pb_dst = nm_out / 'pkg-prebuilds'
  for rel in (
      Path('package.json'),
      Path('bindings.js'),
      Path('lib') / 'prebuild.js',
      Path('LICENSE'),
  ):
    src = pkg_pb_src / rel
    if src.is_file():
      dst = pkg_pb_dst / rel
      dst.parent.mkdir(parents=True, exist_ok=True)
      shutil.copy2(src, dst)

  common_header = (
      '@echo off\n'
      'setlocal\n'
      'chcp 65001 >nul\n'
      'set "BACKEND=%~dp0"\n'
      'set "NODE_EXE=%BACKEND%runtime\\node.exe"\n'
      'set "LAUNCH_JS=%BACKEND%app\\desktop\\launch.cjs"\n'
      'set "STARTUP_PS1=%BACKEND%app\\desktop\\startup.ps1"\n'
      'set "RAINY75_DATA=%BACKEND%data"\n'
      'set "RAINY75_FONT=%BACKEND%app\\FONT.BIN"\n'
  )

  write_crlf_cmd(
      backend_dir / '启动歌词与音量后台.cmd',
      common_header
      + 'if not exist "%NODE_EXE%" goto :missing_node\n'
      'for /f "usebackq delims=" %%U in (`""%NODE_EXE%" "%LAUNCH_JS%""`) do set "BRIDGE_URL=%%U"\n'
      'if errorlevel 1 goto :failed\n'
      'echo [Rainy75 V2] 歌词与音量后台已启动：%BRIDGE_URL%\n'
      'exit /b 0\n'
      ':missing_node\n'
      'echo [错误] 未找到便携 Node.js："%NODE_EXE%"\n'
      'pause\n'
      'exit /b 1\n'
      ':failed\n'
      'echo [错误] 启动后台失败，请查看 "%RAINY75_DATA%\\background-error.log"\n'
      'pause\n'
      'exit /b 1\n',
  )

  write_crlf_cmd(
      backend_dir / '打开歌词控制台.cmd',
      common_header
      + 'if not exist "%NODE_EXE%" goto :missing_node\n'
      'for /f "usebackq delims=" %%U in (`""%NODE_EXE%" "%LAUNCH_JS%""`) do set "BRIDGE_URL=%%U"\n'
      'if errorlevel 1 goto :failed\n'
      'echo [Rainy75 V2] 正在打开歌词控制台：%BRIDGE_URL%\n'
      'start "" "%BRIDGE_URL%"\n'
      'exit /b 0\n'
      ':missing_node\n'
      'echo [错误] 未找到便携 Node.js："%NODE_EXE%"\n'
      'pause\n'
      'exit /b 1\n'
      ':failed\n'
      'echo [错误] 无法拉起歌词控制台，请查看 "%RAINY75_DATA%\\background-error.log"\n'
      'pause\n'
      'exit /b 1\n',
  )

  write_crlf_cmd(
      backend_dir / '开启开机自启.cmd',
      common_header
      + 'if not exist "%NODE_EXE%" goto :missing_node\n'
      '"%NODE_EXE%" "%LAUNCH_JS%" >nul\n'
      'if errorlevel 1 goto :failed\n'
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%STARTUP_PS1%" -Action Enable -DataDirectory "%RAINY75_DATA%"\n'
      'if errorlevel 1 goto :failed\n'
      'echo [Rainy75 V2] 已开启当前用户 Windows 开机自启。\n'
      'exit /b 0\n'
      ':missing_node\n'
      'echo [错误] 未找到便携 Node.js："%NODE_EXE%"\n'
      'pause\n'
      'exit /b 1\n'
      ':failed\n'
      'echo [错误] 开启开机自启失败。\n'
      'pause\n'
      'exit /b 1\n',
  )

  write_crlf_cmd(
      backend_dir / '取消开机自启.cmd',
      common_header
      + 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%STARTUP_PS1%" -Action Disable -DataDirectory "%RAINY75_DATA%"\n'
      'if errorlevel 1 goto :failed\n'
      'echo [Rainy75 V2] 已取消开机自启。\n'
      'exit /b 0\n'
      ':failed\n'
      'echo [错误] 取消开机自启失败。\n'
      'pause\n'
      'exit /b 1\n',
  )

  stop_js = (
      "const fs=require('fs'),http=require('http');const p=process.argv[1];"
      "if(!fs.existsSync(p)){console.log('[Rainy75 V2] 后台当前未运行。');process.exit(0);}"
      "const s=JSON.parse(fs.readFileSync(p,'utf8'));"
      "const req=http.request(s.url+'/stop',{method:'POST'},res=>{res.resume();console.log('[Rainy75 V2] 已向后台发送停止指令。');});"
      "req.on('error',()=>{try{fs.unlinkSync(p)}catch{}console.log('[Rainy75 V2] 已清理残留后台状态文件。');});"
      "req.setTimeout(1500,()=>{req.destroy();});req.end();"
  )
  write_crlf_cmd(
      backend_dir / '退出后台.cmd',
      common_header
      + 'if not exist "%NODE_EXE%" goto :missing_node\n'
      f'"%NODE_EXE%" -e "{stop_js}" "%RAINY75_DATA%\\background-service.json"\n'
      'exit /b 0\n'
      ':missing_node\n'
      'echo [错误] 未找到便携 Node.js："%NODE_EXE%"\n'
      'pause\n'
      'exit /b 1\n',
  )


def write_top_launcher_cmd(release_dir: Path) -> None:
  write_crlf_cmd(
      release_dir / LAUNCHER_CMD_NAME,
      '@echo off\n'
      'setlocal\n'
      'chcp 65001 >nul\n'
      'set "ROOT=%~dp0"\n'
      f'set "BACKEND=%ROOT%{BACKEND_DIR_NAME}"\n'
      'set "NODE_EXE=%BACKEND%\\runtime\\node.exe"\n'
      'set "GUI_SERVER=%BACKEND%\\app\\desktop\\gui-server.cjs"\n'
      f'set "HTML_ENTRY=%ROOT%{ONLINE_HTML_NAME}"\n'
      'set "RAINY75_DATA=%BACKEND%\\data"\n'
      'set "RAINY75_FONT=%BACKEND%\\app\\FONT.BIN"\n'
      'if not exist "%NODE_EXE%" goto :missing_node\n'
      'if not exist "%GUI_SERVER%" goto :missing_server\n'
      'if not exist "%HTML_ENTRY%" goto :missing_html\n'
      'echo [Rainy75 V2] 正在启动本地定制与部署工作台服务...\n'
      'echo [Rainy75 V2] 仅监听 127.0.0.1；刷机前可通过页面安全停用后台释放 USB HID。\n'
      'echo.\n'
      '"%NODE_EXE%" "%GUI_SERVER%" --html "%HTML_ENTRY%" --port 8765 --open\n'
      'if errorlevel 1 goto :failed\n'
      'exit /b 0\n'
      ':missing_node\n'
      'echo [错误] 未找到便携 Node.js 运行时："%NODE_EXE%"\n'
      'pause\n'
      'exit /b 1\n'
      ':missing_server\n'
      'echo [错误] 未找到工作台服务脚本："%GUI_SERVER%"\n'
      'pause\n'
      'exit /b 1\n'
      ':missing_html\n'
      'echo [错误] 未找到离线工作台 HTML："%HTML_ENTRY%"\n'
      'pause\n'
      'exit /b 1\n'
      ':failed\n'
      'echo.\n'
      'echo [错误] 本地工作台服务异常退出（错误码 %errorlevel%）。\n'
      'pause\n'
      'exit /b 1\n',
  )


def assemble_release(
    *,
    staging: dict[str, Path],
    html_entry: Path,
    node_exe: Path,
    out_dir: Path,
    version: str,
    root: Path = ROOT,
    check_node_syntax: bool = True,
) -> Path:
  """Assemble complete Release folder from staged targets/assets/font + frontend + backend + docs + manifests."""
  if out_dir.exists():
    shutil.rmtree(out_dir)
  out_dir.mkdir(parents=True, exist_ok=True)

  # 1. Copy 固件与素材/
  fw_root = out_dir / FIRMWARE_DIR_NAME
  restore_root = fw_root / 'restore-images'
  restore_root.mkdir(parents=True, exist_ok=True)

  _copy_dir_clean(staging['main-064'], fw_root / 'main-064')
  _copy_dir_clean(staging['main-063beta1'], fw_root / 'main-063beta1')
  _copy_dir_clean(staging['ips-base'], fw_root / 'ips-base')
  _copy_dir_clean(staging['ips-lyrics'], fw_root / 'ips-lyrics')
  _copy_dir_clean(staging['main-064-restore'], restore_root / 'main-064-restore')
  _copy_dir_clean(staging['main-063beta1-restore'], restore_root / 'main-063beta1-restore')
  _copy_dir_clean(staging['ips-restore'], restore_root / 'ips-restore')

  staged_font_bin = staging['font-bin']
  font_bytes = staged_font_bin.read_bytes()
  fontpack_tool.Font20(font_bytes)
  font_body_crc = struct.unpack_from('<I', font_bytes, 36)[0]
  shutil.copy2(staged_font_bin, fw_root / 'FONT.BIN')

  assets_dst = fw_root / 'assets'
  _copy_dir_clean(staging['assets-dir'], assets_dst)

  restore_notice_src = root / 'release-docs' / 'RESTORE-NOTICE.txt'
  shutil.copy2(restore_notice_src, restore_root / 'RESTORE-NOTICE.txt')

  # 2. Copy 说明文档/
  docs_dst = out_dir / DOCS_DIR_NAME
  docs_dst.mkdir(parents=True, exist_ok=True)
  shutil.copy2(root / 'release-docs' / 'README-使用说明.md', docs_dst / 'README-使用说明.md')
  shutil.copy2(root / 'release-docs' / 'RECOVERY-恢复与救砖.md', docs_dst / 'RECOVERY-恢复与救砖.md')

  # 3. Copy licenses/ + LICENSE-NOTICE.txt
  collect_licenses(out_dir / 'licenses', node_exe=node_exe, root=root)
  write_license_notice(out_dir / 'LICENSE-NOTICE.txt', version=version)

  # 4. Copy Windows便携后台/ + top launcher
  copy_portable_windows_backend(
      out_dir / BACKEND_DIR_NAME,
      node_exe=node_exe,
      font_dir=staging['font-dir'],
      root=root,
  )
  write_top_launcher_cmd(out_dir)

  # 5. Build gzip+base64 offline payload & bundle HTML
  profiles_dir = root / 'profiles'
  profiles_payload = {
      'keys': json.loads((profiles_dir / 'keys.json').read_text('utf-8')),
      'themes': json.loads((profiles_dir / 'themes.json').read_text('utf-8')),
      'font': json.loads((profiles_dir / 'font.json').read_text('utf-8')),
  }
  asset_entries = {}
  for theme_name in THEME_NAMES:
    gif_file = assets_dst / f'robot-{theme_name}.gif'
    gif_bytes = gif_file.read_bytes()
    asset_entries[f'robot{theme_name.capitalize()}'] = {
        'filename': gif_file.name,
        'theme': theme_name,
        'gifGzipBase64': _gz_b64(gif_bytes),
        'sha256': sha256_bytes(gif_bytes),
        'size': len(gif_bytes),
    }

  bundle_payload = {
      'format': 'rainy75v2-release-bundle/v1',
      'version': version,
      'generatedAt': utc_now_iso(),
      'restoreNotice': '基于官方输入基线重建的恢复镜像（非实机 Flash 回读备份）。',
      'licenseNotice': '本发布包包含混合第三方许可组件，整体并非单一 MIT 许可分发。',
      'profiles': profiles_payload,
      'firmware': {
          'main064': _load_target_entry(fw_root / 'main-064', 'rainy75v2-main.bin'),
          'main063beta1': _load_target_entry(fw_root / 'main-063beta1', 'rainy75v2-main.bin'),
          'ipsBase': _load_target_entry(fw_root / 'ips-base', 'rainy75v2-ips.bin'),
          'ipsLyrics': _load_target_entry(fw_root / 'ips-lyrics', 'rainy75v2-ips.bin'),
          'restoreMain064': _load_target_entry(restore_root / 'main-064-restore', 'rainy75v2-main-restore.bin'),
          'restoreMain063beta1': _load_target_entry(restore_root / 'main-063beta1-restore', 'rainy75v2-main-restore.bin'),
          'restoreIps': _load_target_entry(restore_root / 'ips-restore', 'rainy75v2-ips-restore.bin'),
      },
      'font': {
          'filename': 'FONT.BIN',
          'binGzipBase64': _gz_b64(font_bytes),
          'sha256': sha256_bytes(font_bytes),
          'size': len(font_bytes),
          'bodyCrc': font_body_crc,
      },
      'assets': asset_entries,
  }

  bundled_html = bundle_html(html_entry, release_bundle=bundle_payload, profiles_data=profiles_payload)
  verify_release_html(bundled_html, require_bundle_payload=True, check_node_syntax=check_node_syntax)
  offline_html_path = out_dir / ONLINE_HTML_NAME
  offline_html_path.write_text(bundled_html, encoding='utf-8')

  # 6. Inventory all files, write RELEASE-MANIFEST.json, then write SHA256SUMS.txt
  file_records: list[dict[str, object]] = []
  for p in sorted(out_dir.rglob('*')):
    if not p.is_file():
      continue
    rel = p.relative_to(out_dir).as_posix()
    if rel in ('RELEASE-MANIFEST.json', 'SHA256SUMS.txt'):
      continue
    file_records.append({
        'path': rel,
        'sha256': sha256_file(p),
        'size': p.stat().st_size,
    })

  target_summary = {}
  for key, rel_dir, bin_name in (
      ('main-064', f'{FIRMWARE_DIR_NAME}/main-064', 'rainy75v2-main.bin'),
      ('main-063beta1', f'{FIRMWARE_DIR_NAME}/main-063beta1', 'rainy75v2-main.bin'),
      ('ips-base', f'{FIRMWARE_DIR_NAME}/ips-base', 'rainy75v2-ips.bin'),
      ('ips-lyrics', f'{FIRMWARE_DIR_NAME}/ips-lyrics', 'rainy75v2-ips.bin'),
      ('main-064-restore', f'{FIRMWARE_DIR_NAME}/restore-images/main-064-restore', 'rainy75v2-main-restore.bin'),
      ('main-063beta1-restore', f'{FIRMWARE_DIR_NAME}/restore-images/main-063beta1-restore', 'rainy75v2-main-restore.bin'),
      ('ips-restore', f'{FIRMWARE_DIR_NAME}/restore-images/ips-restore', 'rainy75v2-ips-restore.bin'),
  ):
    m = json.loads((out_dir / rel_dir / 'manifest.json').read_text('utf-8'))
    entry_summary = {
        'path': f'{rel_dir}/{bin_name}',
        'manifestPath': f'{rel_dir}/manifest.json',
        'sha256': m.get('sha256'),
        'bytes': m.get('bytes'),
        'target': m.get('target'),
    }
    if 'stockVersion' in m:
      entry_summary['stockVersion'] = m['stockVersion']
    if 'themeSlot' in m:
      entry_summary['themeSlot'] = m['themeSlot']
    target_summary[key] = entry_summary

  release_manifest = {
      'format': 'rainy75v2-release/v1',
      'version': version,
      'generatedAt': bundle_payload['generatedAt'],
      'licenseNotice': (
          'Mixed third-party licenses; this bundle is NOT released as a whole under MIT. '
          'See LICENSE-NOTICE.txt and licenses/.'
      ),
      'restoreNotice': (
          'Restore images are reconstructed from matched factory firmware inputs, '
          'NOT device flash readbacks. See restore-images/RESTORE-NOTICE.txt.'
      ),
      'offlineHtml': {
          'path': ONLINE_HTML_NAME,
          'entrySource': html_entry.name,
          'sha256': sha256_file(offline_html_path),
          'size': offline_html_path.stat().st_size,
      },
      'targets': target_summary,
      'font': {
          'path': f'{FIRMWARE_DIR_NAME}/FONT.BIN',
          'sha256': sha256_bytes(font_bytes),
          'size': len(font_bytes),
          'bodyCrc': font_body_crc,
      },
      'assets': [
          {
              'path': f'{FIRMWARE_DIR_NAME}/assets/robot-{t}.gif',
              'theme': t,
              'sha256': sha256_file(assets_dst / f'robot-{t}.gif'),
              'size': (assets_dst / f'robot-{t}.gif').stat().st_size,
          }
          for t in THEME_NAMES
      ],
      'files': file_records,
  }
  manifest_path = out_dir / 'RELEASE-MANIFEST.json'
  manifest_path.write_text(json.dumps(release_manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

  sum_lines: list[str] = []
  for p in sorted(out_dir.rglob('*')):
    if not p.is_file():
      continue
    rel = p.relative_to(out_dir).as_posix()
    if rel == 'SHA256SUMS.txt':
      continue
    sum_lines.append(f'{sha256_file(p)} *{rel}')
  (out_dir / 'SHA256SUMS.txt').write_text('\n'.join(sum_lines) + '\n', encoding='utf-8')
  return out_dir


def write_release_zip(release_dir: Path, zip_path: Path) -> Path:
  zip_path.parent.mkdir(parents=True, exist_ok=True)
  if zip_path.exists():
    zip_path.unlink()
  fixed_dt = (2026, 1, 1, 0, 0, 0)
  with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    for p in sorted(release_dir.rglob('*')):
      if not p.is_file():
        continue
      rel = p.relative_to(release_dir).as_posix()
      zi = zipfile.ZipInfo(filename=rel, date_time=fixed_dt)
      zi.compress_type = zipfile.ZIP_DEFLATED
      zi.flag_bits |= 0x800  # UTF-8 filenames
      zi.external_attr = 0o100644 << 16
      zf.writestr(zi, p.read_bytes())
  return zip_path


def verify_release_dir(release_dir: Path, *, check_node_syntax: bool = True) -> dict:
  """Verify unpacked release directory integrity, hashes, licenses, notices, and offline HTML."""
  root_dir = release_dir.resolve()
  if not root_dir.is_dir():
    raise ValueError(f'Release directory does not exist: {root_dir}')

  required_paths = [
      root_dir / ONLINE_HTML_NAME,
      root_dir / LAUNCHER_CMD_NAME,
      root_dir / 'RELEASE-MANIFEST.json',
      root_dir / 'SHA256SUMS.txt',
      root_dir / 'LICENSE-NOTICE.txt',
      root_dir / FIRMWARE_DIR_NAME / 'FONT.BIN',
      root_dir / FIRMWARE_DIR_NAME / 'restore-images' / 'RESTORE-NOTICE.txt',
      root_dir / DOCS_DIR_NAME / 'README-使用说明.md',
      root_dir / DOCS_DIR_NAME / 'RECOVERY-恢复与救砖.md',
      root_dir / BACKEND_DIR_NAME / 'runtime' / 'node.exe',
      root_dir / BACKEND_DIR_NAME / 'app' / 'desktop' / 'gui-server.cjs',
      root_dir / BACKEND_DIR_NAME / 'app' / 'desktop' / 'launch.cjs',
      root_dir / BACKEND_DIR_NAME / 'app' / 'desktop' / 'bridge.cjs',
      root_dir / BACKEND_DIR_NAME / 'app' / 'desktop' / 'startup.ps1',
      root_dir / BACKEND_DIR_NAME / 'app' / 'FONT.BIN',
      root_dir / BACKEND_DIR_NAME / 'app' / 'node_modules' / 'node-hid' / 'prebuilds' / 'HID-win32-x64' / 'node-napi-v4.node',
  ]
  for lic in REQUIRED_LICENSE_FILES:
    required_paths.append(root_dir / 'licenses' / lic)
  for cmd in BACKEND_CMD_FILES:
    required_paths.append(root_dir / BACKEND_DIR_NAME / cmd)
  for t in THEME_NAMES:
    required_paths.append(root_dir / FIRMWARE_DIR_NAME / 'assets' / f'robot-{t}.gif')

  missing = [str(p.relative_to(root_dir)) for p in required_paths if not p.is_file()]
  if missing:
    raise ValueError(f'Missing required release files: {", ".join(missing)}')

  lic_notice = (root_dir / 'LICENSE-NOTICE.txt').read_text('utf-8')
  if 'NOT released as a whole under the MIT' not in lic_notice and '并非单一 MIT' not in lic_notice:
    raise ValueError('LICENSE-NOTICE.txt missing explicit mixed-license / not-MIT-as-a-whole warning')

  restore_notice = (root_dir / FIRMWARE_DIR_NAME / 'restore-images' / 'RESTORE-NOTICE.txt').read_text('utf-8')
  if 'NOT' not in restore_notice or 'readback' not in restore_notice.lower():
    raise ValueError('RESTORE-NOTICE.txt missing explicit not-a-flash-readback notice')

  # Verify SHA256SUMS.txt matches ALL files on disk
  actual_files = {
      p.relative_to(root_dir).as_posix(): p
      for p in sorted(root_dir.rglob('*'))
      if p.is_file() and p.relative_to(root_dir).as_posix() != 'SHA256SUMS.txt'
  }
  sums_lines = [
      line for line in (root_dir / 'SHA256SUMS.txt').read_text('utf-8').splitlines() if line.strip()
  ]
  seen_sums: set[str] = set()
  for line in sums_lines:
    m = re.match(r'^([0-9a-f]{64})\s+[\*\s](.+)$', line)
    if not m:
      raise ValueError(f'Malformed SHA256SUMS.txt line: {line}')
    expected_sha, rel = m.group(1), m.group(2)
    if rel in seen_sums:
      raise ValueError(f'Duplicate entry in SHA256SUMS.txt: {rel}')
    seen_sums.add(rel)
    if rel not in actual_files:
      raise ValueError(f'SHA256SUMS.txt references missing file: {rel}')
    if sha256_file(actual_files[rel]) != expected_sha:
      raise ValueError(f'SHA-256 mismatch in SHA256SUMS.txt for {rel}')
  extra_files = set(actual_files.keys()) - seen_sums
  if extra_files:
    raise ValueError(f'Files missing from SHA256SUMS.txt: {sorted(extra_files)}')

  # Verify RELEASE-MANIFEST.json
  try:
    manifest = json.loads((root_dir / 'RELEASE-MANIFEST.json').read_text('utf-8'))
  except Exception as exc:
    raise ValueError(f'Corrupt RELEASE-MANIFEST.json: {exc}') from exc
  if manifest.get('format') != 'rainy75v2-release/v1':
    raise ValueError('Unexpected RELEASE-MANIFEST.json format')

  manifest_files = {
      f['path']: f for f in manifest.get('files', []) if isinstance(f, dict) and 'path' in f
  }
  expected_manifest_paths = {rel for rel in actual_files if rel != 'RELEASE-MANIFEST.json'}
  if set(manifest_files.keys()) != expected_manifest_paths:
    raise ValueError('RELEASE-MANIFEST.json files list out of sync with directory contents')
  for rel, rec in manifest_files.items():
    p = actual_files[rel]
    if p.stat().st_size != rec.get('size') or sha256_file(p) != rec.get('sha256'):
      raise ValueError(f'RELEASE-MANIFEST.json mismatch for {rel}')

  for ips_key in ('ips-base', 'ips-lyrics'):
    t_entry = manifest.get('targets', {}).get(ips_key)
    if not isinstance(t_entry, dict):
      raise ValueError(f'RELEASE-MANIFEST.json missing target {ips_key}')
    slot = t_entry.get('themeSlot')
    if not isinstance(slot, dict) or slot.get('format') != 'r75t/v1' or slot.get('magic') != 'R75T':
      raise ValueError(f'Target {ips_key} missing valid r75t/v1 themeSlot metadata')

  # Validate FONT.BIN & robot GIFs directly
  fontpack_tool.Font20((root_dir / FIRMWARE_DIR_NAME / 'FONT.BIN').read_bytes())
  themes_cfg = json.loads((ROOT / 'profiles' / 'themes.json').read_text('utf-8'))
  for t in THEME_NAMES:
    assets_tool.validate_cache_gif(root_dir / FIRMWARE_DIR_NAME / 'assets' / f'robot-{t}.gif', themes_cfg[t])

  # Verify offline HTML
  html_text = (root_dir / ONLINE_HTML_NAME).read_text('utf-8')
  html_info = verify_release_html(
      html_text,
      require_bundle_payload=True,
      check_node_syntax=check_node_syntax,
  )
  return {'manifest': manifest, 'html': html_info}


def verify_release_zip(zip_path: Path, *, check_node_syntax: bool = True) -> dict:
  zp = zip_path.resolve()
  if not zp.is_file():
    raise ValueError(f'Release ZIP not found: {zp}')
  with tempfile.TemporaryDirectory() as td:
    tmp_root = Path(td)
    with zipfile.ZipFile(zp, 'r') as zf:
      zf.extractall(tmp_root)
    if (tmp_root / 'RELEASE-MANIFEST.json').is_file():
      return verify_release_dir(tmp_root, check_node_syntax=check_node_syntax)
    children = [c for c in tmp_root.iterdir() if c.is_dir()]
    if len(children) == 1 and (children[0] / 'RELEASE-MANIFEST.json').is_file():
      return verify_release_dir(children[0], check_node_syntax=check_node_syntax)
    raise ValueError(f'RELEASE-MANIFEST.json not found inside {zp}')


def build_arg_parser() -> argparse.ArgumentParser:
  ap = argparse.ArgumentParser(description='Build and verify Rainy75 V2 TFT portable release bundle')
  ap.add_argument('--ips-stock', help='Stock IPS firmware binary path')
  ap.add_argument('--main-063beta1', help='Stock 0.63-beta1 main firmware binary path')
  ap.add_argument('--main-064', help='Stock 0.64 main firmware binary path')
  ap.add_argument('--libisp585', help='WCH libISP585.a static library path')
  ap.add_argument('--noto-otf', help='NotoSansMonoCJKsc-Regular.otf path to build FONT.BIN')
  ap.add_argument('--font-bin', help='Prebuilt FONT.BIN path (validated with Font20)')
  ap.add_argument('--clang', help='Clang compiler path for RISC-V firmware builds')
  ap.add_argument('--riscv-march', help='Override RISC-V -march passed to tools/build.py')
  ap.add_argument('--node-exe', help='Portable Windows node.exe path to bundle')
  ap.add_argument('--version', help='Release version string (defaults to package.json version)')
  ap.add_argument('--html-entry', help='Frontend HTML entry path (defaults to web/studio.html or web/index.html)')
  ap.add_argument('--staging-dir', help='Isolated staging directory (defaults to build/release-staging)')
  ap.add_argument('--out-dir', help='Output release directory (defaults to build/release/Rainy75V2-Release-<version>)')
  ap.add_argument('--zip', help='Output ZIP file path (defaults to <out-dir>.zip)')
  ap.add_argument('--no-zip', action='store_true', help='Skip creating the ZIP archive')
  ap.add_argument('--verify', help='Verify an existing release directory or .zip archive and exit')
  return ap


def main(argv: list[str] | None = None) -> int:
  ap = build_arg_parser()
  args = ap.parse_args(argv)

  if args.verify:
    target = Path(args.verify)
    if target.is_dir():
      verify_release_dir(target)
      print(f'Verified release directory OK: {target}')
    else:
      verify_release_zip(target)
      print(f'Verified release ZIP OK: {target}')
    return 0

  version = args.version or read_package_version(ROOT)
  resolved = resolve_inputs(args, ROOT)
  staging_dir = Path(args.staging_dir).resolve() if args.staging_dir else (ROOT / 'build' / 'release-staging').resolve()
  out_dir = (
      Path(args.out_dir).resolve()
      if args.out_dir
      else (ROOT / 'build' / 'release' / f'Rainy75V2-Release-{version}').resolve()
  )

  staging = build_staging_artifacts(
      resolved,
      staging_dir,
      root=ROOT,
      riscv_march=getattr(args, 'riscv_march', None),
  )
  assemble_release(
      staging=staging,
      html_entry=resolved['html_entry'],
      node_exe=resolved['node_exe'],
      out_dir=out_dir,
      version=version,
      root=ROOT,
  )
  verify_release_dir(out_dir)

  if not args.no_zip:
    zip_path = Path(args.zip).resolve() if args.zip else out_dir.with_suffix('.zip')
    write_release_zip(out_dir, zip_path)
    verify_release_zip(zip_path)
    print(f'Release built & verified:\n  DIR: {out_dir}\n  ZIP: {zip_path}')
  else:
    print(f'Release directory built & verified:\n  DIR: {out_dir}')
  return 0


if __name__ == '__main__':
  raise SystemExit(main())
