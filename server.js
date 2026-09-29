
const express = require('express');
const { v4: uuidv4 } = require('uuid');
// ...existing code...
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const dayjs = require('dayjs');
const fs = require('fs');
const path = require('path');
const {
  registerAllgameRoutes,
  closeAllgameDb,
  allgameBrowserDirFor,
  allgameCdpPortFor,
  allgameNormalizePortalId,
} = require('./lib/allgame_api');
const { dbRun: xoso66DbRun } = require('./lib/xoso66_db');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

/** Chuẩn hóa time GD → YYYY-MM-DD HH:mm:ss (VN). Tránh ISO 'T' làm BETWEEN string so sánh sai. */
function normalizeTxnTimeStr(raw) {
  if (raw == null || raw === '') {
    return dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD HH:mm:ss');
  }
  const s = String(raw).trim();
  const d = dayjs(s);
  if (d.isValid()) {
    return d.tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD HH:mm:ss');
  }
  return s.replace('T', ' ').replace(/\.\d+Z?$/i, '').slice(0, 19);
}

/** SQL: thời điểm GD khi lọc theo ngày (db_time ưu tiên, fallback time đã chuẩn hóa). */
const TXN_EFFECTIVE_TIME_SQL = `datetime(COALESCE(NULLIF(db_time, ''), replace(replace(time, 'T', ' '), 'Z', '')))`;

const schedule = require('node-schedule');

const app = express();
const PORT = 3000;

/** slot_id preset (39|40|41) → tên hiển thị CMS */
const SLOT_PRESET_GAME_NAMES = {
  39: 'Tay chơi AVENGER',
  40: 'Chuyên gia Furius',
  41: 'Mỏ Đá Quý',
};

// Chuẩn hóa path: tránh lỗi Cannot GET //api/... khi gõ nhầm 127.0.0.1:3000//api/...
app.use((req, _res, next) => {
  const raw = typeof req.originalUrl === 'string' ? req.originalUrl : req.url;
  if (typeof raw === 'string' && raw.includes('//')) {
    const q = raw.indexOf('?');
    const pathPart = q === -1 ? raw : raw.slice(0, q);
    const search = q === -1 ? '' : raw.slice(q);
    const normalized = pathPart.replace(/\/{2,}/g, '/') || '/';
    const fixed = normalized + search;
    req.url = fixed;
    if (typeof req.originalUrl === 'string') req.originalUrl = fixed;
  }
  next();
});

// 🧩 Thêm ở đầu file (sau các require khác)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
app.use(cors());
app.use(bodyParser.json());
app.use(express.text({ type: 'text/plain' }));

// ------------------- Config files -------------------
const LC79_CONFIG_PATH = process.env.LC79_CONFIG_PATH
  || path.resolve(__dirname, '../LC79/lc79/config.json');
const XOSO66_STANDALONE_DIR = process.env.XOSO66_STANDALONE_DIR
  || path.resolve(__dirname, '../LC79/xoso66_standalone');
const XOSO66_CONFIG_PATH = process.env.XOSO66_CONFIG_PATH
  || process.env.XOSO66_CONFIG
  || path.join(XOSO66_STANDALONE_DIR, 'xoso66_config.json');
const BANKING_DEVICES_PATH = process.env.BANKING_DEVICES_PATH
  || path.resolve(__dirname, '../Banking/devices.json');
const BANKING_ENV_PATH = process.env.BANKING_ENV_PATH
  || path.resolve(__dirname, '../Banking/.env');

/** Nạp token từ Banking/.env nếu CMS chưa có (máy game cùng repo). Không đè BANKING_DB_URL. */
function loadBankingEnvFallback() {
  const allow = new Set(['APP_API_TOKEN', 'INTERNAL_DB_TOKEN', 'ADMIN_API_TOKEN']);
  try {
    if (!fs.existsSync(BANKING_ENV_PATH)) return;
    for (const raw of fs.readFileSync(BANKING_ENV_PATH, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      const key = line.slice(0, i).trim();
      if (!allow.has(key)) continue;
      let val = line.slice(i + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (
        key &&
        (process.env[key] === undefined || process.env[key] === '')
      ) {
        process.env[key] = val;
      }
    }
  } catch (_e) {
    /* ignore */
  }
}
loadBankingEnvFallback();

/**
 * URL credit rút game → Banking DB (máy local):
 * 1) BANKING_CREDIT_URL nếu set
 * 2) http://127.0.0.1:3010 (banking-db Node local)
 * Không ưu tiên devices.json bankingDbUrl (domain public / máy SSH).
 */
function resolveBankingDbUrl() {
  const env = String(process.env.BANKING_CREDIT_URL || '').trim();
  if (env) return env.replace(/\/$/, '');
  return 'http://127.0.0.1:3010';
}

function isXmsbDeviceName(device) {
  return String(device || '')
    .trim()
    .toUpperCase()
    .startsWith('XMSB');
}

const WEAK_INTERNAL_DB_TOKENS = new Set([
  'local_banking_internal_token_change_me',
  'changeme',
  'change_me',
  'change-me',
  'secret',
  'password',
]);

/** Header auth khi CMS credit rút game → Banking. */
function bankingCreditHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const appToken = String(process.env.APP_API_TOKEN || '').trim();
  if (appToken) headers['X-App-Token'] = appToken;
  const internal = String(process.env.INTERNAL_DB_TOKEN || '').trim();
  if (internal && !WEAK_INTERNAL_DB_TOKENS.has(internal)) {
    headers['X-Internal-Token'] = internal;
  } else if (internal && WEAK_INTERNAL_DB_TOKENS.has(internal)) {
    console.error(
      '❌ INTERNAL_DB_TOKEN đang là placeholder yếu — không gửi X-Internal-Token. Đặt token mạnh trong Banking/.env',
    );
  } else {
    console.warn(
      '⚠️ Thiếu INTERNAL_DB_TOKEN — credit XMSB có thể 401. Nạp từ Banking/.env',
    );
  }
  return headers;
}

// ------------------- Runtime queue: streak break events -------------------
const STREAK_BREAK_THRESHOLD_DEFAULT = 8;
const STREAK_BREAK_EVENTS_MAX = 5000;
let streakBreakEventSeq = 0;
const streakBreakEvents = [];

function pushStreakBreakEvent(eventPayload) {
  const event = {
    id: ++streakBreakEventSeq,
    created_at: dayjs().toISOString(),
    ...eventPayload,
  };
  streakBreakEvents.push(event);
  if (streakBreakEvents.length > STREAK_BREAK_EVENTS_MAX) {
    const overflow = streakBreakEvents.length - STREAK_BREAK_EVENTS_MAX;
    streakBreakEvents.splice(0, overflow);
  }
  return event;
}

app.get('/api/config', (req, res) => {
  try {
    const raw = fs.readFileSync(LC79_CONFIG_PATH, 'utf8');
    if (String(req.query.raw) === '1') {
      res.type('text/plain').send(raw);
      return;
    }
    const data = JSON.parse(raw);
    res.json({ ok: true, path: LC79_CONFIG_PATH, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: `Không đọc được config: ${err.message}` });
  }
});

app.put('/api/config', (req, res) => {
  try {
    if (typeof req.body === 'string') {
      fs.writeFileSync(LC79_CONFIG_PATH, req.body, 'utf8');
    } else {
      const data = req.body || {};
      const json = JSON.stringify(data, null, 2);
      fs.writeFileSync(LC79_CONFIG_PATH, json, 'utf8');
    }
    res.json({ ok: true, path: LC79_CONFIG_PATH });
  } catch (err) {
    res.status(500).json({ ok: false, error: `Không lưu được config: ${err.message}` });
  }
});

app.get('/api/xoso66-config', (req, res) => {
  try {
    const raw = fs.readFileSync(XOSO66_CONFIG_PATH, 'utf8');
    if (String(req.query.raw) === '1') {
      res.type('text/plain').send(raw);
      return;
    }
    const data = JSON.parse(raw);
    res.json({ ok: true, path: XOSO66_CONFIG_PATH, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: `Không đọc được xoso66_config: ${err.message}` });
  }
});

app.put('/api/xoso66-config', (req, res) => {
  try {
    if (typeof req.body === 'string') {
      fs.writeFileSync(XOSO66_CONFIG_PATH, req.body, 'utf8');
    } else {
      const data = req.body || {};
      const json = JSON.stringify(data, null, 2);
      fs.writeFileSync(XOSO66_CONFIG_PATH, json, 'utf8');
    }
    res.json({ ok: true, path: XOSO66_CONFIG_PATH });
  } catch (err) {
    res.status(500).json({ ok: false, error: `Không lưu được xoso66_config: ${err.message}` });
  }
});

app.get('/api/banking-devices', (req, res) => {
  try {
    const raw = fs.readFileSync(BANKING_DEVICES_PATH, 'utf8');
    if (String(req.query.raw) === '1') {
      res.type('text/plain').send(raw);
      return;
    }
    const data = JSON.parse(raw);
    res.json({ ok: true, path: BANKING_DEVICES_PATH, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: `Không đọc được devices.json: ${err.message}` });
  }
});

app.put('/api/banking-devices', (req, res) => {
  try {
    if (typeof req.body === 'string') {
      fs.writeFileSync(BANKING_DEVICES_PATH, req.body, 'utf8');
    } else {
      const data = req.body || {};
      const json = JSON.stringify(data, null, 2);
      fs.writeFileSync(BANKING_DEVICES_PATH, json, 'utf8');
    }
    res.json({ ok: true, path: BANKING_DEVICES_PATH });
  } catch (err) {
    res.status(500).json({ ok: false, error: `Không lưu được devices.json: ${err.message}` });
  }
});

// ------------------- Kết nối SQLite -------------------
// ./game_data.db theo thư mục chạy lệnh `node` (như bản cũ). Đổi sang __dirname từng làm
// toàn bộ API đọc nhầm DB nếu bạn vẫn start server từ LC79 hoặc thư mục khác.
const db = new sqlite3.Database('./game_data.db', (err) => {
  if (err) {
    console.error("❌ Lỗi khi kết nối DB:", err.message);
  } else {
    console.log("✅ Kết nối SQLite thành công.");
  }
});
db.serialize();

// ------------------- C168 accounts DB (game_data/c168.db) -------------------
const C168_DATA_DIR = path.join(__dirname, 'game_data');
const C168_DB_PATH = path.join(C168_DATA_DIR, 'c168.db');
try {
  fs.mkdirSync(C168_DATA_DIR, { recursive: true });
} catch (e) {
  console.warn('[C168] mkdir game_data:', e.message);
}

const c168Db = new sqlite3.Database(C168_DB_PATH, (err) => {
  if (err) console.error('❌ C168 DB:', err.message);
  else console.log(`✅ C168 DB → ${C168_DB_PATH}`);
});

c168Db.serialize(() => {
  c168Db.run(`
    CREATE TABLE IF NOT EXISTS c168_accounts (
      username TEXT PRIMARY KEY COLLATE NOCASE,
      password TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      account_holder TEXT NOT NULL DEFAULT '',
      fund_password TEXT NOT NULL DEFAULT '',
      bank_code TEXT NOT NULL DEFAULT '',
      bank_name TEXT NOT NULL DEFAULT '',
      account_number TEXT NOT NULL DEFAULT '',
      proxy TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT '',
      balance REAL NOT NULL DEFAULT 0,
      daily_bet_total REAL NOT NULL DEFAULT 0,
      daily_bet_day TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  c168Db.run(
    'CREATE INDEX IF NOT EXISTS idx_c168_username ON c168_accounts(username)'
  );
  c168Db.all('PRAGMA table_info(c168_accounts)', [], (eCol, cols) => {
    if (eCol || !cols) return;
    const names = cols.map((c) => c.name);
    if (!names.includes('chrome_browser_dir')) {
      c168Db.run(
        "ALTER TABLE c168_accounts ADD COLUMN chrome_browser_dir TEXT NOT NULL DEFAULT ''"
      );
    }
    if (!names.includes('chrome_cdp_port')) {
      c168Db.run('ALTER TABLE c168_accounts ADD COLUMN chrome_cdp_port INTEGER');
    }
    c168MigrateUsernamePk((mErr) => {
      if (mErr) console.error('[C168] migrate username PK:', mErr.message);
    });
  });
});

const C168_BROWSERS_DIR = path.join(C168_DATA_DIR, 'c168_browsers');
const C168_STANDALONE_DIR = path.resolve(__dirname, '../LC79/c168_standalone');
const C168_POST_OPEN_SCRIPT = path.join(C168_STANDALONE_DIR, 'c168_post_open_chrome.py');
const C168_DEFAULT_OPEN_URL = process.env.C168_LOGIN_URL || 'https://c1686.net';
const C168_CDP_PORT_BASE = parseInt(process.env.C168_CDP_PORT_BASE || '9360', 10);
const C168_VENV_PY = path.resolve(__dirname, '../LC79/.venv/Scripts/python.exe');
/** python.exe — có cửa sổ terminal khi spawn script C168 (nghe WS qua Chrome CDP). */
function c168PythonExecutable() {
  let py = process.env.PYTHON || '';
  if (!py && fs.existsSync(C168_VENV_PY)) py = C168_VENV_PY;
  if (!py) py = 'python';
  return py;
}

function c168ParsePythonJsonLine(stdout) {
  const lines = String(stdout || '')
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const line = lines.length ? lines[lines.length - 1] : '{}';
  return JSON.parse(line);
}

/** AllGame C168: profile allgame_browsers — không cần bản ghi c168.db. */
function c168PostOpenExtraArgs(acc) {
  const profileDir =
    acc && acc.chrome_browser_dir ? String(acc.chrome_browser_dir).trim() : '';
  if (!profileDir) return [];
  const args = ['--profile-dir', profileDir, '--no-launch'];
  const port = acc.chrome_cdp_port;
  if (port != null && String(port).trim() !== '') {
    args.push('--cdp-port', String(port));
  }
  let proxy = String((acc && acc.proxy) || '').trim();
  if (proxy) {
    try {
      proxy = validateSocks5Proxy(proxy);
    } catch (_) {
      /* giữ raw */
    }
    if (proxy) args.push('--proxy', proxy);
  }
  return args;
}

function c168PostOpenSessionCheck(acc, cdpWaitSec, callback) {
  const { execFile } = require('child_process');
  const python = c168PythonExecutable();
  if (!fs.existsSync(C168_POST_OPEN_SCRIPT)) {
    return callback(new Error(`Không thấy ${C168_POST_OPEN_SCRIPT}`));
  }
  execFile(
    python,
    [
      '-u',
      C168_POST_OPEN_SCRIPT,
      '-u',
      String(acc.username),
      '--check-only',
      '--cdp-wait',
      String(cdpWaitSec != null ? cdpWaitSec : 6),
      ...c168PostOpenExtraArgs(acc),
    ],
    {
      cwd: C168_STANDALONE_DIR,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 4,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    },
    (err, stdout, stderr) => {
      let data = null;
      try {
        data = c168ParsePythonJsonLine(stdout);
      } catch (_) {
        try {
          data = c168ParsePythonJsonLine(stderr);
        } catch (e2) {
          if (err) {
            const detail = String(stderr || stdout || err.message || '').trim();
            return callback(new Error(detail || err.message));
          }
          return callback(new Error(`Parse JSON post-open: ${e2.message}`));
        }
      }
      if (data && data.ok === false && data.error) {
        return callback(new Error(data.error));
      }
      if (err && !data) {
        const detail = String(stderr || err.message || '').trim();
        return callback(new Error(detail || err.message));
      }
      callback(null, data || {});
    }
  );
}

function spawnC168BcrWsListen(acc) {
  const { spawn } = require('child_process');
  const python = c168PythonExecutable();
  if (!fs.existsSync(C168_POST_OPEN_SCRIPT)) {
    console.warn('[C168] Không spawn WS listen:', C168_POST_OPEN_SCRIPT);
    return null;
  }
  const spawnOpts = {
    cwd: C168_STANDALONE_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
  };
  if (process.platform === 'win32') {
    spawnOpts.creationFlags = 0x08000000; // CREATE_NO_WINDOW
  }
  const child = spawn(
    python,
    [
      '-u',
      C168_POST_OPEN_SCRIPT,
      '-u',
      String(acc.username),
      '--cdp-wait',
      '3',
      ...c168PostOpenExtraArgs(acc),
    ],
    spawnOpts
  );
  child.unref();
  return child.pid;
}

function c168SafeDirKey(username) {
  const s = String(username || '').trim();
  return (s.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'user');
}

function c168CdpPortForUsername(username) {
  const u = String(username || '');
  let h = 0;
  for (let i = 0; i < u.length; i++) {
    h = ((h << 5) - h + u.charCodeAt(i)) | 0;
  }
  return C168_CDP_PORT_BASE + 1 + (Math.abs(h) % 399);
}

function c168BrowserDirForUsername(username) {
  return path.join(C168_BROWSERS_DIR, c168SafeDirKey(username));
}

function c168MigrateUsernamePk(done) {
  c168Db.all('PRAGMA table_info(c168_accounts)', [], (e, cols) => {
    if (e) return done(e);
    const names = (cols || []).map((c) => c.name);
    if (!names.includes('id')) return done(null);
    c168Db.all('SELECT * FROM c168_accounts', [], (e2, rows) => {
      if (e2) return done(e2);
      try {
        fs.mkdirSync(C168_BROWSERS_DIR, { recursive: true });
      } catch (_) {}
      const migrated = (rows || [])
        .map((r) => {
          const user = String(r.username || '').trim();
          if (!user) return null;
          const oldId = String(r.id || '').trim();
          const newDir = c168BrowserDirForUsername(user);
          const oldDir = path.join(C168_BROWSERS_DIR, oldId);
          let browserDir = String(r.chrome_browser_dir || '').trim();
          if (browserDir && fs.existsSync(browserDir)) {
            // giữ đường dẫn đang dùng
          } else if (fs.existsSync(newDir)) {
            browserDir = newDir;
          } else if (oldId && fs.existsSync(oldDir)) {
            if (!fs.existsSync(newDir)) {
              try {
                fs.renameSync(oldDir, newDir);
                browserDir = newDir;
              } catch (renErr) {
                console.warn('[C168] giữ profile', oldId, ':', renErr.message);
                browserDir = oldDir;
              }
            } else {
              browserDir = oldDir;
            }
          } else {
            browserDir = newDir;
          }
          return { ...r, chrome_browser_dir: browserDir };
        })
        .filter(Boolean);
      c168Db.serialize(() => {
        c168Db.run(
          `CREATE TABLE c168_accounts_new (
            username TEXT PRIMARY KEY COLLATE NOCASE,
            password TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            account_holder TEXT NOT NULL DEFAULT '',
            fund_password TEXT NOT NULL DEFAULT '',
            bank_code TEXT NOT NULL DEFAULT '',
            bank_name TEXT NOT NULL DEFAULT '',
            account_number TEXT NOT NULL DEFAULT '',
            proxy TEXT NOT NULL DEFAULT '',
            device TEXT NOT NULL DEFAULT '',
            balance REAL NOT NULL DEFAULT 0,
            daily_bet_total REAL NOT NULL DEFAULT 0,
            daily_bet_day TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'new',
            chrome_browser_dir TEXT NOT NULL DEFAULT '',
            chrome_cdp_port INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )`
        );
        const ins = `INSERT INTO c168_accounts_new (
          username, password, phone, account_holder, fund_password,
          bank_code, bank_name, account_number, proxy, device,
          balance, daily_bet_total, daily_bet_day, status,
          chrome_browser_dir, chrome_cdp_port, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
        for (const d of migrated) {
          c168Db.run(ins, [
            d.username,
            d.password || '',
            d.phone || '',
            d.account_holder || '',
            d.fund_password || '',
            d.bank_code || '',
            d.bank_name || '',
            d.account_number || '',
            d.proxy || '',
            d.device || '',
            Number(d.balance) || 0,
            Number(d.daily_bet_total) || 0,
            d.daily_bet_day || '',
            d.status || 'new',
            d.chrome_browser_dir || '',
            d.chrome_cdp_port,
            d.created_at || c168NowIso(),
            d.updated_at || c168NowIso(),
          ]);
        }
        c168Db.run('DROP TABLE c168_accounts');
        c168Db.run('ALTER TABLE c168_accounts_new RENAME TO c168_accounts');
        c168Db.run(
          'CREATE INDEX IF NOT EXISTS idx_c168_username ON c168_accounts(username)'
        );
        console.log('[C168] Đã migrate DB: khóa chính = username');
        done(null);
      });
    });
  });
}

function c168EnrichRow(r) {
  const base = { ...r };
  if (base.id != null) delete base.id;
  const hasBrowser = !!(r.chrome_browser_dir && String(r.chrome_browser_dir).trim());
  const port =
    r.chrome_cdp_port || (r.username ? c168CdpPortForUsername(r.username) : null);
  base.chrome_ready = hasBrowser;
  base.cdp_port = port;
  base.cdp_url = port ? `http://127.0.0.1:${port}` : '';
  return base;
}

function launchC168Browser(acc, urls, callback) {
  const { execFile } = require('child_process');
  const username = String(acc.username || '').trim();
  if (!username) return callback(new Error('username trống'));
  try {
    fs.mkdirSync(C168_BROWSERS_DIR, { recursive: true });
  } catch (e) {
    return callback(e);
  }
  const profileDir = acc.chrome_browser_dir || c168BrowserDirForUsername(username);
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }
  if (!fs.existsSync(CMS_LAUNCH_SCRIPT)) {
    return callback(new Error(`Không thấy ${CMS_LAUNCH_SCRIPT}`));
  }
  let proxy = '';
  try {
    proxy = validateSocks5Proxy(acc.proxy || '');
  } catch (e) {
    return callback(e);
  }
  if (!proxy) {
    return callback(
      new Error('Bắt buộc proxy SOCKS5 dạng host:port:user:pass — nhập proxy trên acc C168')
    );
  }
  const cdpPort = acc.chrome_cdp_port || c168CdpPortForUsername(username);
  const openUrls = Array.isArray(urls) && urls.length ? urls : [C168_DEFAULT_OPEN_URL];
  const python = c168PythonExecutable();
  const args = [
    CMS_LAUNCH_SCRIPT,
    '--profile-dir',
    profileDir,
    '--proxy',
    proxy,
    '--cdp-port',
    String(cdpPort),
    '--urls-json',
    JSON.stringify(openUrls),
  ];
  execFile(
    python,
    args,
    {
      cwd: BROWSER_ISOLATE_DIR,
      windowsHide: false,
      timeout: 60000,
      maxBuffer: 1024 * 512,
    },
    (err, stdout, stderr) => {
      let data = null;
      try {
        const line = String(stdout || '').trim().split('\n').pop();
        data = JSON.parse(line || '{}');
      } catch (parseErr) {
        const detail = String(stderr || err?.message || parseErr.message || '').trim();
        return callback(
          new Error(
            detail ||
              'Không mở Chrome. Cài: pip install pproxy (SOCKS5 user/pass) và khởi động lại CMS.'
          )
        );
      }
      if (!data.ok) {
        return callback(new Error(data.error || 'Mở Chrome thất bại'));
      }
      data.cdp_port = cdpPort;
      data.cdp_url = `http://127.0.0.1:${cdpPort}`;
      data.chrome_browser_dir = profileDir;
      callback(null, data);
    }
  );
}

function c168NowIso() {
  return dayjs().toISOString();
}

function c168TodayVn() {
  return dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
}

/** nhanNgay / chuyenNgay: chỉ tính nếu *Day = hôm nay GMT+7 (Asia/Ho_Chi_Minh) */
function deviceDailyAmountToday(amount, dayCol, today = c168TodayVn()) {
  return String(dayCol || '').trim() === today ? (Number(amount) || 0) : 0;
}

function mapDeviceBalanceDailyRow(row) {
  if (!row) return row;
  const today = c168TodayVn();
  return {
    ...row,
    nhanNgay: deviceDailyAmountToday(row.nhanNgay, row.nhanNgayDay, today),
    chuyenNgay: deviceDailyAmountToday(row.chuyenNgay, row.chuyenNgayDay, today),
  };
}

const C168_EDITABLE = new Set([
  'username', 'password', 'phone', 'account_holder', 'fund_password',
  'bank_code', 'bank_name', 'account_number', 'proxy', 'device',
  'balance', 'daily_bet_total', 'status',
]);

function c168PublicRow(row, includeSecrets) {
  if (!row) return null;
  const r = { ...row };
  if (!includeSecrets) {
    if (r.password) r.password = '••••';
    if (r.fund_password) r.fund_password = '••••';
  }
  return r;
}

function c168NormalizePayload(body) {
  const p = body && typeof body === 'object' ? { ...body } : {};
  const str = (k) => (p[k] != null ? String(p[k]).trim() : undefined);
  const out = {};
  if (str('username') !== undefined) out.username = str('username');
  if (str('password') !== undefined) out.password = str('password');
  if (str('phone') !== undefined) out.phone = str('phone');
  if (str('account_holder') !== undefined) out.account_holder = str('account_holder');
  if (str('fund_password') !== undefined) out.fund_password = str('fund_password');
  if (str('bank_code') !== undefined) out.bank_code = str('bank_code');
  if (str('bank_name') !== undefined) out.bank_name = str('bank_name');
  if (str('account_number') !== undefined) out.account_number = str('account_number');
  if (str('proxy') !== undefined) out.proxy = str('proxy');
  if (str('device') !== undefined) out.device = str('device');
  if (str('status') !== undefined) out.status = str('status');
  if (p.balance != null && p.balance !== '') out.balance = Number(p.balance);
  if (p.daily_bet_total != null && p.daily_bet_total !== '') {
    out.daily_bet_total = Number(p.daily_bet_total);
  }
  if (p.bank != null && String(p.bank).trim()) {
    const b = String(p.bank).trim();
    out.bank_code = b;
    out.bank_name = b;
  }
  return out;
}
// ------------------- Tạo bảng -------------------
// Log cấu trúc bảng accounts để kiểm tra trường uuid
db.all("PRAGMA table_info(accounts)", (err, rows) => {
  if (!err) {
    console.log("Cấu trúc bảng accounts:");
    console.table(rows);
  }
});

process.on('SIGINT', () => {
  console.log("🛑 Server dừng, đóng kết nối DB/WS...");
  db.close();
  c168Db.close();
  closeAllgameDb();
  process.exit();
});
// Account
// Đảm bảo bảng accounts có trường uuid
db.get("PRAGMA table_info(accounts)", (err, columns) => {
  if (err) return;
  const hasUuid = Array.isArray(columns) && columns.some(col => col.name === 'uuid');
  if (!hasUuid) {
    db.run("ALTER TABLE accounts ADD COLUMN uuid TEXT", (err2) => {
      if (!err2) console.log("✅ Đã thêm trường uuid vào bảng accounts");
    });
  }
});
db.run(`CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT,
  username TEXT,
  loginPass TEXT,
  phone TEXT,
  withdrawPass TEXT,
  bank TEXT,
  accountNumber TEXT,
  accountHolder TEXT,
  device TEXT,
  totalDeposit INTEGER DEFAULT 0,
  totalWithdraw INTEGER DEFAULT 0,
  totalBet INTEGER DEFAULT 0,
  currentBet INTEGER DEFAULT 0,
  status TEXT DEFAULT 'OFF'
)`);
db.run(`CREATE TABLE IF NOT EXISTS bet_totals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,

  total_all INTEGER DEFAULT 0,

  total_day INTEGER DEFAULT 0,
  day_start TEXT,

  total_week INTEGER DEFAULT 0,
  week_start TEXT,

  total_month INTEGER DEFAULT 0,
  month_start TEXT,

  updated_at TEXT DEFAULT (datetime('now'))
)`); 
//  Streaks
db.run(`
  CREATE TABLE IF NOT EXISTS streaks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    best_win_today INTEGER DEFAULT 0,
    best_lose_today INTEGER DEFAULT 0,
    current_type TEXT CHECK(current_type IN ('won','lost')) DEFAULT NULL,
    current_len INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  )
`, (err) => {
  if (err) console.error("❌ Lỗi khi tạo bảng streaks:", err.message);
  else console.log("✅ Bảng streaks đã sẵn sàng.");
});

// UserProfile
db.run(`CREATE TABLE IF NOT EXISTS user_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  nickname TEXT,
  proxy TEXT,
  uuid TEXT,
  device TEXT,
  balance INTEGER DEFAULT 0,
  accessToken TEXT,
  jwt TEXT,
  status TEXT DEFAULT 'Mới Tạo',
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Proxy
db.run(`CREATE TABLE IF NOT EXISTS proxies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proxy TEXT NOT NULL,
  device TEXT NOT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// DeviceBalance
db.run(`CREATE TABLE IF NOT EXISTS device_balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT UNIQUE NOT NULL,
  balance INTEGER DEFAULT 0,
  nhanNgay INTEGER DEFAULT 0,
  chuyenNgay INTEGER DEFAULT 0,
  accountNumber TEXT,
  accountHolder TEXT,
  bank TEXT,
  username TEXT,
  password TEXT DEFAULT '',
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.run(`CREATE INDEX IF NOT EXISTS idx_device_balances_device ON device_balances(device)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_device_balances_balance ON device_balances(balance DESC)`);

// TransactionDetail
db.run(`CREATE TABLE IF NOT EXISTS transaction_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  nickname TEXT,
  hinhThuc TEXT CHECK(hinhThuc IN ('Nạp tiền','Rút tiền')) NOT NULL,
  transactionId TEXT NOT NULL,
  amount INTEGER NOT NULL,
  time DATETIME NOT NULL,
  db_time DATETIME,
  status TEXT DEFAULT 'pending',
  reason TEXT,
  content TEXT,
  deviceNap TEXT DEFAULT ''
)`);
// Migration: thêm db_time nếu chưa có
db.run(`ALTER TABLE transaction_details ADD COLUMN db_time DATETIME`, () => {});
// Migration: chuẩn hóa time ISO (2026-06-20T01:35:39) → YYYY-MM-DD HH:mm:ss
db.all(`SELECT id, time FROM transaction_details WHERE time LIKE '%T%'`, [], (err, rows) => {
  if (err || !rows?.length) return;
  const stmt = db.prepare(`UPDATE transaction_details SET time = ? WHERE id = ?`);
  rows.forEach((r) => stmt.run(normalizeTxnTimeStr(r.time), r.id));
  stmt.finalize(() => {
    console.log(`✅ Chuẩn hóa ${rows.length} bản ghi time ISO trong transaction_details`);
  });
});
// Migration: thêm status nếu chưa có
db.get("PRAGMA table_info(transaction_details)", (err, columns) => {
  if (err) return;
  const hasStatus = Array.isArray(columns) && columns.some(col => col.name === 'status');
  if (!hasStatus) {
    db.run("ALTER TABLE transaction_details ADD COLUMN status TEXT DEFAULT 'pending'", () => {});
  }
});
// Migration: thêm reason nếu chưa có
db.get("PRAGMA table_info(transaction_details)", (err, columns) => {
  if (err) return;
  const hasReason = Array.isArray(columns) && columns.some(col => col.name === 'reason');
  if (!hasReason) {
    db.run("ALTER TABLE transaction_details ADD COLUMN reason TEXT", () => {});
  }
});
// Migration: thêm content nếu chưa có
db.get("PRAGMA table_info(transaction_details)", (err, columns) => {
  if (err) return;
  const hasContent = Array.isArray(columns) && columns.some(col => col.name === 'content');
  if (!hasContent) {
    db.run("ALTER TABLE transaction_details ADD COLUMN content TEXT", () => {});
  }
});
// Daily Profits - Lưu lợi nhuận theo ngày
db.run(`CREATE TABLE IF NOT EXISTS daily_profits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  total_deposit INTEGER DEFAULT 0,
  total_withdraw INTEGER DEFAULT 0,
  deposit_day INTEGER DEFAULT 0,
  withdraw_day INTEGER DEFAULT 0,
  total_balance INTEGER DEFAULT 0,
  profit INTEGER DEFAULT 0,
  total_bet_day INTEGER DEFAULT 0,
  account_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now'))
)`, (err) => {
  if (err) console.error("❌ Lỗi khi tạo bảng daily_profits:", err.message);
  else {
    console.log("✅ Bảng daily_profits đã sẵn sàng.");
    // Thêm cột mới nếu chưa có (migration)
    db.run(`ALTER TABLE daily_profits ADD COLUMN deposit_day INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE daily_profits ADD COLUMN withdraw_day INTEGER DEFAULT 0`, () => {});
  }
});
// DeviceReport
db.run(`CREATE TABLE IF NOT EXISTS device_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hostname TEXT UNIQUE,
  ip TEXT,
  devices TEXT,
  last_seen DATETIME
)`);
// bet_history đã bỏ — xoá bảng / bảng tạm migration nếu còn từ phiên bản cũ
db.run(`DROP TABLE IF EXISTS _bet_history_mig`, () => {});
db.run(`DROP TABLE IF EXISTS bet_history`, (err) => {
  if (err) console.error("⚠️ Không xoá được bet_history:", err.message);
  else console.log("✅ bet_history: đã gỡ khỏi DB (không còn dùng)");
});

// Phiên nổ hũ Tài Xỉu — thông số chia hũ (Python: jackpot_session_db.py)
db.run(`CREATE TABLE IF NOT EXISTS jackpot_session_records (
  session_id INTEGER PRIMARY KEY,
  username TEXT,
  my_total_bet REAL NOT NULL,
  game_total_bet REAL NOT NULL,
  jackpot_amount REAL NOT NULL,
  amount_received REAL NOT NULL,
  jackpot_side TEXT,
  session_timestamp TEXT,
  api_username TEXT,
  dices TEXT,
  dice_point INTEGER,
  overall_total_amount REAL,
  created_at TEXT,
  updated_at TEXT NOT NULL
)`);

db.run(`
  CREATE TABLE IF NOT EXISTS deposit_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    amount INTEGER,
    accountNumber TEXT,
    accountHolder TEXT,
    bank TEXT,
    transferContent TEXT,
    status TEXT CHECK(status IN ('Chờ Nạp','Đang Nạp','Đã Nạp','Thành Công','Thất Bại','Huỷ')) DEFAULT 'Chờ Nạp',
    deviceNap TEXT DEFAULT '',
    createdAt TEXT DEFAULT (datetime('now')),
    updatedAt TEXT DEFAULT (datetime('now'))
  )
`, (err) => {
  if (err) console.error("❌ Lỗi khi tạo bảng deposit_orders:", err.message);
  else console.log("✅ Bảng deposit_orders đã sẵn sàng.");
});

db.run(`
  CREATE TABLE IF NOT EXISTS gift_box_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    gift_type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    issued_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    raw_line TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`, (err) => {
  if (err) console.error("❌ Lỗi khi tạo bảng gift_box_claims:", err.message);
  else console.log("✅ Bảng gift_box_claims đã sẵn sàng.");
});

function classifyGiftTitle(title) {
  const t = String(title || '').trim();
  if (/top\s*cược\s*ngày/i.test(t)) return 'Tóp cược ngày';
  if (t.includes('Xin chúc mừng! Bạn đã xuất sắc xếp hạng')) return 'Tóp';
  if (t.includes('Xin chúc mừng! Bạn đã xuất sắc đạt chuỗi')) return 'Chuỗi';
  if (t.includes('Bạn đã đạt chuỗi')) return 'Chuỗi';
  if (t.includes('Hoàn thua tuần LC79')) return 'Hoàn thua tuần LC79';
  if (t.includes('Hoàn thua ngày LC79')) return 'Hoàn thua ngày LC79';
  if (t.includes('Lộc may mắn LC79')) return 'Lộc may mắn LC79';
  if (/hoàn\s*cược\s*tháng|hoan\s*cược\s*tháng/i.test(t)) return 'Hoàn cược tháng';
  if (/hoàn\s*cược\s*tuần|hoan\s*cược\s*tuần/i.test(t)) return 'Hoàn cược tuần';
  if (/hoàn\s*cược\s*ngày|hoan\s*cược\s*ngày/i.test(t)) return 'Hoàn cược ngày';
  return 'Khác';
}

/** Thống kê theo ngày: nhãn cột UI ↔ gift_type trong DB */
const GIFT_BOX_DAILY_STAT_COLUMNS = [
  { key: 'hoan_cuoc_ngay', label: 'Hoàn Cược Ngày', dbValue: 'Hoàn cược ngày' },
  { key: 'chuoi', label: 'Chuỗi', dbValue: 'Chuỗi' },
  { key: 'top_cuoc_ngay', label: 'Tóp Cược Ngày', dbValue: 'Tóp cược ngày' },
  { key: 'top', label: 'Tóp', dbValue: 'Tóp' },
  { key: 'loc_may_man', label: 'Lộc May Mắn', dbValue: 'Lộc may mắn LC79' },
  { key: 'hoan_thua_ngay', label: 'Hoàn Thua Ngày', dbValue: 'Hoàn thua ngày LC79' },
  { key: 'hoan_cuoc_tuan', label: 'Hoàn Cược Tuần', dbValue: 'Hoàn cược tuần' },
  { key: 'hoan_thua_tuan', label: 'Hoàn Thua Tuần', dbValue: 'Hoàn thua tuần LC79' },
  { key: 'hoan_cuoc_thang', label: 'Hoàn Cược Tháng', dbValue: 'Hoàn cược tháng' },
  { key: 'khac', label: 'Khác', dbValue: 'Khác' },
];

function giftTypeToDailyStatKey(giftType) {
  const s = String(giftType || '');
  const col = GIFT_BOX_DAILY_STAT_COLUMNS.find((c) => c.dbValue === s);
  if (col) return col.key;
  if (/top\s*cược\s*ngày/i.test(s)) return 'top_cuoc_ngay';
  if (/hoàn\s*cược\s*tuần|hoan\s*cược\s*tuần/i.test(s)) return 'hoan_cuoc_tuan';
  if (/hoàn\s*cược\s*ngày|hoan\s*cược\s*ngày/i.test(s)) return 'hoan_cuoc_ngay';
  if (/hoàn\s*cược\s*tháng|hoan\s*cược\s*tháng/i.test(s)) return 'hoan_cuoc_thang';
  return 'khac';
}

function giftBoxClaimsRowsByDate(rows) {
  const byDate = new Map();
  for (const r of rows || []) {
    const d = r.d;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push({ gift_type: r.gift_type, sum_amount: Number(r.sum_amount) || 0 });
  }
  return byDate;
}

function giftBoxClaimsFoldOneDay(byDate, dStr) {
  const list = byDate.get(dStr) || [];
  const counts = {};
  for (const c of GIFT_BOX_DAILY_STAT_COLUMNS) counts[c.key] = 0;
  let total = 0;
  for (const { gift_type: gt, sum_amount } of list) {
    total += sum_amount;
    const key = giftTypeToDailyStatKey(gt);
    counts[key] = (counts[key] || 0) + sum_amount;
  }
  return { total, ...counts };
}

/** Parse dòng log: 🎁 [user] YYYY-MM-DD HH:mm:ss | Nhận: ... (+Xđ) → Số dư: ... */
function parseGiftBoxLine(line) {
  const s = String(line || '').replace(/\r\n/g, '\n').trim();
  const headerMatch = s.match(/🎁\s*\[([^\]]+)\]\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
  if (!headerMatch) return null;
  const username = headerMatch[1].trim();
  const issued_at = headerMatch[2].trim();
  const endPhrase = ') → Số dư:';
  const endIdx = s.lastIndexOf(endPhrase);
  if (endIdx < 0) return null;
  const beforeClosing = s.slice(0, endIdx);
  const openIdx = beforeClosing.lastIndexOf('(+');
  if (openIdx < 0) return null;
  const nhanMark = '| Nhận:';
  const nhanIdx = s.indexOf(nhanMark);
  if (nhanIdx < 0) return null;
  const titleStart = nhanIdx + nhanMark.length;
  const title = s.slice(titleStart, openIdx).trim();
  const amountInside = s.slice(openIdx + 2, endIdx);
  const amount = parseInt(String(amountInside).replace(/[^\d]/g, ''), 10);
  if (!title || Number.isNaN(amount)) return null;
  return {
    username,
    issued_at,
    title,
    amount,
    gift_type: classifyGiftTitle(title),
  };
}

// ------------------- API: Hòm quà (LC79) -------------------
app.post('/api/gift-box-claims', (req, res) => {
  const body = req.body || {};
  let username;
  let gift_type;
  let amount;
  let issued_at;
  let received_at = body.received_at || body.receivedAt;
  let raw_line = body.line || body.raw_line || body.rawLine || null;

  if (body.username && (body.gift_type != null || body.giftType != null) && body.amount != null && body.issued_at != null) {
    username = String(body.username).trim();
    gift_type = String(body.gift_type || body.giftType).trim();
    amount = parseInt(body.amount, 10);
    issued_at = String(body.issued_at || body.issuedAt).trim();
  } else if (raw_line) {
    const parsed = parseGiftBoxLine(raw_line);
    if (!parsed) {
      return res.status(400).json({ ok: false, error: 'Không parse được dòng hòm quà' });
    }
    username = parsed.username;
    gift_type = body.gift_type || body.giftType || parsed.gift_type;
    amount = parsed.amount;
    issued_at = parsed.issued_at;
  } else {
    return res.status(400).json({ ok: false, error: 'Thiếu line hoặc bộ username/gift_type/amount/issued_at' });
  }

  if (!received_at) {
    received_at = dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD HH:mm:ss');
  } else {
    received_at = String(received_at).trim();
  }

  if (!username || !gift_type || Number.isNaN(amount)) {
    return res.status(400).json({ ok: false, error: 'Dữ liệu không hợp lệ sau khi parse' });
  }

  const sql = `INSERT INTO gift_box_claims (username, gift_type, amount, issued_at, received_at, raw_line)
               VALUES (?, ?, ?, ?, ?, ?)`;
  db.run(sql, [username, gift_type, amount, issued_at, received_at, raw_line], function (err) {
    if (err) {
      console.error('❌ gift-box-claims:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
    res.json({ ok: true, id: this.lastID });
  });
});

app.get('/api/gift-box-claims/types', (req, res) => {
  db.all(
    `SELECT DISTINCT gift_type FROM gift_box_claims ORDER BY gift_type`,
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, types: (rows || []).map((r) => r.gift_type) });
    }
  );
});

/** Thống kê hòm quà theo ngày (múi giờ VN): mỗi ô A/B = tổng tiền theo issued_at / received_at */
app.get('/api/gift-box-claims/stats/daily', (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 20));

  const end = dayjs().tz('Asia/Ho_Chi_Minh').startOf('day');
  const start = end.subtract(days - 1, 'day');
  const startStr = start.format('YYYY-MM-DD');
  const endStr = end.format('YYYY-MM-DD');

  const sqlIssued = `
    SELECT date(issued_at) AS d, gift_type, COALESCE(SUM(amount), 0) AS sum_amount
    FROM gift_box_claims
    WHERE date(issued_at) >= date(?) AND date(issued_at) <= date(?)
    GROUP BY d, gift_type
  `;
  const sqlReceived = `
    SELECT date(received_at) AS d, gift_type, COALESCE(SUM(amount), 0) AS sum_amount
    FROM gift_box_claims
    WHERE date(received_at) >= date(?) AND date(received_at) <= date(?)
    GROUP BY d, gift_type
  `;

  db.all(sqlIssued, [startStr, endStr], (err, rowsA) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    db.all(sqlReceived, [startStr, endStr], (err2, rowsB) => {
      if (err2) return res.status(500).json({ ok: false, error: err2.message });

      const byIssued = giftBoxClaimsRowsByDate(rowsA);
      const byReceived = giftBoxClaimsRowsByDate(rowsB);

      const result = [];
      for (let i = 0; i < days; i++) {
        const day = start.add(i, 'day');
        const dStr = day.format('YYYY-MM-DD');
        result.push({
          date: dStr,
          a: giftBoxClaimsFoldOneDay(byIssued, dStr),
          b: giftBoxClaimsFoldOneDay(byReceived, dStr),
        });
      }

      result.reverse();

      res.json({
        ok: true,
        days,
        range: { start: startStr, end: endStr },
        aggregate: 'sum_amount',
        ab: { a: 'issued_at', b: 'received_at' },
        columns: GIFT_BOX_DAILY_STAT_COLUMNS.map((c) => ({ key: c.key, label: c.label })),
        rows: result,
      });
    });
  });
});

app.get('/api/gift-box-claims', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;
  const username = req.query.username;
  const gift_type = req.query.gift_type || req.query.giftType;
  const received_date = req.query.received_date || req.query.receivedDate;
  const conditions = [];
  const params = [];
  if (username) {
    conditions.push('username LIKE ?');
    params.push(`%${username}%`);
  }
  if (gift_type) {
    conditions.push('gift_type = ?');
    params.push(gift_type);
  }
  if (received_date) {
    conditions.push('date(received_at) = date(?)');
    params.push(String(received_date).trim());
  }
  const whereClause = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const sqlCount = `SELECT COUNT(*) as total FROM gift_box_claims${whereClause}`;
  const sqlSumFiltered = `SELECT COALESCE(SUM(amount), 0) as total_amount_filtered FROM gift_box_claims${whereClause}`;
  const sqlSumAll = `SELECT COALESCE(SUM(amount), 0) as total_amount_all FROM gift_box_claims`;
  const sqlData = `SELECT * FROM gift_box_claims${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`;

  db.get(sqlCount, params, (err, countRow) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    const total = countRow?.total || 0;
    db.get(sqlSumFiltered, params, (errSumFiltered, sumFilteredRow) => {
      if (errSumFiltered) return res.status(500).json({ ok: false, error: errSumFiltered.message });
      const total_amount_filtered = Number(sumFilteredRow?.total_amount_filtered) || 0;
      db.get(sqlSumAll, [], (errSumAll, sumAllRow) => {
        if (errSumAll) return res.status(500).json({ ok: false, error: errSumAll.message });
        const total_amount_all = Number(sumAllRow?.total_amount_all) || 0;
        db.all(sqlData, [...params, limit, offset], (err2, rows) => {
          if (err2) return res.status(500).json({ ok: false, error: err2.message });
          db.all(
            `SELECT DISTINCT gift_type FROM gift_box_claims ORDER BY gift_type`,
            (err3, typeRows) => {
              if (err3) return res.status(500).json({ ok: false, error: err3.message });
              const gift_types = (typeRows || []).map((r) => r.gift_type);
              res.json({ ok: true, total, page, limit, rows, gift_types, total_amount_filtered, total_amount_all });
            }
          );
        });
      });
    });
  });
});

// ------------------- Danh sách phiên nổ hũ (bảng jackpot_session_records) -------------------
app.get('/api/jackpot-sessions', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;
  const username = req.query.username;
  const session_date = req.query.session_date || req.query.sessionDate;
  const conditions = [];
  const params = [];
  if (username) {
    conditions.push('(username LIKE ? OR api_username LIKE ?)');
    const like = `%${username}%`;
    params.push(like, like);
  }
  if (session_date) {
    // Mặc định lọc theo ngày của session_timestamp; nếu trống thì fallback updated_at.
    // session_timestamp thực tế có thể ở dạng: "HH:mm:ss DD/MM/YYYY".
    const ymd = String(session_date).trim(); // ví dụ: 2026-04-24
    const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const dmy = m ? `${m[3]}/${m[2]}/${m[1]}` : ymd; // 24/04/2026
    conditions.push(`(
      (session_timestamp IS NOT NULL AND trim(session_timestamp) <> '' AND (
        substr(trim(session_timestamp), 1, 10) = ? OR
        substr(trim(session_timestamp), -10) = ?
      ))
      OR
      ((session_timestamp IS NULL OR trim(session_timestamp) = '') AND substr(updated_at, 1, 10) = ?)
    )`);
    params.push(ymd, dmy, ymd);
  }
  const whereClause = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const sqlCount = `SELECT COUNT(*) as total FROM jackpot_session_records${whereClause}`;
  const sqlSumReceived = `SELECT COALESCE(SUM(amount_received), 0) as total_amount_received_filtered FROM jackpot_session_records${whereClause}`;
  const sqlData = `
    SELECT session_id, my_total_bet, game_total_bet, jackpot_amount, amount_received,
           username, api_username, session_timestamp, created_at, updated_at
    FROM jackpot_session_records${whereClause}
    ORDER BY session_id DESC
    LIMIT ? OFFSET ?
  `;

  db.get(sqlCount, params, (err, countRow) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    const total = countRow?.total || 0;
    db.get(sqlSumReceived, params, (errSum, sumRow) => {
      if (errSum) return res.status(500).json({ ok: false, error: errSum.message });
      const total_amount_received_filtered = Number(sumRow?.total_amount_received_filtered) || 0;
      db.all(sqlData, [...params, limit, offset], (err2, rows) => {
        if (err2) return res.status(500).json({ ok: false, error: err2.message });
        res.json({ ok: true, total, page, limit, rows, total_amount_received_filtered });
      });
    });
  });
});

// ------------------- Thống kê nổ hũ theo ngày (mặc định 10 ngày gần nhất) -------------------
app.get('/api/jackpot-sessions/stats/daily', (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 10));
  const username = req.query.username;
  const params = [];
  const where = ['day_key IS NOT NULL', "day_key <> ''"];
  if (username) {
    where.push('(username LIKE ? OR api_username LIKE ?)');
    const like = `%${username}%`;
    params.push(like, like);
  }

  const sql = `
    SELECT
      day_key as date,
      COUNT(*) as session_count,
      COALESCE(SUM(my_total_bet), 0) as my_total_bet,
      COALESCE(SUM(game_total_bet), 0) as game_total_bet,
      COALESCE(SUM(jackpot_amount), 0) as jackpot_amount,
      COALESCE(SUM(amount_received), 0) as amount_received
    FROM (
      SELECT
        username,
        api_username,
        my_total_bet,
        game_total_bet,
        jackpot_amount,
        amount_received,
        CASE
          WHEN session_timestamp IS NOT NULL AND trim(session_timestamp) <> '' THEN
            CASE
              WHEN instr(session_timestamp, '/') > 0
                THEN substr(trim(session_timestamp), -4) || '-' || substr(trim(session_timestamp), -7, 2) || '-' || substr(trim(session_timestamp), -10, 2)
              ELSE substr(trim(session_timestamp), 1, 10)
            END
          ELSE substr(updated_at, 1, 10)
        END as day_key
      FROM jackpot_session_records
    ) t
    WHERE ${where.join(' AND ')}
    GROUP BY day_key
    ORDER BY day_key DESC
    LIMIT ?
  `;

  db.all(sql, [...params, days], (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, days, rows: rows || [] });
  });
});

// ------------------- QR lệnh nạp (ảnh lưu bởi LC79 deposit_api.py) -------------------
const QR_OUTPUTS_DIR = path.resolve(__dirname, '../LC79/qr_outputs');

function sanitizeQrFilename(text) {
  let s = String(text || '').trim();
  s = s.replace(/[\\/:*?"<>|]/g, '_');
  s = s.replace(/\s+/g, '_');
  return (s.slice(0, 80) || 'no_msg');
}

function resolveQrImagePath(order) {
  const username = String(order?.username || '').trim();
  const ndck = String(order?.transferContent || '').trim();
  if (!username) return null;

  if (ndck) {
    const exact = path.join(QR_OUTPUTS_DIR, `${username}_${sanitizeQrFilename(ndck)}.png`);
    if (fs.existsSync(exact)) return exact;
  }

  try {
    if (!fs.existsSync(QR_OUTPUTS_DIR)) return null;
    const prefix = `${username}_`;
    const candidates = fs.readdirSync(QR_OUTPUTS_DIR)
      .filter((f) => f.startsWith(prefix) && f.toLowerCase().endsWith('.png'))
      .map((f) => {
        const full = path.join(QR_OUTPUTS_DIR, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return candidates.length ? candidates[0].full : null;
  } catch (e) {
    console.warn('⚠️ resolveQrImagePath:', e.message);
    return null;
  }
}

function readQrBase64DataUrl(order) {
  const stored = String(order?.qrBase64 || '').trim();
  if (stored) {
    return stored.startsWith('data:image') ? stored : `data:image/png;base64,${stored}`;
  }
  const imgPath = resolveQrImagePath(order);
  if (!imgPath) return '';
  try {
    const b64 = fs.readFileSync(imgPath).toString('base64');
    return `data:image/png;base64,${b64}`;
  } catch (e) {
    console.error('❌ Không đọc được QR image:', e.message);
    return '';
  }
}

// ------------------- API: Tạo lệnh nạp tiền -------------------
app.post('/api/deposit-orders', (req, res) => {
  const { username, amount, accountNumber, accountHolder, bank, transferContent, transfer_content, qrLink, qrBase64 } = req.body;
  // Hỗ trợ cả camelCase và snake_case. Ưu tiên giá trị không rỗng (format BC... có dấu - từ BIDV).
  const ndck = [transferContent, transfer_content].find(v => v != null && String(v).trim()) || '';
  // Debug: nếu thiếu ndck nhưng có 1 trong 2 key thì log (Python gửi đủ nhưng Node nhận thiếu)
  if (!ndck && (transferContent !== undefined || transfer_content !== undefined)) {
    console.warn('⚠️ deposit-orders: Nhận transferContent/transfer_content nhưng ndck rỗng. Raw:', { transferContent, transfer_content, bank });
  }
  if (!username) return res.status(400).json({ error: 'Thiếu username' });

  const sqlCheckPending = `
    SELECT id, status, amount, createdAt, updatedAt
    FROM deposit_orders
    WHERE username = ?
      AND status IN ('Chờ Nạp', 'Đang Nạp', 'Đã Nạp')
    ORDER BY createdAt DESC
    LIMIT 1
  `;

  db.get(sqlCheckPending, [username], (checkErr, existingOrder) => {
    if (checkErr) {
      console.error("❌ Lỗi khi kiểm tra lệnh nạp:", checkErr.message);
      return res.status(500).json({ error: 'Không thể kiểm tra lệnh nạp' });
    }
    if (existingOrder) {
      return res.status(409).json({
        error: 'Tài khoản đang có lệnh nạp chưa hoàn thành',
        order: existingOrder
      });
    }

  const sql = `INSERT INTO deposit_orders (username, amount, accountNumber, accountHolder, bank, transferContent, qrLink, qrBase64, status, createdAt, updatedAt)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Chờ Nạp', datetime('now'), datetime('now'))`;
  db.run(sql, [
    username,
    amount || 0,
    accountNumber || '',
    accountHolder || '',
    bank || '',
    ndck,
    qrLink || '',
    qrBase64 || '',
  ], function (err) {
    if (err) {
      console.error("❌ Lỗi khi tạo lệnh nạp:", err.message);
      return res.status(500).json({ error: 'Không thể tạo lệnh nạp' });
    }
    if (ndck && (ndck.includes('-') || ndck.startsWith('BC'))) {
      console.log('✅ Lưu deposit order #' + this.lastID + ' với NDCK: ' + ndck.substring(0, 30) + '...');
    }
    res.json({ success: true, id: this.lastID });
  });
  });
});

// ------------------- API: Lấy danh sách lệnh nạp (có lọc/phân trang) -------------------
app.get('/api/deposit-orders', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.max(1, parseInt(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  const status = req.query.status; // filter theo status nếu có
  const username = req.query.username; // filter theo username nếu có

  const conditions = [];
  const params = [];

  if (status) {
    conditions.push(`status = ?`);
    params.push(status);
  }

  if (username) {
    conditions.push(`username LIKE ?`);
    params.push(`%${username}%`);
  }

  const whereClause = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  let sqlCount = `SELECT COUNT(*) as total FROM deposit_orders${whereClause}`;
  let sqlData = `SELECT * FROM deposit_orders${whereClause}`;

  sqlData += ` ORDER BY createdAt DESC LIMIT ? OFFSET ?`;
  const paramsData = [...params, limit, offset];

  db.get(sqlCount, params, (err, countRow) => {
    if (err) return res.status(500).json({ error: err.message });
    const total = countRow?.total || 0;

    db.all(sqlData, paramsData, (err2, rows) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ page, limit, totalItems: total, totalPages: Math.ceil(total / limit), data: rows });
    });
  });
});

// ------------------- API: Lấy QR lệnh nạp -------------------
app.get('/api/deposit-orders/:id/qr', (req, res) => {
  const { id } = req.params;
  db.get(`SELECT * FROM deposit_orders WHERE id = ?`, [id], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: 'Lệnh nạp không tồn tại' });

    const qrLink = String(order.qrLink || '').trim();
    const qrBase64 = readQrBase64DataUrl(order);
    const qrImagePath = resolveQrImagePath(order) || '';

    res.json({
      ok: Boolean(qrBase64 || qrLink),
      order: {
        id: order.id,
        username: order.username,
        amount: order.amount,
        accountNumber: order.accountNumber,
        accountHolder: order.accountHolder,
        bank: order.bank,
        transferContent: order.transferContent,
        status: order.status,
      },
      qrBase64,
      qrLink,
      qrImagePath,
    });
  });
});

// ------------------- API: Lấy 1 lệnh nạp theo id -------------------
app.get('/api/deposit-orders/:id', (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(String(id))) {
    return res.status(400).json({ error: 'ID không hợp lệ' });
  }
  db.get(`SELECT * FROM deposit_orders WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Lệnh nạp không tồn tại' });
    res.json(row);
  });
});

// ------------------- API: Cập nhật trạng thái lệnh nạp -------------------
app.put('/api/deposit-orders/:id', (req, res) => {
  const { id } = req.params;
  const { status, accountNumber, accountHolder, bank, transferContent, deviceNap } = req.body;

  db.get(`SELECT status FROM deposit_orders WHERE id = ?`, [id], (err0, existing) => {
    if (err0) return res.status(500).json({ error: err0.message });
    if (!existing) return res.status(404).json({ error: 'Lệnh nạp không tồn tại' });
    if (existing.status === 'Huỷ') {
      return res.status(400).json({ error: 'Lệnh nạp đã Huỷ, không thể cập nhật' });
    }

    const updates = [];
    const values = [];
    if (status) { updates.push('status = ?'); values.push(status); }
    if (accountNumber !== undefined) { updates.push('accountNumber = ?'); values.push(accountNumber); }
    if (accountHolder !== undefined) { updates.push('accountHolder = ?'); values.push(accountHolder); }
    if (bank !== undefined) { updates.push('bank = ?'); values.push(bank); }
    if (transferContent !== undefined) { updates.push('transferContent = ?'); values.push(transferContent); }
    if (deviceNap !== undefined) { updates.push('deviceNap = ?'); values.push(deviceNap); }

    if (updates.length === 0) return res.status(400).json({ error: 'Không có trường để cập nhật' });

    updates.push('updatedAt = datetime("now")');
    values.push(id);

    const sql = `UPDATE deposit_orders SET ${updates.join(', ')} WHERE id = ?`;
    db.run(sql, values, function (err) {
      if (err) {
        console.error("❌ Lỗi khi cập nhật lệnh nạp:", err.message);
        return res.status(500).json({ error: 'Không thể cập nhật lệnh nạp' });
      }
      if (this.changes === 0) return res.status(404).json({ error: 'Lệnh nạp không tồn tại' });

      db.get(`SELECT * FROM deposit_orders WHERE id = ?`, [id], (err2, row) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json(row);
      });
    });
  });
});

// ------------------- API: Kiểm tra transferContent trong deposit_orders -------------------
app.get('/api/deposit-orders/check-transfer-content', (req, res) => {
  const { transferContent, exact } = req.query;

  if (!transferContent) {
    return res.status(400).json({ error: 'Thiếu tham số transferContent' });
  }

  // Nếu exact=true thì tìm chính xác, ngược lại tìm gần đúng (LIKE)
  const isExact = exact === 'true' || exact === '1';
  
  let sql;
  let params;

  if (isExact) {
    sql = `SELECT * FROM deposit_orders WHERE transferContent = ? ORDER BY createdAt DESC`;
    params = [transferContent];
  } else {
    sql = `SELECT * FROM deposit_orders WHERE transferContent LIKE ? ORDER BY createdAt DESC`;
    params = [`%${transferContent}%`];
  }

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error("❌ Lỗi khi kiểm tra transferContent:", err.message);
      return res.status(500).json({ error: 'Không thể kiểm tra transferContent', detail: err.message });
    }

    res.json({
      success: true,
      transferContent: transferContent,
      exact: isExact,
      count: rows.length,
      found: rows.length > 0,
      data: rows
    });
  });
});

// ------------------- API: Lấy danh sách User "Đang Chơi" và users có deposit_orders "Chờ Nạp"/"Đang Nạp"/"Đã Nạp" -------------------
app.get('/api/active-users-with-deposits', (req, res) => {
  // Lấy tất cả users có status = 'Đang Chơi'
  const sqlUsersActive = `SELECT * FROM user_profiles WHERE status = 'Đang Chơi' ORDER BY username`;
  
  // Lấy danh sách username từ deposit_orders có status = 'Chờ Nạp', 'Đang Nạp' hoặc 'Đã Nạp'
  const sqlUsernamesFromOrders = `
    SELECT DISTINCT username 
    FROM deposit_orders 
    WHERE status IN ('Chờ Nạp', 'Đang Nạp', 'Đã Nạp')
  `;

  // Lấy cả 2 danh sách song song
  db.all(sqlUsersActive, [], (err, usersActive) => {
    if (err) {
      console.error("❌ Lỗi khi lấy danh sách users:", err.message);
      return res.status(500).json({ error: 'Không thể lấy danh sách users' });
    }

    db.all(sqlUsernamesFromOrders, [], (err2, usernameRows) => {
      if (err2) {
        console.error("❌ Lỗi khi lấy usernames từ deposit_orders:", err2.message);
        return res.status(500).json({ error: 'Không thể lấy usernames từ deposit_orders' });
      }

      // Nếu không có username nào từ orders, chỉ trả về users "Đang Chơi"
      if (usernameRows.length === 0) {
        return res.json({ 
          total: usersActive.length,
          data: usersActive
        });
      }

      // Lấy thông tin user_profiles của những username có deposit_orders
      const usernames = usernameRows.map(row => row.username);
      const placeholders = usernames.map(() => '?').join(',');
      const sqlUsersFromOrders = `SELECT * FROM user_profiles WHERE username IN (${placeholders}) ORDER BY username`;

      db.all(sqlUsersFromOrders, usernames, (err3, usersFromOrders) => {
        if (err3) {
          console.error("❌ Lỗi khi lấy users từ deposit_orders:", err3.message);
          return res.status(500).json({ error: 'Không thể lấy users từ deposit_orders' });
        }

        // Gộp 2 danh sách và loại bỏ trùng lặp (dựa trên username)
        const userMap = new Map();
        
        // Thêm users "Đang Chơi"
        usersActive.forEach(user => {
          userMap.set(user.username, user);
        });

        // Thêm users có deposit_orders
        usersFromOrders.forEach(user => {
          userMap.set(user.username, user);
        });

        // Chuyển Map thành mảng và sắp xếp theo username
        const uniqueUsers = Array.from(userMap.values()).sort((a, b) => 
          a.username.localeCompare(b.username)
        );

        res.json({ 
          total: uniqueUsers.length,
          data: uniqueUsers
        });
      });
    });
  });
});

// ------------------- API: Users Đang Chơi/Hết Tiền chưa nạp tiền hôm nay -------------------
app.get('/api/users/active-no-deposit-today', (req, res) => {
  const startOfDayVN = dayjs().tz('Asia/Ho_Chi_Minh').startOf('day').format('YYYY-MM-DD HH:mm:ss');
  const sql = `
    SELECT *
    FROM user_profiles
    WHERE status IN ('Đang Chơi', 'Hết Tiền')
      AND NOT EXISTS (
        SELECT 1
        FROM transaction_details td
        WHERE td.username = user_profiles.username
          AND td.hinhThuc = 'Nạp tiền'
          AND td.time >= ?
      )
    ORDER BY username
  `;

  db.all(sql, [startOfDayVN], (err, rows) => {
    if (err) {
      console.error("❌ Lỗi khi lấy users chưa nạp hôm nay:", err.message);
      return res.status(500).json({ error: 'Không thể lấy danh sách users', detail: err.message });
    }
    res.json({ total: rows.length, data: rows });
  });
});

// ------------------- API: Users Hết Tiền có dây thua/thắng >= min trong ngày -------------------
app.get('/api/users/het-tien-streak', (req, res) => {
  const minStreak = Math.max(1, parseInt(req.query.min || '5', 10));
  const sql = `
    SELECT
      up.*,
      s.current_type AS streak_current_type,
      COALESCE(s.current_len, 0) AS streak_current_len
    FROM user_profiles up
    LEFT JOIN streaks s ON s.username = up.username
    WHERE up.status = 'Hết Tiền'
      AND COALESCE(s.current_len, 0) >= ?
    ORDER BY
      COALESCE(s.current_len, 0) DESC,
      up.username
  `;

  db.all(sql, [minStreak], (err, rows) => {
    if (err) {
      console.error("❌ Lỗi khi lấy users Hết Tiền dây thua:", err.message);
      return res.status(500).json({ error: 'Không thể lấy danh sách users', detail: err.message });
    }
    res.json({ total: rows.length, minStreak, data: rows });
  });
});

// ------------------- API: Xóa lệnh nạp -------------------
app.delete('/api/deposit-orders/:id', (req, res) => {
  const { id } = req.params;
  const sql = `DELETE FROM deposit_orders WHERE id = ?`;
  db.run(sql, [id], function (err) {
    if (err) {
      console.error("❌ Lỗi khi xóa lệnh nạp:", err.message);
      return res.status(500).json({ error: 'Không thể xóa lệnh nạp' });
    }
    if (this.changes === 0) return res.status(404).json({ error: 'Lệnh nạp không tồn tại' });
    res.json({ success: true });
  });
});
// --- REPLACE: updateStreak implementation (use dayjs.tz reliably, store ISO UTC updated_at) ---
function updateStreak(db, username, result) {
  if (!username || !["won", "lost"].includes(result)) return;

  const todayVN = dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
  const nowIso = dayjs().toISOString(); // store canonical UTC ISO

  db.get(`SELECT * FROM streaks WHERE username = ?`, [username], (err, row) => {
    if (err) return console.error(err);

    if (!row) {
      const bestWin = result === "won" ? 1 : 0;
      const bestLose = result === "lost" ? 1 : 0;
      const currentLen = 1;
      db.run(`
        INSERT INTO streaks (username, current_type, current_len, best_win_today, best_lose_today, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [username, result, currentLen, bestWin, bestLose, nowIso], err2 => {
        if (err2) console.error(err2);
      });
      return;
    }

    // parse existing updated_at robustly then convert to VN day
    let lastVNDay = null;
    if (row.updated_at) {
      try {
        lastVNDay = dayjs(row.updated_at).tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
      } catch (e) {
        lastVNDay = null;
      }
    }

    let bestWin = Number(row.best_win_today || 0);
    let bestLose = Number(row.best_lose_today || 0);
    let currentLen = Number(row.current_len || 0);
    let currentType = row.current_type || null;

    // If record not from today VN -> reset daily maxima and current streak
    if (!lastVNDay || lastVNDay !== todayVN) {
      bestWin = 0;
      bestLose = 0;
      currentType = null;
      currentLen = 0;
    }

    // apply new result
    const prevType = currentType;
    const prevLen = currentLen;
    if (currentType === result) {
      currentLen += 1;
    } else {
      currentType = result;
      currentLen = 1;
    }

    if (currentType === "won") {
      bestWin = Math.max(bestWin, currentLen);
    } else {
      bestLose = Math.max(bestLose, currentLen);
    }

    db.run(`
      UPDATE streaks
      SET current_type = ?, current_len = ?, best_win_today = ?, best_lose_today = ?, updated_at = ?
      WHERE username = ?
    `, [currentType, currentLen, bestWin, bestLose, nowIso, username], err3 => {
      if (err3) console.error(err3);
    });

    // Event "gãy dây > 8": ví dụ won-9 -> lost-1, hoặc lost-10 -> won-1
    if (
      prevType &&
      prevType !== result &&
      Number(prevLen || 0) > STREAK_BREAK_THRESHOLD_DEFAULT
    ) {
      pushStreakBreakEvent({
        username,
        break_from: prevType,         // won | lost
        break_len: Number(prevLen || 0),
        new_result: result,           // won | lost
        threshold: STREAK_BREAK_THRESHOLD_DEFAULT,
        today_vn: todayVN,
      });
    }
  });
}

// ===== Ensure columns exist (SQLite: ADD COLUMN nếu chưa có) =====
function ensureColumn(table, column, typeAndDefault) {
  db.all(`PRAGMA table_info(${table})`, [], (err, rows) => {
    if (err) {
      console.error(`❌ PRAGMA table_info(${table}) lỗi:`, err.message);
      return;
    }
    const has = rows.some(r => r.name === column);
    if (!has) {
      const sql = `ALTER TABLE ${table} ADD COLUMN ${column} ${typeAndDefault}`;
      db.run(sql, [], (e2) => {
        if (e2) console.error(`❌ Lỗi thêm cột ${column} vào ${table}:`, e2.message);
        else console.log(`✅ Đã thêm cột ${column} vào ${table}`);
      });
    }
  });
}

// Tạo cột streak trong user_profiles nếu chưa có
ensureColumn('user_profiles', 'streak_date',            "TEXT");               // YYYY-MM-DD
ensureColumn('user_profiles', 'streak_current_type',    "TEXT");               // 'won' | 'lost' | NULL
ensureColumn('user_profiles', 'streak_current_len',     "INTEGER DEFAULT 0");
ensureColumn('user_profiles', 'streak_win_today',       "INTEGER DEFAULT 0");  // dây thắng dài nhất trong ngày
ensureColumn('user_profiles', 'streak_lose_today',      "INTEGER DEFAULT 0");  // dây thua dài nhất trong ngày

// (tuỳ chọn) cờ mốc alert để tránh spam
ensureColumn('user_profiles', 'streak_last_alert_win',  "INTEGER DEFAULT 0");
ensureColumn('user_profiles', 'streak_last_alert_lose', "INTEGER DEFAULT 0");
ensureColumn('device_balances', 'nhanNgay', 'INTEGER DEFAULT 0');
ensureColumn('device_balances', 'chuyenNgay', 'INTEGER DEFAULT 0');
ensureColumn('device_balances', 'chuyenNgayDay', "TEXT DEFAULT ''");
ensureColumn('device_balances', 'nhanNgayDay', "TEXT DEFAULT ''");
ensureColumn('device_balances', 'password', "TEXT DEFAULT ''");

// Thống kê slot theo ngày VN — slot_id = game preset 39|40|41 (ws_slot_client --slot), KHÔNG phải roomId payload WS.
db.run(
  `CREATE TABLE IF NOT EXISTS slot_game_daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    slot_id INTEGER NOT NULL,
    spin_count INTEGER NOT NULL DEFAULT 0,
    symbol_count INTEGER NOT NULL DEFAULT 0,
    total_reward_won INTEGER NOT NULL DEFAULT 0,
    reward_claimed INTEGER NOT NULL DEFAULT 0 CHECK(reward_claimed IN (0, 1)),
    vn_day TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(username, slot_id)
  )`,
  (err) => {
    if (err) console.error('❌ Lỗi tạo slot_game_daily_stats:', err.message);
    else console.log('✅ Bảng slot_game_daily_stats sẵn sàng.');
  }
);

ensureColumn('slot_game_daily_stats', 'total_reward_won', 'INTEGER NOT NULL DEFAULT 0');

// Client cũ lưu nhầm ws roomId (vd 100) vào slot_id — gom về preset 41 (một lần, idempotent với dữ liệu đã 41).
db.run(
  `UPDATE slot_game_daily_stats SET slot_id = 41 WHERE slot_id = 100`,
  (migErr) => {
    if (migErr) console.error('⚠️ migrate slot_game_daily_stats 100→41:', migErr.message);
  }
);

// Hoàn tiền tuần/tháng (cashback_reward_periods_api.py + QuanLyLC79_All.html)
db.run(
  `CREATE TABLE IF NOT EXISTS user_reward_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    week_justified_bet_amount INTEGER NOT NULL DEFAULT 0,
    week_current_reward INTEGER NOT NULL DEFAULT 0,
    month_justified_bet_amount INTEGER NOT NULL DEFAULT 0,
    month_current_reward INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  (err) => {
    if (err) console.error('❌ Lỗi tạo user_reward_periods:', err.message);
    else console.log('✅ Bảng user_reward_periods sẵn sàng.');
  }
);

// Tân thủ / VIP point / nhiệm vụ x10 (NhiemVu.html + LC79: tan_thu_vmission_service, vip_point_api, x10_mission_checker)
db.run(
  `CREATE TABLE IF NOT EXISTS user_vip_x10_params (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    onboarding_task INTEGER NOT NULL DEFAULT 0 CHECK(onboarding_task IN (0, 1, 2, 3)),
    vip INTEGER NOT NULL DEFAULT 0 CHECK(vip >= 0),
    x10_total_bet INTEGER NOT NULL DEFAULT 0 CHECK(x10_total_bet >= 0),
    x10_next_reward_total_bet INTEGER NOT NULL DEFAULT 0 CHECK(x10_next_reward_total_bet >= 0),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  (err) => {
    if (err) console.error('❌ Lỗi tạo user_vip_x10_params:', err.message);
    else console.log('✅ Bảng user_vip_x10_params sẵn sàng.');
  }
);

// Thêm cột bank cho deposit_orders nếu chưa có
ensureColumn('deposit_orders', 'bank', "TEXT");
ensureColumn('deposit_orders', 'qrLink', "TEXT");
ensureColumn('deposit_orders', 'qrBase64', "TEXT");
ensureColumn('deposit_orders', 'deviceNap', "TEXT DEFAULT ''");

// Chrome profiles — QuanLyChrome.html (LC79 menu)
const CHROME_PROFILES_DIR = path.resolve(__dirname, '../chrome_profiles_data');
const CHROME_LAUNCH_CONFIG_PATH = path.join(__dirname, 'chrome_launch_config.json');
const BROWSER_ISOLATE_DIR = path.resolve(__dirname, '../LC79/browser_isolate');
const CMS_LAUNCH_SCRIPT = path.join(BROWSER_ISOLATE_DIR, 'cms_launch.py');

function readChromeLaunchConfig() {
  try {
    if (fs.existsSync(CHROME_LAUNCH_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CHROME_LAUNCH_CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('⚠️ chrome_launch_config.json:', e.message);
  }
  return { default_startup_urls: [] };
}

function writeChromeLaunchConfig(cfg) {
  const urls = normalizeStartupUrlList(cfg?.default_startup_urls || []);
  const data = { default_startup_urls: urls };
  fs.writeFileSync(CHROME_LAUNCH_CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function parseStartupUrlsText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function normalizeStartupUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

function normalizeStartupUrlList(listOrText) {
  let raw = listOrText;
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) raw = j;
      else raw = parseStartupUrlsText(raw);
    } catch {
      raw = parseStartupUrlsText(raw);
    }
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const u = normalizeStartupUrl(item);
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

function startupUrlsToStorage(textOrList) {
  return JSON.stringify(normalizeStartupUrlList(textOrList));
}

function startupUrlsToDisplay(stored) {
  if (!stored) return '';
  try {
    const j = JSON.parse(stored);
    if (Array.isArray(j)) return j.join('\n');
  } catch {
    /* raw text */
  }
  return String(stored);
}

function resolveProfileStartupUrls(row) {
  const profileUrls = normalizeStartupUrlList(row?.startup_urls || '');
  if (profileUrls.length) return profileUrls;
  const cfg = readChromeLaunchConfig();
  return normalizeStartupUrlList(cfg.default_startup_urls || []);
}

function ensureChromeProfilesDir() {
  if (!fs.existsSync(CHROME_PROFILES_DIR)) {
    fs.mkdirSync(CHROME_PROFILES_DIR, { recursive: true });
  }
}

function newChromeSessionId() {
  return `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** SOCKS5 host:port:user:pass — kiểm tra format trước khi lưu DB */
function validateSocks5Proxy(proxyStr) {
  const s = String(proxyStr || '').trim();
  if (!s) return '';
  let raw = s;
  for (const prefix of ['socks5h://', 'socks5://']) {
    if (raw.toLowerCase().startsWith(prefix)) raw = raw.slice(prefix.length);
  }
  const parts = raw.split(':');
  if (parts.length < 4) {
    throw new Error(
      'Proxy SOCKS5 cần dạng host:port:user:pass (4 phần, cách nhau bởi dấu :)'
    );
  }
  const port = parseInt(parts[1], 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error('Port proxy không hợp lệ');
  }
  if (!String(parts[2] || '').trim()) {
    throw new Error('Thiếu user SOCKS5');
  }
  return s;
}

function gameDbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ changes: this.changes });
    });
  });
}

/** Gán device cho acc LC79 + xoso66 theo username (fallback khi device DB lệch profile Chrome). */
async function syncDeviceToUsername(username, device) {
  const u = String(username || '').trim();
  const dev = String(device || '').trim();
  if (!u || !dev) return { lc79: 0, xoso66: 0 };
  const lc79Acc = await gameDbRun(
    `UPDATE accounts SET device = ? WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))`,
    [dev, u]
  );
  const lc79Prof = await gameDbRun(
    `UPDATE user_profiles SET device = ? WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))`,
    [dev, u]
  );
  let xoso66 = { changes: 0 };
  try {
    xoso66 = await xoso66DbRun(
      `UPDATE accounts SET device = ?, updated_at = ? WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))`,
      [dev, new Date().toISOString(), u]
    );
  } catch (e) {
    console.warn('⚠️ sync device username xoso66:', e.message);
  }
  return {
    lc79: (lc79Acc.changes || 0) + (lc79Prof.changes || 0),
    xoso66: xoso66.changes || 0,
  };
}

/** Đổi tên device → LC79 + xoso66 (theo device cũ và/hoặc username profile Chrome). */
async function syncDeviceRename(oldDevice, newDevice, username, opts = {}) {
  const oldKey = String(oldDevice || '').trim().toLowerCase();
  const newVal = String(newDevice || '').trim();
  const out = { lc79: 0, xoso66: 0 };
  if (oldKey && newVal && oldKey !== newVal.toLowerCase()) {
    const lc79Acc = await gameDbRun(
      `UPDATE accounts SET device = ? WHERE LOWER(TRIM(device)) = ?`,
      [newVal, oldKey]
    );
    const lc79Prof = await gameDbRun(
      `UPDATE user_profiles SET device = ? WHERE LOWER(TRIM(device)) = ?`,
      [newVal, oldKey]
    );
    out.lc79 = (lc79Acc.changes || 0) + (lc79Prof.changes || 0);
    try {
      const x66 = await xoso66DbRun(
        `UPDATE accounts SET device = ?, updated_at = ? WHERE LOWER(TRIM(device)) = ?`,
        [newVal, new Date().toISOString(), oldKey]
      );
      out.xoso66 = x66.changes || 0;
    } catch (e) {
      console.warn('⚠️ sync device rename xoso66:', e.message);
    }
    if (!opts.skipDeviceBalances) {
      try {
        await gameDbRun(
          `UPDATE device_balances SET device = ? WHERE LOWER(TRIM(device)) = ?`,
          [newVal, oldKey]
        );
      } catch (e) {
        console.warn('⚠️ sync device rename device_balances:', e.message);
      }
    }
    if (out.lc79 || out.xoso66) {
      console.log(
        `✅ Đổi tên device "${oldDevice}" → "${newVal}": LC79=${out.lc79}, xoso66=${out.xoso66}`
      );
    }
  }
  const byUser = await syncDeviceToUsername(username, newVal);
  out.lc79 += byUser.lc79;
  out.xoso66 += byUser.xoso66;
  return out;
}

/** Đồng bộ proxy từ Quản Lý Chrome → LC79 (user_profiles) + xoso66 (accounts) theo device */
async function syncProxyByDevice(device, proxy, username) {
  const devKey = String(device || '').trim().toLowerCase();
  if (!devKey) return { lc79: 0, xoso66: 0 };
  const proxyVal = String(proxy || '').trim();
  // LC79: device hiển thị trên QuanLyLC79 nằm ở accounts.device; proxy ở user_profiles
  const lc79 = await gameDbRun(
    `UPDATE user_profiles SET proxy = ?
     WHERE username IN (
       SELECT username FROM accounts WHERE LOWER(TRIM(device)) = ?
     )
     OR LOWER(TRIM(device)) = ?`,
    [proxyVal, devKey, devKey]
  );
  let xoso66 = { changes: 0 };
  try {
    xoso66 = await xoso66DbRun(
      `UPDATE accounts SET proxy = ?, updated_at = ? WHERE LOWER(TRIM(device)) = ?`,
      [proxyVal, new Date().toISOString(), devKey]
    );
  } catch (e) {
    console.warn('⚠️ sync proxy xoso66:', e.message);
  }
  let out = { lc79: lc79.changes || 0, xoso66: xoso66.changes || 0 };
  const u = String(username || '').trim();
  if (u) {
    try {
      const lc79Acc = await gameDbRun(
        `UPDATE user_profiles SET proxy = ?
         WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))`,
        [proxyVal, u]
      );
      const x66User = await xoso66DbRun(
        `UPDATE accounts SET proxy = ?, updated_at = ? WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))`,
        [proxyVal, new Date().toISOString(), u]
      );
      out = {
        lc79: out.lc79 + (lc79Acc.changes || 0),
        xoso66: out.xoso66 + (x66User.changes || 0),
      };
    } catch (e) {
      console.warn('⚠️ sync proxy username xoso66:', e.message);
    }
  }
  if (out.lc79 || out.xoso66) {
    console.log(
      `✅ Đồng bộ proxy device "${device}": LC79=${out.lc79}, xoso66=${out.xoso66}`
    );
  }
  return out;
}

function launchChromeProfile(row, callback) {
  const { execFile } = require('child_process');
  ensureChromeProfilesDir();
  const profileDir = path.join(CHROME_PROFILES_DIR, String(row.session_id));
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }
  if (!fs.existsSync(CMS_LAUNCH_SCRIPT)) {
    return callback(new Error(`Không thấy ${CMS_LAUNCH_SCRIPT}`));
  }
  const proxy = validateSocks5Proxy(row.proxy);
  const urls = resolveProfileStartupUrls(row);
  const python = process.env.PYTHON || 'python';
  const args = [
    CMS_LAUNCH_SCRIPT,
    '--profile-dir',
    profileDir,
    '--proxy',
    proxy,
    '--urls-json',
    JSON.stringify(urls.length ? urls : ['about:blank']),
  ];
  execFile(
    python,
    args,
    { cwd: BROWSER_ISOLATE_DIR, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 512 },
    (err, stdout, stderr) => {
      let data = null;
      try {
        const line = String(stdout || '').trim().split('\n').pop();
        data = JSON.parse(line || '{}');
      } catch (parseErr) {
        const detail = String(stderr || err?.message || parseErr.message || '').trim();
        return callback(
          new Error(
            detail ||
              'Không mở Chrome. Cài: pip install pproxy (SOCKS5 user/pass) và khởi động lại CMS.'
          )
        );
      }
      if (!data.ok) {
        return callback(new Error(data.error || 'Mở Chrome thất bại'));
      }
      callback(null, data);
    }
  );
}

db.run(
  `CREATE TABLE IF NOT EXISTS chrome_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    proxy TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  (err) => {
    if (err) console.error('❌ Lỗi tạo chrome_profiles:', err.message);
    else console.log('✅ Bảng chrome_profiles sẵn sàng.');
  }
);
ensureColumn('chrome_profiles', 'startup_urls', "TEXT NOT NULL DEFAULT ''");
ensureColumn('chrome_profiles', 'lc79_username', "TEXT NOT NULL DEFAULT ''");
ensureColumn('chrome_profiles', 'device', "TEXT NOT NULL DEFAULT ''");
ensureColumn('chrome_profiles', 'phone', "TEXT NOT NULL DEFAULT ''");
ensureColumn('chrome_profiles', 'bank', "TEXT NOT NULL DEFAULT ''");
ensureColumn('chrome_profiles', 'account_number', "TEXT NOT NULL DEFAULT ''");
ensureColumn('chrome_profiles', 'account_holder', "TEXT NOT NULL DEFAULT ''");

/** Khóa nghiệp vụ = thiết bị (duy nhất, bắt buộc); name = username game, cập nhật sau. */
function migrateChromeProfilesDeviceKey(done) {
  db.get(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chrome_profiles'`,
    [],
    (e, row) => {
      if (e) return done(e);
      const ddl = String(row?.sql || '');
      if (!ddl || /device\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(ddl)) {
        return done(null);
      }
      db.all('SELECT * FROM chrome_profiles', [], (e2, rows) => {
        if (e2) return done(e2);
        const prepared = (rows || []).map((r) => {
          let device = String(r.device || '').trim();
          if (!device) {
            device = String(r.name || '').trim() || String(r.session_id || '').trim();
          }
          return { ...r, device, name: String(r.name || '').trim() };
        });
        db.serialize(() => {
          db.run(
            `CREATE TABLE chrome_profiles_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL DEFAULT '',
              proxy TEXT NOT NULL DEFAULT '',
              session_id TEXT NOT NULL UNIQUE,
              startup_urls TEXT NOT NULL DEFAULT '',
              lc79_username TEXT NOT NULL DEFAULT '',
              device TEXT NOT NULL UNIQUE COLLATE NOCASE,
              phone TEXT NOT NULL DEFAULT '',
              bank TEXT NOT NULL DEFAULT '',
              account_number TEXT NOT NULL DEFAULT '',
              account_holder TEXT NOT NULL DEFAULT '',
              created_at TEXT DEFAULT (datetime('now')),
              updated_at TEXT DEFAULT (datetime('now'))
            )`
          );
          const ins = `INSERT INTO chrome_profiles_new (
            id, name, proxy, session_id, startup_urls, lc79_username,
            device, phone, bank, account_number, account_holder,
            created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`;
          for (const r of prepared) {
            db.run(ins, [
              r.id,
              r.name || '',
              r.proxy || '',
              r.session_id,
              r.startup_urls || '',
              r.lc79_username || '',
              r.device,
              r.phone || '',
              r.bank || '',
              r.account_number || '',
              r.account_holder || '',
              r.created_at,
              r.updated_at,
            ]);
          }
          db.run('DROP TABLE chrome_profiles');
          db.run('ALTER TABLE chrome_profiles_new RENAME TO chrome_profiles');
          console.log('✅ chrome_profiles: khóa chính = thiết bị (device)');
          done(null);
        });
      });
    }
  );
}
migrateChromeProfilesDeviceKey((mErr) => {
  if (mErr) console.error('❌ migrate chrome_profiles device PK:', mErr.message);
});

function mapChromeProfileItem(r) {
  const item = {
    ...r,
    startup_urls_text: startupUrlsToDisplay(r.startup_urls),
    startup_urls_list: normalizeStartupUrlList(r.startup_urls || ''),
    device: r.device || '',
    phone: r.phone || '',
    bank: r.bank || '',
    account_number: r.account_number || '',
    account_holder: r.account_holder || '',
  };
  delete item.lc79_username;
  return item;
}

// ===================== Thêm: Hàm tính ngày/tuần/tháng theo VN và cập nhật bet_totals =====================
function getVNDateInfo() {
  const now = dayjs().tz('Asia/Ho_Chi_Minh');

  // ngày (YYYY-MM-DD)
  const day = now.format('YYYY-MM-DD');

  // tuần bắt đầu từ Chủ Nhật (startOf('week') mặc định của dayjs)
  const week_start = now.startOf('week').format('YYYY-MM-DD');

  // tháng theo quy 30 -> 29 (nếu ngày >=30 -> tháng hiện bắt đầu 30 của tháng hiện tại,
  // nếu ngày <=29 -> tháng hiện bắt đầu 30 của tháng trước)
  let month_start;
  if (now.date() >= 30) {
    const startVN = now.date(30).startOf('day');
    month_start = startVN.format('YYYY-MM-DD');
  } else {
    const startVN = now.subtract(1, 'month').date(30).startOf('day');
    month_start = startVN.format('YYYY-MM-DD');
  }

  return { day, week_start, month_start };
}

function updateTotals(username, amount) {
  return new Promise((resolve, reject) => {
    try {
      const { day, week_start, month_start } = getVNDateInfo();
      // 1) lấy record hiện tại
      db.get(`SELECT * FROM bet_totals WHERE username = ?`, [username], (err, row) => {
        if (err) return reject(err);

        if (!row) {
          // insert mới: map sang cột hiện có trong schema của bạn
          const insertSql = `
            INSERT INTO bet_totals (
              username,
              total_all,
              total_day, day_start,
              total_week, week_start,
              total_month, month_start,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `;
          db.run(insertSql, [
            username,
            amount || 0,
            amount || 0, day,
            amount || 0, week_start,
            amount || 0, month_start
          ], (e2) => {
            if (e2) return reject(e2);
            return resolve();
          });
        } else {
          // update thông minh: nếu day_start khác -> reset total_day = amount, else += amount
          const newTotalAll = (row.total_all || 0) + (amount || 0);

          const dayStartMatches = row.day_start === day;
          const weekStartMatches = row.week_start === week_start;
          const monthStartMatches = row.month_start === month_start;

          const newTotalDay = dayStartMatches ? (row.total_day || 0) + (amount || 0) : (amount || 0);
          const newDayStart = day;

          const newTotalWeek = weekStartMatches ? (row.total_week || 0) + (amount || 0) : (amount || 0);
          const newWeekStart = week_start;

          const newTotalMonth = monthStartMatches ? (row.total_month || 0) + (amount || 0) : (amount || 0);
          const newMonthStart = month_start;

          const updateSql = `
            UPDATE bet_totals
            SET total_all = ?,
                total_day = ?, day_start = ?,
                total_week = ?, week_start = ?,
                total_month = ?, month_start = ?,
                updated_at = datetime('now')
            WHERE username = ?
          `;
          db.run(updateSql, [
            newTotalAll,
            newTotalDay, newDayStart,
            newTotalWeek, newWeekStart,
            newTotalMonth, newMonthStart,
            username
          ], function (e3) {
            if (e3) return reject(e3);
            return resolve();
          });
        }
      });
    } catch (ex) {
      reject(ex);
    }
  });
}

// ================= Hàm tính toán lợi nhuận ngày hôm nay (không lưu) =================
async function calculateTodayProfit() {
  return new Promise((resolve, reject) => {
    try {
      const today = dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
      const startOfDay = dayjs().tz('Asia/Ho_Chi_Minh').startOf('day').format('YYYY-MM-DD HH:mm:ss');
      const endOfDay = dayjs().tz('Asia/Ho_Chi_Minh').endOf('day').format('YYYY-MM-DD HH:mm:ss');

      // 1. Tính tổng nạp/rút từ transaction_details
      db.get(`SELECT 
        SUM(CASE WHEN hinhThuc='Nạp tiền' THEN amount ELSE 0 END) AS deposit,
        SUM(CASE WHEN hinhThuc='Rút tiền' AND status IN ('Thành công', 'pending') THEN amount ELSE 0 END) AS withdraw
        FROM transaction_details`, [], (err1, txnRow) => {
        if (err1) return reject(err1);

        const totalDeposit = Number(txnRow?.deposit || 0);
        const totalWithdraw = Number(txnRow?.withdraw || 0);

        // 1b. Tính tổng nạp/rút trong ngày hôm nay (theo thời gian update)
        db.get(`SELECT 
          SUM(CASE WHEN hinhThuc='Nạp tiền' THEN amount ELSE 0 END) AS deposit_day,
          SUM(CASE WHEN hinhThuc='Rút tiền' AND status IN ('Thành công', 'pending') THEN amount ELSE 0 END) AS withdraw_day
          FROM transaction_details
          WHERE db_time IS NOT NULL AND db_time >= ? AND db_time <= ?`, [startOfDay, endOfDay], (err1b, dayRow) => {
          if (err1b) return reject(err1b);

          const depositDay = Number(dayRow?.deposit_day || 0);
          const withdrawDay = Number(dayRow?.withdraw_day || 0);

          // 2. Tính tổng số dư từ user_profiles (chỉ LC79)
          db.all(`SELECT a.username, u.balance 
            FROM accounts a 
            JOIN user_profiles u ON a.username = u.username 
            WHERE a.game = 'LC79'`, [], (err2, accountRows) => {
            if (err2) return reject(err2);

            const totalBalance = (accountRows || []).reduce((sum, r) => sum + (Number(r.balance) || 0), 0);
            const accountCount = accountRows?.length || 0;

            // 3. Tính tổng cược ngày (từ bet_totals, chỉ tính những user có day_start = hôm nay)
            const todayDateStr = dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
            db.get(`SELECT SUM(total_day) as total FROM bet_totals 
              WHERE day_start = ?`, [todayDateStr], (err3, betRow) => {
              if (err3) return reject(err3);

              const totalBetDay = Number(betRow?.total || 0);

              // 4. Tính lợi nhuận: Rút + Số Dư - Nạp
              const profit = totalWithdraw + totalBalance - totalDeposit;

              resolve({
                date: today,
                total_deposit: totalDeposit,
                total_withdraw: totalWithdraw,
                deposit_day: depositDay,
                withdraw_day: withdrawDay,
                total_balance: totalBalance,
                profit: profit,
                total_bet_day: totalBetDay,
                account_count: accountCount
              });
            });
          });
        });
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ================= Hàm lưu lợi nhuận ngày hôm nay =================
async function saveTodayProfit() {
  try {
    const today = dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
    console.log(`💾 Bắt đầu lưu lợi nhuận ngày: ${today}`);

    // Sử dụng hàm calculateTodayProfit để tính toán
    const todayData = await calculateTodayProfit();

    // Lưu vào database
    return new Promise((resolve, reject) => {
      db.run(`INSERT OR REPLACE INTO daily_profits 
        (date, total_deposit, total_withdraw, deposit_day, withdraw_day, total_balance, profit, total_bet_day, account_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [todayData.date, todayData.total_deposit, todayData.total_withdraw, 
         todayData.deposit_day, todayData.withdraw_day, todayData.total_balance, 
         todayData.profit, todayData.total_bet_day, todayData.account_count],
        function(err) {
          if (err) return reject(err);
          console.log(`✅ Đã lưu lợi nhuận ngày ${today}:`, todayData);
          resolve(todayData);
        });
    });
  } catch (e) {
    throw e;
  }
}

// API cập nhật streak
app.post("/streaks/update", (req, res) => {
  const { username, result } = req.body;

  if (!username || !["won","lost"].includes(result)) {
    return res.status(400).json({ error: "username hoặc result không hợp lệ" });
  }

  updateStreak(db, username, result);  // truyền db đúng
  res.json({ message: "✅ Streak đã được cập nhật." });
});

// API lấy tổng nạp/rút theo user trong ngày
app.get('/api/transactions/grouped/by-user/today', (req, res) => {
  try {
    const startOfDayVN = dayjs().tz('Asia/Ho_Chi_Minh').startOf('day').format('YYYY-MM-DD HH:mm:ss');
    const endOfDayVN = dayjs().tz('Asia/Ho_Chi_Minh').endOf('day').format('YYYY-MM-DD HH:mm:ss');

    const sql = `
      SELECT username,
             SUM(CASE WHEN hinhThuc='Nạp tiền' THEN amount ELSE 0 END) AS deposit,
             SUM(CASE WHEN hinhThuc='Rút tiền' AND status='Thành công' THEN amount ELSE 0 END) AS withdraw
      FROM transaction_details
      WHERE ${TXN_EFFECTIVE_TIME_SQL} BETWEEN datetime(?) AND datetime(?)
      GROUP BY username
    `;
    db.all(sql, [startOfDayVN, endOfDayVN], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const map = {};
      (rows || []).forEach(r => {
        const u = String(r.username || '').trim();
        if (!u) return;
        map[u] = {
          deposit: Number(r.deposit) || 0,
          withdraw: Number(r.withdraw) || 0,
        };
      });
      res.json(map);
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// API tổng nạp / tổng rút của 1 user trong transaction_details (toàn thời gian)
// GET /api/transaction-totals?username=...
// Hoặc GET /api/users/:username/transaction-totals
function handleUserTransactionTotals(username, res) {
  const u = String(username || '').trim();
  if (!u) {
    return res.status(400).json({ ok: false, error: 'username bắt buộc' });
  }
  const sql = `
    SELECT
      SUM(CASE WHEN hinhThuc = 'Nạp tiền' THEN amount ELSE 0 END) AS total_deposit,
      SUM(CASE WHEN hinhThuc = 'Rút tiền' AND status IN ('Thành công', 'pending') THEN amount ELSE 0 END) AS total_withdraw
    FROM transaction_details
    WHERE username = ?
  `;
  db.get(sql, [u], (err, row) => {
    if (err) {
      console.error('❌ transaction-totals:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
    const totalDeposit = Number(row?.total_deposit || 0);
    const totalWithdraw = Number(row?.total_withdraw || 0);
    res.json({
      ok: true,
      username: u,
      total_deposit: totalDeposit,
      total_withdraw: totalWithdraw,
      net: totalDeposit - totalWithdraw
    });
  });
}

app.get('/api/transaction-totals', (req, res) => {
  handleUserTransactionTotals(req.query.username, res);
});

app.get('/api/users/:username/transaction-totals', (req, res) => {
  handleUserTransactionTotals(req.params.username, res);
});


// API lấy dữ liệu streak nhiều user
// ...existing code...

// API lấy dữ liệu streak nhiều user (batch) — ensure compare by VN day
app.post('/streaks/batch', (req, res) => {
  try {
    const usernames = Array.isArray(req.body?.usernames) ? req.body.usernames.filter(Boolean) : [];
    if (usernames.length === 0) return res.json({});
    const placeholders = usernames.map(() => '?').join(',');
    const sql = `SELECT * FROM streaks WHERE username IN (${placeholders})`;
    db.all(sql, usernames, (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const todayVN = dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
      const map = {};
      (rows || []).forEach(r => {
        let bestWin = Number(r.best_win_today || 0);
        let bestLose = Number(r.best_lose_today || 0);
        let currentType = r.current_type || null;
        let currentLen = Number(r.current_len || 0);
        let updatedAt = r.updated_at || null;

        const updatedDay = r.updated_at ? dayjs(r.updated_at).tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD') : null;
        if (!updatedDay || updatedDay !== todayVN) {
          bestWin = 0;
          bestLose = 0;
          // keep currentType/currentLen reset behavior if you prefer to reset them as well
        }

        map[r.username] = {
          best_win_today: bestWin,
          best_lose_today: bestLose,
          current_type: currentType,
          current_len: currentLen,
          updated_at: updatedAt
        };
      });
      usernames.forEach(u => {
        if (!map[u]) map[u] = { best_win_today: 0, best_lose_today: 0, current_type: null, current_len: 0, updated_at: null };
      });
      res.json(map);
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// API lấy streak 1 user — compare by VN day
app.get("/streaks/:username", (req, res) => {
  const { username } = req.params;

  db.get(`SELECT * FROM streaks WHERE username = ?`, [username], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "User không tồn tại" });

    const todayVN = dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
    const updatedDay = row.updated_at ? dayjs(row.updated_at).tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD') : null;

    let bestWin = Number(row.best_win_today || 0);
    let bestLose = Number(row.best_lose_today || 0);

    if (!updatedDay || updatedDay !== todayVN) {
      bestWin = 0;
      bestLose = 0;
    }

    res.json({
      id: row.id,
      username: row.username,
      best_win_today: bestWin,
      best_lose_today: bestLose,
      current_type: row.current_type,
      current_len: row.current_len,
      updated_at: row.updated_at
    });
  });
});

// ------------------- API: Lấy tài khoản Hết Tiền sắp xếp theo lần nạp Thành Công gần nhất -------------------
app.get('/api/accounts/out-of-money', (req, res) => {
  const sql = `
    SELECT 
      a.*,
      MAX(d.createdAt) as lastSuccessfulDeposit
    FROM accounts a
    LEFT JOIN deposit_orders d ON a.username = d.username AND d.status = 'Thành Công'
    WHERE a.status = 'Hết Tiền'
      AND a.username NOT IN (
        SELECT username FROM deposit_orders WHERE status IN ('Chờ Nạp','Đang Nạp','Đã Nạp')
      )
    GROUP BY a.username
    ORDER BY lastSuccessfulDeposit ASC
  `;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("❌ Lỗi khi lấy tài khoản Hết Tiền:", err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows || []);
  });
});

// ------------------- API: Hết Tiền ưu tiên dây ngắn (đẩy dây dài xuống cuối) -------------------
app.get('/api/accounts/out-of-money-priority', (req, res) => {
  const streakLimit = Math.max(1, parseInt(req.query.streak_limit || '8', 10));
  const includeHighStreak = String(req.query.include_high_streak || '1') === '1';

  const sql = `
    SELECT
      a.*,
      MAX(d.createdAt) AS lastSuccessfulDeposit,
      COALESCE(s.current_len, 0) AS streak_current_len,
      MAX(COALESCE(s.best_win_today, 0), COALESCE(s.best_lose_today, 0)) AS streak_peak_today,
      COALESCE(s.current_type, '') AS streak_current_type,
      s.updated_at AS streak_updated_at,
      CASE
        WHEN MAX(COALESCE(s.best_win_today, 0), COALESCE(s.best_lose_today, 0)) > ? THEN 1
        ELSE 0
      END AS is_high_streak
    FROM accounts a
    LEFT JOIN deposit_orders d ON a.username = d.username AND d.status = 'Thành Công'
    LEFT JOIN streaks s ON s.username = a.username
    WHERE a.status = 'Hết Tiền'
      AND a.username NOT IN (
        SELECT username FROM deposit_orders WHERE status IN ('Chờ Nạp', 'Đang Nạp', 'Đã Nạp')
      )
    GROUP BY a.username
    ORDER BY
      CASE
        WHEN ? = 1 THEN is_high_streak
        ELSE 0
      END ASC,
      lastSuccessfulDeposit ASC,
      a.username ASC
  `;

  db.all(sql, [streakLimit, includeHighStreak ? 1 : 0], (err, rows) => {
    if (err) {
      console.error("❌ Lỗi khi lấy danh sách out-of-money-priority:", err.message);
      return res.status(500).json({ error: err.message });
    }
    const todayVN = dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
    const normalizedRows = (rows || []).map((row) => {
      let updatedDay = null;
      if (row?.streak_updated_at) {
        try {
          updatedDay = dayjs(row.streak_updated_at).tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
        } catch (_) {
          updatedDay = null;
        }
      }
      if (updatedDay !== todayVN) {
        return {
          ...row,
          streak_current_len: 0,
          streak_peak_today: 0,
          is_high_streak: 0,
        };
      }
      return row;
    });
    normalizedRows.sort((a, b) => {
      const leftHigh = includeHighStreak ? (Number(a.is_high_streak) || 0) : 0;
      const rightHigh = includeHighStreak ? (Number(b.is_high_streak) || 0) : 0;
      // 1) Nếu bật include_high_streak: đẩy acc có peak > streak_limit xuống cuối.
      if (leftHigh !== rightHigh) return leftHigh - rightHigh;

      const leftNoStreakToday =
        !a?.streak_updated_at || Number(a.streak_peak_today || 0) <= 0 ? 1 : 0;
      const rightNoStreakToday =
        !b?.streak_updated_at || Number(b.streak_peak_today || 0) <= 0 ? 1 : 0;
      // 2) Trong cùng nhóm high/normal: ưu tiên acc chưa có streak hôm nay (chưa chơi / chưa cập nhật).
      if (leftNoStreakToday !== rightNoStreakToday) {
        return rightNoStreakToday - leftNoStreakToday;
      }

      // 3) Fallback cũ: lần nạp gần nhất cũ hơn đứng trước.
      const lastA = a.lastSuccessfulDeposit || '';
      const lastB = b.lastSuccessfulDeposit || '';
      if (lastA < lastB) return -1;
      if (lastA > lastB) return 1;
      return String(a.username || '').localeCompare(String(b.username || ''));
    });
    // Giữ format giống API cũ: trả về list
    res.json(normalizedRows);
  });
});

// ...existing code...

// ------------------- Lấy toàn bộ tài khoản -------------------
app.get('/api/accounts', (req, res) => {
  const sql = `
    SELECT a.*, p.nickname AS nickname
    FROM accounts a
    LEFT JOIN user_profiles p ON p.username = a.username
  `;
  db.all(sql, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Xuất CSV: username, SĐT, ngân hàng, STK, chủ TK, thiết bị, proxy (game_data.db) */
app.get('/api/accounts/export.csv', (req, res) => {
  const game = String(req.query.game || '').trim();
  let sql = `
    SELECT
      a.username,
      a.phone,
      a.bank,
      a.accountNumber,
      a.accountHolder,
      COALESCE(NULLIF(TRIM(a.device), ''), NULLIF(TRIM(p.device), ''), '') AS device,
      COALESCE(p.proxy, '') AS proxy
    FROM accounts a
    LEFT JOIN user_profiles p ON p.username = a.username
  `;
  const params = [];
  if (game) {
    sql += ` WHERE a.game = ?`;
    params.push(game);
  }
  sql += ` ORDER BY a.username COLLATE NOCASE`;

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('❌ export accounts:', err.message);
      return res.status(500).json({ error: err.message });
    }
    const header = [
      'username',
      'SĐT',
      'Ngân hàng',
      'STK Ngân hàng',
      'Tên chủ TK ngân hàng',
      'Thiết bị',
      'proxy',
    ];
    const lines = [header.map(csvEscape).join(',')];
    for (const r of rows || []) {
      lines.push(
        [
          r.username,
          r.phone,
          r.bank,
          r.accountNumber,
          r.accountHolder,
          r.device,
          r.proxy,
        ]
          .map(csvEscape)
          .join(',')
      );
    }
    const body = '\uFEFF' + lines.join('\r\n') + '\r\n';
    const suffix = game ? `_${game}` : '';
    const fname = `accounts_export${suffix}_${dayjs().format('YYYYMMDD_HHmmss')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(body);
  });
});

// ------------------- API gọi deposit_api.py -------------------
app.post('/api/deposit', async (req, res) => {
  const { username, amount } = req.body;
  
  console.log('💰 API /api/deposit được gọi:', { username, amount });
  
  if (!username || !amount || amount <= 0) {
    console.log('❌ Thiếu thông tin hoặc số tiền không hợp lệ');
    return res.status(400).json({ error: 'Missing username or invalid amount' });
  }

  const sqlCheckPending = `
    SELECT id, status, amount, createdAt, updatedAt
    FROM deposit_orders
    WHERE username = ?
      AND status IN ('Chờ Nạp', 'Đang Nạp', 'Đã Nạp')
    ORDER BY createdAt DESC
    LIMIT 1
  `;

  db.get(sqlCheckPending, [username], (checkErr, existingOrder) => {
    if (checkErr) {
      console.error("❌ Lỗi khi kiểm tra lệnh nạp:", checkErr.message);
      return res.status(500).json({ error: 'Không thể kiểm tra lệnh nạp' });
    }
    if (existingOrder) {
      return res.status(409).json({
        error: 'Tài khoản đang có lệnh nạp chưa hoàn thành',
        order: existingOrder
      });
    }

  const { spawn } = require('child_process');
  const args = [
    'c:\\Users\\Quang\\Documents\\LC79\\deposit_api.py',
    username,
    amount.toString()
  ];
  
  console.log('🐍 Chạy Python với args:', args);
  const python = spawn('python', args);

  let result = '';
  let error = '';

  python.stdout.on('data', (data) => { 
    const output = data.toString();
    console.log('📤 Python stdout:', output);
    result += output;
  });
  
  python.stderr.on('data', (data) => { 
    const errOutput = data.toString();
    console.error('📤 Python stderr:', errOutput);
    error += errOutput;
  });

  python.on('close', (code) => {
    console.log('🐍 Python exit code:', code);
    console.log('📦 Result:', result);
    console.log('❌ Error:', error);
    
    if (code !== 0) {
      return res.status(500).json({ error: error || 'Python script failed', details: result });
    }
    
    try {
      // Lọc lấy dòng JSON cuối cùng
      const lines = result.split('\n').filter(line => line.trim());
      const jsonLine = lines.find(line => line.trim().startsWith('{'));
      
      const parsed = JSON.parse(jsonLine || result);
      const data = parsed?.data || {};
      const qrImagePath = data.qrImagePath;
      const hasInlineQr = Boolean(data.qr_base64 || data.qrBase64 || data.qr);

      if (qrImagePath && !hasInlineQr) {
        try {
          const imgBase64 = fs.readFileSync(qrImagePath).toString('base64');
          parsed.data = { ...data, qr_base64: imgBase64 };
        } catch (readErr) {
          console.error('❌ Không đọc được QR image:', readErr.message);
        }
      }

      res.json(parsed);
    } catch (e) {
      console.error('❌ Lỗi parse JSON:', e.message);
      res.json({ ok: true, output: result.trim() });
    }
  });
  });
});

// ------------------- API gọi withdraw.py -------------------
app.post('/api/withdraw', async (req, res) => {
  const { username, amount, bankCode, accountNumber, accountHolder, otp } = req.body;
  
  if (!username || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Missing username or invalid amount' });
  }

  const { spawn } = require('child_process');
  
  // Build arguments cho Python script
  const args = [
    'c:\\Users\\Quang\\Documents\\LC79\\withdraw.py',
    username,
    amount.toString()
  ];
  
  // Thêm các tham số optional nếu có
  if (bankCode) args.push('--bank', bankCode);
  if (accountNumber) args.push('--account', accountNumber);
  if (accountHolder) args.push('--holder', accountHolder);
  if (otp) args.push('--otp', otp);
  
  console.log('🐍 Chạy Python với args:', args);
  const python = spawn('python', args);

  let result = '';
  let error = '';

  python.stdout.on('data', (data) => { 
    const output = data.toString();
    console.log('📤 Python stdout:', output);
    result += output;
  });
  
  python.stderr.on('data', (data) => { 
    const errOutput = data.toString();
    console.error('📤 Python stderr:', errOutput);
    error += errOutput;
  });

  python.on('close', (code) => {
    console.log('🐍 Python exit code:', code);
    console.log('📦 Result:', result);
    console.log('❌ Error:', error);
    
    if (code !== 0) {
      return res.status(500).json({ error: error || 'Python script failed', details: result });
    }
    
    try {
      // Lọc lấy dòng JSON cuối cùng (dòng có { ... })
      const lines = result.split('\n').filter(line => line.trim());
      const jsonLine = lines.find(line => line.trim().startsWith('{'));
      
      if (jsonLine) {
        const parsed = JSON.parse(jsonLine);
        res.json(parsed);
      } else {
        // Fallback: thử parse toàn bộ
        res.json(JSON.parse(result));
      }
    } catch (e) {
      console.error('❌ Lỗi parse JSON:', e.message);
      // Vẫn trả về success vì script exit 0
      res.json({ ok: true, output: result.trim() });
    }
  });
});// ...existing code...
// ------------------- Thêm tài khoản mới + UserProfile -------------------
// ...existing code...

app.post('/api/accounts', (req, res) => {
  const {
    game, username, nickname, loginPass, phone, withdrawPass, bank, accountNumber, accountHolder, device, proxy,
  } = req.body;
  const uuid = uuidv4();
  const proxyVal = String(proxy || '').trim();

  // 1. Thêm Account
  const sqlAcc = `INSERT INTO accounts 
    (game, username, loginPass, phone, withdrawPass, bank, accountNumber, accountHolder, device, uuid) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  db.run(sqlAcc, [game, username, loginPass, phone, withdrawPass, bank, accountNumber, accountHolder, device, uuid], function (err) {
    if (err) {
      console.error("❌ Lỗi khi thêm Account:", err.message);
      return res.status(500).json({ error: "Không thể thêm tài khoản" });
    }

    const accountId = this.lastID; // ID mới thêm

    // 2. Kiểm tra UserProfile tồn tại chưa
    const sqlCheck = `SELECT * FROM user_profiles WHERE username = ?`;
    db.get(sqlCheck, [username], (err, row) => {
      if (err) {
        console.error("❌ Lỗi khi kiểm tra UserProfile:", err.message);
        return res.status(500).json({ error: "Không thể kiểm tra UserProfile" });
      }

      if (!row) {
        // 3. Nếu chưa có thì thêm UserProfile mới (nickname lưu tại user_profiles)
        const sqlProfile = `INSERT INTO user_profiles (username, nickname, proxy, status, device, balance) VALUES (?, ?, ?, ?, ?, ?)`;
        db.run(sqlProfile, [username, nickname || null, proxyVal || null, "Mới Tạo", device || "", 0], function (err2) {
          if (err2) {
            console.error("❌ Lỗi khi thêm UserProfile:", err2.message);
            return res.status(500).json({ error: "Không thể thêm UserProfile" });
          }

          res.json({
            success: true,
            account: {
              id: accountId,
              username,
              game,
              device
            },
            userProfileCreated: true
          });
        });
      } else {
        const respondExisting = () => res.json({
          success: true,
          account: {
            id: accountId,
            username,
            game,
            device
          },
          userProfileCreated: false
        });

        // Nếu profile đã tồn tại, đồng bộ nickname / proxy / device từ form (nếu có gửi)
        const profileUpdates = [];
        const profileVals = [];
        if (Object.prototype.hasOwnProperty.call(req.body, 'nickname')) {
          profileUpdates.push('nickname = ?');
          profileVals.push(nickname || null);
        }
        if (Object.prototype.hasOwnProperty.call(req.body, 'proxy')) {
          profileUpdates.push('proxy = ?');
          profileVals.push(proxyVal || null);
        }
        if (Object.prototype.hasOwnProperty.call(req.body, 'device')) {
          profileUpdates.push('device = ?');
          profileVals.push(device || '');
        }
        if (!profileUpdates.length) {
          return respondExisting();
        }
        profileVals.push(username);
        db.run(
          `UPDATE user_profiles SET ${profileUpdates.join(', ')} WHERE username = ?`,
          profileVals,
          (err3) => {
            if (err3) {
              console.error("❌ Lỗi khi cập nhật UserProfile:", err3.message);
              return res.status(500).json({ error: "Không thể cập nhật UserProfile" });
            }
            respondExisting();
          }
        );
      }
    });
  });
});
// ------------------- Lấy toàn bộ user -------------------
app.get('/api/users', (req, res) => {
  const sql = `SELECT * FROM user_profiles`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("❌ Lỗi SQL:", err); // in full object
      return res.status(500).json({ error: "Lỗi server", detail: err.message });
    }
    res.json(rows);
  });
});

// LC79 + trạng thái Đang Chơi / Hết Tiền, kèm tổng cược ngày (LEFT bet_totals — không có dòng thì total_day = 0).
// GET /api/users/lc79-playing-or-out?page=1&limit=10000  (alias: /api/lc79/playing-or-out)
// profile_status=Đang Chơi | Hết Tiền (bỏ trống = cả hai). sort=total_day|username (mặc định total_day DESC).
// Express 5 có thể khớp /api/users/:username trước path tĩnh — cũng gọi handler từ :username khi slug trùng.
async function handleLc79PlayingOrOutList(req, res) {
  try {
    await refreshBetTotalsAll();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(50000, parseInt(req.query.limit, 10) || 10000));
    const offset = (page - 1) * limit;
    const ps = String(req.query.profile_status || '').trim();
    let statusClause;
    if (!ps) {
      statusClause = `up.status IN ('Đang Chơi', 'Hết Tiền')`;
    } else if (ps === 'Đang Chơi' || ps === 'Hết Tiền') {
      statusClause = `up.status = '${ps.replace(/'/g, "''")}'`;
    } else {
      return res.status(400).json({
        error: 'profile_status chỉ nhận Đang Chơi, Hết Tiền, hoặc bỏ trống (cả hai)',
      });
    }
    const sortKey = String(req.query.sort || 'total_day').toLowerCase();
    const orderSql =
      sortKey === 'username'
        ? 'up.username ASC'
        : 'COALESCE(bt.total_day, 0) DESC, up.username ASC';

    const scopeWhere = `${statusClause}
      AND EXISTS (SELECT 1 FROM accounts ac WHERE ac.username = up.username AND ac.game = 'LC79')`;

    const countSql = `SELECT COUNT(*) AS total
      FROM user_profiles up
      WHERE ${scopeWhere}`;

    const listSql = `SELECT up.id AS profile_id, up.username, up.nickname, up.status, up.balance, up.device, up.proxy,
        COALESCE(bt.total_day, 0) AS total_day,
        bt.day_start,
        COALESCE(bt.total_week, 0) AS total_week,
        COALESCE(bt.total_month, 0) AS total_month,
        COALESCE(bt.total_all, 0) AS total_all,
        bt.updated_at AS bet_totals_updated_at
      FROM user_profiles up
      LEFT JOIN bet_totals bt ON bt.username = up.username
        AND bt.id = (SELECT MAX(x.id) FROM bet_totals x WHERE x.username = up.username)
      WHERE ${scopeWhere}
      ORDER BY ${orderSql}
      LIMIT ? OFFSET ?`;

    db.get(countSql, [], (err, countRow) => {
      if (err) return res.status(500).json({ error: err.message });
      const total = countRow?.total || 0;
      db.all(listSql, [limit, offset], (err2, rows) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({
          description:
            'LC79 + Đang Chơi/Hết Tiền; total_day và các cột bet từ bet_totals (0 nếu chưa có dòng).',
          page,
          limit,
          sort: sortKey === 'username' ? 'username' : 'total_day',
          totalItems: total,
          totalPages: Math.ceil(total / limit) || 1,
          data: rows,
        });
      });
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}

app.get('/api/users/lc79-playing-or-out', handleLc79PlayingOrOutList);
app.get('/api/lc79/playing-or-out', handleLc79PlayingOrOutList);

// ------------------- Lấy 1 user theo username -------------------
app.get('/api/users/:username', (req, res) => {
  if (req.params.username === 'lc79-playing-or-out') {
    return handleLc79PlayingOrOutList(req, res);
  }
  const sql = `SELECT * FROM user_profiles WHERE username = ?`;
  db.get(sql, [req.params.username], (err, row) => {
    if (err) {
      console.error("❌ Lỗi SQL:", err);
      return res.status(500).json({ error: "Lỗi server", detail: err.message });
    }
    if (!row) {
      console.warn("⚠️ Không tìm thấy user:", req.params.username);
      return res.status(404).json({ error: "Không tìm thấy user" });
    }
    res.json(row);
  });
});



// ------------------- Thêm user mới -------------------
app.post('/api/users', (req, res) => {
  const { username, nickname, proxy, uuid, device, balance, accessToken, jwt, status } = req.body;
  const sql = `INSERT INTO user_profiles 
    (username, nickname, proxy, uuid, device, balance, accessToken, jwt, status) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  db.run(sql, [
    username,
    nickname || null,
    proxy || null,
    uuid || null,
    device || null,
    balance || 0,
    accessToken || null,
    jwt || null,
    status || "Mới Tạo"
  ], function (err) {
    if (err) {
      console.error("❌ Lỗi khi thêm user:", err.message);
      return res.status(500).json({ error: "Không thể thêm user" });
    }
    res.json({
      success: true,
      user: {
        id: this.lastID,
        username,
        nickname,
        proxy,
        uuid,
        device,
        balance: balance || 0,
        accessToken,
        jwt,
        status: status || "Mới Tạo"
      }
    });
  });
});
// ------------------- Cập nhật user -------------------
app.put('/api/users/:username', (req, res) => {
  const oldUsername = String(req.params.username || '').trim();
  const fields = req.body || {};
  const requestedUsername = Object.prototype.hasOwnProperty.call(fields, 'username')
    ? String(fields.username || '').trim()
    : oldUsername;

  const applyUserUpdate = (username) => {
    const updates = [];
    const values = [];

    // ✅ Chỉ cho phép cập nhật các cột này (username đổi qua rename riêng)
    const allowedFields = [
      'status', 'name', 'phone', 'email', 'note', 'balance', 'jwt', 'nickname',
      'proxy', 'uuid', 'device', 'accessToken',
      // thêm các trường streak:
      'streak_date',
      'streak_current_type',
      'streak_current_len',
      'streak_win_today',
      'streak_lose_today',
      'streak_last_alert_win',
      'streak_last_alert_lose',
    ];

    for (const key in fields) {
      if (key === 'username') continue;
      if (allowedFields.includes(key)) {
        updates.push(`${key} = ?`);
        values.push(fields[key]);
      }
    }

    const respondUser = () => {
      db.get(`SELECT * FROM user_profiles WHERE username = ?`, [username], (err3, row) => {
        if (err3) {
          return res.status(500).json({ error: "Lỗi khi lấy user sau update" });
        }
        res.json(row);
      });
    };

    // Chỉ đổi username (đã rename) — không có field khác
    if (updates.length === 0) {
      return respondUser();
    }

    values.push(username);
    const sql = `UPDATE user_profiles SET ${updates.join(", ")} WHERE username = ?`;

    db.run(sql, values, function (err) {
      if (err) {
        console.error("❌ Lỗi khi cập nhật user:", err.message);
        return res.status(500).json({ error: "Không thể cập nhật user" });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: "Không tìm thấy user" });
      }

      // 🔁 Nếu có status -> đồng bộ sang Account
      if (typeof fields.status !== "undefined") {
        const sqlAcc = `UPDATE accounts SET status = ? WHERE username = ?`;
        db.run(sqlAcc, [fields.status, username], (err2) => {
          if (err2) {
            console.error("❌ Lỗi khi đồng bộ status sang Account:", err2.message);
          }
        });
      }

      respondUser();
    });
  };

  if (requestedUsername && requestedUsername !== oldUsername) {
    return renameLc79Username(oldUsername, requestedUsername, (renameErr) => {
      if (renameErr) {
        return res.status(renameErr.status || 500).json({ error: renameErr.message });
      }
      applyUserUpdate(requestedUsername);
    });
  }

  const allowedProbe = [
    'status', 'name', 'phone', 'email', 'note', 'balance', 'jwt', 'nickname',
    'proxy', 'uuid', 'device', 'accessToken',
    'streak_date', 'streak_current_type', 'streak_current_len',
    'streak_win_today', 'streak_lose_today',
    'streak_last_alert_win', 'streak_last_alert_lose',
  ];
  const hasAllowed = Object.keys(fields).some(
    (k) => k !== 'username' && allowedProbe.includes(k)
  );
  if (!hasAllowed) {
    return res.status(400).json({ error: "Không có trường hợp lệ để cập nhật" });
  }
  applyUserUpdate(oldUsername);
});

function rowToUserRewardPeriod(row) {
  if (!row) return null;
  const wj = Number(row.week_justified_bet_amount || 0);
  const wr = Number(row.week_current_reward || 0);
  const mj = Number(row.month_justified_bet_amount || 0);
  const mr = Number(row.month_current_reward || 0);
  return {
    id: row.id,
    username: row.username,
    week_justified_bet_amount: wj,
    weekJustifiedBetAmount: wj,
    week_current_reward: wr,
    weekCurrentReward: wr,
    month_justified_bet_amount: mj,
    monthJustifiedBetAmount: mj,
    month_current_reward: mr,
    monthCurrentReward: mr,
    updated_at: row.updated_at,
  };
}

function parseVipX10OnboardingTask(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0 || n > 3) return null;
  return n;
}

function parseVipX10NonNegInt(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function rowToVipX10Params(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    onboarding_task: Number(row.onboarding_task ?? 0),
    vip: Number(row.vip ?? 0),
    x10_total_bet: Number(row.x10_total_bet ?? 0),
    x10_next_reward_total_bet: Number(row.x10_next_reward_total_bet ?? 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ------------------- user_reward_periods (cashback preview tuần/tháng) -------------------
app.get('/api/user-reward-periods', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100000, parseInt(req.query.limit, 10) || 10000));
  const offset = (page - 1) * limit;

  db.all(
    `SELECT * FROM user_reward_periods ORDER BY username ASC LIMIT ? OFFSET ?`,
    [limit, offset],
    (err, rows) => {
      if (err) {
        console.error('❌ user_reward_periods GET list:', err.message);
        return res.status(500).json({ error: err.message });
      }
      const data = (rows || []).map((r) => rowToUserRewardPeriod(r));
      res.json({ data, page, limit });
    }
  );
});

app.post('/api/user-reward-periods', (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  if (!username) {
    return res.status(400).json({ error: 'Thiếu username' });
  }

  const wj = parseInt(b.weekJustifiedBetAmount ?? b.week_justified_bet_amount ?? 0, 10) || 0;
  const wr = parseInt(b.weekCurrentReward ?? b.week_current_reward ?? 0, 10) || 0;
  const mj = parseInt(b.monthJustifiedBetAmount ?? b.month_justified_bet_amount ?? 0, 10) || 0;
  const mr = parseInt(b.monthCurrentReward ?? b.month_current_reward ?? 0, 10) || 0;

  db.run(
    `INSERT INTO user_reward_periods (username, week_justified_bet_amount, week_current_reward, month_justified_bet_amount, month_current_reward, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [username, wj, wr, mj, mr],
    function (insErr) {
      if (insErr) {
        if (String(insErr.message).toUpperCase().includes('UNIQUE')) {
          return res.status(409).json({ error: 'Username đã tồn tại trong user_reward_periods' });
        }
        console.error('❌ user_reward_periods INSERT:', insErr.message);
        return res.status(500).json({ error: insErr.message });
      }
      db.get(
        `SELECT * FROM user_reward_periods WHERE id = ?`,
        [this.lastID],
        (e2, row) => {
          if (e2 || !row) {
            return res.status(201).json({ ok: true, id: this.lastID, username });
          }
          res.status(201).json(rowToUserRewardPeriod(row));
        }
      );
    }
  );
});

app.put('/api/user-reward-periods/:username', (req, res) => {
  const username = String(req.params.username || '').trim();
  const b = req.body || {};
  const updates = [];
  const values = [];

  if (
    Object.prototype.hasOwnProperty.call(b, 'weekJustifiedBetAmount') ||
    Object.prototype.hasOwnProperty.call(b, 'week_justified_bet_amount')
  ) {
    const v = b.weekJustifiedBetAmount !== undefined ? b.weekJustifiedBetAmount : b.week_justified_bet_amount;
    updates.push('week_justified_bet_amount = ?');
    values.push(parseInt(v, 10) || 0);
  }
  if (
    Object.prototype.hasOwnProperty.call(b, 'weekCurrentReward') ||
    Object.prototype.hasOwnProperty.call(b, 'week_current_reward')
  ) {
    const v = b.weekCurrentReward !== undefined ? b.weekCurrentReward : b.week_current_reward;
    updates.push('week_current_reward = ?');
    values.push(parseInt(v, 10) || 0);
  }
  if (
    Object.prototype.hasOwnProperty.call(b, 'monthJustifiedBetAmount') ||
    Object.prototype.hasOwnProperty.call(b, 'month_justified_bet_amount')
  ) {
    const v = b.monthJustifiedBetAmount !== undefined ? b.monthJustifiedBetAmount : b.month_justified_bet_amount;
    updates.push('month_justified_bet_amount = ?');
    values.push(parseInt(v, 10) || 0);
  }
  if (
    Object.prototype.hasOwnProperty.call(b, 'monthCurrentReward') ||
    Object.prototype.hasOwnProperty.call(b, 'month_current_reward')
  ) {
    const v = b.monthCurrentReward !== undefined ? b.monthCurrentReward : b.month_current_reward;
    updates.push('month_current_reward = ?');
    values.push(parseInt(v, 10) || 0);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Không có trường hợp lệ để cập nhật' });
  }

  updates.push("updated_at = datetime('now')");
  values.push(username);

  db.run(
    `UPDATE user_reward_periods SET ${updates.join(', ')} WHERE username = ?`,
    values,
    function (uErr) {
      if (uErr) {
        console.error('❌ user_reward_periods UPDATE:', uErr.message);
        return res.status(500).json({ error: uErr.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Không tìm thấy user_reward_periods' });
      }
      db.get(`SELECT * FROM user_reward_periods WHERE username = ?`, [username], (e2, row) => {
        if (e2) return res.status(500).json({ error: e2.message });
        res.json(rowToUserRewardPeriod(row));
      });
    }
  );
});

// ------------------- user_vip_x10_params (tân thủ / VIP / x10) -------------------
app.get('/api/vip-x10-params', (req, res) => {
  db.all(`SELECT * FROM user_vip_x10_params ORDER BY username ASC`, [], (err, rows) => {
    if (err) {
      console.error('❌ user_vip_x10_params GET list:', err.message);
      return res.status(500).json({ error: err.message });
    }
    const data = (rows || []).map((r) => rowToVipX10Params(r));
    res.json({ data });
  });
});

app.get('/api/vip-x10-params/:username', (req, res) => {
  const username = String(req.params.username || '').trim();
  if (!username) {
    return res.status(400).json({ error: 'Thiếu username' });
  }
  db.get(`SELECT * FROM user_vip_x10_params WHERE username = ?`, [username], (err, row) => {
    if (err) {
      console.error('❌ user_vip_x10_params GET one:', err.message);
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Không tìm thấy user_vip_x10_params' });
    }
    res.json({ data: rowToVipX10Params(row) });
  });
});

app.put('/api/vip-x10-params/:username', (req, res) => {
  const username = String(req.params.username || '').trim();
  if (!username) {
    return res.status(400).json({ error: 'Thiếu username' });
  }
  const b = req.body || {};
  const patch = {};

  if (Object.prototype.hasOwnProperty.call(b, 'onboarding_task')) {
    const v = parseVipX10OnboardingTask(b.onboarding_task);
    if (v === null) {
      return res.status(400).json({ error: 'onboarding_task phải từ 0 đến 3' });
    }
    patch.onboarding_task = v;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'vip')) {
    const v = parseVipX10NonNegInt(b.vip);
    if (v === null) {
      return res.status(400).json({ error: 'vip phải là số nguyên >= 0' });
    }
    patch.vip = v;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'x10_total_bet')) {
    const v = parseVipX10NonNegInt(b.x10_total_bet);
    if (v === null) {
      return res.status(400).json({ error: 'x10_total_bet phải >= 0' });
    }
    patch.x10_total_bet = v;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'x10_next_reward_total_bet')) {
    const v = parseVipX10NonNegInt(b.x10_next_reward_total_bet);
    if (v === null) {
      return res.status(400).json({ error: 'x10_next_reward_total_bet phải >= 0' });
    }
    patch.x10_next_reward_total_bet = v;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Không có trường hợp lệ để cập nhật' });
  }

  db.get(`SELECT * FROM user_vip_x10_params WHERE username = ?`, [username], (err, row) => {
    if (err) {
      console.error('❌ user_vip_x10_params SELECT (PUT):', err.message);
      return res.status(500).json({ error: err.message });
    }

    if (!row) {
      const ot = patch.onboarding_task !== undefined ? patch.onboarding_task : 0;
      const vip = patch.vip !== undefined ? patch.vip : 0;
      const xt = patch.x10_total_bet !== undefined ? patch.x10_total_bet : 0;
      const xn = patch.x10_next_reward_total_bet !== undefined ? patch.x10_next_reward_total_bet : 0;
      db.run(
        `INSERT INTO user_vip_x10_params (username, onboarding_task, vip, x10_total_bet, x10_next_reward_total_bet, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [username, ot, vip, xt, xn],
        function (insErr) {
          if (insErr) {
            console.error('❌ user_vip_x10_params INSERT:', insErr.message);
            return res.status(500).json({ error: insErr.message });
          }
          db.get(`SELECT * FROM user_vip_x10_params WHERE username = ?`, [username], (e2, newRow) => {
            if (e2) return res.status(500).json({ error: e2.message });
            res.status(201).json({ ok: true, data: rowToVipX10Params(newRow) });
          });
        }
      );
      return;
    }

    const updates = [];
    const values = [];
    if (patch.onboarding_task !== undefined) {
      updates.push('onboarding_task = ?');
      values.push(patch.onboarding_task);
    }
    if (patch.vip !== undefined) {
      updates.push('vip = ?');
      values.push(patch.vip);
    }
    if (patch.x10_total_bet !== undefined) {
      updates.push('x10_total_bet = ?');
      values.push(patch.x10_total_bet);
    }
    if (patch.x10_next_reward_total_bet !== undefined) {
      updates.push('x10_next_reward_total_bet = ?');
      values.push(patch.x10_next_reward_total_bet);
    }
    updates.push("updated_at = datetime('now')");
    values.push(username);

    db.run(
      `UPDATE user_vip_x10_params SET ${updates.join(', ')} WHERE username = ?`,
      values,
      function (uErr) {
        if (uErr) {
          console.error('❌ user_vip_x10_params UPDATE:', uErr.message);
          return res.status(500).json({ error: uErr.message });
        }
        db.get(`SELECT * FROM user_vip_x10_params WHERE username = ?`, [username], (e2, newRow) => {
          if (e2) return res.status(500).json({ error: e2.message });
          res.json({ ok: true, data: rowToVipX10Params(newRow) });
        });
      }
    );
  });
});

app.delete('/api/vip-x10-params/:username', (req, res) => {
  const username = String(req.params.username || '').trim();
  if (!username) {
    return res.status(400).json({ error: 'Thiếu username' });
  }
  db.run(`DELETE FROM user_vip_x10_params WHERE username = ?`, [username], function (dErr) {
    if (dErr) {
      console.error('❌ user_vip_x10_params DELETE:', dErr.message);
      return res.status(500).json({ error: dErr.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Không tìm thấy user_vip_x10_params' });
    }
    res.json({ ok: true });
  });
});

// Cộng dồn spin_count + symbol_count + total_reward_won (tổng totalMoneyWon phiên quay) — reset theo vn_day.
app.post('/api/slot-game-daily/accumulate', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const slot_id = parseInt(req.body?.slot_id, 10);
  const delta_spin = Math.max(0, parseInt(req.body?.delta_spin ?? 0, 10));
  const delta_symbol = Math.max(0, parseInt(req.body?.delta_symbol ?? 0, 10));
  const delta_reward = Math.max(
    0,
    parseInt(req.body?.delta_reward ?? req.body?.delta_total_money_won ?? 0, 10)
  );

  if (!username || !Number.isFinite(slot_id)) {
    return res.status(400).json({ error: 'Thiếu username hoặc slot_id không hợp lệ' });
  }
  if (delta_spin === 0 && delta_symbol === 0 && delta_reward === 0) {
    return res.json({ ok: true, skipped: true });
  }

  const vn_day = dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');

  db.get(
    `SELECT * FROM slot_game_daily_stats WHERE username = ? AND slot_id = ?`,
    [username, slot_id],
    (err, row) => {
      if (err) {
        console.error('❌ slot_game_daily_stats SELECT:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (!row) {
        db.run(
          `INSERT INTO slot_game_daily_stats (username, slot_id, spin_count, symbol_count, total_reward_won, reward_claimed, vn_day, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, datetime('now'))`,
          [username, slot_id, delta_spin, delta_symbol, delta_reward, vn_day],
          function (insErr) {
            if (insErr) {
              console.error('❌ slot_game_daily_stats INSERT:', insErr.message);
              return res.status(500).json({ error: insErr.message });
            }
            return res.json({
              ok: true,
              created: true,
              spin_count: delta_spin,
              symbol_count: delta_symbol,
              total_reward_won: delta_reward,
              reward_claimed: 0,
              vn_day,
            });
          }
        );
        return;
      }

      const sameDayAcc = String(row.vn_day || '') === vn_day;
      if (sameDayAcc && Number(row.reward_claimed || 0) === 1) {
        return res.json({
          ok: true,
          blocked: true,
          reason: 'reward_claimed',
          reward_claimed: 1,
          spin_count: Number(row.spin_count || 0),
          symbol_count: Number(row.symbol_count || 0),
          total_reward_won: Number(row.total_reward_won || 0),
          vn_day,
        });
      }

      // Sang ngày VN mới: coi như reset — spin/symbol/total_reward_won/reward_claimed chỉ còn bước cộng hôm nay
      const baseSpin = sameDayAcc ? Number(row.spin_count || 0) : 0;
      const baseSym = sameDayAcc ? Number(row.symbol_count || 0) : 0;
      const baseRewardWon = sameDayAcc ? Number(row.total_reward_won || 0) : 0;
      const keepReward = sameDayAcc ? Number(row.reward_claimed || 0) : 0;

      const newSpin = baseSpin + delta_spin;
      const newSym = baseSym + delta_symbol;
      const newRewardWon = baseRewardWon + delta_reward;

      db.run(
        `UPDATE slot_game_daily_stats SET spin_count = ?, symbol_count = ?, total_reward_won = ?, reward_claimed = ?, vn_day = ?, updated_at = datetime('now') WHERE id = ?`,
        [newSpin, newSym, newRewardWon, keepReward, vn_day, row.id],
        function (uErr) {
          if (uErr) {
            console.error('❌ slot_game_daily_stats UPDATE:', uErr.message);
            return res.status(500).json({ error: uErr.message });
          }
          return res.json({
            ok: true,
            spin_count: newSpin,
            symbol_count: newSym,
            total_reward_won: newRewardWon,
            reward_claimed: keepReward,
            vn_day,
          });
        }
      );
    }
  );
});

// Ghi đè symbol_count (đồng bộ từ API nhiệm vụ ngày khi CMS cao hơn server game) — ws_slot_client Slot41
app.post('/api/slot-game-daily/set-symbol-count', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const slot_id = parseInt(req.body?.slot_id, 10);
  const symbol_count = Math.max(0, parseInt(req.body?.symbol_count ?? -1, 10));

  if (!username || !Number.isFinite(slot_id) || !Number.isFinite(symbol_count)) {
    return res.status(400).json({ error: 'Thiếu username, slot_id hoặc symbol_count không hợp lệ' });
  }

  const vn_day = dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');

  db.get(
    `SELECT * FROM slot_game_daily_stats WHERE username = ? AND slot_id = ?`,
    [username, slot_id],
    (err, row) => {
      if (err) {
        console.error('❌ slot_game_daily_stats SELECT (set-symbol):', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (!row) {
        db.run(
          `INSERT INTO slot_game_daily_stats (username, slot_id, spin_count, symbol_count, total_reward_won, reward_claimed, vn_day, updated_at)
           VALUES (?, ?, 0, ?, 0, 0, ?, datetime('now'))`,
          [username, slot_id, symbol_count, vn_day],
          function (insErr) {
            if (insErr) {
              console.error('❌ slot_game_daily_stats INSERT (set-symbol):', insErr.message);
              return res.status(500).json({ error: insErr.message });
            }
            return res.json({
              ok: true,
              created: true,
              spin_count: 0,
              symbol_count,
              total_reward_won: 0,
              reward_claimed: 0,
              vn_day,
            });
          }
        );
        return;
      }

      const sameDay = String(row.vn_day || '') === vn_day;
      const newSpin = sameDay ? Number(row.spin_count || 0) : 0;
      const newRewardSym = sameDay ? Number(row.reward_claimed || 0) : 0;
      const newTotalWon = sameDay ? Number(row.total_reward_won || 0) : 0;

      db.run(
        `UPDATE slot_game_daily_stats SET spin_count = ?, symbol_count = ?, total_reward_won = ?, reward_claimed = ?, vn_day = ?, updated_at = datetime('now') WHERE id = ?`,
        [newSpin, symbol_count, newTotalWon, newRewardSym, vn_day, row.id],
        function (uErr) {
          if (uErr) {
            console.error('❌ slot_game_daily_stats UPDATE (set-symbol):', uErr.message);
            return res.status(500).json({ error: uErr.message });
          }
          return res.json({
            ok: true,
            spin_count: newSpin,
            symbol_count,
            total_reward_won: newTotalWon,
            reward_claimed: newRewardSym,
            vn_day,
          });
        }
      );
    }
  );
});

// Đánh dấu đã nhận thưởng nhiệm vụ ngày (icon slot) — ws_slot_client sau auto_claim_missions
app.post('/api/slot-game-daily/set-reward-claimed', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const slot_id = parseInt(req.body?.slot_id, 10);
  const raw = parseInt(req.body?.reward_claimed ?? 1, 10);
  const reward_claimed = raw ? 1 : 0;

  if (!username || !Number.isFinite(slot_id)) {
    return res.status(400).json({ error: 'Thiếu username hoặc slot_id không hợp lệ' });
  }

  const vn_day = dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');

  db.get(
    `SELECT * FROM slot_game_daily_stats WHERE username = ? AND slot_id = ?`,
    [username, slot_id],
    (err, row) => {
      if (err) {
        console.error('❌ slot_game_daily_stats SELECT (set-reward):', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (!row) {
        db.run(
          `INSERT INTO slot_game_daily_stats (username, slot_id, spin_count, symbol_count, total_reward_won, reward_claimed, vn_day, updated_at)
           VALUES (?, ?, 0, 0, 0, ?, ?, datetime('now'))`,
          [username, slot_id, reward_claimed, vn_day],
          function (insErr) {
            if (insErr) {
              console.error('❌ slot_game_daily_stats INSERT (set-reward):', insErr.message);
              return res.status(500).json({ error: insErr.message });
            }
            return res.json({
              ok: true,
              created: true,
              reward_claimed,
              spin_count: 0,
              symbol_count: 0,
              total_reward_won: 0,
              vn_day,
            });
          }
        );
        return;
      }

      const sameDay = String(row.vn_day || '') === vn_day;
      const newSpin = sameDay ? Number(row.spin_count || 0) : 0;
      const newSym = sameDay ? Number(row.symbol_count || 0) : 0;
      const newTotalWon = sameDay ? Number(row.total_reward_won || 0) : 0;

      db.run(
        `UPDATE slot_game_daily_stats SET spin_count = ?, symbol_count = ?, total_reward_won = ?, reward_claimed = ?, vn_day = ?, updated_at = datetime('now') WHERE id = ?`,
        [newSpin, newSym, newTotalWon, reward_claimed, vn_day, row.id],
        function (uErr) {
          if (uErr) {
            console.error('❌ slot_game_daily_stats UPDATE (set-reward):', uErr.message);
            return res.status(500).json({ error: uErr.message });
          }
          return res.json({
            ok: true,
            reward_claimed,
            spin_count: newSpin,
            symbol_count: newSym,
            total_reward_won: newTotalWon,
            vn_day,
          });
        }
      );
    }
  );
});

// Đọc slot_game_daily_stats (vn_day VN, qua ngày mới → reward/spin/symbol coi như 0 cho client)
app.get('/api/slot-game-daily/stats', (req, res) => {
  const username = String(req.query.username || '').trim();
  const slot_id = parseInt(req.query.slot_id, 10);

  if (!username || !Number.isFinite(slot_id)) {
    return res.status(400).json({ error: 'Thiếu username hoặc slot_id' });
  }

  const vn_day = dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');

  db.get(
    `SELECT * FROM slot_game_daily_stats WHERE username = ? AND slot_id = ?`,
    [username, slot_id],
    (err, row) => {
      if (err) {
        console.error('❌ slot_game_daily_stats GET stats:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (!row) {
        return res.json({
          ok: true,
          empty: true,
          username,
          slot_id,
          vn_day,
          same_day: false,
          reward_claimed: 0,
          spin_count: 0,
          symbol_count: 0,
          total_reward_won: 0,
        });
      }
      const sameDay = String(row.vn_day || '') === vn_day;
      return res.json({
        ok: true,
        empty: false,
        username,
        slot_id,
        vn_day,
        row_vn_day: row.vn_day,
        same_day: sameDay,
        reward_claimed: sameDay ? Number(row.reward_claimed || 0) : 0,
        spin_count: sameDay ? Number(row.spin_count || 0) : 0,
        symbol_count: sameDay ? Number(row.symbol_count || 0) : 0,
        total_reward_won: sameDay ? Number(row.total_reward_won || 0) : 0,
      });
    }
  );
});

// CMS: danh sách dòng slot theo ngày VN (bảng slot_game_daily_stats)
app.get('/api/slot-game-daily/cms-list', (req, res) => {
  const rawDay = String(req.query.vn_day || req.query.date || '').trim();
  const vn_day = rawDay
    ? rawDay.slice(0, 10)
    : dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
  const usernameQ = String(req.query.username || '').trim();
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10)));
  const offset = Math.max(0, parseInt(req.query.offset || '0', 10));

  let where = 'vn_day = ?';
  const params = [vn_day];
  if (usernameQ) {
    where += ' AND instr(lower(username), lower(?)) > 0';
    params.push(usernameQ);
  }

  const countSql = `SELECT COUNT(*) AS c FROM slot_game_daily_stats WHERE ${where}`;
  const listSql = `
    SELECT id, username, slot_id, spin_count, symbol_count, total_reward_won, reward_claimed, vn_day, updated_at
    FROM slot_game_daily_stats
    WHERE ${where}
    ORDER BY username ASC, slot_id DESC
    LIMIT ? OFFSET ?
  `;

  db.get(countSql, params, (errCount, countRow) => {
    if (errCount) {
      console.error('❌ slot-game-daily cms-list COUNT:', errCount.message);
      return res.status(500).json({ ok: false, error: errCount.message });
    }
    const total = Number(countRow?.c || 0);
    db.all(listSql, [...params, limit, offset], (err, rows) => {
      if (err) {
        console.error('❌ slot-game-daily cms-list:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
      }
      const spinUnit = 100;
      const items = (rows || []).map((r) => {
        const spin = Number(r.spin_count || 0);
        const won = Number(r.total_reward_won || 0);
        const profit = won - spin * spinUnit;
        const sid = Number(r.slot_id);
        return {
          id: r.id,
          username: r.username,
          slot_id: sid,
          game_name: SLOT_PRESET_GAME_NAMES[sid] || `Slot ${sid}`,
          spin_count: spin,
          symbol_count: Number(r.symbol_count || 0),
          total_reward_won: won,
          reward_claimed: Number(r.reward_claimed || 0),
          reward_status: Number(r.reward_claimed || 0) === 1 ? 'Đã nhận' : 'Chưa nhận',
          profit,
          vn_day: r.vn_day,
          updated_at: r.updated_at,
        };
      });
      res.json({
        ok: true,
        table: 'slot_game_daily_stats',
        vn_day,
        spin_unit_cost: spinUnit,
        profit_formula: 'total_reward_won - spin_count * spin_unit_cost',
        total,
        limit,
        offset,
        items,
      });
    });
  });
});

// Lấy streak của 1 user
app.get('/api/users/:username/streak', (req, res) => {
  const sql = `
    SELECT
      up.username,
      up.streak_date,
      s.current_type AS streak_current_type,
      COALESCE(s.current_len, 0) AS streak_current_len,
      COALESCE(s.best_win_today, 0) AS streak_win_today,
      COALESCE(s.best_lose_today, 0) AS streak_lose_today
    FROM user_profiles up
    LEFT JOIN streaks s ON s.username = up.username
    WHERE up.username = ?
  `;
  db.get(sql, [req.params.username], (err, row) => {
    if (err)   return res.status(500).json({ error: "Lỗi server", detail: err.message });
    if (!row)  return res.status(404).json({ error: "Không tìm thấy user" });
    res.json(row);
  });
});

// ------------------- API: Event feed "gãy dây > 8" -------------------
app.get('/api/strategy/streak-break-events', (req, res) => {
  const afterId = Math.max(0, parseInt(req.query.after_id || '0', 10));
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '100', 10)));
  const username = String(req.query.username || '').trim();

  let items = streakBreakEvents;
  if (username) {
    items = items.filter((e) => String(e.username || '') === username);
  }

  const data = items
    .filter((e) => Number(e.id || 0) > afterId)
    .slice(0, limit);

  const lastId = data.length > 0
    ? Number(data[data.length - 1].id || afterId)
    : afterId;

  return res.json({
    ok: true,
    after_id: afterId,
    last_id: lastId,
    total: data.length,
    data,
  });
});

// ------------------- API: Claim user gãy dây > ngưỡng (server -> client cache) -------------------
app.get('/api/strategy/streak-break-claim', (req, res) => {
  const threshold = Math.max(1, parseInt(req.query.threshold || '8', 10));
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '50', 10)));
  const todayVN = dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');

  const sql = `
    SELECT
      up.username,
      up.status,
      COALESCE(s.current_type, '') AS current_type,
      COALESCE(s.current_len, 0) AS current_len,
      COALESCE(s.best_win_today, 0) AS best_win_today,
      COALESCE(s.best_lose_today, 0) AS best_lose_today,
      COALESCE(up.streak_last_alert_win, 0) AS streak_last_alert_win,
      COALESCE(up.streak_last_alert_lose, 0) AS streak_last_alert_lose,
      s.updated_at
    FROM user_profiles up
    INNER JOIN streaks s ON s.username = up.username
    WHERE up.status <> 'Hết Tiền'
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("❌ Lỗi lấy danh sách streak-break-claim:", err.message);
      return res.status(500).json({ error: "Không thể lấy danh sách streak-break-claim", detail: err.message });
    }

    const candidates = [];
    for (const row of rows || []) {
      const updatedDay = row.updated_at
        ? dayjs(row.updated_at).tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD')
        : null;
      if (updatedDay !== todayVN) continue; // Không dùng dữ liệu streak của ngày cũ

      // Gãy dây thắng > threshold: current chuyển sang lost, và best_win_today vượt ngưỡng
      const winBreakPeak = Number(row.best_win_today || 0);
      if (
        row.current_type === 'lost' &&
        winBreakPeak > threshold &&
        Number(row.streak_last_alert_win || 0) < winBreakPeak
      ) {
        candidates.push({
          username: row.username,
          status: row.status,
          break_side: 'win',
          peak_today: winBreakPeak,
          current_type: row.current_type,
          current_len: Number(row.current_len || 0),
          updated_at: row.updated_at,
        });
      }

      // Gãy dây thua > threshold: current chuyển sang won, và best_lose_today vượt ngưỡng
      const loseBreakPeak = Number(row.best_lose_today || 0);
      if (
        row.current_type === 'won' &&
        loseBreakPeak > threshold &&
        Number(row.streak_last_alert_lose || 0) < loseBreakPeak
      ) {
        candidates.push({
          username: row.username,
          status: row.status,
          break_side: 'lose',
          peak_today: loseBreakPeak,
          current_type: row.current_type,
          current_len: Number(row.current_len || 0),
          updated_at: row.updated_at,
        });
      }
    }

    candidates.sort((a, b) => {
      if (b.peak_today !== a.peak_today) return b.peak_today - a.peak_today;
      return String(a.username || '').localeCompare(String(b.username || ''));
    });

    const claimed = candidates.slice(0, limit);
    if (claimed.length === 0) {
      return res.json({
        ok: true,
        threshold,
        total: 0,
        data: [],
      });
    }

    let pending = claimed.length;
    const failedUpdates = [];
    const done = () => {
      if (pending > 0) return;
      res.json({
        ok: failedUpdates.length === 0,
        threshold,
        total: claimed.length,
        failed_updates: failedUpdates,
        data: claimed,
      });
    };

    claimed.forEach((item) => {
      const col = item.break_side === 'win' ? 'streak_last_alert_win' : 'streak_last_alert_lose';
      const sqlUpdate = `UPDATE user_profiles SET ${col} = ? WHERE username = ?`;
      db.run(sqlUpdate, [item.peak_today, item.username], function (updateErr) {
        if (updateErr) {
          failedUpdates.push({
            username: item.username,
            break_side: item.break_side,
            error: updateErr.message,
          });
        }
        pending -= 1;
        done();
      });
    });
  });
});

// ------------------- Đổi tên username an toàn (helper dùng chung) -------------------
const LC79_RENAME_USERNAME_TABLES = [
  { name: 'user_profiles', required: true },
  { name: 'accounts', required: true },
  { name: 'transaction_details', required: false },
  { name: 'deposit_orders', required: false },
  { name: 'bet_totals', required: false },
  { name: 'streaks', required: false },
  { name: 'gift_box_claims', required: false },
  { name: 'user_reward_periods', required: false },
  { name: 'user_vip_x10_params', required: false },
  { name: 'slot_game_daily_stats', required: false },
  { name: 'device_balances', required: false },
  { name: 'jackpot_session_records', required: false },
];

/**
 * Đổi username trên toàn bộ bảng LC79 liên quan.
 * callback(err, result) — err có thể có .status (400/409/500)
 */
function renameLc79Username(oldUsername, newUsername, callback) {
  const oldU = String(oldUsername || '').trim();
  const newU = String(newUsername || '').trim();

  if (!oldU || !newU) {
    const err = new Error('Thiếu oldUsername hoặc newUsername');
    err.status = 400;
    return callback(err);
  }
  if (oldU === newU) {
    return callback(null, {
      skipped: true,
      success: true,
      totalUpdated: 0,
      oldUsername: oldU,
      newUsername: newU,
      updates: [],
    });
  }

  db.get(
    `SELECT username FROM (
       SELECT username FROM user_profiles WHERE username = ?
       UNION
       SELECT username FROM accounts WHERE username = ?
     ) LIMIT 1`,
    [newU, newU],
    (err, row) => {
      if (err) {
        const e = new Error('Lỗi kiểm tra username: ' + err.message);
        e.status = 500;
        return callback(e);
      }
      if (row) {
        const e = new Error(`Username "${newU}" đã tồn tại`);
        e.status = 409;
        return callback(e);
      }

      db.serialize(() => {
        db.run('BEGIN TRANSACTION', (beginErr) => {
          if (beginErr) {
            const e = new Error('Không thể bắt đầu transaction: ' + beginErr.message);
            e.status = 500;
            return callback(e);
          }

          let totalUpdated = 0;
          const updates = [];
          const errors = [];
          let completed = 0;
          const tables = LC79_RENAME_USERNAME_TABLES;

          tables.forEach((table) => {
            db.run(
              `UPDATE ${table.name} SET username = ? WHERE username = ?`,
              [newU, oldU],
              function (updErr) {
                if (updErr) {
                  if (table.required || !String(updErr.message || '').includes('no such table')) {
                    errors.push(`${table.name}: ${updErr.message}`);
                  }
                } else {
                  const changes = this.changes || 0;
                  if (changes > 0) {
                    updates.push(`${table.name}: ${changes} row(s)`);
                    totalUpdated += changes;
                  }
                }

                completed += 1;
                if (completed !== tables.length) return;

                if (errors.length > 0) {
                  return db.run('ROLLBACK', () => {
                    console.error(`❌ Rollback đổi username: ${errors.join(', ')}`);
                    const e = new Error(errors.join('; '));
                    e.status = 500;
                    e.details = errors;
                    callback(e);
                  });
                }

                db.run('COMMIT', (commitErr) => {
                  if (commitErr) {
                    const e = new Error('Lỗi commit: ' + commitErr.message);
                    e.status = 500;
                    return callback(e);
                  }
                  console.log(`✅ Đổi username: ${oldU} → ${newU} (${totalUpdated} records)`);
                  if (updates.length) console.log(`   Chi tiết: ${updates.join(', ')}`);
                  callback(null, {
                    success: true,
                    totalUpdated,
                    oldUsername: oldU,
                    newUsername: newU,
                    updates,
                  });
                });
              }
            );
          });
        });
      });
    }
  );
}

app.post('/api/users/rename', (req, res) => {
  const { oldUsername, newUsername } = req.body || {};
  renameLc79Username(oldUsername, newUsername, (err, result) => {
    if (err) {
      return res.status(err.status || 500).json({
        success: false,
        error: err.message,
        details: err.details,
      });
    }
    res.json(result);
  });
});

// ------------------- Xoá user -------------------
app.delete('/api/users/:username', (req, res) => {
  const username = req.params.username;
  const sql = `DELETE FROM user_profiles WHERE username = ?`;

  db.run(sql, [username], function (err) {
    if (err) {
      console.error("❌ Lỗi khi xoá user:", err.message);
      return res.status(500).json({ error: "Không thể xoá user" });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: "Không tìm thấy user" });
    }
    res.json({ success: true });
  });
});
// ------------------- Lấy 1 tài khoản theo username -------------------
app.get('/api/accounts/:username', (req, res) => {
  const sql = `
    SELECT a.*, p.nickname AS nickname, p.proxy AS proxy
    FROM accounts a
    LEFT JOIN user_profiles p ON p.username = a.username
    WHERE a.username = ?
  `;
  db.get(sql, [req.params.username], (err, row) => {
    if (err) {
      console.error("❌ Lỗi khi lấy tài khoản:", err.message);
      return res.status(500).json({ error: "Lỗi server" });
    }
    if (!row) return res.status(404).json({ error: "Không tìm thấy tài khoản" });
    res.json(row);
  });
});

// ------------------- Cập nhật tài khoản theo username -------------------
app.put('/api/accounts/:username', (req, res) => {
  const oldUsername = String(req.params.username || '').trim();
  const fields = req.body || {};
  const requestedUsername = Object.prototype.hasOwnProperty.call(fields, 'username')
    ? String(fields.username || '').trim()
    : oldUsername;
  const hasNickname = Object.prototype.hasOwnProperty.call(fields, 'nickname');
  const nicknameVal = fields.nickname;
  const hasProxy = Object.prototype.hasOwnProperty.call(fields, 'proxy');
  const proxyVal = String(fields.proxy || '').trim();
  const hasProfileDevice = Object.prototype.hasOwnProperty.call(fields, 'device');
  const profileDeviceVal = fields.device;

  const applyAccountUpdate = (username) => {
    const updates = [];
    const values = [];
    for (const key in fields) {
      if (key === 'nickname' || key === 'username') continue;
      if (["game","loginPass","phone","withdrawPass","bank","accountNumber","accountHolder","device","totalDeposit","totalWithdraw","totalBet","currentBet","status","uuid"].includes(key)) {
        updates.push(`${key} = ?`);
        values.push(fields[key]);
      }
    }
    values.push(username);

    const syncUserProfile = (cb) => {
      const profileUpdates = [];
      const profileVals = [];
      if (hasNickname) {
        profileUpdates.push('nickname = ?');
        profileVals.push(nicknameVal || null);
      }
      if (hasProxy) {
        profileUpdates.push('proxy = ?');
        profileVals.push(proxyVal || null);
      }
      if (hasProfileDevice) {
        profileUpdates.push('device = ?');
        profileVals.push(profileDeviceVal || '');
      }
      if (!profileUpdates.length) return cb();
      profileVals.push(username);
      db.run(
        `UPDATE user_profiles SET ${profileUpdates.join(', ')} WHERE username = ?`,
        profileVals,
        (errNick) => {
          if (errNick) {
            console.error("❌ Lỗi khi đồng bộ UserProfile:", errNick.message);
            return res.status(500).json({ error: "Không thể cập nhật user profile" });
          }
          cb();
        }
      );
    };

    const respondMerged = () => {
      db.get(
        `
        SELECT a.*, p.nickname AS nickname, p.proxy AS proxy
        FROM accounts a
        LEFT JOIN user_profiles p ON p.username = a.username
        WHERE a.username = ?
        `,
        [username],
        (err3, row) => {
          if (err3) {
            return res.status(500).json({ error: "Lỗi khi lấy tài khoản sau update" });
          }
          res.json(row);
        }
      );
    };

    if (updates.length === 0) {
      if (!hasNickname && !hasProxy && !hasProfileDevice) {
        // Chỉ đổi username (đã rename) — vẫn trả bản ghi hiện tại
        return respondMerged();
      }
      return syncUserProfile(() => respondMerged());
    }

    const sql = `UPDATE accounts SET ${updates.join(", ")} WHERE username = ?`;

    db.run(sql, values, function (err) {
      if (err) {
        console.error("❌ Lỗi khi cập nhật tài khoản:", err.message);
        return res.status(500).json({ error: "Không thể cập nhật tài khoản" });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: "Không tìm thấy tài khoản" });
      }

      if (typeof fields.status !== "undefined") {
        const sqlUser = `UPDATE user_profiles SET status = ? WHERE username = ?`;
        db.run(sqlUser, [fields.status, username], (err2) => {
          if (err2) {
            console.error("❌ Lỗi khi đồng bộ status sang UserProfile:", err2.message);
          }
        });
      }

      syncUserProfile(() => respondMerged());
    });
  };

  if (requestedUsername && requestedUsername !== oldUsername) {
    return renameLc79Username(oldUsername, requestedUsername, (renameErr) => {
      if (renameErr) {
        return res.status(renameErr.status || 500).json({ error: renameErr.message });
      }
      applyAccountUpdate(requestedUsername);
    });
  }

  applyAccountUpdate(oldUsername);
});

// ------------------- Xóa tài khoản theo username -------------------
// Đồng thời xoá user_profiles + bet_totals (cùng username). Transaction: lỗi giữa chừng → rollback hết.
app.delete('/api/accounts/:username', (req, res) => {
  const username = req.params.username;

  db.serialize(() => {
    db.run('BEGIN TRANSACTION', (beginErr) => {
      if (beginErr) {
        console.error('❌ BEGIN TRANSACTION:', beginErr.message);
        return res.status(500).json({ error: 'Không thể bắt đầu transaction' });
      }

      db.run(`DELETE FROM accounts WHERE username = ?`, [username], function (err) {
        if (err) {
          return db.run('ROLLBACK', () => {
            console.error('❌ Lỗi khi xoá accounts:', err.message);
            res.status(500).json({ error: 'Không thể xoá tài khoản', detail: err.message });
          });
        }
        if (this.changes === 0) {
          return db.run('ROLLBACK', () => {
            res.status(404).json({ error: 'Không tìm thấy tài khoản' });
          });
        }

        const deletedAccounts = this.changes;

        db.run(`DELETE FROM user_profiles WHERE username = ?`, [username], function (err2) {
          if (err2) {
            return db.run('ROLLBACK', () => {
              console.error('❌ Lỗi khi xoá user_profiles:', err2.message);
              res.status(500).json({
                error: 'Lỗi khi xoá user_profiles (accounts đã rollback)',
                detail: err2.message,
              });
            });
          }
          const deletedProfiles = this.changes;

          db.run(`DELETE FROM bet_totals WHERE username = ?`, [username], function (err3) {
            if (err3) {
              return db.run('ROLLBACK', () => {
                console.error('❌ Lỗi khi xoá bet_totals:', err3.message);
                res.status(500).json({
                  error: 'Lỗi khi xoá bet_totals (đã rollback)',
                  detail: err3.message,
                });
              });
            }
            const deletedBetTotals = this.changes;

            db.run('COMMIT', (commitErr) => {
              if (commitErr) {
                console.error('❌ COMMIT:', commitErr.message);
                return res.status(500).json({ error: 'Lỗi commit', detail: commitErr.message });
              }
              res.json({
                success: true,
                deleted: {
                  accounts: deletedAccounts,
                  user_profiles: deletedProfiles,
                  bet_totals: deletedBetTotals,
                },
              });
            });
          });
        });
      });
    });
  });
});
// ------------------- Gán thiết bị cho tài khoản -------------------
app.post('/api/accounts/device', (req, res) => {
  const { username, device } = req.body;
  const sql = `UPDATE accounts SET device = ? WHERE username = ?`;
  db.run(sql, [device, username], function (err) {
    if (err) {
      console.error("❌ Lỗi khi gán thiết bị:", err.message);
      return res.status(500).json({ error: "Không thể gán thiết bị" });
    }
    if (this.changes === 0) return res.status(404).json({ error: "Không tìm thấy tài khoản" });

    db.get(`SELECT * FROM accounts WHERE username = ?`, [username], (err2, row) => {
      if (err2) return res.status(500).json({ error: "Lỗi khi lấy account sau update" });
      res.json(row);
    });
  });
});

// ------------------- Cập nhật số tiền đã cược hiện tại (currentBet) -------------------
app.post('/api/accounts/currentBet', (req, res) => {
  const { username, currentBet } = req.body;
  const sql = `UPDATE accounts SET currentBet = ? WHERE username = ?`;
  db.run(sql, [currentBet, username], function (err) {
    if (err) {
      console.error("❌ Lỗi khi cập nhật currentBet:", err.message);
      return res.status(500).json({ error: "Không thể cập nhật currentBet" });
    }
    if (this.changes === 0) return res.status(404).json({ error: "Không tìm thấy tài khoản" });

    db.get(`SELECT * FROM accounts WHERE username = ?`, [username], (err2, row) => {
      if (err2) return res.status(500).json({ error: "Lỗi khi lấy account sau update" });
      res.json(row);
    });
  });
});

// ------------------- Cập nhật tổng cược (totalBet) -------------------
app.post('/api/accounts/totalBet', (req, res) => {
  const { username, amount } = req.body;
  const sql = `UPDATE accounts SET totalBet = ? WHERE username = ?`;
  db.run(sql, [amount, username], function (err) {
    if (err) {
      console.error("❌ Lỗi khi cập nhật totalBet:", err.message);
      return res.status(500).json({ error: "Không thể cập nhật totalBet" });
    }
    if (this.changes === 0) return res.status(404).json({ error: "Không tìm thấy tài khoản" });

    db.get(`SELECT * FROM accounts WHERE username = ?`, [username], (err2, row) => {
      if (err2) return res.status(500).json({ error: "Lỗi khi lấy account sau update" });
      res.json(row);
    });
  });
});

// ------------------- Cập nhật trạng thái tài khoản -------------------
app.post('/api/accounts/status', (req, res) => {
  const { username, status } = req.body;

  const sqlAcc = `UPDATE accounts SET status = ? WHERE username = ?`;
  db.run(sqlAcc, [status, username], function (err) {
    if (err) {
      console.error("❌ Lỗi khi cập nhật trạng thái Account:", err.message);
      return res.status(500).json({ error: "Không thể cập nhật trạng thái account" });
    }

    // đồng bộ UserProfile
    const sqlProfile = `UPDATE user_profiles SET status = ? WHERE username = ?`;
    db.run(sqlProfile, [status, username], function (err2) {
      if (err2) {
        console.error("❌ Lỗi khi cập nhật trạng thái UserProfile:", err2.message);
      }

      // lấy lại dữ liệu account + profile
      db.get(`SELECT * FROM accounts WHERE username = ?`, [username], (err3, accRow) => {
        if (err3) return res.status(500).json({ error: "Lỗi khi lấy account sau update" });

        db.get(`SELECT * FROM user_profiles WHERE username = ?`, [username], (err4, profileRow) => {
          if (err4) return res.status(500).json({ error: "Lỗi khi lấy profile sau update" });

          res.json({ account: accRow, profile: profileRow });
        });
      });
    });
  });
});
// ------------------- Đồng bộ UserProfiles -------------------
app.post('/api/sync-users', (req, res) => {
  const sqlAcc = `SELECT * FROM accounts`;

  db.all(sqlAcc, [], (err, accounts) => {
    if (err) {
      console.error("❌ Lỗi lấy accounts:", err.message);
      return res.status(500).json({ error: "Không thể lấy accounts" });
    }

    const results = [];
    let pending = accounts.length;
    if (pending === 0) return res.json({ success: true, synced: [] });

    accounts.forEach(acc => {
      db.get(`SELECT * FROM user_profiles WHERE username = ?`, [acc.username], (err2, row) => {
        if (err2) {
          console.error("❌ Lỗi khi kiểm tra user_profiles:", err2.message);
        }
        if (!row) {
          const sqlInsert = `INSERT INTO user_profiles (username, status, device, balance) VALUES (?, ?, ?, ?)`;
          db.run(sqlInsert, [acc.username, acc.status || "Mới Tạo", acc.device || "", 0], function (err3) {
            if (err3) {
              console.error("❌ Lỗi khi thêm user_profiles:", err3.message);
            }
            results.push({ username: acc.username, created: true });
            if (--pending === 0) res.json({ success: true, synced: results });
          });
        } else {
          results.push({ username: acc.username, created: false });
          if (--pending === 0) res.json({ success: true, synced: results });
        }
      });
    });
  });
});
// ------------------- Cộng thêm tiền nạp cho tài khoản -------------------
app.post('/api/accounts/deposit', (req, res) => {
  const { username, amount, fromDevice } = req.body;

  if (!username || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'username hoặc amount không hợp lệ' });
  }

  const numericAmount = Number(amount);

  // cập nhật totalDeposit
  const sqlUpdateAcc = `UPDATE accounts SET totalDeposit = totalDeposit + ? WHERE username = ?`;
  db.run(sqlUpdateAcc, [numericAmount, username], function (err) {
    if (err) {
      console.error("❌ Lỗi khi cập nhật deposit:", err.message);
      return res.status(500).json({ error: 'Không thể cập nhật deposit' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
    }

    // thêm TransactionDetail (thay cho Transaction mongoose)
    const sqlInsertTxn = `INSERT INTO transaction_details (username, hinhThuc, transactionId, amount, time, db_time, deviceNap, status) 
                          VALUES (?, 'Nạp tiền', ?, ?, datetime('now'), datetime('now','localtime'), ?, ?)`;
    const txnId = `TXN_${Date.now()}`;
    db.run(sqlInsertTxn, [username, txnId, numericAmount, fromDevice || "", "pending"], (err2) => {
      if (err2) {
        console.error("❌ Lỗi khi thêm TransactionDetail:", err2.message);
      }
    });

    // trừ tiền DeviceBalance nếu có fromDevice
    if (fromDevice) {
      const sqlUpdateDevice = `UPDATE device_balances 
                               SET balance = balance - ?, updatedAt = datetime('now') 
                               WHERE device = ?`;
      db.run(sqlUpdateDevice, [numericAmount, fromDevice], (err3) => {
        if (err3) {
          console.error("❌ Lỗi khi trừ DeviceBalance:", err3.message);
        }
      });
    }

    // trả về account sau khi update
    db.get(`SELECT * FROM accounts WHERE username = ?`, [username], (err4, row) => {
      if (err4) return res.status(500).json({ error: "Lỗi khi lấy account sau deposit" });
      res.json(row);
    });
  });
});
// ------------------- Đồng bộ UserProfiles chỉ cho game LC79 -------------------
app.post('/api/sync-users/lc79', (req, res) => {
  const sqlAcc = `SELECT * FROM accounts WHERE game = 'LC79'`;

  db.all(sqlAcc, [], (err, accounts) => {
    if (err) {
      console.error("❌ Lỗi lấy accounts LC79:", err.message);
      return res.status(500).json({ error: "Không thể lấy accounts LC79" });
    }

    const results = [];
    let pending = accounts.length;
    if (pending === 0) return res.json({ success: true, synced: [] });

    accounts.forEach(acc => {
      db.get(`SELECT * FROM user_profiles WHERE username = ?`, [acc.username], (err2, row) => {
        if (err2) {
          console.error("❌ Lỗi khi kiểm tra user_profiles:", err2.message);
        }
        if (!row) {
          const sqlInsert = `INSERT INTO user_profiles (username, nickname, status, device, balance) VALUES (?, ?, ?, ?, ?)`;
          db.run(sqlInsert, [acc.username, "", acc.status || "Mới Tạo", acc.device || "", 0], function (err3) {
            if (err3) {
              console.error("❌ Lỗi khi thêm user_profiles LC79:", err3.message);
            }
            results.push({ username: acc.username, created: true });
            if (--pending === 0) res.json({ success: true, synced: results });
          });
        } else {
          results.push({ username: acc.username, created: false });
          if (--pending === 0) res.json({ success: true, synced: results });
        }
      });
    });
  });
});
// ------------------- Cộng thêm tiền rút của tài khoản -------------------
app.post('/api/accounts/withdraw', (req, res) => {
  const { username, amount } = req.body;

  if (!username || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'username hoặc amount không hợp lệ' });
  }

  const numericAmount = Number(amount);

  // 1️⃣ Cập nhật tổng rút trong bảng accounts
  const sqlUpdateAcc = `UPDATE accounts SET totalWithdraw = totalWithdraw + ? WHERE username = ?`;
  db.run(sqlUpdateAcc, [numericAmount, username], function (err) {
    if (err) {
      console.error("❌ Lỗi khi cập nhật withdraw:", err.message);
      return res.status(500).json({ error: 'Không thể cập nhật withdraw' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
    }

    // 2️⃣ Lấy thông tin account để dùng cho Transaction + DeviceBalance
    db.get(`SELECT * FROM accounts WHERE username = ?`, [username], (err2, acc) => {
      if (err2) {
        return res.status(500).json({ error: "Lỗi khi lấy account" });
      }

      // 3️⃣ Thêm TransactionDetail (ghi lại giao dịch)
      const txnId = `TXN_${Date.now()}`;
      const sqlInsertTxn = `INSERT INTO transaction_details 
        (username, hinhThuc, transactionId, amount, time, db_time, deviceNap, status) 
        VALUES (?, 'Rút tiền', ?, ?, datetime('now'), datetime('now','localtime'), ?, ?)`;
      db.run(sqlInsertTxn, [username, txnId, numericAmount, acc.device || "", "pending"], (err3) => {
        if (err3) {
          console.error("❌ Lỗi khi thêm TransactionDetail:", err3.message);
        }
      });

      // 4️⃣ Trả kết quả account sau khi update
      db.get(`SELECT * FROM accounts WHERE username = ?`, [username], (err7, updatedAcc) => {
        if (err7) {
          return res.status(500).json({ error: "Lỗi khi lấy account sau withdraw" });
        }
        res.json(updatedAcc);
      });
    });
  });
});
// ------------------- Báo cáo thiết bị từ máy con -------------------
app.post('/api/devices/report', (req, res) => {
  const { hostname, devices } = req.body;
  const ip = req.ip.replace('::ffff:', '');

  if (!hostname || !devices) {
    return res.status(400).json({ error: "Thiếu hostname hoặc devices" });
  }

  // Kiểm tra xem đã có hostname chưa
  db.get(`SELECT * FROM device_reports WHERE hostname = ?`, [hostname], (err, row) => {
    if (err) {
      console.error("❌ Lỗi khi kiểm tra device_reports:", err.message);
      return res.status(500).json({ error: "Lỗi server" });
    }

    const now = new Date().toISOString();
    if (row) {
      // Update
      const sqlUpdate = `UPDATE device_reports 
                         SET ip = ?, devices = ?, last_seen = ? 
                         WHERE hostname = ?`;
      db.run(sqlUpdate, [ip, JSON.stringify(devices), now, hostname], function (err2) {
        if (err2) {
          console.error("❌ Lỗi khi update device_reports:", err2.message);
          return res.status(500).json({ error: "Không thể cập nhật report" });
        }
        res.json({ ok: true, report: { hostname, ip, devices, last_seen: now } });
      });
    } else {
      // Insert mới
      const sqlInsert = `INSERT INTO device_reports (hostname, ip, devices, last_seen) VALUES (?, ?, ?, ?)`;
      db.run(sqlInsert, [hostname, ip, JSON.stringify(devices), now], function (err3) {
        if (err3) {
          console.error("❌ Lỗi khi insert device_reports:", err3.message);
          return res.status(500).json({ error: "Không thể thêm report" });
        }
        res.json({ ok: true, report: { hostname, ip, devices, last_seen: now } });
      });
    }
  });
});
// ------------------- Lấy danh sách tất cả thiết bị đã báo cáo -------------------
app.get('/api/devices/all', (req, res) => {
  const sql = `SELECT * FROM device_reports`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error("❌ Lỗi khi lấy devices:", err.message);
      return res.status(500).json({ error: "Lỗi server" });
    }

    // parse devices JSON trước khi trả về
    const result = rows.map(r => ({
      ...r,
      devices: r.devices ? JSON.parse(r.devices) : []
    }));

    res.json(result);
  });
});
// ✅ Tổng nạp trong ngày (theo giờ Việt Nam)
app.get('/api/transactions/summary/day', (req, res) => {
  // 🕒 Giờ Việt Nam
  const startOfDayVN = dayjs().tz('Asia/Ho_Chi_Minh').startOf('day').format("YYYY-MM-DD HH:mm:ss");
  const endOfDayVN = dayjs().tz('Asia/Ho_Chi_Minh').endOf('day').format("YYYY-MM-DD HH:mm:ss");

  // 🔍 Query trực tiếp theo giờ VN vì DB lưu giờ VN
  const sql = `
    SELECT SUM(amount) as totalToday 
    FROM transaction_details 
    WHERE hinhThuc = 'Nạp tiền' 
      AND ${TXN_EFFECTIVE_TIME_SQL} BETWEEN datetime(?) AND datetime(?)
  `;

  db.get(sql, [startOfDayVN, endOfDayVN], (err, row) => {
    if (err) {
      console.error("❌ Lỗi khi tính tổng nạp ngày:", err.message);
      return res.status(500).json({ error: "Lỗi server" });
    }
    res.json({
      totalToday: row?.totalToday || 0,
      range: [startOfDayVN, endOfDayVN]
    });
  });
});

// ------------------- Lấy toàn bộ giao dịch (có phân trang) -------------------
app.get('/api/transactions/all', (req, res) => {
  const page = parseInt(req.query.page) || 1;    // trang hiện tại
  const limit = parseInt(req.query.limit) || 20; // số dòng mỗi trang
  const max = parseInt(req.query.max) || 0;      // giới hạn tổng số bản ghi nếu cần
  const username = (req.query.username || '').trim();
  const type = (req.query.type || '').trim();
  const offset = (page - 1) * limit;

  const conditions = [];
  const whereParams = [];
  if (username) {
    conditions.push('username = ?');
    whereParams.push(username);
  }
  if (type) {
    conditions.push('hinhThuc = ?');
    whereParams.push(type);
  }
  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // 1️⃣ Đếm tổng số bản ghi
  const sqlCount = max > 0
    ? `SELECT COUNT(*) as total FROM (SELECT 1 FROM transaction_details ${whereSql} ORDER BY time DESC LIMIT ?)`
    : `SELECT COUNT(*) as total FROM transaction_details ${whereSql}`;
  const countParams = max > 0 ? [...whereParams, max] : [...whereParams];
  db.get(sqlCount, countParams, (err, countRow) => {
    if (err) {
      console.error("❌ Lỗi khi đếm giao dịch:", err.message);
      return res.status(500).json({ error: "Lỗi server" });
    }

    const total = countRow.total;
    const effectiveLimit = max > 0 ? Math.min(limit, Math.max(0, max - offset)) : limit;
    if (effectiveLimit <= 0) {
      return res.json({
        page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        data: []
      });
    }

    // 2️⃣ Lấy dữ liệu theo trang (🆕 thêm transactionId)
    const sqlData = `SELECT username, deviceNap AS device, hinhThuc AS type, amount, time, db_time, transactionId, status
                     FROM transaction_details
                     ${whereSql}
                     ORDER BY db_time DESC, time DESC
                     LIMIT ? OFFSET ?`;

    db.all(sqlData, [...whereParams, effectiveLimit, offset], (err2, rows) => {
      if (err2) {
        console.error("❌ Lỗi khi lấy giao dịch:", err2.message);
        return res.status(500).json({ error: "Lỗi server" });
      }

      // 3️⃣ Format lại time theo giờ VN
      const result = rows.map(t => ({
        username: t.username,
        device: t.device,
        type: t.type,
        amount: t.amount,
        transactionId: t.transactionId,   // 🆕 trả thêm mã giao dịch
        status: t.status,
        time: dayjs(t.time).tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD HH:mm:ss'),
        dbTime: t.db_time ? dayjs(t.db_time).tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD HH:mm:ss') : null
      }));

      res.json({
        page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        data: result
      });
    });
  });
});

// Trạng thái lệnh rút coi là đang chờ xử lý (CMS + game sync)
const PENDING_WITHDRAW_STATUSES = [
  'pending',
  'Chờ xử lý',
  'Đang xử lý',
  'Đang sử lý',
];

// ------------------- Lấy danh sách lệnh rút đang chờ (chi tiết) -------------------
app.get('/api/withdrawals/pending', (req, res) => {
  const placeholders = PENDING_WITHDRAW_STATUSES.map(() => '?').join(', ');
  const sql = `
    SELECT
      username,
      transactionId,
      amount,
      status,
      time,
      db_time AS dbTime
    FROM transaction_details
    WHERE hinhThuc = 'Rút tiền'
      AND status IN (${placeholders})
    ORDER BY db_time DESC, time DESC
  `;

  db.all(sql, PENDING_WITHDRAW_STATUSES, (err, rows) => {
    if (err) {
      console.error("❌ Lỗi khi lấy lệnh rút chờ xử lý:", err.message);
      return res.status(500).json({ error: "Lỗi server" });
    }

    const result = (rows || []).map(r => ({
      username: r.username,
      transactionId: r.transactionId,
      amount: r.amount,
      status: r.status,
      time: r.time,
      dbTime: r.dbTime,
    }));

    res.json(result);
  });
});

// ------------------- Lấy danh sách user đang chờ rút tiền -------------------
app.get('/api/withdrawals/pending-users', (req, res) => {
  const placeholders = PENDING_WITHDRAW_STATUSES.map(() => '?').join(', ');
  const sql = `
    SELECT 
      username,
      COUNT(*) as pendingCount,
      SUM(amount) as pendingAmount,
      MAX(db_time) as lastDbTime,
      MAX(time) as lastTime
    FROM transaction_details
    WHERE hinhThuc = 'Rút tiền'
      AND status IN (${placeholders})
    GROUP BY username
    ORDER BY lastDbTime DESC, lastTime DESC
  `;

  db.all(sql, PENDING_WITHDRAW_STATUSES, (err, rows) => {
    if (err) {
      console.error("❌ Lỗi khi lấy danh sách chờ rút:", err.message);
      return res.status(500).json({ error: "Lỗi server" });
    }

    const result = (rows || []).map(r => r.username);

    res.json(result);
  });
});
// Cập nhật Proxy
app.post('/api/users/proxy', (req,res)=>{
  const { username, proxy } = req.body;
  const sql = `UPDATE user_profiles SET proxy=? WHERE username=?`;
  db.run(sql, [proxy, username], function(err){
    if (err) {
      console.error("❌ Lỗi khi cập nhật proxy:", err.message);
      return res.status(500).json({error: "Không thể cập nhật proxy"});
    }
    res.json({ok:true, changes: this.changes});
  });
});

// Cập nhật AccessToken
app.post('/api/users/accessToken', (req,res)=>{
  const { username, accessToken } = req.body;
  const sql = `UPDATE user_profiles SET accessToken=? WHERE username=?`;
  db.run(sql, [accessToken, username], function(err){
    if (err) {
      console.error("❌ Lỗi khi cập nhật accessToken:", err.message);
      return res.status(500).json({error: "Không thể cập nhật accessToken"});
    }
    res.json({ok:true, changes: this.changes});
  });
});

// ------------------- API: Lưu lịch sử cược (đã tắt — bảng bet_history đã gỡ) -------------------
app.post("/api/bet-history", (req, res) => {
  res.status(410).json({
    error: "bet_history đã ngừng. Không lưu lịch sử cược qua API này nữa.",
  });
});





app.post('/api/force-check', async (req, res) => {
  try {
    const r = await fetch('http://127.0.0.1:5006/api/force-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });

    const text = await r.text(); // đọc dạng text trước

    // 🧠 Thử parse JSON
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error('⚠️ Response không phải JSON:', text.slice(0, 200));
      return res.status(500).json({
        error: 'Python trả về không phải JSON',
        raw: text.slice(0, 500)
      });
    }

    res.status(r.status).json(data);

  } catch (err) {
    console.error('❌ Proxy lỗi:', err);
    res.status(500).json({
      error: 'Không gọi được API Python',
      detail: err.message
    });
  }
});


//  ------------------- Thống kê tổng cược theo game (LC79) -------------------
app.get("/api/bet-history/stats/lc79", (req, res) => {
  // 🕐 Lấy thời gian hiện tại theo VN
  const nowVN = dayjs().tz("Asia/Ho_Chi_Minh");

  // ===== Ngày =====
  const startOfDayUTC = nowVN.startOf("day").utc().format("YYYY-MM-DD HH:mm:ss");
  const endOfDayUTC = nowVN.endOf("day").utc().format("YYYY-MM-DD HH:mm:ss");

  // ===== Tuần (CN -> T7) =====
  const dow = nowVN.day(); // 0 = CN
  const startOfWeekVN = nowVN.subtract(dow, "day").startOf("day");
  const endOfWeekVN = startOfWeekVN.add(7, "day").endOf("day");
  const startOfWeekUTC = startOfWeekVN.utc().format("YYYY-MM-DD HH:mm:ss");
  const endOfWeekUTC = endOfWeekVN.utc().format("YYYY-MM-DD HH:mm:ss");

  // ===== Tháng (30 -> 29) =====
  let startOfMonthUTC, endOfMonthUTC;
  if (nowVN.date() >= 30) {
    const startVN = nowVN.date(30).startOf("day");
    const endVN = nowVN.add(1, "month").date(29).endOf("day");
    startOfMonthUTC = startVN.utc().format("YYYY-MM-DD HH:mm:ss");
    endOfMonthUTC = endVN.utc().format("YYYY-MM-DD HH:mm:ss");
  } else {
    const startVN = nowVN.subtract(1, "month").date(30).startOf("day");
    const endVN = nowVN.date(29).endOf("day");
    startOfMonthUTC = startVN.utc().format("YYYY-MM-DD HH:mm:ss");
    endOfMonthUTC = endVN.utc().format("YYYY-MM-DD HH:mm:ss");
  }

  // bet_history đã gỡ — luôn trả 0 (giữ shape API cho giao diện cũ)
  res.json({
    game: "LC79",
    totalDay: 0,
    totalWeek: 0,
    totalMonth: 0,
    range: {
      day: [startOfDayUTC, endOfDayUTC],
      week: [startOfWeekUTC, endOfWeekUTC],
      month: [startOfMonthUTC, endOfMonthUTC],
    },
  });
});


// ------------------- Thống kê tổng cược theo user (LC79) -------------------
// ------------------- Thống kê tổng cược theo user (LC79) + TOTAL ALL -------------------
app.get("/api/bet-history/stats/lc79/users", (req, res) => {
  const nowVN = dayjs().tz("Asia/Ho_Chi_Minh");

  const startOfDayUTC = nowVN.startOf("day").utc().format("YYYY-MM-DD HH:mm:ss");
  const endOfDayUTC   = nowVN.endOf("day").utc().format("YYYY-MM-DD HH:mm:ss");

  const dow = nowVN.day(); // 0 = CN
  const startOfWeekVN = nowVN.subtract(dow, "day").startOf("day");
  const endOfWeekVN   = startOfWeekVN.add(7, "day").endOf("day");
  const startOfWeekUTC = startOfWeekVN.utc().format("YYYY-MM-DD HH:mm:ss");
  const endOfWeekUTC   = endOfWeekVN.utc().format("YYYY-MM-DD HH:mm:ss");

  let startOfMonthUTC, endOfMonthUTC;
  if (nowVN.date() >= 30) {
    const startVN = nowVN.date(30).startOf("day");
    const endVN   = nowVN.add(1, "month").date(29).endOf("day");
    startOfMonthUTC = startVN.utc().format("YYYY-MM-DD HH:mm:ss");
    endOfMonthUTC   = endVN.utc().format("YYYY-MM-DD HH:mm:ss");
  } else {
    const startVN = nowVN.subtract(1, "month").date(30).startOf("day");
    const endVN   = nowVN.date(29).endOf("day");
    startOfMonthUTC = startVN.utc().format("YYYY-MM-DD HH:mm:ss");
    endOfMonthUTC   = endVN.utc().format("YYYY-MM-DD HH:mm:ss");
  }

  // bet_history đã gỡ — danh sách account LC79 với tổng cược = 0
  db.all(
    `SELECT username FROM accounts WHERE game = 'LC79' ORDER BY id ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const stats = (rows || []).map((r) => ({
        username: r.username,
        totalDay: 0,
        totalWeek: 0,
        totalMonth: 0,
        totalAll: 0,
      }));
      res.json({
        game: "LC79",
        stats,
        range: {
          day: [startOfDayUTC, endOfDayUTC],
          week: [startOfWeekUTC, endOfWeekUTC],
          month: [startOfMonthUTC, endOfMonthUTC],
        },
      });
    }
  );
});


// ------------------- Lấy lịch sử cược (bet_history đã gỡ) -------------------
app.get('/api/bet-history', (req, res) => {
  res.json([]);
});

// ------------------- Thống kê giao dịch (nạp/rút) theo ngày, tuần, tất cả -------------------
app.get('/api/transactions/stats', (req, res) => {
  const nowVN = dayjs().tz('Asia/Ho_Chi_Minh');

  // ===== Ngày (VN) =====
  const startOfDayUTC = nowVN.startOf('day').utc().format("YYYY-MM-DD HH:mm:ss");

  // ===== Tuần (Thứ 7 → Thứ 6) =====
  const dow = nowVN.day(); // 0 = CN, 6 = T7
  const daysSinceSaturday = (dow >= 6 ? dow - 6 : dow + 1);
  const startOfWeekUTC = nowVN.subtract(daysSinceSaturday, 'day').startOf('day').utc().format("YYYY-MM-DD HH:mm:ss");

  // 📘 Hàm SQL thống kê
  const sqlAgg = (from) => from
    ? `SELECT hinhThuc as type, SUM(amount) as total 
       FROM transaction_details 
       WHERE time >= ? 
       GROUP BY hinhThuc`
    : `SELECT hinhThuc as type, SUM(amount) as total 
       FROM transaction_details 
       GROUP BY hinhThuc`;

  // ===== Query theo UTC =====
  db.all(sqlAgg(true), [startOfDayUTC], (err1, dayRows) => {
    if (err1) return res.status(500).json({ error: err1.message });

    db.all(sqlAgg(true), [startOfWeekUTC], (err2, weekRows) => {
      if (err2) return res.status(500).json({ error: err2.message });

      db.all(sqlAgg(false), [], (err3, allRows) => {
        if (err3) return res.status(500).json({ error: err3.message });

        // Helper format
        const format = (rows) => ({
          deposit: rows.find(r => r.type === "Nạp tiền")?.total || 0,
          withdraw: rows.find(r => r.type === "Rút tiền")?.total || 0
        });

        res.json({
          range: {
            day: startOfDayUTC,
            week: startOfWeekUTC,
          },
          day: format(dayRows),
          week: format(weekRows),
          all: format(allRows)
        });
      });
    });
  });
});


// ------------------- Thống kê tổng cược theo thiết bị + game (bet_history đã gỡ) -------------------
app.get('/api/bet-history/stats', (req, res) => {
  res.json([]);
});


function creditDeviceBalance(username, amount) {
  db.get(`SELECT device FROM accounts WHERE username = ?`, [username], (err3, acc) => {
    if (err3) {
      console.error("❌ Lỗi khi lấy device từ accounts:", err3.message);
      return;
    }
    if (!acc || !acc.device) {
      console.warn(`⚠️ User ${username} không có device → bỏ qua cộng tiền`);
      return;
    }

    const device = String(acc.device || '').trim();
    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      console.warn(`⚠️ credit device amount không hợp lệ: ${amount}`);
      return;
    }

    const base = resolveBankingDbUrl();
    // XMSB* → MSBAPI credit (auto-create + auto-sweep); còn lại → device_balances credit
    const url = isXmsbDeviceName(device)
      ? `${base}/api/msb-accounts/by-device/${encodeURIComponent(device)}/credit`
      : `${base}/api/device-balances/${encodeURIComponent(device)}/credit`;

    fetch(url, {
      method: 'POST',
      headers: bankingCreditHeaders(),
      body: JSON.stringify({
        amount: Math.trunc(numericAmount),
        source: 'lc79_withdraw',
        reason: `LC79 rút thành công · ${username}`,
      }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          console.error(
            `❌ Banking credit ${device} failed: HTTP ${r.status}`,
            body?.error || body,
          );
          return;
        }
        const created = body?.created ? ' (tạo mới)' : '';
        console.log(
          `✅ Banking credit ${device}${created} +${numericAmount} → balance=${body?.balance ?? '?'}`,
        );
      })
      .catch((e) => {
        console.error(`❌ Banking credit ${device} lỗi:`, e.message || e);
      });
  });
}

// ===================== API: Lưu giao dịch + cập nhật số dư device nếu là Rút tiền =====================
app.post('/api/transaction-details', (req, res) => {
  const { username, nickname, hinhThuc, transactionId, amount, time, deviceNap, status, reason, content } = req.body;

  if (!username || !hinhThuc || !transactionId || !amount) {
    return res.status(400).json({ error: "Thiếu dữ liệu bắt buộc (username, hinhThuc, transactionId, amount)" });
  }

  // 1️⃣ Kiểm tra transactionId đã tồn tại chưa
  db.get(`SELECT id FROM transaction_details WHERE transactionId = ?`, [transactionId], (err, row) => {
    if (err) {
      console.error("❌ Lỗi khi kiểm tra transactionId:", err.message);
      return res.status(500).json({ error: "Lỗi server" });
    }

    if (row) {
      // 🚫 Nếu đã có thì bỏ qua
      return res.status(409).json({ error: "Transaction đã tồn tại" });
    }

    // 2️⃣ Nếu chưa có → Insert mới
    const sqlInsert = `
      INSERT INTO transaction_details 
      (username, nickname, hinhThuc, transactionId, amount, time, db_time, deviceNap, status, reason, content) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const dbTime = dayjs().tz('Asia/Ho_Chi_Minh').format("YYYY-MM-DD HH:mm:ss");

    const normalizedStatus = status || "pending";
    db.run(
      sqlInsert,
      [
        username,
        nickname || "",
        hinhThuc,
        transactionId,
        amount,
        normalizeTxnTimeStr(time),
        dbTime,
        deviceNap || "",
        normalizedStatus,
        reason || "",
        content || "",
      ],
      function (err2) {
      if (err2) {
        console.error("❌ Lỗi khi lưu transaction_details:", err2.message);
        return res.status(500).json({ error: "Không thể lưu transaction", detail: err2.message });
      }

      console.log(`✅ Đã thêm giao dịch ${hinhThuc} cho user ${username}, amount = ${amount}, txn = ${transactionId}`);

      // 3️⃣ Nếu là Rút tiền và đã Thành công → Cộng tiền vào device
      if (hinhThuc === "Rút tiền" && normalizedStatus === "Thành công") {
        creditDeviceBalance(username, amount);
      }

      // 4️⃣ Trả kết quả sau khi insert
      res.status(201).json({
        success: true,
        id: this.lastID,
        transactionId: transactionId,
        type: hinhThuc,
        amount: amount,
        username: username,
        status: normalizedStatus,
      });
    });
  });
});

// ------------------- Lấy transaction theo transactionId -------------------
app.get('/api/transaction-details/:transactionId', (req, res) => {
  const { transactionId } = req.params;
  if (!transactionId) {
    return res.status(400).json({ error: "Thiếu transactionId" });
  }
  db.get(
    `SELECT * FROM transaction_details WHERE transactionId = ?`,
    [transactionId],
    (err, row) => {
      if (err) {
        console.error("❌ Lỗi khi lấy transaction_details:", err.message);
        return res.status(500).json({ error: "Lỗi server", detail: err.message });
      }
      if (!row) {
        return res.status(404).json({ error: "Transaction không tồn tại" });
      }
      res.json(row);
    }
  );
});

/** Banking / LDPlayer: lấy nhanh số dư theo prefix (đặt TRƯỚC /:device để không bị nuốt "quick"). */
app.get('/api/device-balances/quick', (req, res) => {
  const prefix = String(req.query.prefix || 'XMSB').trim() || 'XMSB';
  const minBalance = parseInt(String(req.query.minBalance || '0'), 10) || 0;
  const params = [`${prefix}%`];
  let sql = `SELECT device, balance FROM device_balances WHERE device LIKE ?`;
  if (minBalance > 0) {
    sql += ` AND balance >= ?`;
    params.push(minBalance);
  }
  sql += ` ORDER BY balance DESC`;
  db.all(sql, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ prefix, count: rows.length, items: rows });
  });
});

// Lấy 1 device theo tên
app.get('/api/device-balances/:device', (req, res) => {
  const { device } = req.params;
  const sql = `SELECT * FROM device_balances WHERE device = ?`;
  db.get(sql, [device], (err, row) => {
    if (err) {
      console.error("❌ Lỗi khi lấy device:", err.message);
      return res.status(500).json({ error: "Không thể lấy device" });
    }
    if (!row) {
      return res.status(404).json({ error: "Device không tồn tại" });
    }
    res.json(mapDeviceBalanceDailyRow(row));
  });
});
// ------------------- Cập nhật 1 device theo tên (cho phép đổi tên đồng bộ) -------------------
app.put('/api/device-balances/:device', (req, res) => {
  const oldDevice = req.params.device;
  const {
    device: bodyDevice,   // tên mới nếu form gửi theo key "device"
    newDevice,            // hoặc bạn có thể gửi theo key "newDevice"
    balance,
    nhanNgay,
    chuyenNgay,
    bank,
    username,
    password,
    accountNumber,
    accountHolder
  } = req.body;

  const targetDevice = (newDevice || bodyDevice || "").trim() || oldDevice;

  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); });
  });
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
  });

  db.serialize(async () => {
    try {
      const existing = await get(`SELECT * FROM device_balances WHERE device = ?`, [oldDevice]);
      const bodyRaw = req.body || {};
      const hasKey = (k) => Object.prototype.hasOwnProperty.call(bodyRaw, k);
      const eb = existing || {};
      const finalBalance = hasKey('balance') ? (Number(balance) || 0) : Number(eb.balance ?? 0);
      const finalNhanNgay = hasKey('nhanNgay') ? (Number(nhanNgay) || 0) : Number(eb.nhanNgay ?? 0);
      const finalChuyenNgay = hasKey('chuyenNgay') ? (Number(chuyenNgay) || 0) : Number(eb.chuyenNgay ?? 0);
      const todayVn = c168TodayVn();
      const finalNhanNgayDay = hasKey('nhanNgay')
        ? todayVn
        : String(eb.nhanNgayDay || '').trim() || '';
      const finalChuyenNgayDay = hasKey('chuyenNgay')
        ? todayVn
        : String(eb.chuyenNgayDay || '').trim() || '';
      const finalBank = hasKey('bank') ? String(bank ?? "") : String(eb.bank ?? "");
      const finalUsername = hasKey('username') ? String(username ?? "") : String(eb.username ?? "");
      const finalPassword = hasKey('password') ? String(password ?? "") : String(eb.password ?? "");
      const finalAccNum = hasKey('accountNumber') ? String(accountNumber ?? "") : String(eb.accountNumber ?? "");
      const finalHolder = hasKey('accountHolder') ? String(accountHolder ?? "") : String(eb.accountHolder ?? "");

      // 1) Nếu đổi tên -> kiểm tra trùng trước (device UNIQUE)
      if (targetDevice !== oldDevice) {
        const dup = await get(`SELECT id FROM device_balances WHERE device = ?`, [targetDevice]);
        if (dup) {
          return res.status(409).json({
            error: "Tên device đã tồn tại",
            detail: `Device '${targetDevice}' đã có trong hệ thống`
          });
        }
      }

      // 2) Transaction để đảm bảo đồng bộ
      await run(`BEGIN IMMEDIATE`);

      //      //  // 3) Cập nhật bảng chính + đổi tên nếu cần
      const sqlUpdateMain = `
        UPDATE device_balances
        SET device = ?,
            balance = ?,
            nhanNgay = ?,
            chuyenNgay = ?,
            nhanNgayDay = ?,
            chuyenNgayDay = ?,
            bank = ?,
            username = ?,
            password = ?,
            accountNumber = ?,
            accountHolder = ?,
            updatedAt = datetime('now')
        WHERE device = ?
      `;
      const rMain = await run(sqlUpdateMain, [
        targetDevice,
        finalBalance,
        finalNhanNgay,
        finalChuyenNgay,
        finalNhanNgayDay,
        finalChuyenNgayDay,
        finalBank,
        finalUsername,
        finalPassword,
        finalAccNum,
        finalHolder,
        oldDevice
      ]);
      if (rMain.changes === 0) {
        // Đổi tên mà không có bản ghi cũ → không tạo nhầm
        if (targetDevice !== oldDevice) {
          await run(`ROLLBACK`);
          return res.status(404).json({ error: "Device không tồn tại" });
        }
        // App Banking: PUT balance lần đầu — tự tạo device (không cần POST / thêm tay trong DB)
        await run(`ROLLBACK`);
        await run(`BEGIN IMMEDIATE`);
        const sqlInsert = `
          INSERT INTO device_balances (device, balance, nhanNgay, chuyenNgay, nhanNgayDay, chuyenNgayDay, bank, username, password, accountNumber, accountHolder, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `;
        try {
          await run(sqlInsert, [
            oldDevice,
            finalBalance,
            finalNhanNgay,
            finalChuyenNgay,
            finalNhanNgayDay || todayVn,
            finalChuyenNgayDay || todayVn,
            finalBank,
            finalUsername,
            finalPassword,
            finalAccNum,
            finalHolder
          ]);
        } catch (insErr) {
          if (String(insErr.message || "").includes("UNIQUE")) {
            await run(`ROLLBACK`);
            await run(`BEGIN IMMEDIATE`);
            await run(sqlUpdateMain, [
              targetDevice,
              finalBalance,
              finalNhanNgay,
              finalChuyenNgay,
              finalNhanNgayDay,
              finalChuyenNgayDay,
              finalBank,
              finalUsername,
              finalPassword,
              finalAccNum,
              finalHolder,
              oldDevice
            ]);
            await run(`COMMIT`);
            const rowRace = await get(`SELECT * FROM device_balances WHERE device = ?`, [targetDevice]);
            return res.json(rowRace);
          }
          throw insErr;
        }
        await run(`COMMIT`);
        const rowNew = await get(`SELECT * FROM device_balances WHERE device = ?`, [oldDevice]);
        console.log(`✅ device_balances: tạo mới device '${oldDevice}' qua PUT (lần đầu, balance=${finalBalance})`);
        return res.status(201).json(rowNew);
      }

      // 4) Nếu có đổi tên -> đồng bộ các bảng liên quan (LC79 + xoso66)
      if (targetDevice !== oldDevice) {
        await run(`UPDATE user_profiles SET device = ? WHERE device = ?`, [targetDevice, oldDevice]);
        await run(`UPDATE accounts SET device = ? WHERE device = ?`, [targetDevice, oldDevice]);
        await run(`UPDATE proxies SET device = ? WHERE device = ?`, [targetDevice, oldDevice]);
        await run(`UPDATE transaction_details SET deviceNap = ?, db_time = datetime('now','localtime') WHERE deviceNap = ?`, [targetDevice, oldDevice]);
        try {
          await syncDeviceRename(oldDevice, targetDevice, finalUsername, {
            skipDeviceBalances: true,
          });
        } catch (syncErr) {
          console.warn('⚠️ sync device rename xoso66 (device_balances):', syncErr.message);
        }
        // (tuỳ chọn) device_reports.devices là JSON -> nếu cần, xử lý sau
      }

      // 5) Commit và trả về bản ghi mới
      await run(`COMMIT`);
      const row = await get(`SELECT * FROM device_balances WHERE device = ?`, [targetDevice]);
      return res.json(row);
    } catch (err) {
      console.error("❌ Lỗi khi cập nhật/đổi tên device:", err.message);
      try { await run(`ROLLBACK`); } catch {}
      return res.status(500).json({ error: "Không thể cập nhật device", detail: err.message });
    }
  });
});

// ------------------- APIs cho bet_totals -------------------

// Cộng dồn tổng cược (ngày/tuần/tháng/all) — thay cho việc ghi bet_history + updateTotals khi INSERT
app.post('/api/bet-totals/increment', async (req, res) => {
  try {
    const { username, amount } = req.body || {};
    if (!username || amount == null || amount === '') {
      return res.status(400).json({ error: 'Thiếu username hoặc amount' });
    }
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      return res.status(400).json({ error: 'amount không hợp lệ' });
    }
    await updateTotals(username, Math.floor(n));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Đường dẫn cụ thể (/daily, /top) đăng ký TRƯỚC GET /api/bet-totals để luôn khớp đúng (Express 5 / path-to-regexp).
// GET /api/bet-totals/daily — mặc định: LC79 + Đang Chơi/Hết Tiền + total_day>0
//   include_zero_day=1|true: bỏ điều kiện total_day>0 (vẫn LC79 + 2 trạng thái; không dùng kèm raw=1).
//   raw=1: toàn bộ bet_totals (hành vi cũ, có thể lẫn nick ngoài CMS).
//   profile_status=Đang Chơi | Hết Tiền: thu hẹp 1 trạng thái (chỉ khi không raw).
function _betTotalsProfileStatusWhere(req) {
  const ps = String(req.query.profile_status || '').trim();
  if (!ps) return { ok: true, sql: "up.status IN ('Đang Chơi', 'Hết Tiền')" };
  if (ps === 'Đang Chơi' || ps === 'Hết Tiền') return { ok: true, sql: `up.status = '${ps}'` };
  return { ok: false, error: 'profile_status chỉ nhận Đang Chơi hoặc Hết Tiền' };
}

app.get('/api/bet-totals/daily', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 10000);
    const offset = (page - 1) * limit;
    await refreshBetTotalsAll();
    const rawDaily = req.query.raw === '1' || req.query.raw === 'true';

    if (rawDaily) {
      if (req.query.include_zero_day === '1' || req.query.include_zero_day === 'true') {
        return res.status(400).json({ error: 'include_zero_day không dùng kèm raw=1' });
      }
      if (String(req.query.profile_status || '').trim()) {
        return res.status(400).json({ error: 'profile_status không dùng kèm raw=1' });
      }
      db.get(`SELECT COUNT(*) as total FROM bet_totals`, [], (err, countRow) => {
        if (err) return res.status(500).json({ error: err.message });
        const total = countRow?.total || 0;
        db.all(
          `SELECT username, total_day, day_start, total_week, total_month, total_all, updated_at
           FROM bet_totals
           ORDER BY total_day DESC, username ASC
           LIMIT ? OFFSET ?`,
          [limit, offset],
          (err2, rows) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({
              metric: 'total_day',
              description: 'raw=1: mọi dòng bet_totals (tương thích cũ)',
              page,
              limit,
              totalItems: total,
              totalPages: Math.ceil(total / limit) || 1,
              data: rows,
            });
          }
        );
      });
      return;
    }

    const st = _betTotalsProfileStatusWhere(req);
    if (!st.ok) return res.status(400).json({ error: st.error });
    const includeZeroDay = req.query.include_zero_day === '1' || req.query.include_zero_day === 'true';
    const dayPositiveSql = includeZeroDay ? '' : ' AND bt.total_day > 0';
    const dailyFilter = `INNER JOIN user_profiles up ON up.username = bt.username
         INNER JOIN accounts ac ON ac.username = bt.username AND ac.game = 'LC79'
         WHERE ${st.sql}${dayPositiveSql}`;
    db.get(
      `SELECT COUNT(*) as total FROM bet_totals bt ${dailyFilter}`,
      [],
      (err, countRow) => {
      if (err) return res.status(500).json({ error: err.message });
      const total = countRow?.total || 0;
      db.all(
        `SELECT bt.username, bt.total_day, bt.day_start, bt.total_week, bt.total_month, bt.total_all, bt.updated_at
         FROM bet_totals bt
         ${dailyFilter}
         ORDER BY bt.total_day DESC, bt.username ASC
         LIMIT ? OFFSET ?`,
        [limit, offset],
        (err2, rows) => {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({
            metric: 'total_day',
            description:
              'Mặc định: LC79 + Đang Chơi/Hết Tiền + total_day>0. include_zero_day=1 → bỏ total_day>0. raw=1 → không lọc.',
            page,
            limit,
            totalItems: total,
            totalPages: Math.ceil(total / limit) || 1,
            data: rows,
          });
        }
      );
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Leaderboard / top by period
app.get('/api/bet-totals/top', async (req, res) => {
  try {
    await refreshBetTotalsAll(); // ✅ đảm bảo số liệu ngày/tuần/tháng đã reset
    const period = (req.query.period || 'all').toLowerCase();
    const limit = Math.max(1, parseInt(req.query.limit) || 20);
    let col = 'total_all';
    if (period === 'day') col = 'total_day';
    else if (period === 'week') col = 'total_week';
    else if (period === 'month') col = 'total_month';

    const sql = `SELECT username, ${col} as total, day_start, week_start, month_start, updated_at
                 FROM bet_totals ORDER BY ${col} DESC LIMIT ?`;
    db.all(sql, [limit], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ period, limit, data: rows });
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/bet-totals?page=1&limit=10000 — danh sách tổng cược; mặc định sort=total_day DESC (tổng cược ngày).
// Mặc định: mọi dòng bet_totals (tương thích cũ).
// managed_scope=1: chỉ LC79 + user_profiles; profile_status=Đang Chơi|Hết Tiền (tùy chọn, mặc định cả hai).
//   Khi sort=total_day và managed_scope=1: thêm total_day > 0 (trừ include_zero_day=1|true).
// sort: total_day | total_all | total_week | total_month (tie-break username ASC).
app.get('/api/bet-totals', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 500);
    const offset = (page - 1) * limit;
    const username = req.query.username;

    const sortAllowed = {
      total_day: 'total_day',
      total_all: 'total_all',
      total_week: 'total_week',
      total_month: 'total_month',
    };
    const sortKey = String(req.query.sort || 'total_day').toLowerCase();
    const orderCol = sortAllowed[sortKey] || 'total_day';

    if (username) {
      await refreshBetTotalsForUser(username);
      return db.get(`SELECT * FROM bet_totals WHERE username = ?`, [username], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Không tìm thấy username' });
        return res.json(row);
      });
    }

    await refreshBetTotalsAll(); // ✅ reset theo VN nếu đổi ngày/tuần/tháng mà chưa có bet

    const managedScope = req.query.managed_scope === '1' || req.query.managed_scope === 'true';
    if (String(req.query.profile_status || '').trim() && !managedScope) {
      return res.status(400).json({ error: 'profile_status chỉ dùng kèm managed_scope=1' });
    }
    const st = _betTotalsProfileStatusWhere(req);
    if (!st.ok) return res.status(400).json({ error: st.error });
    const includeZeroDayBt = req.query.include_zero_day === '1' || req.query.include_zero_day === 'true';
    const dayPositiveOnly =
      orderCol === 'total_day' && !includeZeroDayBt ? ' AND bt.total_day > 0' : '';

    if (managedScope) {
      const betTotalsScope = `INNER JOIN user_profiles up ON up.username = bt.username
         INNER JOIN accounts ac ON ac.username = bt.username AND ac.game = 'LC79'
         WHERE ${st.sql}`;
      db.get(
        `SELECT COUNT(*) as total FROM bet_totals bt ${betTotalsScope}${dayPositiveOnly}`,
        [],
        (err, countRow) => {
        if (err) return res.status(500).json({ error: err.message });
        const total = countRow?.total || 0;
        db.all(
          `SELECT bt.* FROM bet_totals bt
           ${betTotalsScope}${dayPositiveOnly}
           ORDER BY bt.${orderCol} DESC, bt.username ASC
           LIMIT ? OFFSET ?`,
          [limit, offset],
          (err2, rows) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({
              page,
              limit,
              sort: orderCol,
              managed_scope: true,
              totalItems: total,
              totalPages: Math.ceil(total / limit),
              data: rows,
            });
          }
        );
      });
      return;
    }

    db.get(`SELECT COUNT(*) as total FROM bet_totals`, [], (err, countRow) => {
      if (err) return res.status(500).json({ error: err.message });
      const total = countRow?.total || 0;
      db.all(
        `SELECT * FROM bet_totals
         ORDER BY ${orderCol} DESC, username ASC
         LIMIT ? OFFSET ?`,
        [limit, offset],
        (err2, rows) => {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ page, limit, sort: orderCol, totalItems: total, totalPages: Math.ceil(total / limit), data: rows });
        }
      );
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Tóm tắt 1 user
app.get('/api/bet-totals/:username/summary', async (req, res) => {
  try {
    const username = req.params.username;
    await refreshBetTotalsForUser(username); // ✅ auto reset riêng user
    db.get(
      `SELECT username, total_all, total_day, day_start, total_week, week_start, total_month, month_start, updated_at
       FROM bet_totals WHERE username = ?`,
      [username],
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Không tìm thấy username' });
        res.json(row);
      }
    );
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ------------------- Xoá 1 device theo tên -------------------
app.delete('/api/device-balances/:device', (req, res) => {
  const { device } = req.params;
  const sql = `DELETE FROM device_balances WHERE device = ?`;
  db.run(sql, [device], function (err) {
    if (err) {
      console.error("❌ Lỗi khi xoá device:", err.message);
      return res.status(500).json({ error: "Không thể xoá device", detail: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: "Device không tồn tại" });
    }
    res.json({ success: true, deleted: this.changes });
  });
});
// Trừ tiền trong device_balances
app.post('/api/device-balances/:device/deduct', (req, res) => {
  const { device } = req.params;
  const { amount } = req.body;

  const sql = `UPDATE device_balances SET balance = balance - ? WHERE device = ?`;
  db.run(sql, [amount, device], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "Device không tồn tại" });
    res.json({ success: true });
  });
});

// ------------------- Thống kê tổng nạp/rút theo user -------------------
app.get('/api/transactions/grouped/by-user', (req, res) => {
  const sql = `SELECT username,
                      SUM(CASE WHEN hinhThuc='Nạp tiền' THEN amount ELSE 0 END) AS deposit,
                      SUM(CASE WHEN hinhThuc='Rút tiền' AND status='Thành công' THEN amount ELSE 0 END) AS withdraw
               FROM transaction_details
               GROUP BY username`;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const map = {};
    rows.forEach(r => { map[r.username] = { deposit: r.deposit || 0, withdraw: r.withdraw || 0 }; });
    res.json(map);
  });
});

// ------------------- API: Lấy lịch sử lợi nhuận theo ngày -------------------
app.get('/api/daily-profits', async (req, res) => {
  try {
    const { from, to, limit = 30 } = req.query;
    const today = dayjs().tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
    
    let sql = `SELECT * FROM daily_profits ORDER BY date DESC`;
    const params = [];
    
    if (from && to) {
      sql += ` WHERE date BETWEEN ? AND ?`;
      params.push(from, to);
    } else {
      sql += ` LIMIT ?`;
      params.push(Number(limit));
    }
    
    db.all(sql, params, async (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      
      const todayIndex = rows.findIndex(r => r.date === today);
      const shouldIncludeToday = !from || !to
        ? true
        : (today >= from && today <= to);

      // Luôn tính lại dữ liệu ngày hôm nay để phản ánh thay đổi trạng thái
      if (shouldIncludeToday) {
        try {
          const todayData = await calculateTodayProfit();
          if (todayIndex >= 0) {
            rows[todayIndex] = todayData;
          } else {
            // Thêm vào đầu danh sách (ngày mới nhất)
            rows.unshift(todayData);
          }
        } catch (calcErr) {
          console.error('Lỗi khi tính toán dữ liệu ngày hôm nay:', calcErr);
          // Tiếp tục trả về dữ liệu đã có, không báo lỗi
        }
      }
      
      res.json({ data: rows });
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ------------------- API: Lợi nhuận theo ngày từ transaction_details -------------------
app.get('/api/transaction-profits', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  const username = (req.query.username || '').trim();
  const { from, to } = req.query;

  const whereParts = [];
  const whereParams = [];

  whereParts.push('db_time IS NOT NULL');

  if (username) {
    whereParts.push('username = ?');
    whereParams.push(username);
  }

  if (from && to) {
    whereParts.push('date(db_time) BETWEEN ? AND ?');
    whereParams.push(from, to);
  }

  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const sqlCount = `
    SELECT COUNT(*) as total
    FROM (
      SELECT date(db_time) as date
      FROM transaction_details
      ${whereSql}
      GROUP BY date(db_time)
    )
  `;

  db.get(sqlCount, whereParams, (err, countRow) => {
    if (err) {
      console.error("❌ Lỗi khi đếm ngày lợi nhuận:", err.message);
      return res.status(500).json({ error: "Lỗi server" });
    }

    const totalItems = Number(countRow?.total || 0);
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));

    const sqlData = `
      SELECT date(db_time) as date,
             SUM(CASE WHEN hinhThuc='Nạp tiền' THEN amount ELSE 0 END) AS deposit_day,
             SUM(CASE WHEN hinhThuc='Rút tiền' AND status IN ('Thành công', 'pending') THEN amount ELSE 0 END) AS withdraw_day
      FROM transaction_details
      ${whereSql}
      GROUP BY date(db_time)
      ORDER BY date DESC
      LIMIT ? OFFSET ?
    `;

    db.all(sqlData, [...whereParams, limit, offset], (err2, rows) => {
      if (err2) {
        console.error("❌ Lỗi khi lấy lợi nhuận theo ngày:", err2.message);
        return res.status(500).json({ error: "Lỗi server" });
      }

      const data = (rows || []).map(r => {
        const deposit = Number(r.deposit_day || 0);
        const withdraw = Number(r.withdraw_day || 0);
        return {
          date: r.date,
          deposit_day: deposit,
          withdraw_day: withdraw,
          profit: deposit - withdraw
        };
      });

      res.json({
        page,
        totalPages,
        totalItems,
        data
      });
    });
  });
});

// ------------------- Cập nhật giao dịch theo transactionId -------------------
app.put('/api/transaction-details/:transactionId', (req, res) => {
  const { transactionId } = req.params;
  const { status, reason, content, amount, time } = req.body;

  db.get(
    `SELECT username, hinhThuc, status, amount FROM transaction_details WHERE transactionId = ?`,
    [transactionId],
    (err, existing) => {
      if (err) {
        console.error("❌ Lỗi khi lấy transaction_details:", err.message);
        return res.status(500).json({ error: "Không thể cập nhật transaction", detail: err.message });
      }
      if (!existing) {
        return res.status(404).json({ error: "Transaction không tồn tại" });
      }

  const fields = [];
  const values = [];

  if (status !== undefined) {
    fields.push("status = ?");
    values.push(status);
  }
  if (reason !== undefined) {
    fields.push("reason = ?");
    values.push(reason);
  }
  if (content !== undefined) {
    fields.push("content = ?");
    values.push(content);
  }
  if (amount !== undefined) {
    fields.push("amount = ?");
    values.push(amount);
  }
  if (time !== undefined) {
    fields.push("time = ?");
    values.push(time);
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: "Thiếu dữ liệu cập nhật" });
  }

  fields.push("db_time = datetime('now','localtime')");
  const sql = `UPDATE transaction_details SET ${fields.join(", ")} WHERE transactionId = ?`;
  values.push(transactionId);

  const prevStatus = existing.status;
  const nextStatus = status !== undefined ? status : existing.status;
  const nextAmount = amount !== undefined ? amount : existing.amount;

  db.run(sql, values, function (err2) {
    if (err2) {
      console.error("❌ Lỗi khi cập nhật transaction_details:", err2.message);
      return res.status(500).json({ error: "Không thể cập nhật transaction", detail: err2.message });
    }

    if (existing.hinhThuc === "Rút tiền" && prevStatus !== "Thành công" && nextStatus === "Thành công") {
      creditDeviceBalance(existing.username, nextAmount);
    }

    res.json({ success: true, updated: this.changes });
  });
});
});

// ------------------- Cập nhật device cho transaction -------------------
app.put('/api/transactions/:transactionId/device', (req, res) => {
  const { transactionId } = req.params;
  const { device } = req.body;

  if (!device) {
    return res.status(400).json({ error: "Thiếu device" });
  }

  const sql = `UPDATE transaction_details SET deviceNap = ?, db_time = datetime('now','localtime') WHERE transactionId = ?`;
  db.run(sql, [device, transactionId], function (err) {
    if (err) {
      console.error("❌ Lỗi khi cập nhật device:", err.message);
      return res.status(500).json({ error: "Không thể cập nhật device", detail: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: "Transaction không tồn tại" });
    }
    res.json({ success: true });
  });
});

// ------------------- Thêm mới device balance -------------------
app.post('/api/device-balances', (req, res) => {
  const { device, balance, nhanNgay, chuyenNgay, bank, username, password, accountNumber, accountHolder } = req.body;

  if (!device) {
   
    return res.status(400).json({ error: "Thiếu tên device" });
  }

  const todayVn = c168TodayVn();
  const nhanVal = Number(nhanNgay) || 0;
  const chuyenVal = Number(chuyenNgay) || 0;

  const sql = `INSERT INTO device_balances (device, balance, nhanNgay, chuyenNgay, nhanNgayDay, chuyenNgayDay, bank, username, password, accountNumber, accountHolder, updatedAt) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`;

  db.run(sql, [device, balance || 0, nhanVal, chuyenVal, nhanVal ? todayVn : '', chuyenVal ? todayVn : '', bank || "", username || "", password || "", accountNumber || "", accountHolder || ""], function (err) {
    if (err) {
      console.error("❌ Lỗi khi thêm device:", err.message);
      return res.status(500).json({ error: "Không thể thêm device", detail: err.message });
    }
    res.json({ success: true, id: this.lastID });
  });
});

// ------------------- Lấy toàn bộ device balances -------------------
app.get('/api/device-balances', (req, res) => {
  const prefix = String(req.query.prefix || '').trim();
  const minBalance = parseInt(String(req.query.minBalance || '0'), 10) || 0;
  const fields = String(req.query.fields || '').trim().toLowerCase();
  const slim = fields === 'slim' || req.query.slim === '1';

  let sql = slim
    ? `SELECT device, balance, updatedAt FROM device_balances`
    : `SELECT * FROM device_balances`;
  const params = [];
  const clauses = [];
  if (prefix) {
    clauses.push(`device LIKE ?`);
    params.push(`${prefix}%`);
  }
  if (minBalance > 0) {
    clauses.push(`balance >= ?`);
    params.push(minBalance);
  }
  if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
  sql += ` ORDER BY balance DESC`;

  db.all(sql, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json((rows || []).map(mapDeviceBalanceDailyRow));
  });
});
// ------------------- Xoá lịch sử cược (bet_history đã gỡ — API giữ để tương thích) -------------------
app.delete('/api/bet-history/:username', (req, res) => {
  const username = req.params.username;
  if (!username) {
    return res.status(400).json({ error: "Thiếu username" });
  }
  res.json({
    success: true,
    deletedRows: 0,
    message: `bet_history đã bỏ — không còn dữ liệu để xoá (${username})`,
  });
});
// ------------------- Xoá TOÀN BỘ lịch sử nạp/rút của 1 user -------------------
app.delete('/api/transactions/user/:username', (req, res) => {
  const username = req.params.username;
  if (!username) return res.status(400).json({ error: "Thiếu username" });

  const sql = `DELETE FROM transaction_details WHERE username = ?`;
  db.run(sql, [username], function (err) {
    if (err) {
      console.error("❌ Lỗi khi xoá transaction_details:", err.message);
      return res.status(500).json({ error: "Không thể xoá lịch sử nạp/rút" });
    }
    res.json({
      success: true,
      deletedRows: this.changes,
      message: `Đã xoá ${this.changes} dòng giao dịch của user ${username}`
    });
  });
});

// ------------------- Thống kê tổng nạp/rút theo game -------------------
app.get('/api/accounts/summary/:game', (req, res) => {
  const game = (req.params.game || '').toUpperCase();
  if (!game) return res.status(400).json({ error: 'Thiếu game' });

  const sql = `SELECT SUM(totalDeposit) as totalDeposit, SUM(totalWithdraw) as totalWithdraw 
               FROM accounts WHERE game = ?`;

  db.get(sql, [game], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({
      game,
      totalDeposit: row?.totalDeposit || 0,
      totalWithdraw: row?.totalWithdraw || 0
    });
  });
});

const axios = require('axios');
const cron = require('node-cron');

const TELEGRAM_TOKEN = "8406349210:AAElIYSbfvlDum8l0TZ0vs_4YdNqL2tlCQ8"; // thay bằng token bot của bạn
const CHAT_ID = "7129501938"; // id nhóm hoặc user muốn nhận thông báo

async function notifyAndUpdate(user, type, target, status) {
  const msg = `📢 TK ${user} đã đạt tổng cược ${type} ${target.toLocaleString()} (Ép trạng thái ${status})`;

  // Gửi về Telegram
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text: msg
  });

  // Ép trạng thái
  // await axios.post("http://localhost:3000/api/accounts/status", {
  //   username: user,
  //   status: status
  // });
}

// Cronjob: mỗi phút check 1 lần
// cron.schedule("*/20 * * * *", async () => {
//   try {
//     const res = await axios.get("http://127.0.0.1:3000/api/bet-history/stats/lc79/users");
//     const stats = res.data.stats || [];

//     for (const s of stats) {
//       // Gọi API lấy thông tin user để kiểm tra trạng thái
//       const userRes = await axios.get(`http://127.0.0.1:3000/api/users/${s.username}`);
//       const user = userRes.data;

//       if (user && user.status === "Đang Chơi") {
//         if (s.totalDay >= 11000000) {
//           await notifyAndUpdate(s.username, "ngày", 11000000, "Đủ Ngày");
//         }
//         // if (s.totalWeek >= 50000000) {
//         //   await notifyAndUpdate(s.username, "tuần", 50000000, "Đủ Tuần");
//         // }
//         // if (s.totalMonth >= 200000000) {
//         //   await notifyAndUpdate(s.username, "tháng", 200000000, "Đủ Tháng");
//         // }
//       }
//     }

//   } catch (err) {
//     console.error("❌ Lỗi check mốc:", err.message);
//   }
// });
// =========================================

// ================= Tự động lưu lợi nhuận vào cuối ngày (23:59:59 giờ VN +7) =================
// Schedule job chạy vào 23:59:59 mỗi ngày theo múi giờ VN
schedule.scheduleJob('59 23 * * *', async () => {
  const nowVN = dayjs().tz('Asia/Ho_Chi_Minh');
  console.log(`🕐 [${nowVN.format('YYYY-MM-DD HH:mm:ss')}] Tự động lưu lợi nhuận ngày hôm nay...`);
  
  try {
    const result = await saveTodayProfit();
    console.log(`✅ [${nowVN.format('YYYY-MM-DD HH:mm:ss')}] Đã tự động lưu lợi nhuận ngày ${result.date}`);
  } catch (e) {
    console.error(`❌ [${nowVN.format('YYYY-MM-DD HH:mm:ss')}] Lỗi khi tự động lưu lợi nhuận:`, e);
  }
});

console.log('✅ Schedule job đã được thiết lập: Tự động lưu lợi nhuận vào 23:59:59 mỗi ngày (giờ VN +7)');

// ------------------- Quản Lý Chrome (LC79) -------------------
app.get('/api/chrome-launch-config', (req, res) => {
  const cfg = readChromeLaunchConfig();
  const urls = normalizeStartupUrlList(cfg.default_startup_urls || []);
  res.json({
    ok: true,
    default_startup_urls: urls,
    default_startup_urls_text: urls.join('\n'),
  });
});

app.put('/api/chrome-launch-config', (req, res) => {
  try {
    const text = req.body?.default_startup_urls_text;
    const list = text != null
      ? parseStartupUrlsText(text)
      : (req.body?.default_startup_urls || []);
    const saved = writeChromeLaunchConfig({ default_startup_urls: list });
    res.json({
      ok: true,
      default_startup_urls: saved.default_startup_urls,
      default_startup_urls_text: saved.default_startup_urls.join('\n'),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/chrome-profiles', (req, res) => {
  db.all(
    `SELECT id, name, proxy, startup_urls, session_id,
            device, phone, bank, account_number, account_holder,
            created_at, updated_at
     FROM chrome_profiles
     ORDER BY device COLLATE NOCASE ASC, id ASC`,
    [],
    (err, rows) => {
      if (err) {
        console.error('❌ chrome-profiles list:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
      }
      const items = (rows || []).map(mapChromeProfileItem);
      res.json({ ok: true, items, total: items.length });
    }
  );
});

app.post('/api/chrome-profiles', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const device = String(req.body?.device || '').trim();
  let proxy = '';
  try {
    proxy = validateSocks5Proxy(req.body?.proxy);
  } catch (valErr) {
    return res.status(400).json({ ok: false, error: valErr.message });
  }
  if (!device) {
    return res.status(400).json({ ok: false, error: 'Thiếu tên thiết bị (bắt buộc, duy nhất)' });
  }
  const session_id = newChromeSessionId();
  ensureChromeProfilesDir();
  const profileDir = path.join(CHROME_PROFILES_DIR, session_id);
  fs.mkdirSync(profileDir, { recursive: true });

  const startupStored = startupUrlsToStorage(
    req.body?.startup_urls_text ?? req.body?.startup_urls ?? ''
  );
  const phone = String(req.body?.phone || '').trim();
  const bank = String(req.body?.bank || '').trim();
  const account_number = String(req.body?.account_number || '').trim();
  const account_holder = String(req.body?.account_holder || '').trim();

  db.run(
    `INSERT INTO chrome_profiles (
      name, proxy, session_id, startup_urls,
      lc79_username, device, phone, bank, account_number, account_holder
    ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
    [
      name, proxy, session_id, startupStored,
      device, phone, bank, account_number, account_holder,
    ],
    async function onInsert(err) {
      if (err) {
        if (/UNIQUE/i.test(err.message)) {
          return res.status(409).json({ ok: false, error: 'Tên thiết bị đã tồn tại' });
        }
        console.error('❌ chrome-profiles create:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
      }
      const newId = this.lastID;
      let proxySync = { lc79: 0, xoso66: 0 };
      if (proxy) {
        try {
          proxySync = await syncProxyByDevice(device, proxy, name);
        } catch (syncErr) {
          console.error('❌ sync proxy (create):', syncErr.message);
        }
      }
      res.json({
        ok: true,
        item: {
          ...mapChromeProfileItem({
            id: newId,
            name: name || '',
            proxy,
            session_id,
            startup_urls: startupStored,
            device,
            phone,
            bank,
            account_number,
            account_holder,
          }),
          profile_dir: profileDir,
        },
        proxy_sync: proxySync,
      });
    }
  );
});

app.put('/api/chrome-profiles/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 1) {
    return res.status(400).json({ ok: false, error: 'ID không hợp lệ' });
  }
  const patchKeys = [
    'name', 'proxy', 'startup_urls_text', 'startup_urls',
    'device', 'phone', 'bank', 'account_number', 'account_holder',
  ];
  const hasPatch = patchKeys.some((k) => req.body?.[k] != null);
  if (!hasPatch) {
    return res.status(400).json({ ok: false, error: 'Không có trường cập nhật' });
  }

  db.get('SELECT * FROM chrome_profiles WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    if (!row) return res.status(404).json({ ok: false, error: 'Không tìm thấy profile' });

    let nextProxy = row.proxy;
    if (req.body?.proxy != null) {
      try {
        nextProxy = validateSocks5Proxy(req.body.proxy);
      } catch (valErr) {
        return res.status(400).json({ ok: false, error: valErr.message });
      }
    }
    const nextName = req.body?.name != null ? String(req.body.name).trim() : row.name;
    const nextStartup =
      req.body?.startup_urls_text != null || req.body?.startup_urls != null
        ? startupUrlsToStorage(req.body.startup_urls_text ?? req.body.startup_urls ?? '')
        : row.startup_urls;
    const nextDevice = req.body?.device != null ? String(req.body.device).trim() : row.device;
    if (!String(nextDevice).trim()) {
      return res.status(400).json({ ok: false, error: 'Tên thiết bị không được trống' });
    }
    const nextPhone = req.body?.phone != null ? String(req.body.phone).trim() : row.phone;
    const nextBank = req.body?.bank != null ? String(req.body.bank).trim() : row.bank;
    const nextAccNum =
      req.body?.account_number != null ? String(req.body.account_number).trim() : row.account_number;
    const nextHolder =
      req.body?.account_holder != null ? String(req.body.account_holder).trim() : row.account_holder;

    db.run(
      `UPDATE chrome_profiles SET
        name = ?, proxy = ?, startup_urls = ?,
        device = ?, phone = ?, bank = ?, account_number = ?, account_holder = ?,
        updated_at = datetime('now')
       WHERE id = ?`,
      [
        nextName, nextProxy, nextStartup,
        nextDevice, nextPhone, nextBank, nextAccNum, nextHolder,
        id,
      ],
      async function onUpdate(updErr) {
        if (updErr) {
          if (/UNIQUE/i.test(updErr.message)) {
            return res.status(409).json({ ok: false, error: 'Tên thiết bị đã tồn tại' });
          }
          return res.status(500).json({ ok: false, error: updErr.message });
        }
        let proxySync = null;
        let deviceSync = null;
        if (req.body?.device != null) {
          const oldDev = String(row.device || '').trim();
          const newDev = String(nextDevice || '').trim();
          if (oldDev.toLowerCase() !== newDev.toLowerCase()) {
            try {
              deviceSync = await syncDeviceRename(oldDev, newDev, nextName);
            } catch (syncErr) {
              console.error('❌ sync device (update):', syncErr.message);
              deviceSync = { lc79: 0, xoso66: 0, error: syncErr.message };
            }
          } else if (newDev) {
            try {
              deviceSync = await syncDeviceToUsername(nextName, newDev);
            } catch (syncErr) {
              console.error('❌ sync device username (update):', syncErr.message);
              deviceSync = { lc79: 0, xoso66: 0, error: syncErr.message };
            }
          }
        }
        if (req.body?.proxy != null) {
          try {
            proxySync = await syncProxyByDevice(nextDevice, nextProxy, nextName);
          } catch (syncErr) {
            console.error('❌ sync proxy (update):', syncErr.message);
            proxySync = { lc79: 0, xoso66: 0, error: syncErr.message };
          }
        }
        db.get('SELECT * FROM chrome_profiles WHERE id = ?', [id], (gErr, updated) => {
          if (gErr) return res.status(500).json({ ok: false, error: gErr.message });
          const payload = { ok: true, item: mapChromeProfileItem(updated) };
          if (proxySync) payload.proxy_sync = proxySync;
          if (deviceSync) payload.device_sync = deviceSync;
          res.json(payload);
        });
      }
    );
  });
});

app.delete('/api/chrome-profiles/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 1) {
    return res.status(400).json({ ok: false, error: 'ID không hợp lệ' });
  }
  db.get('SELECT * FROM chrome_profiles WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    if (!row) return res.status(404).json({ ok: false, error: 'Không tìm thấy profile' });

    db.run('DELETE FROM chrome_profiles WHERE id = ?', [id], (delErr) => {
      if (delErr) return res.status(500).json({ ok: false, error: delErr.message });
      const profileDir = path.join(CHROME_PROFILES_DIR, String(row.session_id));
      try {
        if (fs.existsSync(profileDir)) {
          fs.rmSync(profileDir, { recursive: true, force: true });
        }
      } catch (rmErr) {
        console.warn('⚠️ xóa thư mục chrome profile:', rmErr.message);
      }
      res.json({ ok: true, deleted_id: id });
    });
  });
});

app.post('/api/chrome-profiles/:id/open', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 1) {
    return res.status(400).json({ ok: false, error: 'ID không hợp lệ' });
  }
  db.get('SELECT * FROM chrome_profiles WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    if (!row) return res.status(404).json({ ok: false, error: 'Không tìm thấy profile' });

    const tabs = resolveProfileStartupUrls(row);
    launchChromeProfile(row, (launchErr, data) => {
      if (launchErr) {
        console.error('❌ chrome-profiles open:', launchErr.message);
        return res.status(500).json({ ok: false, error: launchErr.message });
      }
      db.run(
        `UPDATE chrome_profiles SET updated_at = datetime('now') WHERE id = ?`,
        [id],
        () => {}
      );
      res.json({
        ok: true,
        message: `Đã mở Chrome — ${row.device || row.name || id} (${data.tabs || tabs.length} tab)`,
        pid: data.pid,
        proxy_mode: data.proxy_mode,
        proxy_label: data.proxy_label,
        tabs: data.tabs || tabs.length,
        urls: data.urls || tabs,
        session_id: row.session_id,
        proxy: row.proxy,
      });
    });
  });
});

// ------------------- API Khởi Chạy Lệnh CMD -------------------
app.post('/api/run-command', (req, res) => {
  const { command } = req.body;
  const { spawn } = require('child_process');

  if (!command) {
    return res.status(400).json({ error: 'Thiếu tham số command' });
  }

  let cmd, args, cwd;

  switch (command) {
    case 'lc79':
      cmd = 'cmd';
      args = ['/c', 'start', 'cmd', '/k', 'cd /d C:\\Users\\Quang\\Documents\\LC79 && python main.py'];
      break;
    case 'banking':
      cmd = 'cmd';
      args = ['/c', 'start', 'cmd', '/k', 'cd /d C:\\Users\\Quang\\Documents\\Banking && python main.py'];
      break;
    case 'pm2':
      cmd = 'cmd';
      args = ['/c', 'start', 'cmd', '/k', 'pm2 logs'];
      break;
    default:
      return res.status(400).json({ error: 'Lệnh không hợp lệ' });
  }

  try {
    const process = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore'
    });
    
    process.unref(); // Cho phép process cha tiếp tục mà không đợi process con
    
    res.json({ 
      success: true, 
      message: `Đã khởi chạy lệnh: ${command}` 
    });
  } catch (error) {
    console.error('❌ Lỗi khi khởi chạy lệnh:', error);
    res.status(500).json({ 
      error: 'Không thể khởi chạy lệnh', 
      detail: error.message 
    });
  }
});

// ------------------- C168 accounts API (CMS game_data/c168.db) -------------------
app.get('/api/c168/accounts', (req, res) => {
  const secrets = String(req.query.secrets || '') === '1';
  c168Db.all(
    'SELECT * FROM c168_accounts ORDER BY username COLLATE NOCASE',
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
      res.json((rows || []).map((r) => c168PublicRow(c168EnrichRow(r), secrets)));
    }
  );
});

app.get('/api/c168/accounts/:username', (req, res) => {
  const secrets = String(req.query.secrets || '') === '1';
  const username = String(req.params.username || '').trim();
  c168Db.get(
    'SELECT * FROM c168_accounts WHERE username = ? COLLATE NOCASE',
    [username],
    (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    if (!row) return res.status(404).json({ ok: false, error: 'Không tìm thấy account' });
    res.json(c168PublicRow(c168EnrichRow(row), secrets));
  });
});

app.post('/api/c168/accounts', (req, res) => {
  const payload = c168NormalizePayload(req.body);
  if (!payload.username) {
    return res.status(400).json({ ok: false, error: 'username bắt buộc' });
  }
  const now = c168NowIso();
  const sql = `INSERT INTO c168_accounts (
      username, password, phone, account_holder, fund_password,
      bank_code, bank_name, account_number, proxy, device,
      balance, daily_bet_total, daily_bet_day, status,
      chrome_browser_dir, chrome_cdp_port, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  const vals = [
      payload.username,
      payload.password || '',
      payload.phone || '',
      payload.account_holder || '',
      payload.fund_password || '',
      payload.bank_code || '',
      payload.bank_name || '',
      payload.account_number || '',
      payload.proxy || '',
      payload.device || '',
      Number.isFinite(payload.balance) ? payload.balance : 0,
      Number.isFinite(payload.daily_bet_total) ? payload.daily_bet_total : 0,
      c168TodayVn(),
      payload.status || 'new',
      '',
      null,
      now,
      now,
    ];
  c168Db.run(sql, vals, function (err) {
    if (err) {
      const msg = /UNIQUE/i.test(err.message)
        ? 'Username đã tồn tại'
        : err.message;
      return res.status(400).json({ ok: false, error: msg });
    }
    c168Db.get(
      'SELECT * FROM c168_accounts WHERE username = ? COLLATE NOCASE',
      [payload.username],
      (e2, row) => {
        if (e2) return res.status(500).json({ ok: false, error: e2.message });
        res.status(201).json(c168PublicRow(c168EnrichRow(row), true));
      }
    );
  });
});

app.put('/api/c168/accounts/:username', (req, res) => {
  const username = String(req.params.username || '').trim();
  const payload = c168NormalizePayload(req.body);
  const keys = Object.keys(payload).filter((k) => C168_EDITABLE.has(k));
  if (!keys.length) {
    return res.status(400).json({ ok: false, error: 'Không có trường cập nhật' });
  }
  c168Db.get(
    'SELECT * FROM c168_accounts WHERE username = ? COLLATE NOCASE',
    [username],
    (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    if (!row) return res.status(404).json({ ok: false, error: 'Không tìm thấy account' });
    const finishUpdate = () => {
      const sets = [];
      const vals = [];
      for (const k of keys) {
        if ((k === 'password' || k === 'fund_password') && payload[k] === '••••') continue;
        sets.push(`${k} = ?`);
        vals.push(payload[k]);
      }
      if (!sets.length) {
        return res.status(400).json({ ok: false, error: 'Không có trường cập nhật' });
      }
      if (keys.includes('daily_bet_total')) {
        sets.push('daily_bet_day = ?');
        vals.push(c168TodayVn());
      }
      sets.push('updated_at = ?');
      vals.push(c168NowIso());
      vals.push(username);
      const sql = `UPDATE c168_accounts SET ${sets.join(', ')} WHERE username = ? COLLATE NOCASE`;
      c168Db.run(sql, vals, function (e2) {
        if (e2) {
          const msg = /UNIQUE/i.test(e2.message) ? 'Username đã tồn tại' : e2.message;
          return res.status(400).json({ ok: false, error: msg });
        }
        c168Db.get(
          'SELECT * FROM c168_accounts WHERE username = ? COLLATE NOCASE',
          [username],
          (e3, updated) => {
          if (e3) return res.status(500).json({ ok: false, error: e3.message });
          res.json(c168PublicRow(c168EnrichRow(updated), true));
        });
      });
    };
    finishUpdate();
  });
});

app.post('/api/c168/accounts/:username/open-chrome', (req, res) => {
  const username = String(req.params.username || '').trim();
  c168Db.get(
    'SELECT * FROM c168_accounts WHERE username = ? COLLATE NOCASE',
    [username],
    (err, acc) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    if (!acc) return res.status(404).json({ ok: false, error: 'Không tìm thấy account' });
    if (!String(acc.proxy || '').trim()) {
      return res.status(400).json({
        ok: false,
        error: 'Acc chưa có proxy — nhập proxy trước khi mở Chrome',
      });
    }
    const isFirst = !(acc.chrome_browser_dir && String(acc.chrome_browser_dir).trim());
    const browserDir = c168BrowserDirForUsername(acc.username);
    const cdpPort = acc.chrome_cdp_port || c168CdpPortForUsername(acc.username);
    const accLaunch = {
      ...acc,
      chrome_browser_dir: browserDir,
      chrome_cdp_port: cdpPort,
    };
    let proxyLabel = '';
    try {
      proxyLabel = validateSocks5Proxy(acc.proxy || '');
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    launchC168Browser(accLaunch, [C168_DEFAULT_OPEN_URL], (launchErr, data) => {
      if (launchErr) {
        return res.status(500).json({ ok: false, error: launchErr.message });
      }
      const now = c168NowIso();
      const viaProxy = data.proxy_label || proxyLabel;
      c168Db.run(
        `UPDATE c168_accounts SET chrome_browser_dir = ?, chrome_cdp_port = ?, updated_at = ? WHERE username = ? COLLATE NOCASE`,
        [browserDir, cdpPort, now, acc.username],
        (upErr) => {
          if (upErr) return res.status(500).json({ ok: false, error: upErr.message });
          const basePayload = {
            ok: true,
            first_open: isFirst,
            username: acc.username,
            proxy: proxyLabel,
            proxy_mode: data.proxy_mode || '',
            proxy_label: viaProxy,
            chrome_browser_dir: browserDir,
            cdp_url: data.cdp_url,
            cdp_port: data.cdp_port,
            chrome_pid: data.pid,
            urls: data.urls,
            session_alive: false,
            action: 'none',
          };
          c168PostOpenSessionCheck(acc, 6, (checkErr, checkData) => {
            if (checkErr) {
              return res.json({
                ...basePayload,
                message: (isFirst
                  ? `Đã tạo Chrome — ${acc.username}`
                  : `Đã mở Chrome — ${acc.username}`) + ' (chưa kiểm tra session)',
                session_check_error: checkErr.message,
              });
            }
            if (!checkData || !checkData.session_alive) {
              return res.json({
                ...basePayload,
                session_alive: false,
                action: 'none',
                session: checkData?.session || {},
                message:
                  checkData?.message ||
                  'Session C168 không còn — chỉ mở Chrome, không vào BCR / WS',
              });
            }
            const wsPid = spawnC168BcrWsListen(acc);
            return res.json({
              ...basePayload,
              session_alive: true,
              action: 'ws_listen',
              ws_listen_pid: wsPid,
              table: 'C06',
              message: `Session OK — nghe WS BCR C06, không cược (${acc.username})`,
              session: checkData.session || {},
            });
          });
        }
      );
    });
  });
});

app.delete('/api/c168/accounts/:username', (req, res) => {
  const username = String(req.params.username || '').trim();
  c168Db.run(
    'DELETE FROM c168_accounts WHERE username = ? COLLATE NOCASE',
    [username],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      if (!this.changes) {
        return res.status(404).json({ ok: false, error: 'Không tìm thấy account' });
      }
      res.json({ ok: true, deleted: true, username });
    }
  );
});

app.get('/api/c168/accounts-export.csv', (req, res) => {
  c168Db.all(
    'SELECT * FROM c168_accounts ORDER BY username COLLATE NOCASE',
    [],
    (err, rows) => {
    if (err) return res.status(500).send(err.message);
    const header = [
      'username', 'phone', 'account_holder', 'bank_code', 'bank_name',
      'account_number', 'proxy', 'device', 'balance', 'daily_bet_total', 'status',
    ];
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };
    const lines = [header.join(',')];
    for (const r of rows || []) {
      lines.push(header.map((h) => esc(r[h])).join(','));
    }
    const fname = `c168_accounts_${dayjs().format('YYYYMMDD_HHmmss')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send('\uFEFF' + lines.join('\n'));
  });
});

// XOSO66: API Node + DB game_data/xoso66.db (Python bridge chỉ nạp/rút/provision)
const {
  registerXoso66Routes,
  XOSO66_CONFIG_PATH: XOSO66_CONFIG_PATH_SVC,
} = require('./lib/xoso66_service');
registerXoso66Routes(app);

registerAllgameRoutes(app, {
  onAfterLaunch(portalId, accLaunch, basePayload, callback) {
    const pid = allgameNormalizePortalId(portalId);
    if (pid !== 'c168') {
      return callback(null, basePayload);
    }
    if (basePayload.session_alive) {
      const wsPid = spawnC168BcrWsListen(accLaunch);
      return callback(null, {
        ...basePayload,
        action: 'ws_listen',
        ws_listen_pid: wsPid,
        table: 'C06',
        message: `Session OK — nghe WS BCR C06 (${accLaunch.username})`,
      });
    }
    const cdpWaitSec = basePayload.first_open ? 14 : 8;
    c168PostOpenSessionCheck(accLaunch, cdpWaitSec, (checkErr, checkData) => {
      if (checkErr) {
        return callback(null, {
          ...basePayload,
          message: basePayload.message + ' (chưa kiểm tra session)',
          session_check_error: checkErr.message,
        });
      }
      if (!checkData || !checkData.session_alive) {
        return callback(null, {
          ...basePayload,
          session_alive: false,
          action: 'none',
          session: checkData?.session || {},
          message:
            checkData?.message ||
            'Session C168 không còn — chỉ mở Chrome, không vào BCR / WS',
        });
      }
      const wsPid = spawnC168BcrWsListen(accLaunch);
      callback(null, {
        ...basePayload,
        session_alive: true,
        action: 'ws_listen',
        ws_listen_pid: wsPid,
        table: 'C06',
        message: `Session OK — nghe WS BCR C06 (${accLaunch.username})`,
        session: checkData.session || {},
      });
    });
  },
});

app.listen(PORT, (err) => {
  if (err) return console.error("❌ Lỗi khi khởi động server:", err);
  console.log(`Server  1 running on http://0.0.0.0:${PORT}`);
  console.log(`[C168] Accounts DB → ${C168_DB_PATH}`);
  console.log(`[ALLGAME] Accounts DB → ${path.join(C168_DATA_DIR, 'allgame.db')}`);
  console.log('[XOSO66] UI + API Node → /xoso66-api/ (không cần python :8799)');
  console.log(`[XOSO66] DB → ${path.join(__dirname, 'game_data', 'xoso66.db')}`);
  console.log(`[XOSO66] Config → ${XOSO66_CONFIG_PATH_SVC}`);
});

// Phục vụ giao diện CMS trong thư mục public
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Auto reset bet_totals khi sang ngày/tuần/tháng mới (theo VN) ngay lúc gọi API
function refreshBetTotalsAll() {
  return new Promise((resolve, reject) => {
    const { day, week_start, month_start } = getVNDateInfo();
    db.serialize(() => {
      db.run(
        `UPDATE bet_totals 
         SET total_day = 0, day_start = ?, updated_at = datetime('now')
         WHERE day_start IS NULL OR day_start <> ?`,
        [day, day]
      );
      db.run(
        `UPDATE bet_totals 
         SET total_week = 0, week_start = ?, updated_at = datetime('now')
         WHERE week_start IS NULL OR week_start <> ?`,
        [week_start, week_start]
      );
      db.run(
        `UPDATE bet_totals 
         SET total_month = 0, month_start = ?, updated_at = datetime('now')
         WHERE month_start IS NULL OR month_start <> ?`,
        [month_start, month_start],
        function (err) { if (err) return reject(err); resolve(); }
      );
    });
  });
}

// Chỉ refresh cho 1 user (dùng cho summary)
function refreshBetTotalsForUser(username) {
  return new Promise((resolve, reject) => {
    const { day, week_start, month_start } = getVNDateInfo();
    db.serialize(() => {
      db.run(
        `UPDATE bet_totals 
         SET total_day = 0, day_start = ?, updated_at = datetime('now')
         WHERE username = ? AND (day_start IS NULL OR day_start <> ?)`,
        [day, username, day]
      );
      db.run(
        `UPDATE bet_totals 
         SET total_week = 0, week_start = ?, updated_at = datetime('now')
         WHERE username = ? AND (week_start IS NULL OR week_start <> ?)`,
        [week_start, username, week_start]
      );
      db.run(
        `UPDATE bet_totals 
         SET total_month = 0, month_start = ?, updated_at = datetime('now')
         WHERE username = ? AND (month_start IS NULL OR month_start <> ?)`,
        [month_start, username, month_start],
        function (err) { if (err) return reject(err); resolve(); }
      );
    });
  });
}
