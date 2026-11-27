// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startGuiServer } = require('../desktop/gui-server.cjs');
const editionRoot = path.resolve(process.argv[2] || 'dist/rainy75v2-alpha7');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeHid(version) {
  let handler, last = [13, 5, 0, 0];
  const trace = [];
  const report = { reportId: 0, items: [{ reportSize: 8, reportCount: 256 }] };
  const app = {
    vendorId: 0x36b0, productId: 0x3075, opened: false,
    collections: [{ usagePage: 0xff60, usage: 0x61, inputReports: [report], outputReports: [report] }],
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    addEventListener(_, next) { handler = next; },
    removeEventListener() { handler = undefined; },
    async sendReport(_, packet) {
      if (packet[1] === 0xfc) {
        trace.push(['boot', packet[2]]);
        return;
      }
      if (packet[1] === 0x1a) {
        const [operation, low, high] = packet.subarray(4, 7);
        last = operation === 15 ? [13, 0xd0 + low, 0, 0] :
          operation === 11 ? [13, 0xb0 + low, 0, 0] : [13, 5, low, high];
        return;
      }
      if (packet[1] !== 0xe4) throw new Error('Unexpected HID command');
      const command = packet[3];
      const data = command === 0x44 ? [0, 0, version, 0] : last;
      const response = new Uint8Array(256);
      response.set([0xbe, 0xe4, 14, command, 4, 0, 0, ...data, 0, 0, 0xed]);
      const checksum = response.subarray(0, 11).reduce((sum, byte) => sum + byte, 0);
      response[11] = checksum & 255;
      response[12] = checksum >>> 8;
      queueMicrotask(() => handler?.({ reportId: 0, data: new DataView(response.buffer) }));
    }
  };
  Object.defineProperty(navigator, 'hid', { value: {
    getDevices: async () => [app],
    requestDevice: async ({ filters }) => {
      trace.push(['choose', ...filters.map(item => item.productId)]);
      return filters.some(item => item.productId === 0x3075) ? [app] : [];
    }
  }});
  window.hidTrace = trace;
}

async function checkBridge(app, edition, data) {
  const child = spawn(process.execPath, [path.join(app, 'desktop', 'bridge.cjs'), '--demo'], {
    env: { ...process.env, RAINY75_DATA: data }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  const exit = once(child, 'exit');
  let url, stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    for (let i = 0; i < 100 && child.exitCode === null; i++) {
      try {
        ({ url } = JSON.parse(await fs.readFile(path.join(data, 'background-service.json'), 'utf8')));
        break;
      } catch {
        await delay(50);
      }
    }
    assert(url, stderr || 'Offline service did not start');
    const state = await (await fetch(url + '/state')).json();
    assert.equal(state.edition, edition.id);
    assert.equal(state.settings.mode, 1);
    assert.equal(state.settings.layout, edition.layout);
    const post = (route, body) => fetch(url + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    for (const [route, body] of [['/mode', { mode: 0 }], ['/layout', { layout: 4 }], ['/screen/next', {}]]) {
      assert.equal((await post(route, body)).status, 400);
    }
    assert.equal((await post('/settings', { offsetMs: -500 })).status, 200);
    assert.equal((await post('/stop', {})).status, 200);
    await exit;
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await exit;
    }
  }
}

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  headless: true
});
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rainy75-edition-test-'));
try {
  for (const name of ['keys', 'lyrics-classic', 'lyrics-caption', 'lyrics-focus', 'lyrics-double', 'lyrics-cover']) {
    const dir = path.join(editionRoot, name);
    const app = path.join(dir, 'app');
    const edition = JSON.parse(await fs.readFile(path.join(app, 'edition.json'), 'utf8'));
    const gui = await startGuiServer({
      htmlPath: path.join(dir, '屏幕安装.html'), desktopDir: path.join(app, 'desktop'),
      dataDir: path.join(scratch, name + '-gui'), startupDir: null, port: 0
    });
    try {
      for (const version of name === 'keys' ? [71, 72] : [71]) {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.addInitScript(fakeHid, version);
        await page.goto(gui.url);
        await page.getByRole('heading', { name: edition.title }).waitFor();
        assert(await page.locator('#preview').evaluate(img => img.decode().then(() => img.naturalWidth > 0)));
        await page.getByRole('button', { name: '开始安装' }).click();
        if (version === 71) {
          await page.getByRole('button', { name: '连接键盘升级设备' }).click();
          await page.getByRole('button', { name: '连接键盘升级设备' }).waitFor();
          assert.deepEqual(await page.evaluate(() => window.hidTrace), [
            ['choose', 0x3075, 0x3079, 0x3078], ['boot', 4], ['choose', 0x3079]
          ]);
        } else {
          await page.getByRole('alert').filter({ hasText: '未适配' }).waitFor();
          assert.deepEqual(await page.evaluate(() => window.hidTrace), [['choose', 0x3075, 0x3079, 0x3078]]);
        }
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally {
      await gui.close();
    }
    if (edition.layout !== null) await checkBridge(app, edition, path.join(scratch, name));
    console.log('Verified:', name);
  }
} finally {
  await browser.close();
  await fs.rm(scratch, { recursive: true, force: true });
}
