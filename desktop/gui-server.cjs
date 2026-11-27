// SPDX-License-Identifier: MIT
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { defaultRegistryFile, registeredServiceFiles, registerServiceFile, startupServiceFiles } = require('./background-locations.cjs');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const LOCAL_BRIDGE_URL_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const DEFAULT_HTML_NAME = 'Rainy75V2-定制与部署工作台.html';
const STARTUP_VBS_NAME = 'Rainy75V2-TFT-Lyrics.vbs';

function defaultStartupDir(env = process.env, platform = process.platform) {
  if (env.RAINY75_STARTUP_DIR) return path.resolve(env.RAINY75_STARTUP_DIR);
  if (platform === 'win32' && env.APPDATA) {
    return path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  }
  return null;
}

function resolveDefaultHtml(baseDir = __dirname, env = process.env) {
  if (env.RAINY75_HTML) return path.resolve(env.RAINY75_HTML);
  const candidates = [
    path.resolve(baseDir, '..', '..', '..', DEFAULT_HTML_NAME),
    path.resolve(baseDir, '..', '..', DEFAULT_HTML_NAME),
    path.resolve(baseDir, '..', DEFAULT_HTML_NAME),
    path.resolve(baseDir, DEFAULT_HTML_NAME),
    path.resolve(baseDir, '..', 'web', 'studio.html'),
    path.resolve(baseDir, '..', 'web', 'index.html'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return candidates[0];
}

function resolveDefaults(options = {}) {
  const desktopDir = path.resolve(options.desktopDir || process.env.RAINY75_DESKTOP_DIR || __dirname);
  const configPath = path.join(desktopDir, 'config.cjs');
  let config = null;
  if (fs.existsSync(configPath)) {
    try {
      config = require(configPath);
    } catch {
      config = null;
    }
  }
  const htmlPath = path.resolve(options.htmlPath || resolveDefaultHtml(desktopDir, process.env));
  const dataDir = path.resolve(
    options.dataDir || process.env.RAINY75_DATA || config?.DATA || path.resolve(desktopDir, '..', 'local', 'lyrics')
  );
  const fontPath = options.fontPath || process.env.RAINY75_FONT || config?.FONT || null;
  const startupDir = options.startupDir === null
    ? null
    : (options.startupDir ? path.resolve(options.startupDir) : defaultStartupDir());
  const port = options.port !== undefined ? Number(options.port) : 8765;
  return {
    htmlPath,
    edition: config?.EDITION || null,
    desktopDir,
    dataDir,
    fontPath: fontPath ? path.resolve(fontPath) : null,
    startupDir,
    registryFile: options.registryFile ? path.resolve(options.registryFile) : null,
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 8765,
    open: Boolean(options.open),
  };
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    if (arg === '--html') result.htmlPath = next();
    else if (arg === '--port') result.port = Number(next());
    else if (arg === '--open') result.open = true;
    else if (arg === '--desktop-dir') result.desktopDir = next();
    else if (arg === '--data-dir') result.dataDir = next();
    else if (arg === '--font') result.fontPath = next();
    else if (arg === '--startup-dir') result.startupDir = next();
    else if (arg === '--registry-file') result.registryFile = next();
    else throw Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP_POLICY,
    ...extra,
  };
}

function isUnderDir(rootDir, targetPath) {
  const rel = path.relative(rootDir, targetPath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveDevAsset(htmlPath, pathname) {
  const htmlDir = path.dirname(htmlPath);
  if (path.basename(htmlDir) !== 'web') return null;
  const repoRoot = path.dirname(htmlDir);
  if (!fs.existsSync(path.join(repoRoot, 'profiles'))) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;

  const clean = decoded.replace(/^\/+/, '');
  if (!clean) return null;

  const allowedRootNames = new Set(['profiles', 'assets', 'docs']);
  const allowedRootFiles = new Set(['LICENSE', 'DISCLAIMER.md', 'THIRD_PARTY_NOTICES.md', 'README.md']);
  let candidate = null;

  if (clean === 'web' || clean === 'web/') {
    candidate = htmlPath;
  } else if (clean.startsWith('web/')) {
    const sub = clean.slice(4);
    const resolved = path.resolve(htmlDir, sub);
    if (isUnderDir(htmlDir, resolved)) candidate = resolved;
  } else if (allowedRootFiles.has(clean)) {
    candidate = path.resolve(repoRoot, clean);
  } else {
    const first = clean.split('/', 1)[0];
    if (allowedRootNames.has(first)) {
      const base = path.resolve(repoRoot, first);
      const resolved = path.resolve(repoRoot, clean);
      if (isUnderDir(base, resolved)) candidate = resolved;
    } else {
      const resolved = path.resolve(htmlDir, clean);
      if (isUnderDir(htmlDir, resolved)) candidate = resolved;
    }
  }

  if (!candidate || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  const ext = path.extname(candidate).toLowerCase();
  const baseName = path.basename(candidate);
  const contentType = MIME_TYPES[ext] || (baseName === 'LICENSE' ? 'text/plain; charset=utf-8' : null);
  if (!contentType) return null;
  return { filePath: candidate, contentType };
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function readJsonBody(req, maxBytes = 65536) {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > maxBytes) {
      throw Object.assign(new Error('请求体过大'), { statusCode: 413 });
    }
  }
  if (!body.trim()) return {};
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON 请求体必须是对象');
    }
    return parsed;
  } catch (err) {
    if (err.statusCode) throw err;
    throw Object.assign(new Error('无效 JSON 请求'), { statusCode: 400 });
  }
}

function defaultOpenBrowser(url) {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/$/.test(url)) return;
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
  } else if (process.platform === 'darwin') {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } else {
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  }
}

function createGuiServer(options = {}) {
  const cfg = resolveDefaults(options);
  if (!fs.existsSync(cfg.htmlPath) || !fs.statSync(cfg.htmlPath).isFile()) {
    throw new Error(`未找到前端工作台 HTML 文件：${cfg.htmlPath}`);
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const spawnImpl = options.spawnImpl || spawn;
  const execFileImpl = options.execFileImpl || execFile;
  const nodeExecutable = options.nodeExecutable || process.execPath;
  const isPidAliveImpl = options.isPidAlive || isPidAlive;
  const openBrowserImpl = options.openBrowser || defaultOpenBrowser;
  const onStop = options.onStop || null;

  const startupVbsPath = cfg.startupDir ? path.join(cfg.startupDir, STARTUP_VBS_NAME) : null;
  let backgroundMutation = false;

  function buildChildEnv() {
    const env = { ...process.env, RAINY75_DATA: cfg.dataDir };
    if (cfg.fontPath) env.RAINY75_FONT = cfg.fontPath;
    if (cfg.startupDir) env.RAINY75_STARTUP_DIR = cfg.startupDir;
    return env;
  }

  async function querySingleBackground(serviceFile) {
    const startupEnabled = Boolean(startupVbsPath && fs.existsSync(startupVbsPath));
    const service = readJsonSafe(serviceFile);
    const base = {
      running: false,
      pid: null,
      url: null,
      connected: false,
      mode: null,
      layout: null,
      edition: null,
      demo: false,
      startupEnabled,
      external: serviceFile !== path.join(cfg.dataDir, 'background-service.json'),
    };

    if (!service || !Number.isInteger(service.pid) || service.pid <= 0 || !LOCAL_BRIDGE_URL_RE.test(service.url || '')) {
      return base;
    }
    const unavailable = () => ({ ...base, pid: service.pid, unreachable: isPidAliveImpl(service.pid) });

    try {
      const res = await fetchWithTimeout(fetchImpl, `${service.url}/state`, { method: 'GET' }, 500);
      if (!res || !res.ok) return unavailable();
      const state = await res.json();
      if (!state || state.pid !== service.pid) return unavailable();
      return {
        running: true,
        pid: service.pid,
        url: service.url,
        connected: Boolean(state.connected),
        mode: state.wire?.mode ?? state.wantedMode ?? state.settings?.mode ?? null,
        layout: state.settings?.layout ?? state.wire?.layout ?? null,
        demo: Boolean(state.demo),
        edition: state.edition || null,
        startupEnabled,
        external: base.external,
      };
    } catch {
      return unavailable();
    }
  }

  async function queryBackgroundStatus() {
    const files = [...new Set([path.join(cfg.dataDir, 'background-service.json'),
      ...registeredServiceFiles(cfg.registryFile), ...startupServiceFiles(cfg.startupDir)])];
    const all = await Promise.all(files.map(querySingleBackground));
    const seen = new Set();
    const live = all.filter(item => {
      if ((!item.running && !item.unreachable) || seen.has(item.pid)) return false;
      seen.add(item.pid); return true;
    });
    return { ...(live[0] || all[0]), instances: live };
  }

  function runLaunch() {
    const launchPath = path.join(cfg.desktopDir, 'launch.cjs');
    if (!fs.existsSync(launchPath)) {
      return Promise.reject(new Error(`未找到后台启动脚本：${launchPath}`));
    }
    return new Promise((resolve, reject) => {
      const child = spawnImpl(nodeExecutable, [launchPath], {
        cwd: cfg.desktopDir,
        env: buildChildEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill?.(); } catch {}
        reject(new Error('后台启动超时'));
      }, 18000);

      child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(err?.message || '无法拉起后台进程'));
      });
      child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(stderr.trim() || stdout.trim() || `后台启动失败（退出码 ${code}）`));
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  function runStartupScript(enabled) {
    const scriptPath = path.join(cfg.desktopDir, 'startup.ps1');
    if (!fs.existsSync(scriptPath)) {
      return Promise.reject(new Error(`未找到开机自启脚本：${scriptPath}`));
    }
    const runtimePath = path.join(cfg.dataDir, 'background-runtime.json');
    const launchPath = path.join(cfg.desktopDir, 'launch.cjs');
    if (enabled && fs.existsSync(launchPath)) {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      fs.writeFileSync(
        runtimePath,
        JSON.stringify(
          { nodeExecutable, launcher: launchPath, dataDirectory: cfg.dataDir },
          null,
          2
        )
      );
    }

    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Action',
      enabled ? 'Enable' : 'Disable',
      '-DataDirectory',
      cfg.dataDir,
    ];
    return new Promise((resolve, reject) => {
      execFileImpl(
        'powershell.exe',
        args,
        { windowsHide: true, timeout: 15000, env: buildChildEnv() },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error((stderr && String(stderr).trim()) || err.message || '登录自启设置失败'));
            return;
          }
          resolve(String(stdout || '').trim());
        }
      );
    });
  }

  let server = null;
  let closing = false;

  const closeServer = () => new Promise((resolve) => {
    if (closing) {
      resolve();
      return;
    }
    closing = true;
    try {
      server.close(() => resolve());
      server.closeAllConnections?.();
    } catch {
      resolve();
    }
  });

  server = http.createServer(async (req, res) => {
    const replyJson = (statusCode, payload) => {
      res.writeHead(statusCode, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
      res.end(JSON.stringify(payload));
    };

    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : cfg.port;
    const expectedHost = `127.0.0.1:${port}`;
    const expectedOrigin = `http://${expectedHost}`;

    if (req.headers.host !== expectedHost) {
      replyJson(403, { ok: false, error: 'Invalid local host' });
      return;
    }
    if (req.headers.origin && req.headers.origin !== expectedOrigin) {
      replyJson(403, { ok: false, error: '来源不匹配' });
      return;
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      replyJson(403, { ok: false, error: '来源不匹配' });
      return;
    }

    const url = new URL(req.url || '/', expectedOrigin);

    if (req.method === 'GET') {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        try {
          const html = fs.readFileSync(cfg.htmlPath);
          res.writeHead(200, securityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
          res.end(html);
        } catch (err) {
          replyJson(500, { ok: false, error: err.message });
        }
        return;
      }

      if (url.pathname === '/favicon.ico') {
        res.writeHead(204, securityHeaders());
        res.end();
        return;
      }

      if (url.pathname === '/api/background/status') {
        const status = await queryBackgroundStatus();
        replyJson(200, status);
        return;
      }

      const devAsset = resolveDevAsset(cfg.htmlPath, url.pathname);
      if (devAsset) {
        res.writeHead(200, securityHeaders({ 'Content-Type': devAsset.contentType }));
        res.end(fs.readFileSync(devAsset.filePath));
        return;
      }

      replyJson(404, { ok: false, error: 'Not found' });
      return;
    }

    if (req.method !== 'POST') {
      replyJson(405, { ok: false, error: 'Method not allowed' });
      return;
    }

    let ownsBackgroundMutation = false;
    try {
      if (['/api/background/start', '/api/background/stop'].includes(url.pathname)) {
        if (backgroundMutation) throw Object.assign(new Error('后台启停正在进行中，请稍候'), { statusCode: 409 });
        backgroundMutation = true;
        ownsBackgroundMutation = true;
      }
      if (url.pathname === '/api/background/start') {
        const body = await readJsonBody(req);
        if (cfg.edition?.layout === null) throw new Error('桌宠与按键版无需歌词后台');
        if (cfg.edition && body.settings !== undefined) throw new Error('安装包版式已固定');
        const before = await queryBackgroundStatus();
        if (before.instances.some(item => item.unreachable)) throw Object.assign(new Error('现有后台未响应，请退出后再启动'), { statusCode: 409 });
        if (before.instances.some(item => item.external)) throw Object.assign(new Error('另一个安装目录的后台正在运行，请先停止旧后台'), { statusCode: 409 });
        if (body.settings !== undefined) {
          const selected = body.settings;
          const choices = { mode: [0, 1], layout: [0, 1, 2, 3, 4], textSize: [20, 30, 40],
            textStyle: [0, 1], volumeEnabled: [false, true], volumeScope: [0, 1], volumeStyle: [0, 1] };
          if (!selected || typeof selected !== 'object' || Array.isArray(selected)) throw new Error('播放器设置格式无效');
          for (const [key, value] of Object.entries(selected)) {
            if (key === 'volumeHoldMs') {
              if (!Number.isInteger(value) || value < 400 || value > 3000) throw new Error('音量提示停留时间无效');
            } else if (!choices[key]?.includes(value)) throw new Error(`播放器设置无效：${key}`);
          }
          if ((await queryBackgroundStatus()).running) {
            throw Object.assign(new Error('请先停止后台，再应用工作台中的播放器设置'), { statusCode: 409 });
          }
          fs.mkdirSync(cfg.dataDir, { recursive: true });
          const settingsFile = path.join(cfg.dataDir, 'background-settings.json');
          fs.writeFileSync(settingsFile, JSON.stringify({ ...readJsonSafe(settingsFile), ...selected }, null, 2));
        }
        const printed = await runLaunch();
        const status = await queryBackgroundStatus();
        const urlOut = status.url || (LOCAL_BRIDGE_URL_RE.test(printed) ? printed : null);
        if (!urlOut && !status.running) {
          throw Object.assign(new Error('后台未返回有效本地地址'), { statusCode: 500 });
        }
        replyJson(200, {
          ok: true,
          url: urlOut,
          pid: status.pid,
          connected: status.connected,
          mode: status.mode,
          layout: status.layout,
          edition: status.edition,
        });
        return;
      }

      if (url.pathname === '/api/background/stop') {
        await readJsonBody(req);
        const status = await queryBackgroundStatus();
        if (status.instances.some(item => item.unreachable)) throw Object.assign(new Error('后台进程仍在运行但无法响应，尚不能确认 USB 已释放。请先退出该后台。'), { statusCode: 409 });
        if (!status.running || !status.url) {
          replyJson(200, { ok: true, wasRunning: false });
          return;
        }
        for (const instance of status.instances) try {
          const stopRes = await fetchWithTimeout(
            fetchImpl,
            `${instance.url}/stop`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            },
            1500
          );
          if (!stopRes.ok) {
            throw new Error(`后台停止请求返回 HTTP ${stopRes.status}`);
          }
        } catch (err) {
          throw Object.assign(new Error(`通知后台退出失败：${err.message}`), { statusCode: 500 });
        }

        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          const current = await queryBackgroundStatus();
          const alive = status.instances.some(instance => isPidAliveImpl(instance.pid));
          if (!current.running && !current.unreachable && !alive) break;
          await new Promise((r) => setTimeout(r, 50));
        }

        const stopped = await queryBackgroundStatus();
        if (stopped.running || stopped.unreachable || status.instances.some(instance => isPidAliveImpl(instance.pid))) {
          throw Object.assign(new Error('后台尚未退出，USB 可能仍被占用。请等待后重试停止，再连接键盘。'), { statusCode: 409 });
        }

        replyJson(200, { ok: true, wasRunning: true, pid: status.pid, stoppedCount: status.instances.length });
        return;
      }

      if (url.pathname === '/api/background/startup') {
        const body = await readJsonBody(req);
        if (typeof body.enabled !== 'boolean') {
          throw Object.assign(new Error('无效设置：enabled 必须为布尔值'), { statusCode: 400 });
        }
        const message = await runStartupScript(body.enabled);
        const startupEnabled = startupVbsPath ? fs.existsSync(startupVbsPath) : body.enabled;
        replyJson(200, { ok: true, enabled: body.enabled, startupEnabled, message });
        return;
      }

      if (url.pathname === '/api/server/stop') {
        await readJsonBody(req);
        replyJson(200, { ok: true });
        setTimeout(() => {
          closeServer().then(() => onStop?.());
        }, 40);
        return;
      }

      replyJson(404, { ok: false, error: 'Not found' });
    } catch (err) {
      const code = Number.isInteger(err?.statusCode) ? err.statusCode : 400;
      replyJson(code, { ok: false, error: err?.message || '操作失败' });
    } finally {
      if (ownsBackgroundMutation) backgroundMutation = false;
    }
  });

  async function listen() {
    const tryListen = (targetPort) =>
      new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve(server.address().port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(targetPort, '127.0.0.1');
      });

    let boundPort;
    try {
      boundPort = await tryListen(cfg.port);
    } catch (err) {
      if (cfg.port !== 0 && (err?.code === 'EADDRINUSE' || err?.code === 'EACCES')) {
        boundPort = await tryListen(0);
      } else {
        throw err;
      }
    }

    const url = `http://127.0.0.1:${boundPort}/`;
    if (cfg.open) openBrowserImpl(url);
    return { port: boundPort, url };
  }

  return { server, config: cfg, listen, close: closeServer };
}

async function startGuiServer(options = {}) {
  const instance = createGuiServer(options);
  const info = await instance.listen();
  return { ...instance, ...info };
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    args.registryFile ||= defaultRegistryFile();
    if (args.registryFile) {
      const config = resolveDefaults(args);
      registerServiceFile(args.registryFile, path.join(config.dataDir, 'background-service.json'));
    }
    let stopped = false;
    const shutdown = async () => {
      if (stopped) return;
      stopped = true;
      await instance.close();
      process.exit(0);
    };
    const instance = createGuiServer({
      ...args,
      onStop: () => process.exit(0),
    });
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    const { url } = await instance.listen();
    console.log(`URL=${url}`);
  })().catch((err) => {
    console.error(err?.message || String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  createGuiServer,
  startGuiServer,
  resolveDefaults,
  parseArgs,
  securityHeaders,
  CSP_POLICY,
};
