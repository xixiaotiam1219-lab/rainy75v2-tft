// SPDX-License-Identifier: MIT
import {
  APP_PID,
  MAIN_CAP,
  IPS_CAP,
  TARGETS,
  sha256,
  validateBuild,
  validateGif
} from './protocol.mjs';
import { HidIO, AppClient, validDevice } from './hid.mjs';
import { validateFont } from './font.mjs';
import {
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  PRESET_THEMES,
  DEFAULT_KEYS_PROFILE,
  normalizeHex,
  hexToRgb,
  rgbToHex,
  normalizeTheme,
  resolveManifestTheme,
  rgb565,
  rgb565FromRgb,
  rgb565ToRgb,
  rgb565ToHex,
  auditThemeContrast,
  generateHarmonicTheme,
  extractPaletteFromRgba,
  patchIpsTheme,
  validateKeysProfile,
  renderBaseFrame565,
  drawPreviewToCanvas,
  exportDesignProfile,
  importDesignProfile
} from './theme-engine.mjs';
import {
  decodeGif,
  rgbaToStaticGifSource,
  composePetGifFrames,
  encodeGif320x172,
  auditDeviceGif
} from './gif-studio.mjs';
import {
  MAIN_BASELINES,
  probeDevice,
  planDeployment,
  DeploymentRunner
} from './deploy-wizard.mjs';

const CHANNEL_META = [
  { key: 'background', label: '屏幕底色 (background)' },
  { key: 'panel', label: '键帽/卡片底色 (panel)' },
  { key: 'shell', label: '外框/分割线 (shell)' },
  { key: 'ink', label: '主文字与图标 (ink)' },
  { key: 'accent', label: '强调色与进度条 (accent)' },
  { key: 'muted', label: '次句弱化文字 (muted)' },
  { key: 'lyricsBorder', label: '歌词卡边框 (lyricsBorder)' },
  { key: 'lyricsPanel', label: '歌词卡底色 (lyricsPanel)' }
];

const TRACK_DETAILS = {
  A: {
    name: 'A · 基础屏幕版（免后台）',
    chip: '基础屏幕版 · 极简省心',
    summary: [
      '只在键盘上显示大按键回显、实时时钟、电量、连接图标与可爱的像素桌宠 GIF。',
      '日常使用完全不依赖电脑软件，也不用占空间安装中文字库。',
      '可自由定制 8 色主题（写入时向导会自动更新基础版屏幕）与专属桌宠 GIF。'
    ]
  },
  B: {
    name: 'B · 传统歌词播放器（三模共存）',
    chip: '三模共存 · 默认经典顶栏',
    summary: [
      '装入完整歌词扩展固件：键盘内同时保存基础桌宠页 + 4套经典顶栏歌词 + 全屏沉浸页，按 Ctrl+F8 随时循环切换！',
      '默认停留在保留顶部时间与电量的经典双行/大字歌词模式。',
      '安装前会自动核对大存储屏幕型号，日常听歌通过 USB 有线 + 电脑小助手同步。'
    ]
  },
  C: {
    name: 'C · 沉浸播放器与音量增强（三模共存）',
    chip: '三模共存 · 默认沉浸 + 音量弹窗',
    summary: [
      '同样具备三模共存能力！用 Ctrl+F8 随时切换「基础桌宠 ⇄ 经典歌词 ⇄ 布局4 全屏沉浸」。',
      '主推隐藏顶部状态栏、封面雾化背景与居中大歌词（20/30/40px），调音量时屏幕会自动弹出清晰音量提示条。',
      '仅需保持 USB 有线连接电脑并开启第 5 页电脑小助手即可使用。'
    ]
  }
};

const HERO_SLIDES = [
  { id: 'keys', label: '预览 1 / 7 · 基础按键与动态像素桌宠', note: '显示最近按下的大键、时钟电量，右边桌宠动图会一直播放动画' },
  { id: 'layout0', label: '预览 2 / 7 · 经典布局 0（原版双行歌词）', note: '按 Ctrl+F8 进入歌词页：顶栏保留时间/电量，中间展示卡片式双行歌词' },
  { id: 'layout1', label: '预览 3 / 7 · 经典布局 1（04 大字字幕）', note: '20px 歌名与 40px 当前句，共用一份屏内字库' },
  { id: 'layout2', label: '预览 4 / 7 · 经典布局 2（大字聚焦）', note: '再按 Ctrl+F8：当前句加粗放大高亮，下一句柔和弱化预告' },
  { id: 'layout3', label: '预览 5 / 7 · 经典布局 3（双行大字）', note: '再按 Ctrl+F8：带顶部歌名栏与极细进度条的双行高密度大字' },
  { id: 'layout4', label: '预览 6 / 7 · 全屏沉浸（封面雾面背景）', note: '再按 Ctrl+F8：藏起顶栏，提取专辑封面色彩做雾面背景与超大居中歌词' },
  { id: 'volume', label: '预览 7 / 7 · 沉浸模式 + 系统音量弹窗示意', note: '平时微调 Windows 音量时自动浮现，停留 1 秒后淡出（此项为音量效果预览，不占用切页位置）' }
];

const VIEW_LABELS = {
  keys: '按键与桌宠页',
  layout0: '布局0 · 原版双行',
  layout1: '布局1 · 04大字字幕',
  layout2: '布局2 · 大字聚焦',
  layout3: '布局3 · 双行大字',
  layout4: '布局4 · 沉浸封面'
};

const $ = id => document.getElementById(id);

const state = {
  activeTab: 'overview',
  track: 'A',
  scenario: 'first',
  baseline: '0x40',
  previousBaseline: null,
  restoreTarget: 'both',
  releaseBundle: null,
  decompressedCache: new Map(),
  manualBundle: {
    main: null,
    ipsBase: null,
    ipsLyrics: null,
    restoreMain: null,
    restoreIps: null,
    font: null,
    previousFont: null
  },
  presetsThemes: { ...PRESET_THEMES },
  defaultKeysProfile: JSON.parse(JSON.stringify(DEFAULT_KEYS_PROFILE)),
  keysProfile: JSON.parse(JSON.stringify(DEFAULT_KEYS_PROFILE)),
  customKeysChanged: false,
  themePresetId: 'pink',
  themeModified: false,
  theme: normalizeTheme(PRESET_THEMES.pink),
  wheel: {
    h: 332,
    s: 0.34,
    v: 0.92,
    seedHex: '#d58eae',
    tone: 'soft'
  },
  preview: {
    view: 'keys',
    useGifBg: true,
    key: 227,
    title: 'Rainy75 Pixel Radio',
    current: 'Pixels move with the beat',
    next: 'Next line preview',
    progressPct: 38,
    textSize: 30,
    textStyle: 'crisp',
    coverActive: true,
    coverTint: '#3c5a7a',
    volumeVisible: false,
    volumeEnabled: true,
    volumeStyle: 0,
    volumeScope: 0,
    volumeLevel: 72,
    volumeMuted: false,
    volumeHoldMs: 1000
  },
  gif: {
    source: null,
    sourceLabel: '内置原创像素机器人 (樱花粉)',
    composedFrames: [],
    encodedBytes: null,
    auditResult: null,
    auditError: null,
    useForDeploy: false,
    frameIdx: 0,
    playing: true,
    loop: true,
    eyedropper: false,
    placementPreset: 'pet-right',
    fit: 'contain',
    scale: 1.0,
    offsetX: 0,
    offsetY: 0,
    bgMode: 'theme',
    customBg: '#fff1f6',
    overlayBezel: true,
    speed: 1.0,
    maxFrames: 60,
    chromaEnabled: false,
    chromaKeyColor: '#00ff00',
    chromaKeyTolerance: 32,
    bgBlur: false,
    flipX: false,
    enableAlpha: true
  },
  probeResult: null,
  activeClient: null,
  activeDevice: null,
  currentPlan: null,
  runner: null,
  operation: null,
  bgStatus: null,
  bgApiAvailable: false
};

let gifTimerId = null;
let gifEncodeTimerId = null;
let heroSlideIdx = 0;
let heroAutoplay = false;
let heroAutoplayTimer = null;
let overviewKeysPhase = 0;
let overviewKeysTimer = null;
let cardADemoTheme = 'pink';
let cardADemoKey = 227;
let cardCVolDemoOn = false;
let wheelCacheValue = -1;
let wheelImageData = null;

function renderOverviewKeysCanvases() {
  const now = new Date();
  const timeText = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  const bgFrame = state.gif.composedFrames.length > 0 && state.gif.useForDeploy
    ? state.gif.composedFrames[overviewKeysPhase % state.gif.composedFrames.length].rgba
    : null;

  const heroCanvas = $('hero-keys-canvas');
  if (heroCanvas) {
    const heroTheme = state.theme || PRESET_THEMES.pink;
    drawPreviewToCanvas(heroCanvas, {
      view: 'keys',
      theme: heroTheme,
      keysProfile: state.keysProfile,
      key: state.preview.key || 227,
      timeText,
      battery: 84,
      mode: 1,
      phase: overviewKeysPhase % 8
    }, bgFrame);
  }

  const canvasA = $('card-preview-A');
  if (canvasA) {
    const demoTheme = cardADemoTheme === 'custom'
      ? (state.theme || PRESET_THEMES.pink)
      : (state.presetsThemes[cardADemoTheme] || PRESET_THEMES[cardADemoTheme] || PRESET_THEMES.pink);
    drawPreviewToCanvas(canvasA, {
      view: 'keys',
      theme: demoTheme,
      keysProfile: state.keysProfile,
      key: cardADemoKey,
      timeText,
      battery: 84,
      mode: 1,
      phase: overviewKeysPhase % 8
    }, cardADemoTheme === 'custom' ? bgFrame : null);
  }
}

function startOverviewKeysAnimation() {
  clearInterval(overviewKeysTimer);
  renderOverviewKeysCanvases();
  overviewKeysTimer = setInterval(() => {
    if (state.activeTab !== 'overview') return;
    overviewKeysPhase = (overviewKeysPhase + 1) & 1023;
    renderOverviewKeysCanvases();
  }, 140);
}

function setHeroSlide(slideId, { restartTimer = false } = {}) {
  const idx = HERO_SLIDES.findIndex(s => s.id === slideId);
  if (idx >= 0) heroSlideIdx = idx;
  const slide = HERO_SLIDES[heroSlideIdx] || HERO_SLIDES[0];

  for (const img of document.querySelectorAll('#hero-ctrlf8-stage .stage-img')) {
    img.classList.toggle('active', img.dataset.slide === slide.id);
  }
  for (const dot of document.querySelectorAll('[data-hero-slide]')) {
    dot.classList.toggle('active', dot.dataset.heroSlide === slide.id);
  }
  const sweep = $('hero-scanline');
  if (sweep) {
    sweep.classList.remove('sweeping');
    void sweep.offsetWidth;
    sweep.classList.add('sweeping');
  }
  const labelEl = $('hero-slide-label');
  if (labelEl) labelEl.textContent = slide.label;
  const noteEl = $('hero-bezel-note');
  if (noteEl) noteEl.textContent = slide.note;
  if (slide.id === 'keys') renderOverviewKeysCanvases();
  if (restartTimer && heroAutoplay) scheduleHeroAutoplay();
}

function scheduleHeroAutoplay() {
  clearInterval(heroAutoplayTimer);
  if (!heroAutoplay) return;
  heroAutoplayTimer = setInterval(() => {
    if (state.activeTab !== 'overview') return;
    heroSlideIdx = (heroSlideIdx + 1) % HERO_SLIDES.length;
    setHeroSlide(HERO_SLIDES[heroSlideIdx].id);
  }, 3600);
}

function setCardARobotDemo(robotName) {
  cardADemoTheme = ['pink', 'mint', 'mono'].includes(robotName) ? robotName : 'pink';
  cardADemoKey = 227;
  const canvasA = $('card-preview-A');
  if (canvasA) canvasA.classList.remove('hidden');
  for (const img of document.querySelectorAll('#card-box-A .card-demo-img')) {
    img.classList.toggle('active', img.dataset.robotDemo === robotName);
  }
  for (const b of document.querySelectorAll('[data-card-a-demo]')) {
    b.classList.toggle('active', b.dataset.cardADemo === robotName);
  }
  for (const b of document.querySelectorAll('[data-card-key]')) {
    b.classList.remove('active');
  }
  renderOverviewKeysCanvases();
}

function showCardACustomCanvas(keyCode = state.preview.key) {
  cardADemoKey = keyCode;
  if (state.gif.useForDeploy) cardADemoTheme = 'custom';
  const canvasA = $('card-preview-A');
  if (!canvasA) return;
  for (const img of document.querySelectorAll('#card-box-A .card-demo-img')) {
    img.classList.remove('active');
  }
  canvasA.classList.remove('hidden');
  renderOverviewKeysCanvases();
}

function setCardBLayoutDemo(layoutId) {
  const canvasB = $('card-preview-B');
  if (canvasB) canvasB.classList.add('hidden');
  for (const img of document.querySelectorAll('#card-box-B .card-demo-img')) {
    img.classList.toggle('active', img.dataset.bSlide === layoutId);
  }
  for (const btn of document.querySelectorAll('[data-card-b-layout]')) {
    btn.classList.toggle('active', btn.dataset.cardBLayout === layoutId);
  }
}

function updateCardCDemo({ volumeOn = cardCVolDemoOn, useCustomCanvas = false } = {}) {
  cardCVolDemoOn = volumeOn;
  const canvasC = $('card-preview-C');
  const baseImg = $('card-c-img-base');
  const volImg = $('card-c-img-vol');
  const volBtn = $('btn-card-c-vol-demo');
  if (volBtn) volBtn.classList.toggle('active', volumeOn);

  if (!useCustomCanvas) {
    canvasC?.classList.add('hidden');
    if (baseImg) baseImg.classList.toggle('active', !volumeOn);
    if (volImg) volImg.classList.toggle('active', volumeOn);
  } else if (canvasC) {
    baseImg?.classList.remove('active');
    volImg?.classList.remove('active');
    canvasC.classList.remove('hidden');
    const cover = buildCoverFromTint(state.preview.coverTint);
    drawPreviewToCanvas(canvasC, {
      view: 'layout4',
      theme: state.theme,
      keysProfile: state.keysProfile,
      timeText: '12:35:00',
      battery: 84,
      mode: 1,
      title: state.preview.title,
      current: state.preview.current,
      next: state.preview.next,
      durationMs: 222000,
      positionMs: 86000,
      playing: true,
      textSize: state.preview.textSize,
      textStyle: state.preview.textStyle,
      coverActive: true,
      coverPalette: cover.palette,
      coverRgb565: cover.pixels,
      volumeOverlay: {
        visible: volumeOn,
        style: state.preview.volumeStyle,
        scope: 1,
        level: state.preview.volumeLevel,
        muted: false,
        alpha: 256
      }
    });
  }
}

function showToast(msg, durationMs = 3600) {
  const el = $('global-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => el.classList.add('hidden'), durationMs);
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function downloadBlob(bytesOrText, mime, filename) {
  const blob = bytesOrText instanceof Blob
    ? bytesOrText
    : new Blob([bytesOrText], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function getReleaseBundle() {
  if (state.releaseBundle) return state.releaseBundle;
  if (globalThis.__RAINY75_RELEASE_BUNDLE__ && typeof globalThis.__RAINY75_RELEASE_BUNDLE__ === 'object') {
    state.releaseBundle = globalThis.__RAINY75_RELEASE_BUNDLE__;
    return state.releaseBundle;
  }
  const el = document.getElementById('rainy75-release-bundle');
  if (el && el.textContent) {
    try {
      const parsed = JSON.parse(el.textContent);
      if (parsed && typeof parsed === 'object') {
        globalThis.__RAINY75_RELEASE_BUNDLE__ = parsed;
        state.releaseBundle = parsed;
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

async function gunzipBase64Verified(b64, expectedSha256, expectedSize, label) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前浏览器缺少 DecompressionStream("gzip") 支持，请使用新版桌面 Chrome / Edge');
  }
  const compressed = base64ToUint8Array(b64);
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (Number.isInteger(expectedSize) && bytes.length !== expectedSize) {
    throw new Error(`${label} 解压大小异常：期望 ${expectedSize}，实际 ${bytes.length}`);
  }
  if (expectedSha256) {
    const actualSha = await sha256(bytes);
    if (actualSha !== expectedSha256) {
      throw new Error(`${label} SHA-256 校验失败，已阻止加载`);
    }
  }
  return bytes;
}

async function loadBundleFirmwareEntry(key, label) {
  if (state.decompressedCache.has(`fw:${key}`)) {
    return state.decompressedCache.get(`fw:${key}`);
  }
  const bundle = getReleaseBundle();
  const entry = bundle?.firmware?.[key];
  if (!entry || !entry.binGzipBase64 || !entry.manifest) return null;
  const bytes = await gunzipBase64Verified(entry.binGzipBase64, entry.sha256, entry.size, label);
  const res = { bytes, manifest: entry.manifest };
  state.decompressedCache.set(`fw:${key}`, res);
  return res;
}

async function loadBundleFont() {
  if (state.decompressedCache.has('font')) {
    return state.decompressedCache.get('font');
  }
  const bundle = getReleaseBundle();
  const fontEntry = bundle?.font;
  if (!fontEntry?.binGzipBase64) return null;
  const bytes = await gunzipBase64Verified(fontEntry.binGzipBase64, fontEntry.sha256, fontEntry.size, 'FONT.BIN');
  validateFont(bytes);
  state.decompressedCache.set('font', bytes);
  return bytes;
}

async function loadBundleRobotAsset(themeName) {
  const key = `robot${themeName.charAt(0).toUpperCase()}${themeName.slice(1)}`;
  if (state.decompressedCache.has(`asset:${key}`)) {
    return state.decompressedCache.get(`asset:${key}`);
  }
  const bundle = getReleaseBundle();
  const entry = bundle?.assets?.[key];
  if (!entry?.gifGzipBase64) return null;
  const bytes = await gunzipBase64Verified(entry.gifGzipBase64, entry.sha256, entry.size, entry.filename || key);
  state.decompressedCache.set(`asset:${key}`, bytes);
  return bytes;
}

async function loadProfiles() {
  const bundle = getReleaseBundle();
  const embedded = globalThis.__RAINY75_EMBEDDED_PROFILES__;

  let keysObj = bundle?.profiles?.keys || embedded?.keys || null;
  let themesObj = bundle?.profiles?.themes || embedded?.themes || null;

  if (!keysObj && window.location.protocol !== 'file:') {
    try {
      const res = await fetch('../profiles/keys.json');
      if (res.ok) keysObj = await res.json();
    } catch {
      keysObj = null;
    }
  }
  if (!themesObj && window.location.protocol !== 'file:') {
    try {
      const res = await fetch('../profiles/themes.json');
      if (res.ok) themesObj = await res.json();
    } catch {
      themesObj = null;
    }
  }

  if (keysObj) {
    try {
      state.keysProfile = validateKeysProfile(JSON.parse(JSON.stringify(keysObj)));
      state.defaultKeysProfile = JSON.parse(JSON.stringify(state.keysProfile));
    } catch {
      state.keysProfile = JSON.parse(JSON.stringify(DEFAULT_KEYS_PROFILE));
      state.defaultKeysProfile = JSON.parse(JSON.stringify(DEFAULT_KEYS_PROFILE));
    }
  }
  if (themesObj && typeof themesObj === 'object') {
    state.presetsThemes = { ...PRESET_THEMES, ...themesObj };
  }
}

// ==================== TAB & OVERVIEW ====================

function switchTab(tabId) {
  const changed = state.activeTab !== tabId;
  state.activeTab = tabId;
  for (const btn of document.querySelectorAll('.tab-btn')) {
    const active = btn.dataset.tab === tabId;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.classList.toggle('hidden', panel.dataset.tab !== tabId);
    panel.classList.toggle('active', panel.dataset.tab === tabId);
  }
  if (changed) window.scrollTo({ top: 0, behavior: 'instant' });
  if (tabId === 'theme') {
    drawColorWheel();
    renderScreenPreviewCanvas();
  } else if (tabId === 'gif') {
    drawGifPreviewFrame();
  } else if (tabId === 'background') {
    refreshBackgroundStatus();
  }
}

function selectTrack(track) {
  if (workbenchBusy()) return;
  if (!['A', 'B', 'C'].includes(track)) return;
  state.track = track;
  for (const goal of document.querySelectorAll('[data-goal]')) {
    const active = goal.dataset.goal === (track === 'A' ? 'A' : 'C');
    goal.classList.toggle('active', active);
    goal.setAttribute('aria-checked', String(active));
  }
  const labelMap = {
    A: ' 当前已选 · 只装基础屏幕版',
    B: ' 当前已选 · 三模共存（经典顶栏优先）',
    C: ' 当前已选 · 三模共存（沉浸大封面优先）'
  };
  const idleMap = {
    A: '点击选择（只装基础版 · 免后台）',
    B: '点击选择（三模共存 · 经典样式优先）',
    C: '点击选择（三模共存 · 全屏沉浸优先）'
  };
  for (const card of document.querySelectorAll('.track-card')) {
    const active = card.dataset.track === track;
    card.classList.toggle('active', active);
    card.setAttribute('aria-checked', String(active));
    const mark = card.querySelector('.track-selected-mark');
    if (mark) mark.textContent = active ? labelMap[card.dataset.track] : idleMap[card.dataset.track];
  }
  const info = TRACK_DETAILS[track];
  $('header-track-pill').textContent = { A: '桌宠模式', B: '经典播放器', C: '沉浸播放器' }[track];
  $('overview-track-chip').textContent = info.chip;

  const box = $('overview-plan-summary');
  box.innerHTML = info.summary.map(line => `<div>• ${escapeHtml(line)}</div>`).join('');

  // Align preview defaults & hero demo slide cleanly when switching track
  if (track === 'A' && state.preview.view !== 'keys') {
    setPreviewView('keys');
    setHeroSlide('keys');
  } else if (track === 'B' && (state.preview.view === 'keys' || state.preview.view === 'layout4')) {
    setPreviewView('layout0');
    setHeroSlide('layout0');
  } else if (track === 'C' && state.preview.view !== 'layout4') {
    setPreviewView('layout4');
    setHeroSlide('layout4');
  }

  updateR75tBanner();
  recomputePlan();
}

// ==================== HSV COLOR MATH & WHEEL ====================

function rgbToHsv(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, v];
}

function hsvToRgb(h, s, v) {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(1, s));
  const val = Math.max(0, Math.min(1, v));
  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hue < 60) { r1 = c; g1 = x; b1 = 0; }
  else if (hue < 120) { r1 = x; g1 = c; b1 = 0; }
  else if (hue < 180) { r1 = 0; g1 = c; b1 = x; }
  else if (hue < 240) { r1 = 0; g1 = x; b1 = c; }
  else if (hue < 300) { r1 = x; g1 = 0; b1 = c; }
  else { r1 = c; g1 = 0; b1 = x; }
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255)
  ];
}

function drawColorWheel() {
  const canvas = $('theme-color-wheel');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(cx, cy) - 6;
  const val = Math.max(0.1, Math.min(1, state.wheel.v));
  const valKey = Math.round(val * 100);

  if (!wheelImageData || wheelCacheValue !== valKey) {
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.hypot(dx, dy);
        const at = (y * w + x) * 4;
        if (dist <= radius) {
          const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
          const sat = dist / radius;
          const [r, g, b] = hsvToRgb(deg, sat, val);
          d[at] = r;
          d[at + 1] = g;
          d[at + 2] = b;
          d[at + 3] = 255;
        } else {
          d[at + 3] = 0;
        }
      }
    }
    wheelImageData = img;
    wheelCacheValue = valKey;
  }

  ctx.clearRect(0, 0, w, h);
  ctx.putImageData(wheelImageData, 0, 0);

  // Reticle crosshair
  const rad = (state.wheel.h * Math.PI) / 180;
  const px = cx + Math.cos(rad) * state.wheel.s * radius;
  const py = cy + Math.sin(rad) * state.wheel.s * radius;
  ctx.save();
  ctx.beginPath();
  ctx.arc(px, py, 7, 0, Math.PI * 2);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px, py, 8.5, 0, Math.PI * 2);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = '#2c231f';
  ctx.stroke();
  ctx.restore();
}

function setWheelFromHex(hex, { applyHarmonic = false } = {}) {
  const clean = normalizeHex(hex, 'seedHex');
  const [r, g, b] = hexToRgb(clean);
  const [h, s, v] = rgbToHsv(r, g, b);
  state.wheel.h = h;
  state.wheel.s = s;
  state.wheel.v = Math.max(0.1, v);
  state.wheel.seedHex = clean;
  $('theme-seed-hex').value = clean;
  $('theme-seed-swatch').style.background = clean;
  $('theme-wheel-value').value = String(Math.round(state.wheel.v * 100));
  $('theme-wheel-val-readout').textContent = `${Math.round(state.wheel.v * 100)}%`;
  drawColorWheel();
  if (applyHarmonic) {
    applyHarmonicTheme();
  }
}

function applyHarmonicTheme() {
  const tone = $('theme-harmonic-tone').value || state.wheel.tone;
  state.wheel.tone = tone;
  const derived = generateHarmonicTheme(state.wheel.seedHex, tone);
  applyThemeObject(derived, {
    presetId: 'custom',
    badgeLabel: `协调生成 (${tone})`,
    syncWheel: false
  });
}

function applyThemeObject(themeObj, { presetId = 'custom', badgeLabel = null, syncWheel = true, userChange = true } = {}) {
  state.theme = normalizeTheme(themeObj);
  state.themePresetId = presetId;
  state.themeModified = userChange;

  $('theme-name-badge').textContent = badgeLabel || state.presetsThemes[presetId]?.name || '自定义配色';
  if (syncWheel) {
    setWheelFromHex(state.theme.accent, { applyHarmonic: false });
  }
  renderThemeChannels();
  renderContrastAudit();
  updateR75tBanner();
  renderScreenPreviewCanvas();
  if (state.gif.source) {
    recomposeGif({ immediateEncode: false });
  }
  recomputePlan();
}

function renderThemeChannels() {
  const container = $('theme-channels-grid');
  container.innerHTML = '';
  for (const ch of CHANNEL_META) {
    const hex = state.theme[ch.key];
    const c565 = rgb565(hex);
    const quantHex = rgb565ToHex(c565);

    const row = document.createElement('div');
    row.className = 'channel-row';
    row.dataset.channel = ch.key;
    row.innerHTML = `
      <div class="channel-head">
        <span>${escapeHtml(ch.label)}</span>
      </div>
      <div class="channel-inputs">
        <input type="color" class="chan-color" data-channel="${ch.key}" value="${hex}" aria-label="${escapeHtml(ch.label)} 颜色选择">
        <input type="text" class="chan-hex" data-channel="${ch.key}" value="${hex}" maxlength="7" aria-label="${escapeHtml(ch.label)} HEX 输入">
      </div>
      <div class="channel-565">
        <span class="chip-565" style="background:${quantHex}"></span>
        <span>RGB565: 0x${c565.toString(16).padStart(4, '0').toUpperCase()} (${quantHex})</span>
      </div>
    `;

    const colorInput = row.querySelector('.chan-color');
    const hexInput = row.querySelector('.chan-hex');
    const updateValue = raw => {
      try {
        const clean = normalizeHex(raw, ch.key);
        const next = { ...state.theme, [ch.key]: clean };
        applyThemeObject(next, { presetId: 'custom', badgeLabel: '自定义精调', syncWheel: ch.key === 'accent' });
      } catch {
        hexInput.value = state.theme[ch.key];
      }
    };
    colorInput.addEventListener('input', e => updateValue(e.target.value));
    hexInput.addEventListener('change', e => updateValue(e.target.value));
    container.appendChild(row);
  }
}

function renderContrastAudit() {
  const audit = auditThemeContrast(state.theme);
  const box = $('theme-contrast-box');
  box.classList.toggle('has-warn', audit.warnings.length > 0);
  if (audit.warnings.length > 0) {
    box.textContent = '文字对比度较低，建议调深文字颜色';
  } else {
    box.textContent = '文字对比度良好';
  }
  box.title = `文字 ${audit.inkOnBackground.toFixed(1)}:1，歌词 ${audit.inkOnLyricsPanel.toFixed(1)}:1`;
}

function getActiveIpsEntryForTheme() {
  const targetMode = $('patch-ips-target')?.value || 'auto';
  const wantLyrics = targetMode === 'ipsLyrics' || (targetMode === 'auto' && state.track !== 'A');
  const bundle = getReleaseBundle();

  if (wantLyrics) {
    if (state.manualBundle.ipsLyrics) return { key: 'ipsLyrics', source: 'manual', ...state.manualBundle.ipsLyrics };
    if (bundle?.firmware?.ipsLyrics) return { key: 'ipsLyrics', source: 'bundle', manifest: bundle.firmware.ipsLyrics.manifest };
  } else {
    if (state.manualBundle.ipsBase) return { key: 'ipsBase', source: 'manual', ...state.manualBundle.ipsBase };
    if (bundle?.firmware?.ipsBase) return { key: 'ipsBase', source: 'bundle', manifest: bundle.firmware.ipsBase.manifest };
  }
  return null;
}

function updateR75tBanner() {
  const badge = $('theme-r75t-status');
  const desc = $('theme-r75t-desc');
  if (!badge || !desc) return;
  const entry = getActiveIpsEntryForTheme();
  const hasSlot = Boolean(entry?.manifest?.themeSlot?.magic === 'R75T');
  const entryTheme = entry?.manifest ? resolveManifestTheme(entry.manifest) : normalizeTheme(PRESET_THEMES.pink);
  const changed = Object.keys(entryTheme).some(k => entryTheme[k] !== state.theme[k]);

  if (!entry) {
    badge.className = 'pill pill-muted';
    badge.textContent = changed ? '配色已修改（需加载 IPS 固件）' : '默认预设';
    desc.textContent = '当前未加载内置或手动 IPS 固件包；如需导出已调色固件，请在「部署与恢复向导」加载 IPS .bin + manifest.json，或使用发布包运行。';
  } else if (!hasSlot) {
    badge.className = 'pill pill-danger';
    badge.textContent = '缺少 R75T 槽位';
    desc.textContent = '当前 IPS 构建清单缺少 R75T 主题槽位，修改配色需要用源码 tools/build.py 重新编译 IPS 后刷入。';
  } else if (changed) {
    badge.className = 'pill pill-warn';
    badge.textContent = 'R75T 主题注入预计重刷 IPS';
    desc.textContent = `当前 8 色与所选 IPS (${entry.key === 'ipsLyrics' ? '歌词版 LY1' : '基础版 L6'}) 原始主题不同，部署时将自动注入 R75T v1 槽位并重刷 IPS（同时建议同步更新配套 S1 GIF）。`;
  } else {
    badge.className = 'pill pill-safe';
    badge.textContent = '与默认 IPS 主题一致 · 免额外注入';
    desc.textContent = '当前配色与构建产物一致；如切换歌词布局、字号与音量 HUD，可通过控制台实时生效，无需重刷 IPS。';
  }
}

async function handleDownloadPatchedIps() {
  const feedback = $('patch-ips-feedback');
  feedback.textContent = '正在准备 IPS 固件并验证 R75T 槽位…';
  try {
    const targetMode = $('patch-ips-target').value;
    const wantLyrics = targetMode === 'ipsLyrics' || (targetMode === 'auto' && state.track !== 'A');
    const key = wantLyrics ? 'ipsLyrics' : 'ipsBase';

    let entry = state.manualBundle[key];
    if (!entry) {
      entry = await loadBundleFirmwareEntry(key, key === 'ipsLyrics' ? '歌词版 IPS' : '基础版 IPS');
    }
    if (!entry) {
      throw new Error('未找到可用 IPS 固件（请使用发布包运行，或在「部署与恢复向导 → 手动选择文件」载入 IPS .bin 与 manifest.json）');
    }

    const patched = await patchIpsTheme(entry.bytes, entry.manifest, state.theme);
    const binName = wantLyrics ? 'rainy75v2-ips-lyrics-patched.bin' : 'rainy75v2-ips-base-patched.bin';
    const manifestName = wantLyrics ? 'rainy75v2-ips-lyrics-patched.manifest.json' : 'rainy75v2-ips-base-patched.manifest.json';

    downloadBlob(patched.bytes, 'application/octet-stream', binName);
    downloadBlob(JSON.stringify(patched.manifest, null, 2) + '\n', 'application/json', manifestName);

    feedback.textContent = `已导出 ${binName} (${patched.bytes.length} B) 与 manifest.json · R75T CRC 0x${patched.manifest.themeSlot.crc32.toString(16).padStart(8, '0')} · SHA-256 ${patched.manifest.sha256.slice(0, 16)}…`;
    showToast(`已导出调色 IPS 固件：${binName}`);
  } catch (err) {
    feedback.textContent = `导出失败：${err.message}`;
  }
}

// ==================== 320x172 SCREEN PREVIEW ====================

function buildCoverFromTint(tintHex) {
  const [r, g, b] = hexToRgb(normalizeHex(tintHex, 'coverTint'));
  const darken = factor => rgb565FromRgb(
    Math.round(r * factor),
    Math.round(g * factor),
    Math.round(b * factor)
  );
  const bright = rgb565FromRgb(
    Math.min(255, Math.round(r * 0.9 + 55)),
    Math.min(255, Math.round(g * 0.9 + 55)),
    Math.min(255, Math.round(b * 0.9 + 55))
  );
  const mid = darken(0.75);
  const deep = darken(0.38);
  const pixels = new Uint16Array(48 * 48);
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) {
      const dist = Math.hypot(x - 24, y - 24);
      if (dist < 7) pixels[y * 48 + x] = 0xffff;
      else if (dist < 15) pixels[y * 48 + x] = bright;
      else if (((x + y) & 4) === 0) pixels[y * 48 + x] = mid;
      else pixels[y * 48 + x] = deep;
    }
  }
  const palette = [darken(0.32), darken(0.46), darken(0.36), darken(0.24)];
  return { pixels, palette };
}

function setPreviewView(view) {
  state.preview.view = view;
  for (const btn of document.querySelectorAll('.preview-view-btn')) {
    btn.classList.toggle('active', btn.dataset.view === view);
  }
  const badge = $('theme-preview-view-badge');
  if (badge) badge.textContent = VIEW_LABELS[view] || view;
  const isKeys = view === 'keys';
  const isLayout4 = view === 'layout4';
  $('preview-keys-controls')?.classList.toggle('hidden', !isKeys);
  $('preview-lyrics-controls')?.classList.toggle('hidden', isKeys);
  $('preview-modec-controls')?.classList.toggle('hidden', !isLayout4);
  renderScreenPreviewCanvas();
}

function renderScreenPreviewCanvas() {
  const canvas = $('theme-preview-canvas');
  if (!canvas) return;
  const p = state.preview;
  const now = new Date();
  const timeText = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':');

  const durationMs = 222000;
  const positionMs = Math.round((p.progressPct / 100) * durationMs);
  const cover = buildCoverFromTint(p.coverTint);

  const bgFrame = (p.view === 'keys' && p.useGifBg && state.gif.composedFrames.length > 0)
    ? state.gif.composedFrames[state.gif.frameIdx % state.gif.composedFrames.length].rgba
    : null;

  drawPreviewToCanvas(canvas, {
    view: p.view,
    theme: state.theme,
    keysProfile: state.keysProfile,
    key: p.key,
    timeText,
    battery: 84,
    mode: 1,
    title: p.title,
    current: p.current,
    next: p.next,
    durationMs,
    positionMs,
    playing: true,
    textSize: p.textSize,
    textStyle: p.textStyle,
    coverActive: p.coverActive,
    coverPalette: p.coverActive ? cover.palette : undefined,
    coverRgb565: p.coverActive ? cover.pixels : undefined,
    volumeOverlay: {
      visible: p.volumeVisible,
      style: p.volumeStyle,
      scope: p.volumeScope,
      level: p.volumeLevel,
      muted: p.volumeMuted,
      alpha: 256
    }
  }, bgFrame);
}

// ==================== KEYS MATRIX EDITOR & DESIGN PROFILE ====================

function populateKeyEditorSelect() {
  const sel = $('key-editor-select');
  if (!sel) return;
  const prev = sel.value;
  sel.replaceChildren();
  for (const g of state.keysProfile.glyphs) {
    sel.add(new Option(`${g.name || 'Key'} (键码 ${g.key})`, String(g.key)));
  }
  if (prev && state.keysProfile.glyphs.some(g => String(g.key) === prev)) {
    sel.value = prev;
  }
  renderKeyPixelGrid();
}

function getEditingGlyph() {
  const code = Number($('key-editor-select')?.value);
  return state.keysProfile.glyphs.find(g => g.key === code) || state.keysProfile.glyphs[0];
}

function renderKeyPixelGrid() {
  const grid = $('key-pixel-grid');
  const dims = $('key-grid-dims');
  if (!grid) return;
  const glyph = getEditingGlyph();
  if (!glyph) return;
  const rows = glyph.rows;
  const h = rows.length;
  const w = rows[0].length;
  grid.style.gridTemplateColumns = `repeat(${w}, auto)`;
  grid.innerHTML = '';

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const on = rows[y][x] === '1';
      btn.className = `pixel-cell${on ? ' on' : ''}`;
      btn.setAttribute('aria-label', `行 ${y + 1} 列 ${x + 1} ${on ? '亮' : '灭'}`);
      btn.addEventListener('click', () => {
        const chars = [...rows[y]];
        chars[x] = chars[x] === '1' ? '0' : '1';
        rows[y] = chars.join('');
        state.customKeysChanged = true;
        renderKeyPixelGrid();
        renderScreenPreviewCanvas();
        recomputePlan();
      });
      grid.appendChild(btn);
    }
  }
  if (dims) {
    dims.textContent = `当前点阵：${w} × ${h}（规范上限 16 × 11，放大 6 倍后 ${w * 6} × ${h * 6} ≤ 120 × 76）`;
  }
}

function getCurrentPlayerSettings() {
  const layoutMap = { layout0: 0, layout1: 1, layout2: 2, layout3: 3, layout4: 4 };
  return {
    layout: layoutMap[state.preview.view] ?? (state.track === 'C' ? 4 : 0),
    textSize: state.preview.textSize,
    textStyle: state.preview.textStyle === 'soft' ? 1 : 0,
    volumeEnabled: state.preview.volumeEnabled,
    volumeScope: state.preview.volumeScope,
    volumeStyle: state.preview.volumeStyle,
    volumeHoldMs: state.preview.volumeHoldMs
  };
}

function getCurrentGifTransforms() {
  const g = state.gif;
  return {
    placementPreset: g.placementPreset,
    fit: g.fit,
    scale: g.scale,
    offsetX: g.offsetX,
    offsetY: g.offsetY,
    bgMode: g.bgMode,
    customBg: g.customBg,
    overlayBezel: g.overlayBezel,
    speed: g.speed,
    chromaKeyColor: g.chromaEnabled ? g.chromaKeyColor : null,
    chromaKeyTolerance: g.chromaKeyTolerance,
    bgBlur: g.bgBlur,
    flipX: g.flipX,
    enableAlpha: g.enableAlpha
  };
}

function refreshPetAiPrompt() {
  const idea = $('pet-ai-idea').value.trim() || '一只会眨眼、轻轻呼吸的原创像素桌宠';
  const theme = state.theme;
  const prompt = `请为我的 Rainy75 V2 键盘小屏设计并制作桌宠素材。

我的想法：${idea}
当前屏幕配色：背景 ${theme.background}，角色浅色 ${theme.panel}，轮廓 ${theme.ink}，点缀 ${theme.accent}。

交付要求：
1. 优先输出可下载的循环 GIF；如果只能生成图片，输出透明 PNG，并注明是静态素材。不要只描述画法或给一张软件界面截图。
2. 只画角色，使用 124×110px 透明画布，角色四周留约 6px 空间。轮廓清楚、细节简洁，适合小尺寸显示；可先大图设计，再按像素风缩小。
3. 动画建议 6-12 帧、每帧 100-150ms，包括待机、眨眼与小幅动作。首尾循环顺畅，身体位置稳定，不要整只角色忽明忽暗。
4. 不要把时钟、电池、按键框、边框、文字或水印画进源素材。整块设备屏幕为 320×172，右侧桌宠区域约 124×110；工作台负责摆放、填充背景和合成。
5. 请使用原创或我有权使用的素材。不要擅自修改固件、烧录设备或要求上传原厂二进制。
6. 文件命名 pet.gif 或 pet.png，并给一张预览。拿到成品后，我会在工作台的「桌宠动图」导入并调整。

如果我要求“敲键时拍爪”：请额外交付待机、左拍、右拍三个同尺寸、同坐标的独立姿态。普通 GIF 只会循环播放，不能自行知道键盘是否按下；真实按键联动需要屏幕固件的原生通知支持，请勿把循环拍爪当作已实现联动。`;
  $('pet-ai-prompt').value = prompt;
  return prompt;
}

function handleExportDesignProfile() {
  const feedback = $('design-profile-feedback');
  try {
    const schemeName = $('design-profile-name')?.value?.trim() || '我的 Rainy75 定制方案';
    const customGif = state.gif.encodedBytes
      ? { bytes: state.gif.encodedBytes, transforms: getCurrentGifTransforms() }
      : null;

    const exported = exportDesignProfile({
      name: schemeName,
      track: state.track,
      keys: state.keysProfile,
      theme: state.theme,
      customGif,
      playerSettings: getCurrentPlayerSettings()
    });
    downloadBlob(JSON.stringify(exported, null, 2) + '\n', 'application/json', 'rainy75-design-v1.json');
    feedback.textContent = `已导出设计方案：${exported.name} (轨道 ${exported.track})`;
    showToast('已导出完整设计方案 JSON');
  } catch (err) {
    feedback.textContent = `导出失败：${err.message}`;
  }
}

async function handleImportDesignProfile(file) {
  const feedback = $('design-profile-feedback');
  if (!file) return;
  try {
    const text = await file.text();
    const imported = importDesignProfile(text);
    $('design-profile-name').value = imported.name;
    selectTrack(imported.track);

    if (imported.keys) {
      state.keysProfile = imported.keys;
      state.customKeysChanged = true;
      populateKeyEditorSelect();
    }
    if (imported.playerSettings) {
      const ps = imported.playerSettings;
      if (ps.volumeEnabled !== undefined) state.preview.volumeEnabled = ps.volumeEnabled;
      if (ps.layout !== undefined) setPreviewView(`layout${ps.layout}`);
      if (ps.textSize !== undefined) {
        state.preview.textSize = ps.textSize;
        syncPreviewModeCControls();
      }
      if (ps.textStyle !== undefined) {
        state.preview.textStyle = ps.textStyle === 1 ? 'soft' : 'crisp';
        syncPreviewModeCControls();
      }
      if (ps.volumeScope !== undefined) {
        state.preview.volumeScope = ps.volumeScope;
        $('preview-vol-scope').value = String(ps.volumeScope);
      }
      if (ps.volumeStyle !== undefined) {
        state.preview.volumeStyle = ps.volumeStyle;
        $('preview-vol-style').value = String(ps.volumeStyle);
      }
      if (ps.volumeHoldMs !== undefined) {
        state.preview.volumeHoldMs = ps.volumeHoldMs;
        $('preview-vol-hold').value = String(ps.volumeHoldMs);
        $('preview-vol-hold-val').textContent = `${ps.volumeHoldMs} ms`;
      }
    }

    if (imported.customGif) {
      if (imported.customGif.transforms) {
        applyGifTransformsToState(imported.customGif.transforms);
      }
      if (imported.customGif.bytes) {
        state.gif.source = decodeGif(imported.customGif.bytes);
        state.gif.sourceLabel = `导入方案 GIF (${file.name})`;
        $('gif-file-name').textContent = state.gif.sourceLabel;
      }
    }

    applyThemeObject(imported.theme, { presetId: 'custom', badgeLabel: imported.name });
    feedback.textContent = `已导入方案：${imported.name} (轨道 ${imported.track})`;
    showToast(`已导入设计方案：${imported.name}`);
  } catch (err) {
    feedback.textContent = `导入失败：${err.message}`;
  }
}

// ==================== GIF STUDIO ====================

function extractRobotSpriteFromFullFrames(fullFrames, themeObj) {
  const bg565 = rgb565(normalizeTheme(themeObj).background);
  const cropX = 196;
  const cropY = 48;
  const cropW = 108;
  const cropH = 108;
  const outFrames = [];

  for (const f of fullFrames) {
    const rgba = new Uint8ClampedArray(cropW * cropH * 4);
    for (let y = 0; y < cropH; y++) {
      for (let x = 0; x < cropW; x++) {
        const srcAt = ((cropY + y) * SCREEN_WIDTH + (cropX + x)) * 4;
        const dstAt = (y * cropW + x) * 4;
        const r = f.rgba[srcAt];
        const g = f.rgba[srcAt + 1];
        const b = f.rgba[srcAt + 2];
        const a = f.rgba[srcAt + 3];
        if (a < 128 || rgb565FromRgb(r, g, b) === bg565) {
          rgba[dstAt] = 0;
          rgba[dstAt + 1] = 0;
          rgba[dstAt + 2] = 0;
          rgba[dstAt + 3] = 0;
        } else {
          rgba[dstAt] = r;
          rgba[dstAt + 1] = g;
          rgba[dstAt + 2] = b;
          rgba[dstAt + 3] = 255;
        }
      }
    }
    outFrames.push({ rgba, delayMs: f.delayMs || 120, disposal: 1 });
  }
  return { width: cropW, height: cropH, frames: outFrames, loopCount: 0 };
}

function synthesizeRobotFrames(themeObj) {
  const frames = [];
  for (let phase = 0; phase < 8; phase++) {
    const fb = renderBaseFrame565(themeObj, { phase });
    const rgba = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
    for (let i = 0; i < fb.length; i++) {
      const [r, g, b] = rgb565ToRgb(fb[i]);
      const at = i * 4;
      rgba[at] = r;
      rgba[at + 1] = g;
      rgba[at + 2] = b;
      rgba[at + 3] = 255;
    }
    frames.push({ rgba, delayMs: 120, disposal: 1 });
  }
  return { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, frames, loopCount: 0 };
}

async function loadPresetRobot(themeName) {
  const themeObj = state.presetsThemes[themeName] || PRESET_THEMES[themeName] || PRESET_THEMES.pink;
  let decoded = null;
  try {
    const bundledBytes = await loadBundleRobotAsset(themeName);
    if (bundledBytes) {
      decoded = decodeGif(bundledBytes);
    }
  } catch {
    decoded = null;
  }
  if (!decoded) {
    decoded = synthesizeRobotFrames(themeObj);
  }
  state.gif.source = extractRobotSpriteFromFullFrames(decoded.frames, themeObj);
  state.gif.sourceLabel = `内置原创像素机器人 (${themeObj.name || themeName})`;
  state.gif.frameIdx = 0;
  $('gif-file-name').textContent = state.gif.sourceLabel;
  $('gif-source-info').textContent = `源尺寸：${state.gif.source.width}×${state.gif.source.height} · ${state.gif.source.frames.length} 帧`;
  recomposeGif({ immediateEncode: true });
}

async function decodeImageFileToRgba(file) {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(file);
    try {
      const w = Math.min(2048, bmp.width);
      const h = Math.min(2048, bmp.height);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0, w, h);
      return { rgba: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
    } finally {
      bmp.close?.();
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('无法解码图片文件'));
      el.src = url;
    });
    const w = Math.min(2048, img.naturalWidth || img.width);
    const h = Math.min(2048, img.naturalHeight || img.height);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return { rgba: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function handleGifFileSelected(file) {
  if (!file) return;
  try {
    const isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name);
    if (isGif) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      state.gif.source = decodeGif(bytes);
    } else {
      const { rgba, width, height } = await decodeImageFileToRgba(file);
      state.gif.source = rgbaToStaticGifSource(rgba, width, height, 120);
    }
    state.gif.sourceLabel = `${file.name} (${state.gif.source.width}×${state.gif.source.height}, ${state.gif.source.frames.length} 帧)`;
    state.gif.frameIdx = 0;
    state.gif.useForDeploy = true;
    $('gif-file-name').textContent = state.gif.sourceLabel;
    $('gif-source-info').textContent = `源尺寸：${state.gif.source.width}×${state.gif.source.height} · ${state.gif.source.frames.length} 帧`;
    recomposeGif({ immediateEncode: true });
    recomputePlan();
    showToast(`已载入本地素材：${file.name}`);
  } catch (err) {
    showToast(`素材解析失败：${err.message}`, 5000);
  }
}

function applyGifTransformsToState(tr) {
  const g = state.gif;
  if (tr.placementPreset !== undefined) g.placementPreset = tr.placementPreset;
  if (tr.fit !== undefined) g.fit = tr.fit;
  if (tr.scale !== undefined) g.scale = tr.scale;
  if (tr.offsetX !== undefined) g.offsetX = tr.offsetX;
  if (tr.offsetY !== undefined) g.offsetY = tr.offsetY;
  if (tr.bgMode !== undefined) g.bgMode = tr.bgMode;
  if (tr.customBg !== undefined) g.customBg = tr.customBg;
  if (tr.overlayBezel !== undefined) g.overlayBezel = tr.overlayBezel;
  if (tr.speed !== undefined) g.speed = tr.speed;
  if (tr.chromaKeyColor !== undefined && tr.chromaKeyColor !== null) {
    g.chromaEnabled = true;
    g.chromaKeyColor = tr.chromaKeyColor;
  } else if (tr.chromaKeyColor === null) {
    g.chromaEnabled = false;
  }
  if (tr.chromaKeyTolerance !== undefined) g.chromaKeyTolerance = tr.chromaKeyTolerance;
  if (tr.bgBlur !== undefined) g.bgBlur = Boolean(tr.bgBlur);
  if (tr.flipX !== undefined) g.flipX = tr.flipX;
  if (tr.enableAlpha !== undefined) g.enableAlpha = tr.enableAlpha;
  syncGifControlsFromState();
}

function syncGifControlsFromState() {
  const g = state.gif;
  for (const btn of document.querySelectorAll('[data-place]')) {
    btn.classList.toggle('active', btn.dataset.place === g.placementPreset);
  }
  $('gif-fit').value = g.fit;
  $('gif-scale').value = String(g.scale);
  $('gif-scale-val').textContent = `${g.scale.toFixed(2)}x`;
  $('gif-offset-x').value = String(g.offsetX);
  $('gif-offsetx-val').textContent = String(g.offsetX);
  $('gif-offset-y').value = String(g.offsetY);
  $('gif-offsety-val').textContent = String(g.offsetY);
  $('gif-max-frames').value = String(g.maxFrames);
  $('gif-flip-x').checked = g.flipX;
  $('gif-overlay-bezel').checked = g.overlayBezel;
  $('gif-enable-alpha').checked = g.enableAlpha;
  $('gif-bg-mode').value = g.bgMode;
  $('gif-custom-bg').value = g.customBg;
  $('gif-custom-bg-wrap').classList.toggle('hidden', g.bgMode !== 'custom');
  $('gif-bg-blur').checked = Boolean(g.bgBlur);
  $('gif-chroma-enabled').checked = g.chromaEnabled;
  $('gif-chroma-color').value = g.chromaKeyColor;
  $('gif-chroma-hex').value = g.chromaKeyColor;
  $('gif-chroma-tolerance').value = String(g.chromaKeyTolerance);
  $('gif-chroma-tol-val').textContent = String(g.chromaKeyTolerance);
  $('gif-speed').value = String(g.speed);
  $('gif-speed-val').textContent = `${g.speed.toFixed(2)}x`;
  $('gif-loop').checked = g.loop;
}

function recomposeGif({ immediateEncode = false } = {}) {
  if (!state.gif.source) return;
  const g = state.gif;
  try {
    g.composedFrames = composePetGifFrames(g.source, {
      theme: state.theme,
      placementPreset: g.placementPreset,
      fit: g.fit,
      scale: g.scale,
      offsetX: g.offsetX,
      offsetY: g.offsetY,
      bgMode: g.bgMode,
      customBg: g.customBg,
      overlayBezel: g.overlayBezel,
      speed: g.speed,
      maxFrames: g.maxFrames,
      chromaKeyColor: g.chromaEnabled ? g.chromaKeyColor : null,
      chromaKeyTolerance: g.chromaKeyTolerance,
      bgBlur: g.bgBlur ? 4 : false,
      flipX: g.flipX,
      enableAlpha: g.enableAlpha
    });
  } catch (err) {
    g.auditError = err.message;
    updateGifAuditCard();
    return;
  }

  if (g.frameIdx >= g.composedFrames.length) g.frameIdx = 0;
  const scrubber = $('gif-scrubber');
  scrubber.max = String(Math.max(0, g.composedFrames.length - 1));
  scrubber.value = String(g.frameIdx);

  drawGifPreviewFrame();
  drawGifSourceCanvas();
  renderScreenPreviewCanvas();

  clearTimeout(gifEncodeTimerId);
  if (immediateEncode || g.composedFrames.length <= 16) {
    encodeAndAuditCurrentGif();
  } else {
    $('gif-audit-badge').className = 'pill pill-muted';
    $('gif-audit-badge').textContent = '重新编码中…';
    gifEncodeTimerId = setTimeout(encodeAndAuditCurrentGif, 140);
  }
  scheduleNextGifFrame();
}

function encodeAndAuditCurrentGif() {
  const g = state.gif;
  if (!g.composedFrames.length) return;
  try {
    const bytes = encodeGif320x172(g.composedFrames, { loop: g.loop });
    const audit = auditDeviceGif(bytes, state.theme);
    g.encodedBytes = bytes;
    g.auditResult = audit;
    g.auditError = null;
  } catch (err) {
    g.encodedBytes = null;
    g.auditResult = null;
    g.auditError = err.message;
  }
  updateGifAuditCard();
  if (state.gif.useForDeploy) recomputePlan();
}

function updateGifAuditCard() {
  const g = state.gif;
  const badge = $('gif-audit-badge');
  if (g.auditError) {
    badge.className = 'pill pill-danger';
    badge.textContent = '未通过校验';
    $('audit-size').textContent = g.encodedBytes ? `${(g.encodedBytes.length / 1024).toFixed(1)} KiB` : '--';
    $('audit-format').textContent = '存在异常';
    $('audit-marker').textContent = '未确认';
    $('audit-detail').textContent = g.auditError;
    return;
  }
  if (!g.auditResult) {
    badge.className = 'pill pill-muted';
    badge.textContent = '待生成';
    return;
  }
  const a = g.auditResult;
  badge.className = 'pill pill-safe';
  badge.textContent = `校验通过 · ${(a.bytes / 1024).toFixed(1)} KiB`;
  $('audit-size').textContent = `${(a.bytes / 1024).toFixed(1)} KiB / 4096 KiB`;
  $('audit-format').textContent = `${a.width}×${a.height} · ${a.frameCount} 帧 · 全帧不透明 + disposal=1`;
  $('audit-marker').textContent = '(22, 39) 标记像素安全';
  $('audit-detail').textContent = '满足设备 S1 缓存与歌词切页全部规范';
}

function drawGifPreviewFrame() {
  const canvas = $('gif-preview-canvas');
  const frames = state.gif.composedFrames;
  if (!canvas || !frames.length) return;
  const idx = state.gif.frameIdx % frames.length;
  const frame = frames[idx];
  const ctx = canvas.getContext('2d');
  const img = new ImageData(new Uint8ClampedArray(frame.rgba), SCREEN_WIDTH, SCREEN_HEIGHT);
  ctx.putImageData(img, 0, 0);

  $('gif-frame-counter').textContent = `${idx + 1} / ${frames.length}`;
  $('gif-scrubber').value = String(idx);
  const fps = frame.delayMs > 0 ? (1000 / frame.delayMs).toFixed(1) : '--';
  $('gif-fps-readout').textContent = `${frame.delayMs} ms · ${fps} FPS`;
}

function drawGifSourceCanvas() {
  const canvas = $('gif-source-canvas');
  const src = state.gif.source;
  if (!canvas || !src || !src.frames.length) return;
  const maxIdx = src.frames.length - 1;
  const ratio = state.gif.composedFrames.length > 1
    ? state.gif.frameIdx / Math.max(1, state.gif.composedFrames.length - 1)
    : 0;
  const srcIdx = Math.min(maxIdx, Math.round(ratio * maxIdx));
  const f = src.frames[srcIdx];

  const off = document.createElement('canvas');
  off.width = src.width;
  off.height = src.height;
  off.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(f.rgba), src.width, src.height), 0, 0);

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / src.width, canvas.height / src.height);
  const dw = src.width * scale;
  const dh = src.height * scale;
  const dx = (canvas.width - dw) / 2;
  const dy = (canvas.height - dh) / 2;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, dx, dy, dw, dh);
}

function scheduleNextGifFrame() {
  clearTimeout(gifTimerId);
  const frames = state.gif.composedFrames;
  if (!state.gif.playing || frames.length <= 1) return;
  const delay = Math.max(20, frames[state.gif.frameIdx % frames.length]?.delayMs || 100);
  gifTimerId = setTimeout(() => {
    if (!state.gif.playing) return;
    const next = state.gif.frameIdx + 1;
    if (next >= frames.length) {
      if (!state.gif.loop) {
        state.gif.playing = false;
        $('btn-gif-play').textContent = '播放';
        return;
      }
      state.gif.frameIdx = 0;
    } else {
      state.gif.frameIdx = next;
    }
    if (state.activeTab === 'gif') {
      drawGifPreviewFrame();
      drawGifSourceCanvas();
    }
    if (state.activeTab === 'theme' && state.preview.view === 'keys' && state.preview.useGifBg) {
      renderScreenPreviewCanvas();
    }
    scheduleNextGifFrame();
  }, delay);
}

function toggleEyedropper(force) {
  const next = force !== undefined ? force : !state.gif.eyedropper;
  state.gif.eyedropper = next;
  $('btn-gif-eyedropper').classList.toggle('btn-primary', next);
  $('btn-gif-eyedropper').textContent = next ? '点击预览或源图画面取色（再次点击取消）' : '从预览画面点选抠除色';
  $('gif-source-canvas').classList.toggle('eyedropper-active', next);
  $('gif-preview-canvas').classList.toggle('eyedropper-active', next);
  $('gif-eyedropper-hint').textContent = next ? '取色模式已开启：点击下方源图或上方预览画面' : '点选「从预览画面点选抠除色」后点击画面';
}

function handleEyedropperPick(canvas, clientX, clientY) {
  if (!state.gif.eyedropper) return;
  const rect = canvas.getBoundingClientRect();
  const px = Math.max(0, Math.min(canvas.width - 1, Math.floor(((clientX - rect.left) * canvas.width) / rect.width)));
  const py = Math.max(0, Math.min(canvas.height - 1, Math.floor(((clientY - rect.top) * canvas.height) / rect.height)));
  const data = canvas.getContext('2d').getImageData(px, py, 1, 1).data;
  if (data[3] === 0) {
    showToast('所选像素为透明背景，请点击非透明区域取色');
    return;
  }
  const hex = rgbToHex(data[0], data[1], data[2]);
  state.gif.chromaEnabled = true;
  state.gif.chromaKeyColor = hex;
  $('gif-sampled-chip').style.background = hex;
  $('gif-sampled-hex').textContent = hex;
  syncGifControlsFromState();
  toggleEyedropper(false);
  recomposeGif({ immediateEncode: true });
  showToast(`已选取抠除色：${hex}`);
}

function handleExtractGifPalette() {
  const container = $('gif-extracted-palette');
  const srcFrame = state.gif.source?.frames?.[0]?.rgba;
  const compFrame = state.gif.composedFrames?.[0]?.rgba;
  let colors = [];
  if (srcFrame) {
    colors = extractPaletteFromRgba(srcFrame, 6);
  }
  if (colors.length === 0 && compFrame) {
    colors = extractPaletteFromRgba(compFrame, 6);
  }
  if (colors.length === 0) {
    container.innerHTML = '<span class="hint">当前帧未提取到有效不透明颜色。</span>';
    return;
  }
  container.innerHTML = '';
  for (const hex of colors) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'palette-swatch-btn';
    btn.innerHTML = `<span class="palette-swatch-dot" style="background:${hex}"></span><span>${hex}</span>`;
    btn.title = `设为色盘主色 ${hex}`;
    btn.addEventListener('click', () => {
      setWheelFromHex(hex, { applyHarmonic: true });
      showToast(`已将 ${hex} 设为色盘种子色并生成协调 8 色`);
      switchTab('theme');
    });
    container.appendChild(btn);
  }
}

// ==================== DEPLOYMENT & DEVICE PROBING ====================

function getPlanningBundle() {
  const release = getReleaseBundle();
  const { patch: baseKey, restore: restoreBaseKey } = MAIN_BASELINES[state.baseline];

  const makeMetaEntry = (manual, fwKey) => {
    if (manual) return manual;
    const rel = release?.firmware?.[fwKey];
    if (!rel?.manifest) return null;
    return { bytes: new Uint8Array(0), manifest: rel.manifest };
  };

  return {
    main: makeMetaEntry(state.manualBundle.main, baseKey),
    ipsBase: makeMetaEntry(state.manualBundle.ipsBase, 'ipsBase'),
    ipsLyrics: makeMetaEntry(state.manualBundle.ipsLyrics, 'ipsLyrics'),
    restoreMain: makeMetaEntry(state.manualBundle.restoreMain, restoreBaseKey),
    restoreIps: makeMetaEntry(state.manualBundle.restoreIps, 'restoreIps'),
    font: state.manualBundle.font || (release?.font ? { fakeCrc: release.font.bodyCrc } : null),
    gif: (state.gif.useForDeploy && state.gif.encodedBytes) ? state.gif.encodedBytes : (release?.assets?.robotPink ? new Uint8Array(1) : null)
  };
}

function getFontBodyCrcHint() {
  if (state.manualBundle.font) {
    try { return validateFont(state.manualBundle.font).bodyCrc; } catch { return null; }
  }
  const release = getReleaseBundle();
  if (Number.isInteger(release?.font?.bodyCrc)) return release.font.bodyCrc >>> 0;
  const ipsLyrics = state.manualBundle.ipsLyrics || release?.firmware?.ipsLyrics;
  const c = ipsLyrics?.manifest?.fontBodyCrc;
  return Number.isInteger(c) ? (c >>> 0) : null;
}

function buildDeployIntent() {
  const defaultPink = normalizeTheme(PRESET_THEMES.pink);
  const ipsEntry = state.track === 'A'
    ? (state.manualBundle.ipsBase || getReleaseBundle()?.firmware?.ipsBase)
    : (state.manualBundle.ipsLyrics || getReleaseBundle()?.firmware?.ipsLyrics);
  const baseTheme = ipsEntry?.manifest ? resolveManifestTheme(ipsEntry.manifest) : defaultPink;
  const themeChanged = state.themeModified;

  return {
    scenario: state.scenario,
    track: state.track,
    baseline: state.baseline,
    previousBaseline: state.previousBaseline,
    baselineSwitched: Boolean(state.previousBaseline && state.previousBaseline !== state.baseline),
    restoreTarget: state.restoreTarget,
    forceReflashMain: $('opt-force-main').checked,
    forceReflashIps: $('opt-force-ips').checked,
    forceUploadFont: $('opt-force-font').checked,
    skipGif: $('opt-skip-gif').checked,
    skipCalibrate: $('opt-skip-calibrate').checked,
    themeColors: themeChanged ? state.theme : null,
    themeChanged,
    customKeysChanged: state.customKeysChanged,
    keysIncludedInBuild: false,
    customGifBytes: state.gif.useForDeploy ? state.gif.encodedBytes : null,
    previousFontBytes: state.manualBundle.previousFont || undefined,
    timeZone: $('quick-timezone').value.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  };
}

function recomputePlan() {
  const listEl = $('deploy-plan-steps');
  const noticesEl = $('deploy-notices');
  const pillEl = $('plan-status-pill');
  if (!listEl || !noticesEl) return;

  if (!state.probeResult) {
    state.currentPlan = null;
    pillEl.className = 'pill pill-muted';
    pillEl.textContent = '等待探测';
    noticesEl.innerHTML = '';
    listEl.innerHTML = '<li class="step-empty">请先点击左侧「连接并探测设备（只读）」，系统将自动生成针对当前设备状态的计划。</li>';
    $('btn-start-deploy').disabled = true;
    return;
  }

  const intent = buildDeployIntent();
  const planBundle = getPlanningBundle();
  // Pass real font bytes only when available; otherwise pass ipsLyrics fontBodyCrc via ipsLyrics manifest
  const bundleForPlan = {
    main: planBundle.main,
    ipsBase: planBundle.ipsBase,
    ipsLyrics: planBundle.ipsLyrics,
    restoreMain: planBundle.restoreMain,
    restoreIps: planBundle.restoreIps,
    font: state.manualBundle.font || undefined,
    gif: planBundle.gif || undefined
  };
  if (!bundleForPlan.font && getFontBodyCrcHint() !== null && bundleForPlan.ipsLyrics?.manifest) {
    bundleForPlan.ipsLyrics = {
      bytes: bundleForPlan.ipsLyrics.bytes,
      manifest: { ...bundleForPlan.ipsLyrics.manifest, fontBodyCrc: getFontBodyCrcHint() }
    };
  }

  const plan = planDeployment(state.probeResult, intent, bundleForPlan);
  state.currentPlan = plan;
  const names = { flash_main: '键盘主控', flash_ips_base: '屏幕固件', flash_ips_lyrics: '播放器固件',
    upload_font: '检查字库', upload_gif: '桌宠动画', calibrate: '时钟校准',
    flash_restore_main: '官方主控固件', flash_restore_ips: '官方屏幕固件' };
  const changes = plan.steps.filter(step => step.action === 'run' && names[step.id]).map(step => names[step.id]);
  $('install-summary').textContent = plan.blocked ? '请先处理下方提示，再继续安装。'
    : changes.length ? `本次安装：${changes.join('、')}。` : '当前功能已兼容，无需重复安装。';
  const writesMain = plan.steps.some(step => step.target === 'main' && step.action === 'run');
  $('baseline-field').classList.toggle('hidden', !writesMain && state.scenario !== 'restore');

  const notices = [];
  for (const w of plan.warnings || []) {
    notices.push({ kind: 'warn', text: w });
  }
  if (plan.blocked && plan.error) {
    notices.push({ kind: 'error', text: plan.error });
  }
  if (intent.themeChanged && state.scenario !== 'restore') {
    const ipsEntry = state.track === 'A' ? planBundle.ipsBase : planBundle.ipsLyrics;
    if (ipsEntry?.manifest?.themeSlot) {
      notices.push({
        kind: 'info',
        text: '自定义配色将通过 R75T v1 槽位验证后自动重刷 IPS 固件，并同步更新配套 S1 GIF。'
      });
    }
  }
  if (state.probeResult.mode === 'app' && state.probeResult.uiActive !== true && state.scenario !== 'restore') {
    notices.push({
      kind: 'warn',
      text: '当前未确认屏幕正在播放 S1。安装后如未显示新画面，请在官方驱动中选择「GIF 播放 / 槽位 1」。'
    });
  }

  noticesEl.innerHTML = notices
    .map(n => `<div class="banner banner-${n.kind === 'error' ? 'error' : n.kind === 'warn' ? 'warn' : 'info'}">${escapeHtml(n.text)}</div>`)
    .join('');

  const actionMeta = {
    run: { text: '待执行', cls: 'pill-accent' },
    skip: { text: '已一致·跳过', cls: 'pill-safe' },
    manual: { text: '需手动操作', cls: 'pill-warn' },
    blocked: { text: '硬件不兼容阻塞', cls: 'pill-danger' },
    needs_reflash: { text: '需源码重编 IPS', cls: 'pill-warn' }
  };

  listEl.innerHTML = plan.steps.map((s, idx) => {
    const badge = actionMeta[s.action] || { text: s.action, cls: 'pill-muted' };
    return `
      <li class="step-item" data-step-id="${escapeHtml(s.id)}" data-action="${escapeHtml(s.action)}">
        <div class="step-top">
          <span class="step-title">${idx + 1}. ${escapeHtml(s.title)}</span>
          <span class="pill ${badge.cls}">${escapeHtml(badge.text)}</span>
        </div>
        <div class="step-reason">${escapeHtml(s.reason || '')}</div>
      </li>
    `;
  }).join('');

  if (plan.blocked) {
    pillEl.className = 'pill pill-danger';
    pillEl.textContent = '硬件不兼容阻塞';
  } else {
    const runCount = plan.steps.filter(s => s.action === 'run').length;
    pillEl.className = runCount > 0 ? 'pill pill-accent' : 'pill pill-safe';
    pillEl.textContent = runCount > 0 ? `待执行 ${runCount} 步` : '全部已一致·无需刷写';
  }

  $('btn-start-deploy').disabled = Boolean(plan.blocked || workbenchBusy());
  syncOperationUi();
}

function workbenchBusy() {
  return Boolean(state.operation || state.runner && ['running', 'awaiting_iap_auth', 'awaiting_app_auth'].includes(state.runner.status));
}

const lockedControls = new Map();
function syncOperationUi() {
  const busy = workbenchBusy();
  $('panel-deploy').setAttribute('aria-busy', String(busy));
  const exclusions = '.tab-btn, #btn-appearance, #btn-auth-iap, #btn-abort-deploy, #btn-clear-log';
  if (busy) {
    for (const el of document.querySelectorAll('main button, main input, main select, main textarea, .track-card')) {
      if (el.matches(exclusions)) continue;
      if (el.matches('.track-card')) { el.setAttribute('aria-disabled', 'true'); continue; }
      if (!lockedControls.has(el)) lockedControls.set(el, el.disabled);
      el.disabled = true;
    }
  } else {
    for (const [el, disabled] of lockedControls) el.disabled = disabled;
    lockedControls.clear();
    document.querySelectorAll('.track-card').forEach(el => el.removeAttribute('aria-disabled'));
    const app = state.probeResult?.mode === 'app' && state.activeClient;
    $('btn-disconnect-device').disabled = !state.activeDevice;
    for (const id of ['btn-quick-calibrate', 'btn-quick-upload-gif', 'btn-quick-delete-font', 'btn-quick-check-font']) $(id).disabled = !app;
  }
  const terminal = state.runner && ['completed', 'aborted'].includes(state.runner.status);
  $('btn-start-deploy').disabled = Boolean(busy || terminal || !state.currentPlan || state.currentPlan.blocked);
  $('btn-probe-device').disabled = busy || !navigator.hid;
  $('deploy-baseline').disabled = busy || Boolean(state.probeResult?.detectedBaseline);
  $('btn-abort-deploy').disabled = !state.runner || state.runner._busy || !['awaiting_iap_auth', 'awaiting_app_auth', 'failed'].includes(state.runner.status);
  let phase = 'connect';
  if (state.runner?.status === 'completed') phase = 'done';
  else if (state.runner && ['running', 'awaiting_iap_auth', 'awaiting_app_auth', 'failed'].includes(state.runner.status)) phase = 'write';
  else if (state.probeResult) phase = 'review';
  document.querySelectorAll('[data-install-phase]').forEach(el => {
    if (el.dataset.installPhase === phase) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
  });
}

function renderProbeTelemetry() {
  const p = state.probeResult;
  const headerPill = $('header-device-pill');
  const probeBadge = $('probe-badge');
  const connEl = $('friendly-conn-text');
  const chipEl = $('friendly-chip-text');
  const funcEl = $('friendly-func-text');
  const cfEl = $('friendly-clockfont-text');

  if (!p) {
    headerPill.className = 'pill pill-muted';
    headerPill.textContent = '键盘：未连接';
    probeBadge.className = 'pill pill-muted';
    probeBadge.textContent = '等待连接';
    if (connEl) connEl.textContent = '还没连上键盘';
    if (chipEl) chipEl.textContent = '连线后自动识别';
    if (funcEl) funcEl.textContent = '--';
    if (cfEl) cfEl.textContent = '--';
    for (const id of ['probe-pid', 'probe-main', 'probe-ips', 'probe-silicon', 'probe-clock', 'probe-ui-active', 'probe-font-crc', 'probe-lyrics-caps']) {
      $(id).textContent = '--';
    }
    $('btn-disconnect-device').disabled = true;
    $('btn-quick-calibrate').disabled = true;
    $('btn-quick-upload-gif').disabled = true;
    $('btn-quick-delete-font').disabled = true;
    syncOperationUi();
    return;
  }

  const pidHex = `0x${p.pid.toString(16)}`;
  const isApp = p.mode === 'app';
  headerPill.className = isApp ? 'pill pill-safe' : 'pill pill-warn';
  headerPill.textContent = isApp ? ' 键盘已连接' : `⏳ 升级通道 (${pidHex})`;
  probeBadge.className = isApp ? 'pill pill-safe' : 'pill pill-warn';
  probeBadge.textContent = isApp ? '已正常连上 USB' : `正在升级模式 (${pidHex})`;

  $('probe-pid').textContent = `${pidHex} (${isApp ? '正常 APP' : p.target === 'main' ? '主控 IAP' : '屏幕 IAP'})`;

  if (!isApp) {
    if (connEl) connEl.textContent = `键盘正处于「${p.target === 'main' ? '主控' : '屏幕'}升级模式」，可直接继续写入或恢复`;
    if (chipEl) chipEl.textContent = '升级模式下暂不可检查';
    if (funcEl) funcEl.textContent = '等待刷写完成';
    if (cfEl) cfEl.textContent = '写完自动回到正常模式';
    $('probe-main').textContent = 'IAP 模式下不可查询';
    $('probe-ips').textContent = 'IAP 模式下不可查询';
    $('probe-silicon').textContent = 'IAP 模式下不可查询';
    $('probe-clock').textContent = '--';
    $('probe-ui-active').textContent = '--';
    $('probe-font-crc').textContent = '--';
    $('probe-lyrics-caps').textContent = '--';
  } else {
    const ly = p.lyrics || {};
    if (connEl) connEl.textContent = ' 已通过 USB 有线连接成功';
    if (chipEl) {
      if (p.flashKiB === 1024 && p.series === 13) {
        chipEl.textContent = ' 大容量可升级屏幕（支持三模共存）';
      } else if (p.flashKiB !== null && p.series !== null) {
        chipEl.textContent = `ℹ 检测到 ${p.flashKiB}KiB / 系列 ${p.series}（仅建议装基础屏幕版）`;
      } else {
        chipEl.textContent = ' 当前为出厂屏幕，点「开始写入」时会自动核对芯片';
      }
    }
    if (funcEl) {
      if (p.ipsCap !== IPS_CAP) {
        funcEl.textContent = '还是官方原厂固件';
      } else if (ly.supported) {
        funcEl.textContent = '已装歌词版，支持的模板见下方';
      } else {
        funcEl.textContent = '已装基础屏幕版（省心免后台）';
      }
    }
    if (cfEl) {
      const clockStr = p.clockValid === true ? '已校时' : p.clockValid === false ? '尚未对时' : '时间未知';
      const fontStr = ly.supported ? (ly.fontReady ? '中文字库已就绪' : ly.fontInitializing ? '字库初始化中' : '字库未就绪') : '无需字库';
      cfEl.textContent = `${clockStr} · ${fontStr}`;
    }

    $('probe-main').textContent = p.mainCap === MAIN_CAP ? 'V7.1 (0x4350)' : `非本版 (0x${Number(p.mainCap ?? 0).toString(16)})`;
    $('probe-ips').textContent = p.ipsCap === IPS_CAP
      ? (ly.supported ? 'L6 + LY1 歌词扩展' : 'L6 基础版 (0x5536)')
      : `未知 / 原厂 (0x${Number(p.ipsCap ?? 0).toString(16)})`;
    $('probe-silicon').textContent = (p.flashKiB !== null && p.series !== null)
      ? `${p.flashKiB}KiB / 系列 ${p.series}`
      : '未读到（需先刷本版 L6）';
    $('probe-clock').textContent = p.clockValid === true ? '有效 (已校时)' : p.clockValid === false ? '未校时 (无效)' : '未知';
    $('probe-ui-active').textContent = p.uiActive === true ? '已激活 S1 (1)' : p.uiActive === false ? '未确认激活 (0)' : '未知';

    const targetCrc = getFontBodyCrcHint();
    if (!ly.supported) {
      $('probe-font-crc').textContent = '不适用 (非歌词固件)';
    } else if (ly.fontCrc !== null && ly.fontCrc !== undefined) {
      const matchNote = targetCrc !== null
        ? (ly.fontCrc === targetCrc ? ' · 与目标字库一致' : ` · 不匹配目标 (0x${targetCrc.toString(16)})`)
        : '';
      $('probe-font-crc').textContent = `${ly.fontReady ? '就绪' : ly.fontInitializing ? '初始化中' : '未就绪'} · 固件绑定 0x${ly.fontCrc.toString(16).padStart(8, '0')}${matchNote}`;
    } else {
      $('probe-font-crc').textContent = ly.fontReady ? '就绪' : '未就绪';
    }

    $('probe-lyrics-caps').textContent = ly.supported
      ? `模板 ${ly.layoutCount ?? 2} 套 · 封面 ${ly.coverSupported ? '支持' : '无'} · 音量 HUD ${ly.volumeSupported ? '支持' : '无'}`
      : '未启用歌词协议';
  }

  $('btn-disconnect-device').disabled = false;
  $('btn-quick-calibrate').disabled = !isApp;
  $('btn-quick-upload-gif').disabled = !isApp;
  $('btn-quick-delete-font').disabled = !isApp;
  syncOperationUi();
}

async function handleProbeDevice() {
  if (workbenchBusy()) return;
  await refreshBackgroundStatus();
  if (workbenchBusy()) return;
  if (state.bgStatus?.running || state.bgStatus?.unreachable) {
    $('probe-feedback').textContent = '歌词后台正在运行，请先点击上方「暂停歌词后台」，再连接键盘。';
    $('connection-occupancy').classList.remove('hidden');
    return;
  }
  state.operation = 'probe';
  state.runner = null;
  $('deploy-complete-box').classList.add('hidden');
  $('probe-feedback').textContent = '';
  await disconnectDevice({ silent: true });
  $('probe-badge').textContent = '正在读取设备状态…';
  syncOperationUi();
  appendDeployLog('正在请求 WebHID 设备授权并执行只读探测…');
  try {
    const probed = await probeDevice(null, { hid: navigator.hid, keepOpen: true });
    state.probeResult = probed;
    state.activeClient = probed.client || null;
    state.activeDevice = probed.device || null;
    if (probed.detectedBaseline) {
      state.baseline = probed.detectedBaseline;
      $('deploy-baseline').value = state.baseline;
      $('deploy-baseline').disabled = true;
      $('baseline-detected-note').textContent = `已自动识别：${MAIN_BASELINES[state.baseline].version}`;
    }
    if (state.scenario === 'first' && probed.ipsCap === IPS_CAP) {
      state.scenario = 'update';
      document.querySelectorAll('[data-scenario]').forEach(btn => btn.classList.toggle('active', btn.dataset.scenario === 'update'));
      $('probe-feedback').textContent = '检测到已安装自定义屏幕，已改为更新。没有选择替换的桌宠动画会保留。';
      $('probe-feedback').dataset.kind = 'info';
    }
    renderProbeTelemetry();
    recomputePlan();
    appendDeployLog(`探测完成：PID 0x${probed.pid.toString(16)} (${probed.mode.toUpperCase()})`);
  } catch (err) {
    $('probe-feedback').dataset.kind = 'error';
    $('probe-badge').textContent = '未完成连接';
    $('probe-feedback').textContent = `${err.message}。请确认 USB 有线模式，并退出 WOBHub 和其他驱动后重试。`;
    appendDeployLog(`探测失败：${err.message}`);
    showToast(`探测失败：${err.message}`, 4500);
  } finally {
    state.operation = null;
    syncOperationUi();
  }
}

async function disconnectDevice({ silent = false } = {}) {
  try {
    if (state.activeClient) await state.activeClient.close().catch(() => {});
    else if (state.activeDevice?.opened) await state.activeDevice.close().catch(() => {});
  } catch {
    // ignore close error
  }
  state.activeClient = null;
  state.activeDevice = null;
  state.probeResult = null;
  renderProbeTelemetry();
  recomputePlan();
  if (!silent) appendDeployLog('已断开设备连接。');
}

function appendDeployLog(line) {
  const el = $('deploy-log');
  if (!el) return;
  const stamp = new Date().toTimeString().slice(0, 8);
  el.textContent += `[${stamp}] ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

async function prepareRuntimeBundle(plan) {
  const bundle = {};
  const neededIds = new Set(plan.steps.filter(s => s.action === 'run').map(s => s.id));
  const { patch: baseKey, restore: restoreBaseKey } = MAIN_BASELINES[state.baseline];

  if (neededIds.has('flash_main')) {
    bundle.main = state.manualBundle.main || await loadBundleFirmwareEntry(baseKey, '主控固件 V7.1');
    if (!bundle.main) throw new Error('缺少主控固件 BIN 与 manifest.json（请使用发布包或在手动面板载入）');
  }
  if (neededIds.has('flash_ips_base')) {
    bundle.ipsBase = state.manualBundle.ipsBase || await loadBundleFirmwareEntry('ipsBase', '基础版 IPS');
    if (!bundle.ipsBase) throw new Error('缺少基础版 IPS BIN 与 manifest.json（请在手动面板载入）');
  }
  if (neededIds.has('flash_ips_lyrics')) {
    bundle.ipsLyrics = state.manualBundle.ipsLyrics || await loadBundleFirmwareEntry('ipsLyrics', '歌词版 IPS');
    if (!bundle.ipsLyrics) throw new Error('缺少歌词版 IPS BIN 与 manifest.json（请在手动面板载入）');
  }
  if (neededIds.has('flash_restore_main')) {
    bundle.restoreMain = state.manualBundle.restoreMain || await loadBundleFirmwareEntry(restoreBaseKey, '主控恢复镜像');
    if (!bundle.restoreMain) throw new Error('缺少主控恢复镜像 BIN 与 manifest.json');
  }
  if (neededIds.has('flash_restore_ips')) {
    bundle.restoreIps = state.manualBundle.restoreIps || await loadBundleFirmwareEntry('restoreIps', '屏幕恢复镜像');
    if (!bundle.restoreIps) throw new Error('缺少屏幕恢复镜像 BIN 与 manifest.json');
  }
  if (neededIds.has('upload_font')) {
    bundle.font = state.manualBundle.font || await loadBundleFont();
    if (!bundle.font) throw new Error('缺少 FONT.BIN 文件');
    if (state.manualBundle.previousFont) {
      bundle.previousFont = state.manualBundle.previousFont;
    }
  }
  if (neededIds.has('upload_gif')) {
    let gifBytes = state.gif.useForDeploy || state.themeModified ? state.gif.encodedBytes : null;
    if (!gifBytes) {
      const assetBytes = await loadBundleRobotAsset(state.themePresetId === 'custom' ? 'pink' : state.themePresetId);
      if (assetBytes) gifBytes = assetBytes;
    }
    if (!gifBytes && state.gif.composedFrames.length > 0) {
      gifBytes = encodeGif320x172(state.gif.composedFrames, { loop: true });
    }
    bundle.gif = gifBytes;
  }
  return bundle;
}

let lastAuthorizationKey = '';
function updateRunnerUi(snapshot, progressPayload = null) {
  const pill = $('runner-state-pill');
  const startBtn = $('btn-start-deploy');
  const abortBtn = $('btn-abort-deploy');
  const iapBox = $('iap-auth-box');
  const errBox = $('deploy-error-box');

  const statusMap = {
    idle: { text: '空闲', cls: 'pill-muted' },
    running: { text: '执行中', cls: 'pill-accent' },
    awaiting_iap_auth: { text: '请连接升级设备', cls: 'pill-warn' },
    awaiting_app_auth: { text: '等待键盘重连', cls: 'pill-warn' },
    failed: { text: '已失败中止', cls: 'pill-danger' },
    completed: { text: '全部完成', cls: 'pill-safe' },
    aborted: { text: '已手动中止', cls: 'pill-muted' }
  };
  const sm = statusMap[snapshot.status] || statusMap.idle;
  pill.className = `pill ${sm.cls}`;
  pill.textContent = sm.text;

  const isBusy = ['running', 'awaiting_iap_auth', 'awaiting_app_auth'].includes(snapshot.status);
  startBtn.disabled = Boolean(isBusy || state.currentPlan?.blocked || !state.currentPlan);
  abortBtn.disabled = !isBusy && snapshot.status !== 'failed';

  if (progressPayload) {
    $('deploy-progress-fill').style.width = `${progressPayload.percent}%`;
    $('deploy-progress-pct').textContent = `${progressPayload.percent}%`;
    const phase = progressPayload.phase || '';
    const step = state.runner?.plan.steps[snapshot.stepIndex];
    const chip = step?.target === 'main' ? '主控' : '屏幕';
    $('deploy-progress-text').textContent = phase.startsWith('flash:') ? `正在${phase.slice(6)}${chip}固件`
      : phase === 'awaiting_iap_auth' || phase === 'awaiting_app_auth' ? '请在下方连接设备，授权后继续'
      : phase === 'upload_font' ? '正在写入中文字库…'
      : phase === 'font_reused' ? '已复用现有字库，无需重新上传'
      : phase === 'font_ready' ? '字库已就绪'
      : phase === 'upload_gif' ? '正在保存桌宠动画…'
      : phase === 'skip' ? '正在核对已有功能…'
      : progressPayload.message || '';
  }

  // Highlight active step
  const items = document.querySelectorAll('#deploy-plan-steps .step-item');
  items.forEach((el, idx) => {
    el.classList.toggle('step-active', isBusy && idx === snapshot.stepIndex);
  });

  // IAP Pause Box
  if (['awaiting_iap_auth', 'awaiting_app_auth'].includes(snapshot.status) && snapshot.iapNeeded) {
    const pidStr = `0x${snapshot.iapNeeded.pid.toString(16)}`;
    const app = snapshot.status === 'awaiting_app_auth';
    $('iap-auth-title').textContent = app ? '等待键盘回到正常模式' : `已进入${snapshot.iapNeeded.target === 'main' ? '主控' : '屏幕'}升级模式`;
    $('iap-auth-desc').textContent = app
      ? '等待键盘重启，再点下方按钮。'
      : '键盘重启后，浏览器需要一次新授权。';
    $('btn-auth-iap').textContent = app ? '连接正常模式键盘并继续' : `连接${snapshot.iapNeeded.target === 'main' ? '主控' : '屏幕'}升级设备并继续`;
    iapBox.classList.remove('hidden');
    const authKey = `${snapshot.status}:${snapshot.stepIndex}`;
    if (authKey !== lastAuthorizationKey) {
      lastAuthorizationKey = authKey;
      requestAnimationFrame(() => {
        iapBox.scrollIntoView({ block: 'center', behavior: 'auto' });
        $('btn-auth-iap').focus({ preventScroll: true });
      });
    }
  } else {
    lastAuthorizationKey = '';
    iapBox.classList.add('hidden');
  }

  // Error Box
  if (snapshot.status === 'failed') {
    $('deploy-error-msg').textContent = snapshot.error || '未知错误';
    $('deploy-recovery-hint').textContent = snapshot.diagnostic?.recoveryHint || '';
    errBox.classList.remove('hidden');
    $('btn-recheck-font').classList.toggle('hidden', !['upload_font', 'verify_font', 'upload_gif'].includes(snapshot.diagnostic?.stepId));
  } else {
    errBox.classList.add('hidden');
    $('btn-recheck-font').classList.add('hidden');
  }
  if (snapshot.status === 'completed') {
    $('deploy-complete-box').classList.remove('hidden');
    $('btn-complete-background').classList.toggle('hidden', state.track === 'A' || state.scenario === 'restore');
    $('deploy-complete-copy').textContent = state.scenario === 'restore'
      ? '已完成清单中的官方固件恢复。请检查键盘输入与小屏显示。'
      : state.track === 'A' ? '请检查时钟、电量和按键显示。基础页无需电脑后台，可以关闭工作台。'
      : '请检查按键页与动画，再启动歌词后台。以后按 Ctrl + F8 切换按键页与播放器。';
    state.activeClient = null;
    state.activeDevice = null;
  }
  syncOperationUi();
}

async function handleStartDeploy() {
  if (!state.currentPlan || state.currentPlan.blocked) return;
  if (workbenchBusy()) {
    showToast('部署任务正在进行中，请勿重复点击');
    return;
  }
  await refreshBackgroundStatus();
  if (workbenchBusy()) return;
  if (state.bgStatus?.running || state.bgStatus?.unreachable) {
    showToast('请先暂停歌词后台，再开始安装');
    return;
  }
  const plan = state.currentPlan;
  const intent = buildDeployIntent();
  state.operation = 'prepare';
  syncOperationUi();
  try {
    appendDeployLog('正在准备并校验固件与素材…');
    const runtimeBundle = await prepareRuntimeBundle(plan);

    // Clone plan with fresh device handle if IAP already open
    const appClient = state.probeResult?.mode === 'app' ? state.activeClient : null;
    state.activeClient = null;

    let lastProgressKey = '';
    let lastFlashLogPct = -1;
    const runner = new DeploymentRunner({
      plan,
      bundle: runtimeBundle,
      intent,
      hid: navigator.hid,
      appClient,
      onProgress: info => {
        const key = `${info.percent}|${info.message}`;
        if (key === lastProgressKey) return;
        lastProgressKey = key;
        updateRunnerUi(info, info);
        if (info.stage?.startsWith('flash:') && info.percent < 100 && Math.abs(info.percent - lastFlashLogPct) < 10) {
          return;
        }
        lastFlashLogPct = info.percent;
        appendDeployLog(`${info.percent}% · ${info.message}`);
      },
      onStateChange: snap => {
        updateRunnerUi(snap);
      }
    });
    state.runner = runner;
    state.operation = null;
    updateRunnerUi(runner.snapshot(), { percent: 0, message: '启动部署流程…' });

    const outcome = await runner.start();
    if (outcome?.status === 'completed') {
      updateRunnerUi(runner.snapshot(), { percent: 100, message: '部署与核对已全部完成' });
      appendDeployLog('部署与核对已全部完成！');
      showToast('部署与核对已全部完成！');
      state.previousBaseline = state.baseline;
      if (outcome.manualReminders?.length > 0) {
        for (const mr of outcome.manualReminders) {
          appendDeployLog(`[手动提醒] ${mr.title}：${mr.reason}`);
        }
      }
      // Re-probe quietly if device stays connected via getDevices or wait for user
      renderProbeTelemetry();
    }
  } catch (err) {
    appendDeployLog(`[失败] ${err.message}`);
    if (state.runner) updateRunnerUi(state.runner.snapshot());
    showToast(`部署停止：${err.message}`, 5000);
  } finally {
    state.operation = null;
    syncOperationUi();
  }
}

async function handleAuthorizeIap() {
  if (!state.runner || !['awaiting_iap_auth', 'awaiting_app_auth'].includes(state.runner.status)) return;
  try {
    appendDeployLog(`正在授权 IAP 设备 0x${state.runner.iapNeeded.pid.toString(16)} 并继续刷写…`);
    const outcome = await state.runner.authorizeIapAndContinue();
    if (outcome?.status === 'completed') {
      updateRunnerUi(state.runner.snapshot(), { percent: 100, message: 'IAP 烧录与后续核对全部完成' });
      appendDeployLog('IAP 烧录与后续核对全部完成！');
      showToast('IAP 烧录与后续核对全部完成！');
      state.previousBaseline = state.baseline;
    }
  } catch (err) {
    appendDeployLog(`[IAP 失败] ${err.message}`);
    updateRunnerUi(state.runner.snapshot());
    showToast(`刷写失败：${err.message}`, 5000);
  }
}

async function handleRetryStep() {
  if (!state.runner || state.runner.status !== 'failed') return;
  await refreshBackgroundStatus();
  if (workbenchBusy()) return;
  if (state.bgStatus?.running || state.bgStatus?.unreachable) {
    showToast('请先暂停歌词后台，再重试当前步骤');
    return;
  }
  try {
    appendDeployLog('用户手动触发：重试当前失败步骤…');
    const outcome = await state.runner.retryCurrentStep();
    if (outcome?.status === 'completed') {
      showToast('重试成功，部署已完成！');
    }
  } catch (err) {
    appendDeployLog(`[重试失败] ${err.message}`);
    updateRunnerUi(state.runner.snapshot());
  }
}

async function handleAbortDeploy(alsoDisconnect = false) {
  if (state.runner) {
    try { await state.runner.abort(); } catch (err) { showToast(err.message); return; }
    updateRunnerUi(state.runner.snapshot(), { percent: 0, message: '部署已中止' });
    appendDeployLog('部署流程已安全中止。');
  }
  if (alsoDisconnect) {
    await disconnectDevice();
  }
}

async function ensureActiveAppClientForQuickTool() {
  if (state.runner?.appClient && state.runner.status === 'failed') return state.runner.appClient;
  if (state.activeClient) return state.activeClient;
  const probed = await probeDevice(null, { hid: navigator.hid, keepOpen: true });
  if (probed.mode !== 'app' || !probed.client) {
    if (probed.device?.opened) await probed.device.close().catch(() => {});
    throw new Error('当前设备处于 IAP 升级模式，无法执行 APP 快捷指令');
  }
  state.probeResult = probed;
  state.activeClient = probed.client;
  state.activeDevice = probed.device;
  renderProbeTelemetry();
  return probed.client;
}

async function handleCheckFont() {
  if (workbenchBusy()) return;
  await refreshBackgroundStatus();
  if (workbenchBusy()) return;
  if (state.bgStatus?.running || state.bgStatus?.unreachable) {
    showToast('请先暂停歌词后台，再检查字库');
    return;
  }
  state.operation = 'check-font'; syncOperationUi();
  try {
    const client = await ensureActiveAppClientForQuickTool();
    // A lost OP2 reply can leave rendering paused. Resume before queuing initialization.
    await client.control(5);
    const font = await client.inspectFont();
    if (state.probeResult) state.probeResult.lyrics = {
      ...state.probeResult.lyrics, supported: true, fontReady: font.settled ? font.ready : null,
      fontInitializing: !font.settled, fontCrc: font.expectedBodyCrc, error: font.error
    };
    renderProbeTelemetry();
    const targetCrc = getFontBodyCrcHint();
    if (!font.ready) throw new Error(font.settled
      ? `现有字库未通过初始化（状态 ${font.error}），未上传或删除文件`
      : '字库仍在初始化，请确认屏幕为 GIF / 槽位 1 后再次检查');
    if (targetCrc !== null && font.expectedBodyCrc !== targetCrc) throw new Error('屏幕固件绑定的字库与此安装包不同，请核对版本');
    const message = state.runner?.status === 'failed'
      ? '显示已恢复，现有字库可用。点击“再试一次这一步”继续。'
      : '显示已恢复，现有字库可用，无需重新上传。';
    if (state.runner?.status === 'failed') $('deploy-recovery-hint').textContent = message;
    else recomputePlan();
    appendDeployLog(message);
    showToast(message, 5000);
  } catch (err) {
    appendDeployLog(`[字库检查] ${err.message}`);
    if (state.runner?.status === 'failed') $('deploy-recovery-hint').textContent = err.message;
    showToast(err.message, 5000);
  } finally {
    state.operation = null; syncOperationUi();
  }
}

async function handleQuickCalibrate() {
  if (workbenchBusy()) return;
  state.operation = 'calibrate'; syncOperationUi();
  try {
    const tz = $('quick-timezone').value.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
    const client = await ensureActiveAppClientForQuickTool();
    appendDeployLog(`正在同步本地时区 (${tz}) 时间并核对主控与屏幕读回…`);
    const s = await client.calibrate({ timeZone: tz });
    if (state.probeResult) state.probeResult.clockValid = s.valid;
    renderProbeTelemetry();
    recomputePlan();
    appendDeployLog(`校时通过：屏幕时间 ${s.screenTime?.text || '--'}，主控已确认有效`);
    showToast(`校时通过 (${s.screenTime?.text || tz})`);
  } catch (err) {
    appendDeployLog(`[校时失败] ${err.message}`);
    showToast(`校时失败：${err.message}`, 4500);
  } finally {
    state.operation = null; syncOperationUi();
  }
}

async function handleQuickUploadGif({ confirmCheckboxId }) {
  if (workbenchBusy()) return;
  state.operation = 'upload'; syncOperationUi();
  try {
    if (!$(confirmCheckboxId).checked) {
      throw new Error('请先勾选确认覆盖键盘 S1 槽位');
    }
    let gifBytes = state.gif.encodedBytes;
    if (!gifBytes && state.gif.composedFrames.length > 0) {
      gifBytes = encodeGif320x172(state.gif.composedFrames, { loop: state.gif.loop });
    }
    if (!gifBytes) throw new Error('当前工作室尚未生成可写入的 320×172 GIF');
    validateGif(gifBytes);
    auditDeviceGif(gifBytes, state.track === 'A' ? null : state.theme);

    const client = await ensureActiveAppClientForQuickTool();
    appendDeployLog(`正在向键盘 S1 槽位写入 ${gifBytes.length} 字节 GIF…`);
    await client.upload(gifBytes, {
      replaceConfirmed: true,
      progress: p => {
        $('deploy-progress-fill').style.width = `${Math.round(p * 100)}%`;
        $('deploy-progress-pct').textContent = `${Math.round(p * 100)}%`;
        $('deploy-progress-text').textContent = `上传 S1 GIF ${Math.round(p * 100)}%`;
      }
    });
    appendDeployLog('S1 GIF 上传已应答，请查看键盘屏幕效果。');
    showToast('定制 GIF 已成功写入键盘 S1 槽位');
  } catch (err) {
    appendDeployLog(`[GIF 写入失败] ${err.message}`);
    showToast(`GIF 写入失败：${err.message}`, 4500);
  } finally {
    state.operation = null; syncOperationUi();
  }
}

async function handleQuickDeleteFont() {
  if (workbenchBusy()) return;
  state.operation = 'font'; syncOperationUi();
  try {
    if (!$('quick-confirm-del-font').checked) {
      throw new Error('请先勾选明确确认仅删除屏内 FONT.BIN');
    }
    const fontBytes = state.manualBundle.previousFont || state.manualBundle.font || await loadBundleFont();
    if (!fontBytes) {
      throw new Error('缺少用于头部校验的 FONT.BIN，请在「离线/开发模式手动文件」中选择对应字库');
    }
    const client = await ensureActiveAppClientForQuickTool();
    appendDeployLog('正在核对 FONT.BIN 头部并仅删除屏内字库（保留 GIF 素材）…');
    await client.deleteFont(fontBytes, { deleteConfirmed: true });
    if (state.probeResult?.lyrics) state.probeResult.lyrics.fontReady = false;
    renderProbeTelemetry();
    recomputePlan();
    appendDeployLog('屏内 FONT.BIN 已安全删除，GIF 槽位保持不变。');
    showToast('FONT.BIN 已删除');
  } catch (err) {
    appendDeployLog(`[删除字库失败] ${err.message}`);
    showToast(`删除字库失败：${err.message}`, 4500);
  } finally {
    state.operation = null; syncOperationUi();
  }
}

// ==================== MANUAL BUNDLE LOADERS ====================

function wireManualPair(binInputId, manifestInputId, slotKey, statusId) {
  let pendingBin = null;
  let pendingManifest = null;
  const checkReady = async () => {
    const statusEl = $(statusId);
    if (!pendingBin && !pendingManifest) return;
    if (!pendingBin || !pendingManifest) {
      statusEl.textContent = pendingBin ? `已选 BIN (${pendingBin.length} B)，等待 manifest.json` : '已选 manifest.json，等待 .bin';
      return;
    }
    try {
      const plan = await validateBuild(pendingBin, pendingManifest);
      const expectedTarget = ['main', 'restoreMain'].includes(slotKey) ? 'main' : 'ips';
      if (plan.target !== expectedTarget || slotKey === 'ipsLyrics' && plan.variant !== 'lyrics-v1' || slotKey === 'ipsBase' && plan.variant) {
        throw new Error('文件属于另一种目标芯片或屏幕版本，请选择本栏对应的固件');
      }
      state.manualBundle[slotKey] = { bytes: pendingBin, manifest: pendingManifest };
      statusEl.textContent = `校验通过：${plan.target}${plan.variant ? ' / ' + plan.variant : ''} (${pendingBin.length} B · SHA ${plan.sha256.slice(0, 12)}…)`;
      updateR75tBanner();
      recomputePlan();
    } catch (err) {
      state.manualBundle[slotKey] = null;
      statusEl.textContent = `校验失败：${err.message}`;
    }
  };
  $(binInputId)?.addEventListener('change', async e => {
    const f = e.target.files?.[0];
    pendingBin = f ? new Uint8Array(await f.arrayBuffer()) : null;
    await checkReady();
  });
  $(manifestInputId)?.addEventListener('change', async e => {
    const f = e.target.files?.[0];
    if (!f) {
      pendingManifest = null;
    } else {
      try {
        pendingManifest = JSON.parse(await f.text());
      } catch (err) {
        $(statusId).textContent = `JSON 解析失败：${err.message}`;
        pendingManifest = null;
      }
    }
    await checkReady();
  });
}

// ==================== WINDOWS BACKGROUND IPC ====================

function isSafeLocalBridgeUrl(u) {
  if (typeof u !== 'string') return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

async function refreshBackgroundStatus() {
  const badge = $('bg-status-badge');
  const ovText = $('overview-bg-text');
  const setControlsDisabled = (isHttp, st) => {
    const running = Boolean(st?.running || st?.unreachable);
    $('btn-bg-refresh').disabled = !isHttp;
    $('btn-bg-start').disabled = !isHttp || running;
    $('btn-bg-open-console').disabled = !isHttp || !running || !isSafeLocalBridgeUrl(st?.url);
    $('btn-bg-startup-enable').disabled = !isHttp;
    $('btn-bg-startup-disable').disabled = !isHttp;
    $('bg-startup-toggle').disabled = !isHttp || workbenchBusy();
    $('bg-startup-toggle').checked = Boolean(st?.startupEnabled);
    $('btn-bg-stop').disabled = !isHttp || !running;
    $('btn-overview-bg-start').disabled = !isHttp || running;
    $('btn-overview-bg-stop').disabled = !isHttp || !running;
    $('btn-deploy-bg-stop').disabled = !isHttp || !running || workbenchBusy();
    $('btn-bg-apply-design').disabled = !isHttp || running || workbenchBusy();
    $('btn-complete-background').disabled = !isHttp || running || workbenchBusy();
    $('connection-occupancy').classList.toggle('hidden', !running);
    syncOperationUi();
  };

  if (window.location.protocol === 'file:') {
    state.bgApiAvailable = false;
    state.bgStatus = null;
    if (badge) {
      badge.className = 'pill pill-warn';
      badge.textContent = 'file:// 静态模式';
    }
    if (ovText) ovText.textContent = '静态文件模式（请通过 1-打开工作台（推荐点我）.cmd 启动后台联控）';
    $('bg-running').textContent = '无法直连本地 IPC（请通过本地工作台启动）';
    setControlsDisabled(false, null);
    return;
  }

  try {
    const res = await fetch('/api/background/status', { method: 'GET', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const st = await res.json();
    state.bgApiAvailable = true;
    state.bgStatus = st;

    const runningText = st.unreachable ? '后台未响应' : st.running ? `运行中${st.demo ? ' (演示模式)' : ''}` : '未运行';
    if (ovText) {
      ovText.textContent = st.unreachable ? '后台未响应，USB 占用尚未确认' : st.running
        ? `运行中 (PID ${st.pid} · ${st.connected ? '已连键盘 HID' : '未占用键盘 HID'})`
        : '本套件后台未运行（其他驱动需自行退出）';
    }
    badge.className = st.unreachable ? 'pill pill-warn' : st.running ? 'pill pill-safe' : 'pill pill-muted';
    badge.textContent = runningText;

    $('bg-running').textContent = runningText;
    $('bg-pid').textContent = st.pid ? String(st.pid) : '--';
    $('bg-url').textContent = st.url || '--';
    $('bg-hid').textContent = st.unreachable ? '占用未确认' : st.running
      ? (st.connected ? '已占用键盘 USB HID（刷机前请先退出后台）' : '后台运行中，当前未连接键盘')
      : '未占用';
    $('bg-mode-layout').textContent = st.running
      ? `模式 ${st.mode ?? '--'} / 模板 ${st.layout ?? '--'}`
      : '--';
    $('bg-startup').textContent = st.startupEnabled ? '已开启' : '未开启';

    setControlsDisabled(true, st);
  } catch {
    state.bgApiAvailable = false;
    state.bgStatus = null;
    if (ovText) ovText.textContent = '本地后台接口不可用（仅静态托管）';
    if (badge) {
      badge.className = 'pill pill-muted';
      badge.textContent = '接口未连接';
    }
    setControlsDisabled(false, null);
  }
}

async function postBackgroundAction(endpoint, bodyObj = {}) {
  const feedback = $('bg-action-feedback');
  try {
    if (workbenchBusy()) throw new Error('设备操作进行中，请等待完成');
    if (endpoint === '/api/background/start') await disconnectDevice({ silent: true });
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `请求失败 (${res.status})`);
    }
    await refreshBackgroundStatus();
    if (feedback) feedback.textContent = data.message || '操作成功';
    return data;
  } catch (err) {
    if (feedback) feedback.textContent = `操作失败：${err.message}`;
    showToast(`后台操作失败：${err.message}`, 4500);
    return null;
  }
}

async function startBackgroundFromDesign() {
  if (workbenchBusy()) return;
  const settings = { ...getCurrentPlayerSettings(), mode: state.track === 'A' ? 0 : 1 };
  const result = await postBackgroundAction('/api/background/start', { settings });
  if (result) {
    switchTab('background');
    showToast('已保存当前播放器样式并启动后台');
  }
}

// ==================== WIRE ALL EVENTS & INIT ====================

function syncPreviewModeCControls() {
  for (const btn of document.querySelectorAll('.preview-size-btn')) {
    btn.classList.toggle('active', Number(btn.dataset.size) === state.preview.textSize);
  }
  for (const btn of document.querySelectorAll('.preview-style-btn')) {
    btn.classList.toggle('active', btn.dataset.style === state.preview.textStyle);
  }
  const crispSoftDisabled = state.preview.textSize !== 30;
  for (const btn of document.querySelectorAll('.preview-style-btn')) {
    btn.disabled = crispSoftDisabled;
  }
}

function wireEvents() {
  $('pet-ai-help').addEventListener('toggle', () => { if ($('pet-ai-help').open) refreshPetAiPrompt(); });
  $('pet-ai-idea').addEventListener('input', refreshPetAiPrompt);
  $('btn-copy-pet-prompt').addEventListener('click', async () => {
    const prompt = refreshPetAiPrompt();
    try {
      await navigator.clipboard.writeText(prompt);
      $('pet-ai-feedback').textContent = '已复制，粘贴给你的 AI 即可';
    } catch {
      $('pet-ai-prompt').focus(); $('pet-ai-prompt').select();
      const copied = document.execCommand('copy');
      $('pet-ai-feedback').textContent = copied ? '已复制，粘贴给你的 AI 即可' : '已选中文本，请按 Ctrl + C 复制';
    }
  });
  $('btn-download-pet-prompt').addEventListener('click', () => downloadBlob(refreshPetAiPrompt(), 'text/plain;charset=utf-8', 'rainy75-pet-prompt.txt'));
  document.querySelectorAll('[data-goal]').forEach(btn => btn.addEventListener('click', () => selectTrack(btn.dataset.goal)));
  $('btn-workspace-help').addEventListener('click', () => {
    const open = $('workspace-help').classList.toggle('hidden') === false;
    document.body.classList.toggle('show-help', open);
    $('btn-workspace-help').setAttribute('aria-expanded', String(open));
  });
  $('bg-startup-toggle').addEventListener('change', event => postBackgroundAction('/api/background/startup', { enabled: event.target.checked }));
  const appearanceBtn = $('btn-appearance');
  const updateAppearance = () => { appearanceBtn.textContent = document.documentElement.dataset.appearance === 'dark' ? '页面：深色' : '页面：浅色'; };
  updateAppearance();
  appearanceBtn.addEventListener('click', () => {
    const value = document.documentElement.dataset.appearance === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.appearance = value;
    try { localStorage.setItem('rainy75-appearance', value); } catch {}
    updateAppearance();
  });
  $('btn-deploy-bg-stop').addEventListener('click', () => postBackgroundAction('/api/background/stop'));
  $('btn-complete-background').addEventListener('click', startBackgroundFromDesign);
  $('btn-bg-apply-design').addEventListener('click', startBackgroundFromDesign);
  $('btn-complete-overview').addEventListener('click', () => switchTab('overview'));
  window.addEventListener('beforeunload', event => {
    if (workbenchBusy()) { event.preventDefault(); event.returnValue = ''; }
  });
  // Navigation Tabs
  const tabs = [...document.querySelectorAll('.tab-btn')];
  for (const [index, btn] of tabs.entries()) {
    btn.setAttribute('aria-controls', `panel-${btn.dataset.tab}`);
    btn.tabIndex = index === 0 ? 0 : -1;
    $(`panel-${btn.dataset.tab}`).setAttribute('aria-labelledby', btn.id);
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    btn.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
      switchTab(tabs[next].dataset.tab); tabs[next].focus();
    });
  }

  // Hero Ctrl+F8 Coexistence Stage & Interactive Card Toys
  $('btn-hero-ctrlf8')?.addEventListener('click', () => {
    heroSlideIdx = (heroSlideIdx + 1) % HERO_SLIDES.length;
    setHeroSlide(HERO_SLIDES[heroSlideIdx].id, { restartTimer: true });
  });
  $('btn-hero-autoplay')?.addEventListener('click', () => {
    heroAutoplay = !heroAutoplay;
    $('btn-hero-autoplay').textContent = heroAutoplay ? '暂停轮播' : '自动轮播';
    if (heroAutoplay) scheduleHeroAutoplay();
    else clearInterval(heroAutoplayTimer);
  });
  for (const dot of document.querySelectorAll('[data-hero-slide]')) {
    dot.addEventListener('click', () => setHeroSlide(dot.dataset.heroSlide, { restartTimer: true }));
  }
  $('btn-hero-next-gif')?.addEventListener('click', () => switchTab('gif'));
  $('btn-hero-direct-deploy')?.addEventListener('click', () => switchTab('deploy'));

  for (const btn of document.querySelectorAll('[data-card-a-demo]')) {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      selectTrack('A');
      setCardARobotDemo(btn.dataset.cardADemo);
      setHeroSlide('keys', { restartTimer: true });
    });
  }
  for (const btn of document.querySelectorAll('[data-card-key]')) {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      selectTrack('A');
      const k = Number(btn.dataset.cardKey);
      state.preview.key = k;
      if ($('preview-key-select')) $('preview-key-select').value = String(k);
      for (const b of document.querySelectorAll('[data-card-a-demo]')) b.classList.remove('active');
      for (const b of document.querySelectorAll('[data-card-key]')) b.classList.toggle('active', b === btn);
      showCardACustomCanvas(k);
    });
  }
  for (const btn of document.querySelectorAll('[data-card-b-layout]')) {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const layout = btn.dataset.cardBLayout;
      selectTrack('B');
      setCardBLayoutDemo(layout);
      setPreviewView(layout);
      setHeroSlide(layout, { restartTimer: true });
    });
  }
  for (const btn of document.querySelectorAll('[data-card-c-size]')) {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      selectTrack('C');
      state.preview.textSize = Number(btn.dataset.cardCSize);
      syncPreviewModeCControls();
      for (const b of document.querySelectorAll('[data-card-c-size]')) {
        b.classList.toggle('active', b === btn);
      }
      updateCardCDemo({ volumeOn: cardCVolDemoOn, useCustomCanvas: state.preview.textSize !== 30 });
      renderScreenPreviewCanvas();
    });
  }
  $('btn-card-c-vol-demo')?.addEventListener('click', e => {
    e.stopPropagation();
    selectTrack('C');
    const nextVol = !cardCVolDemoOn;
    updateCardCDemo({ volumeOn: nextVol, useCustomCanvas: state.preview.textSize !== 30 });
    setHeroSlide(nextVol ? 'volume' : 'layout4', { restartTimer: true });
  });

  // Overview Track Cards & Quick Jumps
  for (const card of document.querySelectorAll('.track-card')) {
    card.addEventListener('click', () => selectTrack(card.dataset.track));
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectTrack(card.dataset.track);
      }
    });
  }
  $('btn-goto-deploy').addEventListener('click', () => switchTab('deploy'));
  $('btn-goto-theme').addEventListener('click', () => switchTab('theme'));
  $('btn-goto-gif').addEventListener('click', () => switchTab('gif'));
  $('btn-goto-background').addEventListener('click', () => switchTab('background'));
  $('btn-overview-bg-start').addEventListener('click', () => postBackgroundAction('/api/background/start'));
  $('btn-overview-bg-stop').addEventListener('click', () => postBackgroundAction('/api/background/stop'));

  // Deploy Config
  for (const btn of document.querySelectorAll('[data-scenario]')) {
    btn.addEventListener('click', () => {
      state.scenario = btn.dataset.scenario;
      for (const b of document.querySelectorAll('[data-scenario]')) {
        b.classList.toggle('active', b === btn);
      }
      $('restore-honest-banner')?.classList.toggle('hidden', state.scenario !== 'restore');
      $('restore-target-wrap').classList.toggle('hidden', state.scenario !== 'restore');
      $('deploy-options-grid').classList.toggle('hidden', state.scenario === 'restore');
      recomputePlan();
    });
  }
  $('deploy-baseline').addEventListener('change', e => {
    if (state.baseline !== e.target.value) {
      state.previousBaseline = state.baseline;
      state.baseline = e.target.value;
      recomputePlan();
    }
  });
  $('deploy-restore-target').addEventListener('change', e => {
    state.restoreTarget = e.target.value;
    recomputePlan();
  });
  for (const id of ['opt-force-main', 'opt-force-ips', 'opt-force-font', 'opt-skip-gif', 'opt-skip-calibrate']) {
    $(id).addEventListener('change', recomputePlan);
  }

  // Device Probe & Runner
  $('btn-probe-device').addEventListener('click', handleProbeDevice);
  $('btn-disconnect-device').addEventListener('click', () => disconnectDevice());
  $('btn-start-deploy').addEventListener('click', handleStartDeploy);
  $('btn-auth-iap').addEventListener('click', handleAuthorizeIap);
  $('btn-retry-step').addEventListener('click', handleRetryStep);
  $('btn-recheck-font').addEventListener('click', handleCheckFont);
  $('btn-switch-restore').addEventListener('click', () => {
    document.querySelector('[data-scenario="restore"]').click();
  });
  $('btn-abort-deploy').addEventListener('click', () => handleAbortDeploy(false));
  $('btn-abort-disconnect').addEventListener('click', () => handleAbortDeploy(true));
  $('btn-clear-log').addEventListener('click', () => { $('deploy-log').textContent = ''; });

  // Quick Tools
  $('btn-quick-calibrate').addEventListener('click', handleQuickCalibrate);
  $('btn-quick-upload-gif').addEventListener('click', () => handleQuickUploadGif({ confirmCheckboxId: 'quick-confirm-gif' }));
  $('btn-quick-delete-font').addEventListener('click', handleQuickDeleteFont);
  $('btn-quick-check-font').addEventListener('click', handleCheckFont);

  // Manual Bundle
  wireManualPair('manual-main-bin', 'manual-main-manifest', 'main', 'manual-main-status');
  wireManualPair('manual-ips-base-bin', 'manual-ips-base-manifest', 'ipsBase', 'manual-ips-base-status');
  wireManualPair('manual-ips-lyrics-bin', 'manual-ips-lyrics-manifest', 'ipsLyrics', 'manual-ips-lyrics-status');
  wireManualPair('manual-restore-main-bin', 'manual-restore-main-manifest', 'restoreMain', 'manual-restore-status');
  wireManualPair('manual-restore-ips-bin', 'manual-restore-ips-manifest', 'restoreIps', 'manual-restore-status');

  $('manual-font-bin').addEventListener('change', async e => {
    const f = e.target.files?.[0];
    if (!f) { state.manualBundle.font = null; return; }
    try {
      const b = new Uint8Array(await f.arrayBuffer());
      const info = validateFont(b);
      state.manualBundle.font = b;
      $('manual-font-status').textContent = `已加载新字库：${info.count} 字形 · CRC 0x${info.bodyCrc.toString(16)}`;
      recomputePlan();
    } catch (err) {
      state.manualBundle.font = null;
      $('manual-font-status').textContent = `字库校验失败：${err.message}`;
    }
  });
  $('manual-prev-font-bin').addEventListener('change', async e => {
    const f = e.target.files?.[0];
    if (!f) { state.manualBundle.previousFont = null; return; }
    try {
      const b = new Uint8Array(await f.arrayBuffer());
      const info = validateFont(b);
      state.manualBundle.previousFont = b;
      $('manual-font-status').textContent += ` ｜ 旧字库 CRC 0x${info.bodyCrc.toString(16)}`;
    } catch (err) {
      state.manualBundle.previousFont = null;
      $('manual-font-status').textContent = `旧字库校验失败：${err.message}`;
    }
  });

  // GIF Studio
  $('gif-file-input').addEventListener('change', e => handleGifFileSelected(e.target.files?.[0]));
  for (const btn of document.querySelectorAll('[data-robot]')) {
    btn.addEventListener('click', () => loadPresetRobot(btn.dataset.robot));
  }
  for (const btn of document.querySelectorAll('[data-place]')) {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.place;
      state.gif.placementPreset = preset;
      if (preset === 'pet-right') {
        state.gif.overlayBezel = true;
        state.gif.fit = 'contain';
      } else if (preset === 'center') {
        state.gif.overlayBezel = false;
        state.gif.fit = 'contain';
      } else {
        state.gif.overlayBezel = false;
        state.gif.fit = 'cover';
      }
      syncGifControlsFromState();
      recomposeGif({ immediateEncode: true });
    });
  }
  $('gif-fit').addEventListener('change', e => { state.gif.fit = e.target.value; recomposeGif({ immediateEncode: true }); });
  $('gif-max-frames').addEventListener('change', e => {
    const n = Math.max(1, Math.min(60, Math.round(Number(e.target.value) || 60)));
    state.gif.maxFrames = n;
    e.target.value = String(n);
    recomposeGif({ immediateEncode: true });
  });
  $('gif-scale').addEventListener('input', e => {
    state.gif.scale = Number(e.target.value);
    $('gif-scale-val').textContent = `${state.gif.scale.toFixed(2)}x`;
    recomposeGif();
  });
  $('gif-scale').addEventListener('change', () => recomposeGif({ immediateEncode: true }));
  $('gif-offset-x').addEventListener('input', e => {
    state.gif.offsetX = Number(e.target.value);
    $('gif-offsetx-val').textContent = String(state.gif.offsetX);
    recomposeGif();
  });
  $('gif-offset-x').addEventListener('change', () => recomposeGif({ immediateEncode: true }));
  $('gif-offset-y').addEventListener('input', e => {
    state.gif.offsetY = Number(e.target.value);
    $('gif-offsety-val').textContent = String(state.gif.offsetY);
    recomposeGif();
  });
  $('gif-offset-y').addEventListener('change', () => recomposeGif({ immediateEncode: true }));
  $('gif-flip-x').addEventListener('change', e => { state.gif.flipX = e.target.checked; recomposeGif({ immediateEncode: true }); });
  $('gif-overlay-bezel').addEventListener('change', e => { state.gif.overlayBezel = e.target.checked; recomposeGif({ immediateEncode: true }); });
  $('gif-enable-alpha').addEventListener('change', e => { state.gif.enableAlpha = e.target.checked; recomposeGif({ immediateEncode: true }); });
  $('gif-bg-mode').addEventListener('change', e => {
    state.gif.bgMode = e.target.value;
    $('gif-custom-bg-wrap').classList.toggle('hidden', state.gif.bgMode !== 'custom');
    recomposeGif({ immediateEncode: true });
  });
  $('gif-custom-bg').addEventListener('input', e => {
    state.gif.customBg = e.target.value;
    recomposeGif();
  });
  $('gif-custom-bg').addEventListener('change', () => recomposeGif({ immediateEncode: true }));
  $('gif-bg-blur').addEventListener('change', e => { state.gif.bgBlur = e.target.checked; recomposeGif({ immediateEncode: true }); });

  $('gif-chroma-enabled').addEventListener('change', e => { state.gif.chromaEnabled = e.target.checked; recomposeGif({ immediateEncode: true }); });
  $('gif-chroma-color').addEventListener('input', e => {
    state.gif.chromaKeyColor = e.target.value;
    $('gif-chroma-hex').value = e.target.value;
    if (state.gif.chromaEnabled) recomposeGif({ immediateEncode: true });
  });
  $('gif-chroma-hex').addEventListener('change', e => {
    try {
      const hex = normalizeHex(e.target.value, 'chromaKeyColor');
      state.gif.chromaKeyColor = hex;
      $('gif-chroma-color').value = hex;
      if (state.gif.chromaEnabled) recomposeGif({ immediateEncode: true });
    } catch {
      e.target.value = state.gif.chromaKeyColor;
    }
  });
  $('gif-chroma-tolerance').addEventListener('input', e => {
    state.gif.chromaKeyTolerance = Number(e.target.value);
    $('gif-chroma-tol-val').textContent = String(state.gif.chromaKeyTolerance);
    if (state.gif.chromaEnabled) recomposeGif();
  });
  $('gif-chroma-tolerance').addEventListener('change', () => { if (state.gif.chromaEnabled) recomposeGif({ immediateEncode: true }); });

  $('btn-gif-eyedropper').addEventListener('click', () => toggleEyedropper());
  $('gif-source-canvas').addEventListener('click', e => handleEyedropperPick($('gif-source-canvas'), e.clientX, e.clientY));
  $('gif-preview-canvas').addEventListener('click', e => handleEyedropperPick($('gif-preview-canvas'), e.clientX, e.clientY));

  // Direct canvas drag to move pet position & wheel to zoom
  const gifCanvas = $('gif-preview-canvas');
  let gifDragStart = null;
  gifCanvas?.addEventListener('pointerdown', e => {
    if (state.gif.eyedropper) return;
    gifDragStart = {
      x: e.clientX,
      y: e.clientY,
      ox: state.gif.offsetX,
      oy: state.gif.offsetY,
      moved: false
    };
    gifCanvas.setPointerCapture?.(e.pointerId);
  });
  gifCanvas?.addEventListener('pointermove', e => {
    if (!gifDragStart) return;
    const rect = gifCanvas.getBoundingClientRect();
    const dx = Math.round(((e.clientX - gifDragStart.x) * SCREEN_WIDTH) / Math.max(1, rect.width));
    const dy = Math.round(((e.clientY - gifDragStart.y) * SCREEN_HEIGHT) / Math.max(1, rect.height));
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) gifDragStart.moved = true;
    state.gif.offsetX = Math.max(-160, Math.min(160, gifDragStart.ox + dx));
    state.gif.offsetY = Math.max(-86, Math.min(86, gifDragStart.oy + dy));
    $('gif-offset-x').value = String(state.gif.offsetX);
    $('gif-offset-y').value = String(state.gif.offsetY);
    $('gif-offsetx-val').textContent = String(state.gif.offsetX);
    $('gif-offsety-val').textContent = String(state.gif.offsetY);
    recomposeGif({ immediateEncode: false });
  });
  const endGifDrag = () => {
    if (gifDragStart?.moved) encodeAndAuditCurrentGif();
    gifDragStart = null;
  };
  gifCanvas?.addEventListener('pointerup', endGifDrag);
  gifCanvas?.addEventListener('pointercancel', endGifDrag);
  gifCanvas?.addEventListener('wheel', e => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.08 : -0.08;
    const next = Math.max(0.2, Math.min(3.0, Math.round((state.gif.scale + delta) * 20) / 20));
    if (next !== state.gif.scale) {
      state.gif.scale = next;
      $('gif-scale').value = String(next);
      $('gif-scale-val').textContent = `${next.toFixed(2)}x`;
      recomposeGif({ immediateEncode: true });
    }
  }, { passive: false });

  // File drag & drop directly onto preview stage
  const dropStage = $('gif-drop-stage');
  dropStage?.addEventListener('dragover', e => {
    e.preventDefault();
    dropStage.classList.add('drop-active');
  });
  dropStage?.addEventListener('dragleave', () => dropStage.classList.remove('drop-active'));
  dropStage?.addEventListener('drop', e => {
    e.preventDefault();
    dropStage.classList.remove('drop-active');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleGifFileSelected(file);
  });

  $('btn-gif-reset-pos')?.addEventListener('click', () => {
    state.gif.scale = 1.0;
    state.gif.offsetX = 0;
    state.gif.offsetY = 0;
    state.gif.flipX = false;
    syncGifControlsFromState();
    recomposeGif({ immediateEncode: true });
    showToast('已把桌宠摆正回默认位置');
  });
  $('btn-gif-next-theme')?.addEventListener('click', () => switchTab('theme'));

  $('btn-gif-play').addEventListener('click', () => {
    state.gif.playing = !state.gif.playing;
    $('btn-gif-play').textContent = state.gif.playing ? '暂停' : '播放';
    if (state.gif.playing) scheduleNextGifFrame();
    else clearTimeout(gifTimerId);
  });
  $('gif-scrubber').addEventListener('input', e => {
    state.gif.frameIdx = Number(e.target.value);
    drawGifPreviewFrame();
    drawGifSourceCanvas();
  });
  $('gif-speed').addEventListener('input', e => {
    state.gif.speed = Number(e.target.value);
    $('gif-speed-val').textContent = `${state.gif.speed.toFixed(2)}x`;
    recomposeGif();
  });
  $('gif-speed').addEventListener('change', () => recomposeGif({ immediateEncode: true }));
  $('gif-loop').addEventListener('change', e => { state.gif.loop = e.target.checked; encodeAndAuditCurrentGif(); });

  $('btn-gif-extract-palette').addEventListener('click', handleExtractGifPalette);
  $('btn-gif-download').addEventListener('click', () => {
    encodeAndAuditCurrentGif();
    if (!state.gif.encodedBytes) {
      showToast('GIF 尚未通过生成与校验，无法下载');
      return;
    }
    downloadBlob(state.gif.encodedBytes, 'image/gif', 'rainy75-s1-pet.gif');
    showToast('已下载 320×172 设备规范 GIF');
  });
  $('btn-gif-use-deploy').addEventListener('click', () => {
    encodeAndAuditCurrentGif();
    if (!state.gif.encodedBytes) return;
    state.gif.useForDeploy = true;
    recomputePlan();
    showToast('已将该 320×172 GIF 设为部署用 S1 素材');
  });
  $('btn-gif-upload-s1').addEventListener('click', () => handleQuickUploadGif({ confirmCheckboxId: 'gif-confirm-s1' }));
  $('gif-confirm-s1').addEventListener('change', e => {
    $('btn-gif-upload-s1').disabled = !e.target.checked;
  });

  // Theme Color Wheel & Controls
  const wheelCanvas = $('theme-color-wheel');
  const pickFromWheelEvent = e => {
    const rect = wheelCanvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) * wheelCanvas.width) / rect.width;
    const y = ((e.clientY - rect.top) * wheelCanvas.height) / rect.height;
    const cx = wheelCanvas.width / 2;
    const cy = wheelCanvas.height / 2;
    const radius = Math.min(cx, cy) - 6;
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.min(radius, Math.hypot(dx, dy));
    const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    const s = dist / radius;
    state.wheel.h = h;
    state.wheel.s = s;
    const [r, g, b] = hsvToRgb(h, s, state.wheel.v);
    const hex = rgbToHex(r, g, b);
    state.wheel.seedHex = hex;
    $('theme-seed-hex').value = hex;
    $('theme-seed-swatch').style.background = hex;
    drawColorWheel();
    applyHarmonicTheme();
  };
  let wheelDragging = false;
  wheelCanvas.addEventListener('pointerdown', e => {
    wheelDragging = true;
    wheelCanvas.setPointerCapture?.(e.pointerId);
    pickFromWheelEvent(e);
  });
  wheelCanvas.addEventListener('pointermove', e => {
    if (wheelDragging) pickFromWheelEvent(e);
  });
  const stopDrag = () => { wheelDragging = false; };
  wheelCanvas.addEventListener('pointerup', stopDrag);
  wheelCanvas.addEventListener('pointercancel', stopDrag);

  $('theme-wheel-value').addEventListener('input', e => {
    state.wheel.v = Number(e.target.value) / 100;
    $('theme-wheel-val-readout').textContent = `${e.target.value}%`;
    const [r, g, b] = hsvToRgb(state.wheel.h, state.wheel.s, state.wheel.v);
    const hex = rgbToHex(r, g, b);
    state.wheel.seedHex = hex;
    $('theme-seed-hex').value = hex;
    $('theme-seed-swatch').style.background = hex;
    drawColorWheel();
    applyHarmonicTheme();
  });
  $('theme-seed-hex').addEventListener('change', e => {
    try {
      setWheelFromHex(e.target.value, { applyHarmonic: true });
    } catch {
      e.target.value = state.wheel.seedHex;
    }
  });
  $('theme-harmonic-tone').addEventListener('change', e => { state.wheel.tone = e.target.value; });
  $('btn-generate-harmonic').addEventListener('click', applyHarmonicTheme);

  for (const btn of document.querySelectorAll('[data-preset]')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.preset;
      const preset = state.presetsThemes[id] || PRESET_THEMES[id];
      if (preset) applyThemeObject(preset, { presetId: id, badgeLabel: preset.name || id });
    });
  }
  $('patch-ips-target').addEventListener('change', updateR75tBanner);
  $('btn-download-patched-ips').addEventListener('click', handleDownloadPatchedIps);

  // Screen Preview Controls
  for (const btn of document.querySelectorAll('.preview-view-btn')) {
    btn.addEventListener('click', () => setPreviewView(btn.dataset.view));
  }
  $('preview-use-gif-bg').addEventListener('change', e => { state.preview.useGifBg = e.target.checked; renderScreenPreviewCanvas(); });
  $('preview-key-select').addEventListener('change', e => {
    state.preview.key = Number(e.target.value);
    for (const kb of document.querySelectorAll('[data-keycap]')) {
      kb.classList.toggle('active', Number(kb.dataset.keycap) === state.preview.key);
    }
    renderScreenPreviewCanvas();
  });
  for (const kb of document.querySelectorAll('[data-keycap]')) {
    kb.addEventListener('click', () => {
      const k = Number(kb.dataset.keycap);
      state.preview.key = k;
      if ($('preview-key-select')) $('preview-key-select').value = String(k);
      for (const b of document.querySelectorAll('[data-keycap]')) {
        b.classList.toggle('active', b === kb);
      }
      renderScreenPreviewCanvas();
    });
  }
  $('btn-theme-next-deploy')?.addEventListener('click', () => switchTab('deploy'));
  $('preview-song-title').addEventListener('input', e => { state.preview.title = e.target.value; renderScreenPreviewCanvas(); });
  $('preview-lyric-current').addEventListener('input', e => { state.preview.current = e.target.value; renderScreenPreviewCanvas(); });
  $('preview-lyric-next').addEventListener('input', e => { state.preview.next = e.target.value; renderScreenPreviewCanvas(); });
  $('preview-progress').addEventListener('input', e => {
    state.preview.progressPct = Number(e.target.value);
    $('preview-progress-val').textContent = `${state.preview.progressPct}%`;
    renderScreenPreviewCanvas();
  });
  for (const btn of document.querySelectorAll('.preview-size-btn')) {
    btn.addEventListener('click', () => {
      state.preview.textSize = Number(btn.dataset.size);
      syncPreviewModeCControls();
      renderScreenPreviewCanvas();
    });
  }
  for (const btn of document.querySelectorAll('.preview-style-btn')) {
    btn.addEventListener('click', () => {
      state.preview.textStyle = btn.dataset.style;
      syncPreviewModeCControls();
      renderScreenPreviewCanvas();
    });
  }
  $('preview-cover-active').addEventListener('change', e => { state.preview.coverActive = e.target.checked; renderScreenPreviewCanvas(); });
  $('preview-cover-tint').addEventListener('input', e => { state.preview.coverTint = e.target.value; renderScreenPreviewCanvas(); });
  $('preview-vol-visible').addEventListener('change', e => { state.preview.volumeVisible = e.target.checked; renderScreenPreviewCanvas(); });
  $('preview-vol-style').addEventListener('change', e => { state.preview.volumeStyle = Number(e.target.value); renderScreenPreviewCanvas(); });
  $('preview-vol-scope').addEventListener('change', e => { state.preview.volumeScope = Number(e.target.value); renderScreenPreviewCanvas(); });
  $('preview-vol-level').addEventListener('input', e => {
    state.preview.volumeLevel = Number(e.target.value);
    $('preview-vol-level-val').textContent = `${state.preview.volumeLevel}%`;
    renderScreenPreviewCanvas();
  });
  $('preview-vol-hold').addEventListener('input', e => {
    state.preview.volumeHoldMs = Number(e.target.value);
    $('preview-vol-hold-val').textContent = `${state.preview.volumeHoldMs} ms`;
  });
  $('preview-vol-muted').addEventListener('change', e => { state.preview.volumeMuted = e.target.checked; renderScreenPreviewCanvas(); });

  // Key Pixel Editor & Design JSON
  $('key-editor-select').addEventListener('change', renderKeyPixelGrid);
  $('btn-key-clear').addEventListener('click', () => {
    const g = getEditingGlyph();
    if (!g) return;
    g.rows = g.rows.map(r => '0'.repeat(r.length));
    state.customKeysChanged = true;
    renderKeyPixelGrid();
    renderScreenPreviewCanvas();
    recomputePlan();
  });
  $('btn-key-reset-all').addEventListener('click', () => {
    state.keysProfile = JSON.parse(JSON.stringify(state.defaultKeysProfile || DEFAULT_KEYS_PROFILE));
    state.customKeysChanged = false;
    populateKeyEditorSelect();
    renderScreenPreviewCanvas();
    recomputePlan();
    showToast('已恢复内置默认键位点阵');
  });
  $('btn-key-export').addEventListener('click', () => {
    downloadBlob(JSON.stringify(state.keysProfile, null, 2) + '\n', 'application/json', 'keys.json');
    showToast('已导出 keys.json（需通过源码 tools/build.py 重编 IPS 固件）');
  });
  $('key-import-input').addEventListener('change', async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const parsed = validateKeysProfile(JSON.parse(await f.text()));
      state.keysProfile = parsed;
      state.customKeysChanged = true;
      populateKeyEditorSelect();
      renderScreenPreviewCanvas();
      recomputePlan();
      showToast('已导入 keys.json 点阵配置');
    } catch (err) {
      showToast(`keys.json 格式错误：${err.message}`, 4500);
    }
  });
  $('btn-export-design').addEventListener('click', handleExportDesignProfile);
  $('design-import-input').addEventListener('change', e => handleImportDesignProfile(e.target.files?.[0]));

  // Background Panel
  $('btn-bg-refresh').addEventListener('click', refreshBackgroundStatus);
  $('btn-bg-start').addEventListener('click', () => postBackgroundAction('/api/background/start'));
  $('btn-bg-stop').addEventListener('click', () => postBackgroundAction('/api/background/stop'));
  $('btn-bg-startup-enable').addEventListener('click', () => postBackgroundAction('/api/background/startup', { enabled: true }));
  $('btn-bg-startup-disable').addEventListener('click', () => postBackgroundAction('/api/background/startup', { enabled: false }));
  $('btn-bg-open-console').addEventListener('click', () => {
    const url = state.bgStatus?.url;
    if (isSafeLocalBridgeUrl(url)) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  });
}

async function init() {
  const isFile = window.location.protocol === 'file:';
  $('file-protocol-banner').classList.toggle('hidden', !isFile);

  const releaseBundle = getReleaseBundle();
  const bundlePill = $('header-bundle-pill');
  const bundleText = $('overview-bundle-text');
  if (releaseBundle) {
    bundlePill.className = 'pill pill-safe';
    bundlePill.textContent = '安装资源已就绪';
    if (bundleText) bundleText.textContent = ` 已内置全套固件、字库与示例桌宠 (${releaseBundle.version || 'v1'})`;
  } else {
    bundlePill.className = 'pill pill-muted';
    bundlePill.textContent = '离线预览模式';
    if (bundleText) bundleText.textContent = '当前仅预览/制图（如需直接写入键盘，请打开完整发布包版 HTML）';
  }

  const hasWebHid = Boolean(globalThis.navigator?.hid);
  const hidChip = $('overview-webhid-chip');
  const hidText = $('overview-webhid-text');
  if (hasWebHid) {
    hidChip.className = 'pill pill-safe';
    hidChip.textContent = 'WebHID 已就绪';
    hidText.textContent = isFile
      ? '浏览器支持连键盘（如果点击连接无弹窗，请双击「1-打开工作台.cmd」打开）'
      : ' 正常可用（已支持直接弹窗选择并写入键盘）';
  } else {
    hidChip.className = 'pill pill-warn';
    hidChip.textContent = '需用 Chrome / Edge';
    hidText.textContent = '当前浏览器不支持直连 USB 键盘，请使用 Chrome 或 Edge 浏览（预览与制作 GIF 仍正常可用）';
    $('probe-feedback').textContent = '请用桌面 Chrome 或 Edge 打开此工作台。';
  }

  $('quick-timezone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';

  await loadProfiles();
  wireEvents();

  populateKeyEditorSelect();
  applyThemeObject(state.presetsThemes.pink || PRESET_THEMES.pink, { presetId: 'pink', badgeLabel: '樱花粉', userChange: false });
  syncPreviewModeCControls();
  selectTrack('A');
  setPreviewView('keys');
  setHeroSlide('keys');
  startOverviewKeysAnimation();
  scheduleHeroAutoplay();
  syncGifControlsFromState();
  await loadPresetRobot('pink');
  await refreshBackgroundStatus();
}

init();
