// SPDX-License-Identifier: MIT
import { MAIN_CAP, IPS_CAP } from './protocol.mjs';
import { MAIN_BASELINES, planDeployment } from './deploy-wizard.mjs';
import { auditDeviceGif } from './gif-studio.mjs';
import { validateFont } from './font.mjs';

export function planEdition(probe, edition, bundle) {
  if (probe.mode !== 'app') throw new Error('键盘处于升级模式。请先按恢复说明处理，再安装。');
  const baseline = MAIN_BASELINES[probe.detectedBaseline];
  if (probe.mainCap !== MAIN_CAP && !baseline) {
    const version = probe.stockVersion?.join('.');
    throw new Error(version
      ? `当前主控版本（${version}）未适配，已停止安装。`
      : '未读到主控版本。请退出 WOBHub，确认 USB 有线连接后重试。');
  }

  const lyrics = edition.layout !== null;
  const selected = { ...bundle, main: bundle.firmware[baseline?.patch] };
  if (probe.mainCap !== MAIN_CAP && selected.main?.manifest?.stockSha256 !== baseline.stockSha256) {
    throw new Error('安装包缺少匹配的主控固件，请重新下载。');
  }
  const theme = (lyrics ? selected.ipsLyrics : selected.ipsBase).manifest.themeColors;
  auditDeviceGif(selected.gif, theme);
  if (lyrics) {
    const { bodyCrc } = validateFont(selected.font);
    if (probe.lyrics?.fontReady && probe.lyrics.fontCrc !== bodyCrc && !selected.previousFont) {
      throw new Error('屏幕装有另一版字库。请先用原安装工具移除它，再安装本版。');
    }
  }

  const intent = {
    scenario: probe.ipsCap === IPS_CAP ? 'update' : 'first',
    track: lyrics ? (edition.layout === 4 ? 'C' : 'B') : 'A',
    preferredLayout: lyrics ? edition.layout : undefined,
    baseOnly: !lyrics,
    requireKnownMain: true,
    customGifBytes: selected.gif,
    skipCalibrate: true,
    verifyS1: true
  };
  const plan = planDeployment(probe, intent, selected);
  if (plan.blocked) throw new Error(plan.error);
  if (!lyrics) plan.steps = plan.steps.filter(step => step.id !== 'upload_font');
  // Start the expected playback surface before font initialization. Keep the
  // saved font in place when it already matches the chosen image.
  const gifIndex = plan.steps.findIndex(step => step.id === 'upload_gif');
  const fontIndex = plan.steps.findIndex(step => step.id === 'upload_font');
  if (lyrics && fontIndex >= 0 && gifIndex > fontIndex) {
    const [gif] = plan.steps.splice(gifIndex, 1);
    plan.steps.splice(fontIndex, 0, gif);
  }
  return { plan, intent, bundle: selected };
}
