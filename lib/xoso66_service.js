/**
 * XOSO66 trên CMS — API Node (SQLite game_data/xoso66.db), không chạy xoso66_api.py :8799.
 * Nạp/rút/provision vẫn gọi Python bridge (logic site).
 */
const path = require('path');
const schedule = require('node-schedule');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { registerXoso66ApiRoutes } = require('./xoso66_api');
const {
  XOSO66_DB_PATH,
  XOSO66_CONFIG_PATH,
  bootstrapGameData,
  loadApiKey,
  saveTodayProfit,
} = require('./xoso66_db');

dayjs.extend(utc);
dayjs.extend(timezone);

let _dailyProfitSchedulerStarted = false;

function startXoso66DailyProfitScheduler() {
  if (_dailyProfitSchedulerStarted) return;
  _dailyProfitSchedulerStarted = true;

  const rule = new schedule.RecurrenceRule();
  rule.hour = 23;
  rule.minute = 59;
  rule.second = 0;
  rule.tz = 'Asia/Ho_Chi_Minh';

  schedule.scheduleJob(rule, async () => {
    const nowVN = dayjs().tz('Asia/Ho_Chi_Minh');
    console.log(
      `[XOSO66] ${nowVN.format('YYYY-MM-DD HH:mm:ss')} — lưu lợi nhuận ngày…`
    );
    try {
      const result = await saveTodayProfit();
      console.log(
        `[XOSO66] ✅ Đã lưu lợi nhuận ngày ${result.date} | profit=${result.profit.toLocaleString('vi-VN')}`
      );
    } catch (e) {
      console.error('[XOSO66] ❌ Lưu lợi nhuận ngày:', e.message);
    }
  });

  console.log(
    '[XOSO66] Schedule: tự động lưu lợi nhuận ngày lúc 23:59 (Asia/Ho_Chi_Minh)'
  );
}

const XOSO66_STANDALONE_DIR =
  process.env.XOSO66_STANDALONE_DIR ||
  path.resolve(__dirname, '../../LC79/xoso66_standalone');

/** @deprecated — không còn proxy Python :8799 */
const XOSO66_API_PORT = parseInt(process.env.XOSO66_API_PORT || '8799', 10);
const XOSO66_API_BASE = `http://127.0.0.1:${XOSO66_API_PORT}`;

function registerXoso66Routes(app) {
  bootstrapGameData();
  registerXoso66ApiRoutes(app, '/xoso66-api');
  startXoso66DailyProfitScheduler();

  app.get('/api/xoso66/health', (req, res) => {
    res.json({
      ok: true,
      backend: 'cms-node',
      db: XOSO66_DB_PATH,
      config: XOSO66_CONFIG_PATH,
      proxy_path: '/xoso66-api',
      python_api: false,
      bridge: path.join(XOSO66_STANDALONE_DIR, 'xoso66_cms_bridge.py'),
    });
  });

  app.post('/api/xoso66/ensure', (req, res) => {
    res.json({
      ok: true,
      already_running: true,
      mode: 'cms-node',
      message: 'Không cần spawn xoso66_api.py — API đã nằm trong CMS Node',
      url: '/xoso66-api',
    });
  });
}

async function ensureXoso66Api() {
  return {
    ok: true,
    already_running: true,
    mode: 'cms-node',
    url: '/xoso66-api',
  };
}

async function fetchHealth() {
  return true;
}

module.exports = {
  registerXoso66Routes,
  ensureXoso66Api,
  fetchHealth,
  startXoso66DailyProfitScheduler,
  XOSO66_API_BASE,
  XOSO66_CONFIG_PATH,
  XOSO66_STANDALONE_DIR,
  XOSO66_AUTO_START: false,
  loadApiKey,
};
