// SPDX-License-Identifier: MIT
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const REPO_ROOT = path.resolve(__dirname, '..');
const GUI_SERVER_PATH = path.join(REPO_ROOT, 'desktop', 'gui-server.cjs');
const CONFIG_PATH = path.join(REPO_ROOT, 'desktop', 'config.cjs');
const STARTUP_PS1 = path.join(REPO_ROOT, 'desktop', 'startup.ps1');
const BRIDGE_PATH = path.join(REPO_ROOT, 'desktop', 'bridge.cjs');

const { createGuiServer, startGuiServer, parseArgs } = require(GUI_SERVER_PATH);
const { registerServiceFile, registeredServiceFiles, startupServiceFiles } = require('../desktop/background-locations.cjs');

function makeTempDir(prefix = 'r75-测试 空间-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function httpRequest({ host = '127.0.0.1', port, path: reqPath = '/', method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method, headers: { Host: headers.Host || `${host}:${port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

test('parseArgs validates flags and rejects missing values or unknown flags', () => {
  const parsed = parseArgs(['--html', 'a.html', '--port', '9001', '--open', '--data-dir', 'd', '--startup-dir', 's']);
  assert.equal(parsed.htmlPath, 'a.html');
  assert.equal(parsed.port, 9001);
  assert.equal(parsed.open, true);
  assert.equal(parsed.dataDir, 'd');
  assert.equal(parsed.startupDir, 's');
  assert.throws(() => parseArgs(['--html']), /Missing value/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
});

test('service registry and UTF16 startup discovery read only fixed local service paths', (t) => {
  const root = makeTempDir();
  t.after(() => cleanupDir(root));
  const registry = path.join(root, 'registry.json');
  const service = path.join(root, '旧 安装', 'background-service.json');
  registerServiceFile(registry, service);
  registerServiceFile(registry, service);
  registerServiceFile(registry, path.join(root, 'other.json'));
  assert.deepEqual(registeredServiceFiles(registry), [service]);
  fs.writeFileSync(path.join(root, 'Rainy75V2-TFT-Lyrics.vbs'), '\uFEFFshell.Environment("PROCESS")("RAINY75_DATA") = "' + path.dirname(service) + '"\r\n', 'utf16le');
  assert.deepEqual(startupServiceFiles(root), [service]);
});

test('external registered backend blocks duplicate start and is stopped only after verified PID exit', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanupDir(root));
  const htmlPath = path.join(root, 'studio.html'), registryFile = path.join(root, 'registry.json');
  const serviceFile = path.join(root, 'old', 'background-service.json');
  fs.writeFileSync(htmlPath, '<html></html>');
  fs.mkdirSync(path.dirname(serviceFile));
  fs.writeFileSync(serviceFile, JSON.stringify({ pid: 777777, url: 'http://127.0.0.1:19998' }));
  registerServiceFile(registryFile, serviceFile);
  let alive = true;
  const requests = [];
  const gui = await startGuiServer({ htmlPath, dataDir: path.join(root, 'new'), startupDir: null, registryFile, port: 0,
    isPidAlive: pid => pid === 777777 && alive,
    spawnImpl: () => assert.fail('External backend must block launch'),
    fetchImpl: async (url, options) => {
      requests.push([url, options.method]);
      if (url.endsWith('/stop')) { alive = false; fs.unlinkSync(serviceFile); return { ok: true }; }
      return { ok: true, json: async () => ({ pid: 777777, connected: true }) };
    } });
  t.after(() => gui.close());
  const status = JSON.parse((await httpRequest({ port: gui.port, path: '/api/background/status' })).text);
  assert.equal(status.running, true);
  assert.equal(status.external, true);
  assert.equal(status.instances.length, 1);
  assert.equal((await httpRequest({ port: gui.port, path: '/api/background/start', method: 'POST', body: '{}' })).status, 409);
  const stop = await httpRequest({ port: gui.port, path: '/api/background/stop', method: 'POST', body: '{}' });
  assert.equal(stop.status, 200);
  assert.equal(JSON.parse(stop.text).stoppedCount, 1);
  assert.deepEqual(requests.filter(r => r[0].endsWith('/stop')), [['http://127.0.0.1:19998/stop', 'POST']]);
});

test('concurrent backend starts cannot both pass the status check', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanupDir(root));
  const desktopDir = path.join(root, 'desktop'); fs.mkdirSync(desktopDir);
  const htmlPath = path.join(root, 'studio.html'); fs.writeFileSync(htmlPath, '<html></html>');
  fs.writeFileSync(path.join(desktopDir, 'launch.cjs'), '// mock');
  let release, started;
  const spawned = new Promise(resolve => { started = resolve; });
  const gui = await startGuiServer({ htmlPath, desktopDir, dataDir: path.join(root, 'data'), startupDir: null, port: 0,
    spawnImpl: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      release = () => { child.stdout.emit('data', Buffer.from('http://127.0.0.1:19998')); child.emit('exit', 0); };
      started(); return child;
    } });
  t.after(() => gui.close());
  const first = httpRequest({ port: gui.port, path: '/api/background/start', method: 'POST', body: '{}' });
  await spawned;
  assert.equal((await httpRequest({ port: gui.port, path: '/api/background/start', method: 'POST', body: '{}' })).status, 409);
  release();
  assert.equal((await first).status, 200);
});

test('gui-server binds strictly to 127.0.0.1, falls back if busy, serves HTML with security headers, and blocks foreign Origin/Host', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanupDir(root));
  const htmlFile = path.join(root, 'offline.html');
  fs.writeFileSync(htmlFile, '<!doctype html><html><body>OK-离线工作台</body></html>', 'utf8');

  // Occupy a port to force EADDRINUSE fallback
  const blocker = http.createServer((_req, res) => res.end());
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => blocker.close(r)));
  const busyPort = blocker.address().port;

  let openedUrl = null;
  const gui = await startGuiServer({
    htmlPath: htmlFile,
    dataDir: path.join(root, 'data'),
    startupDir: path.join(root, 'startup'),
    port: busyPort,
    open: true,
    openBrowser: (u) => { openedUrl = u; },
  });
  t.after(() => gui.close());

  assert.notEqual(gui.port, busyPort);
  assert.equal(gui.server.address().address, '127.0.0.1');
  assert.equal(openedUrl, `http://127.0.0.1:${gui.port}/`);

  const home = await httpRequest({ port: gui.port, path: '/' });
  assert.equal(home.status, 200);
  assert.match(home.text, /OK-离线工作台/);
  assert.equal(home.headers['x-content-type-options'], 'nosniff');
  assert.equal(home.headers['x-frame-options'], 'DENY');
  assert.equal(home.headers['referrer-policy'], 'no-referrer');
  assert.equal(home.headers['cache-control'], 'no-store');
  assert.match(home.headers['content-security-policy'], /default-src 'self'/);
  assert.match(home.headers['content-security-policy'], /frame-ancestors 'none'/);

  // Reject foreign Origin on GET and POST
  const badOriginGet = await httpRequest({
    port: gui.port,
    path: '/api/background/status',
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(badOriginGet.status, 403);

  const badOriginPost = await httpRequest({
    port: gui.port,
    path: '/api/background/stop',
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(badOriginPost.status, 403);

  // Reject cross-site Sec-Fetch-Site
  const crossSite = await httpRequest({
    port: gui.port,
    path: '/api/background/status',
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);

  // Reject forged Host header
  const badHost = await httpRequest({
    port: gui.port,
    path: '/',
    headers: { Host: `localhost:${gui.port}` },
  });
  assert.equal(badHost.status, 403);
});

test('gui-server dev asset serving restricts paths strictly to allowed repo roots', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanupDir(root));
  const gui = await startGuiServer({
    htmlPath: path.join(REPO_ROOT, 'web', 'index.html'),
    dataDir: path.join(root, 'data'),
    startupDir: path.join(root, 'startup'),
    port: 0,
  });
  t.after(() => gui.close());

  const cssRes = await httpRequest({ port: gui.port, path: '/style.css' });
  assert.equal(cssRes.status, 200);
  const themesRes = await httpRequest({ port: gui.port, path: '/profiles/themes.json' });
  assert.equal(themesRes.status, 200);
  const blockedPkg = await httpRequest({ port: gui.port, path: '/../package.json' });
  assert.equal(blockedPkg.status, 404);
  const blockedDesktop = await httpRequest({ port: gui.port, path: '/desktop/bridge.cjs' });
  assert.equal(blockedDesktop.status, 404);
});

test('gui-server background status, start, stop, and startup IPC endpoints operate safely with injected runners', async (t) => {
  const root = makeTempDir();
  t.after(() => cleanupDir(root));
  const dataDir = path.join(root, 'data');
  const startupDir = path.join(root, 'startup');
  const desktopDir = path.join(root, 'desktop');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(startupDir, { recursive: true });
  fs.mkdirSync(desktopDir, { recursive: true });

  const htmlFile = path.join(root, 'studio.html');
  fs.writeFileSync(htmlFile, '<html><body>studio</body></html>', 'utf8');
  fs.writeFileSync(path.join(desktopDir, 'launch.cjs'), '// stub', 'utf8');
  fs.writeFileSync(path.join(desktopDir, 'startup.ps1'), '# stub', 'utf8');

  // Fake local bridge state without touching HID
  let bridgeAlive = false;
  let stopCalled = false;
  const fakeBridgePid = 424242;
  const fakeBridge = http.createServer((req, res) => {
    if (req.url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        pid: fakeBridgePid,
        connected: false,
        demo: true,
        wantedMode: 'lyrics',
        settings: { layout: 'compact', mode: 'lyrics' },
      }));
      return;
    }
    if (req.url === '/stop' && req.method === 'POST') {
      stopCalled = true;
      bridgeAlive = false;
      try { fs.unlinkSync(path.join(dataDir, 'background-service.json')); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => fakeBridge.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => fakeBridge.close(r)));
  const bridgeUrl = `http://127.0.0.1:${fakeBridge.address().port}`;

  const spawnCalls = [];
  const execCalls = [];
  const gui = await startGuiServer({
    htmlPath: htmlFile,
    desktopDir,
    dataDir,
    startupDir,
    port: 0,
    isPidAlive: (pid) => bridgeAlive && pid === fakeBridgePid,
    spawnImpl: (exe, args) => {
      spawnCalls.push({ exe, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      bridgeAlive = true;
      fs.writeFileSync(
        path.join(dataDir, 'background-service.json'),
        JSON.stringify({ pid: fakeBridgePid, port: fakeBridge.address().port, url: bridgeUrl }),
        'utf8'
      );
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from(`${bridgeUrl}\n`));
        child.emit('exit', 0);
      });
      return child;
    },
    execFileImpl: (exe, args, _opts, cb) => {
      execCalls.push({ exe, args });
      const idx = args.indexOf('-Action');
      const action = idx >= 0 ? args[idx + 1] : '';
      const vbsPath = path.join(startupDir, 'Rainy75V2-TFT-Lyrics.vbs');
      if (action === 'Enable') {
        fs.writeFileSync(vbsPath, "' mocked vbs\r\n", 'utf16le');
      } else if (action === 'Disable') {
        try { fs.unlinkSync(vbsPath); } catch {}
      }
      cb(null, `${action} ok`, '');
    },
  });
  t.after(() => gui.close());

  const origin = `http://127.0.0.1:${gui.port}`;

  // Initial status: not running
  const s0 = JSON.parse((await httpRequest({ port: gui.port, path: '/api/background/status' })).text);
  assert.equal(s0.running, false);
  assert.equal(s0.startupEnabled, false);

  // Start via IPC
  const startRes = await httpRequest({
    port: gui.port,
    path: '/api/background/start',
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { mode: 1, layout: 4, textSize: 30, volumeEnabled: false } }),
  });
  assert.equal(startRes.status, 200);
  const startJson = JSON.parse(startRes.text);
  assert.equal(startJson.ok, true);
  assert.equal(startJson.url, bridgeUrl);
  assert.equal(startJson.pid, fakeBridgePid);
  assert.equal(spawnCalls.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'background-settings.json'), 'utf8'));
  assert.equal(saved.layout, 4);
  assert.equal(saved.volumeEnabled, false);

  const s1 = JSON.parse((await httpRequest({ port: gui.port, path: '/api/background/status' })).text);
  assert.equal(s1.running, true);
  assert.equal(s1.demo, true);
  assert.equal(s1.mode, 'lyrics');
  assert.equal(s1.layout, 'compact');

  // Startup invalid payload -> 400
  const badStartup = await httpRequest({
    port: gui.port,
    path: '/api/background/startup',
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: 'yes' }),
  });
  assert.equal(badStartup.status, 400);

  // Enable & disable startup
  fs.writeFileSync(path.join(dataDir, 'background-runtime.json'), JSON.stringify({ nodeExecutable: 'Z:/old/node.exe' }));
  const enRes = JSON.parse((await httpRequest({
    port: gui.port,
    path: '/api/background/startup',
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  })).text);
  assert.equal(enRes.ok, true);
  assert.equal(enRes.startupEnabled, true);
  assert.equal(execCalls.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'background-runtime.json'), 'utf8')).nodeExecutable, process.execPath);

  const disRes = JSON.parse((await httpRequest({
    port: gui.port,
    path: '/api/background/startup',
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  })).text);
  assert.equal(disRes.ok, true);
  assert.equal(disRes.startupEnabled, false);

  // Stop background
  const stopRes = JSON.parse((await httpRequest({
    port: gui.port,
    path: '/api/background/stop',
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: '{}',
  })).text);
  assert.equal(stopRes.ok, true);
  assert.equal(stopRes.wasRunning, true);
  assert.equal(stopCalled, true);

  // Stop when already stopped is idempotent
  const stopAgain = JSON.parse((await httpRequest({
    port: gui.port,
    path: '/api/background/stop',
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: '{}',
  })).text);
  assert.equal(stopAgain.ok, true);
  assert.equal(stopAgain.wasRunning, false);
});

test('real demo bridge --demo stop lifecycle & CLI gui-server startup/stop work without touching HID', async (t) => {
  const root = makeTempDir('r75-demo-中文 路径-');
  t.after(() => cleanupDir(root));
  const dataDir = path.join(root, '数据 目录');
  const startupDir = path.join(root, '自启 目录');
  const htmlFile = path.join(root, '工作台.html');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(startupDir, { recursive: true });
  fs.writeFileSync(htmlFile, '<html><body>demo-ready</body></html>', 'utf8');

  // Spawn real bridge in --demo mode (never touches HID/media/hotkeys)
  const bridgeProc = spawn(process.execPath, [BRIDGE_PATH, '--demo'], {
    cwd: REPO_ROOT,
    env: { ...process.env, RAINY75_DATA: dataDir },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bridgeExited = false;
  bridgeProc.once('exit', () => { bridgeExited = true; });
  t.after(() => {
    if (!bridgeExited) {
      try { bridgeProc.kill(); } catch {}
    }
  });

  // Wait until background-service.json appears
  const svcPath = path.join(dataDir, 'background-service.json');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !fs.existsSync(svcPath)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(fs.existsSync(svcPath), 'demo bridge must write background-service.json');

  // Spawn real CLI gui-server.cjs on ephemeral port
  const guiProc = spawn(
    process.execPath,
    [GUI_SERVER_PATH, '--html', htmlFile, '--port', '0', '--data-dir', dataDir, '--startup-dir', startupDir, '--registry-file', path.join(dataDir, 'test-background-locations.json')],
    { cwd: REPO_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let guiExited = false;
  guiProc.once('exit', () => { guiExited = true; });
  t.after(() => {
    if (!guiExited) {
      try { guiProc.kill(); } catch {}
    }
  });

  const urlMatch = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`CLI stdout timeout: ${out}`)), 8000);
    guiProc.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
      const m = /URL=(http:\/\/127\.0\.0\.1:(\d+)\/)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ url: m[1], port: Number(m[2]) });
      }
    });
    guiProc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`gui-server exited early (${code}): ${out}`));
    });
  });

  const status = JSON.parse((await httpRequest({ port: urlMatch.port, path: '/api/background/status' })).text);
  assert.equal(status.running, true);
  assert.equal(status.demo, true);
  assert.equal(status.pid, bridgeProc.pid);

  // Stop real demo bridge cleanly via gui-server IPC
  const stopBridge = JSON.parse((await httpRequest({
    port: urlMatch.port,
    path: '/api/background/stop',
    method: 'POST',
    headers: { Origin: `http://127.0.0.1:${urlMatch.port}`, 'Content-Type': 'application/json' },
    body: '{}',
  })).text);
  assert.equal(stopBridge.ok, true);
  assert.equal(stopBridge.wasRunning, true);

  // Ensure demo bridge exited cleanly
  await new Promise((resolve, reject) => {
    if (bridgeExited) return resolve();
    const timer = setTimeout(() => reject(new Error('demo bridge did not exit')), 4000);
    bridgeProc.once('exit', () => { clearTimeout(timer); resolve(); });
  });

  // Stop CLI gui-server cleanly via /api/server/stop
  const stopServer = await httpRequest({
    port: urlMatch.port,
    path: '/api/server/stop',
    method: 'POST',
    headers: { Origin: `http://127.0.0.1:${urlMatch.port}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(stopServer.status, 200);
  const exitCode = await new Promise((resolve, reject) => {
    if (guiExited) return resolve(0);
    const timer = setTimeout(() => reject(new Error('gui-server did not exit')), 4000);
    guiProc.once('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(exitCode, 0);
});

test('config.cjs and startup.ps1 handle portable Chinese + space directories using isolated RAINY75_STARTUP_DIR', { skip: process.platform !== 'win32' }, async (t) => {
  const root = makeTempDir('r75-中文 便携 测试-');
  t.after(() => cleanupDir(root));

  // Simulate portable backend layout: <root>/runtime/node.exe, <root>/app/desktop/config.cjs, <root>/app/FONT.BIN
  const portableBase = path.join(root, 'Windows 便携后台');
  const runtimeDir = path.join(portableBase, 'runtime');
  const appDir = path.join(portableBase, 'app');
  const desktopDir = path.join(appDir, 'desktop');
  const dataDir = path.join(portableBase, 'data');
  const startupDir = path.join(root, '测试 自启目录');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.mkdirSync(startupDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'node.exe'), '', 'utf8');
  fs.writeFileSync(path.join(appDir, 'FONT.BIN'), 'stub', 'utf8');
  fs.copyFileSync(CONFIG_PATH, path.join(desktopDir, 'config.cjs'));

  // Run node in child so config.cjs resolves portable DATA & FONT cleanly without polluting cache
  const cfgCheck = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['-e', `const c=require(process.argv[1]);console.log(JSON.stringify({DATA:c.DATA,FONT:c.FONT}))`, path.join(desktopDir, 'config.cjs')],
      { env: { PATH: process.env.PATH }, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(JSON.parse(stdout.trim()));
      }
    );
  });
  assert.equal(cfgCheck.DATA, dataDir);
  assert.equal(cfgCheck.FONT, path.join(appDir, 'FONT.BIN'));

  fs.mkdirSync(dataDir, { recursive: true });
  const fakeNode = path.join(runtimeDir, 'node.exe');
  const fakeLauncher = path.join(desktopDir, 'launch.cjs');
  const portableStartupPs1 = path.join(desktopDir, 'startup.ps1');
  fs.writeFileSync(fakeLauncher, '// stub', 'utf8');
  fs.copyFileSync(STARTUP_PS1, portableStartupPs1);
  fs.writeFileSync(
    path.join(dataDir, 'background-runtime.json'),
    JSON.stringify({ nodeExecutable: fakeNode, launcher: fakeLauncher, dataDirectory: dataDir }, null, 2),
    'utf8'
  );

  // Execute real startup.ps1 from portable Chinese + space directory pointing ONLY to isolated temp startupDir
  await new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', portableStartupPs1, '-Action', 'Enable', '-DataDirectory', dataDir, '-StartupDirectory', startupDir],
      { env: { ...process.env, RAINY75_DATA: dataDir, RAINY75_STARTUP_DIR: startupDir }, windowsHide: true },
      (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())
    );
  });

  const vbsPath = path.join(startupDir, 'Rainy75V2-TFT-Lyrics.vbs');
  assert.ok(fs.existsSync(vbsPath), 'VBS shortcut should be created in isolated startupDir');
  const vbsText = fs.readFileSync(vbsPath, 'utf16le').replace(/^\uFEFF/, '');
  assert.ok(vbsText.includes('Windows 便携后台'), 'UTF-16LE VBS must preserve Chinese directory name without mojibake');
  assert.ok(vbsText.includes(fakeNode));
  assert.ok(vbsText.includes(fakeLauncher));
  assert.ok(vbsText.includes(path.join(appDir, 'FONT.BIN')));

  // Verify gui-server /api/background/status sees startupEnabled=true in isolated startupDir
  const htmlFile = path.join(root, 'index.html');
  fs.writeFileSync(htmlFile, '<html></html>', 'utf8');
  const gui = await startGuiServer({ htmlPath: htmlFile, desktopDir, dataDir, startupDir, port: 0 });
  t.after(() => gui.close());
  const st = JSON.parse((await httpRequest({ port: gui.port, path: '/api/background/status' })).text);
  assert.equal(st.startupEnabled, true);

  // Disable startup and verify cleanup
  await new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', portableStartupPs1, '-Action', 'Disable', '-DataDirectory', dataDir, '-StartupDirectory', startupDir],
      { env: { ...process.env, RAINY75_DATA: dataDir, RAINY75_STARTUP_DIR: startupDir }, windowsHide: true },
      (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())
    );
  });
  assert.equal(fs.existsSync(vbsPath), false);
});

test('stop does not report success while the bridge still owns a live process', async t => {
  const root = makeTempDir(); t.after(() => cleanupDir(root));
  const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir);
  const htmlPath = path.join(root, 'studio.html'); fs.writeFileSync(htmlPath, '<html></html>');
  const pid = 424243;
  fs.writeFileSync(path.join(dataDir, 'background-service.json'), JSON.stringify({ pid, url: 'http://127.0.0.1:12345' }));
  const gui = await startGuiServer({ htmlPath, dataDir, port: 0, startupDir: null,
    isPidAlive: () => true,
    fetchImpl: async () => ({ ok: true, json: async () => ({ pid, connected: true }) }) });
  t.after(() => gui.close());
  const result = await httpRequest({ port: gui.port, path: '/api/background/stop', method: 'POST', body: '{}' });
  assert.equal(result.status, 409);
  assert.equal(JSON.parse(result.text).ok, false);
  assert.match(JSON.parse(result.text).error, /尚未退出/);
});

test('a live but unreachable bridge blocks starting or claiming USB is released', async t => {
  const root = makeTempDir(); t.after(() => cleanupDir(root));
  const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir);
  const htmlPath = path.join(root, 'studio.html'); fs.writeFileSync(htmlPath, '<html></html>');
  fs.writeFileSync(path.join(dataDir, 'background-service.json'), JSON.stringify({ pid: 424244, url: 'http://127.0.0.1:12345' }));
  const gui = await startGuiServer({ htmlPath, dataDir, port: 0, startupDir: null,
    isPidAlive: () => true, fetchImpl: async () => { throw new Error('not responding'); } });
  t.after(() => gui.close());
  const state = JSON.parse((await httpRequest({ port: gui.port, path: '/api/background/status' })).text);
  assert.equal(state.unreachable, true);
  for (const action of ['start', 'stop']) {
    const result = await httpRequest({ port: gui.port, path: `/api/background/${action}`, method: 'POST', body: '{}' });
    assert.equal(result.status, 409);
  }
});
