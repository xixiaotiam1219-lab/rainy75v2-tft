// SPDX-License-Identifier: MIT
import { validateGif } from './protocol.mjs';
import {
  PRESET_THEMES,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  normalizeHex,
  normalizeTheme,
  hexToRgb,
  rgb565,
  rgb565FromRgb,
  rgb565ToRgb,
  drawBezelOverlay565
} from './theme-engine.mjs';

const MAX_GIF_DIM = 2048;
const MAX_GIF_FRAMES = 300;
const MAX_DEVICE_GIF_BYTES = 4 * 1024 * 1024;
const INTERLACE_PASSES = [
  [0, 8],
  [4, 8],
  [2, 4],
  [1, 2]
];

function readU16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function decompressGifLzw(data, minCodeSize, expectedPixels) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const stack = new Uint8Array(4096);
  for (let i = 0; i < clearCode; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
  }

  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let prevCode = -1;
  let bitBuf = 0;
  let bitCount = 0;
  let bytePos = 0;
  let outPos = 0;
  const output = new Uint8Array(expectedPixels);

  const readCode = bits => {
    while (bitCount < bits) {
      if (bytePos >= data.length) return -1;
      bitBuf |= data[bytePos++] << bitCount;
      bitCount += 8;
    }
    const code = bitBuf & ((1 << bits) - 1);
    bitBuf >>>= bits;
    bitCount -= bits;
    return code;
  };

  while (true) {
    const code = readCode(codeSize);
    if (code < 0) {
      if (outPos < expectedPixels) throw new Error('GIF LZW 图像数据截断');
      break;
    }
    if (code === eoiCode) break;
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
      prevCode = -1;
      continue;
    }

    let stackLen = 0;
    let firstChar = 0;
    if (code < nextCode) {
      let cur = code;
      while (cur >= clearCode && stackLen < 4096) {
        stack[stackLen++] = suffix[cur];
        cur = prefix[cur];
      }
      if (cur < 0 || stackLen >= 4096) throw new Error('GIF LZW 字典索引损坏');
      stack[stackLen++] = cur;
      firstChar = cur;
    } else if (code === nextCode && prevCode !== -1) {
      firstChar = first[prevCode];
      stack[stackLen++] = firstChar;
      let cur = prevCode;
      while (cur >= clearCode && stackLen < 4096) {
        stack[stackLen++] = suffix[cur];
        cur = prefix[cur];
      }
      if (cur < 0 || stackLen >= 4096) throw new Error('GIF LZW KwKwK 字典损坏');
      stack[stackLen++] = cur;
    } else {
      throw new Error('GIF LZW 编码流无效或已损坏');
    }

    while (stackLen > 0) {
      const px = stack[--stackLen];
      if (outPos < expectedPixels) output[outPos++] = px;
    }

    if (prevCode !== -1 && nextCode < 4096) {
      prefix[nextCode] = prevCode;
      suffix[nextCode] = firstChar;
      first[nextCode] = first[prevCode];
      nextCode++;
      if (nextCode === (1 << codeSize) && codeSize < 12) {
        codeSize++;
      }
    }
    prevCode = code;
  }

  return output;
}

function unswizzleInterlaced(indices, width, height) {
  const out = new Uint8Array(indices.length);
  let srcRow = 0;
  for (const [start, step] of INTERLACE_PASSES) {
    for (let y = start; y < height; y += step) {
      out.set(indices.subarray(srcRow * width, (srcRow + 1) * width), y * width);
      srcRow++;
    }
  }
  return out;
}

function parseGifInternal(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('GIF 数据必须为 Uint8Array 或 ArrayBuffer');
  }
  if (bytes.length < 14) {
    throw new Error('GIF 文件过短，头部不完整');
  }
  const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') {
    throw new Error(`无效的 GIF 文件头：${sig}`);
  }

  const width = readU16LE(bytes, 6);
  const height = readU16LE(bytes, 8);
  if (width < 1 || height < 1 || width > MAX_GIF_DIM || height > MAX_GIF_DIM) {
    throw new Error(`GIF 尺寸超出支持范围（${width}×${height}，限制 1..${MAX_GIF_DIM}）`);
  }

  const lsdPacked = bytes[10];
  const gctFlag = (lsdPacked >> 7) & 1;
  const gctCount = gctFlag ? (1 << ((lsdPacked & 7) + 1)) : 0;
  let pos = 13;

  let gct = null;
  if (gctFlag) {
    const gctBytes = gctCount * 3;
    if (pos + gctBytes > bytes.length) throw new Error('GIF 全局调色板数据截断');
    gct = bytes.subarray(pos, pos + gctBytes);
    pos += gctBytes;
  }

  const canvas = new Uint8ClampedArray(width * height * 4);
  const frames = [];
  const meta = [];
  let gce = null;
  let loopCount = null;

  const readSubBlocks = concat => {
    const chunks = [];
    let total = 0;
    while (true) {
      if (pos >= bytes.length) throw new Error('GIF 子块读取越界（文件截断）');
      const len = bytes[pos++];
      if (len === 0) break;
      if (pos + len > bytes.length) throw new Error('GIF 子块长度超出文件末尾');
      if (concat) {
        chunks.push(bytes.subarray(pos, pos + len));
        total += len;
      }
      pos += len;
    }
    if (!concat) return null;
    const merged = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      merged.set(c, at);
      at += c.length;
    }
    return merged;
  };

  while (pos < bytes.length) {
    const intro = bytes[pos++];
    if (intro === 0x3b) break;

    if (intro === 0x21) {
      if (pos >= bytes.length) throw new Error('GIF 扩展块截断');
      const label = bytes[pos++];
      if (label === 0xf9) {
        if (pos >= bytes.length) throw new Error('GIF 图形控制扩展截断');
        const blockSize = bytes[pos++];
        if (blockSize !== 4 || pos + 4 >= bytes.length) {
          throw new Error('GIF 图形控制扩展长度无效');
        }
        const packed = bytes[pos];
        gce = {
          disposal: (packed >> 2) & 7,
          transparentFlag: packed & 1,
          delayCs: readU16LE(bytes, pos + 1),
          transparentIndex: bytes[pos + 3]
        };
        pos += 4;
        readSubBlocks(false);
      } else if (label === 0xff) {
        if (pos >= bytes.length) throw new Error('GIF 应用扩展块截断');
        const appLen = bytes[pos++];
        if (pos + appLen > bytes.length) throw new Error('GIF 应用扩展头部截断');
        const appId = String.fromCharCode(...bytes.subarray(pos, pos + appLen));
        pos += appLen;
        const appData = readSubBlocks(true);
        if ((appId === 'NETSCAPE2.0' || appId === 'ANIMEXTS1.0') && appData.length >= 3 && appData[0] === 1) {
          loopCount = readU16LE(appData, 1);
        }
      } else {
        readSubBlocks(false);
      }
      continue;
    }

    if (intro === 0x2c) {
      if (frames.length >= MAX_GIF_FRAMES) {
        throw new Error(`GIF 帧数超过上限（最多 ${MAX_GIF_FRAMES} 帧）`);
      }
      if (pos + 9 >= bytes.length) throw new Error('GIF 图像描述符截断');
      const left = readU16LE(bytes, pos);
      const top = readU16LE(bytes, pos + 2);
      const imgW = readU16LE(bytes, pos + 4);
      const imgH = readU16LE(bytes, pos + 6);
      const imgPacked = bytes[pos + 8];
      pos += 9;

      if (imgW < 1 || imgH < 1 || left + imgW > width || top + imgH > height) {
        throw new Error(`GIF 第 ${frames.length} 帧尺寸或偏移越出画布（${left},${top},${imgW},${imgH}）`);
      }

      const lctFlag = (imgPacked >> 7) & 1;
      const interlace = (imgPacked >> 6) & 1;
      const lctCount = lctFlag ? (1 << ((imgPacked & 7) + 1)) : 0;
      let palette = gct;
      if (lctFlag) {
        const lctBytes = lctCount * 3;
        if (pos + lctBytes > bytes.length) throw new Error('GIF 局部调色板数据截断');
        palette = bytes.subarray(pos, pos + lctBytes);
        pos += lctBytes;
      }
      if (!palette) throw new Error('GIF 图像帧缺少全局或局部调色板');

      if (pos >= bytes.length) throw new Error('GIF 缺少 LZW 最小码宽');
      const minCodeSize = bytes[pos++];
      if (minCodeSize < 1 || minCodeSize > 8) {
        throw new Error(`无效的 GIF LZW 最小码宽：${minCodeSize}`);
      }

      const compressed = readSubBlocks(true);
      let indices = decompressGifLzw(compressed, minCodeSize, imgW * imgH);
      if (interlace) {
        indices = unswizzleInterlaced(indices, imgW, imgH);
      }

      const disposal = gce ? gce.disposal : 0;
      const transparentFlag = gce ? gce.transparentFlag : 0;
      const transparentIndex = gce ? gce.transparentIndex : 0;
      const delayMs = gce ? gce.delayCs * 10 : 100;
      const prevSnapshot = disposal === 3 ? new Uint8ClampedArray(canvas) : null;
      const paletteEntries = Math.floor(palette.length / 3);

      for (let py = 0; py < imgH; py++) {
        const dstRow = (top + py) * width;
        const srcRow = py * imgW;
        for (let px = 0; px < imgW; px++) {
          const idx = indices[srcRow + px];
          if (transparentFlag && idx === transparentIndex) continue;
          const pOff = (idx < paletteEntries ? idx : 0) * 3;
          const outAt = (dstRow + left + px) * 4;
          canvas[outAt] = palette[pOff];
          canvas[outAt + 1] = palette[pOff + 1];
          canvas[outAt + 2] = palette[pOff + 2];
          canvas[outAt + 3] = 255;
        }
      }

      frames.push({
        rgba: new Uint8ClampedArray(canvas),
        delayMs,
        disposal
      });
      meta.push({
        left,
        top,
        frameWidth: imgW,
        frameHeight: imgH,
        disposal,
        transparentFlag,
        delayMs
      });

      if (disposal === 2) {
        for (let py = 0; py < imgH; py++) {
          const dstRow = (top + py) * width;
          for (let px = 0; px < imgW; px++) {
            const outAt = (dstRow + left + px) * 4;
            canvas[outAt] = 0;
            canvas[outAt + 1] = 0;
            canvas[outAt + 2] = 0;
            canvas[outAt + 3] = 0;
          }
        }
      } else if (disposal === 3 && prevSnapshot) {
        canvas.set(prevSnapshot);
      }
      gce = null;
      continue;
    }

    throw new Error(`无效的 GIF 块标识：0x${intro.toString(16)}`);
  }

  if (frames.length === 0) {
    throw new Error('GIF 中未包含任何有效图像帧');
  }

  return { width, height, frames, loopCount, meta, signature: sig };
}

/**
 * Pure JS GIF87a/GIF89a multi-frame decoder with stateful frame disposal composition.
 */
export function decodeGif(bytes) {
  const { width, height, frames, loopCount } = parseGifInternal(bytes);
  return { width, height, frames, loopCount };
}

// --- Quantizer (<= 256 opaque colors with optional pinned exact colors) ---

function quantizeFrameRgba(rgba, width, height, pinnedColors = []) {
  const pixelCount = width * height;
  const hist = new Map();
  for (let i = 0; i < pixelCount; i++) {
    const at = i * 4;
    const key = (rgba[at] << 16) | (rgba[at + 1] << 8) | rgba[at + 2];
    hist.set(key, (hist.get(key) || 0) + 1);
  }

  const palette = [];
  const paletteSet = new Set();
  for (const rgb of pinnedColors) {
    const k = ((rgb[0] & 255) << 16) | ((rgb[1] & 255) << 8) | (rgb[2] & 255);
    if (!paletteSet.has(k) && palette.length < 256) {
      paletteSet.add(k);
      palette.push([rgb[0] & 255, rgb[1] & 255, rgb[2] & 255]);
    }
  }

  if (hist.size <= 256 && [...hist.keys()].every(k => paletteSet.has(k)) === false && hist.size + palette.length <= 256) {
    for (const k of hist.keys()) {
      if (!paletteSet.has(k)) {
        paletteSet.add(k);
        palette.push([(k >>> 16) & 255, (k >>> 8) & 255, k & 255]);
      }
    }
  } else if (hist.size <= 256) {
    // Exact lossless fit within 256 colors
    palette.length = 0;
    paletteSet.clear();
    for (const k of hist.keys()) {
      paletteSet.add(k);
      palette.push([(k >>> 16) & 255, (k >>> 8) & 255, k & 255]);
    }
  } else {
    // Median-cut for remaining slots after pinned colors
    const remaining = Math.max(1, 256 - palette.length);
    const items = [];
    for (const [k, n] of hist.entries()) {
      if (paletteSet.has(k)) continue;
      items.push({ k, n, c: [(k >>> 16) & 255, (k >>> 8) & 255, k & 255] });
    }
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
      const axis = ranges.indexOf(maxRange);
      return { items: list, axis, weight, score: maxRange * weight };
    };
    if (items.length > 0) {
      const boxes = [makeBox(items)];
      while (boxes.length < remaining) {
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
      for (const box of boxes) {
        let sr = 0, sg = 0, sb = 0;
        for (const it of box.items) {
          sr += it.c[0] * it.n;
          sg += it.c[1] * it.n;
          sb += it.c[2] * it.n;
        }
        const rgb = [
          Math.round(sr / box.weight),
          Math.round(sg / box.weight),
          Math.round(sb / box.weight)
        ];
        const k = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
        if (!paletteSet.has(k) && palette.length < 256) {
          paletteSet.add(k);
          palette.push(rgb);
        }
      }
    }
  }

  const lookup = new Map();
  for (let i = 0; i < palette.length; i++) {
    const [r, g, b] = palette[i];
    lookup.set((r << 16) | (g << 8) | b, i);
  }

  const indices = new Uint8Array(pixelCount);
  const outRgba = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    const at = i * 4;
    const r = rgba[at];
    const g = rgba[at + 1];
    const b = rgba[at + 2];
    const key = (r << 16) | (g << 8) | b;
    let idx = lookup.get(key);
    if (idx === undefined) {
      let bestDist = Infinity;
      idx = 0;
      for (let p = 0; p < palette.length; p++) {
        const pr = palette[p][0] - r;
        const pg = palette[p][1] - g;
        const pb = palette[p][2] - b;
        const dist = pr * pr + pg * pg + pb * pb;
        if (dist < bestDist) {
          bestDist = dist;
          idx = p;
          if (dist === 0) break;
        }
      }
      lookup.set(key, idx);
    }
    indices[i] = idx;
    const col = palette[idx];
    outRgba[at] = col[0];
    outRgba[at + 1] = col[1];
    outRgba[at + 2] = col[2];
    outRgba[at + 3] = 255;
  }

  return { palette, indices, rgba: outRgba };
}

function sampleMatteRgb(frame, fallbackRgb) {
  const { width, height, rgba } = frame;
  const pts = [
    [0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1],
    [Math.floor(width / 2), 0], [0, Math.floor(height / 2)]
  ];
  const counts = new Map();
  for (const [x, y] of pts) {
    const at = (y * width + x) * 4;
    if (rgba[at + 3] < 128) continue;
    const k = (rgba[at] << 16) | (rgba[at + 1] << 8) | rgba[at + 2];
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let bestKey = null;
  let bestN = 0;
  for (const [k, n] of counts.entries()) {
    if (n > bestN) {
      bestN = n;
      bestKey = k;
    }
  }
  if (bestKey === null) return fallbackRgb;
  return [(bestKey >>> 16) & 255, (bestKey >>> 8) & 255, bestKey & 255];
}

function buildBezelMask(theme) {
  const sentinel = 0x1234;
  const fb = new Uint16Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  fb.fill(sentinel);
  // Avoid collision if any theme color happens to equal sentinel
  const t = normalizeTheme(theme);
  const used565 = new Set([
    rgb565(t.background), rgb565(t.panel), rgb565(t.shell), rgb565(t.ink), rgb565(t.accent)
  ]);
  let emptyMarker = 0;
  while (used565.has(emptyMarker)) emptyMarker++;
  fb.fill(emptyMarker);
  drawBezelOverlay565(fb, t, { fillCutoutBg: null });

  const mask = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  const overlayRgb = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT * 3);
  for (let i = 0; i < fb.length; i++) {
    if (fb[i] !== emptyMarker) {
      mask[i] = 1;
      const [r, g, b] = rgb565ToRgb(fb[i]);
      overlayRgb[i * 3] = r;
      overlayRgb[i * 3 + 1] = g;
      overlayRgb[i * 3 + 2] = b;
    }
  }
  return { mask, overlayRgb };
}

function normalizeInputFrames(decodedOrStaticRgba) {
  let source = decodedOrStaticRgba;
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
    source = decodeGif(source);
  }
  if (!source || typeof source !== 'object') {
    throw new Error('缺少待合成的图像或 GIF 帧数据');
  }
  if (Array.isArray(source.frames)) {
    if (source.frames.length === 0) throw new Error('GIF 帧列表不能为空');
    const w = source.width;
    const h = source.height;
    return source.frames.map(f => ({
      width: w,
      height: h,
      rgba: f.rgba,
      delayMs: f.delayMs ?? 100
    }));
  }
  const rgba = source.rgba || source.data;
  if (!(rgba instanceof Uint8ClampedArray || rgba instanceof Uint8Array) || !source.width || !source.height) {
    throw new Error('静态帧对象必须包含 width、height 与 RGBA 像素数据');
  }
  if (rgba.length !== source.width * source.height * 4) {
    throw new Error('RGBA 像素长度与 width × height × 4 不匹配');
  }
  return [{ width: source.width, height: source.height, rgba, delayMs: source.delayMs ?? 120 }];
}

function boxBlurRgbRegion(buf, width, height, minX, maxX, minY, maxY, radius) {
  const tmp = new Uint8Array(buf.length);
  tmp.set(buf);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      const x0 = Math.max(minX, x - radius);
      const x1 = Math.min(maxX, x + radius);
      for (let kx = x0; kx <= x1; kx++) {
        const at = (y * width + kx) * 3;
        sr += buf[at];
        sg += buf[at + 1];
        sb += buf[at + 2];
        cnt++;
      }
      const dst = (y * width + x) * 3;
      tmp[dst] = Math.round(sr / cnt);
      tmp[dst + 1] = Math.round(sg / cnt);
      tmp[dst + 2] = Math.round(sb / cnt);
    }
  }
  for (let y = minY; y <= maxY; y++) {
    const y0 = Math.max(minY, y - radius);
    const y1 = Math.min(maxY, y + radius);
    for (let x = minX; x <= maxX; x++) {
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      for (let ky = y0; ky <= y1; ky++) {
        const at = (ky * width + x) * 3;
        sr += tmp[at];
        sg += tmp[at + 1];
        sb += tmp[at + 2];
        cnt++;
      }
      const dst = (y * width + x) * 3;
      buf[dst] = Math.round(sr / cnt);
      buf[dst + 1] = Math.round(sg / cnt);
      buf[dst + 2] = Math.round(sb / cnt);
    }
  }
}

/**
 * Wrap a raw Canvas/PNG/JPG/WebP RGBA buffer into a single-frame source for composePetGifFrames().
 */
export function rgbaToStaticGifSource(rgba, w, h, delayMs = 120) {
  if (!(rgba instanceof Uint8ClampedArray || rgba instanceof Uint8Array)) {
    throw new Error('静态图像像素数据必须为 Uint8ClampedArray 或 Uint8Array');
  }
  if (!Number.isInteger(w) || w <= 0 || w > MAX_GIF_DIM || !Number.isInteger(h) || h <= 0 || h > MAX_GIF_DIM) {
    throw new Error(`静态图像尺寸超出允许范围（1..${MAX_GIF_DIM}）：${String(w)}×${String(h)}`);
  }
  if (rgba.length !== w * h * 4) {
    throw new Error(`RGBA 像素长度不匹配：期望 ${w * h * 4}，实际 ${rgba.length}`);
  }
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs <= 0) {
    throw new Error(`无效的静态帧延迟 delayMs：${String(delayMs)}`);
  }
  return {
    width: w,
    height: h,
    frames: [{ rgba: new Uint8ClampedArray(rgba), delayMs: Math.round(delayMs), disposal: 1 }],
    loopCount: 0
  };
}

/**
 * Composite decoded GIF or static RGBA frames onto opaque 320x172 TFT frames
 * with bezel/fit/offset/chromaKey/blur/flip/preset/theme/marker guarantees.
 */
export function composePetGifFrames(decodedOrStaticRgba, options = {}) {
  const {
    theme: themeInput = PRESET_THEMES.pink,
    placementPreset = null,
    fit: fitOption,
    scale = 1.0,
    offsetX = 0,
    offsetY = 0,
    bgMode = 'theme',
    customBg = '#fff0f6',
    overlayBezel: overlayBezelOption,
    speed = 1.0,
    maxFrames = 60,
    chromaKeyColor = null,
    chromaKeyTolerance = 32,
    bgBlur = false,
    flipX = false,
    enableAlpha = true
  } = options;

  if (
    placementPreset !== null &&
    placementPreset !== undefined &&
    !['pet-right', 'center', 'fullscreen'].includes(placementPreset)
  ) {
    throw new Error(`不支持的排版预设 placementPreset：${String(placementPreset)}`);
  }
  const overlayBezel = overlayBezelOption !== undefined
    ? Boolean(overlayBezelOption)
    : (placementPreset !== 'center' && placementPreset !== 'fullscreen');
  const fit = fitOption !== undefined
    ? fitOption
    : (placementPreset === 'fullscreen' ? 'cover' : 'contain');

  if (!['contain', 'cover', 'crop', 'stretch'].includes(fit)) {
    throw new Error(`不支持的缩放模式 fit：${String(fit)}`);
  }
  if (!['theme', 'custom', 'matte'].includes(bgMode)) {
    throw new Error(`不支持的背景模式 bgMode：${String(bgMode)}`);
  }
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
    throw new Error(`无效的缩放比例 scale：${String(scale)}`);
  }
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) {
    throw new Error(`无效的速度倍率 speed：${String(speed)}`);
  }
  if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > MAX_GIF_FRAMES) {
    throw new Error(`无效的最大帧数 maxFrames：${String(maxFrames)}`);
  }
  if (typeof chromaKeyTolerance !== 'number' || !Number.isFinite(chromaKeyTolerance) || chromaKeyTolerance < 0 || chromaKeyTolerance > 120) {
    throw new Error(`无效的抠像容差 chromaKeyTolerance（0..120）：${String(chromaKeyTolerance)}`);
  }
  if (typeof flipX !== 'boolean') {
    throw new Error('flipX 必须为布尔值');
  }
  if (typeof enableAlpha !== 'boolean') {
    throw new Error('enableAlpha 必须为布尔值');
  }

  let blurRadius = 0;
  if (bgBlur === true) {
    blurRadius = 4;
  } else if (typeof bgBlur === 'number') {
    if (!Number.isFinite(bgBlur) || bgBlur < 0 || bgBlur > 32) {
      throw new Error(`无效的背景模糊半径 bgBlur（0..32）：${String(bgBlur)}`);
    }
    blurRadius = Math.round(bgBlur);
  } else if (bgBlur !== false && bgBlur !== null && bgBlur !== undefined) {
    throw new Error('bgBlur 必须为布尔值或 0..32 数字');
  }

  const chromaKeyRgb = (chromaKeyColor !== null && chromaKeyColor !== undefined && chromaKeyColor !== '')
    ? hexToRgb(normalizeHex(chromaKeyColor, 'chromaKeyColor'))
    : null;
  const chromaTolSq = chromaKeyTolerance * chromaKeyTolerance;

  const theme = normalizeTheme(themeInput);
  const themeBgRgb = rgb565ToRgb(rgb565(theme.background));
  const bg565 = rgb565(theme.background);
  const rawFrames = normalizeInputFrames(decodedOrStaticRgba);

  // Down-sample frames cleanly if exceeding maxFrames
  let selectedFrames = rawFrames;
  if (rawFrames.length > maxFrames) {
    selectedFrames = [];
    const ratio = rawFrames.length / maxFrames;
    for (let i = 0; i < maxFrames; i++) {
      const idx = Math.floor(i * ratio);
      const nextIdx = Math.min(rawFrames.length, Math.floor((i + 1) * ratio));
      let sumDelay = 0;
      for (let j = idx; j < nextIdx; j++) sumDelay += rawFrames[j].delayMs || 100;
      selectedFrames.push({ ...rawFrames[idx], delayMs: sumDelay });
    }
  }

  const fillRgb = bgMode === 'custom'
    ? rgb565ToRgb(rgb565(normalizeHex(customBg, 'customBg')))
    : bgMode === 'matte'
      ? sampleMatteRgb(selectedFrames[0], themeBgRgb)
      : themeBgRgb;

  const bezel = overlayBezel ? buildBezelMask(theme) : null;
  const viewport = (placementPreset === 'center' || placementPreset === 'fullscreen' || !overlayBezel)
    ? { x: 0, y: 0, w: SCREEN_WIDTH, h: SCREEN_HEIGHT }
    : { x: 180, y: 46, w: 124, h: 110 };

  // Marker color distinct from theme.background in RGB565
  let markerRgb = rgb565ToRgb(rgb565(theme.shell));
  if (rgb565FromRgb(markerRgb[0], markerRgb[1], markerRgb[2]) === bg565) {
    markerRgb = rgb565ToRgb(rgb565(theme.accent));
  }
  if (rgb565FromRgb(markerRgb[0], markerRgb[1], markerRgb[2]) === bg565) {
    markerRgb = rgb565ToRgb(rgb565(theme.ink));
  }
  if (rgb565FromRgb(markerRgb[0], markerRgb[1], markerRgb[2]) === bg565) {
    markerRgb = rgb565ToRgb(bg565 ^ 0x0821);
  }

  const pinnedThemeColors = [
    themeBgRgb,
    rgb565ToRgb(rgb565(theme.panel)),
    rgb565ToRgb(rgb565(theme.shell)),
    rgb565ToRgb(rgb565(theme.ink)),
    rgb565ToRgb(rgb565(theme.accent)),
    markerRgb
  ];

  const outFrames = [];
  const totalPixels = SCREEN_WIDTH * SCREEN_HEIGHT;

  const sampleSourcePixel = (src, sx, sy) => {
    const srcX = flipX ? src.width - 1 - sx : sx;
    const sAt = (sy * src.width + srcX) * 4;
    const sr = src.rgba[sAt];
    const sg = src.rgba[sAt + 1];
    const sb = src.rgba[sAt + 2];
    let a = enableAlpha ? src.rgba[sAt + 3] : 255;
    if (chromaKeyRgb && a > 0) {
      const dr = sr - chromaKeyRgb[0];
      const dg = sg - chromaKeyRgb[1];
      const db = sb - chromaKeyRgb[2];
      if (dr * dr + dg * dg + db * db <= chromaTolSq) {
        a = 0;
      }
    }
    return [sr, sg, sb, a];
  };

  for (const src of selectedFrames) {
    const canvas = new Uint8ClampedArray(totalPixels * 4);
    for (let i = 0; i < totalPixels; i++) {
      const y = Math.floor(i / SCREEN_WIDTH);
      const c = overlayBezel && y < 37 ? themeBgRgb : fillRgb;
      const at = i * 4;
      canvas[at] = c[0];
      canvas[at + 1] = c[1];
      canvas[at + 2] = c[2];
      canvas[at + 3] = 255;
    }

    const minX = Math.max(0, Math.floor(viewport.x));
    const maxX = Math.min(SCREEN_WIDTH - 1, Math.ceil(viewport.x + viewport.w) - 1);
    const minY = Math.max(0, Math.floor(viewport.y));
    const maxY = Math.min(SCREEN_HEIGHT - 1, Math.ceil(viewport.y + viewport.h) - 1);

    if (blurRadius > 0) {
      const bgMinY = overlayBezel ? Math.max(37, minY) : minY;
      const bgH = Math.max(1, maxY - bgMinY + 1);
      const bgScale = Math.max((maxX - minX + 1) / src.width, bgH / src.height);
      const bgOriginX = minX + ((maxX - minX + 1) - src.width * bgScale) / 2;
      const bgOriginY = bgMinY + (bgH - src.height * bgScale) / 2;
      const blurBuf = new Uint8Array(totalPixels * 3);
      for (let i = 0; i < totalPixels; i++) {
        const cAt = i * 4;
        const bAt = i * 3;
        blurBuf[bAt] = canvas[cAt];
        blurBuf[bAt + 1] = canvas[cAt + 1];
        blurBuf[bAt + 2] = canvas[cAt + 2];
      }
      for (let y = bgMinY; y <= maxY; y++) {
        const sy = Math.max(0, Math.min(src.height - 1, Math.floor((y + 0.5 - bgOriginY) / bgScale)));
        for (let x = minX; x <= maxX; x++) {
          const sx = Math.max(0, Math.min(src.width - 1, Math.floor((x + 0.5 - bgOriginX) / bgScale)));
          const [sr, sg, sb, a] = sampleSourcePixel(src, sx, sy);
          if (a === 0) continue;
          const bAt = (y * SCREEN_WIDTH + x) * 3;
          blurBuf[bAt] = Math.round((sr * a + blurBuf[bAt] * (255 - a)) / 255);
          blurBuf[bAt + 1] = Math.round((sg * a + blurBuf[bAt + 1] * (255 - a)) / 255);
          blurBuf[bAt + 2] = Math.round((sb * a + blurBuf[bAt + 2] * (255 - a)) / 255);
        }
      }
      boxBlurRgbRegion(blurBuf, SCREEN_WIDTH, SCREEN_HEIGHT, minX, maxX, bgMinY, maxY, blurRadius);
      boxBlurRgbRegion(blurBuf, SCREEN_WIDTH, SCREEN_HEIGHT, minX, maxX, bgMinY, maxY, Math.max(1, Math.floor(blurRadius / 2)));
      for (let y = bgMinY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const i = y * SCREEN_WIDTH + x;
          canvas[i * 4] = blurBuf[i * 3];
          canvas[i * 4 + 1] = blurBuf[i * 3 + 1];
          canvas[i * 4 + 2] = blurBuf[i * 3 + 2];
          canvas[i * 4 + 3] = 255;
        }
      }
    }

    let scaleX;
    let scaleY;
    if (fit === 'stretch') {
      scaleX = (viewport.w / src.width) * scale;
      scaleY = (viewport.h / src.height) * scale;
    } else if (fit === 'contain') {
      const base = Math.min(viewport.w / src.width, viewport.h / src.height) * scale;
      scaleX = base;
      scaleY = base;
    } else if (fit === 'cover') {
      const base = Math.max(viewport.w / src.width, viewport.h / src.height) * scale;
      scaleX = base;
      scaleY = base;
    } else {
      scaleX = scale;
      scaleY = scale;
    }

    const drawW = src.width * scaleX;
    const drawH = src.height * scaleY;
    const originX = viewport.x + (viewport.w - drawW) / 2 + offsetX;
    const originY = viewport.y + (viewport.h - drawH) / 2 + offsetY;

    for (let y = minY; y <= maxY; y++) {
      const sy = Math.floor((y + 0.5 - originY) / scaleY);
      if (sy < 0 || sy >= src.height) continue;
      for (let x = minX; x <= maxX; x++) {
        const sx = Math.floor((x + 0.5 - originX) / scaleX);
        if (sx < 0 || sx >= src.width) continue;
        const [sr, sg, sb, a] = sampleSourcePixel(src, sx, sy);
        if (a === 0) continue;
        const dAt = (y * SCREEN_WIDTH + x) * 4;
        if (a === 255) {
          canvas[dAt] = sr;
          canvas[dAt + 1] = sg;
          canvas[dAt + 2] = sb;
          canvas[dAt + 3] = 255;
        } else {
          const inv = 255 - a;
          canvas[dAt] = Math.round((sr * a + canvas[dAt] * inv) / 255);
          canvas[dAt + 1] = Math.round((sg * a + canvas[dAt + 1] * inv) / 255);
          canvas[dAt + 2] = Math.round((sb * a + canvas[dAt + 2] * inv) / 255);
          canvas[dAt + 3] = 255;
        }
      }
    }

    if (bezel) {
      for (let i = 0; i < totalPixels; i++) {
        if (bezel.mask[i]) {
          const dAt = i * 4;
          const sAt = i * 3;
          canvas[dAt] = bezel.overlayRgb[sAt];
          canvas[dAt + 1] = bezel.overlayRgb[sAt + 1];
          canvas[dAt + 2] = bezel.overlayRgb[sAt + 2];
          canvas[dAt + 3] = 255;
        }
      }
    }

    const markerAt = (39 * SCREEN_WIDTH + 22) * 4;
    if (rgb565FromRgb(canvas[markerAt], canvas[markerAt + 1], canvas[markerAt + 2]) === bg565) {
      canvas[markerAt] = markerRgb[0];
      canvas[markerAt + 1] = markerRgb[1];
      canvas[markerAt + 2] = markerRgb[2];
      canvas[markerAt + 3] = 255;
    }

    const quantized = quantizeFrameRgba(canvas, SCREEN_WIDTH, SCREEN_HEIGHT, pinnedThemeColors);
    // Double-check marker pixel after quantization as well
    if (
      rgb565FromRgb(
        quantized.rgba[markerAt],
        quantized.rgba[markerAt + 1],
        quantized.rgba[markerAt + 2]
      ) === bg565
    ) {
      quantized.rgba[markerAt] = markerRgb[0];
      quantized.rgba[markerAt + 1] = markerRgb[1];
      quantized.rgba[markerAt + 2] = markerRgb[2];
    }

    outFrames.push({
      rgba: quantized.rgba,
      delayMs: Math.max(20, Math.round((src.delayMs || 100) / speed)),
      disposal: 1
    });
  }

  return outFrames;
}

// --- GIF89a LZW Encoder ---

function compressGifLzw8(indices) {
  const TABLE_SIZE = 16384;
  const TABLE_MASK = TABLE_SIZE - 1;
  const keys = new Int32Array(TABLE_SIZE);
  const vals = new Int16Array(TABLE_SIZE);
  keys.fill(-1);

  const outBytes = [];
  let bitBuf = 0;
  let bitCount = 0;
  const writeBits = (code, bits) => {
    bitBuf |= code << bitCount;
    bitCount += bits;
    while (bitCount >= 8) {
      outBytes.push(bitBuf & 255);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };

  let codeSize = 9;
  let nextCode = 258;
  writeBits(256, codeSize); // Clear code

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i];
    const k = (prefix << 8) | c;
    let h = ((prefix << 5) ^ c ^ (prefix >>> 3)) & TABLE_MASK;
    while (keys[h] !== -1 && keys[h] !== k) {
      h = (h + 1) & TABLE_MASK;
    }
    if (keys[h] === k) {
      prefix = vals[h];
    } else {
      writeBits(prefix, codeSize);
      if (nextCode < 4096) {
        keys[h] = k;
        vals[h] = nextCode;
        if (nextCode === (1 << codeSize) && codeSize < 12) {
          codeSize++;
        }
        nextCode++;
      } else {
        writeBits(256, codeSize);
        keys.fill(-1);
        nextCode = 258;
        codeSize = 9;
      }
      prefix = c;
    }
  }

  writeBits(prefix, codeSize);
  writeBits(257, codeSize); // EOI code
  if (bitCount > 0) outBytes.push(bitBuf & 255);
  return Uint8Array.from(outBytes);
}

function writeColorTable256(out, palette) {
  const offset = out.length;
  for (let i = 0; i < 256; i++) {
    if (i < palette.length) {
      out.push(palette[i][0] & 255, palette[i][1] & 255, palette[i][2] & 255);
    } else {
      out.push(0, 0, 0);
    }
  }
  return offset;
}

/**
 * Encode composed 320x172 frames into a hardware-safe opaque GIF89a (disposal=1, full frames).
 */
export function encodeGif320x172(composedFrames, { loop = true } = {}) {
  if (!Array.isArray(composedFrames) || composedFrames.length === 0) {
    throw new Error('待编码 GIF 帧列表不能为空');
  }
  if (composedFrames.length > MAX_GIF_FRAMES) {
    throw new Error(`帧数超过限制（最多 ${MAX_GIF_FRAMES} 帧）`);
  }

  const expectedRgbaLen = SCREEN_WIDTH * SCREEN_HEIGHT * 4;
  const quantizedFrames = composedFrames.map((f, idx) => {
    if (!f || !(f.rgba instanceof Uint8ClampedArray || f.rgba instanceof Uint8Array) || f.rgba.length !== expectedRgbaLen) {
      throw new Error(`第 ${idx} 帧缺少有效的 320×172 RGBA 数据`);
    }
    return {
      ...quantizeFrameRgba(f.rgba, SCREEN_WIDTH, SCREEN_HEIGHT),
      delayMs: f.delayMs ?? 100
    };
  });

  const gct = quantizedFrames[0].palette;
  const gctMap = new Map();
  for (let i = 0; i < gct.length; i++) {
    gctMap.set((gct[i][0] << 16) | (gct[i][1] << 8) | gct[i][2], i);
  }

  const out = [];
  // Header: GIF89a
  out.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
  // Logical Screen Descriptor: 320x172, GCT=1, 8-bit res, size=7 (256 colors)
  out.push(
    SCREEN_WIDTH & 255, (SCREEN_WIDTH >>> 8) & 255,
    SCREEN_HEIGHT & 255, (SCREEN_HEIGHT >>> 8) & 255,
    0xf7, 0x00, 0x00
  );
  writeColorTable256(out, gct);

  // NETSCAPE2.0 loop extension
  if (loop !== false) {
    const loopCount = typeof loop === 'number' && Number.isInteger(loop) && loop >= 0 ? loop : 0;
    out.push(
      0x21, 0xff, 0x0b,
      0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
      0x03, 0x01, loopCount & 255, (loopCount >>> 8) & 255, 0x00
    );
  }

  for (let i = 0; i < quantizedFrames.length; i++) {
    const qf = quantizedFrames[i];
    const delayCs = Math.max(2, Math.round(Math.max(20, qf.delayMs) / 10));

    // Graphic Control Extension: disposal = 1 (0x04), transparentFlag = 0
    out.push(
      0x21, 0xf9, 0x04, 0x04,
      delayCs & 255, (delayCs >>> 8) & 255,
      0x00, 0x00
    );

    // Check if frame palette is a subset of GCT (save 768 bytes per frame when matched)
    let useGct = true;
    let remapped = qf.indices;
    if (i > 0) {
      const remap = new Uint8Array(qf.palette.length);
      for (let p = 0; p < qf.palette.length; p++) {
        const k = (qf.palette[p][0] << 16) | (qf.palette[p][1] << 8) | qf.palette[p][2];
        const gIdx = gctMap.get(k);
        if (gIdx === undefined) {
          useGct = false;
          break;
        }
        remap[p] = gIdx;
      }
      if (useGct) {
        remapped = new Uint8Array(qf.indices.length);
        for (let px = 0; px < qf.indices.length; px++) {
          remapped[px] = remap[qf.indices[px]];
        }
      }
    }

    // Image Descriptor: 0, 0, 320, 172
    out.push(
      0x2c,
      0x00, 0x00, 0x00, 0x00,
      SCREEN_WIDTH & 255, (SCREEN_WIDTH >>> 8) & 255,
      SCREEN_HEIGHT & 255, (SCREEN_HEIGHT >>> 8) & 255,
      useGct ? 0x00 : 0x87
    );
    if (!useGct) {
      writeColorTable256(out, qf.palette);
    }

    // LZW minimum code size = 8 + compressed sub-blocks
    out.push(0x08);
    const compressed = compressGifLzw8(remapped);
    for (let at = 0; at < compressed.length; at += 255) {
      const n = Math.min(255, compressed.length - at);
      out.push(n);
      for (let k = 0; k < n; k++) out.push(compressed[at + k]);
    }
    out.push(0x00);
  }

  out.push(0x3b); // GIF trailer
  const result = Uint8Array.from(out);
  if (result.length > MAX_DEVICE_GIF_BYTES) {
    throw new Error(
      `生成的 GIF 体积为 ${(result.length / 1024 / 1024).toFixed(2)} MiB，超出 S1 4MiB 限制；请减少帧数或简化颜色`
    );
  }
  return result;
}

/**
 * Audit a 320x172 GIF against firmware cache/lyrics contracts (mirrors tools/assets.py validate_cache_gif).
 */
export function auditDeviceGif(bytes, themeInput = null) {
  validateGif(bytes);
  const parsed = parseGifInternal(bytes);
  if (parsed.width !== SCREEN_WIDTH || parsed.height !== SCREEN_HEIGHT) {
    throw new Error(`GIF 分辨率必须为 320×172，实际为 ${parsed.width}×${parsed.height}`);
  }
  const theme = themeInput ? normalizeTheme(themeInput) : null;
  const bg565 = theme ? rgb565(theme.background) : null;

  for (let i = 0; i < parsed.meta.length; i++) {
    const m = parsed.meta[i];
    if (m.left !== 0 || m.top !== 0 || m.frameWidth !== SCREEN_WIDTH || m.frameHeight !== SCREEN_HEIGHT) {
      throw new Error(`第 ${i} 帧不是完整 320×172 帧（${m.left},${m.top},${m.frameWidth},${m.frameHeight}），不支持增量矩形`);
    }
    if (m.disposal !== 1) {
      throw new Error(`第 ${i} 帧 disposal=${m.disposal}，设备要求每帧必须为 disposal=1（保留上一帧）`);
    }
    if (m.transparentFlag !== 0) {
      throw new Error(`第 ${i} 帧启用了透明色标记，设备缓存 GIF 要求所有像素 100% 不透明`);
    }
    if (bg565 !== null) {
      const rgba = parsed.frames[i].rgba;
      const at = (39 * SCREEN_WIDTH + 22) * 4;
      const marker565 = rgb565FromRgb(rgba[at], rgba[at + 1], rgba[at + 2]);
      if (marker565 === bg565) {
        throw new Error(`第 ${i} 帧坐标 (22,39) 的 RGB565 颜色与主题 background 相同，歌词切页标记将失效`);
      }
    }
  }

  return {
    ok: true,
    width: parsed.width,
    height: parsed.height,
    frameCount: parsed.frames.length,
    bytes: bytes.length,
    loopCount: parsed.loopCount
  };
}
