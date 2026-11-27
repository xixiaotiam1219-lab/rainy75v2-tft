// SPDX-License-Identifier: MIT
import { AppClient, FlashClient } from './hid.mjs';
import { sha256, validateBuild } from './protocol.mjs';
import { auditDeviceGif } from './gif-studio.mjs';

const $ = id => document.getElementById(id);
const input = $('build');
const action = $('action');
let stage = 'select';
let contents;
let busy = false;
const stages = {
  select: '开始安装',
  setup: '开始安装',
  flash: '连接屏幕升级设备',
  assets: '连接键盘并写入素材',
  done: '安装完成'
};

function update() {
  input.disabled = busy || ['flash', 'assets'].includes(stage);
  action.textContent = stages[stage];
  action.disabled = busy || stage === 'select' || stage === 'done';
}

function status(message) {
  $('status').textContent = message;
}

async function run(task) {
  if (busy) return;
  busy = true;
  update();
  $('error').hidden = true;
  try {
    await task();
  } catch (error) {
    $('error').hidden = false;
    $('error').textContent = error.message;
  } finally {
    busy = false;
    update();
  }
}

async function loadBuild() {
  stage = 'select';
  contents = null;
  const files = [...input.files];
  if (!files.length) return;
  const manifestFile = files.find(file => file.name === 'manifest.json' &&
    file.webkitRelativePath.split('/').length === 2);
  if (!manifestFile) throw new Error('请选择直接包含 manifest.json 的构建文件夹。');
  const root = manifestFile.webkitRelativePath.split('/')[0];
  const fileAt = name => files.find(file => file.webkitRelativePath === root + '/' + name);
  const manifest = JSON.parse(await manifestFile.text());
  if (manifest.variant !== 'bongo-v1' || manifest.petIdentity !== 0x4246 ||
      manifest.stockSha256 !== '32defab7902e57eb972a577fc6cbf3a7e57bc772d59b99f11038370412b77f41' ||
      !/^assets\/bongo-base-[a-z0-9-]+\.gif$/.test(manifest.petGif || '')) {
    throw new Error('请选择与说明匹配的白猫按键版构建。');
  }
  const image = fileAt('rainy75v2-ips.bin');
  const gifFile = fileAt(manifest.petGif);
  if (!image || !gifFile) throw new Error('构建文件夹缺少屏幕固件或配套 GIF。');
  const [plan, gif] = await Promise.all([
    image.arrayBuffer().then(bytes => validateBuild(new Uint8Array(bytes), manifest)),
    gifFile.arrayBuffer().then(bytes => new Uint8Array(bytes))
  ]);
  if (await sha256(gif) !== '76bf75daa5044046d4416035587ff8967638a018e838d85ecb5fce931d003672') {
    throw new Error('GIF 与本版固件的配套素材不一致。请选择同一次构建生成的文件夹。');
  }
  auditDeviceGif(gif, manifest.themeColors);
  contents = { plan, gif };
  stage = 'setup';
  status('已核对固件与素材。可以开始安装。');
}

async function enterUpgrade() {
  const client = await AppClient.connect();
  try {
    status('正在检查屏幕芯片…');
    try {
      await client.probeLyricsTarget();
    } catch (cause) {
      throw new Error('请确认键盘已安装兼容主控和普通屏幕固件，屏幕芯片为 1024 KiB AT32F435（系列 13）。', { cause });
    }
    await client.enterIap('ips');
    contents.plan.hardwareChecked = true;
    stage = 'flash';
    status('已检查屏幕芯片。请连接屏幕升级设备（0x3078）。');
  } finally {
    await client.close().catch(() => {});
  }
}

async function flashScreen() {
  const flasher = await FlashClient.connect(contents.plan);
  try {
    $('progress').hidden = false;
    await flasher.flash((phase, percent) => {
      $('progress').value = percent;
      status(`${phase}屏幕固件 · ${Math.round(percent * 100)}%`);
    });
    stage = 'assets';
    status('固件已校验。等待键盘重启，再连接正常模式键盘（0x3075）。');
  } finally {
    await flasher.io.close().catch(() => {});
  }
}

async function uploadAssets() {
  const app = await AppClient.connect();
  try {
    status('正在等屏幕应答…');
    await app.requireScreen();
    if (await app.queryIps(13) !== 0x4246) throw new Error('屏幕未返回本版白猫固件标识，请检查安装进度。');
    await app.upload(contents.gif, {
      replaceConfirmed: true,
      progress: ratio => {
        $('progress').value = ratio;
        status(`正在写入 GIF · ${Math.round(ratio * 100)}%`);
      }
    });
    stage = 'done';
    status('安装完成。若小屏仍显示原厂界面，请在 WOBHub 选择 GIF 槽位 1。');
  } finally {
    await app.close().catch(() => {});
  }
}

const tasks = { setup: enterUpgrade, flash: flashScreen, assets: uploadAssets };
if (!navigator.hid) {
  status('请用 Chrome 或 Edge 打开本页。浏览器限制文件访问时，请按说明从本地服务器打开。');
} else {
  input.addEventListener('change', () => run(loadBuild));
  action.addEventListener('click', () => run(tasks[stage]));
}
