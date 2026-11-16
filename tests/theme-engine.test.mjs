// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  R75T_MAGIC,
  R75T_VERSION,
  R75T_BYTES,
  IPS_APP_BASE,
  IPS_FLASH_ORIGIN,
  PRESET_THEMES,
  REGIONS,
  ICONS,
  DEFAULT_KEYS_PROFILE,
  normalizeTheme,
  resolveManifestTheme,
  rgb565,
  rgb565ToHex,
  rgb565ToRgb,
  contrastRatio,
  auditThemeContrast,
  generateHarmonicTheme,
  extractPaletteFromRgba,
  crc32,
  patchIpsTheme,
  validateKeysProfile,
  scalePixelGlyph,
  renderScreenPreview,
  drawPreviewToCanvas,
  exportDesignProfile,
  importDesignProfile
} from '../web/theme-engine.mjs';
import { sha256, validateBuild } from '../web/protocol.mjs';

function readRepoJson(relPath) {
  return JSON.parse(fs.readFileSync(new URL(relPath, import.meta.url), 'utf8'));
}

function makeSyntheticIpsBuild({ variant = 'standard', theme = 'pink', slotOffset = null, corruptSlotCrc = false } = {}) {
  const isLyrics = variant === 'lyrics-v1';
  const length = isLyrics ? 540672 : 507904;
  const codeStart = isLyrics ? 0x08080000 : IPS_FLASH_ORIGIN;
  const imageEnd = isLyrics ? 0x08088000 : IPS_FLASH_ORIGIN + length;
  const defaultOffset = isLyrics ? 0x08080100 - IPS_FLASH_ORIGIN : 0x1000;
  const offset = slotOffset ?? defaultOffset;

  const bytes = new Uint8Array(length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 9) & 255;

  const norm = normalizeTheme(theme);
  const fields565 = [
    rgb565(norm.background),
    rgb565(norm.panel),
    rgb565(norm.shell),
    rgb565(norm.ink),
    rgb565(norm.accent),
    rgb565(norm.muted),
    rgb565(norm.lyricsBorder),
    rgb565(norm.lyricsPanel)
  ];

  const view = new DataView(bytes.buffer);
  view.setUint32(offset, R75T_MAGIC, true);
  view.setUint16(offset + 4, R75T_VERSION, true);
  view.setUint16(offset + 6, R75T_BYTES, true);
  for (let i = 0; i < 8; i++) {
    view.setUint16(offset + 8 + i * 2, fields565[i], true);
  }
  let slotCrc = crc32(bytes.subarray(offset, offset + 24));
  if (corruptSlotCrc) slotCrc = (slotCrc ^ 0x12345678) >>> 0;
  view.setUint32(offset + 24, slotCrc, true);

  return { bytes, offset, codeStart, imageEnd, slotCrc, norm, isLyrics };
}

async function makeIpsManifest({ bytes, offset, codeStart, imageEnd, slotCrc, isLyrics, theme = 'pink', omitSlot = false }) {
  const manifest = {
    format: 'rainy75v2-tft/build-v1',
    target: 'ips',
    applicationBase: IPS_APP_BASE,
    iapPid: 0x3078,
    bytes: bytes.length,
    sha256: await sha256(bytes),
    theme
  };
  if (isLyrics) {
    manifest.variant = 'lyrics-v1';
    manifest.requiredFlashKiB = 1024;
    manifest.requiredSeries = 13;
    manifest.codeStart = codeStart;
    manifest.imageEnd = imageEnd;
    manifest.iapEraseEnd = 0x080c0000;
  }
  if (!omitSlot) {
    manifest.themeSlot = {
      format: 'r75t/v1',
      magic: 'R75T',
      version: 1,
      fileOffset: offset,
      bytes: 28,
      codeStart,
      imageEnd,
      applicationBase: IPS_APP_BASE,
      fields: ['bg', 'panel', 'shell', 'ink', 'accent', 'muted', 'lyricsBorder', 'lyricsPanel'],
      crc32: slotCrc
    };
  }
  return manifest;
}

test('PRESET_THEMES and normalizeTheme match profiles/themes.json with exact fallback rules', () => {
  const repoThemes = readRepoJson('../profiles/themes.json');
  for (const name of ['pink', 'mint', 'mono']) {
    assert.deepEqual(normalizeTheme(PRESET_THEMES[name]), normalizeTheme(repoThemes[name]));
  }
  const derived = normalizeTheme({
    background: '#112233',
    panel: '#445566',
    shell: '#778899',
    ink: '#AABBCC',
    accent: '#DDEEFF'
  });
  assert.deepEqual(derived, {
    background: '#112233',
    panel: '#445566',
    shell: '#778899',
    ink: '#aabbcc',
    accent: '#ddeeff',
    muted: '#ddeeff',
    lyricsBorder: '#778899',
    lyricsPanel: '#445566'
  });
  assert.throws(() => normalizeTheme({ ...derived, ink: '#xyz' }), /无效的ink/);
  assert.throws(() => normalizeTheme('nonexistent'), /无效的主题配置/);
});

test('rgb565, rgb565ToHex, contrastRatio, auditThemeContrast, and IEEE crc32 match exact math', () => {
  assert.equal(rgb565('#ff0000'), 0xf800);
  assert.equal(rgb565('#00ff00'), 0x07e0);
  assert.equal(rgb565('#0000ff'), 0x001f);
  assert.equal(rgb565ToHex(0xffff), '#ffffff');
  assert.equal(rgb565ToHex(0x0000), '#000000');
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);

  const badContrast = auditThemeContrast({
    background: '#ffffff',
    panel: '#fefefe',
    shell: '#eeeeee',
    ink: '#dddddd',
    accent: '#eeeeee'
  });
  assert(badContrast.inkOnPanel < 2);
  assert(badContrast.warnings.length >= 3);

  const bytes = new TextEncoder().encode('123456789');
  assert.equal(crc32(bytes), 0xcbf43926);
});

test('generateHarmonicTheme and extractPaletteFromRgba derive readable themes and clean palettes', () => {
  for (const tone of ['soft', 'vivid', 'dark']) {
    const t = generateHarmonicTheme('#3b82f6', tone);
    const audit = auditThemeContrast(t);
    assert.equal(audit.warnings.length, 0, `unexpected contrast warning in ${tone}: ${audit.warnings.join(', ')}`);
    assert(audit.inkOnBackground >= 4.5);
    assert(audit.inkOnPanel >= 4.5);
    assert(audit.inkOnLyricsPanel >= 4.5);
  }
  const darkTheme = generateHarmonicTheme('#e11d48', 'dark');
  assert(contrastRatio(darkTheme.background, '#000000') < 2.0);
  assert(contrastRatio(darkTheme.ink, '#ffffff') < 2.0);
  const graySoft = generateHarmonicTheme('#808080', 'soft');
  assert.equal(auditThemeContrast(graySoft).warnings.length, 0);
  assert.throws(() => generateHarmonicTheme('#3b82f6', 'neon'), /不支持的配色风格/);

  const tile = new Uint8ClampedArray(60 * 4);
  for (let i = 0; i < 60; i++) {
    const at = i * 4;
    if (i < 25) {
      tile[at] = 240; tile[at + 1] = 60; tile[at + 2] = 90; tile[at + 3] = 255;
    } else if (i < 40) {
      tile[at] = 20; tile[at + 1] = 180; tile[at + 2] = 160; tile[at + 3] = 255;
    } else {
      tile[at] = 0; tile[at + 1] = 0; tile[at + 2] = 0; tile[at + 3] = 0;
    }
  }
  const pal = extractPaletteFromRgba(tile, 4);
  assert.deepEqual(pal, ['#f03c5a', '#14b4a0']);
  assert.deepEqual(extractPaletteFromRgba(new Uint8ClampedArray(16), 3), []);
});

test('REGIONS, ICONS, validateKeysProfile, and scalePixelGlyph match profiles/keys.json', () => {
  assert.equal(REGIONS.length, 5);
  assert.equal(ICONS.length, 3);
  const repoKeys = readRepoJson('../profiles/keys.json');
  const validated = validateKeysProfile(repoKeys);
  assert.equal(validated.glyphs.length, DEFAULT_KEYS_PROFILE.glyphs.length);

  const { width, height, mask } = scalePixelGlyph(['10', '01'], 4);
  assert.equal(width, 8);
  assert.equal(height, 8);
  assert.equal(mask[0], 1);
  assert.equal(mask[4], 0);
  assert.equal(mask[4 * width + 4], 1);

  assert.throws(() => validateKeysProfile({ ...repoKeys, idleTimeoutMs: 500 }), /idleTimeoutMs/);
  assert.throws(() => validateKeysProfile({
    idleTimeoutMs: 0,
    glyphs: [{ key: 4, name: 'Bad', rows: ['01', '010'] }]
  }), /点阵行长度不一致/);
});

test('patchIpsTheme patches manifest-verified R75T slot cleanly and passes validateBuild', async () => {
  const std = makeSyntheticIpsBuild({ variant: 'standard', theme: 'pink' });
  const stdManifest = await makeIpsManifest(std);
  const stdCopy = new Uint8Array(std.bytes);
  const patchedStd = await patchIpsTheme(std.bytes, stdManifest, 'mint');

  assert.deepEqual(std.bytes, stdCopy); // input bytes must stay immutable
  assert.equal(patchedStd.manifest.theme, 'mint');
  assert.deepEqual(patchedStd.manifest.themeColors, normalizeTheme('mint'));
  assert.equal(resolveManifestTheme(patchedStd.manifest).ink, normalizeTheme('mint').ink);

  const view = new DataView(patchedStd.bytes.buffer);
  assert.equal(view.getUint16(std.offset + 8, true), rgb565(PRESET_THEMES.mint.background));
  assert.equal(view.getUint16(std.offset + 14, true), rgb565(PRESET_THEMES.mint.ink));
  assert.equal(view.getUint32(std.offset + 24, true), patchedStd.manifest.themeSlot.crc32);
  await validateBuild(patchedStd.bytes, patchedStd.manifest);

  const ly = makeSyntheticIpsBuild({ variant: 'lyrics-v1', theme: 'pink' });
  const lyManifest = await makeIpsManifest(ly);
  const custom = {
    background: '#102030',
    panel: '#182838',
    shell: '#304050',
    ink: '#f0f4f8',
    accent: '#ff8844'
  };
  const patchedLy = await patchIpsTheme(ly.bytes, lyManifest, custom);
  assert.equal(patchedLy.manifest.theme, 'custom');
  assert.equal(patchedLy.rgb565.lyricsBorder, rgb565(custom.shell));
  assert.equal(patchedLy.rgb565.lyricsPanel, rgb565(custom.panel));
  await validateBuild(patchedLy.bytes, patchedLy.manifest);
});

test('patchIpsTheme rejects missing slot, corrupted R75T CRC, out-of-bounds offset, and non-IPS target', async () => {
  const noSlot = makeSyntheticIpsBuild({ variant: 'standard' });
  const noSlotManifest = await makeIpsManifest({ ...noSlot, omitSlot: true });
  await assert.rejects(() => patchIpsTheme(noSlot.bytes, noSlotManifest, 'mint'), /themeSlot/);

  const corrupt = makeSyntheticIpsBuild({ variant: 'standard', corruptSlotCrc: true });
  const corruptManifest = await makeIpsManifest(corrupt);
  await assert.rejects(() => patchIpsTheme(corrupt.bytes, corruptManifest, 'mint'), /CRC-32/);

  const oob = makeSyntheticIpsBuild({ variant: 'lyrics-v1' });
  const oobManifest = await makeIpsManifest(oob);
  oobManifest.themeSlot.fileOffset = 0x100; // below codeStart - 0x08004000
  await assert.rejects(() => patchIpsTheme(oob.bytes, oobManifest, 'mint'), /越出当前构建代码区间/);

  const badMagic = makeSyntheticIpsBuild({ variant: 'standard' });
  badMagic.bytes[badMagic.offset] = 0x00;
  const badMagicManifest = await makeIpsManifest(badMagic);
  await assert.rejects(() => patchIpsTheme(badMagic.bytes, badMagicManifest, 'mint'), /R75T/);

  await assert.rejects(
    () => patchIpsTheme(oob.bytes, { ...oobManifest, target: 'main' }, 'mint'),
    /仅支持 IPS/
  );
});

test('renderScreenPreview & drawPreviewToCanvas render all views with RGB565 theme colors and volume HUD styles', () => {
  const mintKeys = renderScreenPreview(null, { view: 'keys', theme: 'mint', keyCode: 4 });
  const pinkKeys = renderScreenPreview(null, { view: 'keys', theme: 'pink', keyCode: 4 });
  assert.equal(mintKeys.length, SCREEN_WIDTH * SCREEN_HEIGHT * 4);
  assert.notDeepEqual(mintKeys, pinkKeys);

  // Keys and layouts 0..3 keep top status bar region, layout 1 renders distinct card border
  const l0 = renderScreenPreview(null, { view: 'layout0', theme: 'pink' });
  const l1 = renderScreenPreview(null, { view: 'layout1', theme: 'pink' });
  const l2 = renderScreenPreview(null, { view: 'layout2', theme: 'pink' });
  const l3 = renderScreenPreview(null, { view: 'layout3', theme: 'pink', current: 'Very long lyric line wraps cleanly across multiple lines' });
  assert.notDeepEqual(l0, l1);
  assert.notDeepEqual(l1, l2);
  assert.notDeepEqual(l2, l3);

  // Layout 4 omits top status bar (even bg at top differs from layout0) and supports 20/30/40 + crisp/soft + volume styles
  const l4Crisp = renderScreenPreview(null, {
    view: 'layout4',
    theme: 'mint',
    textSize: 40,
    textStyle: 'crisp'
  });
  const l4Soft = renderScreenPreview(null, {
    view: 'layout4',
    theme: 'mint',
    textSize: 30,
    textStyle: 'soft'
  });
  assert.notDeepEqual(l4Crisp, l4Soft);

  const l4VolPill = renderScreenPreview(null, {
    view: 'layout4',
    theme: 'pink',
    volumeOverlay: { visible: true, style: 0, level: 75, muted: false }
  });
  const l4VolBar = renderScreenPreview(null, {
    view: 'layout4',
    theme: 'pink',
    volumeOverlay: { visible: true, style: 1, level: 75, muted: false }
  });
  // Center pill modifies pixels around (160, 80); bottom bar overrides y=142..165 while leaving center box untouched
  assert.notDeepEqual(l4VolPill, l4VolBar);

  let putCalled = 0;
  const mockCanvas = {
    getContext(type) {
      assert.equal(type, '2d');
      return {
        createImageData(w, h) {
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        },
        putImageData(img, x, y) {
          putCalled++;
          assert.equal(x, 0);
          assert.equal(y, 0);
          assert.equal(img.data.length, SCREEN_WIDTH * SCREEN_HEIGHT * 4);
        }
      };
    }
  };
  drawPreviewToCanvas(mockCanvas, { view: 'keys', theme: 'mono' });
  assert.equal(putCalled, 1);
});

test('exportDesignProfile and importDesignProfile roundtrip keys, theme, GIF bytes + transforms, and player settings', () => {
  const gifSample = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x3b]);
  const exported = exportDesignProfile({
    name: 'My Custom Studio',
    track: 'C',
    theme: {
      background: '#fff0f5',
      panel: '#ffffff',
      shell: '#f4b6c2',
      ink: '#4a2030',
      accent: '#e06080'
    },
    keys: DEFAULT_KEYS_PROFILE,
    customGif: {
      bytes: gifSample,
      transforms: {
        fit: 'cover',
        scale: 1.25,
        offsetX: 6,
        offsetY: -4,
        bgMode: 'custom',
        customBg: '#fff0f5',
        overlayBezel: false,
        speed: 1.5,
        placementPreset: 'center',
        chromaKeyColor: '#00ff00',
        chromaKeyTolerance: 40,
        bgBlur: 4,
        flipX: true,
        enableAlpha: true
      }
    },
    playerSettings: {
      layout: 4,
      textSize: 30,
      textStyle: 1,
      volumeEnabled: true,
      volumeScope: 0,
      volumeStyle: 1,
      volumeHoldMs: 1200
    }
  });

  assert.equal(exported.format, 'rainy75v2-tft/design-v1');
  const roundtrip = importDesignProfile(JSON.stringify(exported));
  assert.equal(roundtrip.track, 'C');
  assert.equal(roundtrip.theme.muted, '#e06080');
  assert.deepEqual(roundtrip.customGif.bytes, gifSample);
  assert.equal(roundtrip.customGif.transforms.flipX, true);
  assert.equal(roundtrip.customGif.transforms.chromaKeyColor, '#00ff00');
  assert.equal(roundtrip.playerSettings.volumeStyle, 1);

  assert.throws(() => importDesignProfile('{"format":"wrong"}'), /rainy75v2-tft\/design-v1/);
  assert.throws(() => exportDesignProfile({ track: 'Z', theme: 'pink' }), /无效功能轨道/);
});
