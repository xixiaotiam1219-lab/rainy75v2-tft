// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  MAIN_BASELINES,
  assertValidHidDevice,
  probeDevice,
  readStockBaseline,
  planDeployment,
  DeploymentRunner
} from '../web/deploy-wizard.mjs';
import {
  MAIN_CAP,
  IPS_CAP,
  ACK_READ,
  sha256,
  sum16
} from '../web/protocol.mjs';
import { validateFont } from '../web/font.mjs';
import {
  R75T_MAGIC,
  R75T_VERSION,
  R75T_BYTES,
  IPS_APP_BASE,
  IPS_FLASH_ORIGIN,
  PRESET_THEMES,
  crc32,
  rgb565,
  normalizeTheme
} from '../web/theme-engine.mjs';
import {
  composePetGifFrames,
  encodeGif320x172,
  rgbaToStaticGifSource
} from '../web/gif-studio.mjs';

import { planEdition } from '../web/easy-plan.mjs';

const require = createRequire(import.meta.url);
const { fontFixture } = require('./font-fixture.cjs');

function makeRawHidDescriptor(pid, length, { vid = 0x36b0, usagePage = 0xff60, usage = 0x61 } = {}) {
  const rep = { reportId: 0, items: [{ reportSize: 8, reportCount: length }] };
  return {
    vendorId: vid,
    productId: pid,
    collections: [{ usagePage, usage, inputReports: [rep], outputReports: [rep] }]
  };
}

function makeAppHidDevice({
  mainCap = MAIN_CAP,
  clockValid = true,
  ipsCap = IPS_CAP,
  uiActive = true,
  flashKiB = 1024,
  series = 13,
  lyricsSupported = true,
  fontReady = true,
  fontReadyAfterQueries = 0,
  fontCrc = 0x11223344,
  layoutCount = 5,
  coverSupported = true,
  volumeSupported = true
} = {}) {
  const base = makeRawHidDescriptor(0x3075, 256);
  const listeners = new Set();
  let curIpsCap = ipsCap;
  let seconds = clockValid ? 43200 : null;
  let ack = { sub: 13, status: 0, value: 0 };
  let readyQueries = 0;

  const emitInput = arr => {
    const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
    queueMicrotask(() => {
      for (const fn of [...listeners]) fn({ reportId: 0, data: view });
    });
  };

  const dev = {
    ...base,
    opened: false,
    setIpsCap(v) { curIpsCap = v; },
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    addEventListener(_, fn) { listeners.add(fn); },
    removeEventListener(_, fn) { listeners.delete(fn); },
    async sendReport(_, data) {
      const p = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (p[0] === ACK_READ[0] && p[1] === ACK_READ[1] && p[2] === ACK_READ[2]) {
        const r = new Uint8Array(256);
        r.set([0xbe, 0xe4, 14, 0x84, 4, 0, 0, ack.sub, ack.status, ack.value & 255, (ack.value >>> 8) & 255, 0, 0, 0xed], 0);
        const s = sum16(r.slice(0, 11));
        r[11] = s & 255;
        r[12] = s >>> 8;
        emitInput(r);
        return;
      }
      const op = p[4];
      const id = p[5] | (p[6] << 8);
      if (op === 15) {
        const f = p[5];
        const s = seconds ?? 0xffffffff;
        const v = f === 9 ? mainCap : f === 8 ? Number(seconds !== null) : f === 7 ? s >>> 16 : f === 6 ? s & 0xffff : 0;
        ack = { sub: 13, status: 0xd0 + f, value: v };
      } else if (op === 11) {
        const f = p[5];
        const s = seconds ?? 0xffffffff;
        const bcd = s === 0xffffffff
          ? 0xffffffff
          : parseInt(
              [Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60]
                .map(n => String(n).padStart(2, '0'))
                .join(''),
              16
            );
        let v = 0;
        if (f === 0) v = curIpsCap ?? 0;
        else if (f === 7) v = uiActive ? 1 : 0;
        else if (f === 14) v = flashKiB ?? 0;
        else if (f === 15) v = series ?? 0;
        else if (f === 4) v = s === 0xffffffff ? 0x401 : 0x402;
        else if (f === 5) v = bcd & 0xffff;
        else if (f === 6) v = bcd >>> 16;
        ack = { sub: 13, status: (f === 0 && curIpsCap === null) ? 0 : 0xb0 + f, value: v };
      } else if (op === 18) {
        const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
        seconds = dv.getUint32(8, true);
        ack = { sub: 13, status: 1, value: id };
      } else if (op === 24) {
        ack = lyricsSupported ? { sub: 13, status: 0xa6, value: 0x4c59 } : { sub: 13, status: 0xff, value: 0 };
      } else if (op === 22) {
        const f = p[5];
        let v = 0;
        if (f === 0) v = fontReady ? (++readyQueries > fontReadyAfterQueries ? 1 : 2) : 0;
        else if (f === 1) v = 0;
        else if (f === 2) v = fontReady ? 0 : 7;
        else if (f === 5) v = fontCrc & 0xffff;
        else if (f === 6) v = (fontCrc >>> 16) & 0xffff;
        else if (f === 11) v = layoutCount;
        else if (f === 12) v = coverSupported ? 0x4341 : 0;
        else if (f === 23) v = volumeSupported ? 0x564f : 0;
        ack = { sub: 13, status: 0xc0 + (f & 15), value: v };
      } else {
        ack = { sub: 13, status: 1, value: id };
      }
    }
  };
  return dev;
}

function makeIapHidDevice(pid, memSize, { failFirstVerify = false, onFlashEnd = null } = {}) {
  const base = makeRawHidDescriptor(pid, 64);
  const listeners = new Set();
  const memory = new Uint8Array(memSize);
  let writePos = 0;
  let eraseCalls = 0;
  let endCalls = 0;
  let verifyCount = 0;
  let shouldFailVerify = failFirstVerify;

  const emit = arr => {
    const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
    queueMicrotask(() => {
      for (const fn of [...listeners]) fn({ reportId: 0, data: view });
    });
  };

  return {
    ...base,
    opened: false,
    memory,
    stats: () => ({ eraseCalls, endCalls, writePos, verifyCount }),
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    addEventListener(_, fn) { listeners.add(fn); },
    removeEventListener(_, fn) { listeners.delete(fn); },
    async sendReport(_, data) {
      const p = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const cmd = p[0];
      if (cmd === 0x81) {
        eraseCalls++;
        writePos = 0;
        emit(new Uint8Array([0, 0]));
      } else if (cmd === 0x80) {
        const len = p[1];
        memory.set(p.slice(2, 2 + len), writePos);
        writePos += len;
        emit(new Uint8Array(64));
      } else if (cmd === 0x82) {
        verifyCount++;
        const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
        const appBase = pid === 0x3079 ? 0x2000 : 0x4000;
        const off = dv.getUint32(2, true) - appBase;
        if (shouldFailVerify) {
          shouldFailVerify = false;
          throw new Error('模拟 Flash 校验字节不一致');
        }
        const slice = memory.slice(off, off + 56);
        assert.deepEqual(slice, p.slice(6, 62));
        emit(new Uint8Array(64));
      } else if (cmd === 0x83) {
        endCalls++;
        if (onFlashEnd) onFlashEnd();
      }
    }
  };
}

async function makeSyntheticMainBundle() {
  const bytes = Uint8Array.from({ length: 294912 }, (_, i) => (i * 19 + 5) & 255);
  return {
    bytes,
    manifest: {
      format: 'rainy75v2-tft/build-v1',
      target: 'main',
      applicationBase: 0x2000,
      iapPid: 0x3079,
      bytes: bytes.length,
      sha256: await sha256(bytes)
    }
  };
}

async function makeSyntheticIpsBundle({ lyrics = false, fontBodyCrc = 0x11223344 } = {}) {
  const length = lyrics ? 540672 : 507904;
  const codeStart = lyrics ? 0x08080000 : IPS_FLASH_ORIGIN;
  const imageEnd = lyrics ? 0x08088000 : IPS_FLASH_ORIGIN + length;
  const slotOffset = lyrics ? 0x08080200 - IPS_FLASH_ORIGIN : 0x2000;
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
      codeStart,
      imageEnd,
      applicationBase: IPS_APP_BASE,
      fields: ['bg', 'panel', 'shell', 'ink', 'accent', 'muted', 'lyricsBorder', 'lyricsPanel'],
      crc32: slotCrc
    }
  };
  if (lyrics) {
    manifest.variant = 'lyrics-v1';
    manifest.requiredFlashKiB = 1024;
    manifest.requiredSeries = 13;
    manifest.codeStart = codeStart;
    manifest.imageEnd = imageEnd;
    manifest.iapEraseEnd = 0x080c0000;
    manifest.fontBodyCrc = fontBodyCrc;
  }
  return { bytes, manifest, slotOffset };
}

function makeTinyDeviceGif(theme = 'pink') {
  const rgba = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) {
    rgba[i * 4] = 220;
    rgba[i * 4 + 1] = 100;
    rgba[i * 4 + 2] = 150;
    rgba[i * 4 + 3] = 255;
  }
  const composed = composePetGifFrames(rgbaToStaticGifSource(rgba, 16, 16, 80), { theme });
  return encodeGif320x172(composed);
}

function makeSyntheticFont() {
  const bytes = new Uint8Array(fontFixture());
  const { bodyCrc } = validateFont(bytes);
  return { bytes, bodyCrc };
}

test('assertValidHidDevice and probeDevice accept APP/IAP devices and reject receivers/bad descriptors', async () => {
  assert.throws(() => assertValidHidDevice(makeRawHidDescriptor(0x3071, 256)), /2\.4G 接收器/);
  assert.throws(() => assertValidHidDevice(makeRawHidDescriptor(0x3070, 256)), /2\.4G 接收器/);
  assert.throws(() => assertValidHidDevice(makeRawHidDescriptor(0x3075, 256, { vid: 0x1234 })), /VID 不匹配/);
  assert.throws(() => assertValidHidDevice(makeRawHidDescriptor(0x3075, 64)), /HID 接口描述符不匹配/);

  const appDev = makeAppHidDevice({ fontCrc: 0xaabbccdd, flashKiB: 1024, series: 13 });
  const probed = await probeDevice(appDev, { pause: async () => {} });
  assert.equal(probed.mode, 'app');
  assert.equal(probed.mainCap, MAIN_CAP);
  assert.equal(probed.ipsCap, IPS_CAP);
  assert.equal(probed.uiActive, true);
  assert.equal(probed.flashKiB, 1024);
  assert.equal(probed.series, 13);
  assert.equal(probed.lyrics.supported, true);
  assert.equal(probed.lyrics.fontCrc, 0xaabbccdd);
  assert.equal(probed.lyrics.fontReady, true);
  assert.equal(probed.lyrics.layoutCount, 5);
  assert.equal(probed.lyrics.coverSupported, true);
  assert.equal(probed.lyrics.volumeSupported, true);

  const iapDev = makeRawHidDescriptor(0x3078, 64);
  const probedIap = await probeDevice(iapDev);
  assert.equal(probedIap.mode, 'iap');
  assert.equal(probedIap.target, 'ips');
});

test('update keeps the current S1 even when a default GIF exists in the release bundle', () => {
  const probe = { mainCap: MAIN_CAP, ipsCap: IPS_CAP, clockValid: true, uiActive: true };
  const bundle = { gif: makeTinyDeviceGif() };
  const unchanged = planDeployment(probe, { scenario: 'update', track: 'A' }, bundle);
  assert.equal(unchanged.steps.find(s => s.id === 'upload_gif').action, 'skip');
  const selected = planDeployment(probe, { scenario: 'update', track: 'A', customGifBytes: bundle.gif }, bundle);
  assert.equal(selected.steps.find(s => s.id === 'upload_gif').action, 'run');
});

test('probe waits for queued font initialization and keeps an accepted existing font', async () => {
  const app = makeAppHidDevice({ fontReadyAfterQueries: 5, fontCrc: 0x11223344 });
  const probe = await probeDevice(app, { pause: async () => {} });
  assert.equal(probe.lyrics.fontReady, true);
  assert.equal(probe.lyrics.fontInitializing, false);
  const plan = planDeployment(probe, { scenario: 'update', track: 'C', skipGif: true },
    { ipsLyrics: { manifest: { fontBodyCrc: 0x11223344 } } });
  assert.equal(plan.steps.find(s => s.id === 'upload_font').action, 'skip');
  assert(plan.steps.find(s => s.id === 'verify_font'));
});

test('font step rechecks after reboot and reuses an accepted font without starting any upload', async () => {
  const font = makeSyntheticFont(), events = [];
  const runner = new DeploymentRunner({
    plan: { steps: [{ id: 'upload_font', category: 'asset', action: 'run' },
      { id: 'verify_font', category: 'guard', action: 'run', expectedBodyCrc: font.bodyCrc }] },
    bundle: { font: font.bytes },
    appClient: {
      inspectFont: async () => ({ ready: true, settled: true, expectedBodyCrc: font.bodyCrc }),
      listFiles: async () => assert.fail('Accepted font must not need a storage listing'),
      uploadFont: async () => assert.fail('Accepted font must not be uploaded again'),
      close: async () => {}
    },
    onProgress: e => events.push(e.phase)
  });
  assert.equal((await runner.start()).status, 'completed');
  assert(events.includes('font_reused'));
  assert(events.includes('font_ready'));
});

test('unready existing font and pending initialization both stop before any storage write', async () => {
  const font = makeSyntheticFont();
  for (const settled of [false, true]) {
    const runner = new DeploymentRunner({
      plan: { steps: [{ id: 'upload_font', category: 'asset', action: 'run' }] },
      bundle: { font: font.bytes },
      appClient: {
        inspectFont: async () => ({ ready: false, settled, error: 7, expectedBodyCrc: font.bodyCrc }),
        listFiles: async () => [{ name: 'FONT.BIN', bytes: font.bytes.length }],
        uploadFont: async () => assert.fail('Existing or pending font must not be overwritten')
      }
    });
    await assert.rejects(() => runner.start(), settled ? /已有 FONT.BIN/ : /仍在初始化/);
    assert.equal(runner.diagnostic.stepId, 'upload_font');
    assert.doesNotMatch(runner.diagnostic.recoveryHint, /IAP/);
  }
});

test('font failure after successful IAP is attributed to font and retries only that step', async () => {
  const font = makeSyntheticFont();
  const ips = await makeSyntheticIpsBundle({ lyrics: true, fontBodyCrc: font.bodyCrc });
  const app = makeAppHidDevice({ fontCrc: font.bodyCrc ^ 1 });
  const iap = makeIapHidDevice(0x3078, ips.bytes.length);
  const runner = new DeploymentRunner({
    plan: { probe: { flashKiB: 1024, series: 13 }, steps: [
      { id: 'flash_ips_lyrics', target: 'ips', pid: 0x3078, category: 'firmware', action: 'run', hardwareChecked: true },
      { id: 'upload_font', category: 'asset', action: 'run' }] },
    bundle: { ipsLyrics: ips, font: font.bytes },
    appClient: { enterIap: async () => {}, probeLyricsTarget: async () => ({ flashKiB: 1024, series: 13 }) },
    hid: { getDevices: async () => [app], requestDevice: async () => [iap] },
    pause: async () => {}
  });
  assert.equal((await runner.start()).status, 'awaiting_iap_auth');
  await assert.rejects(() => runner.authorizeIapAndContinue(), /字库与安装文件不同/);
  assert.equal(runner.diagnostic.stepId, 'upload_font');
  assert.doesNotMatch(runner.diagnostic.recoveryHint, /IAP/);
  runner.appClient = { inspectFont: async () => ({ ready: true, settled: true, expectedBodyCrc: font.bodyCrc }), close: async () => {} };
  assert.equal((await runner.retryCurrentStep()).status, 'completed');
  assert.equal(iap.stats().eraseCalls, 1);
});

test('official version read correlates the response and accepts only the known checksum forms', async () => {
  for (const code of [63, 64, 65, 71]) for (const legacy of [false, true]) {
    const info = await readStockBaseline({ exchange: async (packet, match) => {
      assert.deepEqual(Array.from(packet.subarray(0, 7)), [0xbe, 0xe4, 10, 0x44, 4, 0, 0]);
      const reply = new Uint8Array(256);
      reply.set([0xbe, 0xe4, 14, 0x44, 4, 0, 0, 0, 0, code, 0, 0, 0, 0xed]);
      const checksum = legacy ? sum16(packet) : sum16(reply.subarray(0, 11));
      reply[11] = checksum & 255; reply[12] = checksum >>> 8;
      assert.equal(match(reply), true);
      const wrong = new Uint8Array(reply); wrong[3] = 0x84;
      assert.equal(match(wrong), false);
      return reply;
    } });
    assert.equal(info.baseline, code === 63 ? '0x3f' : code === 64 ? '0x40' : code === 71 ? '0x47' : null);
  }
  await assert.rejects(() => readStockBaseline({ exchange: async () => Uint8Array.of(0xbe, 0xe4, 14, 0x44, 4, 0, 0, 0, 0, 64, 0, 255, 255, 0xed) }), /校验失败/);
});

test('all required files are checked before entering the first firmware upgrade', async () => {
  let entered = false;
  const main = await makeSyntheticMainBundle();
  const runner = new DeploymentRunner({
    plan: { steps: [{ id: 'flash_main', category: 'firmware', target: 'main', pid: 0x3079, action: 'run' },
      { id: 'upload_font', category: 'asset', action: 'run' }] },
    bundle: { main }, appClient: { enterIap: async () => { entered = true; } }
  });
  await assert.rejects(() => runner.start(), /缺少 FONT.BIN/);
  await assert.rejects(() => runner.retryCurrentStep(), /缺少 FONT.BIN/);
  assert.equal(entered, false);
});

test('partial silicon reads schedule a guard before any lyrics firmware write', () => {
  for (const missing of [{ flashKiB: null, series: 13 }, { flashKiB: 1024, series: null }]) {
    const p = planDeployment({ mainCap: MAIN_CAP, ipsCap: IPS_CAP, ...missing },
      { scenario: 'update', track: 'C', forceReflashIps: true });
    assert(p.steps.findIndex(s => s.id === 'probe_lyrics_hardware') < p.steps.findIndex(s => s.id === 'flash_ips_lyrics'));
  }
});

test('restoring both chips from either IAP includes both targets in the actual plan', () => {
  for (const [pid, order] of [[0x3079, ['main', 'ips']], [0x3078, ['ips', 'main']]]) {
    const p = planDeployment({ pid, mode: 'iap' }, { scenario: 'restore', restoreTarget: 'both' });
    assert.deepEqual(p.steps.map(s => s.target), order);
    assert.equal(p.steps[0].alreadyInIap, true);
    assert.equal(p.steps[1].alreadyInIap, false);
  }
});

test('a disconnected APP pauses for a user gesture rather than requesting HID from a timer', async () => {
  let requests = 0;
  const app = makeAppHidDevice();
  const runner = new DeploymentRunner({
    plan: { steps: [{ id: 'calibrate', action: 'run', category: 'rtc' }] },
    hid: { getDevices: async () => [], requestDevice: async () => { requests++; return [app]; } },
    pause: async () => {}
  });
  assert.equal((await runner.start()).status, 'awaiting_app_auth');
  assert.equal(requests, 0);
  assert.equal((await runner.authorizeIapAndContinue()).status, 'completed');
  assert.equal(requests, 1);
});

test('cancel cannot close a HID handle while an upload is in progress', async () => {
  let release;
  let closed = false;
  const pending = new Promise(resolve => { release = resolve; });
  const runner = new DeploymentRunner({
    plan: { track: 'A', steps: [{ id: 'upload_gif', action: 'run', category: 'asset' }] },
    bundle: { gif: makeTinyDeviceGif() },
    appClient: { upload: async () => pending, close: async () => { closed = true; } }
  });
  const running = runner.start();
  await assert.rejects(() => runner.abort(), /等待当前操作结束/);
  assert.equal(closed, false);
  release();
  assert.equal((await running).status, 'completed');
});

test('planDeployment computes Track A/B/C smart skips, baseline switch warning, two-stage probe, hardware guard, and restore labels', () => {
  const factoryApp = {
    pid: 0x3075,
    mode: 'app',
    mainCap: 0x434f,
    ipsCap: null,
    clockValid: false,
    uiActive: false,
    flashKiB: null,
    series: null,
    lyrics: { supported: false }
  };

  // 1. Track A first install + skipping FONT.BIN
  const planAFirst = planDeployment(factoryApp, { scenario: 'first', track: 'A' });
  assert.equal(planAFirst.blocked, false);
  assert.equal(planAFirst.steps.find(s => s.id === 'flash_main').action, 'run');
  assert.equal(planAFirst.steps.find(s => s.id === 'flash_ips_base').action, 'run');
  assert.equal(planAFirst.steps.find(s => s.id === 'upload_font').action, 'skip');
  assert.equal(planAFirst.steps.find(s => s.id === 'upload_gif').action, 'run');
  assert.equal(planAFirst.steps.find(s => s.id === 'manual_wob_s1_check').action, 'manual');

  // 2. Smart skip main V7.1 + baseline switch warning
  const upToDateApp = {
    pid: 0x3075,
    mode: 'app',
    mainCap: MAIN_CAP,
    ipsCap: IPS_CAP,
    clockValid: true,
    uiActive: true,
    flashKiB: 1024,
    series: 13,
    lyrics: { supported: true, fontReady: true, fontCrc: 0x55667788, layoutCount: 5, coverSupported: true, volumeSupported: true }
  };
  const planBaselineWarn = planDeployment(
    upToDateApp,
    { scenario: 'update', track: 'C', baseline: '0x3f', previousBaseline: '0x40', skipCalibrate: true },
    { ipsLyrics: { bytes: new Uint8Array(10), manifest: { fontBodyCrc: 0x55667788, themeSlot: {} } } }
  );
  assert.equal(planBaselineWarn.steps.find(s => s.id === 'flash_main').action, 'skip');
  assert.equal(planBaselineWarn.steps.find(s => s.id === 'flash_ips_lyrics').action, 'skip');
  assert.equal(planBaselineWarn.steps.find(s => s.id === 'upload_font').action, 'skip');
  assert(planBaselineWarn.warnings.some(w => w.includes('0x40') && w.includes('0x3f')));
  assert.equal(planBaselineWarn.steps.find(s => s.id === 'manual_wob_s1_check').action, 'skip');

  // 3. Factory unknown IPS on Track B -> two-stage flow (base -> probe -> lyrics)
  const planBTwoStage = planDeployment(factoryApp, { scenario: 'first', track: 'B' });
  const ids = planBTwoStage.steps.map(s => s.id);
  assert(ids.indexOf('flash_ips_base') < ids.indexOf('probe_lyrics_hardware'));
  assert(ids.indexOf('probe_lyrics_hardware') < ids.indexOf('flash_ips_lyrics'));

  // 4. Hardware guard rejects <1024KiB or non-series 13 for Track B/C
  const blockedChip = planDeployment({ ...upToDateApp, flashKiB: 512, series: 13 }, { scenario: 'first', track: 'B' });
  assert.equal(blockedChip.blocked, true);
  assert.match(blockedChip.error, /1024KiB/);

  const blockedIapLyrics = planDeployment({ pid: 0x3078, mode: 'iap', target: 'ips' }, { scenario: 'first', track: 'C' });
  assert.equal(blockedIapLyrics.blocked, true);

  // 5. Missing themeSlot when changing theme triggers needs_reflash; custom keys triggers needs_reflash
  const noSlotPlan = planDeployment(
    upToDateApp,
    { scenario: 'update', track: 'A', themeColors: PRESET_THEMES.mint, customKeysChanged: true },
    { ipsBase: { bytes: new Uint8Array(10), manifest: {} } }
  );
  assert.equal(noSlotPlan.steps.find(s => s.id === 'flash_ips_base').action, 'needs_reflash');
  assert.equal(noSlotPlan.steps.find(s => s.id === 'rebuild_custom_keys').action, 'needs_reflash');

  // 6. Restore flow labels & IAP already-entered detection
  const restoreIps = planDeployment({ pid: 0x3078, mode: 'iap', target: 'ips' }, { scenario: 'restore', restoreTarget: 'ips' });
  assert.equal(restoreIps.blocked, false);
  assert.equal(restoreIps.steps.length, 1);
  assert.equal(restoreIps.steps[0].alreadyInIap, true);
  assert.match(restoreIps.steps[0].title, /基于官方输入基线生成的恢复镜像（非整片 Flash 备份）/);
});

test('DeploymentRunner executes end-to-end IAP theme patch + authorizeIapAndContinue + single-flight lock + failure/retry + abort', async () => {
  const ipsBundle = await makeSyntheticIpsBundle({ lyrics: false });
  const mintTheme = normalizeTheme('mint');

  const appDev = makeAppHidDevice({ mainCap: MAIN_CAP, ipsCap: null, uiActive: true });
  const existingIapDev = makeIapHidDevice(0x3078, 507904, { failFirstVerify: true });
  const freshIapDev = makeIapHidDevice(0x3078, 507904, {
    failFirstVerify: false,
    onFlashEnd: () => appDev.setIpsCap(IPS_CAP)
  });

  let requestCount = 0;
  const mockHid = {
    async getDevices() { return [appDev, existingIapDev]; },
    async requestDevice({ filters }) {
      requestCount++;
      assert.equal(filters[0].productId, 0x3078);
      // 1st request returns existingIapDev (which fails first verify), 2nd retry returns freshIapDev!
      return [requestCount === 1 ? existingIapDev : freshIapDev];
    }
  };

  const rawProbe = await probeDevice(appDev, { pause: async () => {} });
  const plan = planDeployment(
    rawProbe,
    { scenario: 'update', track: 'A', themeColors: mintTheme, skipGif: true },
    { ipsBase: ipsBundle }
  );

  const runner = new DeploymentRunner({
    plan,
    bundle: { ipsBase: ipsBundle },
    intent: { track: 'A', themeColors: mintTheme, skipGif: true },
    hid: mockHid,
    pause: async () => {}
  });

  // Pause at awaiting_iap_auth after APP enterIap
  const firstPause = await runner.start();
  assert.equal(firstPause.status, 'awaiting_iap_auth');
  assert.equal(firstPause.iapNeeded.pid, 0x3078);

  // Single-flight guard rejects duplicate start()
  await assert.rejects(() => runner.start(), /正在进行中/);

  // authorizeIapAndContinue with allowExisting=false MUST call requestDevice even though getDevices has 0x3078;
  // first device deliberately corrupts verify -> must enter failed with NO auto-retry!
  await assert.rejects(() => runner.authorizeIapAndContinue({ allowExisting: false }), /校验失败|不一致/);
  assert.equal(requestCount, 1);
  assert.equal(runner.status, 'failed');
  assert(runner.diagnostic?.recoveryHint);
  assert.equal(existingIapDev.stats().eraseCalls, 1); // Did NOT auto-retry

  // Explicit retryCurrentStep() re-requests IAP device -> completes IPS flash + reconnects APP to calibrate!
  const finished = await runner.retryCurrentStep();
  assert.equal(requestCount, 2);
  assert.equal(finished.status, 'completed');
  assert.equal(freshIapDev.stats().endCalls, 1);

  // Verify the flashed bytes in freshIapDev.memory actually contain the patched MINT theme in R75T slot!
  const memDv = new DataView(freshIapDev.memory.buffer);
  assert.equal(memDv.getUint16(ipsBundle.slotOffset + 8, true), rgb565(mintTheme.background));
  assert.equal(memDv.getUint16(ipsBundle.slotOffset + 14, true), rgb565(mintTheme.ink));
  assert.equal(
    memDv.getUint32(ipsBundle.slotOffset + 24, true),
    crc32(freshIapDev.memory.subarray(ipsBundle.slotOffset, ipsBundle.slotOffset + 24))
  );

  // Abort test on a fresh runner
  const abortRunner = new DeploymentRunner({
    plan,
    bundle: { ipsBase: ipsBundle },
    intent: { track: 'A', themeColors: mintTheme, skipGif: true },
    hid: mockHid,
    pause: async () => {}
  });
  await abortRunner.start();
  const aborted = await abortRunner.abort();
  assert.equal(aborted.status, 'aborted');
  await assert.rejects(() => abortRunner.start(), /已中止/);
});

test('DeploymentRunner runs Track C font/GIF uploads via validated pipeline and supports already-in-IAP restore', async () => {
  const font = makeSyntheticFont();
  const gif = makeTinyDeviceGif('pink');
  const ipsLyrics = await makeSyntheticIpsBundle({ lyrics: true, fontBodyCrc: font.bodyCrc });

  const probeUpToDate = {
    pid: 0x3075,
    mode: 'app',
    mainCap: MAIN_CAP,
    ipsCap: IPS_CAP,
    clockValid: false,
    uiActive: false,
    flashKiB: 1024,
    series: 13,
    lyrics: { supported: true, fontReady: false, fontCrc: font.bodyCrc, layoutCount: 5, coverSupported: true, volumeSupported: true }
  };
  const plan = planDeployment(
    probeUpToDate,
    { scenario: 'update', track: 'C', customGifBytes: gif },
    { ipsLyrics, font: font.bytes, gif }
  );

  const calls = [];
  let uploaded = false;
  const fakeAppClient = {
    async probeLyricsTarget() { calls.push('probe'); return { flashKiB: 1024, series: 13 }; },
    async inspectFont() { return { ready: uploaded, settled: true, expectedBodyCrc: font.bodyCrc }; },
    async listFiles() { return []; },
    async uploadFont(bytes) { uploaded = true; calls.push(['font', bytes.length]); },
    async upload(bytes) { calls.push(['gif', bytes.length]); },
    async calibrate() { calls.push('calibrate'); },
    async close() {}
  };

  const runner = new DeploymentRunner({
    plan,
    bundle: { ipsLyrics, font: font.bytes, gif },
    intent: { track: 'C', customGifBytes: gif },
    hid: { getDevices: async () => [] },
    appClient: fakeAppClient,
    pause: async () => {}
  });
  const done = await runner.start();
  assert.equal(done.status, 'completed');
  assert.deepEqual(calls, [['font', font.bytes.length], ['gif', gif.length], 'calibrate']);
  assert.equal(done.manualReminders.length, 1);
  assert.equal(runner.snapshot().manualReminders[0].id, 'manual_wob_s1_check');

  // Already-in-IAP single-target Main restore from 0x3079 without switching modes first
  const mainBundle = await makeSyntheticMainBundle();
  const iapMainDev = makeIapHidDevice(0x3079, 294912);
  const restoreProbe = await probeDevice(iapMainDev);
  const restorePlan = planDeployment(restoreProbe, { scenario: 'restore', restoreTarget: 'main' });
  const restoreRunner = new DeploymentRunner({
    plan: { ...restorePlan, probe: { ...restorePlan.probe, device: iapMainDev } },
    bundle: { restoreMain: mainBundle },
    intent: { scenario: 'restore', restoreTarget: 'main' },
    hid: { getDevices: async () => [iapMainDev] },
    pause: async () => {}
  });
  const restoreDone = await restoreRunner.start();
  assert.equal(restoreDone.status, 'completed');
  assert.deepEqual(iapMainDev.memory, mainBundle.bytes);
});


test('standalone editions select the matching 0.71 image and refuse unknown or mismatched stock', async () => {
  const main071 = await makeSyntheticMainBundle();
  main071.manifest.stockSha256 = MAIN_BASELINES['0x47'].stockSha256;
  const font = new Uint8Array(fontFixture());
  const { bodyCrc } = validateFont(font);
  const ipsBase = await makeSyntheticIpsBundle();
  const ipsLyrics = await makeSyntheticIpsBundle({ lyrics: true, fontBodyCrc: bodyCrc });
  const gif = new Uint8Array(require('node:fs').readFileSync(new URL('../assets/robot-pink.gif', import.meta.url)));
  const bundle = { firmware: { main071 }, ipsBase, ipsLyrics, font, gif };
  const stock071 = { mode: 'app', detectedBaseline: '0x47', stockVersion: [0, 0, 71, 0] };
  for (const layout of [null, 0, 1, 2, 3, 4]) {
    const { plan, intent, bundle: selected } = planEdition(stock071, { layout }, bundle);
    assert.equal(selected.main, main071);
    assert.equal(plan.baseline, '0x47');
    assert.equal(plan.steps[0].id, 'flash_main');
    assert.equal(intent.preferredLayout, layout ?? undefined);
    assert.equal(plan.steps.some(step => step.id === 'flash_ips_lyrics'), layout !== null);
    if (layout !== null) {
      assert(plan.steps.findIndex(step => step.id === 'upload_gif') < plan.steps.findIndex(step => step.id === 'upload_font'));
    }
  }
  let writes = 0;
  const candidate = planEdition(stock071, { layout: null }, bundle);
  const runner = new DeploymentRunner({ ...candidate, appClient: { enterIap: async () => { writes++; } } });
  assert.equal((await runner.start()).status, 'awaiting_iap_auth');
  assert.equal(writes, 1);
  assert.throws(() => planEdition({ ...stock071, detectedBaseline: null }, { layout: 4 }, bundle), /未适配/);
  assert.throws(() => planEdition({ mode: 'app' }, { layout: 4 }, bundle), /未读到/);
  assert.throws(() => planEdition({ mode: 'iap' }, { layout: 4 }, bundle), /升级模式/);
  assert.throws(() => planEdition(stock071, { layout: 4 }, { ...bundle, firmware: {} }), /缺少匹配/);
  const wrong = { ...main071, manifest: { ...main071.manifest, stockSha256: MAIN_BASELINES['0x40'].stockSha256 } };
  assert.throws(() => planEdition(stock071, { layout: 4 }, { ...bundle, firmware: { main071: wrong } }), /缺少匹配/);

  const patched = { ...stock071, mainCap: MAIN_CAP, ipsCap: IPS_CAP, flashKiB: 1024, series: 13,
    clockValid: true, lyrics: { supported: true, fontCrc: bodyCrc, fontReady: true, layout: 1, layoutCount: 2 } };
  const action = (layout, step) => planEdition(patched, { layout }, bundle).plan.steps.find(s => s.id === step)?.action;
  assert.equal(action(1, 'upload_font'), 'skip');
  assert.equal(action(1, 'flash_ips_lyrics'), 'skip');
  assert.equal(action(3, 'flash_ips_lyrics'), 'run');
  assert.equal(action(null, 'flash_ips_base'), 'run');
  assert.equal(action(1, 'calibrate'), 'skip');
});
