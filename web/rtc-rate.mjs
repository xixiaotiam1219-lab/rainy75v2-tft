// SPDX-License-Identifier: MIT
const DAY_TICKS = 0xa8c00000;
// R8_CK32K_CONFIG bit 7 is the instantaneous pin level. Only bit 2 selects the source.
const CLOCK_SOURCE_SELECT = 0x04;

async function sampleCounter(client, now) {
  let best;
  for (let attempt = 0; attempt < 6; attempt++) {
    const day = await client.queryMain(2);
    const high = await client.queryMain(1);
    const started = now();
    const low = await client.queryMain(0);
    const ended = now();
    const endHigh = await client.queryMain(1);
    const endDay = await client.queryMain(2);
    const counter = high * 65536 + low;
    if (day !== endDay || high !== endHigh || day >= 0x4000 || counter >= DAY_TICKS) continue;
    const sample = { ticks: day * DAY_TICKS + counter, at: (started + ended) / 2, rtt: ended - started };
    if (!best || sample.rtt < best.rtt) best = sample;
  }
  if (!best) throw new Error('主控 RTC 读数不稳定，请保持 USB 有线连接后重测');
  return best;
}

export async function measureRtcRate(client, {
  durationMs = 600000,
  now = () => performance.now(),
  wallNow = Date.now,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  progress = () => {},
  signal
} = {}) {
  if (!Number.isInteger(durationMs) || durationMs < 300000 || durationMs > 1800000) throw new Error('校频时长须为 5 到 30 分钟');
  signal?.throwIfAborted();
  if (await client.queryMain(24) !== 0x4346) throw new Error('请先安装支持精确校频的 0.71 主控补丁');
  const originOffset = wallNow() - now();
  const source = (await client.queryMain(3)) & CLOCK_SOURCE_SELECT;
  const first = await sampleCounter(client, now);
  let middle;
  progress(0);
  while (now() - first.at < durationMs) {
    signal?.throwIfAborted();
    await pause(Math.min(1000, Math.max(1, durationMs - (now() - first.at))));
    if (Math.abs(wallNow() - now() - originOffset) > 250) throw new Error('测量期间电脑时钟发生跳变，请重新测量');
    if (!middle && now() - first.at >= durationMs / 2) middle = await sampleCounter(client, now);
    progress(Math.min(1, (now() - first.at) / durationMs));
  }
  signal?.throwIfAborted();
  if (((await client.queryMain(3)) & CLOCK_SOURCE_SELECT) !== source) throw new Error('测量期间键盘 RTC 时钟源变化，请重新测量');
  const last = await sampleCounter(client, now);
  const elapsedMs = last.at - first.at;
  const rateMilliHz = Math.round((last.ticks - first.ticks) * 1e6 / elapsedMs);
  if (rateMilliHz < 30000000 || rateMilliHz > 40000000) throw new Error('RTC 计数与测量时长不符，请保持键盘供电并重新测量');
  const middleExpected = first.ticks + (last.ticks - first.ticks) * (middle.at - first.at) / elapsedMs;
  const middleErrorMs = Math.abs(middleExpected - middle.ticks) * 1e6 / rateMilliHz;
  if (middleErrorMs > 35 + (first.rtt + middle.rtt + last.rtt) / 2) throw new Error('测量期间 RTC 计数不连续，请重新测量');
  const uncertaintyHz = (first.rtt + last.rtt) * rateMilliHz / (2 * elapsedMs * 1000);
  if (uncertaintyHz > 1) throw new Error('USB 应答延迟偏大，请选择更长时间重新测量');
  return { rateMilliHz, uncertaintyHz, elapsedMs };
}
