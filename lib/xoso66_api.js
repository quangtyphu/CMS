/**
 * XOSO66 API trên CMS Node — mount tại /xoso66-api (thay FastAPI :8799).
 * Nạp/rút/provision: gọi Python bridge (giữ logic site), DB đọc/ghi trực tiếp SQLite CMS.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const {
  bootstrapGameData,
  loadApiKey,
  loadConfigJson,
  listAccountsEnriched,
  getAccount,
  getAccountByUsername,
  createAccount,
  updateAccount,
  deleteAccount,
  listDepositOrders,
  getDepositOrder,
  updateDepositOrder,
  listPaymentOrders,
  paymentStats,
  enrichDepositForUi,
  listDailyProfits,
  saveTodayProfit,
  publicRow,
  loadGameDomains,
  todayVnIso,
  dbRun,
  dbGet,
  dbAll,
  XOSO66_CONFIG_PATH,
} = require('./xoso66_db');
const {
  runBridge,
  forwardToMainApi,
  mainApiReachable,
  XOSO66_STANDALONE_DIR,
} = require('./xoso66_python');

const WEB_DIR = path.join(XOSO66_STANDALONE_DIR, 'web');
const QR_DIR = path.join(XOSO66_STANDALONE_DIR, 'qr_outputs');
const DEFAULT_FUND_PASSWORD = (
  process.env.XOSO66_DEFAULT_FUND_PASSWORD || '270288'
).trim();
const DEFAULT_LOGIN_PASSWORD = (
  process.env.XOSO66_DEFAULT_LOGIN_PASSWORD || 'Valentine1'
).trim();

function requireApiKey(req, res, next) {
  const expected = loadApiKey();
  if (!expected) return next();
  const got = String(req.get('X-API-Key') || '').trim();
  if (got === expected) return next();
  const ip = req.ip || req.socket?.remoteAddress || '';
  const loopback =
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    !got;
  if (loopback && !got) return next();
  return res.status(401).json({ detail: 'API key không hợp lệ' });
}

function logApi(method, p) {
  console.log(`[XOSO66-API] ${method} ${p}`, new Date().toISOString());
}

async function resolveAccountId(accountId, username) {
  if (accountId) {
    const a = await getAccount(accountId);
    if (a) return a.id;
  }
  if (username) {
    const a = await getAccountByUsername(username);
    if (a) return a.id;
  }
  return null;
}

function registerXoso66ApiRoutes(app, mountPath = '/xoso66-api') {
  bootstrapGameData();
  const router = express.Router();

  router.use((req, res, next) => {
    if (req.path.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      logApi(req.method, req.originalUrl || req.url);
    }
    next();
  });

  router.get('/api/health', (req, res) => {
    res.json({ status: 'ok', backend: 'cms-node', db: 'game_data/xoso66.db' });
  });

  router.get('/api/ui-config', (req, res) => {
    const domains = loadGameDomains();
    res.json({
      needs_api_key: !!loadApiKey(),
      api_key: loadApiKey(),
      default_fund_password: DEFAULT_FUND_PASSWORD,
      default_login_password: DEFAULT_LOGIN_PASSWORD,
      game_domains: domains,
    });
  });

  router.get('/api/game-domains', requireApiKey, (req, res) => {
    const domains = loadGameDomains();
    res.json({
      default_base_url: domains.default_base_url,
      candidates: domains.candidates,
      auto_rotate_enabled: true,
    });
  });

  router.get('/', (req, res) => {
    const index = path.join(WEB_DIR, 'index.html');
    if (!fs.existsSync(index)) {
      return res.status(404).send('Thiếu web/index.html trong xoso66_standalone');
    }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.sendFile(index);
  });

  router.get('/bulk_register.example.csv', (req, res) => {
    const p = path.join(XOSO66_STANDALONE_DIR, 'bulk_register.example.csv');
    if (!fs.existsSync(p)) return res.status(404).send('Thiếu file mẫu');
    res.download(p, 'bulk_register.example.csv');
  });

  if (fs.existsSync(QR_DIR)) {
    router.use('/qr_outputs', express.static(QR_DIR));
  }

  const auth = [requireApiKey];

  /** UI dùng ?secrets=1; cũng nhận true/yes (khớp FastAPI bool). */
  function wantSecrets(q) {
    const s = String(q || '').trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes';
  }

  router.get('/api/accounts', auth, async (req, res) => {
    try {
      const secrets = wantSecrets(req.query.secrets);
      const rows = await listAccountsEnriched({ includeSecrets: secrets });
      res.json(rows);
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.get('/api/accounts/:account_id', auth, async (req, res) => {
    try {
      const row = await getAccount(req.params.account_id);
      if (!row) return res.status(404).json({ detail: 'Không tìm thấy account' });
      const secrets = wantSecrets(req.query.secrets);
      const rows = await listAccountsEnriched({ includeSecrets: secrets });
      const hit = rows.find((r) => r.id === req.params.account_id);
      res.json(hit || publicRow(row, { includeSecrets: secrets }));
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.post('/api/accounts', auth, async (req, res) => {
    try {
      const row = await createAccount(req.body || {});
      res.json(row);
    } catch (e) {
      res.status(400).json({ detail: e.message });
    }
  });

  router.put('/api/accounts/:account_id', auth, async (req, res) => {
    try {
      const existing = await getAccount(req.params.account_id);
      if (!existing) return res.status(404).json({ detail: 'Không tìm thấy account' });
      const row = await updateAccount(req.params.account_id, req.body || {});
      res.json(row);
    } catch (e) {
      res.status(400).json({ detail: e.message });
    }
  });

  router.delete('/api/accounts/:account_id', auth, async (req, res) => {
    try {
      const ok = await deleteAccount(req.params.account_id);
      if (!ok) return res.status(404).json({ detail: 'Không tìm thấy account' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.post('/api/accounts/:account_id/refresh-balance', auth, async (req, res) => {
    try {
      const out = await runBridge('refresh_balance', {
        account_id: req.params.account_id,
        force_login: !!(req.body && req.body.force_login),
      });
      if (!out.ok) return res.status(400).json(out);
      res.json(out);
    } catch (e) {
      res.status(400).json({ detail: e.message });
    }
  });

  /** Gắn domain tay → clear session + login + lấy token minigame. */
  router.post('/api/accounts/:account_id/set-domain', auth, async (req, res) => {
    try {
      const aid = String(req.params.account_id || '').trim();
      const existing = await getAccount(aid);
      if (!existing) return res.status(404).json({ detail: 'Không tìm thấy account' });
      const body = req.body || {};
      const baseUrl = String(body.base_url || '').trim();
      const relogin = body.relogin !== false;
      // Ghi DB CMS trước (cột base_url).
      await updateAccount(aid, { base_url: baseUrl });
      const out = await runBridge(
        'set_domain',
        { account_id: aid, base_url: baseUrl, relogin },
        300000
      );
      if (!out || out.ok === false) {
        return res.status(400).json(out || { detail: 'set_domain thất bại' });
      }
      res.json(out);
    } catch (e) {
      res.status(400).json({ detail: e.message });
    }
  });

  router.post('/api/accounts/:account_id/rotate-domain', auth, async (req, res) => {
    try {
      const aid = String(req.params.account_id || '').trim();
      const existing = await getAccount(aid);
      if (!existing) return res.status(404).json({ detail: 'Không tìm thấy account' });
      const out = await runBridge('rotate_domain', { account_id: aid }, 300000);
      if (!out || out.ok === false) {
        return res.status(400).json(out || { detail: 'rotate_domain thất bại' });
      }
      // Đồng bộ base_url mới về CMS DB nếu bridge trả về.
      if (out.base_url != null || out.new) {
        await updateAccount(aid, { base_url: String(out.base_url || out.new || '') });
      }
      res.json(out);
    } catch (e) {
      res.status(400).json({ detail: e.message });
    }
  });

  router.post('/api/accounts/:account_id/sync-from-chrome', auth, async (req, res) => {
    const body = req.body || {};
    const runSync = async () => {
      if (await mainApiReachable()) {
        try {
          return await forwardToMainApi(
            'POST',
            `/api/accounts/${encodeURIComponent(req.params.account_id)}/sync-from-chrome`,
            body,
            300000
          );
        } catch (e) {
          if (e.status !== 404) throw e;
        }
      }
      return runBridge(
        'sync_from_chrome',
        {
          account_id: req.params.account_id,
          device: body.device,
          force_login: body.force_login,
          timeout_sec: body.timeout_sec,
        },
        300000
      );
    };
    try {
      const out = await runSync();
      if (!out.ok) return res.status(400).json(out);
      res.json(out);
    } catch (e) {
      res.status(400).json({ detail: e.message, ...(e.data || {}) });
    }
  });

  router.post('/api/accounts/provision', auth, async (req, res) => {
    try {
      const out = await runBridge('provision', req.body || {}, 300000);
      res.json(out);
    } catch (e) {
      res.status(400).json({ detail: e.message });
    }
  });

  router.post('/api/deposit', auth, async (req, res) => {
    const body = req.body || {};
    const account_id = String(body.account_id || '').trim();
    const amount = parseInt(body.amount, 10);
    const wait = body.wait !== false;
    if (!account_id || !amount) {
      return res.status(400).json({ detail: 'account_id và amount bắt buộc' });
    }
    if (!wait) {
      runBridge('deposit', { account_id, amount, use_handler: false }).catch((e) =>
        console.error('[XOSO66-API] deposit nền:', e.message)
      );
      return res.json({ ok: true, message: `Đang nạp ${amount} cho ${account_id}` });
    }
    try {
      const out = await runBridge('deposit', { account_id, amount, use_handler: false }, 300000);
      res.json(enrichDepositForUi(out));
    } catch (e) {
      res.status(400).json({ detail: e.message });
    }
  });

  router.post('/api/deposit/send-third-party', auth, async (req, res) => {
    const body = req.body || {};
    const username = String(body.username || '').trim();
    if (!username) {
      return res.status(400).json({ ok: false, error: 'Thiếu username' });
    }
    try {
      const out = await runBridge('send_third_party', body, 120000);
      if (!out.ok) {
        const status =
          String(out.error || '').includes('đã được gửi bên thứ 3') ? 409 : 500;
        return res.status(status).json(out);
      }
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/api/withdraw', auth, async (req, res) => {
    const body = req.body || {};
    const account_id = String(body.account_id || '').trim();
    if (!account_id) return res.status(400).json({ detail: 'account_id bắt buộc' });
    const wait = body.wait !== false;
    const runWithdraw = async () => {
      if (await mainApiReachable()) {
        return forwardToMainApi('POST', '/api/withdraw', body, 300000);
      }
      return runBridge('withdraw', body, 300000);
    };
    if (!wait) {
      runWithdraw().catch((e) =>
        console.error('[XOSO66-API] withdraw nền:', e.message)
      );
      return res.json({ ok: true, message: `Đang rút cho ${account_id}` });
    }
    try {
      const out = await runWithdraw();
      res.json(out);
    } catch (e) {
      res.status(e.status || 400).json({ detail: e.message, ...(e.data || {}) });
    }
  });

  router.get('/api/deposit-orders', auth, async (req, res) => {
    try {
      const data = await listDepositOrders({
        account_id: req.query.account_id,
        username: req.query.username,
        status: req.query.status,
        page: req.query.page,
        limit: req.query.limit,
      });
      res.json(data);
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.put('/api/deposit-orders/:order_id', auth, async (req, res) => {
    try {
      const row = await updateDepositOrder(req.params.order_id, req.body || {});
      if (!row) return res.status(404).json({ detail: 'Không tìm thấy lệnh' });
      const st = String(row.status || '').trim();
      const terminal = new Set(['Thành Công', 'Thất Bại', 'Huỷ', 'Hủy']);
      if (terminal.has(st) && row.account_id) {
        try {
          await runBridge('release_deposit_order', {
            account_id: String(row.account_id),
          });
        } catch (e) {
          console.warn(
            `[XOSO66-API] release_deposit_order ${row.account_id}:`,
            e.message
          );
        }
      }
      res.json(row);
    } catch (e) {
      res.status(400).json({ detail: e.message });
    }
  });

  router.get('/api/payment-orders', auth, async (req, res) => {
    try {
      const ot = req.query.type != null ? parseInt(req.query.type, 10) : null;
      const data = await listPaymentOrders({
        account_id: req.query.account_id,
        username: req.query.username,
        order_type: ot,
        status: req.query.status,
        page: req.query.page,
        limit: req.query.limit,
      });
      res.json(data);
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.get('/api/payment-orders/stats', auth, async (req, res) => {
    try {
      const data = await paymentStats({ username: req.query.username });
      res.json(data);
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.get('/api/daily-profits', auth, async (req, res) => {
    try {
      const rows = await listDailyProfits({
        from: req.query.from,
        to: req.query.to,
        limit: req.query.limit,
      });
      res.json({ ok: true, data: rows });
    } catch (e) {
      res.status(500).json({ ok: false, detail: e.message });
    }
  });

  router.post('/api/daily-profits/save', auth, async (req, res) => {
    try {
      const data = await saveTodayProfit();
      res.json({ ok: true, data });
    } catch (e) {
      res.status(500).json({ ok: false, detail: e.message });
    }
  });

  router.post('/api/payment-orders/sync', auth, async (req, res) => {
    const body = req.body || {};
    const aid = await resolveAccountId(body.account_id, body.username);
    if (!aid) return res.status(400).json({ detail: 'Không tìm thấy account' });
    const days = Math.max(1, parseInt(body.days, 10) || 7);
    const wait = body.wait !== false;
    if (!wait) {
      runBridge('sync_payment', { account_id: aid, days, type: body.type }).catch(() => {});
      return res.json({ ok: true, message: `Đang đồng bộ ${aid} (${days} ngày)` });
    }
    try {
      const out = await runBridge('sync_payment', {
        account_id: aid,
        days,
        type: body.type,
      });
      res.json(out);
    } catch (e) {
      res.status(400).json({ detail: e.message });
    }
  });

  router.post(
    '/api/accounts/:account_id/payment-history/sync',
    auth,
    async (req, res) => {
      const aid = req.params.account_id;
      const days = Math.max(1, parseInt(req.query.days, 10) || 7);
      const wait = String(req.query.wait) === 'true';
      const type = req.query.type != null ? parseInt(req.query.type, 10) : null;
      if (!wait) {
        runBridge('sync_payment', { account_id: aid, days, type }).catch(() => {});
        return res.json({ ok: true, message: `Đang đồng bộ lịch sử ${aid}` });
      }
      try {
        const out = await runBridge('sync_payment', { account_id: aid, days, type });
        res.json(out);
      } catch (e) {
        res.status(400).json({ detail: e.message });
      }
    }
  );

  router.get('/api/accounts/:account_id/payment-history', auth, async (req, res) => {
    try {
      const acc = await getAccount(req.params.account_id);
      if (!acc) return res.status(404).json({ detail: 'Không tìm thấy account' });
      const ot = req.query.type != null ? parseInt(req.query.type, 10) : null;
      const data = await listPaymentOrders({
        account_id: req.params.account_id,
        order_type: ot,
        status: req.query.status,
        page: req.query.page,
        limit: req.query.limit,
      });
      res.json(data);
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.post('/api/payment-orders/check-withdraw', auth, async (req, res) => {
    try {
      const out = await runBridge('check_withdraw', req.body || {}, 120000);
      res.json(out);
    } catch (e) {
      res.status(400).json({ detail: e.message });
    }
  });

  router.post('/api/missions/refresh-status', auth, async (req, res) => {
    const body = req.body || {};
    const wait = body.wait !== false;
    if (!wait) {
      runBridge('refresh_missions', body, 600000).catch(() => {});
      return res.json({ ok: true, message: 'Đang refresh mission' });
    }
    try {
      const out = await runBridge('refresh_missions', body, 600000);
      res.json(out);
    } catch (e) {
      res.status(400).json({ detail: e.message });
    }
  });

  router.post('/api/missions/auto-claim', auth, async (req, res) => {
    const body = req.body || {};
    const aids = Array.isArray(body.account_ids)
      ? body.account_ids.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    if (!aids.length) {
      return res.status(400).json({ detail: 'account_ids bắt buộc' });
    }
    const payload = { ...body, account_ids: aids, wait: body.wait !== false };
    const wait = payload.wait !== false;
    if (!wait) {
      (async () => {
        try {
          if (await mainApiReachable()) {
            await forwardToMainApi('POST', '/api/missions/auto-claim', payload, 600000);
          } else {
            await runBridge('auto_mission_claim', payload, 600000);
          }
        } catch (e) {
          console.error('[XOSO66-API] auto-claim nền:', e.message);
        }
      })();
      return res.json({ ok: true, message: `Đang auto-mission (Ck) cho ${aids.length} acc` });
    }
    try {
      let out;
      if (await mainApiReachable()) {
        out = await forwardToMainApi('POST', '/api/missions/auto-claim', payload, 600000);
      } else {
        out = await runBridge('auto_mission_claim', payload, 600000);
      }
      if (out.busy) return res.status(409).json(out);
      res.json(out);
    } catch (e) {
      res.status(e.status || 400).json({ detail: e.message, ...(e.data || {}) });
    }
  });

  router.post('/api/vip/refresh-status', auth, async (req, res) => {
    const body = req.body || {};
    const wait = body.wait !== false;
    if (!wait) {
      runBridge('refresh_vip', body, 600000).catch(() => {});
      return res.json({ ok: true, message: 'Đang refresh VIP' });
    }
    try {
      const out = await runBridge('refresh_vip', body, 600000);
      res.json(out);
    } catch (e) {
      res.status(400).json({ detail: e.message });
    }
  });

  router.post('/api/minigame/refresh', auth, async (req, res) => {
    try {
      const out = await runBridge('minigame_refresh', req.body || {});
      res.json(out);
    } catch (e) {
      res.status(400).json({ detail: e.message });
    }
  });

  router.post('/api/auto-deposit', auth, async (req, res) => {
    const body = req.body || {};
    const account_id = String(body.account_id || '').trim();
    if (!account_id) return res.status(400).json({ detail: 'account_id bắt buộc' });
    try {
      const out = await runBridge('deposit', {
        account_id,
        amount: parseInt(body.amount, 10) || undefined,
        use_handler: false,
      });
      res.json(out);
    } catch (e) {
      res.status(400).json({ detail: e.message });
    }
  });

  router.get('/api/ws-priority-accounts', auth, async (req, res) => {
    try {
      const rows = await listAccountsEnriched();
      const playing = rows.filter((r) => String(r.status || '') === 'Đang Chơi');
      playing.sort((a, b) => (Number(b.balance) || 0) - (Number(a.balance) || 0));
      res.json({
        ok: true,
        accounts: playing.map((r) => ({
          account_id: r.id,
          username: r.username,
          balance: r.balance,
          daily_bet_total: r.daily_bet_total,
        })),
      });
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });

  // ── Lì Xì Chat (phòng chat — không liên quan 21h) ─────────────────────────
  async function ensureChatLixiTable() {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS chat_lixi_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        red_id INTEGER,
        money INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        code INTEGER,
        msg TEXT NOT NULL DEFAULT '',
        vn_hour TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    await dbRun(
      'CREATE INDEX IF NOT EXISTS idx_chat_lixi_created ON chat_lixi_claims(created_at)'
    );
    await dbRun(
      'CREATE INDEX IF NOT EXISTS idx_chat_lixi_vn_hour ON chat_lixi_claims(vn_hour)'
    );
  }

  function readChatLixiEnabled() {
    const cfg = loadConfigJson();
    const block =
      cfg.auto_chat_lixi && typeof cfg.auto_chat_lixi === 'object'
        ? cfg.auto_chat_lixi
        : {};
    return {
      enabled: Boolean(block.enabled),
      minute: Number(block.minute != null ? block.minute : 1),
      parallel: Number(block.parallel != null ? block.parallel : 5),
      profile: String(block.profile || 'android_app'),
    };
  }

  function writeChatLixiEnabled(enabled) {
    const cfg = loadConfigJson();
    if (!cfg.auto_chat_lixi || typeof cfg.auto_chat_lixi !== 'object') {
      cfg.auto_chat_lixi = {
        enabled: false,
        minute: 1,
        parallel: 5,
        worker_tick_sec: 15,
        profile: 'android_app',
      };
    }
    cfg.auto_chat_lixi.enabled = Boolean(enabled);
    fs.writeFileSync(XOSO66_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return readChatLixiEnabled();
  }

  router.get('/api/chat-lixi/enabled', auth, (req, res) => {
    try {
      res.json({ ok: true, ...readChatLixiEnabled() });
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.put('/api/chat-lixi/enabled', auth, (req, res) => {
    try {
      const body = req.body || {};
      const en =
        body.enabled === true ||
        body.enabled === 1 ||
        body.enabled === '1' ||
        body.enabled === 'true';
      const out = writeChatLixiEnabled(en);
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.get('/api/chat-lixi/stats', auth, async (req, res) => {
    try {
      await ensureChatLixiTable();
      const day = todayVnIso();
      const row = await dbGet(
        `SELECT
           COALESCE(SUM(money), 0) AS today_amount,
           COUNT(*) AS today_success_count
         FROM chat_lixi_claims
         WHERE status = 'success' AND substr(created_at, 1, 10) = ?`,
        [day]
      );
      res.json({
        ok: true,
        vn_day: day,
        today_amount: Number(row?.today_amount) || 0,
        today_success_count: Number(row?.today_success_count) || 0,
        ...readChatLixiEnabled(),
      });
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });

  router.get('/api/chat-lixi/claims', auth, async (req, res) => {
    try {
      await ensureChatLixiTable();
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
      const date = String(req.query.date || '').trim();
      const username = String(req.query.username || '').trim();
      const status = String(req.query.status || '').trim();
      const where = [];
      const params = [];
      if (date) {
        where.push('substr(created_at, 1, 10) = ?');
        params.push(date);
      }
      if (username) {
        where.push('username LIKE ? COLLATE NOCASE');
        params.push(`%${username}%`);
      }
      if (status) {
        where.push('status = ?');
        params.push(status);
      }
      const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      const totalRow = await dbGet(
        `SELECT COUNT(*) AS c FROM chat_lixi_claims${clause}`,
        params
      );
      const sumFiltered = await dbGet(
        `SELECT COALESCE(SUM(CASE WHEN status = 'success' THEN money ELSE 0 END), 0) AS s
         FROM chat_lixi_claims${clause}`,
        params
      );
      const sumAll = await dbGet(
        `SELECT COALESCE(SUM(money), 0) AS s FROM chat_lixi_claims WHERE status = 'success'`
      );
      const offset = (page - 1) * limit;
      const rows = await dbAll(
        `SELECT * FROM chat_lixi_claims${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      res.json({
        ok: true,
        total: Number(totalRow?.c) || 0,
        page,
        limit,
        rows,
        total_amount_filtered: Number(sumFiltered?.s) || 0,
        total_amount_all: Number(sumAll?.s) || 0,
      });
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });

  app.use(mountPath, router);
  console.log(`[XOSO66] API Node → ${mountPath}/* (DB game_data/xoso66.db)`);
}

module.exports = { registerXoso66ApiRoutes, requireApiKey, loadApiKey };
