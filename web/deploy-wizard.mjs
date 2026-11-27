// SPDX-License-Identifier: MIT
import {
  VID,
  APP_PID,
  MAIN_CAP,
  IPS_CAP,
  TARGETS,
  sum16,
  validateBuild,
  validateGif
} from './protocol.mjs';
import { HidIO, AppClient, FlashClient, validDevice, wait } from './hid.mjs';
import { validateFont } from './font.mjs';
import { patchIpsTheme, normalizeTheme } from './theme-engine.mjs';
import { auditDeviceGif } from './gif-studio.mjs';

const RESTORE_NOTE = '基于官方输入基线生成的恢复镜像（非整片 Flash 备份）';
const KNOWN_PIDS = new Set([APP_PID, TARGETS.main.pid, TARGETS.ips.pid]);
const RECEIVER_PIDS = new Set([0x3070, 0x3071]);

export const MAIN_BASELINES = Object.freeze({
  '0x3f': Object.freeze({
    version: '0.63-beta1', code: 63, patch: 'main063beta1', restore: 'restoreMain063beta1',
    stockSha256: 'bc575a6d7b19042048705248715a43a67a23c7f217ba0ac464c539a390f4d23b'
  }),
  '0x40': Object.freeze({
    version: '0.64', code: 64, patch: 'main064', restore: 'restoreMain064',
    stockSha256: '31a9eb80752c1f8c94951dd6e2e6776eeb216f47ba58919ca36f6e6d26f0e476'
  }),
  '0x47': Object.freeze({
    version: '0.71', code: 71, patch: 'main071', restore: 'restoreMain071',
    stockSha256: 'c9ecade81300d083e3a067498e67401dd323668b76c26450ad23f758394ccbd4'
  }),
});

function isReceiverPid(pid) {
  return RECEIVER_PIDS.has(pid);
}

function getDefaultHid(override) {
  if (override) return override;
  if (globalThis.navigator && globalThis.navigator.hid) return globalThis.navigator.hid;
  return null;
}

/**
 * Validate a WebHID device descriptor and reject receivers or mismatched targets.
 * @param {any} device
 * @param {number} [expectedPid]
 * @returns {{ pid: number, length: number, mode: 'app'|'iap', target: 'app'|'main'|'ips' }}
 */
export function assertValidHidDevice(device, expectedPid) {
  if (!device || typeof device !== 'object') {
    throw new Error('未选择有效的 USB HID 设备');
  }
  const vid = device.vendorId;
  const pid = device.productId;
  if (vid !== VID) {
    throw new Error('设备 VID 不匹配，仅支持 Rainy75 V2（0x36B0）');
  }
  if (isReceiverPid(pid)) {
    throw new Error(
      `检测到 2.4G 接收器（PID 0x${pid.toString(16)}），请用 USB 数据线直连键盘并切到有线模式`
    );
  }
  if (!KNOWN_PIDS.has(pid)) {
    throw new Error(`不支持的设备 PID：0x${Number(pid).toString(16)}`);
  }
  if (expectedPid !== undefined && pid !== expectedPid) {
    throw new Error(
      `设备模式不匹配：期望 0x${expectedPid.toString(16)}，实际 0x${pid.toString(16)}`
    );
  }
  const expectedLength = pid === APP_PID ? 256 : 64;
  if (!validDevice(device, pid, expectedLength)) {
    throw new Error(
      `HID 接口描述符不匹配（期望 UsagePage 0xFF60 / Usage 0x61 / ${expectedLength}B 报文）`
    );
  }
  return {
    pid,
    length: expectedLength,
    mode: pid === APP_PID ? 'app' : 'iap',
    target: pid === TARGETS.main.pid ? 'main' : pid === TARGETS.ips.pid ? 'ips' : 'app'
  };
}

async function safeQuery(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

// The official read-only version parameter, also present before our patch is installed.
export async function readStockBaseline(io) {
  const packet = Uint8Array.of(0xbe, 0xe4, 10, 0x44, 4, 0, 0, 0, 0, 0xed);
  const requestSum = sum16(packet.subarray(0, 7));
  packet[7] = requestSum & 255; packet[8] = requestSum >>> 8;
  const reply = await io.exchange(packet, p => p[0] === 0xbe && p[1] === 0xe4 && p[2] === 14 &&
    p[3] === 0x44 && p[4] === 4 && p[5] === 0 && p[6] === 0 && p[13] === 0xed, 2500);
  const received = reply[11] | reply[12] << 8;
  if (received !== sum16(reply.subarray(0, 11)) && received !== sum16(packet)) throw new Error('原厂版本应答校验失败');
  const raw = Array.from(reply.subarray(7, 11));
  const baseline = Object.keys(MAIN_BASELINES).find(key => raw.join(',') === `0,0,${MAIN_BASELINES[key].code},0`);
  return { raw, baseline: baseline || null };
}

async function queryLy1State(client) {
  let fontState;
  try {
    fontState = await client.inspectFont();
  } catch {
    return { supported: false };
  }
  const q = async field => {
    try {
      const ack = await client.request(22, field, [], a => a.status === 0xc0 + (field & 15));
      return ack.value;
    } catch {
      return null;
    }
  };
  const fields = {};
  for (let f = 0; f <= 28; f++) {
    fields[f] = await q(f);
  }
  // HELLO queues initialization; an early ready=2 must not mean "missing font".
  fields[0] = fontState.readyState;
  fields[2] = fontState.error;
  const crcLo = fields[5];
  const crcHi = fields[6];
  const fontCrc = crcLo !== null && crcHi !== null ? ((crcHi * 65536 + crcLo) >>> 0) : null;
  const coverFormats = fields[16] ?? 0;
  return {
    supported: true,
    fontReady: fontState.settled ? fontState.ready : null,
    fontInitializing: !fontState.settled,
    mode: fields[1],
    error: fields[2],
    committed: fields[3],
    jobBusy: fields[4],
    fontCrc,
    titleMaxGlyphs: fields[7],
    layout: fields[8],
    layoutCount: fields[11] ?? 2,
    coverSupported: fields[12] === 0x4341,
    coverIndexed: Boolean(coverFormats & 1),
    coverSmall: Boolean(coverFormats & 2),
    textSize: fields[21],
    textStyle: fields[22],
    volumeSupported: fields[23] === 0x564f,
    volumeLevel: fields[24] !== null ? fields[24] & 255 : null,
    volumeMuted: fields[24] !== null ? Boolean(fields[24] >>> 8) : null,
    volumeScope: fields[26] !== null ? fields[26] & 255 : null,
    volumeStyle: fields[26] !== null ? fields[26] >>> 8 : null,
    volumeHoldMs: fields[28],
    rawFields: fields
  };
}

/**
 * Probe a connected APP or IAP device (or pick one via an injectable HID adapter).
 * @param {any} target
 * @param {{ hid?: any, pause?: Function, now?: Function, keepOpen?: boolean }} [options]
 */
export async function probeDevice(target, options = {}) {
  const { pause = wait, now = Date.now, keepOpen = false } = options;

  if (target && typeof target.queryMain === 'function' && typeof target.queryIps === 'function') {
    const mainCap = await safeQuery(() => target.queryMain(9));
    const stock = target.io ? await safeQuery(() => readStockBaseline(target.io)) : null;
    const clockValidRaw = mainCap === MAIN_CAP ? await safeQuery(() => target.queryMain(8)) : null;
    const clockGuard = mainCap === MAIN_CAP ? await safeQuery(() => target.queryMain(15)) : null;
    const ipsCap = await safeQuery(() => target.queryIps(0));
    let uiActive = null;
    let flashKiB = null;
    let series = null;
    let lyrics = { supported: false };
    if (ipsCap === IPS_CAP) {
      const uiRaw = await safeQuery(() => target.queryIps(7));
      uiActive = uiRaw === null ? null : Boolean(uiRaw);
      flashKiB = await safeQuery(() => target.queryIps(14));
      series = await safeQuery(() => target.queryIps(15));
      lyrics = await queryLy1State(target);
    }
    return {
      valid: true,
      vendorId: VID,
      pid: APP_PID,
      mode: 'app',
      target: 'app',
      mainCap,
      stockVersion: stock?.raw || null,
      detectedBaseline: stock?.baseline || null,
      clockValid: clockValidRaw === null ? null : Boolean(clockValidRaw),
      clockGuard,
      ipsCap,
      uiActive,
      flashKiB,
      series,
      lyrics
    };
  }

  let device = target;
  if (!device || (typeof device.requestDevice === 'function' && !device.collections)) {
    const hid = getDefaultHid(device || options.hid);
    if (!hid) {
      throw new Error('请使用支持 WebHID 的桌面 Chrome / Edge（localhost 或 HTTPS）');
    }
    const list = await hid.requestDevice({
      filters: [
        { vendorId: VID, productId: APP_PID, usagePage: 0xff60, usage: 0x61 },
        { vendorId: VID, productId: TARGETS.main.pid, usagePage: 0xff60, usage: 0x61 },
        { vendorId: VID, productId: TARGETS.ips.pid, usagePage: 0xff60, usage: 0x61 }
      ]
    });
    device = list && list[0];
    if (!device) throw new Error('未选择设备');
  }

  const info = assertValidHidDevice(device);
  if (info.mode === 'iap') {
    return {
      valid: true,
      vendorId: VID,
      pid: info.pid,
      mode: 'iap',
      target: info.target,
      device: keepOpen ? device : undefined
    };
  }

  const wasOpened = Boolean(device.opened);
  if (!wasOpened && typeof device.open === 'function') {
    await device.open();
  }
  const io = new HidIO(device, 256);
  const client = new AppClient(io, { pause, now });
  try {
    const result = await probeDevice(client);
    if (keepOpen) {
      return { ...result, client, device };
    }
    return result;
  } finally {
    if (!keepOpen && !wasOpened) {
      await client.close().catch(() => {});
    }
  }
}

function normalizeProbe(probe) {
  if (!probe || typeof probe !== 'object') {
    throw new Error('缺少设备探测结果');
  }
  if (probe.vendorId !== undefined && probe.vendorId !== VID) {
    throw new Error('设备 VID 不匹配，仅支持 Rainy75 V2（0x36B0）');
  }
  if (probe.collections !== undefined || probe.productId !== undefined) {
    const checked = assertValidHidDevice(probe);
    return {
      ...probe,
      pid: checked.pid,
      mode: checked.mode,
      target: checked.target,
      valid: true
    };
  }
  const pid = probe.pid ?? APP_PID;
  if (isReceiverPid(pid)) {
    throw new Error(`检测到 2.4G 接收器（PID 0x${pid.toString(16)}），无法用于有线部署`);
  }
  if (!KNOWN_PIDS.has(pid)) {
    throw new Error(`不支持的设备 PID：0x${Number(pid).toString(16)}`);
  }
  if (probe.valid === false) {
    throw new Error(probe.error || '设备 HID 描述符无效');
  }
  const mode = probe.mode || (pid === APP_PID ? 'app' : 'iap');
  const lyrics = probe.lyrics || {
    supported: Boolean(probe.lyricsSupported),
    fontReady: probe.fontReady,
    fontCrc: probe.fontCrc,
    layoutCount: probe.layoutCount,
    coverSupported: probe.coverSupported,
    volumeSupported: probe.volumeSupported
  };
  return {
    ...probe,
    pid,
    mode,
    target: probe.target || (pid === TARGETS.main.pid ? 'main' : pid === TARGETS.ips.pid ? 'ips' : 'app'),
    lyrics
  };
}

function resolveBundleEntry(entry, label) {
  if (!entry) return null;
  if (entry.bytes instanceof Uint8Array && entry.manifest) return entry;
  throw new Error(`缺少 ${label} 的固件 BIN 或 manifest.json`);
}

function getFontBodyCrcFromBundle(bundle, ipsEntry) {
  if (bundle?.font instanceof Uint8Array) {
    return validateFont(bundle.font).bodyCrc;
  }
  const crc = ipsEntry?.manifest?.fontBodyCrc;
  return typeof crc === 'number' ? (crc >>> 0) : null;
}

/**
 * Compute a deterministic deployment / recovery plan without mutating hardware.
 * @param {any} rawProbe
 * @param {any} [intent]
 * @param {any} [bundle]
 */
export function planDeployment(rawProbe, intent = {}, bundle = {}) {
  const probe = normalizeProbe(rawProbe);
  const scenario = intent.scenario || 'first';
  const track = intent.track || 'A';
  const baseline = intent.baseline || probe.detectedBaseline || '0x40';
  const restoreTarget = intent.restoreTarget || 'both';
  const warnings = [];
  const steps = [];

  if (scenario !== 'restore' && probe.stockVersion && !probe.detectedBaseline && (probe.mainCap !== MAIN_CAP || intent.forceReflashMain)) {
    return { scenario, track, baseline, probe, blocked: true, error: '原厂主控版本尚未适配，请保留官方固件并反馈版本信息。', warnings, steps: [] };
  }
  if (probe.detectedBaseline && baseline !== probe.detectedBaseline && (scenario === 'restore' || probe.mainCap !== MAIN_CAP || intent.forceReflashMain)) {
    return { scenario, track, baseline, probe, blocked: true, error: '所选主控镜像与设备读到的原厂版本不同，请按识别结果选择。', warnings, steps: [] };
  }

  if (!['first', 'update', 'restore'].includes(scenario)) {
    throw new Error(`不支持的部署场景：${scenario}`);
  }
  if (!['A', 'B', 'C'].includes(track)) {
    throw new Error(`不支持的功能轨道：${track}`);
  }

  if (scenario === 'restore') {
    const addRestoreMain = alreadyInIap => {
      steps.push({
        id: 'flash_restore_main',
        category: 'firmware',
        target: 'main',
        pid: TARGETS.main.pid,
        alreadyInIap,
        action: 'run',
        title: `恢复主控固件（${RESTORE_NOTE}）`,
        reason: RESTORE_NOTE,
        note: RESTORE_NOTE
      });
    };
    const addRestoreIps = alreadyInIap => {
      steps.push({
        id: 'flash_restore_ips',
        category: 'firmware',
        target: 'ips',
        pid: TARGETS.ips.pid,
        alreadyInIap,
        action: 'run',
        title: `恢复屏幕 IPS 固件（${RESTORE_NOTE}）`,
        reason: RESTORE_NOTE,
        note: RESTORE_NOTE
      });
    };

    if (probe.pid === TARGETS.main.pid) {
      if (restoreTarget === 'ips') {
        const msg = `当前设备处于主控 IAP (0x3079)，仅可执行主控恢复；${RESTORE_NOTE}`;
        return {
          scenario,
          track,
          baseline,
          probe,
          blocked: true,
          error: msg,
          warnings,
          steps: [{
            id: 'flash_restore_ips',
            category: 'firmware',
            target: 'ips',
            pid: TARGETS.ips.pid,
            action: 'blocked',
            title: `恢复屏幕 IPS 固件（${RESTORE_NOTE}）`,
            reason: msg,
            note: RESTORE_NOTE
          }]
        };
      }
      if (restoreTarget === 'both') {
        warnings.push('先恢复主控，正常模式重连后继续恢复屏幕。');
      }
      addRestoreMain(true);
      if (restoreTarget === 'both') addRestoreIps(false);
    } else if (probe.pid === TARGETS.ips.pid) {
      if (restoreTarget === 'main') {
        const msg = `当前设备处于屏幕 IAP (0x3078)，仅可执行屏幕恢复；${RESTORE_NOTE}`;
        return {
          scenario,
          track,
          baseline,
          probe,
          blocked: true,
          error: msg,
          warnings,
          steps: [{
            id: 'flash_restore_main',
            category: 'firmware',
            target: 'main',
            pid: TARGETS.main.pid,
            action: 'blocked',
            title: `恢复主控固件（${RESTORE_NOTE}）`,
            reason: msg,
            note: RESTORE_NOTE
          }]
        };
      }
      if (restoreTarget === 'both') {
        warnings.push('先恢复屏幕，正常模式重连后继续恢复主控。');
      }
      addRestoreIps(true);
      if (restoreTarget === 'both') addRestoreMain(false);
    } else {
      if (restoreTarget === 'both' || restoreTarget === 'main') addRestoreMain(false);
      if (restoreTarget === 'both' || restoreTarget === 'ips') addRestoreIps(false);
    }
    return {
      scenario,
      track,
      baseline,
      probe,
      blocked: false,
      error: null,
      warnings,
      steps
    };
  }

  // First install or update flow
  if (probe.mode === 'iap') {
    if ((track === 'B' || track === 'C') && probe.pid === TARGETS.ips.pid) {
      const msg = '歌词版 IPS 必须先在正常模式 (0x3075) 核对 1024KiB / 系列 13 硬件参数，当前处于 IAP (0x3078) 已阻止直接写入';
      return {
        scenario,
        track,
        baseline,
        probe,
        blocked: true,
        error: msg,
        warnings,
        steps: [{
          id: 'hardware_guard',
          category: 'guard',
          action: 'blocked',
          title: '需要正常模式芯片探测',
          reason: msg
        }]
      };
    }
  }

  // Track B/C Hardware Guard when silicon info is known
  const isLyricsTrack = track === 'B' || track === 'C';
  if (isLyricsTrack && (probe.flashKiB !== null && probe.flashKiB !== undefined || probe.series !== null && probe.series !== undefined)) {
    const badFlash = probe.flashKiB !== null && probe.flashKiB !== undefined && probe.flashKiB !== 1024;
    const badSeries = probe.series !== null && probe.series !== undefined && probe.series !== 13;
    if (badFlash || badSeries) {
      const msg = `歌词版固件要求屏幕芯片为 1024KiB / 系列 13 (AT32F435)，当前检测到 ${probe.flashKiB ?? '未知'}KiB / 系列 ${probe.series ?? '未知'}，已阻止刷写以防设备变砖`;
      return {
        scenario,
        track,
        baseline,
        probe,
        blocked: true,
        error: msg,
        warnings,
        steps: [{
          id: 'hardware_guard',
          category: 'guard',
          action: 'blocked',
          title: '歌词版硬件核对未通过',
          reason: msg
        }]
      };
    }
  }

  // 1. Main controller step
  const mainIsV71 = probe.mainCap === MAIN_CAP;
  const mainRevision = baseline === '0x47' ? 'V7.2' : 'V7.1';
  const switchedBaseline = Boolean(
    intent.baselineSwitched ||
    (intent.previousBaseline && intent.previousBaseline !== baseline)
  );
  let mainWillRun = false;
  if (mainIsV71 && !intent.forceReflashMain) {
    let reason = '主控已具备 V7.1 (0x4350) 能力，跳过重复刷写';
    if (switchedBaseline) {
      const warn = `注意：已从基线 ${intent.previousBaseline || '旧基线'} 切换到 ${baseline}，但因主控已是 V7.1 默认跳过重刷；如需切换对应原厂基线请勾选强制重刷主控`;
      warnings.push(warn);
      reason += `（${warn}）`;
    }
    steps.push({
      id: 'flash_main',
      category: 'firmware',
      target: 'main',
      pid: TARGETS.main.pid,
      action: 'skip',
      title: `键盘主控固件 (${mainRevision})`,
      reason
    });
  } else {
    mainWillRun = true;
    steps.push({
      id: 'flash_main',
      category: 'firmware',
      target: 'main',
      pid: TARGETS.main.pid,
      alreadyInIap: probe.pid === TARGETS.main.pid,
      action: 'run',
      title: `刷入键盘主控固件 (${mainRevision})`,
      reason: intent.forceReflashMain ? '用户勾选强制重刷主控' : '主控尚未升级至 V7.1 (0x4350)'
    });
  }

  // 2. IPS firmware step(s)
  const ipsBaseEntry = bundle.ipsBase || (!isLyricsTrack ? bundle.ips : null);
  const ipsLyricsEntry = bundle.ipsLyrics || (isLyricsTrack ? bundle.ips : null);
  const wantThemePatch = Boolean(intent.themeColors || intent.themeChanged);
  let ipsWillRun = false;
  let lyricsFirmwareWillChange = false;
  let expectedLyricsFontCrc = getFontBodyCrcFromBundle(bundle, ipsLyricsEntry);

  if (track === 'A') {
    const ipsIsL6 = probe.ipsCap === IPS_CAP && (!intent.baseOnly || !probe.lyrics.supported);
    if (ipsIsL6 && !intent.forceReflashIps && !wantThemePatch) {
      steps.push({
        id: 'flash_ips_base',
        category: 'firmware',
        target: 'ips',
        pid: TARGETS.ips.pid,
        action: 'skip',
        title: '基础版 IPS 固件 (L6)',
        reason: '屏幕已安装本版基础 IPS (0x5536)，跳过重复刷写'
      });
    } else if (wantThemePatch && ipsBaseEntry?.manifest && !ipsBaseEntry.manifest.themeSlot) {
      steps.push({
        id: 'flash_ips_base',
        category: 'firmware',
        target: 'ips',
        pid: TARGETS.ips.pid,
        action: 'needs_reflash',
        title: '重新编译并刷入基础版 IPS（缺少 R75T 主题槽位）',
        reason: '该构建产物不包含 R75T 主题槽位，修改配色需要用 tools/build.py 重新编译 IPS 后刷入'
      });
    } else {
      ipsWillRun = true;
      steps.push({
        id: 'flash_ips_base',
        category: 'firmware',
        target: 'ips',
        pid: TARGETS.ips.pid,
        alreadyInIap: probe.pid === TARGETS.ips.pid,
        action: 'run',
        title: '刷入基础版 IPS 固件 (L6)',
        reason: wantThemePatch ? '应用新主题配色到 IPS 固件' : '需要安装或更新基础版 IPS (L6)'
      });
    }
  } else {
    // Track B / C
    const factoryUnknownIps = probe.ipsCap !== IPS_CAP;
    const bundleFontCrc = expectedLyricsFontCrc;
    if (factoryUnknownIps) {
      // Two-stage flow: L6 base -> probe 1024KiB/series 13 -> lyrics IPS
      ipsWillRun = true;
      lyricsFirmwareWillChange = true;
      steps.push({
        id: 'flash_ips_base',
        category: 'firmware',
        target: 'ips',
        pid: TARGETS.ips.pid,
        action: 'run',
        title: '阶段 1/2：刷入基础版 IPS (L6) 以启用芯片硬件查询',
        reason: '当前屏幕为原厂固件（queryIps(0) 未应答 L6），需先刷入本版 L6 才能只读核对 1024KiB / 系列 13'
      });
      steps.push({
        id: 'probe_lyrics_hardware',
        category: 'guard',
        action: 'run',
        title: '核对屏幕芯片容量与系列 (1024KiB / 13)',
        reason: '重连 APP 后执行 probeLyricsTarget()，确认满足歌词版 Bank2 硬件条件'
      });
      steps.push({
        id: 'flash_ips_lyrics',
        category: 'firmware',
        target: 'ips',
        pid: TARGETS.ips.pid,
        hardwareChecked: false,
        requiresHardwareProbe: true,
        action: 'run',
        title: '阶段 2/2：刷入歌词扩展版 IPS (LY1)',
        reason: '芯片硬件核对通过后写入歌词扩展固件'
      });
    } else {
      const ly = probe.lyrics || {};
      const meetsTrackC = track !== 'C' || (ly.coverSupported && ly.volumeSupported && (ly.layoutCount ?? 0) >= 5);
      const meetsLayout = intent.preferredLayout === undefined ||
        (ly.layout !== null && ly.layout !== undefined && ly.layoutCount > intent.preferredLayout);
      const fontCrcMatches = bundleFontCrc === null || ly.fontCrc === bundleFontCrc;
      const alreadyCompatibleLyrics = Boolean(
        ly.supported &&
        meetsTrackC &&
        meetsLayout &&
        fontCrcMatches &&
        !intent.forceReflashIps &&
        !wantThemePatch
      );

      if (alreadyCompatibleLyrics) {
        steps.push({
          id: 'flash_ips_lyrics',
          category: 'firmware',
          target: 'ips',
          pid: TARGETS.ips.pid,
          hardwareChecked: true,
          action: 'skip',
          title: '歌词扩展版 IPS (LY1)',
          reason: '屏幕已是兼容当前轨道与字库 CRC 的 LY1 固件，跳过重复刷写'
        });
      } else if (wantThemePatch && ipsLyricsEntry?.manifest && !ipsLyricsEntry.manifest.themeSlot) {
        steps.push({
          id: 'flash_ips_lyrics',
          category: 'firmware',
          target: 'ips',
          pid: TARGETS.ips.pid,
          action: 'needs_reflash',
          title: '重新编译并刷入歌词 IPS（缺少 R75T 主题槽位）',
          reason: '该歌词 IPS 构建产物不包含 R75T 主题槽位，修改配色需要重新编译'
        });
      } else {
        ipsWillRun = true;
        lyricsFirmwareWillChange = true;
        if (probe.flashKiB !== 1024 || probe.series !== 13) {
          steps.push({
            id: 'probe_lyrics_hardware', category: 'guard', action: 'run',
            title: '重新核对屏幕芯片容量与系列',
            reason: '上次读取不完整，必须在正常模式确认 1024KiB / 系列 13 后才能刷入歌词版'
          });
        }
        steps.push({
          id: 'flash_ips_lyrics',
          category: 'firmware',
          target: 'ips',
          pid: TARGETS.ips.pid,
          hardwareChecked: probe.flashKiB === 1024 && probe.series === 13,
          action: 'run',
          title: '刷入歌词扩展版 IPS (LY1)',
          reason: !ly.supported
            ? '从基础版 L6 升级到歌词扩展版 LY1'
            : !meetsTrackC
              ? '升级到支持沉浸封面与系统音量的轨道 C 歌词固件'
              : wantThemePatch
                ? '应用新主题配色到歌词版 IPS'
                : '按要求更新或绑定新字库 CRC 的歌词版 IPS'
        });
      }
    }
  }

  // Optional custom keys rebuild notice when keys were edited outside current build
  if (intent.customKeysChanged && !intent.keysIncludedInBuild) {
    steps.push({
      id: 'rebuild_custom_keys',
      category: 'design',
      action: 'needs_reflash',
      title: '自定义大键位图标需重新编译 IPS 固件',
      reason: '大键位点阵编入 IPS 代码段，请导出 keys.json 后通过 tools/build.py 重新构建并刷入'
    });
  }

  // 3. FONT.BIN upload step
  if (!isLyricsTrack || intent.fontEnabled === false) {
    steps.push({
      id: 'upload_font',
      category: 'asset',
      action: 'skip',
      title: '上传歌词点阵字库 FONT.BIN',
      reason: track === 'A' ? '基础屏幕版（Track A）不需要点阵字库' : '用户已关闭字库写入'
    });
  } else {
    const deviceFontCrc = probe.lyrics?.fontCrc ?? probe.fontCrc ?? null;
    const deviceFontReady = probe.lyrics?.fontReady ?? probe.fontReady;
    const targetFontCrc = expectedLyricsFontCrc ?? deviceFontCrc;
    const canSkipFont = Boolean(
      !intent.forceUploadFont &&
      targetFontCrc !== null &&
      deviceFontCrc === targetFontCrc &&
      deviceFontReady === true
    );
    if (canSkipFont) {
      steps.push({
        id: 'upload_font',
        category: 'asset',
        action: 'skip',
        title: '上传歌词点阵字库 FONT.BIN',
        reason: '当前固件已成功打开配套字库，保留现有 FONT.BIN'
      });
    } else {
      const replaceExisting = Boolean(
        intent.fontReplaceExisting ||
        (deviceFontReady === true && deviceFontCrc !== null && targetFontCrc !== null && deviceFontCrc !== targetFontCrc)
      );
      steps.push({
        id: 'upload_font',
        category: 'asset',
        action: 'run',
        replaceExisting,
        title: replaceExisting ? '替换屏内歌词字库 FONT.BIN' : '检查字库，按需安装 FONT.BIN',
        reason: replaceExisting ? '字库绑定已变更，需使用旧字库备份执行替换' : '先等待初始化并检查现有文件，匹配时直接复用'
      });
    }
  }

  // 4. S1 GIF upload step
  const shouldRunGif = Boolean(
    !intent.skipGif &&
    (intent.customGifBytes || wantThemePatch || scenario === 'first')
  );
  if (shouldRunGif) {
    steps.push({
      id: 'upload_gif',
      category: 'asset',
      action: 'run',
      title: '上传主题 / 自定义动画 GIF 到 S1 槽位',
      reason: intent.customGifBytes
        ? '写入定制 GIF 动画到 S1'
        : wantThemePatch
          ? '主题配色已变化，同步更新配套 S1 GIF（确保边框与 (22,39) 标记一致）'
          : '首次安装写入配套主题 GIF 到 S1'
    });
  } else {
    steps.push({
      id: 'upload_gif',
      category: 'asset',
      action: 'skip',
      title: '上传 S1 槽位动画 GIF',
      reason: '未修改主题或动画，保留当前 S1 槽位素材'
    });
  }

  if (isLyricsTrack && intent.fontEnabled !== false) {
    steps.push({ id: 'verify_font', category: 'guard', action: 'run', expectedBodyCrc: expectedLyricsFontCrc,
      title: '核对字库可用状态', reason: '素材处理完成后重新打开字库，确认屏幕可正常使用' });
  }

  // 5. RTC calibration step
  const skipCalibrate = Boolean(
    scenario === 'update' &&
    probe.clockValid === true &&
    !mainWillRun &&
    intent.skipCalibrate
  );
  if (skipCalibrate) {
    steps.push({
      id: 'calibrate',
      category: 'rtc',
      action: 'skip',
      title: 'RTC 校时与读回核对',
      reason: '主控未重刷且当前 RTC 校时有效，按更新选项跳过'
    });
  } else {
    steps.push({
      id: 'calibrate',
      category: 'rtc',
      action: 'run',
      title: '写入电脑当前时间并核对主控与屏幕读回',
      reason: probe.clockValid === false
        ? '检测到主控校时标记无效 (queryMain(8) == 0)，需要重新校时'
        : mainWillRun
          ? '重刷主控后执行安全校时与读回验证'
          : '首次部署执行安全校时与双端核对'
    });
  }

  // 6. Honest WOB S1 reminder
  if (probe.uiActive !== true || ipsWillRun) {
    steps.push({
      id: 'manual_wob_s1_check',
      category: 'manual',
      action: 'manual',
      title: '手动确认原厂驱动屏幕处于「GIF 播放 · S1 槽位」',
      reason: probe.uiActive === true
        ? '已刷新 IPS 固件，请目视或到原厂驱动确认 S1 动画已激活（工具不会伪造自动切槽）'
        : '未能通过 queryIps(7) 确认 S1 缓存画面处于激活状态；工作台无法自动代点原厂驱动，请手动确认设为 GIF 播放 S1'
    });
  } else {
    steps.push({
      id: 'manual_wob_s1_check',
      category: 'manual',
      action: 'skip',
      title: '原厂 S1 状态检查',
      reason: '已通过 queryIps(7) 验证 S1 缓存画面处于激活状态'
    });
  }

  const rebuild = steps.find(step => step.action === 'needs_reflash');
  return {
    scenario,
    track,
    baseline,
    probe,
    blocked: Boolean(rebuild),
    error: rebuild?.reason || null,
    warnings,
    steps
  };
}

function buildRecoveryHint(step, error) {
  const msg = error?.message || '';
  if (error?.code === 'IPS_NOT_READY') {
    return '保持 USB 有线连接，关闭 WOBHub 和歌词后台，等小屏亮起后点「再试这一步」。';
  }
  if (step?.id === 'flash_main' || step?.id === 'flash_restore_main' || step?.target === 'main') {
    return '主控刷写中断时键盘可能停留在 IAP (0x3079)，请勿断开供电，重新选择 0x3079 恢复或参照 docs/recovery.md 处理。';
  }
  if (step?.id === 'flash_ips_base' || step?.id === 'flash_ips_lyrics' || step?.id === 'flash_restore_ips' || step?.target === 'ips') {
    if (msg.includes('1024') || msg.includes('AT32F435') || msg.includes('芯片')) {
      return '芯片硬件规格不满足歌词版要求，请停留在基础版 (Track A) 或恢复出厂 IPS。';
    }
    return '屏幕刷写中断时设备可能停留在 IAP (0x3078)，请重新授权 0x3078 恢复或参照 docs/recovery.md 处理。';
  }
  if (step?.id === 'upload_font' || step?.id === 'verify_font') {
    return '先停止其他歌词后台与驱动，再重新检查字库。已有文件会保留；不要为此重刷屏幕或直接重复上传。';
  }
  if (step?.id === 'upload_gif') {
    return '请检查 GIF 是否满足 320×172、<=4MiB、完整不透明帧且 disposal=1。';
  }
  return '请保持 USB 有线连接并关闭 WOB 官方驱动/歌词后台后重试当前步骤，或点击中止。';
}

/**
 * Single-flight WebHID deployment and recovery state machine.
 */
export class DeploymentRunner {
  constructor({
    plan,
    bundle = {},
    intent = {},
    hid,
    appClient = null,
    onProgress = () => {},
    onStateChange = () => {},
    pause = wait,
    now = Date.now
  }) {
    if (!plan || !Array.isArray(plan.steps)) {
      throw new Error('无效的部署计划');
    }
    this.plan = plan;
    this.bundle = bundle;
    this.intent = intent;
    this.hid = getDefaultHid(hid);
    this.appClient = appClient;
    this.onProgress = onProgress;
    this.onStateChange = onStateChange;
    this.pause = pause;
    this.now = now;

    this.status = 'idle';
    this.stepIndex = 0;
    this.iapNeeded = null;
    this.error = null;
    this.diagnostic = null;
    this.manualReminders = [];
    this.hardwareVerified = Boolean(
      plan.probe?.ipsCap === IPS_CAP &&
      plan.probe?.flashKiB === 1024 &&
      plan.probe?.series === 13
    );

    this._busy = false;
    this._preflightPassed = false;
    this._screenBootPending = null;
    this._pendingFirmwarePlan = null;
    this._enteredIapForStepId = null;
    this._flashClient = null;
  }

  _emit(phase, percent, message, extra = {}) {
    const payload = {
      status: this.status,
      phase,
      stepIndex: this.stepIndex,
      totalSteps: this.plan.steps.length,
      percent: Math.max(0, Math.min(100, Math.round(percent))),
      message,
      iapNeeded: this.iapNeeded,
      error: this.error,
      diagnostic: this.diagnostic,
      manualReminders: this.manualReminders.slice(),
      hardwareVerified: this.hardwareVerified,
      ...extra
    };
    this.onProgress(payload);
    this.onStateChange(this.snapshot());
    return payload;
  }

  snapshot() {
    return {
      status: this.status,
      stepIndex: this.stepIndex,
      totalSteps: this.plan.steps.length,
      iapNeeded: this.iapNeeded,
      error: this.error,
      diagnostic: this.diagnostic,
      manualReminders: this.manualReminders.slice(),
      hardwareVerified: this.hardwareVerified
    };
  }

  _fail(step, err) {
    if (this.status === 'aborted') return;
    if (err?.code === 'APP_AUTH_REQUIRED') {
      this.status = 'awaiting_app_auth';
      this._busy = false;
      this.iapNeeded = { target: 'app', pid: APP_PID };
      this._emit('awaiting_app_auth', this.stepIndex / Math.max(1, this.plan.steps.length) * 100,
        '键盘正在重新连接。请确认 USB 有线模式，再点击连接正常模式键盘继续。');
      return;
    }
    this.status = 'failed';
    this._busy = false;
    this.iapNeeded = null;
    this.error = err?.message || String(err);
    this.diagnostic = {
      stepId: step?.id || 'unknown',
      message: this.error,
      recoveryHint: buildRecoveryHint(step, err)
    };
    this._emit('failed', (this.stepIndex / Math.max(1, this.plan.steps.length)) * 100, this.error);
  }

  async _openHidDevice(expectedPid, { allowRequest = true, allowExisting = true } = {}) {
    if (!this.hid) {
      throw new Error('缺少 WebHID 适配器');
    }
    const len = expectedPid === APP_PID ? 256 : 64;
    if (allowExisting && typeof this.hid.getDevices === 'function') {
      const existing = await this.hid.getDevices();
      const match = (existing || []).find(d => validDevice(d, expectedPid, len));
      if (match) {
        assertValidHidDevice(match, expectedPid);
        if (!match.opened && typeof match.open === 'function') await match.open();
        return match;
      }
    }
    if (!allowRequest) return null;
    if (typeof this.hid.requestDevice !== 'function') {
      throw new Error('HID 适配器不支持 requestDevice');
    }
    const picked = await this.hid.requestDevice({
      filters: [{ vendorId: VID, productId: expectedPid, usagePage: 0xff60, usage: 0x61 }]
    });
    const device = picked && picked[0];
    if (!device) throw Object.assign(new Error('未选择设备，可再次点击连接继续'), { code: 'DEVICE_NOT_SELECTED' });
    assertValidHidDevice(device, expectedPid);
    if (!device.opened && typeof device.open === 'function') await device.open();
    return device;
  }

  async _ensureAppClient() {
    if (this.appClient) return this.appClient;
    let device = await this._openHidDevice(APP_PID, { allowRequest: false }).catch(() => null);
    if (!device) {
      for (let i = 0; i < 15 && !device; i++) {
        await this.pause(200);
        device = await this._openHidDevice(APP_PID, { allowRequest: false }).catch(() => null);
      }
    }
    if (!device) {
      throw Object.assign(new Error('需要点击连接正常模式键盘'), { code: 'APP_AUTH_REQUIRED' });
    }
    const io = new HidIO(device, 256);
    this.appClient = new AppClient(io, { pause: this.pause, now: this.now });
    return this.appClient;
  }

  async _closeAppClient() {
    if (this.appClient) {
      await this.appClient.close().catch(() => {});
      this.appClient = null;
    }
  }

  async _waitForScreenBoot(percent) {
    this._emit('screen_boot', percent, '屏幕固件已写入并校验，正在等待屏幕重启。');
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      const app = await this._ensureAppClient();
      try {
        await app.requireScreen();
        const pet = this._screenBootPending.petIdentity;
        if (pet && await app.queryIps(13) !== pet) throw new Error('屏幕未返回匹配的 Bongo Cat 固件标识');
        this._screenBootPending = null;
        return;
      } catch (error) {
        lastError = error;
        await this._closeAppClient();
        if (attempt < 2) await this.pause(500);
      }
    }
    throw Object.assign(new Error('屏幕固件已校验，但重启后屏幕暂未应答。等小屏亮起后点「再试这一步」。',
      { cause: lastError }), { code: 'IPS_NOT_READY' });
  }

  async _prepareFirmwarePlan(step) {
    let rawEntry;
    if (step.id === 'flash_restore_main') {
      rawEntry = this.bundle.restoreMain || this.bundle.main;
    } else if (step.id === 'flash_restore_ips') {
      rawEntry = this.bundle.restoreIps || this.bundle.ipsBase || this.bundle.ips;
    } else if (step.id === 'flash_main') {
      rawEntry = this.bundle.main;
    } else if (step.id === 'flash_ips_base') {
      rawEntry = this.bundle.ipsBase || this.bundle.ips;
    } else if (step.id === 'flash_ips_lyrics') {
      rawEntry = this.bundle.ipsLyrics || this.bundle.ips;
    } else if (step.id === 'flash_ips_bongo') {
      rawEntry = this.bundle.ipsBongo;
    }
    resolveBundleEntry(rawEntry, step.title);
    let bytes = rawEntry.bytes;
    let manifest = rawEntry.manifest;

    if (
      step.target === 'ips' &&
      this.intent.themeColors &&
      this.plan.scenario !== 'restore' &&
      manifest?.themeSlot
    ) {
      const patched = await patchIpsTheme(bytes, manifest, this.intent.themeColors);
      bytes = patched.bytes;
      manifest = patched.manifest;
    }

    const flashPlan = await validateBuild(bytes, manifest);
    if (flashPlan.target !== step.target || flashPlan.pid !== step.pid) {
      throw new Error('固件与本步骤目标芯片不匹配，未擦除');
    }
    if (['lyrics-v1', 'bongo-v1'].includes(flashPlan.variant)) {
      if (!this.hardwareVerified && !step.hardwareChecked) {
        throw new Error('请先在正常模式核对 1024KiB / 系列 13 芯片，再烧录扩展版 IPS');
      }
      flashPlan.hardwareChecked = true;
    }
    return flashPlan;
  }

  async _preflight() {
    // Validate the entire payload before putting either chip into upgrade mode.
    for (const step of this.plan.steps.filter(s => s.action === 'run')) {
      if (step.category === 'firmware') {
        const key = { flash_main: 'main', flash_ips_base: 'ipsBase', flash_ips_lyrics: 'ipsLyrics',
          flash_ips_bongo: 'ipsBongo', flash_restore_main: 'restoreMain', flash_restore_ips: 'restoreIps' }[step.id];
        const entry = this.bundle[key] || (step.target === 'ips' ? this.bundle.ips : null);
        if (!entry) throw new Error(`缺少${step.title}，未进入升级模式`);
        if (step.target === 'main') {
          const stock = MAIN_BASELINES[this.plan.baseline];
          const supplied = entry.manifest?.stockSha256;
          if ((supplied || this.intent.requireKnownMain) && (!stock || supplied !== stock.stockSha256)) {
            throw new Error('主控镜像与识别到的出厂版本不匹配，未进入升级模式');
          }
        }
        const build = await validateBuild(entry.bytes, entry.manifest);
        if (build.target !== step.target || build.pid !== step.pid) throw new Error('固件与目标芯片不匹配，未擦除');
        if (step.id === 'flash_ips_bongo' && build.variant !== 'bongo-v1') throw new Error('白猫固件类型不匹配，未擦除');
      } else if (step.id === 'upload_font') {
        if (!(this.bundle.font instanceof Uint8Array)) throw new Error('缺少 FONT.BIN，未进入升级模式');
        validateFont(this.bundle.font);
        if (step.replaceExisting && !(this.bundle.previousFont || this.intent.previousFontBytes)) {
          throw new Error('替换字库需要提供当前屏内对应的旧 FONT.BIN，未进入升级模式');
        }
      } else if (step.id === 'upload_gif') {
        const bytes = this.intent.customGifBytes || this.bundle.gif;
        validateGif(bytes);
        if (this.plan.track !== 'A') auditDeviceGif(bytes, this.intent.themeColors || undefined);
      }
    }
  }

  async _runLoop() {
    const total = this.plan.steps.length;
    while (this.stepIndex < total) {
      if (this.status === 'aborted') return this.snapshot();
      const step = this.plan.steps[this.stepIndex];
      const basePct = (this.stepIndex / Math.max(1, total)) * 100;
      if (this._screenBootPending) await this._waitForScreenBoot(basePct);

      if (step.action === 'blocked' || step.action === 'needs_reflash') {
        throw new Error(step.reason || step.title);
      }
      if (step.action === 'skip') {
        this._emit('skip', basePct, `跳过：${step.title}`);
        this.stepIndex++;
        continue;
      }
      if (step.action === 'manual') {
        if (step.id === 'manual_wob_s1_check' && this.intent.verifyS1) {
          const app = await this._ensureAppClient();
          let active = await safeQuery(() => app.queryIps(7));
          for (let attempt = 0; active === 0 && attempt < 4; attempt++) {
            await this.pause(250);
            active = await safeQuery(() => app.queryIps(7));
          }
          if (active === 1) {
            this.stepIndex++;
            continue;
          }
        }
        this.manualReminders.push({ id: step.id, title: step.title, reason: step.reason });
        this._emit('manual_reminder', basePct, step.reason);
        this.stepIndex++;
        continue;
      }

      this._emit('step_start', basePct, `执行：${step.title}`);

      if (step.category === 'firmware') {
        const flashPlan = await this._prepareFirmwarePlan(step);
        this._pendingFirmwarePlan = flashPlan;

        if (!step.alreadyInIap && this._enteredIapForStepId !== step.id) {
          const app = await this._ensureAppClient();
          if (['lyrics-v1', 'bongo-v1'].includes(flashPlan.variant) && !this.hardwareVerified) {
            await app.probeLyricsTarget();
            this.hardwareVerified = true;
            flashPlan.hardwareChecked = true;
          }
          await app.enterIap(step.target);
          this.appClient = null;
          this._enteredIapForStepId = step.id;

          this.status = 'awaiting_iap_auth';
          this.iapNeeded = { target: step.target, pid: step.pid };
          this._busy = false;
          return this._emit(
            'awaiting_iap_auth',
            basePct,
            `设备已切入 ${step.target === 'main' ? '主控' : '屏幕'} IAP (0x${step.pid.toString(16)})，请点击授权升级设备继续`
          );
        }

        // Already in IAP (e.g. restore from 0x3078 / 0x3079 or retry after IAP enter)
        let iapDevice = null;
        if (this.plan.probe?.device && validDevice(this.plan.probe.device, step.pid, 64)) {
          iapDevice = this.plan.probe.device;
          if (!iapDevice.opened && typeof iapDevice.open === 'function') await iapDevice.open();
        } else {
          iapDevice = await this._openHidDevice(step.pid, { allowRequest: false }).catch(() => null);
        }
        if (!iapDevice) {
          this.status = 'awaiting_iap_auth';
          this.iapNeeded = { target: step.target, pid: step.pid };
          this._busy = false;
          return this._emit(
            'awaiting_iap_auth',
            basePct,
            `请选择处于 IAP 模式 (0x${step.pid.toString(16)}) 的设备以继续写入`
          );
        }
        await this._executeFlashWithDevice(step, flashPlan, iapDevice);
        this._enteredIapForStepId = null;
        this._pendingFirmwarePlan = null;
        this.stepIndex++;
        continue;
      }

      if (step.id === 'probe_lyrics_hardware') {
        const app = await this._ensureAppClient();
        const hw = await app.probeLyricsTarget();
        this.hardwareVerified = hw.flashKiB === 1024 && hw.series === 13;
        const nextLyricsStep = this.plan.steps.find(s => s.id === 'flash_ips_lyrics');
        if (nextLyricsStep) nextLyricsStep.hardwareChecked = this.hardwareVerified;
        this._emit('probe_ok', ((this.stepIndex + 1) / Math.max(1, total)) * 100, `芯片核对通过：${hw.flashKiB}KiB / 系列 ${hw.series}`);
        this.stepIndex++;
        continue;
      }

      if (step.id === 'upload_font') {
        const fontBytes = this.bundle.font;
        if (!(fontBytes instanceof Uint8Array)) {
          throw new Error('缺少 FONT.BIN 文件');
        }
        const localFont = validateFont(fontBytes);
        const prev = this.bundle.previousFont || this.intent.previousFontBytes;
        const app = await this._ensureAppClient();
        const current = await app.inspectFont();
        if (current.expectedBodyCrc !== localFont.bodyCrc) throw new Error('当前屏幕固件绑定的字库与安装文件不同，未写入');
        if (current.ready && !this.intent.forceUploadFont) {
          step.action = 'skip'; step.reason = '重新核对通过，已复用现有字库';
          this._emit('font_reused', basePct, '已复用现有字库，无需重新上传');
          this.stepIndex++; continue;
        }
        if (!current.settled) throw new Error('字库仍在初始化，未开始上传。请确认屏幕正在播放 GIF / 槽位 1，再重新检查');
        const files = await app.listFiles();
        if (files.some(file => file.name.toUpperCase() === 'FONT.BIN') && !(step.replaceExisting && prev)) {
          throw new Error('检测到已有 FONT.BIN，已停止重复上传。若初始化失败，请核对字库版本；更换时需提供对应的旧字库备份');
        }
        await app.uploadFont(fontBytes, {
          replaceConfirmed: true,
          replaceExisting: Boolean(step.replaceExisting && prev),
          previousFont: step.replaceExisting ? prev : undefined,
          progress: p => this._emit('upload_font', basePct + (p * 100) / total, `上传 FONT.BIN ${Math.round(p * 100)}%`)
        });
        this.stepIndex++;
        continue;
      }

      if (step.id === 'verify_font') {
        const app = await this._ensureAppClient();
        const current = await app.inspectFont();
        if (!current.ready || step.expectedBodyCrc !== null && step.expectedBodyCrc !== undefined && current.expectedBodyCrc !== step.expectedBodyCrc) {
          throw new Error('字库尚未通过初始化。请保持 USB 有线、停止其他后台，并确认屏幕为 GIF / 槽位 1 后重试此项检查');
        }
        this._emit('font_ready', basePct, '字库已就绪');
        this.stepIndex++; continue;
      }

      if (step.id === 'upload_gif') {
        const gifBytes = this.intent.customGifBytes || this.bundle.gif;
        if (!(gifBytes instanceof Uint8Array)) {
          throw new Error('缺少待上传的 320×172 GIF 文件');
        }
        validateGif(gifBytes);
        if (this.plan.track === 'B' || this.plan.track === 'C') {
          const theme = this.intent.themeColors ? normalizeTheme(this.intent.themeColors) : undefined;
          auditDeviceGif(gifBytes, theme);
        }
        const app = await this._ensureAppClient();
        await app.upload(gifBytes, {
          replaceConfirmed: true,
          progress: p => this._emit('upload_gif', basePct + (p * 100) / total, `上传 S1 GIF ${Math.round(p * 100)}%`)
        });
        this.stepIndex++;
        continue;
      }

      if (step.id === 'calibrate') {
        const app = await this._ensureAppClient();
        await app.calibrate({ timeZone: this.intent.timeZone });
        this.stepIndex++;
        continue;
      }

      throw new Error(`未知部署步骤：${step.id}`);
    }

    this.status = 'completed';
    this.iapNeeded = null;
    this._busy = false;
    await this._closeAppClient();
    return this._emit('completed', 100, '部署与核对全部完成');
  }

  async _executeFlashWithDevice(step, flashPlan, device) {
    const total = this.plan.steps.length;
    const basePct = (this.stepIndex / Math.max(1, total)) * 100;
    const io = new HidIO(device, 64);
    const flasher = new FlashClient(io, flashPlan, { pause: this.pause });
    this._flashClient = flasher;
    try {
      await flasher.flash((phase, p) => {
        this._emit(
          `flash:${phase}`,
          basePct + ((p * 100) / total),
          `${step.title} · ${phase} ${Math.round(p * 100)}%`
        );
      });
      this._screenBootPending = ['flash_ips_base', 'flash_ips_lyrics', 'flash_ips_bongo'].includes(step.id)
        ? { petIdentity: step.petIdentity }
        : null;
    } finally {
      this._flashClient = null;
      await io.close().catch(() => {});
    }
  }

  /**
   * Start or resume the deployment sequence (enforces single-flight lock).
   */
  async start() {
    if (this._busy || this.status === 'running' || this.status === 'awaiting_iap_auth' || this.status === 'awaiting_app_auth') {
      throw new Error('部署任务正在进行中，请勿重复点击');
    }
    if (this.status === 'completed') {
      throw new Error('当前部署已完成，如需再次执行请重新规划');
    }
    if (this.status === 'aborted') {
      throw new Error('部署已中止，请重新规划后再启动');
    }
    if (this.plan.blocked) {
      const err = new Error(this.plan.error || '部署条件未满足，已阻止执行');
      this._fail(this.plan.steps[0], err);
      throw err;
    }

    this._busy = true;
    this.status = 'running';
    this.error = null;
    this.diagnostic = null;
    try {
      await this._preflight();
      this._preflightPassed = true;
      return await this._runLoop();
    } catch (err) {
      this._fail(this.plan.steps[this.stepIndex], err);
      if (err?.code === 'APP_AUTH_REQUIRED') return this.snapshot();
      throw err;
    }
  }

  /**
   * Request/connect the expected IAP WebHID device and continue flashing.
   */
  async authorizeIapAndContinue({ allowExisting = false } = {}) {
    if (this._busy) {
      throw new Error('当前正在执行操作，请勿重复触发');
    }
    if (!['awaiting_iap_auth', 'awaiting_app_auth'].includes(this.status) || !this.iapNeeded) {
      throw new Error('当前未处于等待 IAP 授权状态');
    }
    const step = this.plan.steps[this.stepIndex];
    const expectedPid = this.iapNeeded.pid;
    this._busy = true;
    this.status = 'running';
    this.error = null;
    this.diagnostic = null;

    try {
      if (expectedPid === APP_PID) {
        const device = await this._openHidDevice(APP_PID, { allowRequest: true, allowExisting: false });
        this.appClient = new AppClient(new HidIO(device, 256), { pause: this.pause, now: this.now });
        this.iapNeeded = null;
        return await this._runLoop();
      }
      const flashPlan = this._pendingFirmwarePlan || await this._prepareFirmwarePlan(step);
      const device = await this._openHidDevice(expectedPid, { allowRequest: true, allowExisting });
      this.iapNeeded = null;
      await this._executeFlashWithDevice(step, flashPlan, device);
      this._pendingFirmwarePlan = null;
      this._enteredIapForStepId = null;
      this.stepIndex++;
      // Wait briefly for MCU reboot back into APP if further steps exist
      if (this.stepIndex < this.plan.steps.length) {
        await this.pause(200);
      }
      return await this._runLoop();
    } catch (err) {
      if (err?.code === 'DEVICE_NOT_SELECTED' || err?.name === 'NotFoundError') {
        this.status = expectedPid === APP_PID ? 'awaiting_app_auth' : 'awaiting_iap_auth';
        this._busy = false;
        this.iapNeeded = { target: expectedPid === APP_PID ? 'app' : step.target, pid: expectedPid };
        return this._emit(this.status, this.stepIndex / Math.max(1, this.plan.steps.length) * 100, '未选择设备，点击连接可以继续。');
      }
      this._fail(this.plan.steps[this.stepIndex] || step, err);
      if (err?.code === 'APP_AUTH_REQUIRED') return this.snapshot();
      throw err;
    }
  }

  /**
   * Explicitly retry the failed step (never runs automatically).
   */
  async retryCurrentStep() {
    if (this._busy) {
      throw new Error('部署正在进行中');
    }
    if (this.status !== 'failed') {
      throw new Error('当前不处于失败状态，无需重试');
    }
    if (!this._preflightPassed) return this.start();
    const step = this.plan.steps[this.stepIndex];
    if (!step) {
      throw new Error('没有可重试的步骤');
    }

    this.error = null;
    this.diagnostic = null;
    if (step.category === 'firmware' && this._enteredIapForStepId === step.id) {
      this.status = 'awaiting_iap_auth';
      this.iapNeeded = { target: step.target, pid: step.pid };
      this._emit('awaiting_iap_auth', (this.stepIndex / Math.max(1, this.plan.steps.length)) * 100, `请重新授权 0x${step.pid.toString(16)} 重试烧录`);
      return this.authorizeIapAndContinue();
    }

    this._busy = true;
    this.status = 'running';
    try {
      return await this._runLoop();
    } catch (err) {
      this._fail(this.plan.steps[this.stepIndex] || step, err);
      if (err?.code === 'APP_AUTH_REQUIRED') return this.snapshot();
      throw err;
    }
  }

  /**
   * Abort the deployment cleanly and close any active HID handle.
   */
  async abort() {
    if (this._busy) throw new Error('正在写入或校验，请等待当前操作结束后再停止');
    this.status = 'aborted';
    this._busy = false;
    this.iapNeeded = null;
    this._pendingFirmwarePlan = null;
    await this._closeAppClient();
    if (this._flashClient?.io) {
      await this._flashClient.io.close().catch(() => {});
      this._flashClient = null;
    }
    return this._emit('aborted', (this.stepIndex / Math.max(1, this.plan.steps.length)) * 100, '部署已手动中止');
  }
}
