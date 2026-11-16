// SPDX-License-Identifier: MIT
import { sha256, validateBuild } from './protocol.mjs';

export const SCREEN_WIDTH = 320;
export const SCREEN_HEIGHT = 172;
export const R75T_MAGIC = 0x54353752; // "R75T" LE
export const R75T_VERSION = 1;
export const R75T_BYTES = 28;
export const IPS_APP_BASE = 0x4000;
export const IPS_FLASH_ORIGIN = 0x08004000;

export const PRESET_THEMES = Object.freeze({
  pink: Object.freeze({
    name: '樱花粉',
    background: '#fff1f6',
    panel: '#fff8e9',
    shell: '#f0c1d5',
    ink: '#a35479',
    accent: '#d58eae',
    lyricsBorder: '#e6bfd1',
    lyricsPanel: '#fff9fc'
  }),
  mint: Object.freeze({
    name: '薄荷绿',
    background: '#edf8f2',
    panel: '#f8fff6',
    shell: '#b1d8c9',
    ink: '#366c61',
    accent: '#70a998'
  }),
  mono: Object.freeze({
    name: '墨水灰',
    background: '#e9e9e7',
    panel: '#fafaf7',
    shell: '#b7b9b5',
    ink: '#343b37',
    accent: '#8c948b'
  })
});

export const REGIONS = Object.freeze([
  Object.freeze([40, 57, 120, 76]),
  Object.freeze([16, 13, 94, 14]),
  Object.freeze([233, 12, 16, 16]),
  Object.freeze([264, 17, 20, 8]),
  Object.freeze([287, 17, 23, 7])
]);

export const ICONS = Object.freeze([
  Object.freeze([2016, 1440, 1440, 2016, 2016, 4080, 8184, 8184, 8184, 8184, 4080, 384, 384, 384, 384, 384]),
  Object.freeze([0, 8196, 16386, 32769, 33729, 34785, 18018, 10212, 2016, 2016, 2016, 960, 576, 960, 960, 0]),
  Object.freeze([768, 896, 9184, 7024, 3864, 1816, 944, 992, 832, 944, 1816, 3864, 7024, 13280, 896, 768])
]);

// Exact 5x7 glyph rows from profiles/font.json (ASCII 32..96, '{|}~', icons 128..143)
const CACHE_FONT = [
  [0, 0, 0, 0, 0, 0, 0], [4, 4, 4, 4, 4, 0, 4], [10, 10, 10, 0, 0, 0, 0], [10, 31, 10, 10, 31, 10, 0],
  [4, 15, 20, 14, 5, 30, 4], [25, 26, 4, 8, 22, 6, 0], [12, 18, 20, 8, 21, 18, 13], [4, 4, 8, 0, 0, 0, 0],
  [2, 4, 8, 8, 8, 4, 2], [8, 4, 2, 2, 2, 4, 8], [0, 21, 14, 31, 14, 21, 0], [0, 4, 4, 31, 4, 4, 0],
  [0, 0, 0, 0, 4, 4, 8], [0, 0, 0, 31, 0, 0, 0], [0, 0, 0, 0, 0, 4, 4], [1, 2, 2, 4, 8, 8, 16],
  [14, 17, 19, 21, 25, 17, 14], [4, 12, 4, 4, 4, 4, 14], [14, 17, 1, 2, 4, 8, 31], [30, 1, 1, 14, 1, 1, 30],
  [2, 6, 10, 18, 31, 2, 2], [31, 16, 16, 30, 1, 1, 30], [14, 16, 16, 30, 17, 17, 14], [31, 1, 2, 4, 8, 8, 8],
  [14, 17, 17, 14, 17, 17, 14], [14, 17, 17, 15, 1, 1, 14], [0, 4, 4, 0, 4, 4, 0], [0, 4, 4, 0, 4, 4, 8],
  [2, 4, 8, 16, 8, 4, 2], [0, 0, 31, 0, 31, 0, 0], [16, 8, 4, 2, 4, 8, 16], [14, 17, 1, 2, 4, 0, 4],
  [14, 17, 23, 21, 23, 16, 15], [14, 17, 17, 31, 17, 17, 17], [30, 17, 17, 30, 17, 17, 30], [15, 16, 16, 16, 16, 16, 15],
  [30, 17, 17, 17, 17, 17, 30], [31, 16, 16, 30, 16, 16, 31], [31, 16, 16, 30, 16, 16, 16], [15, 16, 16, 23, 17, 17, 15],
  [17, 17, 17, 31, 17, 17, 17], [14, 4, 4, 4, 4, 4, 14], [7, 2, 2, 2, 2, 18, 12], [17, 18, 20, 24, 20, 18, 17],
  [16, 16, 16, 16, 16, 16, 31], [17, 27, 21, 21, 17, 17, 17], [17, 25, 25, 21, 19, 19, 17], [14, 17, 17, 17, 17, 17, 14],
  [30, 17, 17, 30, 16, 16, 16], [14, 17, 17, 17, 21, 18, 13], [30, 17, 17, 30, 20, 18, 17], [15, 16, 16, 14, 1, 1, 30],
  [31, 4, 4, 4, 4, 4, 4], [17, 17, 17, 17, 17, 17, 14], [17, 17, 17, 17, 17, 10, 4], [17, 17, 17, 21, 21, 21, 10],
  [17, 17, 10, 4, 10, 17, 17], [17, 17, 10, 4, 4, 4, 4], [31, 1, 2, 4, 8, 16, 31], [14, 8, 8, 8, 8, 8, 14],
  [16, 8, 8, 4, 2, 2, 1], [14, 2, 2, 2, 2, 2, 14], [4, 10, 17, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 31],
  [8, 4, 2, 0, 0, 0, 0], [2, 4, 4, 8, 4, 4, 2], [4, 4, 4, 4, 4, 4, 4], [8, 4, 4, 2, 4, 4, 8],
  [0, 0, 9, 22, 0, 0, 0], [1, 1, 5, 9, 31, 8, 4], [7, 9, 21, 19, 21, 9, 7], [1, 5, 3, 31, 3, 5, 1],
  [4, 14, 31, 21, 4, 4, 14], [0, 4, 10, 17, 0, 0, 0], [24, 4, 4, 2, 2, 1, 3], [0, 0, 0, 0, 17, 17, 31],
  [4, 14, 21, 4, 4, 4, 4], [4, 4, 4, 4, 21, 14, 4], [0, 4, 8, 31, 8, 4, 0], [0, 4, 2, 31, 2, 4, 0],
  [27, 27, 0, 27, 27, 0, 0], [31, 16, 22, 20, 22, 16, 31], [4, 14, 31, 4, 14, 0, 31], [28, 18, 21, 25, 21, 18, 28],
  [4, 4, 31, 4, 4, 0, 31]
];

export const DEFAULT_KEYS_PROFILE = Object.freeze({
  name: 'Native key profile0.6.2',
  idleTimeoutMs: 0,
  glyphs: [
    { key: 4, name: 'A', rows: ['001111100', '011000110', '110000011', '110000011', '110000011', '111111111', '111111111', '110000011', '110000011', '110000011', '110000011'] },
    { key: 40, name: 'Enter', rows: ['00000000011', '00000000011', '00000000011', '00000000011', '00011000011', '00110000011', '01111111111', '11111111111', '01100000000', '00110000000', '00011000000'] },
    { key: 42, name: 'Backspace', rows: ['0001111111111', '0011111111111', '0110000000011', '1100110011011', '1100011110011', '1100001100011', '1100011110011', '1100110011011', '0110000000011', '0011111111111', '0001111111111'] },
    { key: 44, name: 'Space', rows: ['11000000011', '11000000011', '11000000011', '11111111111', '11111111111'] },
    { key: 80, name: 'Left', rows: ['00000100000', '00001000000', '00010000000', '00100000000', '01000000000', '11111111111', '01000000000', '00100000000', '00010000000', '00001000000', '00000100000'] },
    { key: 82, name: 'Up', rows: ['00000100000', '00001110000', '00010101000', '00100100100', '01000100010', '10000100001', '00000100000', '00000100000', '00000100000', '00000100000', '00000100000'] },
    { key: 79, name: 'Right', rows: ['00000100000', '00000010000', '00000001000', '00000000100', '00000000010', '11111111111', '00000000010', '00000000100', '00000001000', '00000010000', '00000100000'] },
    { key: 81, name: 'Down', rows: ['00000100000', '00000100000', '00000100000', '00000100000', '00000100000', '10000100001', '01000100010', '00100100100', '00010101000', '00001110000', '00000100000'] },
    { key: 75, name: 'PageUp', rows: ['11111111111', '00000000000', '00000100000', '00001110000', '00011111000', '00111111100', '01111111110', '00001110000', '00001110000', '00001110000', '00001110000'] },
    { key: 78, name: 'PageDown', rows: ['00001110000', '00001110000', '00001110000', '00001110000', '01111111110', '00111111100', '00011111000', '00001110000', '00000100000', '00000000000', '11111111111'] },
    { key: 74, name: 'Home', rows: ['00000100000', '00001110000', '00011111000', '00111111100', '01111111110', '11111111111', '01100000110', '01100100110', '01100100110', '01100100110', '01111111110'] },
    { key: 77, name: 'End', rows: ['00000100011', '00000110011', '00000111011', '11111111111', '11111111111', '11111111111', '00000111011', '00000110011', '00000100011', '00000000011', '00000000011'] },
    { key: 227, name: 'Windows', rows: ['111101111', '111101111', '111101111', '111101111', '000000000', '111101111', '111101111', '111101111', '111101111'] }
  ]
});

function glyphIndex(c) {
  if (c >= 97 && c <= 122) c -= 32;
  if (c >= 128 && c < 144) return 69 + c - 128;
  if (c >= 32 && c <= 126) return c - 32 - (c >= 123 ? 26 : 0);
  return 31;
}

/**
 * Validate and normalize a #rrggbb hex color string.
 */
export function normalizeHex(hex, label = '颜色') {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`无效的${label} Hex 色值（应为 #RRGGBB）：${String(hex)}`);
  }
  return hex.toLowerCase();
}

export function hexToRgb(hex) {
  const clean = normalizeHex(hex);
  const n = parseInt(clean.slice(1), 16);
  return [(n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  return (
    '#' +
    [r, g, b]
      .map(v => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * Normalize a preset name or custom theme object into the exact 8 theme colors
 * matching tools/assets.py headers() fallback derivation.
 */
export function normalizeTheme(input) {
  const src = typeof input === 'string' ? PRESET_THEMES[input] : input;
  if (!src || typeof src !== 'object') {
    throw new Error(`无效的主题配置：${String(input)}`);
  }
  const background = normalizeHex(src.background, 'background');
  const panel = normalizeHex(src.panel, 'panel');
  const shell = normalizeHex(src.shell, 'shell');
  const ink = normalizeHex(src.ink, 'ink');
  const accent = normalizeHex(src.accent, 'accent');

  const optionalHex = (val, fallback, field) =>
    val === undefined || val === null || val === ''
      ? fallback
      : normalizeHex(val, field);

  return {
    background,
    panel,
    shell,
    ink,
    accent,
    muted: optionalHex(src.muted, accent, 'muted'),
    lyricsBorder: optionalHex(src.lyricsBorder, shell, 'lyricsBorder'),
    lyricsPanel: optionalHex(src.lyricsPanel, panel, 'lyricsPanel')
  };
}

/**
 * Resolve theme colors from a build manifest (accepts manifest.themeColors or preset manifest.theme).
 */
export function resolveManifestTheme(manifest) {
  if (manifest?.themeColors && typeof manifest.themeColors === 'object') {
    return normalizeTheme(manifest.themeColors);
  }
  if (manifest?.theme !== undefined) {
    return normalizeTheme(manifest.theme);
  }
  return normalizeTheme(PRESET_THEMES.pink);
}

/**
 * Convert #rrggbb hex string to 16-bit RGB565 integer.
 */
export function rgb565(hex) {
  const [r, g, b] = hexToRgb(hex);
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

export function rgb565FromRgb(r, g, b) {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

export function rgb565ToRgb(v) {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
    throw new Error(`无效的 RGB565 数值：${String(v)}`);
  }
  const r5 = (v >>> 11) & 31;
  const g6 = (v >>> 5) & 63;
  const b5 = v & 31;
  return [
    (r5 << 3) | (r5 >> 2),
    (g6 << 2) | (g6 >> 4),
    (b5 << 3) | (b5 >> 2)
  ];
}

/**
 * Convert 16-bit RGB565 integer to #rrggbb hex string.
 */
export function rgb565ToHex(v) {
  const [r, g, b] = rgb565ToRgb(v);
  return rgbToHex(r, g, b);
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Compute WCAG 2.1 contrast ratio between two hex colors (1..21).
 */
export function contrastRatio(hexA, hexB) {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Audit contrast across key UI foreground/background pairs for UI warnings.
 */
export function auditThemeContrast(themeInput) {
  const t = normalizeTheme(themeInput);
  const inkOnPanel = contrastRatio(t.ink, t.panel);
  const inkOnBackground = contrastRatio(t.ink, t.background);
  const inkOnLyricsPanel = contrastRatio(t.ink, t.lyricsPanel);
  const mutedOnBackground = contrastRatio(t.muted, t.background);
  const warnings = [];
  if (inkOnPanel < 4.5) warnings.push(`键帽文字与面板对比度偏低 (${inkOnPanel.toFixed(2)}:1)`);
  if (inkOnBackground < 4.5) warnings.push(`正文文字与底色对比度偏低 (${inkOnBackground.toFixed(2)}:1)`);
  if (inkOnLyricsPanel < 4.5) warnings.push(`歌词卡片文字对比度偏低 (${inkOnLyricsPanel.toFixed(2)}:1)`);
  if (mutedOnBackground < 2.5) warnings.push(`下一句弱化文字对比度偏低 (${mutedOnBackground.toFixed(2)}:1)`);
  return {
    inkOnPanel,
    inkOnBackground,
    inkOnLyricsPanel,
    mutedOnBackground,
    warnings
  };
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(1, s));
  const lig = Math.max(0, Math.min(1, l));
  if (sat === 0) {
    const v = Math.round(lig * 255);
    return rgbToHex(v, v, v);
  }
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const chan = t => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const hNorm = hue / 360;
  return rgbToHex(
    Math.round(chan(hNorm + 1 / 3) * 255),
    Math.round(chan(hNorm) * 255),
    Math.round(chan(hNorm - 1 / 3) * 255)
  );
}

function tuneContrastHex(h, s, startL, bgHexes, minRatio, lighterDirection) {
  let l = startL;
  for (let step = 0; step < 60; step++) {
    const candidate = hslToHex(h, s, l);
    const ratio = Math.min(...bgHexes.map(bg => contrastRatio(candidate, bg)));
    if (ratio >= minRatio) return candidate;
    l = lighterDirection ? Math.min(0.98, l + 0.025) : Math.max(0.02, l - 0.025);
  }
  return lighterDirection ? '#f7f7f7' : '#161616';
}

/**
 * Derive a balanced 8-color theme with strong readable contrast from any seed hex color.
 * Supported tones: 'soft' (default pastel), 'vivid', 'dark'.
 */
export function generateHarmonicTheme(seedHex, tone = 'soft') {
  const cleanSeed = normalizeHex(seedHex, 'seedHex');
  if (!['soft', 'pastel', 'vivid', 'dark'].includes(tone)) {
    throw new Error(`不支持的配色风格 tone：${String(tone)}`);
  }
  const [r, g, b] = hexToRgb(cleanSeed);
  const [h, s] = rgbToHsl(r, g, b);
  const isMono = s < 0.06;

  if (tone === 'dark') {
    const baseS = isMono ? 0.05 : Math.max(0.32, Math.min(0.82, s));
    const background = hslToHex(h, baseS * 0.42, 0.11);
    const panel = hslToHex(h + 12, baseS * 0.36, 0.17);
    const lyricsPanel = hslToHex(h + 6, baseS * 0.38, 0.15);
    const shell = hslToHex(h, baseS * 0.52, 0.36);
    const lyricsBorder = hslToHex(h + 8, baseS * 0.45, 0.31);
    const accent = hslToHex(h, isMono ? 0.08 : Math.max(0.58, baseS), 0.64);
    const muted = tuneContrastHex(h, baseS * 0.45, 0.66, [background, lyricsPanel], 3.5, true);
    const ink = tuneContrastHex(h, baseS * 0.28, 0.92, [background, panel, lyricsPanel], 7.0, true);
    return normalizeTheme({ background, panel, shell, ink, accent, muted, lyricsBorder, lyricsPanel });
  }

  if (tone === 'vivid') {
    const baseS = isMono ? 0.08 : Math.max(0.65, Math.min(0.95, s));
    const background = hslToHex(h, baseS * 0.75, 0.94);
    const panel = hslToHex(h + 24, baseS * 0.5, 0.975);
    const lyricsPanel = hslToHex(h + 8, baseS * 0.58, 0.97);
    const shell = hslToHex(h, baseS * 0.82, 0.74);
    const lyricsBorder = hslToHex(h + 12, baseS * 0.72, 0.78);
    const accent = hslToHex(h, baseS, 0.52);
    const muted = tuneContrastHex(h + 15, baseS * 0.65, 0.48, [background, lyricsPanel], 3.2, false);
    const ink = tuneContrastHex(h, isMono ? 0.08 : Math.min(0.72, baseS * 0.85), 0.3, [background, panel, lyricsPanel], 6.0, false);
    return normalizeTheme({ background, panel, shell, ink, accent, muted, lyricsBorder, lyricsPanel });
  }

  const baseS = isMono ? 0.04 : Math.max(0.28, Math.min(0.68, s));
  const background = hslToHex(h, baseS * 0.85, 0.96);
  const panel = hslToHex(h + 18, baseS * 0.55, 0.985);
  const lyricsPanel = hslToHex(h + 6, baseS * 0.65, 0.98);
  const shell = hslToHex(h, baseS * 0.72, 0.81);
  const lyricsBorder = hslToHex(h + 6, baseS * 0.62, 0.84);
  const accent = hslToHex(h, isMono ? 0.06 : Math.max(0.42, Math.min(0.75, baseS)), 0.62);
  const muted = tuneContrastHex(h, baseS * 0.55, 0.52, [background, lyricsPanel], 3.0, false);
  const ink = tuneContrastHex(h, isMono ? 0.06 : Math.min(0.55, baseS * 0.85), 0.36, [background, panel, lyricsPanel], 5.5, false);
  return normalizeTheme({ background, panel, shell, ink, accent, muted, lyricsBorder, lyricsPanel });
}

/**
 * Sample representative dominant hex colors from an RGBA image/GIF frame via quantized buckets.
 */
export function extractPaletteFromRgba(rgbaInput, count = 6) {
  const rgba = (rgbaInput instanceof Uint8ClampedArray || rgbaInput instanceof Uint8Array)
    ? rgbaInput
    : (rgbaInput?.rgba || rgbaInput?.data);
  if (!(rgba instanceof Uint8ClampedArray || rgba instanceof Uint8Array) || rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new Error('extractPaletteFromRgba 需要有效的 RGBA 像素数组');
  }
  if (!Number.isInteger(count) || count < 1 || count > 32) {
    throw new Error(`extractPaletteFromRgba 的颜色数量 count 必须为 1..32：${String(count)}`);
  }

  const collectBuckets = minAlpha => {
    const map = new Map();
    const stride = rgba.length > 400000 ? 4 * 4 : 4;
    for (let i = 0; i < rgba.length; i += stride) {
      const a = rgba[i + 3];
      if (a < minAlpha) continue;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let entry = map.get(key);
      if (!entry) {
        entry = { sr: 0, sg: 0, sb: 0, n: 0, c: [0, 0, 0] };
        map.set(key, entry);
      }
      entry.sr += r;
      entry.sg += g;
      entry.sb += b;
      entry.n++;
    }
    return [...map.values()].map(b => ({
      n: b.n,
      sr: b.sr,
      sg: b.sg,
      sb: b.sb,
      c: [Math.round(b.sr / b.n), Math.round(b.sg / b.n), Math.round(b.sb / b.n)]
    }));
  };

  let buckets = collectBuckets(128);
  if (buckets.length === 0) buckets = collectBuckets(1);
  if (buckets.length === 0) return [];

  const makeBox = list => {
    let min0 = 255, max0 = 0, min1 = 255, max1 = 0, min2 = 255, max2 = 0, weight = 0;
    for (const it of list) {
      const [r, g, b] = it.c;
      if (r < min0) min0 = r; if (r > max0) max0 = r;
      if (g < min1) min1 = g; if (g > max1) max1 = g;
      if (b < min2) min2 = b; if (b > max2) max2 = b;
      weight += it.n;
    }
    const ranges = [max0 - min0, max1 - min1, max2 - min2];
    const maxRange = Math.max(ranges[0], ranges[1], ranges[2]);
    return { items: list, axis: ranges.indexOf(maxRange), weight, score: maxRange * weight };
  };

  const boxes = [makeBox(buckets)];
  while (boxes.length < count) {
    let best = null;
    let bestIdx = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].items.length > 1 && (!best || boxes[i].score > best.score)) {
        best = boxes[i];
        bestIdx = i;
      }
    }
    if (!best) break;
    const sorted = best.items.slice().sort((a, b) => a.c[best.axis] - b.c[best.axis]);
    let w = 0;
    let cut = 1;
    for (; cut < sorted.length; cut++) {
      w += sorted[cut - 1].n;
      if (w >= best.weight / 2) break;
    }
    cut = Math.min(cut, sorted.length - 1);
    boxes.splice(bestIdx, 1, makeBox(sorted.slice(0, cut)), makeBox(sorted.slice(cut)));
  }

  boxes.sort((a, b) => b.weight - a.weight);
  const out = [];
  const seen = new Set();
  for (const box of boxes) {
    let sr = 0, sg = 0, sb = 0;
    for (const it of box.items) {
      sr += it.sr;
      sg += it.sg;
      sb += it.sb;
    }
    const hex = rgbToHex(
      Math.round(sr / box.weight),
      Math.round(sg / box.weight),
      Math.round(sb / box.weight)
    );
    if (!seen.has(hex)) {
      seen.add(hex);
      out.push(hex);
      if (out.length >= count) break;
    }
  }
  return out;
}

/**
 * Compute IEEE CRC-32 (0xedb88320), matching desktop/font.cjs and Python zlib.crc32.
 */
export function crc32(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('crc32 输入必须为 Uint8Array');
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ ((0 - (crc & 1)) & 0xedb88320);
    }
  }
  return (~crc) >>> 0;
}

/**
 * Patch an IPS firmware binary via its manifest-verified R75T v1 slot.
 */
export async function patchIpsTheme(firmwareBytes, manifest, themeInput) {
  if (!(firmwareBytes instanceof Uint8Array)) {
    throw new Error('固件数据必须为 Uint8Array');
  }
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('缺少构建清单 manifest');
  }
  if (manifest.target !== 'ips' || manifest.format !== 'rainy75v2-tft/build-v1') {
    throw new Error('仅支持 IPS 目标的 rainy75v2-tft/build-v1 构建清单');
  }
  if (manifest.applicationBase !== IPS_APP_BASE) {
    throw new Error(`IPS 应用区基址不匹配：期望 0x4000，实际 ${String(manifest.applicationBase)}`);
  }
  if (manifest.bytes !== firmwareBytes.length) {
    throw new Error(`固件字节数与清单不一致：清单 ${manifest.bytes}，实际 ${firmwareBytes.length}`);
  }

  await validateBuild(firmwareBytes, manifest);

  const slot = manifest.themeSlot;
  if (!slot || typeof slot !== 'object') {
    throw new Error('构建清单缺少 themeSlot，无法安全定位主题槽位');
  }
  if (slot.format !== 'r75t/v1' || slot.magic !== 'R75T' || slot.version !== R75T_VERSION || slot.bytes !== R75T_BYTES) {
    throw new Error('themeSlot 格式声明不匹配（需要 r75t/v1 · R75T · v1 · 28B）');
  }
  if (slot.applicationBase !== undefined && slot.applicationBase !== IPS_APP_BASE) {
    throw new Error(`themeSlot 基址不匹配：期望 16384，实际 ${String(slot.applicationBase)}`);
  }
  if (!Number.isInteger(slot.codeStart) || !Number.isInteger(slot.imageEnd) || !Number.isInteger(slot.fileOffset)) {
    throw new Error('themeSlot 缺少有效的 codeStart / imageEnd / fileOffset 整数边界');
  }
  if (slot.codeStart < IPS_FLASH_ORIGIN || slot.imageEnd <= slot.codeStart) {
    throw new Error('themeSlot 代码段边界无效');
  }

  const offset = slot.fileOffset;
  const minOffset = slot.codeStart - IPS_FLASH_ORIGIN;
  const maxEndOffset = slot.imageEnd - IPS_FLASH_ORIGIN;
  if (offset < 0 || offset < minOffset || offset + R75T_BYTES > maxEndOffset || offset + R75T_BYTES > firmwareBytes.length) {
    throw new Error('themeSlot fileOffset 越出当前构建代码区间或固件文件长度');
  }

  const inView = new DataView(firmwareBytes.buffer, firmwareBytes.byteOffset, firmwareBytes.byteLength);
  if (
    inView.getUint32(offset, true) !== R75T_MAGIC ||
    inView.getUint16(offset + 4, true) !== R75T_VERSION ||
    inView.getUint16(offset + 6, true) !== R75T_BYTES
  ) {
    throw new Error('固件指定偏移处未找到有效的 R75T v1 主题槽位头部');
  }

  const existingCrc = inView.getUint32(offset + 24, true);
  const computedExistingCrc = crc32(firmwareBytes.subarray(offset, offset + 24));
  if (existingCrc !== computedExistingCrc || (Number.isInteger(slot.crc32) && (slot.crc32 >>> 0) !== existingCrc)) {
    throw new Error('固件原有 R75T 主题槽位 CRC-32 校验失败，已拒绝写入');
  }

  const theme = normalizeTheme(themeInput);
  const values = [
    rgb565(theme.background),
    rgb565(theme.panel),
    rgb565(theme.shell),
    rgb565(theme.ink),
    rgb565(theme.accent),
    rgb565(theme.muted),
    rgb565(theme.lyricsBorder),
    rgb565(theme.lyricsPanel)
  ];

  const outBytes = new Uint8Array(firmwareBytes);
  const outView = new DataView(outBytes.buffer, outBytes.byteOffset, outBytes.byteLength);
  for (let i = 0; i < 8; i++) {
    outView.setUint16(offset + 8 + i * 2, values[i], true);
  }
  const newCrc = crc32(outBytes.subarray(offset, offset + 24));
  outView.setUint32(offset + 24, newCrc, true);

  const newSha = await sha256(outBytes);
  let themeName = 'custom';
  if (typeof themeInput === 'string' && PRESET_THEMES[themeInput]) {
    themeName = themeInput;
  } else if (themeInput && typeof themeInput === 'object' && typeof themeInput.id === 'string' && PRESET_THEMES[themeInput.id]) {
    const preset = normalizeTheme(PRESET_THEMES[themeInput.id]);
    if (Object.keys(preset).every(k => preset[k] === theme[k])) {
      themeName = themeInput.id;
    }
  }

  const newManifest = {
    ...manifest,
    theme: themeName,
    themeColors: theme,
    themeSlot: {
      ...slot,
      crc32: newCrc
    },
    sha256: newSha
  };

  return {
    bytes: outBytes,
    manifest: newManifest,
    theme,
    rgb565: {
      background: values[0],
      panel: values[1],
      shell: values[2],
      ink: values[3],
      accent: values[4],
      muted: values[5],
      lyricsBorder: values[6],
      lyricsPanel: values[7]
    }
  };
}

/**
 * Validate key glyph profile matching tools/assets.py validate_keys().
 */
export function validateKeysProfile(profile) {
  if (!profile || typeof profile !== 'object' || !Array.isArray(profile.glyphs) || profile.glyphs.length === 0) {
    throw new Error('按键配置缺少非空的 glyphs 数组');
  }
  if (profile.idleTimeoutMs !== 0) {
    throw new Error('当前固件保持显示最近按键，idleTimeoutMs 必须为 0');
  }
  const seen = new Set();
  for (const g of profile.glyphs) {
    const key = g?.key;
    const rows = g?.rows;
    if (!Number.isInteger(key) || key < 1 || key > 65535 || seen.has(key)) {
      throw new Error(`重复或无效的键码：${String(key)}`);
    }
    seen.add(key);
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 11 || typeof rows[0] !== 'string' || rows[0].length < 1 || rows[0].length > 16) {
      throw new Error(`键码 ${key} 点阵尺寸必须为 1..16 × 1..11`);
    }
    const w = rows[0].length;
    for (const row of rows) {
      if (typeof row !== 'string' || row.length !== w || /[^01]/.test(row)) {
        throw new Error(`键码 ${key} 点阵行长度不一致或包含非 0/1 字符`);
      }
    }
    if (w * 6 > 120 || rows.length * 6 > 76) {
      throw new Error(`键码 ${key} 点阵放大 6 倍后超出 120×76 区域`);
    }
  }
  return profile;
}

/**
 * Scale a 0/1 string bitmap glyph by an integer scale factor.
 */
export function scalePixelGlyph(rows, scale = 6) {
  if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== 'string' || rows[0].length === 0) {
    throw new Error('点阵 rows 不能为空');
  }
  if (!Number.isInteger(scale) || scale < 1 || scale > 16) {
    throw new Error(`无效缩放倍数：${String(scale)}`);
  }
  const gw = rows[0].length;
  const gh = rows.length;
  const width = gw * scale;
  const height = gh * scale;
  const mask = new Uint8Array(width * height);
  const scaledRows = [];
  for (let y = 0; y < gh; y++) {
    const row = rows[y];
    if (typeof row !== 'string' || row.length !== gw || /[^01]/.test(row)) {
      throw new Error('点阵行格式无效');
    }
    let outRow = '';
    for (let x = 0; x < gw; x++) {
      const bit = row[x] === '1' ? 1 : 0;
      outRow += (bit ? '1' : '0').repeat(scale);
    }
    for (let dy = 0; dy < scale; dy++) {
      const py = y * scale + dy;
      scaledRows.push(outRow);
      for (let px = 0; px < width; px++) {
        if (outRow[px] === '1') mask[py * width + px] = 1;
      }
    }
  }
  return { width, height, mask, rows: scaledRows };
}

// --- Software 320x172 RGB565 Framebuffer Primitives ---

function putPixel565(fb, x, y, color) {
  if (x < 0 || y < 0 || x >= SCREEN_WIDTH || y >= SCREEN_HEIGHT) return;
  fb[y * SCREEN_WIDTH + x] = color;
}

function blendPixel565(fb, x, y, color, alpha) {
  if (!alpha || x < 0 || y < 0 || x >= SCREEN_WIDTH || y >= SCREEN_HEIGHT) return;
  if (alpha >= 256) {
    fb[y * SCREEN_WIDTH + x] = color;
    return;
  }
  const at = y * SCREEN_WIDTH + x;
  const old = fb[at];
  const r = (((old >>> 11) * (256 - alpha)) + ((color >>> 11) * alpha)) >> 8;
  const g = ((((old >>> 5) & 63) * (256 - alpha)) + (((color >>> 5) & 63) * alpha)) >> 8;
  const b = (((old & 31) * (256 - alpha)) + ((color & 31) * alpha)) >> 8;
  fb[at] = (r << 11) | (g << 5) | b;
}

function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  if (x >= x0 + r && x <= x1 - r) return true;
  if (y >= y0 + r && y <= y1 - r) return true;
  const cx = x < x0 + r ? x0 + r : x1 - r;
  const cy = y < y0 + r ? y0 + r : y1 - r;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function fillRoundedRect565(fb, x0, y0, x1, y1, r, color) {
  const minY = Math.max(0, y0);
  const maxY = Math.min(SCREEN_HEIGHT - 1, y1);
  const minX = Math.max(0, x0);
  const maxX = Math.min(SCREEN_WIDTH - 1, x1);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (insideRoundedRect(x, y, x0, y0, x1, y1, r)) {
        fb[y * SCREEN_WIDTH + x] = color;
      }
    }
  }
}

function fillRect565(fb, x0, y0, x1, y1, color) {
  const minY = Math.max(0, y0);
  const maxY = Math.min(SCREEN_HEIGHT - 1, y1);
  const minX = Math.max(0, x0);
  const maxX = Math.min(SCREEN_WIDTH - 1, x1);
  for (let y = minY; y <= maxY; y++) {
    const row = y * SCREEN_WIDTH;
    for (let x = minX; x <= maxX; x++) fb[row + x] = color;
  }
}

function fillEllipse565(fb, x0, y0, x1, y1, color) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2 || 0.5;
  const ry = (y1 - y0) / 2 || 0.5;
  for (let y = Math.max(0, y0); y <= Math.min(SCREEN_HEIGHT - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(SCREEN_WIDTH - 1, x1); x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1.0) fb[y * SCREEN_WIDTH + x] = color;
    }
  }
}

function drawThickLine565(fb, x0, y0, x1, y1, width, color) {
  const half = Math.floor(width / 2);
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1) * 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = Math.round(x0 + (x1 - x0) * t);
    const cy = Math.round(y0 + (y1 - y0) * t);
    fillRect565(fb, cx - half, cy - half, cx + half, cy + half, color);
  }
}

function drawAscii565(fb, text, x, y, scale, color, alpha = 256) {
  const str = String(text || '');
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const rows = CACHE_FONT[glyphIndex(code)];
    for (let yy = 0; yy < 7; yy++) {
      const bits = rows[yy];
      for (let xx = 0; xx < 5; xx++) {
        if (bits & (16 >> xx)) {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const px = x + (i * 6 + xx) * scale + dx;
              const py = y + yy * scale + dy;
              if (alpha >= 256) putPixel565(fb, px, py, color);
              else blendPixel565(fb, px, py, color, alpha);
            }
          }
        }
      }
    }
  }
}

/**
 * Draw the shared bezel ring, left keycap card, and RAINY label onto a 320x172 RGB565 surface.
 * Shared between renderBaseFrame565 and web/gif-studio.mjs composePetGifFrames.
 */
export function drawBezelOverlay565(fb, themeInput, { fillCutoutBg = null } = {}) {
  const t = normalizeTheme(themeInput);
  const bg = rgb565(t.background);
  const panel = rgb565(t.panel);
  const shell = rgb565(t.shell);
  const ink = rgb565(t.ink);

  for (let y = 37; y <= 165; y++) {
    for (let x = 7; x <= 312; x++) {
      if (!insideRoundedRect(x, y, 7, 37, 312, 165, 16)) continue;
      if (insideRoundedRect(x, y, 12, 42, 307, 160, 13)) {
        if (fillCutoutBg !== null) fb[y * SCREEN_WIDTH + x] = fillCutoutBg;
      } else {
        fb[y * SCREEN_WIDTH + x] = shell;
      }
    }
  }
  fillRoundedRect565(fb, 24, 45, 176, 145, 13, ink);
  fillRoundedRect565(fb, 27, 48, 173, 142, 10, panel);
  drawAscii565(fb, 'RAINY', 73, 151, 1, ink);
  return { bg, panel, shell, ink };
}

/**
 * Render the theme base frame (bezel + original robot) in 320x172 RGB565 matching tools/assets.py.
 */
export function renderBaseFrame565(themeInput, { phase = 0 } = {}) {
  const t = normalizeTheme(themeInput);
  const bg = rgb565(t.background);
  const panel = rgb565(t.panel);
  const shell = rgb565(t.shell);
  const ink = rgb565(t.ink);
  const accent = rgb565(t.accent);

  const fb = new Uint16Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  fb.fill(bg);
  drawBezelOverlay565(fb, t, { fillCutoutBg: bg });

  const bob = [0, 0, -1, -1, 0, 1, 1, 0][((phase % 8) + 8) % 8];
  const x = 218;
  const y = 70 + bob;

  fillEllipse565(fb, 205, 143, 297, 151, shell);
  drawThickLine565(fb, x + 37, y - 12, x + 37, y, 3, ink);
  fillRect565(fb, x + 33, y - 17, x + 41, y - 10, accent);
  fillRoundedRect565(fb, x, y, x + 74, y + 50, 8, ink);
  fillRoundedRect565(fb, x + 3, y + 3, x + 71, y + 47, 6, panel);
  if (((phase % 8) + 8) % 8 === 4) {
    drawThickLine565(fb, x + 15, y + 19, x + 25, y + 19, 3, ink);
    drawThickLine565(fb, x + 49, y + 19, x + 59, y + 19, 3, ink);
  } else {
    fillRect565(fb, x + 17, y + 13, x + 24, y + 22, ink);
    fillRect565(fb, x + 50, y + 13, x + 57, y + 22, ink);
  }
  drawThickLine565(fb, x + 28, y + 32, x + 46, y + 32, 3, ink);
  fillRect565(fb, x + 20, y + 51, x + 55, y + 68, accent);
  fillRect565(fb, x + 14, y + 69, x + 31, y + 73, ink);
  fillRect565(fb, x + 44, y + 69, x + 61, y + 73, ink);
  drawThickLine565(fb, x + 14, y + 54, x + 5, y + 62, 3, ink);
  drawThickLine565(fb, x + 61, y + 54, x + 70, y + 60 - (Math.abs(phase) % 3), 3, ink);
  return fb;
}

function lyricsVolumeIcon(x, y, muted) {
  if (x < 5 && y >= 4 && y <= 8) return true;
  if (x >= 5 && x <= 9 && y >= 9 - x && y <= x + 3) return true;
  if (muted) return x >= 11 && x <= 15 && y >= 4 && y <= 8 && ((x - 11) === (y - 4) || (x - 11) === (8 - y));
  return (x === 12 && y >= 4 && y <= 8) || (x === 11 && (y === 3 || y === 9)) || (x === 15 && y >= 3 && y <= 9) || (x === 14 && (y === 2 || y === 10)) || (x === 13 && (y === 1 || y === 11));
}

function drawRegionText(fb, slotIndex, str, scale, fg, bg) {
  const [, , rw, rh] = REGIONS[slotIndex];
  const [rx, ry] = REGIONS[slotIndex];
  fillRect565(fb, rx, ry, rx + rw - 1, ry + rh - 1, bg);
  const n = str.length;
  let s = scale;
  while (s > 1 && n > 0 && (n * 6 - 1) * s > rw) s--;
  const width = n > 0 ? (n * 6 - 1) * s : 0;
  const ox = width > rw ? 0 : Math.floor((rw - width) / 2);
  const oy = rh > 7 * s ? Math.floor((rh - 7 * s) / 2) : 0;
  for (let i = 0; i < n; i++) {
    const code = typeof str === 'string' ? str.charCodeAt(i) : str[i];
    const rows = CACHE_FONT[glyphIndex(code)];
    for (let j = 0; j < 7; j++) {
      for (let k = 0; k < 5; k++) {
        if (rows[j] & (16 >> k)) {
          for (let dy = 0; dy < s; dy++) {
            for (let dx = 0; dx < s; dx++) {
              const px = ox + (i * 6 + k) * s + dx;
              const py = oy + j * s + dy;
              if (px >= 0 && px < rw && py >= 0 && py < rh) {
                fb[(ry + py) * SCREEN_WIDTH + (rx + px)] = fg;
              }
            }
          }
        }
      }
    }
  }
}

function drawKeyRegion(fb, state, fg, bg) {
  const [rx, ry, rw, rh] = REGIONS[0];
  fillRect565(fb, rx, ry, rx + rw - 1, ry + rh - 1, bg);

  const vol = state.volumeOverlay;
  if (vol && vol.visible !== false && vol.scope === 1) {
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const alpha = Math.max(0, Math.min(256, vol.alpha ?? 256));
    const muted = Boolean(vol.muted);
    const level = Math.max(0, Math.min(100, vol.level ?? 60));
    const progress = muted ? 0 : level * 256;
    const shift = Math.floor(((256 - alpha) * 6) / 256);
    const label = muted ? '--' : `${level}%`;
    const dot = (px, py) => {
      if (px >= 0 && px < rw && py >= 0 && py < rh && BAYER[(py & 3) * 4 + (px & 3)] * 16 < alpha) {
        fb[(ry + py) * SCREEN_WIDTH + (rx + px)] = fg;
      }
    };
    const iconLeft = Math.floor((rw - 16) / 2);
    for (let y = 0; y < 13; y++) {
      for (let x = 0; x < 16; x++) {
        if (lyricsVolumeIcon(x, y, muted || !level)) dot(iconLeft + x, 7 + y + shift);
      }
    }
    const tw = (label.length * 6 - 1) * 3;
    const tLeft = rw > tw ? Math.floor((rw - tw) / 2) : 0;
    for (let i = 0; i < label.length; i++) {
      const rows = CACHE_FONT[glyphIndex(label.charCodeAt(i))];
      for (let yy = 0; yy < 7; yy++) {
        for (let xx = 0; xx < 5; xx++) {
          if (rows[yy] & (16 >> xx)) {
            for (let dy = 0; dy < 3; dy++) {
              for (let dx = 0; dx < 3; dx++) {
                dot(tLeft + (i * 6 + xx) * 3 + dx, 26 + yy * 3 + dy + shift);
              }
            }
          }
        }
      }
    }
    const barW = rw - 24;
    for (let x = 0; x < barW; x++) {
      for (let y = 0; y < 5; y++) {
        if (x < Math.floor(progress * barW / 25600) || (y === 4 && (x & 1) === 0)) dot(12 + x, 61 + y);
      }
    }
    return;
  }

  let k = state.key ?? 227;
  if (k >= 0xfff8) k = (k & 7) + 224;
  if (k === 231) k = 227;

  const profile = state.keysProfile || DEFAULT_KEYS_PROFILE;
  const big = profile?.glyphs?.find(g => g.key === k);
  if (big) {
    const scale = 6;
    const gw = big.rows[0].length;
    const gh = big.rows.length;
    const ox = Math.floor((rw - gw * scale) / 2);
    const oy = Math.floor((rh - gh * scale) / 2);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        if (big.rows[y][x] === '1') {
          fillRect565(fb, rx + ox + x * scale, ry + oy + y * scale, rx + ox + (x + 1) * scale - 1, ry + oy + (y + 1) * scale - 1, fg);
        }
      }
    }
    return;
  }

  const shifted = Boolean((state.modifiers || 0) & 1);
  if (!k) { drawRegionText(fb, 0, '--', 6, fg, bg); return; }
  if (k === 224 || k === 228) { drawRegionText(fb, 0, 'CTRL', 5, fg, bg); return; }
  if (k === 226 || k === 230) { drawRegionText(fb, 0, 'ALT', 5, fg, bg); return; }
  if (k === 41) { drawRegionText(fb, 0, 'ESC', 5, fg, bg); return; }
  if (k >= 4 && k <= 29) { drawRegionText(fb, 0, String.fromCharCode(65 + k - 4), 9, fg, bg); return; }
  if (k >= 30 && k <= 39) {
    const ch = shifted ? '!@#$%^&*()' [k - 30] : (k === 39 ? '0' : String.fromCharCode(49 + k - 30));
    drawRegionText(fb, 0, ch, 9, fg, bg); return;
  }
  if (k >= 45 && k <= 56) {
    const ch = (shifted ? '_+{}|~:"<>?' : '-=[]\\#;\'`,./')[k - 45] || '?';
    drawRegionText(fb, 0, ch, 9, fg, bg); return;
  }
  if (k >= 401 && k <= 405) {
    drawRegionText(fb, 0, k === 401 ? 'FN' : `FN${k - 400}`, k === 401 ? 6 : 5, fg, bg); return;
  }
  if ((k >= 58 && k <= 69) || (k >= 104 && k <= 115)) {
    const fn = k >= 104 ? k - 91 : k - 57;
    drawRegionText(fb, 0, `F${fn}`, fn >= 10 ? 5 : 6, fg, bg); return;
  }
  const iconMap = { 43: 130, 57: 141, 73: 143, 76: 142, 225: 131, 229: 131 };
  drawRegionText(fb, 0, [iconMap[k] || 63], 9, fg, bg);
}

function drawStatusRegions(fb, state, fg, bg) {
  drawRegionText(fb, 1, state.timeText || '12:34:56', 2, fg, bg);

  const [cx, cy, cw, ch] = REGIONS[2];
  fillRect565(fb, cx, cy, cx + cw - 1, cy + ch - 1, bg);
  const mode = state.mode ?? 1;
  if (mode >= 0 && mode < 5) {
    const iconIdx = mode === 1 ? 0 : mode === 0 ? 1 : 2;
    for (let y = 0; y < 16; y++) {
      const row = ICONS[iconIdx][y];
      for (let x = 0; x < 16; x++) {
        if (row & (1 << (15 - x))) fb[(cy + y) * SCREEN_WIDTH + (cx + x)] = fg;
      }
    }
  }

  const [bx, by, bw, bh] = REGIONS[3];
  fillRect565(fb, bx, by, bx + bw - 1, by + bh - 1, bg);
  const bat = state.battery === null || state.battery === undefined ? 255 : Math.min(100, Math.max(0, state.battery | 0));
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 20; x++) {
      let bit = (x < 17 && (x === 0 || x === 16 || y === 0 || y === 7)) || (x === 17 && y >= 2 && y < 6);
      if (x >= 2 && x < 14 && y >= 2 && y < 6) {
        bit = bat <= 100 ? (x - 2) * 100 < 12 * bat : (y === 4 && x >= 6 && x < 10);
      }
      if (bit) fb[(by + y) * SCREEN_WIDTH + (bx + x)] = fg;
    }
  }

  drawRegionText(fb, 4, bat > 100 ? '--' : `${bat}%`, 1, fg, bg);
}

// Build a 20px-tall 1-bit Line object matching firmware/ips-lyrics/lyrics.c Line layout
function buildPreviewLine(text) {
  const chars = [...String(text || '')];
  const advance = [];
  const glyphs = [];
  let width = 0;
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if (cp >= 32 && cp <= 126) {
      const adv = 12;
      advance.push(adv);
      glyphs.push({ ascii: cp, adv });
      width += adv;
    } else {
      const adv = 18;
      advance.push(adv);
      glyphs.push({ codePoint: cp, adv });
      width += adv;
    }
  }
  const bits = new Uint8Array(Math.ceil((width * 20) / 8));
  const setDot = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= 20) return;
    const b = y * width + x;
    bits[b >> 3] |= 128 >> (b & 7);
  };

  let xOff = 0;
  for (const g of glyphs) {
    if (g.ascii !== undefined) {
      const rows = CACHE_FONT[glyphIndex(g.ascii)];
      for (let yy = 0; yy < 7; yy++) {
        for (let xx = 0; xx < 5; xx++) {
          if (rows[yy] & (16 >> xx)) {
            for (let dy = 0; dy < 2; dy++) {
              for (let dx = 0; dx < 2; dx++) {
                setDot(xOff + xx * 2 + dx, 3 + yy * 2 + dy);
              }
            }
          }
        }
      }
    } else {
      // Deterministic crisp 16x16 bitmap pattern for non-ASCII CJK preview text
      const h = (g.codePoint * 2654435761) >>> 0;
      for (let yy = 2; yy < 18; yy++) {
        for (let xx = 1; xx < 17; xx++) {
          const border = yy === 2 || yy === 17 || xx === 1 || xx === 16;
          const mid = yy === 9 || xx === 8;
          const bit = ((h >> ((yy + xx) & 31)) & 1) === 1;
          if (border || (mid && ((yy + xx) % 2 === 0)) || (bit && xx > 3 && xx < 14 && yy > 4 && yy < 15 && ((xx + yy) % 2 === 0))) {
            setDot(xOff + xx, yy);
          }
        }
      }
    }
    xOff += g.adv;
  }

  return { count: glyphs.length, advance, width, bits };
}

function monoDot(line, x, y) {
  if (!line.bits || x < 0 || x >= line.width || y < 0 || y >= 20) return 0;
  const b = y * line.width + x;
  return (line.bits[b >> 3] & (128 >> (b & 7))) ? 1 : 0;
}

function drawLine565(fb, line, y, field, color, clip0, clip1, scale, leftBase) {
  if (!line.bits || !line.width) return;
  const width = line.width * scale;
  const left = width < field ? leftBase + Math.floor((field - width) / 2) : leftBase;
  for (let yy = 0; yy < 20 * scale; yy++) {
    const py = y + yy;
    if (py < clip0 || py >= clip1) continue;
    for (let x = 0; x < field && x < width; x++) {
      if (monoDot(line, Math.floor(x / scale), Math.floor(yy / scale))) {
        putPixel565(fb, left + x, py, color);
      }
    }
  }
}

function draw30Line565(fb, line, top, style, low, high) {
  if (!line.bits || !line.width) return;
  const width = Math.floor((line.width * 3) / 2);
  const left = width < 288 ? 16 + Math.floor((288 - width) / 2) : 16;
  if (!style) {
    for (let y = 0; y < 30; y++) {
      const py = top + y;
      if (py < low || py >= high) continue;
      for (let x = 0; x < 288 && x < width; x++) {
        if (monoDot(line, Math.floor((x * 2 + 1) / 3), Math.floor((y * 2 + 1) / 3))) {
          putPixel565(fb, left + x, py, 0xffff);
        }
      }
    }
    return;
  }
  for (let y = 0; y < 30; y++) {
    const py = top + y;
    if (py < low || py >= high) continue;
    const sy = y ? Math.floor((y * 4 - 1) / 6) : 0;
    const fy = y ? (y * 4 - 1) % 6 : 0;
    for (let x = 0; x < 288 && x < width; x++) {
      const sx = x ? Math.floor((x * 4 - 1) / 6) : 0;
      const fx = x ? (x * 4 - 1) % 6 : 0;
      const alpha =
        monoDot(line, sx, sy) * (6 - fx) * (6 - fy) +
        monoDot(line, sx + 1, sy) * fx * (6 - fy) +
        monoDot(line, sx, sy + 1) * (6 - fx) * fy +
        monoDot(line, sx + 1, sy + 1) * fx * fy;
      if (alpha) {
        const at = py * SCREEN_WIDTH + left + x;
        const old = fb[at];
        let r = old >>> 11;
        let g = (old >>> 5) & 63;
        let b = old & 31;
        r += Math.floor(((31 - r) * alpha) / 36);
        g += Math.floor(((63 - g) * alpha) / 36);
        b += Math.floor(((31 - b) * alpha) / 36);
        fb[at] = (r << 11) | (g << 5) | b;
      }
    }
  }
}

function formatStamp(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.min(99, Math.floor(s / 60));
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function drawClassicCard(fb, cardColor, paperColor) {
  const outer = [4, 3, 2, 1, 0, 0, 0];
  const inner = [3, 1, 1, 0, 0];
  for (let y = 0; y < 70; y++) {
    const edge = y < 35 ? y : 69 - y;
    const inset = edge < 7 ? outer[edge] : 0;
    for (let x = inset; x < 298 - inset; x++) putPixel565(fb, 11 + x, 75 + y, cardColor);
  }
  for (let y = 0; y < 66; y++) {
    const edge = y < 33 ? y : 65 - y;
    const inset = edge < 5 ? inner[edge] : 0;
    for (let x = inset; x < 294 - inset; x++) putPixel565(fb, 13 + x, 77 + y, paperColor);
  }
}

function drawVolumeOverlay565(fb, layout, theme, coverPalette, vol) {
  if (!vol || vol.visible === false) return;
  if (layout !== 4 && vol.scope === 0) return;
  const inset = [7, 4, 3, 2, 1, 1, 0, 0, 0, 0];
  const alpha = Math.max(0, Math.min(256, vol.alpha ?? 256));
  const muted = Boolean(vol.muted);
  const level = Math.max(0, Math.min(100, vol.level ?? 60));
  const progress = muted ? 0 : level * 256;
  const shift = Math.floor(((256 - alpha) * 6) / 256);
  const label = muted ? '--' : `${level}%`;
  const style = vol.style ?? 0;

  if (style === 1 && layout === 4) {
    const barEnd = 18 + Math.floor((progress * 284) / 25600);
    for (let y = 142; y < 148; y++) {
      for (let x = 18; x < 302; x++) {
        blendPixel565(fb, x, y, x < barEnd ? 0xffff : 0x738e, alpha);
      }
    }
    for (let y = 0; y < 13; y++) {
      for (let x = 0; x < 16; x++) {
        if (lyricsVolumeIcon(x, y, muted || !level)) blendPixel565(fb, 18 + x, 151 + y, 0xffff, alpha);
      }
    }
    drawAscii565(fb, label, 303 - label.length * 6, 153, 1, 0xffff, alpha);
    return;
  }

  const baseColor = layout === 4 ? coverPalette[0] : rgb565(theme.ink);
  const r = Math.floor((baseColor >>> 11) / 2);
  const g = Math.floor(((baseColor >>> 5) & 63) / 2);
  const b = Math.floor((baseColor & 31) / 2);
  const shade = (r << 11) | (g << 5) | b;
  const track =
    ((r + Math.floor((31 - r) / 5)) << 11) |
    ((g + Math.floor((63 - g) / 5)) << 5) |
    (b + Math.floor((31 - b) / 5));

  for (let y = 0; y < 72; y++) {
    const edge = y < 36 ? y : 71 - y;
    const pad = edge < 10 ? inset[edge] : 0;
    for (let x = pad; x < 224 - pad; x++) blendPixel565(fb, 48 + x, 54 + y + shift, shade, alpha);
  }
  const left = 160 - Math.floor((32 + 14 + (label.length * 6 - 1) * 4) / 2);
  for (let y = 0; y < 13; y++) {
    for (let x = 0; x < 16; x++) {
      if (lyricsVolumeIcon(x, y, muted || !level)) {
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            blendPixel565(fb, left + x * 2 + dx, 68 + y * 2 + dy + shift, 0xffff, alpha);
          }
        }
      }
    }
  }
  drawAscii565(fb, label, left + 46, 67 + shift, 4, 0xffff, alpha);
  const fillW = Math.floor((progress * 176) / 25600);
  for (let y = 110; y < 116; y++) {
    for (let k = 0; k < 176; k++) {
      blendPixel565(fb, 72 + k, y + shift, k < fillW ? 0xffff : track, alpha);
    }
  }
}

function buildDefaultCover48(theme) {
  const c0 = rgb565(theme.accent);
  const c1 = rgb565(theme.shell);
  const c2 = rgb565(theme.ink);
  const c3 = rgb565(theme.panel);
  const pixels = new Uint16Array(48 * 48);
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) {
      const dx = x - 24;
      const dy = y - 24;
      const dist = dx * dx + dy * dy;
      pixels[y * 48 + x] = dist < 144 ? c3 : dist < 324 ? c0 : ((x + y) & 8) ? c1 : c2;
    }
  }
  const palette = [c2, c0, c1, c2].map(v => {
    const [r, g, b] = rgb565ToRgb(v).map(ch => Math.round(ch * 0.48));
    return rgb565FromRgb(r, g, b);
  });
  return { pixels, palette };
}

function renderImmersive565(fb, theme, state) {
  const NOISE = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const coverActive = state.coverActive !== false;
  const fallbackCover = buildDefaultCover48(theme);
  const rawPalette = state.coverPalette
    ? state.coverPalette.map(c => typeof c === 'string' ? rgb565(c) : (c & 0xffff))
    : (coverActive ? fallbackCover.palette : [0x2104, 0x2104, 0x2104, 0x2104]);
  const shifts = [11, 5, 0];
  const masks = [31, 63, 31];
  const corners = rawPalette.map(col => shifts.map((s, k) => (col >>> s) & masks[k]));

  const bgGrid = new Uint16Array(18 * 80 * 2);
  for (let y = 0; y < 18; y++) {
    const left = [];
    const right = [];
    const v = [];
    const step = [];
    for (let k = 0; k < 3; k++) {
      left[k] = Math.trunc(((corners[0][k] * (17 - y) + corners[2][k] * y) * 256) / 17);
      right[k] = Math.trunc(((corners[1][k] * (17 - y) + corners[3][k] * y) * 256) / 17);
      v[k] = left[k];
      step[k] = Math.trunc((right[k] - left[k]) / 79);
    }
    for (let x = 0; x < 80; x++) {
      let color = 0;
      let fraction = 0;
      for (let k = 0; k < 3; k++) {
        const q = (v[k] >>> 8) & masks[k];
        color |= q << shifts[k];
        fraction |= (((v[k] & 255) >>> 4) << (8 - k * 4));
        v[k] += step[k];
      }
      const at = (y * 80 + x) * 2;
      bgGrid[at] = color;
      bgGrid[at + 1] = fraction;
    }
  }

  for (let y = 0; y < SCREEN_HEIGHT; y++) {
    const gy = Math.floor((y * 18) / SCREEN_HEIGHT);
    const rowAt = y * SCREEN_WIDTH;
    for (let x = 0; x < 80; x++) {
      const at = (gy * 80 + x) * 2;
      const base = bgGrid[at];
      const frac = bgGrid[at + 1];
      const r = frac >>> 8;
      const g = (frac >>> 4) & 15;
      const b = frac & 15;
      for (let k = 0; k < 4; k++) {
        const th = NOISE[(y & 3) * 4 + k];
        fb[rowAt + x * 4 + k] = base + ((r > th ? 1 : 0) << 11) + ((g > th ? 1 : 0) << 5) + (b > th ? 1 : 0);
      }
    }
  }

  if (coverActive) {
    const coverPixels = state.coverRgb565 || fallbackCover.pixels;
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 48; x++) {
        if ((x < 3 || x > 44) && (y < 3 || y > 44) && ((x < 3 ? 3 - x : x - 44) + (y < 3 ? 3 - y : y - 44) > 3)) {
          continue;
        }
        putPixel565(fb, 16 + x, 14 + y, coverPixels[y * 48 + x]);
      }
    }
  }

  const titleLine = buildPreviewLine(state.title ?? 'Rainy75 Radio');
  const currentLine = buildPreviewLine(state.current ?? 'Pixels move with the beat');
  const nextLine = buildPreviewLine(state.next ?? 'Next line preview');

  drawLine565(fb, titleLine, 28, 224, 0xffff, 28, 48, 1, 80);

  const textSize = [20, 30, 40].includes(state.textSize) ? state.textSize : 30;
  const textStyle = state.textStyle === 'soft' || state.textStyle === 1 ? 1 : 0;
  const top = textSize === 40 ? 68 : textSize === 20 ? 80 : 74;
  if (textSize === 30) {
    draw30Line565(fb, currentLine, top, textStyle, 68, 110);
  } else {
    drawLine565(fb, currentLine, top, 288, 0xffff, 68, 110, textSize === 40 ? 2 : 1, 16);
  }
  drawLine565(fb, nextLine, 113, 286, 0xbdf7, 113, 133, 1, 17);

  const dur = Math.max(0, state.durationMs ?? 222000);
  const pos = Math.max(0, Math.min(dur, state.positionMs ?? 86000));
  const progress = Math.floor(dur / 100) ? Math.floor((Math.floor(pos / 100) * 284) / Math.floor(dur / 100)) : 0;
  const vol = state.volumeOverlay;
  const volActive = Boolean(vol && vol.visible !== false);
  const volAlpha = volActive ? Math.max(0, Math.min(256, vol.alpha ?? 256)) : 0;
  const bottomAlpha = volActive && (vol.style ?? 0) === 1 ? 256 - volAlpha : 256;

  for (let y = 142; y < 148; y++) {
    for (let x = 18; x < 302; x++) {
      blendPixel565(fb, x, y, x < 18 + progress ? 0xffff : 0x738e, bottomAlpha);
    }
  }
  drawAscii565(fb, formatStamp(pos), 18, 153, 1, 0xbdf7, bottomAlpha);
  drawAscii565(fb, formatStamp(dur), 272, 153, 1, 0xbdf7, bottomAlpha);

  drawVolumeOverlay565(fb, 4, theme, rawPalette, vol);
}

function surfaceTo565(input, theme, phase) {
  if (!input) return renderBaseFrame565(theme, { phase });
  if (input instanceof Uint16Array && input.length === SCREEN_WIDTH * SCREEN_HEIGHT) {
    return new Uint16Array(input);
  }
  const data = input?.data ? input.data : input;
  const total = SCREEN_WIDTH * SCREEN_HEIGHT;
  const fb = new Uint16Array(total);
  if (data instanceof Uint8ClampedArray || data instanceof Uint8Array) {
    if (data.length === total * 4) {
      for (let i = 0; i < total; i++) {
        const at = i * 4;
        fb[i] = rgb565FromRgb(data[at], data[at + 1], data[at + 2]);
      }
      return fb;
    }
    if (data.length === total * 3) {
      for (let i = 0; i < total; i++) {
        const at = i * 3;
        fb[i] = rgb565FromRgb(data[at], data[at + 1], data[at + 2]);
      }
      return fb;
    }
  }
  throw new Error('输入帧缓冲必须是 320×172 的 RGBA / RGB / RGB565 缓冲');
}

function fb565ToRgba(fb) {
  const out = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
  for (let i = 0; i < fb.length; i++) {
    const [r, g, b] = rgb565ToRgb(fb[i]);
    const at = i * 4;
    out[at] = r;
    out[at + 1] = g;
    out[at + 2] = b;
    out[at + 3] = 255;
  }
  return out;
}

/**
 * Software 320x172 RGB565-accurate screen preview renderer (returns Uint8ClampedArray RGBA).
 * Supports views: 'keys' | 'layout0' | 'layout1' | 'layout2' | 'layout3' | 'layout4'.
 */
export function renderScreenPreview(imageDataOrBuffer320x172, state = {}) {
  let buffer = imageDataOrBuffer320x172;
  let cfg = state;
  if (
    buffer &&
    typeof buffer === 'object' &&
    !(buffer instanceof Uint8Array) &&
    !(buffer instanceof Uint8ClampedArray) &&
    !(buffer instanceof Uint16Array) &&
    !buffer.data &&
    state &&
    Object.keys(state).length === 0
  ) {
    cfg = buffer;
    buffer = null;
  }

  const theme = normalizeTheme(cfg.theme || PRESET_THEMES.pink);
  const view = cfg.view || 'keys';
  const fb = surfaceTo565(buffer, theme, cfg.phase ?? 0);
  const ink = rgb565(theme.ink);
  const bg = rgb565(theme.background);
  const panel = rgb565(theme.panel);
  const track = rgb565(theme.shell);
  const accent = rgb565(theme.accent);
  const muted = rgb565(theme.muted);
  const card = rgb565(theme.lyricsBorder);
  const paper = rgb565(theme.lyricsPanel);

  if (view === 'layout4') {
    renderImmersive565(fb, theme, cfg);
    return fb565ToRgba(fb);
  }

  // Regions 1..4 top status bar (and Region 0 keycap for 'keys')
  drawStatusRegions(fb, cfg, ink, bg);

  if (view === 'keys') {
    drawKeyRegion(fb, cfg, ink, panel);
    return fb565ToRgba(fb);
  }

  const layoutMatch = /^layout([0-3])$/.exec(view);
  if (!layoutMatch) {
    throw new Error(`未知预览视图：${String(view)}`);
  }
  const layout = Number(layoutMatch[1]);

  // Clear y=37..171 to BG, draw TRACK divider at y=40 (layout 0) or y=37 (layout 1..3)
  fillRect565(fb, 0, 37, SCREEN_WIDTH - 1, SCREEN_HEIGHT - 1, bg);
  const dividerY = layout ? 37 : 40;
  for (let x = 16; x < 304; x++) putPixel565(fb, x, dividerY, track);

  const titleLine = buildPreviewLine(cfg.title ?? 'Rainy75 Radio');
  const currentLine = buildPreviewLine(cfg.current ?? 'Pixels move with the beat');
  const nextLine = buildPreviewLine(cfg.next ?? 'Next line preview');
  const dur = Math.max(0, cfg.durationMs ?? 222000);
  const pos = Math.max(0, Math.min(dur, cfg.positionMs ?? 86000));
  const durUnit = Math.floor(dur / 100);
  const progress = durUnit ? Math.floor((Math.floor(pos / 100) * 285) / durUnit) : 0;

  if (layout === 3) {
    // Wrap currentLine at 144px boundary
    const starts = [];
    const widths = [];
    let start = 0;
    let width = 0;
    for (let i = 0; i < currentLine.count; i++) {
      const adv = currentLine.advance[i];
      if (width && width + adv > 144) {
        starts.push(start);
        widths.push(width);
        start += width;
        width = 0;
      }
      width += adv;
    }
    if (width) {
      starts.push(start);
      widths.push(width);
    }
    const pages = Math.max(1, Math.ceil(starts.length / 2));
    const page = Math.min(pages - 1, Math.max(0, cfg.page ?? 0));
    drawLine565(fb, titleLine, 43, pages > 1 ? 244 : 286, ink, 43, 63, 1, 17);
    if (pages > 1) drawAscii565(fb, `${page + 1}/${pages}`, 278, 49, 1, ink);
    const sliceDraw = (rowStart, rowW, sy) => {
      const left = 16 + Math.floor((288 - rowW * 2) / 2);
      for (let yy = 0; yy < 40; yy++) {
        for (let x = 0; x < rowW * 2; x++) {
          if (monoDot(currentLine, rowStart + Math.floor(x / 2), Math.floor(yy / 2))) {
            putPixel565(fb, left + x, sy + yy, ink);
          }
        }
      }
    };
    const row = page * 2;
    if (row < starts.length) {
      sliceDraw(starts[row], widths[row], row + 1 < starts.length ? 74 : 94);
      if (row + 1 < starts.length) sliceDraw(starts[row + 1], widths[row + 1], 118);
    }
    for (let y = 167; y < 169; y++) {
      for (let x = 18; x < 303; x++) putPixel565(fb, x, y, x < 18 + progress ? accent : track);
    }
    drawVolumeOverlay565(fb, layout, theme, [ink], cfg.volumeOverlay);
    return fb565ToRgba(fb);
  }

  if (layout === 2) {
    drawLine565(fb, titleLine, 43, 286, ink, 43, 63, 1, 17);
    drawLine565(fb, currentLine, 79, 288, ink, 76, 123, 2, 16);
    drawLine565(fb, nextLine, 127, 286, muted, 127, 147, 1, 17);
  } else if (layout === 1) {
    drawLine565(fb, titleLine, 43, 286, ink, 43, 63, 1, 17);
    drawClassicCard(fb, card, paper);
    drawLine565(fb, currentLine, 90, 288, ink, 78, 143, 2, 16);
  } else {
    drawLine565(fb, titleLine, 51, 286, ink, 48, 75, 1, 17);
    drawLine565(fb, currentLine, 86, 286, ink, 86, 135, 1, 17);
    drawLine565(fb, nextLine, 114, 286, muted, 86, 135, 1, 17);
  }

  const barOff = layout ? 11 : 0;
  for (let y = 143 + barOff; y < 146 + barOff; y++) {
    for (let x = 18; x < 303; x++) putPixel565(fb, x, y, x < 18 + progress ? accent : track);
  }
  for (let y = 142 + barOff; y < 147 + barOff; y++) {
    for (let x = 18 + progress; x < 21 + progress && x < 305; x++) putPixel565(fb, x, y, ink);
  }
  drawAscii565(fb, formatStamp(pos), 18, layout ? 162 : 155, 1, ink);
  drawAscii565(fb, formatStamp(dur), 272, layout ? 162 : 155, 1, ink);

  const ctrlOff = layout ? 8 : 0;
  const playing = cfg.playing !== false;
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 5; x++) {
      if (playing ? (x < 2 || x >= 3) : x <= Math.floor((y < 5 ? y : 8 - y) / 2)) {
        putPixel565(fb, 155 + x, 153 + ctrlOff + y, ink);
      }
    }
  }
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 5; x++) {
      const span = y < 4 ? y : 6 - y;
      if (x === 0 || x >= 4 - span) putPixel565(fb, 133 + x, 154 + ctrlOff + y, ink);
      if (x === 4 || x <= span) putPixel565(fb, 177 + x, 154 + ctrlOff + y, ink);
    }
  }

  drawVolumeOverlay565(fb, layout, theme, [ink], cfg.volumeOverlay);
  return fb565ToRgba(fb);
}

/**
 * Render screen preview directly onto a 2D canvas element (or compatible mock canvas).
 */
export function drawPreviewToCanvas(canvas, state = {}, imageDataOrBuffer320x172 = null) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error('无效的 Canvas 对象');
  }
  const rgba = renderScreenPreview(
    imageDataOrBuffer320x172 ?? state?.backgroundFrame ?? state?.frame ?? null,
    state
  );
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法获取 Canvas 2D 上下文');
  const imageData = typeof ImageData !== 'undefined'
    ? new ImageData(rgba, SCREEN_WIDTH, SCREEN_HEIGHT)
    : Object.assign(ctx.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT), { data: rgba });
  if (typeof ImageData === 'undefined' && imageData.data !== rgba) {
    imageData.data.set(rgba);
  }
  ctx.putImageData(imageData, 0, 0);
  return rgba;
}

// --- User Design Profile JSON Import / Export ---

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new Error('无效的 GIF Base64 数据');
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function normalizePlayerSettings(settings) {
  if (!settings) return null;
  if (typeof settings !== 'object') throw new Error('playerSettings 必须为对象');
  const out = {};
  if (settings.layout !== undefined) {
    if (!Number.isInteger(settings.layout) || settings.layout < 0 || settings.layout > 4) {
      throw new Error('playerSettings.layout 必须为 0..4');
    }
    out.layout = settings.layout;
  }
  if (settings.textSize !== undefined) {
    if (![20, 30, 40].includes(settings.textSize)) {
      throw new Error('playerSettings.textSize 必须为 20、30 或 40');
    }
    out.textSize = settings.textSize;
  }
  if (settings.textStyle !== undefined) {
    if (settings.textStyle !== 0 && settings.textStyle !== 1) {
      throw new Error('playerSettings.textStyle 必须为 0 或 1');
    }
    out.textStyle = settings.textStyle;
  }
  if (settings.volumeEnabled !== undefined) {
    if (typeof settings.volumeEnabled !== 'boolean') throw new Error('volumeEnabled 必须为布尔值');
    out.volumeEnabled = settings.volumeEnabled;
  }
  if (settings.volumeScope !== undefined) {
    if (settings.volumeScope !== 0 && settings.volumeScope !== 1) throw new Error('volumeScope 必须为 0 或 1');
    out.volumeScope = settings.volumeScope;
  }
  if (settings.volumeStyle !== undefined) {
    if (settings.volumeStyle !== 0 && settings.volumeStyle !== 1) throw new Error('volumeStyle 必须为 0 或 1');
    out.volumeStyle = settings.volumeStyle;
  }
  if (settings.volumeHoldMs !== undefined) {
    if (!Number.isInteger(settings.volumeHoldMs) || settings.volumeHoldMs < 400 || settings.volumeHoldMs > 3000) {
      throw new Error('volumeHoldMs 必须为 400..3000 毫秒');
    }
    out.volumeHoldMs = settings.volumeHoldMs;
  }
  return out;
}

function normalizeCustomGifPayload(customGif, forExport) {
  if (!customGif) return null;
  if (typeof customGif !== 'object') throw new Error('customGif 必须为对象');
  const out = {};
  if (customGif.bytes instanceof Uint8Array) {
    if (customGif.bytes.length > 4 * 1024 * 1024) throw new Error('嵌入 GIF 超过 4MiB 上限');
    if (forExport) out.base64 = bytesToBase64(customGif.bytes);
    else out.bytes = new Uint8Array(customGif.bytes);
  } else if (typeof customGif.base64 === 'string') {
    const decoded = base64ToBytes(customGif.base64);
    if (decoded.length > 4 * 1024 * 1024) throw new Error('嵌入 GIF 超过 4MiB 上限');
    if (forExport) out.base64 = customGif.base64;
    else out.bytes = decoded;
  }
  if (customGif.transforms && typeof customGif.transforms === 'object') {
    const tr = customGif.transforms;
    const clean = {};
    if (tr.fit !== undefined) {
      if (!['contain', 'cover', 'crop', 'stretch'].includes(tr.fit)) throw new Error('无效 GIF fit 模式');
      clean.fit = tr.fit;
    }
    if (tr.scale !== undefined) {
      if (typeof tr.scale !== 'number' || !Number.isFinite(tr.scale) || tr.scale <= 0 || tr.scale > 16) {
        throw new Error('无效 GIF scale 参数');
      }
      clean.scale = tr.scale;
    }
    for (const axis of ['offsetX', 'offsetY']) {
      if (tr[axis] !== undefined) {
        if (typeof tr[axis] !== 'number' || !Number.isFinite(tr[axis])) throw new Error(`无效 GIF ${axis}`);
        clean[axis] = tr[axis];
      }
    }
    if (tr.bgMode !== undefined) {
      if (!['theme', 'custom', 'matte'].includes(tr.bgMode)) throw new Error('无效 GIF bgMode');
      clean.bgMode = tr.bgMode;
    }
    if (tr.customBg !== undefined && tr.customBg !== null) {
      clean.customBg = normalizeHex(tr.customBg, 'customBg');
    }
    if (tr.overlayBezel !== undefined) {
      if (typeof tr.overlayBezel !== 'boolean') throw new Error('overlayBezel 必须为布尔值');
      clean.overlayBezel = tr.overlayBezel;
    }
    if (tr.speed !== undefined) {
      if (typeof tr.speed !== 'number' || !Number.isFinite(tr.speed) || tr.speed <= 0 || tr.speed > 10) {
        throw new Error('无效 GIF speed 倍率');
      }
      clean.speed = tr.speed;
    }
    if (tr.placementPreset !== undefined && tr.placementPreset !== null) {
      if (!['pet-right', 'center', 'fullscreen'].includes(tr.placementPreset)) {
        throw new Error('无效 GIF placementPreset 模式');
      }
      clean.placementPreset = tr.placementPreset;
    }
    if (tr.chromaKeyColor !== undefined && tr.chromaKeyColor !== null && tr.chromaKeyColor !== '') {
      clean.chromaKeyColor = normalizeHex(tr.chromaKeyColor, 'chromaKeyColor');
    }
    if (tr.chromaKeyTolerance !== undefined) {
      if (typeof tr.chromaKeyTolerance !== 'number' || !Number.isFinite(tr.chromaKeyTolerance) || tr.chromaKeyTolerance < 0 || tr.chromaKeyTolerance > 120) {
        throw new Error('无效 GIF chromaKeyTolerance 参数');
      }
      clean.chromaKeyTolerance = tr.chromaKeyTolerance;
    }
    if (tr.bgBlur !== undefined && tr.bgBlur !== null) {
      if (typeof tr.bgBlur !== 'boolean' && (typeof tr.bgBlur !== 'number' || !Number.isFinite(tr.bgBlur) || tr.bgBlur < 0 || tr.bgBlur > 32)) {
        throw new Error('无效 GIF bgBlur 参数');
      }
      clean.bgBlur = tr.bgBlur;
    }
    if (tr.flipX !== undefined) {
      if (typeof tr.flipX !== 'boolean') throw new Error('flipX 必须为布尔值');
      clean.flipX = tr.flipX;
    }
    if (tr.enableAlpha !== undefined) {
      if (typeof tr.enableAlpha !== 'boolean') throw new Error('enableAlpha 必须为布尔值');
      clean.enableAlpha = tr.enableAlpha;
    }
    out.transforms = clean;
  }
  return out;
}

/**
 * Export a portable rainy75v2-tft/design-v1 user configuration object.
 */
export function exportDesignProfile({ name = 'Rainy75 设计方案', track = 'A', keys = null, theme, customGif = null, playerSettings = null }) {
  if (!['A', 'B', 'C'].includes(track)) {
    throw new Error(`无效功能轨道：${String(track)}`);
  }
  const normalizedTheme = normalizeTheme(theme || PRESET_THEMES.pink);
  const validatedKeys = keys ? validateKeysProfile(JSON.parse(JSON.stringify(keys))) : null;
  const validatedGif = normalizeCustomGifPayload(customGif, true);
  const validatedPlayer = normalizePlayerSettings(playerSettings);
  return {
    format: 'rainy75v2-tft/design-v1',
    version: 1,
    name: String(name || 'Rainy75 设计方案'),
    track,
    theme: normalizedTheme,
    keys: validatedKeys,
    customGif: validatedGif,
    playerSettings: validatedPlayer
  };
}

/**
 * Import and validate a rainy75v2-tft/design-v1 JSON string or object.
 */
export function importDesignProfile(jsonTextOrObj) {
  let obj = jsonTextOrObj;
  if (typeof jsonTextOrObj === 'string') {
    try {
      obj = JSON.parse(jsonTextOrObj);
    } catch (e) {
      throw new Error(`设计配置 JSON 解析失败：${e.message}`);
    }
  }
  if (!obj || typeof obj !== 'object' || obj.format !== 'rainy75v2-tft/design-v1') {
    throw new Error('设计配置格式不匹配，需要 rainy75v2-tft/design-v1');
  }
  if (!['A', 'B', 'C'].includes(obj.track || 'A')) {
    throw new Error(`无效功能轨道：${String(obj.track)}`);
  }
  return {
    format: 'rainy75v2-tft/design-v1',
    version: obj.version || 1,
    name: String(obj.name || 'Rainy75 设计方案'),
    track: obj.track || 'A',
    theme: normalizeTheme(obj.theme),
    keys: obj.keys ? validateKeysProfile(obj.keys) : null,
    customGif: normalizeCustomGifPayload(obj.customGif, false),
    playerSettings: normalizePlayerSettings(obj.playerSettings)
  };
}
