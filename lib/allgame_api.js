/**
 * ALLGAME — API CMS → game_data/allgame.db
 * Khóa tài khoản: (portal_id, username)
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { createHash } = require('crypto');

const { execFile } = require('child_process');
const http = require('http');

const ALLGAME_DATA_DIR = path.join(__dirname, '..', 'game_data');
const ALLGAME_DB_PATH = path.join(ALLGAME_DATA_DIR, 'allgame.db');
const ALLGAME_BROWSERS_DIR = path.join(ALLGAME_DATA_DIR, 'allgame_browsers');
const ALLGAME_CDP_PORT_BASE = parseInt(process.env.ALLGAME_CDP_PORT_BASE || '9360', 10);
const BROWSER_ISOLATE_DIR = path.resolve(__dirname, '..', '..', 'LC79', 'browser_isolate');
const CMS_LAUNCH_SCRIPT = path.join(BROWSER_ISOLATE_DIR, 'cms_launch.py');
/** Giống QuanLyChrome: dùng PYTHON hệ thống, không bắt buộc .venv khi mở Chrome. */
function allgameLaunchPython() {
  return process.env.PYTHON || 'python';
}

/** Chờ Chrome CDP sau cms_launch (lần đầu profile/proxy thường chậm hơn). */
function waitForCdpReady(cdpUrl, timeoutMs, callback) {
  const base = String(cdpUrl || '').replace(/\/$/, '');
  if (!base) return callback(null, false);
  const deadline = Date.now() + Math.max(3000, timeoutMs || 12000);

  const ping = () => {
    const req = http.get(`${base}/json/version`, (res) => {
      res.resume();
      if (res.statusCode === 200) return callback(null, true);
      schedule();
    });
    req.on('error', schedule);
    req.setTimeout(2000, () => {
      req.destroy();
      schedule();
    });
  };

  const schedule = () => {
    if (Date.now() >= deadline) return callback(null, false);
    setTimeout(ping, 400);
  };

  ping();
}

try {
  fs.mkdirSync(ALLGAME_DATA_DIR, { recursive: true });
} catch (e) {
  console.warn('[ALLGAME] mkdir game_data:', e.message);
}

const allgameDb = new sqlite3.Database(ALLGAME_DB_PATH, (err) => {
  if (err) console.error('❌ ALLGAME DB:', err.message);
  else console.log(`✅ ALLGAME DB → ${ALLGAME_DB_PATH}`);
});

const DEFAULT_PORTALS = [
  {
    portal_id: 'cm88',
    display_name: 'CM88',
    site_url: 'https://cm88.com/',
    transport: 'chrome',
    enabled: 1,
    config_json: '{}',
  },
  {
    portal_id: 'fly88',
    display_name: 'FLY88',
    site_url: 'https://m.fly88t.vip/',
    transport: 'chrome',
    enabled: 1,
    config_json: '{}',
  },
  {
    portal_id: 'c168',
    display_name: 'C168',
    site_url: 'https://c168b2.cc/',
    transport: 'chrome',
    enabled: 1,
    config_json: JSON.stringify({ hall_api: 'https://af861c.c168f.com', sitecode: '2865' }),
  },
  {
    portal_id: 'f168',
    display_name: 'F168',
    site_url: 'https://f1686s.com/',
    transport: 'chrome',
    enabled: 1,
    config_json: '{}',
  },
  {
    portal_id: 'sc88',
    display_name: 'SC88',
    site_url: 'https://www.sc881.net/',
    transport: 'chrome',
    enabled: 1,
    config_json: '{}',
  },
];

const ALLGAME_EDITABLE = new Set([
  'portal_id',
  'username',
  'password',
  'phone',
  'account_holder',
  'fund_password',
  'bank_code',
  'bank_name',
  'account_number',
  'proxy',
  'device',
  'balance',
  'daily_bet_total',
  'status',
  'transport',
  'chrome_browser_dir',
  'chrome_cdp_port',
  'vendor_state',
]);

function allgameNowIso() {
  return new Date().toISOString();
}

function allgameTodayVn() {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

function allgameSafeDirKey(username) {
  return String(username || '')
    .trim()
    .replace(/[^\w.\-]+/g, '_')
    .slice(0, 120) || 'user';
}

function allgameCdpPortFor(portalId, username) {
  const key = `${String(portalId || '').toLowerCase()}:${String(username || '').trim().toLowerCase()}`;
  const h = createHash('md5').update(key).digest();
  const n = h.readUInt32BE(0) & 0x7fff;
  return ALLGAME_CDP_PORT_BASE + 1 + (n % 399);
}

function allgameBrowserDirFor(portalId, username) {
  const portal = String(portalId || '').trim().toLowerCase() || 'unknown';
  return path.join(ALLGAME_BROWSERS_DIR, portal, allgameSafeDirKey(username));
}

function parseExecJsonLine(stdout) {
  const lines = String(stdout || '')
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const line = lines.length ? lines[lines.length - 1] : '{}';
  return JSON.parse(line);
}

/** SOCKS5 host:port:user:pass */
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

function normalizePortalOpenUrl(siteUrl) {
  const s = String(siteUrl || '').trim();
  if (!s) return 'about:blank';
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

/**
 * Tạo thư mục profile Chrome riêng (game/username) — gọi khi thêm acc vào DB.
 */
function ensureAllgameChromeProfile(portalId, username) {
  const pid = allgameNormalizePortalId(portalId);
  const user = String(username || '').trim();
  if (!pid || !user) {
    throw new Error('Thiếu portal_id hoặc username');
  }
  try {
    fs.mkdirSync(ALLGAME_BROWSERS_DIR, { recursive: true });
  } catch (e) {
    throw e;
  }
  const browserDir = allgameBrowserDirFor(pid, user);
  const cdpPort = allgameCdpPortFor(pid, user);
  fs.mkdirSync(browserDir, { recursive: true });
  const metaPath = path.join(browserDir, '.allgame_profile.json');
  const meta = {
    portal_id: pid,
    username: user,
    chrome_browser_dir: browserDir,
    chrome_cdp_port: cdpPort,
    updated_at: allgameNowIso(),
  };
  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  } catch (_) {
    /* ignore */
  }
  return { browserDir, cdpPort, profile_created: true };
}

/**
 * Mở Chrome — cùng cách QuanLyChrome / C168: chỉ gọi cms_launch.py, không Playwright.
 */
function launchAllgameBrowser(acc, urls, callback) {
  const portalId = allgameNormalizePortalId(acc.portal_id);
  const username = String(acc.username || '').trim();
  if (!portalId || !username) {
    return callback(new Error('Thiếu portal_id hoặc username'));
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
      new Error('Bắt buộc proxy SOCKS5 host:port:user:pass — cập nhật proxy trên CMS rồi mở lại')
    );
  }
  const profile = ensureAllgameChromeProfile(portalId, username);
  const browserDir = acc.chrome_browser_dir || profile.browserDir;
  const cdpPort = acc.chrome_cdp_port || profile.cdpPort;
  const openUrls =
    Array.isArray(urls) && urls.length
      ? urls.map((u) => normalizePortalOpenUrl(u))
      : ['about:blank'];
  const python = allgameLaunchPython();
  const args = [
    CMS_LAUNCH_SCRIPT,
    '--profile-dir',
    browserDir,
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
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 1024 * 512,
    },
    (err, stdout, stderr) => {
      let data = null;
      try {
        const line = String(stdout || '')
          .trim()
          .split(/\r?\n/)
          .pop();
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
      callback(null, {
        ...data,
        chrome_browser_dir: browserDir,
        cdp_port: cdpPort,
        cdp_url: data.cdp_url || `http://127.0.0.1:${cdpPort}`,
        proxy,
      });
    }
  );
}

function saveSessionJsonToDb(portalId, username, sessionJson, callback) {
  if (!sessionJson || typeof sessionJson !== 'object') {
    return callback(null, false);
  }
  const now = allgameNowIso();
  allgameDb.run(
    `UPDATE accounts SET session_json = ?, updated_at = ?
     WHERE portal_id = ? AND username = ? COLLATE NOCASE`,
    [JSON.stringify(sessionJson), now, portalId, username],
    function (err) {
      callback(err, !err);
    }
  );
}

function allgameNormalizePortalId(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
}

function allgameNormalizePayload(body) {
  const p = body && typeof body === 'object' ? { ...body } : {};
  const str = (k) => (p[k] != null ? String(p[k]).trim() : undefined);
  const out = {};
  if (str('portal_id') !== undefined) out.portal_id = allgameNormalizePortalId(str('portal_id'));
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
  if (str('transport') !== undefined) out.transport = str('transport');
  if (str('vendor_state') !== undefined) out.vendor_state = str('vendor_state');
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

function allgamePublicRow(row, includeSecrets) {
  if (!row) return null;
  const r = { ...row };
  if (!includeSecrets) {
    if (r.password) r.password = '••••';
    if (r.fund_password) r.fund_password = '••••';
  }
  return r;
}

/** ?portal_id= & ?device= (LIKE, không phân biệt hoa thường) */
function allgameAccountsListFilters(query) {
  const q = query && typeof query === 'object' ? query : {};
  const portalId = allgameNormalizePortalId(q.portal_id || '');
  const deviceQ = String(q.device || '').trim();
  const where = [];
  const params = [];
  if (portalId) {
    where.push('portal_id = ?');
    params.push(portalId);
  }
  if (deviceQ) {
    where.push('LOWER(COALESCE(device, "")) LIKE ?');
    params.push(`%${deviceQ.toLowerCase()}%`);
  }
  return { portalId, deviceQ, where, params };
}

/** Thứ tự hiển thị mặc định: Đang Chơi → Đủ ngày → Hết Tiền → … */
const ALLGAME_STATUS_ORDER_SQL = `
  CASE COALESCE(status, '')
    WHEN 'Đang Chơi' THEN 1
    WHEN 'Đủ ngày' THEN 2
    WHEN 'Hết Tiền' THEN 3
    WHEN 'new' THEN 4
    WHEN 'Khoá' THEN 5
    WHEN 'Khóa' THEN 5
    WHEN 'Token Lỗi' THEN 6
    ELSE 50
  END`;

function allgameAccountsSelectSql(query) {
  const { where, params } = allgameAccountsListFilters(query);
  let sql = 'SELECT * FROM accounts';
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ` ORDER BY ${ALLGAME_STATUS_ORDER_SQL}, COALESCE(balance, 0) DESC, portal_id, username COLLATE NOCASE`;
  return { sql, params };
}

function allgameEnrichRow(r) {
  if (!r) return null;
  const portalId = r.portal_id;
  const username = r.username;
  const hasBrowser = !!(r.chrome_browser_dir && String(r.chrome_browser_dir).trim());
  const cdp =
    r.chrome_cdp_port ||
    (portalId && username ? allgameCdpPortFor(portalId, username) : null);
  return {
    ...r,
    session_key: `${portalId}:${username}`,
    chrome_cdp_port: cdp,
    chrome_ready: hasBrowser,
    default_browser_dir: allgameBrowserDirFor(portalId, username),
  };
}

function initAllgameDb() {
  allgameDb.serialize(() => {
    allgameDb.run(`
      CREATE TABLE IF NOT EXISTS portals (
        portal_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL DEFAULT '',
        site_url TEXT NOT NULL DEFAULT '',
        transport TEXT NOT NULL DEFAULT 'chrome',
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    allgameDb.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        portal_id TEXT NOT NULL,
        username TEXT NOT NULL COLLATE NOCASE,
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
        total_deposit REAL NOT NULL DEFAULT 0,
        total_withdraw REAL NOT NULL DEFAULT 0,
        daily_bet_total REAL NOT NULL DEFAULT 0,
        daily_bet_day TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'new',
        transport TEXT NOT NULL DEFAULT 'chrome',
        chrome_browser_dir TEXT NOT NULL DEFAULT '',
        chrome_cdp_port INTEGER,
        vendor_state TEXT NOT NULL DEFAULT 'idle',
        session_json TEXT NOT NULL DEFAULT '{}',
        portal_extra_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (portal_id, username)
      )
    `);
    allgameDb.run(
      'CREATE INDEX IF NOT EXISTS idx_allgame_status ON accounts(status)'
    );
    allgameDb.run(
      'CREATE INDEX IF NOT EXISTS idx_allgame_portal_status ON accounts(portal_id, status)'
    );
    const now = allgameNowIso();
    for (const p of DEFAULT_PORTALS) {
      allgameDb.run(
        `INSERT INTO portals (
          portal_id, display_name, site_url, transport, enabled,
          config_json, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(portal_id) DO UPDATE SET
          display_name = excluded.display_name,
          site_url = excluded.site_url,
          transport = excluded.transport,
          enabled = excluded.enabled,
          config_json = excluded.config_json,
          updated_at = excluded.updated_at`,
        [
          p.portal_id,
          p.display_name,
          p.site_url,
          p.transport,
          p.enabled,
          p.config_json,
          now,
          now,
        ]
      );
    }
    const activeIds = DEFAULT_PORTALS.map((p) => p.portal_id);
    const placeholders = activeIds.map(() => '?').join(',');
    allgameDb.run(
      `UPDATE portals SET enabled = 0 WHERE portal_id NOT IN (${placeholders})`,
      activeIds
    );
  });
}

initAllgameDb();

function registerAllgameRoutes(app, deps = {}) {
  const onAfterLaunch =
    typeof deps.onAfterLaunch === 'function' ? deps.onAfterLaunch : null;
  app.get('/api/allgame/portals', (req, res) => {
    const enabledOnly = String(req.query.enabled || '') === '1';
    const sql = enabledOnly
      ? 'SELECT * FROM portals WHERE enabled = 1 ORDER BY portal_id'
      : 'SELECT * FROM portals ORDER BY portal_id';
    allgameDb.all(sql, [], (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      const items = (rows || []).map((r) => {
        let config_json = {};
        try {
          config_json = JSON.parse(r.config_json || '{}');
        } catch (_) {
          config_json = {};
        }
        return {
          ...r,
          enabled: !!r.enabled,
          config_json,
        };
      });
      res.json({ ok: true, items });
    });
  });

  app.get('/api/allgame/accounts', (req, res) => {
    const secrets = String(req.query.secrets || '') === '1';
    const { sql, params } = allgameAccountsSelectSql(req.query);
    allgameDb.all(sql, params, (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json(
        (rows || []).map((r) => allgamePublicRow(allgameEnrichRow(r), secrets))
      );
    });
  });

  app.get('/api/allgame/accounts/:portal_id/:username', (req, res) => {
    const secrets = String(req.query.secrets || '') === '1';
    const portalId = allgameNormalizePortalId(req.params.portal_id);
    const username = String(req.params.username || '').trim();
    allgameDb.get(
      'SELECT * FROM accounts WHERE portal_id = ? AND username = ? COLLATE NOCASE',
      [portalId, username],
      (err, row) => {
        if (err) return res.status(500).json({ ok: false, error: err.message });
        if (!row) {
          return res.status(404).json({ ok: false, error: 'Không tìm thấy account' });
        }
        res.json(allgamePublicRow(allgameEnrichRow(row), secrets));
      }
    );
  });

  app.post('/api/allgame/accounts', (req, res) => {
    const payload = allgameNormalizePayload(req.body);
    if (!payload.portal_id) {
      return res.status(400).json({ ok: false, error: 'portal_id (game) bắt buộc' });
    }
    if (!payload.username) {
      return res.status(400).json({ ok: false, error: 'username bắt buộc' });
    }
    allgameDb.get(
      'SELECT portal_id FROM portals WHERE portal_id = ?',
      [payload.portal_id],
      (pErr, portalRow) => {
        if (pErr) return res.status(500).json({ ok: false, error: pErr.message });
        if (!portalRow) {
          return res.status(400).json({
            ok: false,
            error: `Portal/game không hợp lệ: ${payload.portal_id}`,
          });
        }
        const now = allgameNowIso();
        let profileInfo;
        try {
          profileInfo = ensureAllgameChromeProfile(
            payload.portal_id,
            payload.username
          );
        } catch (mkErr) {
          return res.status(500).json({ ok: false, error: mkErr.message });
        }
        const browserDir = profileInfo.browserDir;
        const sql = `INSERT INTO accounts (
          portal_id, username, password, phone, account_holder, fund_password,
          bank_code, bank_name, account_number, proxy, device,
          balance, total_deposit, total_withdraw,
          daily_bet_total, daily_bet_day, status, transport,
          chrome_browser_dir, chrome_cdp_port, vendor_state,
          session_json, portal_extra_json, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
        const vals = [
          payload.portal_id,
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
          0,
          0,
          Number.isFinite(payload.daily_bet_total) ? payload.daily_bet_total : 0,
          allgameTodayVn(),
          payload.status || 'new',
          payload.transport || 'chrome',
          browserDir,
          profileInfo.cdpPort,
          payload.vendor_state || 'idle',
          '{}',
          '{}',
          now,
          now,
        ];
        allgameDb.run(sql, vals, function (err) {
          if (err) {
            const msg = /UNIQUE/i.test(err.message)
              ? `Đã tồn tại: ${payload.portal_id} / ${payload.username}`
              : err.message;
            return res.status(400).json({ ok: false, error: msg });
          }
          allgameDb.get(
            'SELECT * FROM accounts WHERE portal_id = ? AND username = ? COLLATE NOCASE',
            [payload.portal_id, payload.username],
            (e2, row) => {
              if (e2) return res.status(500).json({ ok: false, error: e2.message });
              res.status(201).json(allgamePublicRow(allgameEnrichRow(row), true));
            }
          );
        });
      }
    );
  });

  app.put('/api/allgame/accounts/:portal_id/:username', (req, res) => {
    const portalId = allgameNormalizePortalId(req.params.portal_id);
    const username = String(req.params.username || '').trim();
    const payload = allgameNormalizePayload(req.body);
    if (payload.portal_id && payload.portal_id !== portalId) {
      return res.status(400).json({
        ok: false,
        error: 'Không đổi portal_id qua PUT — xóa và tạo lại nếu cần',
      });
    }
    const keys = Object.keys(payload).filter(
      (k) => ALLGAME_EDITABLE.has(k) && k !== 'portal_id'
    );
    if (!keys.length) {
      return res.status(400).json({ ok: false, error: 'Không có trường cập nhật' });
    }
    allgameDb.get(
      'SELECT * FROM accounts WHERE portal_id = ? AND username = ? COLLATE NOCASE',
      [portalId, username],
      (err, row) => {
        if (err) return res.status(500).json({ ok: false, error: err.message });
        if (!row) {
          return res.status(404).json({ ok: false, error: 'Không tìm thấy account' });
        }
        const sets = [];
        const vals = [];
        for (const k of keys) {
          if ((k === 'password' || k === 'fund_password') && payload[k] === '••••') {
            continue;
          }
          sets.push(`${k} = ?`);
          vals.push(payload[k]);
        }
        if (!sets.length) {
          return res.status(400).json({ ok: false, error: 'Không có trường cập nhật' });
        }
        if (keys.includes('daily_bet_total')) {
          sets.push('daily_bet_day = ?');
          vals.push(allgameTodayVn());
        }
        sets.push('updated_at = ?');
        vals.push(allgameNowIso());
        vals.push(portalId, username);
        const sql = `UPDATE accounts SET ${sets.join(', ')} WHERE portal_id = ? AND username = ? COLLATE NOCASE`;
        allgameDb.run(sql, vals, function (e2) {
          if (e2) {
            const msg = /UNIQUE/i.test(e2.message)
              ? 'Trùng portal_id + username'
              : e2.message;
            return res.status(400).json({ ok: false, error: msg });
          }
          allgameDb.get(
            'SELECT * FROM accounts WHERE portal_id = ? AND username = ? COLLATE NOCASE',
            [portalId, username],
            (e3, updated) => {
              if (e3) return res.status(500).json({ ok: false, error: e3.message });
              res.json(allgamePublicRow(allgameEnrichRow(updated), true));
            }
          );
        });
      }
    );
  });

  app.get('/api/allgame/accounts-export.csv', (req, res) => {
    const { sql, params } = allgameAccountsSelectSql(req.query);
    allgameDb.all(sql, params, (err, rows) => {
      if (err) return res.status(500).send(err.message);
      const header = [
        'portal_id',
        'username',
        'phone',
        'account_holder',
        'bank_code',
        'bank_name',
        'account_number',
        'proxy',
        'device',
        'balance',
        'daily_bet_total',
        'status',
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
      const fname = `allgame_accounts_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.send('\uFEFF' + lines.join('\n'));
    });
  });

  /** Chuẩn bị acc + URL trước khi mở Chrome / post-open. */
  function loadAccountForChrome(portalId, username, callback) {
    allgameDb.get(
      'SELECT * FROM accounts WHERE portal_id = ? AND username = ? COLLATE NOCASE',
      [portalId, username],
      (err, acc) => {
        if (err) return callback(err);
        if (!acc) {
          const e = new Error('Không tìm thấy account');
          e.status = 404;
          return callback(e);
        }
        if (!String(acc.proxy || '').trim()) {
          const e = new Error('Acc chưa có proxy — nhập proxy trên CMS rồi mở Chrome');
          e.status = 400;
          return callback(e);
        }
        allgameDb.get(
          'SELECT site_url, display_name FROM portals WHERE portal_id = ?',
          [portalId],
          (pErr, portalRow) => {
            if (pErr) return callback(pErr);
            let proxyLabel = '';
            try {
              proxyLabel = validateSocks5Proxy(acc.proxy || '');
            } catch (e) {
              e.status = 400;
              return callback(e);
            }
            const openUrl = normalizePortalOpenUrl(portalRow && portalRow.site_url);
            const hadProfile = !!(
              acc.chrome_browser_dir && String(acc.chrome_browser_dir).trim()
            );
            const profile = ensureAllgameChromeProfile(portalId, username);
            const browserDir = acc.chrome_browser_dir || profile.browserDir;
            const cdpPort = acc.chrome_cdp_port || profile.cdpPort;
            callback(null, {
              acc,
              accLaunch: {
                ...acc,
                portal_id: portalId,
                chrome_browser_dir: browserDir,
                chrome_cdp_port: cdpPort,
              },
              openUrl,
              hadProfile,
              proxyLabel,
              browserDir,
              cdpPort,
            });
          }
        );
      }
    );
  }

  function persistChromePaths(portalId, username, browserDir, cdpPort, basePayload, extra, res) {
    const now = allgameNowIso();
    allgameDb.run(
      `UPDATE accounts SET chrome_browser_dir = ?, chrome_cdp_port = ?, updated_at = ?
       WHERE portal_id = ? AND username = ? COLLATE NOCASE`,
      [browserDir, cdpPort, now, portalId, username],
      (upErr) => {
        if (upErr) return res.status(500).json({ ok: false, error: upErr.message });
        res.json({ ...basePayload, ...(extra || {}) });
      }
    );
  }

  function runPostOpenAfterLaunch(portalId, accLaunch, basePayload, res) {
    const firstOpen = !!basePayload.first_open;
    const cdpWaitMs = firstOpen ? 20000 : 12000;
    waitForCdpReady(basePayload.cdp_url, cdpWaitMs, (cdpWaitErr, cdpReady) => {
      if (cdpWaitErr) {
        return res.status(500).json({ ok: false, error: cdpWaitErr.message });
      }
      const payload = { ...basePayload, cdp_ready: !!cdpReady };
      if (!cdpReady) {
        payload.message += ' — CDP chưa sẵn sàng, thử lại sau vài giây';
        return persistChromePaths(
          portalId,
          accLaunch.username,
          basePayload.chrome_browser_dir,
          basePayload.cdp_port,
          payload,
          {},
          res
        );
      }
      if (!onAfterLaunch) {
        return persistChromePaths(
          portalId,
          accLaunch.username,
          basePayload.chrome_browser_dir,
          basePayload.cdp_port,
          payload,
          {},
          res
        );
      }
      onAfterLaunch(portalId, accLaunch, payload, (afterErr, afterData) => {
        if (afterErr) {
          return res.status(500).json({ ok: false, error: afterErr.message });
        }
        persistChromePaths(
          portalId,
          accLaunch.username,
          basePayload.chrome_browser_dir,
          basePayload.cdp_port,
          payload,
          afterData || {},
          res
        );
      });
    });
  }

  /** Nút CMS: chỉ mở Chrome (giống Quản lý Chrome) — không check session / WS. */
  app.post('/api/allgame/accounts/:portal_id/:username/open-chrome', (req, res) => {
    const portalId = allgameNormalizePortalId(req.params.portal_id);
    const username = String(req.params.username || '').trim();
    if (!portalId || !username) {
      return res.status(400).json({ ok: false, error: 'Thiếu portal_id hoặc username' });
    }
    loadAccountForChrome(portalId, username, (loadErr, ctx) => {
      if (loadErr) {
        return res.status(loadErr.status || 500).json({ ok: false, error: loadErr.message });
      }
      const { accLaunch, openUrl, hadProfile, proxyLabel, browserDir, cdpPort } = ctx;
      launchAllgameBrowser(accLaunch, [openUrl], (launchErr, data) => {
        if (launchErr) {
          return res.status(500).json({ ok: false, error: launchErr.message });
        }
        const viaProxy = data.proxy_label || proxyLabel;
        persistChromePaths(
          portalId,
          username,
          browserDir,
          cdpPort,
          {
            ok: true,
            launch_only: true,
            portal_id: portalId,
            username,
            first_open: !hadProfile,
            proxy: proxyLabel,
            proxy_mode: data.proxy_mode || '',
            proxy_label: viaProxy,
            chrome_browser_dir: browserDir,
            cdp_url: data.cdp_url,
            cdp_port: cdpPort,
            chrome_pid: data.pid,
            urls: data.urls,
            message: `Đã mở Chrome — ${portalId} / ${username}`,
          },
          {},
          res
        );
      });
    });
  });

  /**
   * API / tự động: mở Chrome (tùy chọn) + check session + WS (C168).
   * Body: { launch: true } — mặc định mở Chrome trước; launch: false nếu Chrome đã chạy.
   */
  app.post('/api/allgame/accounts/:portal_id/:username/open-chrome-post', (req, res) => {
    const portalId = allgameNormalizePortalId(req.params.portal_id);
    const username = String(req.params.username || '').trim();
    if (!portalId || !username) {
      return res.status(400).json({ ok: false, error: 'Thiếu portal_id hoặc username' });
    }
    const doLaunch =
      req.body && req.body.launch === false
        ? false
        : String(req.query.launch || '') !== '0';
    loadAccountForChrome(portalId, username, (loadErr, ctx) => {
      if (loadErr) {
        return res.status(loadErr.status || 500).json({ ok: false, error: loadErr.message });
      }
      const { accLaunch, openUrl, hadProfile, proxyLabel, browserDir, cdpPort } = ctx;

      const afterLaunchData = (data) => {
        const viaProxy = data.proxy_label || proxyLabel;
        const basePayload = {
          ok: true,
          post_open: true,
          portal_id: portalId,
          username,
          first_open: !hadProfile,
          proxy: proxyLabel,
          proxy_mode: data.proxy_mode || '',
          proxy_label: viaProxy,
          chrome_browser_dir: browserDir,
          cdp_url: data.cdp_url || `http://127.0.0.1:${cdpPort}`,
          cdp_port: cdpPort,
          chrome_pid: data.pid,
          urls: data.urls,
          session_alive: false,
          action: 'none',
          message: `Đã mở Chrome — ${portalId} / ${username}`,
        };
        runPostOpenAfterLaunch(portalId, accLaunch, basePayload, res);
      };

      if (!doLaunch) {
        return afterLaunchData({
          cdp_url: `http://127.0.0.1:${cdpPort}`,
          proxy_label: proxyLabel,
        });
      }
      launchAllgameBrowser(accLaunch, [openUrl], (launchErr, data) => {
        if (launchErr) {
          return res.status(500).json({ ok: false, error: launchErr.message });
        }
        afterLaunchData(data);
      });
    });
  });

  app.delete('/api/allgame/accounts/:portal_id/:username', (req, res) => {
    const portalId = allgameNormalizePortalId(req.params.portal_id);
    const username = String(req.params.username || '').trim();
    allgameDb.run(
      'DELETE FROM accounts WHERE portal_id = ? AND username = ? COLLATE NOCASE',
      [portalId, username],
      function (err) {
        if (err) return res.status(500).json({ ok: false, error: err.message });
        if (!this.changes) {
          return res.status(404).json({ ok: false, error: 'Không tìm thấy account' });
        }
        res.json({ ok: true, deleted: true, portal_id: portalId, username });
      }
    );
  });
}

function closeAllgameDb() {
  try {
    allgameDb.close();
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  registerAllgameRoutes,
  closeAllgameDb,
  allgameDb,
  ALLGAME_DB_PATH,
  allgameBrowserDirFor,
  allgameCdpPortFor,
  allgameNormalizePortalId,
  ensureAllgameChromeProfile,
  launchAllgameBrowser,
  saveSessionJsonToDb,
  validateSocks5Proxy,
  parseExecJsonLine,
};
