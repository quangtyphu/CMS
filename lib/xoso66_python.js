/**
 * Gọi xoso66_cms_bridge.py — logic site vẫn Python, API + DB trên CMS Node.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const XOSO66_STANDALONE_DIR =
  process.env.XOSO66_STANDALONE_DIR ||
  path.resolve(__dirname, '../../LC79/xoso66_standalone');
const BRIDGE_SCRIPT = path.join(XOSO66_STANDALONE_DIR, 'xoso66_cms_bridge.py');
const {
  XOSO66_DB_PATH,
  XOSO66_CONFIG_PATH,
  loadApiKey,
} = require('./xoso66_db');

const XOSO66_MAIN_API_PORT = parseInt(process.env.XOSO66_API_PORT || '8799', 10);
const XOSO66_MAIN_API_BASE = `http://127.0.0.1:${XOSO66_MAIN_API_PORT}`;

function pythonExecutable() {
  const candidates = [];
  const venvPy = path.resolve(__dirname, '../../LC79/.venv/Scripts/python.exe');
  if (process.env.XOSO66_PYTHON && fs.existsSync(process.env.XOSO66_PYTHON)) {
    candidates.push(process.env.XOSO66_PYTHON);
  }
  if (fs.existsSync(venvPy)) candidates.push(venvPy);
  if (process.env.PYTHON) candidates.push(process.env.PYTHON);
  candidates.push('python');
  return candidates[0] || 'python';
}

function bridgeEnv() {
  const cmsRoot = path.resolve(__dirname, '..');
  return {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    XOSO66_DB: XOSO66_DB_PATH,
    XOSO66_CONFIG: XOSO66_CONFIG_PATH,
    XOSO66_USE_DB: '1',
    CMS_ROOT: process.env.CMS_ROOT || cmsRoot,
    XOSO66_CMS_ROOT: process.env.XOSO66_CMS_ROOT || cmsRoot,
  };
}

function _emitBridgeLogLine(line, action) {
  const t = String(line || '').trim();
  if (!t) return;
  if (t.startsWith('{') && t.endsWith('}')) return;
  const prefix =
    action === 'auto_mission_claim' ? '[XOSO66-BRIDGE] ' : '[XOSO66-PROVISION] ';
  process.stderr.write(`${prefix}${line}${line.endsWith('\n') ? '' : '\n'}`);
}

async function mainApiReachable() {
  try {
    const res = await fetch(`${XOSO66_MAIN_API_BASE}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function forwardToMainApi(method, apiPath, body = {}, timeoutMs = 600000) {
  const key = loadApiKey();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${XOSO66_MAIN_API_BASE}${apiPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'X-API-Key': key } : {}),
      },
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(
        typeof data.detail === 'string'
          ? data.detail
          : data.error || `HTTP ${res.status}`
      );
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function runBridge(action, body = {}, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(BRIDGE_SCRIPT)) {
      return reject(new Error(`Không thấy bridge: ${BRIDGE_SCRIPT}`));
    }
    const py = pythonExecutable();
    const jsonBody = JSON.stringify(body || {});
    const child = spawn(
      py,
      [BRIDGE_SCRIPT, action, '--json', jsonBody],
      {
        cwd: XOSO66_STANDALONE_DIR,
        env: bridgeEnv(),
        windowsHide: true,
      }
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Bridge timeout ${timeoutMs}ms (${action})`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (
        action === 'auto_mission_claim' ||
        action === 'provision' ||
        action === 'sync_from_chrome'
      ) {
        for (const line of s.split('\n')) _emitBridgeLogLine(line, action);
      }
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (action === 'provision' || action === 'auto_mission_claim') {
        for (const line of s.split('\n')) {
          _emitBridgeLogLine(line, action);
        }
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split('\n').filter(Boolean).pop() || '';
      try {
        const parsed = JSON.parse(line || '{}');
        if (code !== 0 && !parsed.error) {
          parsed.ok = false;
          parsed.error = stderr.trim() || `exit ${code}`;
        }
        return resolve(parsed);
      } catch {
        reject(
          new Error(
            `Bridge ${action} parse lỗi (code=${code}): ${stderr.slice(0, 400) || stdout.slice(0, 400)}`
          )
        );
      }
    });
  });
}

module.exports = {
  runBridge,
  forwardToMainApi,
  mainApiReachable,
  XOSO66_MAIN_API_BASE,
  BRIDGE_SCRIPT,
  XOSO66_STANDALONE_DIR,
};
