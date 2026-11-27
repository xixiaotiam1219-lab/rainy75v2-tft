// SPDX-License-Identifier: MIT
import { DeploymentRunner, MAIN_BASELINES, probeDevice } from './deploy-wizard.mjs';
import { planEdition } from './easy-plan.mjs';
import { sha256 } from './protocol.mjs';

const $ = id => document.getElementById(id);
const payload = globalThis.__RAINY75_RELEASE_BUNDLE__;
const edition = payload?.edition;
const local = location.hostname === '127.0.0.1';
const lyrics = edition?.layout !== null;
const action = $('action');
const background = $('background');
let probe, runner, ready, busy = false;
let primary = connect;
let backgroundStatus = {};

function say(message) {
  $('status').textContent = message;
}

function log(message) {
  $('log').textContent += `${new Date().toLocaleTimeString()}  ${message}\n`;
}

function showError(error) {
  const message = error?.message || String(error);
  $('error').hidden = false;
  $('error').textContent = message;
  log(message);
}

function setAction(label, handler) {
  action.textContent = label;
  action.hidden = !handler;
  primary = handler;
}

async function perform(task) {
  if (busy || !task) return;
  busy = action.disabled = background.disabled = true;
  $('error').hidden = true;
  try {
    await task();
  } catch (error) {
    showError(error);
  } finally {
    busy = action.disabled = background.disabled = false;
  }
}

async function api(route, post = false) {
  const response = await fetch(`/api/background/${route}`, post ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '电脑助手未响应');
  return result;
}

function updateBackground(status) {
  backgroundStatus = status;
  if (!local) return;
  background.hidden = Boolean(runner) || !status.running && !status.unreachable && !lyrics;
  background.textContent = status.running || status.unreachable
    ? (status.external ? '暂停旧后台' : '暂停歌词同步')
    : '启动歌词同步';
  $('settings').hidden = !lyrics || !status.running || status.external || !status.url;
  if (!$('settings').hidden) $('settings').href = status.url;
}

async function stopBackground() {
  await api('stop', true);
  updateBackground(await api('status'));
  say('后台已暂停。可以连接键盘。');
}

async function startBackground(needsS1 = false) {
  await probe?.client?.close();
  probe = ready = null;
  setAction('开始安装', connect);
  say('正在启动电脑助手…');
  try {
    const result = await api('start', true);
    if (result.edition !== edition.id || result.layout !== edition.layout) throw new Error('后台版式与安装包不一致');
    updateBackground(await api('status'));
    say(needsS1
      ? '歌词同步已启动。如果小屏还在原厂界面，请先暂停同步，再用 WOBHub 切到 GIF 槽位 1。'
      : '歌词同步已开启。播放一首歌试试。');
  } catch (error) {
    say('可以再次点击「启动歌词同步」。');
    throw error;
  }
}

async function unpack(entry) {
  const compressed = Uint8Array.from(atob(entry.binGzipBase64), character => character.charCodeAt(0));
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  if (bytes.length !== entry.size || await sha256(bytes) !== entry.sha256) {
    throw new Error('安装文件校验失败，请重新下载压缩包。');
  }
  return bytes;
}

async function loadBundle(baseline) {
  const image = async key => {
    const entry = payload.firmware[key];
    return entry ? { bytes: await unpack(entry), manifest: entry.manifest } : undefined;
  };
  const [main, ipsBase, ipsLyrics, gif, font] = await Promise.all([
    baseline ? image(baseline.patch) : undefined,
    image('ipsBase'),
    lyrics ? image('ipsLyrics') : undefined,
    unpack(payload.gif),
    lyrics ? unpack(payload.font) : undefined,
  ]);
  return { firmware: baseline ? { [baseline.patch]: main } : {}, ipsBase, ipsLyrics, gif, font };
}

async function connect() {
  if (backgroundStatus.running || backgroundStatus.unreachable) {
    throw new Error('请先暂停歌词同步，再连接键盘。');
  }
  await probe?.client?.close();
  probe = ready = null;
  say('正在读取键盘。初次连接可能需要几秒。');
  try {
    // requestDevice is called directly in the click flow, before file loads.
    probe = await probeDevice(null, { hid: navigator.hid, keepOpen: true });
    const baseline = MAIN_BASELINES[probe.detectedBaseline];
    log(`设备模式 ${probe.mode}，主控 ${baseline?.version || probe.stockVersion?.join('.') || '未读取到版本'}`);
    const bundle = await loadBundle(baseline);
    ready = planEdition(probe, edition, bundle);
    say(baseline ? `已连接。识别到主控 ${baseline.version}。` : '已连接。可以开始安装。');
    await install();
  } catch (error) {
    if (runner) throw error;
    await probe?.client?.close().catch(() => {});
    probe = null;
    say('连接或检查未完成。');
    throw error;
  }
}

const steps = {
  flash_main: '更新键盘',
  flash_ips_base: '更新屏幕',
  probe_lyrics_hardware: '检查屏幕型号',
  flash_ips_lyrics: '安装播放器',
  upload_gif: '安装屏幕素材',
  upload_font: '安装字库',
  verify_font: '检查字库',
  calibrate: '同步时间'
};

function onProgress(info) {
  const step = ready.plan.steps[info.stepIndex]?.id;
  if (['step_start', 'skip', 'failed', 'manual_reminder'].includes(info.phase)) log(info.message);
  $('progress').value = info.percent;
  if (info.status === 'failed') {
    setAction('再试这一步', () => advance(() => runner.retryCurrentStep()));
    say('安装暂停。');
    return;
  }
  if (info.iapNeeded) {
    const { target, pid } = info.iapNeeded;
    const name = { app: '正常模式键盘', main: '键盘升级设备', ips: '屏幕升级设备' }[target];
    say(`在弹窗中选择${name}（0x${pid.toString(16)}）。`);
    setAction(`连接${name}`, () => advance(() => runner.authorizeIapAndContinue()));
    return;
  }
  if (steps[step] && info.phase !== 'skip') say(`正在${steps[step]} · ${info.percent}%`);
}

async function advance(run) {
  setAction('正在安装…', null);
  background.hidden = true;
  $('progress').hidden = false;
  try {
    const result = await run();
    if (result.status !== 'completed') return;
    const needsS1 = result.manualReminders.length > 0;
    say(needsS1 ? '安装完成。如果小屏还在原厂界面，请在 WOBHub 切到 GIF 槽位 1，退出 WOBHub 后再使用。' : '安装完成。');
    setAction('重新安装', connect);
    runner = null;
    probe = null;
    ready = null;
    updateBackground(backgroundStatus);
    if (lyrics) {
      try { await startBackground(needsS1); } catch (error) { showError(error); }
    }
  } catch (error) {
    if (runner?.diagnostic?.recoveryHint) log(runner.diagnostic.recoveryHint);
    throw error;
  }
}

async function install() {
  if (local) {
    const status = await api('status');
    updateBackground(status);
    if (status.running || status.unreachable) throw new Error('请暂停电脑助手后再安装。');
  }
  runner = new DeploymentRunner({
    ...ready, hid: navigator.hid, appClient: probe.client, onProgress
  });
  await advance(() => runner.start());
}

if (edition) {
  $('title').textContent = edition.title;
  document.title = `${edition.title} · Rainy75 V2`;
  $('preview').src = edition.preview;
  if (lyrics) $('intro').textContent += ' 歌词通过 Windows 电脑同步。';
  if (!local) say('请双击压缩包内的「点我安装.cmd」打开安装器。');
  else if (!navigator.hid) say('请复制当前地址，用桌面版 Chrome 或 Edge 打开。');
  else {
    try {
      updateBackground(await api('status'));
      action.disabled = false;
    } catch (error) {
      showError(error);
    }
  }
}

action.addEventListener('click', () => perform(primary));
background.addEventListener('click', () => perform(
  backgroundStatus.running || backgroundStatus.unreachable ? stopBackground : startBackground
));
