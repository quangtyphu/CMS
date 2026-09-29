/**
 * XOSO66 SQLite — duy nhất CMS/game_data/xoso66.db
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const CMS_GAME_DATA = path.join(__dirname, '..', 'game_data');
const XOSO66_STANDALONE_DIR =
  process.env.XOSO66_STANDALONE_DIR ||
  path.resolve(__dirname, '../../LC79/xoso66_standalone');

/** Config user — cùng file python main.py (không dùng game_data/). */
const XOSO66_CONFIG_PATH =
  process.env.XOSO66_CONFIG ||
  process.env.XOSO66_CONFIG_PATH ||
  path.join(XOSO66_STANDALONE_DIR, 'xoso66_config.json');
const XOSO66_DB_PATH =
  process.env.XOSO66_DB ||
  path.join(CMS_GAME_DATA, 'xoso66.db');
const XOSO66_BACKUP_DIR = path.join(CMS_GAME_DATA, 'backups');

const CMS_COLUMNS = [
  'id',
  'username',
  'password',
  'phone',
  'account_holder',
  'fund_password',
  'bank_code',
  'bank_name',
  'account_number',
  'proxy',
  'base_url',
  'default_card_id',
  'device',
  'total_deposit',
  'total_withdraw',
  'balance',
  'status',
  'vip_level',
  'vip_progress',
  'daily_bet_total',
  'daily_bet_day',
  'created_at',
  'updated_at',
];

let _bootstrapped = false;

function nowIso() {
  return new Date().toISOString();
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}Z`;
}

function ensureDirs() {
  fs.mkdirSync(CMS_GAME_DATA, { recursive: true });
  fs.mkdirSync(XOSO66_BACKUP_DIR, { recursive: true });
}

function bootstrapGameData() {
  if (_bootstrapped) return;
  _bootstrapped = true;
  ensureDirs();
  if (!fs.existsSync(XOSO66_DB_PATH)) {
    console.warn(
      `[XOSO66] Chưa có DB: ${XOSO66_DB_PATH} — tạo mới khi có acc hoặc restore từ backups/`
    );
  }
}

const db = new sqlite3.Database(XOSO66_DB_PATH, (err) => {
  bootstrapGameData();
  migrateDepositOrdersSchema().catch((e) =>
    console.error('[XOSO66] migrate deposit_orders:', e.message)
  );
  migrateAccountsBaseUrl().catch((e) =>
    console.error('[XOSO66] migrate accounts.base_url:', e.message)
  );
  if (err) console.error('[XOSO66] DB:', err.message);
  else console.log(`[XOSO66] DB → ${XOSO66_DB_PATH}`);
  console.log(`[XOSO66] Config → ${XOSO66_CONFIG_PATH}`);
});

/** Thêm cột mới deposit_orders (idempotent). */
async function migrateDepositOrdersSchema() {
  const table = await dbGet(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='deposit_orders'"
  );
  if (!table) return;
  const cols = await dbAll('PRAGMA table_info(deposit_orders)');
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('device_nap')) {
    await dbRun(
      "ALTER TABLE deposit_orders ADD COLUMN device_nap TEXT NOT NULL DEFAULT ''"
    );
    console.log('[XOSO66] deposit_orders +device_nap');
  }
}

/** accounts.base_url — domain site gắn per-acc ('' = mặc định config). */
async function migrateAccountsBaseUrl() {
  const table = await dbGet(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'"
  );
  if (!table) return;
  const cols = await dbAll('PRAGMA table_info(accounts)');
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('base_url')) {
    await dbRun(
      "ALTER TABLE accounts ADD COLUMN base_url TEXT NOT NULL DEFAULT ''"
    );
    console.log('[XOSO66] accounts +base_url');
  }
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function loadConfigJson() {
  bootstrapGameData();
  try {
    const raw = fs.readFileSync(XOSO66_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function loadApiKey() {
  const env = String(process.env.XOSO66_API_KEY || '').trim();
  if (env) return env;
  const cfg = loadConfigJson();
  return String(cfg.api_key || 'doi-api-key-cms').trim();
}

/** Domain list cho UI CMS (đọc xoso66_config.json → game_domains). */
function loadGameDomains() {
  const cfg = loadConfigJson();
  const gd = cfg.game_domains && typeof cfg.game_domains === 'object' ? cfg.game_domains : {};
  const fallbackDefault = 'https://hnwp57e0.whskxk5.com';
  const defaultBase = String(gd.default_base_url || fallbackDefault).trim().replace(/\/$/, '');
  const raw = Array.isArray(gd.candidates) ? gd.candidates : [];
  const seen = new Set();
  const candidates = [];
  for (const item of raw) {
    let u = String(item || '').trim().replace(/\/$/, '');
    if (!u) continue;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    if (seen.has(u)) continue;
    seen.add(u);
    candidates.push(u);
  }
  if (defaultBase && !seen.has(defaultBase)) {
    candidates.push(defaultBase);
  }
  if (!candidates.length) {
    candidates.push(
      'https://g3lbe63d.whskxk1.com',
      'https://whvcrgfb.whskxk2.com',
      'https://qyhg72o0.whskxk3.com',
      'https://sr8i5ehf.whskxk4.com',
      'https://oz8chipd.whskxk5.com',
      'https://go8iuckl.whskxk5.com',
      fallbackDefault
    );
  }
  return {
    default_base_url: defaultBase || fallbackDefault,
    candidates,
  };
}

function rowToAccount(row) {
  if (!row) return null;
  const out = { ...row };
  try {
    out.provision_log = JSON.parse(row.provision_log || '[]');
  } catch {
    out.provision_log = [];
  }
  if (out.vip_progress != null) out.vip_progress = Number(out.vip_progress) || 0;
  return out;
}

function publicRow(row, { includeSecrets = false } = {}) {
  const out = {};
  for (const k of CMS_COLUMNS) {
    if (row[k] !== undefined) out[k] = row[k];
  }
  out.provision_log = row.provision_log || [];
  if (!includeSecrets) {
    if (out.password) out.password = '******';
    if (out.fund_password) out.fund_password = '******';
  }
  return out;
}

async function nextAccountId() {
  const rows = await dbAll("SELECT id FROM accounts WHERE id GLOB 'acc[0-9]*'");
  let max = 0;
  for (const r of rows) {
    const m = /^acc(\d+)$/i.exec(String(r.id || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `acc${max + 1}`;
}

async function listAccounts() {
  const rows = await dbAll('SELECT * FROM accounts ORDER BY username COLLATE NOCASE');
  return rows.map(rowToAccount);
}

async function getAccount(accountId) {
  const row = await dbGet('SELECT * FROM accounts WHERE id = ?', [accountId]);
  return rowToAccount(row);
}

async function getAccountByUsername(username) {
  const row = await dbGet(
    'SELECT * FROM accounts WHERE username = ? COLLATE NOCASE',
    [username]
  );
  return rowToAccount(row);
}

async function createAccount(payload) {
  const id = await nextAccountId();
  const now = nowIso();
  const p = payload || {};
  await dbRun(
    `INSERT INTO accounts (
      id, username, password, phone, account_holder, fund_password,
      bank_code, bank_name, account_number, proxy, default_card_id,
      device, total_deposit, total_withdraw, balance, status, vip_level,
      vip_progress, daily_bet_total, daily_bet_day, session_json, provision_log,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      String(p.username || '').trim(),
      String(p.password || ''),
      String(p.phone || ''),
      String(p.account_holder || ''),
      String(p.fund_password || ''),
      String(p.bank_code || ''),
      String(p.bank_name || ''),
      String(p.account_number || ''),
      String(p.proxy || ''),
      p.default_card_id != null ? p.default_card_id : null,
      String(p.device || ''),
      Number(p.total_deposit) || 0,
      Number(p.total_withdraw) || 0,
      Number(p.balance) || 0,
      String(p.status || 'new'),
      String(p.vip_level || ''),
      Number(p.vip_progress) || 0,
      Number(p.daily_bet_total) || 0,
      String(p.daily_bet_day || ''),
      '{}',
      JSON.stringify(p.provision_log || []),
      now,
      now,
    ]
  );
  return getAccount(id);
}

async function updateAccount(accountId, fields) {
  const allowed = new Set([
    'username',
    'password',
    'phone',
    'account_holder',
    'fund_password',
    'bank_code',
    'bank_name',
    'account_number',
    'proxy',
    'base_url',
    'default_card_id',
    'device',
    'balance',
    'status',
    'vip_level',
    'vip_progress',
    'daily_bet_total',
    'daily_bet_day',
    'total_deposit',
    'total_withdraw',
  ]);
  const parts = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (!allowed.has(k)) continue;
    // Không cho status = URL domain (bug UI đổi domain từng ghi nhầm).
    if (k === 'status') {
      const s = String(v == null ? '' : v).trim();
      if (/^https?:\/\//i.test(s)) {
        console.warn('[XOSO66] reject status that looks like URL:', s);
        continue;
      }
    }
    parts.push(`${k} = ?`);
    vals.push(v);
  }
  if (!parts.length) return getAccount(accountId);
  // Sửa tổng cược ngày từ CMS → gắn ngày hôm nay (VN) để UI/xoso66 nhận đúng.
  if (
    Object.prototype.hasOwnProperty.call(fields || {}, 'daily_bet_total')
    && !Object.prototype.hasOwnProperty.call(fields || {}, 'daily_bet_day')
  ) {
    parts.push('daily_bet_day = ?');
    vals.push(todayVnIso());
  }
  parts.push('updated_at = ?');
  vals.push(nowIso());
  vals.push(accountId);
  await dbRun(`UPDATE accounts SET ${parts.join(', ')} WHERE id = ?`, vals);
  return getAccount(accountId);
}

async function deleteAccount(accountId) {
  const r = await dbRun('DELETE FROM accounts WHERE id = ?', [accountId]);
  return r.changes > 0;
}

async function paymentTotalsByAccount() {
  const rows = await dbAll(
    `SELECT account_id,
      COALESCE(SUM(CASE WHEN order_type = 1 THEN true_amount ELSE 0 END), 0) AS deposit,
      COALESCE(SUM(CASE WHEN order_type = 2 THEN true_amount ELSE 0 END), 0) AS withdraw
     FROM payment_orders WHERE status = 1 GROUP BY account_id`
  );
  const out = {};
  for (const r of rows) {
    out[r.account_id] = {
      deposit: Number(r.deposit) || 0,
      withdraw: Number(r.withdraw) || 0,
    };
  }
  return out;
}

/** Ngày hôm nay theo giờ VN (YYYY-MM-DD) — khớp xoso66_time_util.today_vn_str */
function todayVnIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
    new Date()
  );
}

function isoToVnDay(iso) {
  if (!iso) return '';
  try {
    let s = String(iso).trim();
    if (s.endsWith('Z')) s = s.slice(0, -1) + '+00:00';
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
      d
    );
  } catch {
    return '';
  }
}

async function missionIndexByAccount() {
  const rows = await dbAll('SELECT * FROM account_missions');
  const out = {};
  for (const r of rows) {
    const u = String(r.username || '').trim().toLowerCase();
    const aid = String(r.account_id || '').trim();
    if (u) out[`u:${u}`] = r;
    if (aid) out[`id:${aid}`] = r;
  }
  return out;
}

function missionSnapshotForAccount(accountId, username, index) {
  const u = String(username || '').trim().toLowerCase();
  const aid = String(accountId || '').trim();
  if (u && index[`u:${u}`]) return index[`u:${u}`];
  if (aid && index[`id:${aid}`]) return index[`id:${aid}`];
  return null;
}

async function vipIndexByAccount() {
  const rows = await dbAll('SELECT * FROM account_vip');
  const out = {};
  for (const r of rows) {
    const aid = String(r.account_id || '').trim();
    if (aid) out[aid] = r;
  }
  return out;
}

const DAILY_161_STATUS_LABEL = { 0: 'Chưa đủ', 1: 'Đã đủ', 2: 'Đã nhận' };

function daily161Label(status) {
  if (status === null || status === undefined) return '—';
  const n = parseInt(status, 10);
  return DAILY_161_STATUS_LABEL[n] || `?(${status})`;
}

function daily161SyncedToday(snap) {
  const day = String(snap.daily_synced_day || '').trim();
  if (day) return day === todayVnIso();
  const legacy = isoToVnDay(snap.synced_at);
  return !!legacy && legacy === todayVnIso();
}

function daily161Effective(snap) {
  if (!daily161SyncedToday(snap)) return { status: null, doneBet: 0 };
  return {
    status: snap.daily_status,
    doneBet: parseInt(snap.daily_done_bet_money, 10) || 0,
  };
}

function miniDayBadge(day, status) {
  if (status === null || status === undefined) {
    return { day, status: null, label: '—', css: 'mini-none' };
  }
  const st = parseInt(status, 10);
  if (st === 2) return { day, status: st, label: '✓', css: 'mini-done' };
  if (st === 1) return { day, status: st, label: '!', css: 'mini-claim' };
  return { day, status: st, label: '○', css: 'mini-pending' };
}

function cuaSyncedToday(snap) {
  const day = String(snap.cua_synced_day || '').trim();
  return !!day && day === todayVnIso();
}

/** 0 = chưa nhận cửa | 1 = đã nhận cửa 1 (2688k) | 2 = đã nhận cửa 2 (6888k) */
function nhiemVuCuaTier(snap) {
  if (!snap || !cuaSyncedToday(snap)) return 0;
  const s2 = snap.cua2_status;
  const s1 = snap.cua1_status;
  if (s2 !== null && s2 !== undefined && s2 !== '' && parseInt(s2, 10) === 2) return 2;
  if (s1 !== null && s1 !== undefined && s1 !== '' && parseInt(s1, 10) === 2) return 1;
  return 0;
}

function cuaLabel(status) {
  if (status === null || status === undefined) return '—';
  const n = parseInt(status, 10);
  return ({ 0: 'Chưa đủ', 1: 'Được nhận', 2: 'Đã nhận' })[n] || `?(${status})`;
}

function missionCmsFields(snap) {
  if (!snap) {
    return {
      mission_synced_at: null,
      daily_161_synced_day: null,
      daily_161_is_today: false,
      daily_161_status: null,
      daily_161_label: '—',
      daily_161_done_bet: 0,
      mini_current_day: 0,
      mini_current_status: null,
      mini_can_claim: 0,
      mini_current_label: '—',
      mini_week_days: [],
      cua1_bet_target: 2688000,
      cua1_status: null,
      cua1_label: '—',
      cua1_done_bet: 0,
      cua2_bet_target: 6888000,
      cua2_status: null,
      cua2_label: '—',
      cua2_done_bet: 0,
      cua_synced_day: null,
      cua_is_today: false,
      nhiem_vu_cua: 0,
    };
  }
  const { status: st, doneBet } = daily161Effective(snap);
  const currentDay = parseInt(snap.mini_current_day, 10) || 0;
  const dayStatuses = [];
  for (let i = 1; i <= 7; i++) dayStatuses.push(snap[`mini_day${i}_status`]);
  const badges = [];
  for (let i = 1; i <= 7; i++) badges.push(miniDayBadge(i, dayStatuses[i - 1]));

  let miniLabel = '—';
  if (currentDay > 0) {
    const allDone =
      dayStatuses.every((s) => s !== null && s !== undefined) &&
      dayStatuses.every((s) => parseInt(s, 10) === 2);
    if (allDone) miniLabel = 'Đủ 7 ngày';
    else {
      const curSt = snap.mini_current_status;
      if (curSt === 1) miniLabel = `Ngày ${currentDay} · được nhận`;
      else if (curSt === 0) miniLabel = `Ngày ${currentDay} · chưa đủ`;
      else if (curSt === 2 && currentDay < 7) miniLabel = `Ngày ${currentDay + 1}`;
      else miniLabel = `Ngày ${currentDay}`;
    }
  }

  const syncedDay =
    String(snap.daily_synced_day || '').trim() || isoToVnDay(snap.synced_at) || null;
  const cuaToday = cuaSyncedToday(snap);
  const cua1St = cuaToday && snap.cua1_status != null && snap.cua1_status !== ''
    ? parseInt(snap.cua1_status, 10)
    : null;
  const cua2St = cuaToday && snap.cua2_status != null && snap.cua2_status !== ''
    ? parseInt(snap.cua2_status, 10)
    : null;

  return {
    mission_synced_at: snap.synced_at,
    daily_161_synced_day: syncedDay,
    daily_161_is_today: daily161SyncedToday(snap),
    daily_161_status: st !== null && st !== undefined ? parseInt(st, 10) : null,
    daily_161_label: daily161Label(st),
    daily_161_done_bet: doneBet,
    mini_current_day: currentDay,
    mini_current_status:
      snap.mini_current_status != null && snap.mini_current_status !== ''
        ? parseInt(snap.mini_current_status, 10)
        : null,
    mini_can_claim: Number(snap.mini_can_claim) || 0,
    mini_current_label: miniLabel,
    mini_week_days: badges,
    cua1_bet_target: parseInt(snap.cua1_bet_target, 10) || 2688000,
    cua1_level_id: snap.cua1_level_id != null ? parseInt(snap.cua1_level_id, 10) : null,
    cua1_status: Number.isFinite(cua1St) ? cua1St : null,
    cua1_label: cuaLabel(cua1St),
    cua1_done_bet: cuaToday ? parseInt(snap.cua1_done_bet, 10) || 0 : 0,
    cua2_bet_target: parseInt(snap.cua2_bet_target, 10) || 6888000,
    cua2_level_id: snap.cua2_level_id != null ? parseInt(snap.cua2_level_id, 10) : null,
    cua2_status: Number.isFinite(cua2St) ? cua2St : null,
    cua2_label: cuaLabel(cua2St),
    cua2_done_bet: cuaToday ? parseInt(snap.cua2_done_bet, 10) || 0 : 0,
    cua_synced_day: String(snap.cua_synced_day || '').trim() || null,
    cua_is_today: cuaToday,
    nhiem_vu_cua: nhiemVuCuaTier(snap),
  };
}

function vipCmsFields(snap) {
  const labels = { 0: 'Chưa đạt', 1: 'Được nhận', 2: 'Đã nhận', 3: 'Chờ mốc' };
  if (!snap) {
    return {
      vip_synced_at: null,
      vip_upgrade_label: '—',
      vip_weekly_label: '—',
      vip_monthly_label: '—',
    };
  }
  const lbl = (s) => labels[s] || '—';
  return {
    vip_synced_at: snap.synced_at,
    vip_sync_phase: snap.sync_phase,
    vip_can_claim: Number(snap.can_claim_count) || 0,
    vip_upgrade_label: lbl(snap.upgrade_status),
    vip_weekly_label: lbl(snap.weekly_status),
    vip_monthly_label: lbl(snap.monthly_status),
  };
}

function enrichAccountRow(row, { missionIdx, vipIdx, payIdx, includeSecrets }) {
  const aid = String(row.id || '');
  const out = publicRow(row, { includeSecrets });
  const missionSnap = missionSnapshotForAccount(aid, row.username, missionIdx);
  Object.assign(out, missionCmsFields(missionSnap));
  Object.assign(out, vipCmsFields(vipIdx[aid]));
  const t = payIdx[aid] || {};
  const dep = t.deposit != null ? t.deposit : Number(row.total_deposit) || 0;
  const wd = t.withdraw != null ? t.withdraw : Number(row.total_withdraw) || 0;
  const bal = Number(row.balance) || 0;
  out.total_deposit = dep;
  out.total_withdraw = wd;
  out.profit = wd + bal - dep;
  return out;
}

async function listAccountsEnriched({ includeSecrets = false } = {}) {
  const [rows, missionIdx, vipIdx, payIdx] = await Promise.all([
    listAccounts(),
    missionIndexByAccount(),
    vipIndexByAccount(),
    paymentTotalsByAccount(),
  ]);
  return rows.map((r) =>
    enrichAccountRow(r, { missionIdx, vipIdx, payIdx, includeSecrets })
  );
}

async function listDepositOrders({ account_id, username, status, page = 1, limit = 50 }) {
  page = Math.max(1, parseInt(page, 10) || 1);
  limit = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const offset = (page - 1) * limit;
  const where = ['1=1'];
  const params = [];
  if (account_id) {
    where.push('account_id = ?');
    params.push(String(account_id));
  }
  if (username) {
    const u = `%${String(username).trim()}%`;
    where.push('(username LIKE ? OR account_id LIKE ?)');
    params.push(u, u);
  }
  if (status) {
    where.push('status = ?');
    params.push(String(status).trim());
  }
  const wsql = where.join(' AND ');
  const totalRow = await dbGet(
    `SELECT COUNT(*) AS c FROM deposit_orders WHERE ${wsql}`,
    params
  );
  const rows = await dbAll(
    `SELECT * FROM deposit_orders WHERE ${wsql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const list = rows.map((d) => {
    try {
      d.transfer_info = JSON.parse(d.transfer_json || '{}');
    } catch {
      d.transfer_info = {};
    }
    delete d.transfer_json;
    return d;
  });
  return { total: Number(totalRow?.c) || 0, page, limit, list };
}

async function updateDepositOrder(orderId, fields) {
  const allowed = new Set([
    'serial_no',
    'trade_no',
    'status',
    'site_status',
    'site_status_formatted',
    'qr_image_path',
    'transfer_json',
    'third_party_tx_id',
    'error_message',
    'da_nap_at_ms',
    'confirm_duration_sec',
    'device_nap',
  ]);
  const parts = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields || {})) {
    let key = k;
    if (key === 'deviceNap') key = 'device_nap';
    if (!allowed.has(key)) continue;
    if (k === 'transfer_json' && v && typeof v === 'object') {
      parts.push('transfer_json = ?');
      vals.push(JSON.stringify(v));
    } else {
      parts.push(`${key} = ?`);
      vals.push(v);
    }
  }
  if (!parts.length) return getDepositOrder(orderId);
  parts.push('updated_at = ?');
  vals.push(nowIso());
  vals.push(orderId);
  await dbRun(`UPDATE deposit_orders SET ${parts.join(', ')} WHERE id = ?`, vals);
  return getDepositOrder(orderId);
}

async function getDepositOrder(orderId) {
  const row = await dbGet('SELECT * FROM deposit_orders WHERE id = ?', [orderId]);
  if (!row) return null;
  try {
    row.transfer_info = JSON.parse(row.transfer_json || '{}');
  } catch {
    row.transfer_info = {};
  }
  delete row.transfer_json;
  return row;
}

async function listPaymentOrders({
  account_id,
  username,
  order_type,
  status,
  page = 1,
  limit = 50,
}) {
  page = Math.max(1, parseInt(page, 10) || 1);
  limit = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const offset = (page - 1) * limit;
  const where = ['1=1'];
  const params = [];
  if (account_id) {
    where.push('account_id = ?');
    params.push(String(account_id));
  }
  if (username) {
    const u = `%${String(username).trim()}%`;
    where.push('(username LIKE ? OR account_id LIKE ?)');
    params.push(u, u);
  }
  if (order_type === 1 || order_type === 2) {
    where.push('order_type = ?');
    params.push(order_type);
  }
  if (status != null && status !== '') {
    where.push('status = ?');
    params.push(parseInt(status, 10));
  }
  const wsql = where.join(' AND ');
  const totalRow = await dbGet(
    `SELECT COUNT(*) AS c FROM payment_orders WHERE ${wsql}`,
    params
  );
  const rows = await dbAll(
    `SELECT * FROM payment_orders WHERE ${wsql} ORDER BY create_time_ms DESC, serial_no DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { total: Number(totalRow?.c) || 0, page, limit, list: rows };
}

async function paymentStats({ username } = {}) {
  let where = 'status = 1';
  const params = [];
  if (username) {
    where += ' AND (username LIKE ? OR account_id LIKE ?)';
    const u = `%${String(username).trim()}%`;
    params.push(u, u);
  }
  const row = await dbGet(
    `SELECT
      COALESCE(SUM(CASE WHEN order_type = 1 THEN true_amount ELSE 0 END), 0) AS total_deposit,
      COALESCE(SUM(CASE WHEN order_type = 2 THEN true_amount ELSE 0 END), 0) AS total_withdraw
     FROM payment_orders WHERE ${where}`,
    params
  );
  const accounts = await listAccountsEnriched();
  let filtered = accounts;
  if (username) {
    const low = String(username).trim().toLowerCase();
    filtered = accounts.filter(
      (a) =>
        String(a.id) === username ||
        String(a.username || '').toLowerCase() === low
    );
  }
  const balance = filtered.reduce((s, a) => s + (Number(a.balance) || 0), 0);
  const dep = Number(row?.total_deposit) || 0;
  const wd = Number(row?.total_withdraw) || 0;
  const profit = wd + balance - dep;
  return {
    ok: true,
    scope: username ? 'account' : 'all',
    total_deposit: dep,
    total_withdraw: wd,
    balance,
    total_balance: balance,
    profit,
    account_count: filtered.length,
  };
}

async function ensureDailyProfitsTable() {
  await dbRun(`CREATE TABLE IF NOT EXISTS daily_profits (
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
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

/** Mốc ms đầu/cuối ngày theo giờ VN (YYYY-MM-DD). */
function vnDayBoundsMs(dateStr) {
  const d = dateStr || todayVnIso();
  return {
    start: Date.parse(`${d}T00:00:00+07:00`),
    end: Date.parse(`${d}T23:59:59.999+07:00`),
  };
}

async function calculateTodayProfit() {
  await ensureDailyProfitsTable();
  const today = todayVnIso();
  const { start, end } = vnDayBoundsMs(today);

  const totals = await dbGet(
    `SELECT
      COALESCE(SUM(CASE WHEN order_type = 1 THEN true_amount ELSE 0 END), 0) AS total_deposit,
      COALESCE(SUM(CASE WHEN order_type = 2 THEN true_amount ELSE 0 END), 0) AS total_withdraw
     FROM payment_orders WHERE status = 1`
  );

  const dayRow = await dbGet(
    `SELECT
      COALESCE(SUM(CASE WHEN order_type = 1 THEN true_amount ELSE 0 END), 0) AS deposit_day,
      COALESCE(SUM(CASE WHEN order_type = 2 THEN true_amount ELSE 0 END), 0) AS withdraw_day
     FROM payment_orders
     WHERE status = 1
       AND COALESCE(create_time_ms, 0) >= ?
       AND COALESCE(create_time_ms, 0) <= ?`,
    [start, end]
  );

  const accounts = await listAccountsEnriched();
  const totalBalance = accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);
  let totalBetDay = 0;
  for (const a of accounts) {
    if (String(a.daily_bet_day || '').trim() === today) {
      totalBetDay += Number(a.daily_bet_total) || 0;
    }
  }

  const totalDeposit = Number(totals?.total_deposit) || 0;
  const totalWithdraw = Number(totals?.total_withdraw) || 0;
  const depositDay = Number(dayRow?.deposit_day) || 0;
  const withdrawDay = Number(dayRow?.withdraw_day) || 0;
  const profit = totalWithdraw + totalBalance - totalDeposit;

  return {
    date: today,
    total_deposit: totalDeposit,
    total_withdraw: totalWithdraw,
    deposit_day: depositDay,
    withdraw_day: withdrawDay,
    total_balance: totalBalance,
    profit,
    total_bet_day: totalBetDay,
    account_count: accounts.length,
  };
}

async function saveTodayProfit() {
  const data = await calculateTodayProfit();
  await dbRun(
    `INSERT OR REPLACE INTO daily_profits
      (date, total_deposit, total_withdraw, deposit_day, withdraw_day,
       total_balance, profit, total_bet_day, account_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.date,
      data.total_deposit,
      data.total_withdraw,
      data.deposit_day,
      data.withdraw_day,
      data.total_balance,
      data.profit,
      data.total_bet_day,
      data.account_count,
    ]
  );
  return data;
}

async function listDailyProfits({ from, to, limit = 30 } = {}) {
  await ensureDailyProfitsTable();
  let rows;
  if (from && to) {
    rows = await dbAll(
      'SELECT * FROM daily_profits WHERE date BETWEEN ? AND ? ORDER BY date DESC',
      [from, to]
    );
  } else {
    const lim = Math.max(1, Math.min(365, parseInt(limit, 10) || 30));
    rows = await dbAll(
      'SELECT * FROM daily_profits ORDER BY date DESC LIMIT ?',
      [lim]
    );
  }

  const today = todayVnIso();
  const shouldIncludeToday =
    !from || !to || (today >= String(from) && today <= String(to));
  if (shouldIncludeToday) {
    try {
      const todayData = await calculateTodayProfit();
      const idx = rows.findIndex((r) => r.date === today);
      if (idx >= 0) rows[idx] = todayData;
      else rows.unshift(todayData);
    } catch (e) {
      console.error('[XOSO66] calculateTodayProfit:', e.message);
    }
  }
  return rows;
}

function enrichDepositForUi(out) {
  const aid = String(out.account_id || '');
  const ti = out.transfer_info && typeof out.transfer_info === 'object' ? out.transfer_info : {};
  if (out.qr_image_path) {
    out.qr_image_url = '/qr_outputs/' + path.basename(String(out.qr_image_path)).replace(/\\/g, '/');
  }
  const uri = ti.qr_data_uri;
  if (typeof uri === 'string' && uri.startsWith('data:') && uri.includes(',')) {
    out.qr_base64 = uri.split(',', 2)[1];
  }
  const ok = !!out.ok;
  out.message = ok
    ? 'Tạo lệnh nạp tiền thành công'
    : `Tạo lệnh nạp tiền thất bại: ${out.error || 'unknown'}`;
  const bankName = ti.bank_name || out.bank || '';
  out.data = {
    username: out.username || aid,
    account_id: aid,
    orderId: out.order_id,
    order_id: out.order_id,
    name: ti.account_name || out.account_holder || '',
    accountHolder: ti.account_name || out.account_holder || '',
    receiver: ti.account_no || out.account_number || '',
    accountNumber: ti.account_no || out.account_number || '',
    amount: out.amount || ti.amount,
    msg: ti.transfer_content || out.transfer_content || '',
    transferContent: ti.transfer_content || out.transfer_content || '',
    bank: bankName,
    type: bankName,
    qr_link: out.qr_image_url || ti.qr_url || out.qr_link || '',
    qrLink: out.qr_image_url || ti.qr_url || out.qr_link || '',
    qr_base64: out.qr_base64 || ti.qr_base64 || '',
    qrBase64: out.qr_base64 || ti.qr_base64 || '',
    qrImagePath: out.qr_image_path || '',
    qr_image_path: out.qr_image_path || '',
    expired: ti.expire_seconds || 300,
    pay_url: out.pay_url,
    trade_no: out.trade_no,
    method: out.method || '',
    transfer_info_error: out.transfer_info_error || '',
    deposit_raw_error: out.error || '',
  };
  return out;
}

module.exports = {
  XOSO66_DB_PATH,
  XOSO66_CONFIG_PATH,
  CMS_GAME_DATA,
  bootstrapGameData,
  loadConfigJson,
  loadApiKey,
  loadGameDomains,
  db,
  dbRun,
  dbGet,
  dbAll,
  listAccounts,
  listAccountsEnriched,
  getAccount,
  getAccountByUsername,
  createAccount,
  updateAccount,
  deleteAccount,
  enrichAccountRow,
  listDepositOrders,
  getDepositOrder,
  updateDepositOrder,
  listPaymentOrders,
  paymentStats,
  enrichDepositForUi,
  ensureDailyProfitsTable,
  calculateTodayProfit,
  saveTodayProfit,
  listDailyProfits,
  publicRow,
  todayVnIso,
  vnDayBoundsMs,
  missionCmsFields,
  missionSnapshotForAccount,
};
