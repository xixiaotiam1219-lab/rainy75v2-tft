// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  decodeGif,
  rgbaToStaticGifSource,
  composePetGifFrames,
  encodeGif320x172,
  auditDeviceGif
} from '../web/gif-studio.mjs';
import {
  PRESET_THEMES,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  rgb565,
  rgb565FromRgb,
  rgb565ToRgb
} from '../web/theme-engine.mjs';
import { validateGif } from '../web/protocol.mjs';

function lzwCompressGif(indices, minCodeSize = 8) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const out = [];
  let bitBuf = 0;
  let bitCount = 0;
  const emit = (code, bits) => {
    bitBuf |= code << bitCount;
    bitCount += bits;
    while (bitCount >= 8) {
      out.push(bitBuf & 255);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  const dict = new Map();
  emit(clearCode, codeSize);
  let prefix = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i];
    const combo = `${prefix},${c}`;
    if (dict.has(combo)) {
      prefix = combo;
    } else {
      emit(dict.has(prefix) ? dict.get(prefix) : Number(prefix), codeSize);
      if (nextCode < 4096) {
        dict.set(combo, nextCode);
        if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
        nextCode++;
      } else {
        emit(clearCode, codeSize);
        dict.clear();
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
      }
      prefix = String(c);
    }
  }
  emit(dict.has(prefix) ? dict.get(prefix) : Number(prefix), codeSize);
  emit(eoiCode, codeSize);
  if (bitCount > 0) out.push(bitBuf & 255);
  return Uint8Array.from(out);
}

function buildTestGif({
  version = 'GIF89a',
  width,
  height,
  gct,
  frames,
  loop = true
}) {
  const out = [];
  const pushStr = s => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };
  pushStr(version);
  out.push(width & 255, width >> 8, height & 255, height >> 8);
  const gctPow = gct ? Math.max(0, Math.ceil(Math.log2(Math.max(2, gct.length))) - 1) : 0;
  const gctFlag = gct ? (0x80 | (7 << 4) | gctPow) : 0x00;
  out.push(gctFlag, 0x00, 0x00);
  if (gct) {
    const tableLen = 1 << (gctPow + 1);
    for (let i = 0; i < tableLen; i++) {
      const c = gct[i] || [0, 0, 0];
      out.push(c[0], c[1], c[2]);
    }
  }
  if (version === 'GIF89a' && loop) {
    out.push(0x21, 0xff, 0x0b);
    pushStr('NETSCAPE2.0');
    out.push(0x03, 0x01, 0x00, 0x00, 0x00);
  }
  for (const f of frames) {
    if (version === 'GIF89a') {
      const disposal = f.disposal ?? 1;
      const tFlag = f.transparentIndex !== undefined && f.transparentIndex !== null ? 1 : 0;
      const delayCs = Math.round((f.delayMs ?? 100) / 10);
      out.push(0x21, 0xf9, 0x04, ((disposal & 7) << 2) | tFlag, delayCs & 255, delayCs >> 8, tFlag ? f.transparentIndex : 0, 0x00);
    }
    const left = f.left ?? 0;
    const top = f.top ?? 0;
    const fw = f.width ?? width;
    const fh = f.height ?? height;
    const interlaced = f.interlaced ? 0x40 : 0x00;
    let lctFlag = 0;
    let lctSizePow = 0;
    if (f.lct) {
      lctSizePow = Math.max(0, Math.ceil(Math.log2(Math.max(2, f.lct.length))) - 1);
      lctFlag = 0x80 | lctSizePow;
    }
    out.push(
      0x2c,
      left & 255, left >> 8,
      top & 255, top >> 8,
      fw & 255, fw >> 8,
      fh & 255, fh >> 8,
      interlaced | lctFlag
    );
    if (f.lct) {
      const len = 1 << (lctSizePow + 1);
      for (let i = 0; i < len; i++) {
        const c = f.lct[i] || [0, 0, 0];
        out.push(c[0], c[1], c[2]);
      }
    }
    const minCode = f.minCodeSize ?? Math.max(2, (f.lct ? lctSizePow : gctPow) + 1);
    out.push(minCode);
    const compressed = lzwCompressGif(f.indices, minCode);
    for (let at = 0; at < compressed.length; at += 255) {
      const n = Math.min(255, compressed.length - at);
      out.push(n);
      for (let k = 0; k < n; k++) out.push(compressed[at + k]);
    }
    out.push(0x00);
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}

test('decodeGif handles GIF87a, interlace, disposal 1/2/3, transparency, and LZW dictionary reset', () => {
  // 1. GIF87a single interlaced 4x8 image with local palette
  const gct4 = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  // Expected display rows 0..7 -> pass rows in order [0], [4], [2,6], [1,3,5,7]
  const passOrderRows = [0, 4, 2, 6, 1, 3, 5, 7];
  const interlaceIndices = [];
  for (const r of passOrderRows) {
    for (let x = 0; x < 4; x++) interlaceIndices.push(r < 4 ? 0 : 2);
  }
  const gif87 = buildTestGif({
    version: 'GIF87a',
    width: 4,
    height: 8,
    gct: gct4,
    frames: [{ indices: interlaceIndices, interlaced: true }]
  });
  const dec87 = decodeGif(gif87);
  assert.equal(dec87.width, 4);
  assert.equal(dec87.height, 8);
  assert.equal(dec87.frames.length, 1);
  // Row 0 -> red, row 4 -> blue
  assert.deepEqual(Array.from(dec87.frames[0].rgba.slice(0, 4)), [255, 0, 0, 255]);
  assert.deepEqual(Array.from(dec87.frames[0].rgba.slice((4 * 4) * 4, (4 * 4) * 4 + 4)), [0, 0, 255, 255]);

  // 2. GIF89a disposal=1 (keep), disposal=2 (clear rect), disposal=3 (restore prev), + transparency
  const gifMulti = buildTestGif({
    width: 4,
    height: 4,
    gct: [[200, 10, 20], [10, 200, 20], [20, 20, 220], [240, 240, 240]],
    frames: [
      {
        disposal: 1,
        delayMs: 80,
        indices: new Array(16).fill(0) // entire canvas red, kept for frame 1
      },
      {
        disposal: 2, // paint green subrect [1..2, 1..2], transparent index 3 at (1,1) keeps red underneath, then clears [1..2, 1..2] before frame 2!
        delayMs: 120,
        left: 1,
        top: 1,
        width: 2,
        height: 2,
        transparentIndex: 3,
        indices: [3, 1, 1, 1]
      },
      {
        disposal: 3, // restore snapshot after frame 2
        delayMs: 60,
        left: 1,
        top: 1,
        width: 2,
        height: 2,
        indices: [2, 2, 2, 2]
      },
      {
        disposal: 1,
        delayMs: 100,
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        indices: [3]
      }
    ]
  });
  const decMulti = decodeGif(gifMulti);
  assert.equal(decMulti.frames.length, 4);
  assert.equal(decMulti.frames[0].delayMs, 80);
  // Frame 1: (1,1) transparent kept red (200,10,20); (2,1) became green (10,200,20)
  assert.deepEqual(Array.from(decMulti.frames[1].rgba.slice((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4)), [200, 10, 20, 255]);
  assert.deepEqual(Array.from(decMulti.frames[1].rgba.slice((1 * 4 + 2) * 4, (1 * 4 + 2) * 4 + 4)), [10, 200, 20, 255]);
  // After Frame 1 disposal=2 cleared [1..2, 1..2] -> Frame 2 overpainted [1..2,1..2] blue with disposal=3 -> Frame 3 should have snapshot cleared at (1,1)
  assert.equal(decMulti.frames[3].rgba[(1 * 4 + 1) * 4 + 3], 0);
  assert.deepEqual(Array.from(decMulti.frames[3].rgba.slice(0, 4)), [240, 240, 240, 255]);

  // 3. Large LZW frame forcing >4096 codes (clear-code reset mid-stream)
  const palette256 = Array.from({ length: 256 }, (_, i) => [i, (i * 3) & 255, (255 - i) & 255]);
  const noisy = new Uint8Array(120 * 120);
  for (let i = 0; i < noisy.length; i++) noisy[i] = (i * 73 + (i >> 5) * 19) & 255;
  const largeLzwGif = buildTestGif({
    width: 120,
    height: 120,
    gct: palette256,
    frames: [{ indices: noisy, minCodeSize: 8 }]
  });
  const decLarge = decodeGif(largeLzwGif);
  assert.equal(decLarge.width, 120);
  assert.equal(decLarge.frames[0].rgba[0], 0);

  // Error handling
  assert.throws(() => decodeGif(new Uint8Array([1, 2, 3])), /过短|文件头/);
  assert.throws(() => decodeGif(gifMulti.slice(0, gifMulti.length - 8)), /截断|结束/);
  assert.throws(() => decodeGif(buildTestGif({
    width: 2100,
    height: 10,
    gct: gct4,
    frames: [{ indices: new Array(2100 * 10).fill(0) }]
  })), /尺寸超出支持范围/);
});

test('composePetGifFrames, rgbaToStaticGifSource, and encodeGif320x172 obey hardware contracts', () => {
  const w = 64;
  const h = 48;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = (y * w + x) * 4;
      if (x < 10 || y < 6) {
        // Pure neon green chroma backdrop
        rgba[at] = 0; rgba[at + 1] = 250; rgba[at + 2] = 0; rgba[at + 3] = 255;
      } else if (x < 32) {
        rgba[at] = 230; rgba[at + 1] = 70; rgba[at + 2] = 110; rgba[at + 3] = 255;
      } else {
        rgba[at] = 40; rgba[at + 1] = 150; rgba[at + 2] = 220; rgba[at + 3] = 255;
      }
    }
  }
  const src = rgbaToStaticGifSource(rgba, w, h, 50);
  assert.equal(src.frames.length, 1);

  // Compose with bezel off AND bg matching theme.background: marker pixel (22,39) MUST still stay distinct in RGB565!
  const composedNoBezel = composePetGifFrames(src, {
    theme: 'mint',
    overlayBezel: false,
    bgMode: 'theme',
    fit: 'contain',
    chromaKeyColor: '#00ff00',
    chromaKeyTolerance: 25,
    flipX: true,
    bgBlur: 2,
    placementPreset: 'center',
    speed: 4 // 50 / 4 -> clamped to >= 20ms
  });
  assert.equal(composedNoBezel.length, 1);
  assert.equal(composedNoBezel[0].disposal, 1);
  assert.equal(composedNoBezel[0].delayMs, 20);
  const encoded = encodeGif320x172(composedNoBezel);
  validateGif(encoded);
  const audit = auditDeviceGif(encoded, 'mint');
  assert.equal(audit.ok, true);
  assert.equal(audit.width, SCREEN_WIDTH);
  assert.equal(audit.height, SCREEN_HEIGHT);

  const mintBg565 = rgb565(PRESET_THEMES.mint.background);
  const decOut = decodeGif(encoded);
  const markerAt = (39 * SCREEN_WIDTH + 22) * 4;
  const marker565 = rgb565FromRgb(
    decOut.frames[0].rgba[markerAt],
    decOut.frames[0].rgba[markerAt + 1],
    decOut.frames[0].rgba[markerAt + 2]
  );
  assert.notEqual(marker565, mintBg565);

  // Also test chromaKeyColor strips green edge cleanly without bgBlur when overlayBezel: true
  const composedChroma = composePetGifFrames(src, {
    theme: 'pink',
    placementPreset: 'pet-right',
    chromaKeyColor: '#00ff00',
    chromaKeyTolerance: 20,
    bgMode: 'theme'
  });
  // Top-left inside right viewport (180, 46) corresponds to keyed neon-green margin -> should match pink background RGB565
  const pxAt = (46 * SCREEN_WIDTH + 180) * 4;
  const pinkBgRgb = rgb565ToRgb(rgb565(PRESET_THEMES.pink.background));
  assert.deepEqual(Array.from(composedChroma[0].rgba.slice(pxAt, pxAt + 3)), pinkBgRgb);

  // Multi-frame speed + maxFrames downsampling
  const multiSrc = {
    width: 16,
    height: 16,
    frames: Array.from({ length: 10 }, (_, idx) => ({
      rgba: new Uint8ClampedArray(16 * 16 * 4).fill(20 + idx * 10),
      delayMs: 100
    }))
  };
  const downsampled = composePetGifFrames(multiSrc, { theme: 'mono', maxFrames: 4, speed: 2, fit: 'cover' });
  assert.equal(downsampled.length, 4);
  const encodedMulti = encodeGif320x172(downsampled);
  assert.equal(auditDeviceGif(encodedMulti, 'mono').frameCount, 4);
});

test('auditDeviceGif rejects disposal=2/3, sub-rects, transparency, and (22,39) marker collision; accepts repo robot-pink.gif', () => {
  const full320x172 = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT).fill(0);
  const pinkBgRgb = rgb565ToRgb(rgb565(PRESET_THEMES.pink.background));
  const gctPink = [pinkBgRgb, [40, 50, 60]];

  const badDisposal2 = buildTestGif({
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    gct: gctPink,
    frames: [{ disposal: 2, indices: full320x172 }]
  });
  assert.throws(() => auditDeviceGif(badDisposal2), /disposal=2/);

  const badSubRect = buildTestGif({
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    gct: gctPink,
    frames: [{ disposal: 1, left: 10, top: 10, width: 100, height: 80, indices: new Uint8Array(8000).fill(1) }]
  });
  assert.throws(() => auditDeviceGif(badSubRect), /不是完整 320×172/);

  const badTransparent = buildTestGif({
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    gct: gctPink,
    frames: [{ disposal: 1, transparentIndex: 0, indices: full320x172 }]
  });
  assert.throws(() => auditDeviceGif(badTransparent), /透明色标记/);

  const badMarker = buildTestGif({
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    gct: gctPink,
    frames: [{ disposal: 1, indices: full320x172 }] // pixel (22,39) === pink background!
  });
  assert.throws(() => auditDeviceGif(badMarker, 'pink'), /\(22,39\)/);

  const repoGif = new Uint8Array(fs.readFileSync(new URL('../assets/robot-pink.gif', import.meta.url)));
  const repoAudit = auditDeviceGif(repoGif, 'pink');
  assert.equal(repoAudit.ok, true);
  assert(repoAudit.frameCount >= 1);
});
