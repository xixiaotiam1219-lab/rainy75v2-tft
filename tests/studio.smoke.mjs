// SPDX-License-Identifier: MIT
// Playwright smoke test for the Chinese GUI Workbench (offline & mock WebHID only; never opens real hardware).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  MAIN_CAP,
  IPS_CAP,
  sha256
} from '../web/protocol.mjs';
import {
  R75T_MAGIC,
  R75T_VERSION,
  R75T_BYTES,
  PRESET_THEMES,
  IPS_APP_BASE,
  IPS_FLASH_ORIGIN,
  crc32,
  rgb565,
  normalizeTheme
} from '../web/theme-engine.mjs';
import {
  rgbaToStaticGifSource,
  composePetGifFrames,
  encodeGif320x172
} from '../web/gif-studio.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeOutDir = path.join(root, 'build', 'studio-smoke');

async function buildSyntheticMain(dir) {
  const bytes = Uint8Array.from({ length: 294912 }, (_, i) => (i * 19 + 5) & 255);
  const manifest = {
    format: 'rainy75v2-tft/build-v1',
    target: 'main',
    applicationBase: 0x2000,
    iapPid: 0x3079,
    bytes: bytes.length,
    sha256: await sha256(bytes)
  };
  const binPath = path.join(dir, 'main-064.bin');
  const manifestPath = path.join(dir, 'main-064.manifest.json');
  await writeFile(binPath, bytes);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { binPath, manifestPath, manifest };
}

async function buildSyntheticIpsBase(dir) {
  const length = 507904;
  const slotOffset = 0x2000;
  const bytes = Uint8Array.from({ length }, (_, i) => (i * 23 + 3) & 255);
  const norm = normalizeTheme('pink');
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
  const dv = new DataView(bytes.buffer);
  dv.setUint32(slotOffset, R75T_MAGIC, true);
  dv.setUint16(slotOffset + 4, R75T_VERSION, true);
  dv.setUint16(slotOffset + 6, R75T_BYTES, true);
  for (let i = 0; i < 8; i++) dv.setUint16(slotOffset + 8 + i * 2, fields565[i], true);
  const slotCrc = crc32(bytes.subarray(slotOffset, slotOffset + 24));
  dv.setUint32(slotOffset + 24, slotCrc, true);

  const manifest = {
    format: 'rainy75v2-tft/build-v1',
    target: 'ips',
    applicationBase: IPS_APP_BASE,
    iapPid: 0x3078,
    bytes: length,
    sha256: await sha256(bytes),
    theme: 'pink',
    themeColors: norm,
    themeSlot: {
      format: 'r75t/v1',
      magic: 'R75T',
      version: 1,
      fileOffset: slotOffset,
      bytes: 28,
      codeStart: IPS_FLASH_ORIGIN,
      imageEnd: IPS_FLASH_ORIGIN + length,
      applicationBase: IPS_APP_BASE,
      fields: ['bg', 'panel', 'shell', 'ink', 'accent', 'muted', 'lyricsBorder', 'lyricsPanel'],
      crc32: slotCrc
    }
  };
  const binPath = path.join(dir, 'ips-base.bin');
  const manifestPath = path.join(dir, 'ips-base.manifest.json');
  await writeFile(binPath, bytes);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { binPath, manifestPath, manifest, slotOffset };
}

async function buildSyntheticGreenGif(dir) {
  const w = 48;
  const h = 48;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = x >= 10 && x < 38 && y >= 10 && y < 38;
      if (inside) {
        rgba[i] = x < 24 ? 235 : 52;
        rgba[i + 1] = 84;
        rgba[i + 2] = y < 24 ? 140 : 228;
        rgba[i + 3] = 255;
      } else {
        // Pure green-screen backdrop to test chroma-key removal
        rgba[i] = 0;
        rgba[i + 1] = 255;
        rgba[i + 2] = 0;
        rgba[i + 3] = 255;
      }
    }
  }
  const src = rgbaToStaticGifSource(rgba, w, h, 90);
  const composed = composePetGifFrames(src, {
    placementPreset: 'center',
    fit: 'contain',
    bgMode: 'custom',
    customBg: '#00ff00',
    overlayBezel: false
  });
  const gifBytes = encodeGif320x172(composed, { loop: true });
  const gifPath = path.join(dir, 'green-pet.gif');
  await writeFile(gifPath, gifBytes);
  return gifPath;
}

function startGuiServer({ dataDir, startupDir }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        'desktop/gui-server.cjs',
        '--html',
        'web/studio.html',
        '--port',
        '0',
        '--data-dir',
        dataDir,
        '--startup-dir',
        startupDir,
        '--registry-file', path.join(dataDir, 'test-background-locations.json')
      ],
      {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`gui-server startup timeout; stdout=${stdoutBuf} stderr=${stderrBuf}`));
      }
    }, 10000);

    child.stdout.on('data', chunk => {
      stdoutBuf += chunk.toString('utf8');
      const m = stdoutBuf.match(/URL=(http:\/\/127\.0\.0\.1:\d+\/)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, url: m[1] });
      }
    });
    child.stderr.on('data', chunk => {
      stderrBuf += chunk.toString('utf8');
    });
    child.on('exit', code => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`gui-server exited early (${code}); stderr=${stderrBuf}`));
      }
    });
  });
}

async function main() {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'rainy75-studio-smoke-'));
  const tmpDataDir = path.join(tmpRoot, 'data');
  const tmpStartupDir = path.join(tmpRoot, 'startup');
  const tmpFilesDir = path.join(tmpRoot, 'files');
  await mkdir(tmpDataDir, { recursive: true });
  await mkdir(tmpStartupDir, { recursive: true });
  await mkdir(tmpFilesDir, { recursive: true });
  await mkdir(smokeOutDir, { recursive: true });

  const mainBundle = await buildSyntheticMain(tmpFilesDir);
  const ipsBundle = await buildSyntheticIpsBase(tmpFilesDir);
  const greenGifPath = await buildSyntheticGreenGif(tmpFilesDir);

  let serverChild = null;
  let browser = null;

  try {
    const srv = await startGuiServer({ dataDir: tmpDataDir, startupDir: tmpStartupDir });
    serverChild = srv.child;

    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {})
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 960 },
      acceptDownloads: true
    });
    const page = await context.newPage();

    const pageErrors = [];
    const consoleErrors = [];
    const failedResponses = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('response', res => {
      if (res.status() >= 400) failedResponses.push(`${res.status()} ${res.url()}`);
    });

    // Inject isolated synthetic WebHID adapter before scripts execute
    await page.addInitScript(({ mainCapDefault, ipsCapDefault }) => {
      const sum16 = arr => {
        let s = 0;
        for (let i = 0; i < arr.length; i++) s = (s + arr[i]) & 0xffff;
        return s;
      };

      const cfg = {
        mode: 'app',
        mainCap: mainCapDefault,
        ipsCap: ipsCapDefault,
        flashKiB: 1024,
        series: 13,
        uiActive: false,
        lyricsSupported: false,
        fontReady: false,
        fontCrc: 0,
        layoutCount: 2,
        coverSupported: false,
        volumeSupported: false
      };

      const stats = {
        calibrateWrites: 0,
        enteredIap: null,
        iapEraseCount: 0,
        iapWriteBytes: 0,
        iapVerifyCount: 0,
        iapEndCount: 0,
        gifBytesUploaded: 0,
        lastR75tHeader: null
      };

      let seconds = null;
      let at = 0;
      let ack = [13, 0, 0, 0];
      let gifChunkBytes = 0;

      const makeCol = (usagePage, usage, len) => ({
        usagePage,
        usage,
        inputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: len }] }],
        outputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: len }] }]
      });

      const appListeners = new Set();
      const appDevice = {
        vendorId: 0x36b0,
        productId: 0x3075,
        opened: false,
        collections: [makeCol(0xff60, 0x61, 256)],
        async open() { this.opened = true; },
        async close() { this.opened = false; },
        addEventListener(_, fn) { appListeners.add(fn); },
        removeEventListener(_, fn) { appListeners.delete(fn); },
        async sendReport(id, data) {
          if (id !== 0) throw new Error('Bad APP reportId');
          const p = data instanceof Uint8Array
            ? data
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          if (p.length !== 256) throw new Error(`Expected 256B APP report, got ${p.length}`);

          if (p[0] === 0xbe && p[1] === 0xfc) {
            stats.enteredIap = p[2] === 4 ? 'main' : p[2] === 5 ? 'ips' : 'unknown';
            cfg.mode = p[2] === 4 ? 'iap_main' : 'iap_ips';
            return;
          }

          const s = seconds === null
            ? 0xffffffff
            : (seconds + Math.floor((Date.now() - at) / 1000)) % 86400;

          if (p[0] === 0xbe && p[1] === 0x1a) {
            const sub = p[3];
            if (sub === 13) {
              const op = p[4];
              const f = p[5];
              const reqId = f | (p[6] << 8);
              let v = 0;
              let status = 1;
              if (op === 15) {
                status = 0xd0 + f;
                v = f === 9 ? cfg.mainCap
                  : f === 8 ? Number(seconds !== null)
                  : f === 7 ? s >>> 16
                  : f === 6 ? s & 0xffff
                  : 0;
              } else if (op === 11) {
                const bcd = s === 0xffffffff
                  ? 0xffffffff
                  : parseInt(
                      [Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60]
                        .map(n => String(n).padStart(2, '0'))
                        .join(''),
                      16
                    );
                status = (f === 0 && cfg.ipsCap === null) ? 0 : 0xb0 + f;
                if (f === 0) v = cfg.ipsCap ?? 0;
                else if (f === 4) v = seconds === null ? 0x401 : 0x402;
                else if (f === 5) v = bcd & 0xffff;
                else if (f === 6) v = bcd >>> 16;
                else if (f === 7) v = cfg.uiActive ? 1 : 0;
                else if (f === 14) v = cfg.flashKiB ?? 0;
                else if (f === 15) v = cfg.series ?? 0;
                else if (f === 2) v = 84;
                else if (f === 3) v = 1;
                else v = 40;
              } else if (op === 18) {
                seconds = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(8, true);
                at = Date.now();
                stats.calibrateWrites++;
                status = 1;
                v = reqId;
              } else if (op === 24) {
                status = cfg.lyricsSupported ? 0xa6 : 0xff;
                v = cfg.lyricsSupported ? 0x4c59 : 0;
              } else if (op === 22) {
                status = 0xc0 + (f & 15);
                if (f === 0) v = 1;
                else if (f === 1) v = cfg.fontReady ? 1 : 0;
                else if (f === 5) v = cfg.fontCrc & 0xffff;
                else if (f === 6) v = (cfg.fontCrc >>> 16) & 0xffff;
                else if (f === 22) v = cfg.layoutCount;
                else if (f === 27) v = cfg.coverSupported ? 1 : 0;
                else if (f === 28) v = cfg.volumeSupported ? 1 : 0;
                else v = 0;
              } else if (op === 2 && cfg.failPauseOnce) {
                cfg.failPauseOnce = false;
                status = 0xc1;
                v = 0;
              } else {
                status = 1;
                v = reqId;
              }
              ack = [13, status, v & 255, (v >>> 8) & 255];
            } else if (sub >= 1 && sub <= 4) {
              if (sub === 1) {
                gifChunkBytes = 0;
                ack = [1, 0, 0, 0];
              } else if (sub === 2) {
                const payloadLen = Math.max(0, p[2] - 11);
                gifChunkBytes += payloadLen;
                ack = [2, 0, p[4], p[5]];
              } else if (sub === 3) {
                stats.gifBytesUploaded = gifChunkBytes;
                ack = [3, 0, 0, 0];
              } else {
                ack = [4, 0, 0, 0];
              }
            }
            return;
          }

          if (p[0] === 0xbe && p[1] === 0xe4) {
            const r = new Uint8Array(256);
            r.set([0xbe, 0xe4, 14, 0x84, 4, 0, 0, ...ack, 0, 0, 0xed], 0);
            const sum = sum16(r.subarray(0, 11));
            r[11] = sum & 255;
            r[12] = sum >>> 8;
            const dv = new DataView(r.buffer);
            queueMicrotask(() => {
              for (const fn of [...appListeners]) fn({ reportId: 0, data: dv });
            });
            return;
          }
          throw new Error(`Unexpected APP packet byte 0x${p[1].toString(16)}`);
        }
      };

      const makeIapMock = (pid, maxSize) => {
        const listeners = new Set();
        const mem = new Uint8Array(maxSize);
        const ok2 = new Uint8Array([0, 0]);
        const ok64 = new Uint8Array(64);
        let writePos = 0;
        const appBase = pid === 0x3079 ? 0x2000 : 0x4000;

        const emit = buf => {
          const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          queueMicrotask(() => {
            for (const fn of [...listeners]) fn({ reportId: 0, data: view });
          });
        };

        return {
          vendorId: 0x36b0,
          productId: pid,
          opened: false,
          collections: [makeCol(0xff60, 0x61, 64)],
          async open() { this.opened = true; },
          async close() { this.opened = false; },
          addEventListener(_, fn) { listeners.add(fn); },
          removeEventListener(_, fn) { listeners.delete(fn); },
          async sendReport(_, data) {
            const p = data instanceof Uint8Array
              ? data
              : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            const cmd = p[0];
            if (cmd === 0x81) {
              stats.iapEraseCount++;
              writePos = 0;
              emit(ok2);
            } else if (cmd === 0x80) {
              const len = p[1];
              if (len > 0) {
                mem.set(p.subarray(2, 2 + len), writePos);
                writePos += len;
                stats.iapWriteBytes = writePos;
              }
              emit(ok64);
            } else if (cmd === 0x82) {
              stats.iapVerifyCount++;
              const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
              const off = dv.getUint32(2, true) - appBase;
              for (let i = 0; i < 56; i++) {
                if (mem[off + i] !== p[6 + i]) {
                  throw new Error(`IAP verify mismatch at offset ${off + i}`);
                }
              }
              emit(ok64);
            } else if (cmd === 0x83) {
              stats.iapEndCount++;
              if (pid === 0x3078) {
                stats.lastR75tHeader = Array.from(mem.subarray(0x2000, 0x2008));
                cfg.ipsCap = 0x5536;
              } else {
                cfg.mainCap = 0x4350;
              }
              cfg.mode = 'app';
            }
          }
        };
      };

      const iapMainDevice = makeIapMock(0x3079, 294912);
      const iapIpsDevice = makeIapMock(0x3078, 560000);

      const getActiveList = () => {
        if (cfg.mode === 'app') return [appDevice];
        if (cfg.mode === 'iap_main') return [iapMainDevice];
        if (cfg.mode === 'iap_ips') return [iapIpsDevice];
        return [];
      };

      Object.defineProperty(navigator, 'hid', {
        configurable: true,
        value: {
          async getDevices() {
            return getActiveList();
          },
          async requestDevice({ filters = [] } = {}) {
            const active = getActiveList();
            if (!filters.length) return active;
            const pid = filters[0]?.productId;
            return active.filter(d => d.productId === pid);
          }
        }
      });

      window.__mockHidConfig = cfg;
      window.__mockHidStats = stats;
    }, { mainCapDefault: MAIN_CAP, ipsCapDefault: IPS_CAP });

    await page.goto(srv.url, { waitUntil: 'networkidle' });

    // ==================== 1. OVERVIEW TAB ====================
    await page.waitForFunction(() => document.querySelector('#overview-webhid-chip')?.textContent?.includes('WebHID'));
    assert.match(await page.locator('#overview-bg-text').textContent(), /未运行/);
    await page.locator('#btn-appearance').click();
    assert.equal(await page.locator('html').getAttribute('data-appearance'), 'dark');
    await page.screenshot({ path: path.join(smokeOutDir, '00-dark-overview.png') });
    await page.locator('#btn-appearance').click();
    await page.screenshot({ path: path.join(smokeOutDir, '00-light-overview.png') });
    await page.locator('#btn-hero-direct-deploy').click();
    await page.locator('#btn-probe-device').click();
    await page.waitForFunction(() => document.querySelector('#probe-pid').textContent.includes('0x3075'));
    assert.match(await page.locator('[data-step-id="upload_gif"]').textContent(), /保留当前 S1/);
    assert.equal(await page.locator('#scenario-update').getAttribute('class').then(s => s.includes('active')), true);
    await page.locator('#btn-disconnect-device').click();
    await page.locator('#tab-btn-overview').click();

    // Verify Hero Ctrl+F8 interactive tour & repo demo diagrams
    assert.match(await page.locator('#hero-slide-label').textContent(), /预览 1 \/ 7/);
    await page.locator('#btn-hero-ctrlf8').click();
    assert.match(await page.locator('#hero-slide-label').textContent(), /预览 2 \/ 7.*原版双行/);
    await page.locator('[data-hero-slide="volume"]').click();
    assert.match(await page.locator('#hero-slide-label').textContent(), /预览 7 \/ 7.*音量弹窗/);
    assert.equal(await page.locator('#btn-hero-autoplay').textContent(), '自动轮播');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(smokeOutDir, '00-hero-overview.png') });
    await page.locator('[data-hero-slide="keys"]').click();
    await page.locator('#screen-examples > summary').click();

    // Verify card interactive toy demos (pet variants, keycap tap, B layouts, C volume demo)
    await page.locator('[data-card-a-demo="mint"]').click();
    assert.equal(await page.locator('#card-box-A img[data-robot-demo="mint"]').evaluate(el => el.classList.contains('active')), true);
    await page.locator('[data-card-b-layout="layout2"]').click();
    assert.equal(await page.locator('#card-box-B img[data-b-slide="layout2"]').evaluate(el => el.classList.contains('active')), true);
    await page.locator('#btn-card-c-vol-demo').click();
    assert.equal(await page.locator('#card-c-img-vol').evaluate(el => el.classList.contains('active')), true);
    await page.locator('#btn-card-c-vol-demo').click();

    await page.locator('#track-card-B').click();
    assert.match(await page.locator('#header-track-pill').textContent(), /经典播放器/);
    await page.locator('#track-card-C').click();
    assert.match(await page.locator('#header-track-pill').textContent(), /沉浸播放器/);
    await page.locator('#track-card-A').click();
    assert.match(await page.locator('#header-track-pill').textContent(), /桌宠模式/);
    await page.screenshot({ path: path.join(smokeOutDir, '01-overview.png') });

    // ==================== 2. THEME & PREVIEW TAB ====================
    await page.locator('#tab-btn-theme').click();

    const canvasSignature = async selector => page.evaluate(sel => {
      const c = document.querySelector(sel);
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 13) {
        h ^= d[i];
        h = Math.imul(h, 16777619) >>> 0;
      }
      return `${c.width}x${c.height}:${h}`;
    }, selector);

    await page.locator('#btn-theme-mint').click();
    const mintBg = await page.locator('.chan-hex[data-channel="background"]').inputValue();
    assert.equal(mintBg.toLowerCase(), PRESET_THEMES.mint.background.toLowerCase());

    await page.locator('#btn-theme-mono').click();
    const sigKeys = await canvasSignature('#theme-preview-canvas');

    // Click HSV Color Wheel + Harmonic generator
    const beforeSeed = await page.locator('#theme-seed-hex').inputValue();
    await page.locator('#theme-color-wheel').click({ position: { x: 165, y: 72 } });
    const afterWheelSeed = await page.locator('#theme-seed-hex').inputValue();
    assert.notEqual(afterWheelSeed, beforeSeed, 'Clicking HSV wheel should update seed hex');

    await page.selectOption('#theme-harmonic-tone', 'vivid');
    await page.locator('#btn-generate-harmonic').click();
    assert.equal(await page.locator('#theme-channels-grid .chan-hex').count(), 8);

    // Test virtual keycap toy syncs to #preview-key-select
    await page.locator('.preview-view-btn[data-view="keys"]').click();
    await page.locator('.keycap-btn[data-keycap="4"]').click();
    assert.equal(await page.locator('#preview-key-select').inputValue(), '4');
    await page.locator('.keycap-btn[data-keycap="227"]').click();

    // Verify preview layouts produce distinct screens
    const viewSigs = new Set([sigKeys]);
    for (const view of ['layout0', 'layout1', 'layout2', 'layout3', 'layout4']) {
      await page.locator(`.preview-view-btn[data-view="${view}"]`).click();
      viewSigs.add(await canvasSignature('#theme-preview-canvas'));
    }
    assert(viewSigs.size >= 5, `Expected distinct renders across preview views, got ${viewSigs.size}`);

    // Verify Track C font sizes + volume HUD overlay
    await page.locator('.preview-size-btn[data-size="20"]').click();
    const sig20 = await canvasSignature('#theme-preview-canvas');
    await page.locator('.preview-size-btn[data-size="40"]').click();
    const sig40 = await canvasSignature('#theme-preview-canvas');
    assert.notEqual(sig20, sig40, '20px and 40px preview must render differently');

    await page.locator('.preview-size-btn[data-size="30"]').click();
    await page.locator('.preview-style-btn[data-style="soft"]').click();
    const sigNoVol = await canvasSignature('#theme-preview-canvas');
    await page.locator('details > summary', { hasText: '音量提示预览' }).click();
    await page.locator('#preview-vol-visible').check();
    const sigWithVol = await canvasSignature('#theme-preview-canvas');
    assert.notEqual(sigNoVol, sigWithVol, 'Volume HUD toggle must change preview pixels');
    await page.selectOption('#preview-vol-style', '1');
    const sigVolBar = await canvasSignature('#theme-preview-canvas');
    assert.notEqual(sigWithVol, sigVolBar, 'Volume HUD style 1 must differ from style 0');

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(smokeOutDir, '02-theme-preview.png') });

    // Keys 16x11 matrix editor + Design v1 JSON export
    await page.locator('#keys-design-details summary').click();
    const cell10 = page.locator('#key-pixel-grid .pixel-cell').nth(10);
    const hadOn = await cell10.evaluate(el => el.classList.contains('on'));
    await cell10.click();
    const hasOnAfter = await cell10.evaluate(el => el.classList.contains('on'));
    assert.notEqual(hasOnAfter, hadOn, 'Key pixel cell should toggle');

    const designDlPromise = page.waitForEvent('download');
    await page.locator('#btn-export-design').click();
    const designDl = await designDlPromise;
    const designOutPath = path.join(smokeOutDir, 'exported-design.json');
    await designDl.saveAs(designOutPath);
    const designJson = JSON.parse(await readFile(designOutPath, 'utf8'));
    assert.equal(designJson.format, 'rainy75v2-tft/design-v1');
    assert.ok(designJson.theme && designJson.keys && designJson.playerSettings);

    // Reset keys back to built-in default so browser-only deployment proceeds without requiring source rebuild
    await page.locator('#btn-key-reset-all').click();
    assert.equal(await cell10.evaluate(el => el.classList.contains('on')), hadOn);

    // ==================== 3. GIF STUDIO TAB ====================
    await page.locator('#tab-btn-gif').click();
    await page.waitForFunction(() => document.querySelector('#gif-audit-badge')?.textContent?.includes('校验通过'));
    assert.match(await page.locator('#audit-format').textContent(), /320×172/);
    assert.match(await page.locator('#audit-format').textContent(), /disposal=1/);
    assert.match(await page.locator('#audit-marker').textContent(), /\(22, 39\)/);
    await page.locator('#pet-ai-help > summary').click();
    await page.locator('#pet-ai-idea').fill('雨滴小猫，蓝色围巾');
    const prompt = await page.locator('#pet-ai-prompt').inputValue();
    assert.match(prompt, /雨滴小猫/);
    assert.match(prompt, /124×110px/);
    assert.match(prompt, /普通 GIF 只会循环播放/);
    assert(prompt.includes(await page.locator('.chan-hex[data-channel="accent"]').inputValue()));
    await page.locator('#btn-copy-pet-prompt').click();
    assert.match(await page.locator('#pet-ai-feedback').textContent(), /已复制|已选中/);
    const [promptDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#btn-download-pet-prompt').click()]);
    const promptPath = path.join(smokeOutDir, 'pet-prompt.txt');
    await promptDownload.saveAs(promptPath);
    assert.equal(await readFile(promptPath, 'utf8'), prompt);
    await page.locator('#pet-ai-help > summary').click();

    // Upload green-screen GIF, test drag-to-move + reset + transforms & chroma-key
    await page.locator('#gif-file-input').setInputFiles(greenGifPath);
    await page.waitForFunction(() => document.querySelector('#gif-file-name')?.textContent?.includes('green-pet.gif'));
    await page.locator('#place-center').click();
    await page.locator('#gif-preview-canvas').scrollIntoViewIfNeeded();
    const box = await page.locator('#gif-preview-canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5 + 32, box.y + box.height * 0.5 - 16, { steps: 3 });
    await page.mouse.up();
    assert.notEqual(await page.locator('#gif-offsetx-val').textContent(), '0', 'Dragging canvas should adjust offset X');
    await page.locator('#btn-gif-reset-pos').click();
    assert.equal(await page.locator('#gif-offsetx-val').textContent(), '0');

    await page.locator('#panel-gif details.mini-details summary', { hasText: '画面裁剪方式' }).click();
    await page.selectOption('#gif-fit', 'cover');
    await page.locator('#gif-flip-x').check();
    await page.locator('#gif-chroma-enabled').check();
    await page.waitForFunction(() => document.querySelector('#gif-audit-badge')?.textContent?.includes('校验通过'));

    await page.locator('#btn-gif-extract-palette').click();
    assert(await page.locator('#gif-extracted-palette .palette-swatch-btn').count() > 0, 'Palette swatches should render');

    const gifDlPromise = page.waitForEvent('download');
    await page.locator('#btn-gif-download').click();
    const gifDl = await gifDlPromise;
    const gifOutPath = path.join(smokeOutDir, 'studio-out.gif');
    await gifDl.saveAs(gifOutPath);
    const downloadedGifBytes = await readFile(gifOutPath);
    assert.equal(downloadedGifBytes.subarray(0, 6).toString('ascii'), 'GIF89a');
    assert(downloadedGifBytes.length > 200);

    await page.locator('#btn-gif-use-deploy').click();
    await page.screenshot({ path: path.join(smokeOutDir, '03-gif-studio.png') });

    // ==================== 4. DEPLOY & RECOVERY WIZARD TAB ====================
    // Select Track A so synthetic main064 + ipsBase handles custom R75T flash + GIF upload + calibration
    await page.locator('#tab-btn-overview').click();
    await page.locator('#track-card-A').click();
    await page.locator('#tab-btn-deploy').click();

    await page.locator('#manual-bundle-details summary').click();
    await page.locator('#manual-main-bin').setInputFiles(mainBundle.binPath);
    await page.locator('#manual-main-manifest').setInputFiles(mainBundle.manifestPath);
    await page.waitForFunction(() => document.querySelector('#manual-main-status')?.textContent?.includes('校验通过'));

    await page.locator('#manual-ips-base-bin').setInputFiles(ipsBundle.binPath);
    await page.locator('#manual-ips-base-manifest').setInputFiles(ipsBundle.manifestPath);
    await page.waitForFunction(() => document.querySelector('#manual-ips-base-status')?.textContent?.includes('校验通过'));

    // Probe mock APP 0x3075 device
    await page.locator('#btn-probe-device').click();
    await page.waitForFunction(() => document.querySelector('#probe-pid')?.textContent?.includes('0x3075'));
    assert.match(await page.locator('#friendly-conn-text').textContent(), /已通过 USB 有线连接成功/);
    assert.match(await page.locator('#friendly-chip-text').textContent(), /大容量可升级屏幕/);
    await page.locator('#hardware-raw-details summary').click();
    assert.equal(await page.locator('#probe-telemetry').isVisible(), true);
    assert.match(await page.locator('#probe-main').textContent(), /V7\.1 \(0x4350\)/);
    assert.match(await page.locator('#probe-silicon').textContent(), /1024KiB \/ 系列 13/);
    assert.match(await page.locator('#probe-clock').textContent(), /未校时/);
    // Honest S1 uiActive=0 reminder must be visible
    assert.match(await page.locator('#deploy-notices').textContent(), /GIF 播放 \/ 槽位 1/);

    // Test smart-skip + pending R75T IPS flash in plan
    assert.match(await page.locator('[data-step-id="flash_main"]').textContent(), /已一致·跳过/);
    assert.match(await page.locator('[data-step-id="flash_ips_base"]').textContent(), /待执行/);

    // Standalone time calibration first
    await page.locator('#maintenance-tools > summary').click();
    await page.locator('#btn-quick-calibrate').click();
    await page.waitForFunction(
      () => document.querySelector('#probe-clock')?.textContent?.includes('有效'),
      null,
      { timeout: 15000 }
    );
    assert.equal(await page.evaluate(() => window.__mockHidStats.calibrateWrites), 1);

    // Start single-flight deployment -> must pause cleanly at awaiting_iap_auth (0x3078)
    await page.locator('#btn-start-deploy').click();
    await page.waitForFunction(
      () => document.querySelector('#runner-state-pill')?.textContent?.includes('请连接升级设备'),
      null,
      { timeout: 15000 }
    );
    assert.equal(await page.locator('#iap-auth-box').evaluate(el => !el.classList.contains('hidden')), true);
    assert.match(await page.locator('#btn-auth-iap').textContent(), /连接屏幕升级设备/);
    assert.equal(await page.locator('#btn-bg-start').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__mockHidStats.enteredIap), 'ips');
    await page.locator('#iap-auth-box').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(smokeOutDir, '04-deploy-iap-pause.png') });

    // A late OP22 response replaces OP2's ACK after IAP. Recover without reflashing.
    await page.evaluate(() => {
      window.__mockHidConfig.failPauseOnce = true;
      window.__mockHidConfig.lyricsSupported = true;
      window.__mockHidConfig.fontReady = true;
    });
    await page.locator('#btn-auth-iap').click();
    await page.waitForFunction(() => document.querySelector('#runner-state-pill')?.textContent?.includes('已失败中止'), null, { timeout: 30000 });
    assert.match(await page.locator('#deploy-error-msg').textContent(), /OP2/);
    assert.doesNotMatch(await page.locator('#deploy-recovery-hint').textContent(), /IAP/);
    assert.equal(await page.locator('#btn-recheck-font').isVisible(), true);
    await page.locator('#btn-recheck-font').click();
    await page.waitForFunction(() => document.querySelector('#deploy-recovery-hint').textContent.includes('现有字库可用'));
    assert.equal(await page.locator('#btn-retry-step').isDisabled(), false);
    await page.locator('#btn-retry-step').click();
    await page.waitForFunction(
      () => document.querySelector('#runner-state-pill')?.textContent?.includes('全部完成'),
      null,
      { timeout: 30000 }
    );

    const flashStats = await page.evaluate(() => window.__mockHidStats);
    assert.equal(flashStats.iapEraseCount, 1);
    assert.equal(flashStats.iapWriteBytes, 507904);
    assert(flashStats.iapVerifyCount > 9000);
    assert.equal(flashStats.iapEndCount, 1);
    assert.equal(await page.locator('#deploy-complete-box').isVisible(), true);
    assert(flashStats.gifBytesUploaded > 200);
    assert(flashStats.calibrateWrites >= 2);
    // R75T magic bytes ('R','7','5','T', 1, 0, 28, 0) written into IPS slot 0x2000!
    assert.deepEqual(flashStats.lastR75tHeader, [0x52, 0x37, 0x35, 0x54, 1, 0, 28, 0]);
    await page.screenshot({ path: path.join(smokeOutDir, '05-deploy-done.png') });

    await page.locator('#btn-probe-device').click();
    await page.waitForFunction(() => !document.querySelector('#btn-quick-check-font').disabled);
    await page.locator('#btn-quick-check-font').click();
    await page.waitForFunction(() => document.querySelector('#deploy-log').textContent.includes('无需重新上传。'));

    // Verify hardware guardrail blocks Track B on non-1024KiB / non-series-13 device
    await page.evaluate(() => {
      window.__mockHidConfig.flashKiB = 512;
      window.__mockHidConfig.series = 8;
    });
    await page.locator('#btn-probe-device').click();
    await page.waitForFunction(() => document.querySelector('#probe-silicon')?.textContent?.includes('512KiB'));
    await page.locator('#tab-btn-overview').click();
    await page.locator('#track-card-B').click();
    await page.locator('#tab-btn-deploy').click();
    assert.match(await page.locator('#plan-status-pill').textContent(), /硬件不兼容阻塞/);
    assert.equal(await page.locator('#btn-start-deploy').isDisabled(), true);

    // Check restore scenario notice cleanly
    await page.locator('#scenario-restore').click();
    assert.match(await page.locator('#deploy-plan-steps').textContent(), /基于官方输入基线生成.*恢复镜像/);

    // ==================== 5. WINDOWS BACKGROUND TAB ====================
    await page.locator('#tab-btn-background').click();
    await page.waitForFunction(() => document.querySelector('#bg-running')?.textContent?.includes('未运行'));
    assert.match(await page.locator('#bg-startup').textContent(), /未开启/);
    assert.match(await page.locator('#bg-hid').textContent(), /未占用/);
    await page.screenshot({ path: path.join(smokeOutDir, '06-background.png') });

    // ==================== 6. MOBILE 390x844 RESPONSIVE CHECK ====================
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileOverflow = {};
    for (const tab of ['overview', 'deploy', 'gif', 'theme', 'background']) {
      await page.locator(`#tab-btn-${tab}`).click();
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth
      }));
      mobileOverflow[tab] = overflow;
      assert(
        overflow.scrollWidth <= overflow.innerWidth + 1,
        `Mobile overflow on tab '${tab}': scrollWidth=${overflow.scrollWidth} > innerWidth=${overflow.innerWidth}`
      );
      if (tab === 'theme') {
        await page.screenshot({ path: path.join(smokeOutDir, '07-mobile-theme.png') });
      }
    }

    assert.deepEqual(pageErrors, [], `Unexpected pageerror(s): ${pageErrors.join('; ')}`);
    assert.deepEqual(consoleErrors, [], `Unexpected console.error(s): ${consoleErrors.join('; ')}`);
    assert.deepEqual(failedResponses, [], `Unexpected HTTP errors: ${failedResponses.join('; ')}`);

    await writeFile(
      path.join(smokeOutDir, 'validation.json'),
      JSON.stringify(
        {
          passed: true,
          physicalHardwareAccessed: false,
          url: srv.url,
          viewports: { desktop: '1280x960', mobile: '390x844', mobileOverflow },
          flashStats,
          pageErrors,
          consoleErrors,
          failedResponses
        },
        null,
        2
      )
    );
    console.log('Studio Playwright smoke passed; zero real HID accessed.');
  } finally {
    await browser?.close();
    serverChild?.kill();
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
