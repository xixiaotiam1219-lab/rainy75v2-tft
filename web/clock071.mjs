// SPDX-License-Identifier: MIT
import { AppClient, FlashClient } from './hid.mjs';
import { validateBuild } from './protocol.mjs';
import { readStockBaseline } from './deploy-wizard.mjs';
import { measureRtcRate } from './rtc-rate.mjs';

const stockSha = 'c9ecade81300d083e3a067498e67401dd323668b76c26450ad23f758394ccbd4';
const rateKey = 'rainy75-clock071-rate-millihertz';
const $ = id => document.getElementById(id);
const validRate = value => Number.isInteger(value) && value >= 30000000 && value <= 40000000;
let plans, busy, iapPending, measurement, savedRate;
try { savedRate = Number(localStorage.getItem(rateKey)); } catch {}
if (!validRate(savedRate)) savedRate = 0;

function render() {
  $('enter').disabled = Boolean(busy || !plans || iapPending);
  $('flash').disabled = Boolean(busy || !plans || !iapPending);
  $('restore').disabled = Boolean(busy || !plans);
  $('measure').disabled = Boolean(busy || iapPending);
  $('reuse').disabled = Boolean(busy || iapPending || !savedRate);
  $('cancel').disabled = !measurement;
  $('sample-minutes').disabled = Boolean(busy);
}

async function loadPlan(entry) {
  if (entry.manifest.stockSha256 !== stockSha || entry.manifest.target !== 'main') throw new Error('固件基线不匹配');
  const packed = Uint8Array.from(atob(entry.gzip), char => char.charCodeAt(0));
  const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return validateBuild(bytes, entry.manifest);
}

async function prepareFirmware() {
  const node = $('clock-firmware');
  if (!node) throw new Error('请打开已打包的 0.71 烧录网页');
  const data = JSON.parse(node.textContent);
  const [patched, restore] = await Promise.all([loadPlan(data.patched), loadPlan(data.restore)]);
  if (data.patched.manifest.stockVersion !== '0.71') throw new Error('未找到配套的 0.71 主控补丁');
  if (!savedRate && validRate(data.measuredRate)) savedRate = data.measuredRate;
  plans = { patched, restore };
  $('flash-status').textContent = '主控补丁和原厂恢复镜像均已通过 SHA-256 核对。';
}

async function enterUpgrade() {
  busy = true; render();
  let client;
  try {
    client = await AppClient.connect();
    const { raw } = await readStockBaseline(client.io);
    if (raw.join(',') !== '0,0,71,0') throw new Error('仅适用于原厂 0.71 主控，版本核对失败');
    await client.enterIap('main');
    iapPending = true;
    $('flash-status').textContent = '已发出升级命令。键盘重连后，选择 0x3079 升级设备并写入。';
  } catch (error) {
    $('flash-status').textContent = error.message;
  } finally {
    if (client) await client.close().catch(() => {});
    busy = false; render();
  }
}

async function flashPlan(plan, restored) {
  busy = true; render();
  let flash, last = '';
  try {
    flash = await FlashClient.connect(plan);
    await flash.flash((phase, fraction) => {
      const percent = Math.floor(fraction * 100);
      const label = `${phase} ${percent}%`;
      if (label === last) return;
      last = label;
      $('flash-status').textContent = label;
      $('flash-progress').value = percent;
    });
    iapPending = false;
    $('flash-status').textContent = restored ? '原厂 0.71 已写入并通过校验。' : '0.71 主控已通过全字节校验。键盘重连后可开始校频。';
  } catch (error) {
    $('flash-status').textContent = error.message;
  } finally {
    if (flash) await flash.io.close().catch(() => {});
    busy = false; render();
  }
}

async function clockCalibration(reuse) {
  busy = true; render();
  let client, device;
  const disconnect = event => { if (event.device === device) measurement?.abort(); };
  try {
    client = await AppClient.connect();
    await client.status();
    if (await client.queryMain(24) !== 0x4346) throw new Error('请先更新 0.71 主控补丁');
    if (!(await client.queryMain(25))) throw new Error('主控校时记录空间已用完，可重新写入本页补丁后校时。');
    let rate = savedRate;
    if (!reuse) {
      measurement = new AbortController(); render();
      device = client.io.device;
      navigator.hid.addEventListener('disconnect', disconnect);
      const minutes = Number($('sample-minutes').value);
      let last = -1;
      const measured = await measureRtcRate(client, {
        durationMs: minutes * 60000,
        signal: measurement.signal,
        progress: fraction => {
          const percent = Math.floor(fraction * 100);
          if (percent === last) return;
          last = percent;
          $('measure-progress').value = percent;
          $('measure-status').textContent = `正在测量 ${percent}%。请保持键盘有线连接。`;
        }
      });
      rate = measured.rateMilliHz;
    }
    measurement = null; render();
    $('measure-status').textContent = `按 ${(rate / 1000).toFixed(3)} Hz 校准并核对屏幕时间…`;
    const result = await client.calibrate({ rateMilliHz: rate });
    savedRate = rate;
    try { localStorage.setItem(rateKey, String(rate)); } catch {}
    $('measure-status').textContent = `校准完成。走时频率 ${(rate / 1000).toFixed(3)} Hz，屏幕时间 ${result.screenTime.text}。`;
  } catch (error) {
    $('measure-status').textContent = error.name === 'AbortError' ? '测量已取消。' : error.message;
  } finally {
    if (device) navigator.hid.removeEventListener('disconnect', disconnect);
    if (client) await client.close().catch(() => {});
    measurement = null; busy = false; render();
  }
}

$('enter').onclick = enterUpgrade;
$('flash').onclick = () => flashPlan(plans.patched, false);
$('restore').onclick = () => flashPlan(plans.restore, true);
$('measure').onclick = () => clockCalibration(false);
$('reuse').onclick = () => clockCalibration(true);
$('cancel').onclick = () => measurement?.abort();
prepareFirmware().catch(error => { $('flash-status').textContent = error.message; }).finally(render);
