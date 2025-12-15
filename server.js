
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const app = express();
const PORT = 3000;
// 🧩 Thêm ở đầu file (sau các require khác)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
app.use(cors());
app.use(bodyParser.json());

// ------------------- Kết nối SQLite -------------------
const db = new sqlite3.Database('./game_data.db', (err) => {
  if (err) {
    console.error("❌ Lỗi khi kết nối DB:", err.message);
  } else {
    console.log("✅ Kết nối SQLite thành công.");
  }
});
db.serialize();
// ------------------- Tạo bảng -------------------
process.on('SIGINT', () => {
  console.log("🛑 Server dừng, đóng kết nối DB/WS...");
  db.close();
  process.exit();
});
// Account
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
  accountNumber TEXT,
  accountHolder TEXT,
  bank TEXT,
  username TEXT,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// TransactionDetail
db.run(`CREATE TABLE IF NOT EXISTS transaction_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  nickname TEXT,
  hinhThuc TEXT CHECK(hinhThuc IN ('Nạp tiền','Rút tiền')) NOT NULL,
  transactionId TEXT NOT NULL,
  amount INTEGER NOT NULL,
  time DATETIME NOT NULL,
  deviceNap TEXT DEFAULT ''
)`);
// DeviceReport
db.run(`CREATE TABLE IF NOT EXISTS device_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hostname TEXT UNIQUE,
  ip TEXT,
  devices TEXT,
  last_seen DATETIME
)`);
// BetHistory
db.run(`CREATE TABLE IF NOT EXISTS bet_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT,
  device TEXT,
  username TEXT,
  amount INTEGER,
  door TEXT,

  -- field mới
  status TEXT CHECK(status IN ('success','failed','won','lost','placed')) DEFAULT 'placed',
  balance INTEGER,     -- số dư sau bet hoặc sau kết quả
  prize INTEGER,       -- tiền thắng
  dices TEXT,          -- lưu mảng xúc xắc dạng JSON string

  time DATETIME DEFAULT (datetime('now'))
)`);

db.run(`
  CREATE TABLE IF NOT EXISTS deposit_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    accountNumber TEXT,
    accountHolder TEXT,
    transferContent TEXT,
    status TEXT CHECK(status IN ('pending','processing','completed','failed','cancelled')) DEFAULT 'pending',
    createdAt TEXT DEFAULT (datetime('now')),
    updatedAt TEXT DEFAULT (datetime('now'))
  )
`, (err) => {
  if (err) console.error("❌ Lỗi khi tạo bảng deposit_orders:", err.message);
  else console.log("✅ Bảng deposit_orders đã sẵn sàng.");
});

// ------------------- API: Tạo lệnh nạp tiền -------------------
app.post('/api/deposit-orders', (req, res) => {
  const { username, accountNumber, accountHolder, transferContent } = req.body;
  if (!username) return res.status(400).json({ error: 'Thiếu username' });

  const sql = `INSERT INTO deposit_orders (username, accountNumber, accountHolder, transferContent, status, createdAt, updatedAt)
               VALUES (?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`;
  db.run(sql, [username, accountNumber || '', accountHolder || '', transferContent || ''], function (err) {
    if (err) {
      console.error("❌ Lỗi khi tạo lệnh nạp:", err.message);
      return res.status(500).json({ error: 'Không thể tạo lệnh nạp' });
    }
    res.json({ success: true, id: this.lastID });
  });
});

// ------------------- API: Lấy danh sách lệnh nạp (có lọc/phân trang) -------------------
app.get('/api/deposit-orders', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.max(1, parseInt(req.query.limit) || 50);
  const offset = (page - 1) * limit;
  const status = req.query.status; // filter theo status nếu có

  let sqlCount = `SELECT COUNT(*) as total FROM deposit_orders`;
  let sqlData = `SELECT * FROM deposit_orders`;
  const params = [];

  if (status) {
    sqlCount += ` WHERE status = ?`;
    sqlData += ` WHERE status = ?`;
    params.push(status);
  }

  sqlData += ` ORDER BY createdAt DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  db.get(sqlCount, status ? [status] : [], (err, countRow) => {
    if (err) return res.status(500).json({ error: err.message });
    const total = countRow?.total || 0;

    db.all(sqlData, params, (err2, rows) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ page, limit, totalItems: total, totalPages: Math.ceil(total / limit), data: rows });
    });
  });
});

// ------------------- API: Cập nhật trạng thái lệnh nạp -------------------
app.put('/api/deposit-orders/:id', (req, res) => {
  const { id } = req.params;
  const { status, accountNumber, accountHolder, transferContent } = req.body;

  const updates = [];
  const values = [];
  if (status) { updates.push('status = ?'); values.push(status); }
  if (accountNumber !== undefined) { updates.push('accountNumber = ?'); values.push(accountNumber); }
  if (accountHolder !== undefined) { updates.push('accountHolder = ?'); values.push(accountHolder); }
  if (transferContent !== undefined) { updates.push('transferContent = ?'); values.push(transferContent); }

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


// API kiểm tra lệnh nạp đầu tiên trong ngày của 1 user
app.get('/api/first-deposit-today/:username', (req, res) => {
  const username = req.params.username;
  const startOfDayVN = dayjs().tz('Asia/Ho_Chi_Minh').startOf('day').format('YYYY-MM-DD HH:mm:ss');
  db.get(
    `SELECT * FROM transaction_details 
     WHERE username = ? AND hinhThuc = 'Nạp tiền' 
     AND time >= ? 
     ORDER BY time ASC, id ASC LIMIT 1`,
    [username, startOfDayVN],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: 'Lỗi server', detail: err.message });
      }
      if (!row) {
        return res.json({
          isFirstDepositToday: false,
          isEligibleForBonus: false,
          message: 'Chưa có lệnh nạp nào trong ngày',
          firstDeposit: null
        });
      }
      const isEligible = row.amount >= 200000;
      res.json({
        isFirstDepositToday: true,
        isEligibleForBonus: isEligible,
        message: isEligible ? 'Lệnh nạp đầu tiên trong ngày >= 200k' : 'Lệnh nạp đầu tiên trong ngày < 200k',
        firstDeposit: row
      });
    }
  );
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
             SUM(CASE WHEN hinhThuc='Rút tiền' THEN amount ELSE 0 END) AS withdraw
      FROM transaction_details
      WHERE time BETWEEN ? AND ?
      GROUP BY username
    `;
    db.all(sql, [startOfDayVN, endOfDayVN], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const map = {};
      (rows || []).forEach(r => {
        map[r.username] = { deposit: r.deposit || 0, withdraw: r.withdraw || 0 };
      });
      res.json(map);
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
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

// ...existing code...

// ------------------- Lấy toàn bộ tài khoản -------------------
app.get('/api/accounts', (req, res) => {
  const sql = `SELECT * FROM accounts`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
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
      
      if (jsonLine) {
        const parsed = JSON.parse(jsonLine);
        res.json(parsed);
      } else {
        res.json(JSON.parse(result));
      }
    } catch (e) {
      console.error('❌ Lỗi parse JSON:', e.message);
      res.json({ ok: true, output: result.trim() });
    }
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
app.post('/api/accounts', (req, res) => {
  const { game, username, loginPass, phone, withdrawPass, bank, accountNumber, accountHolder, device } = req.body;

  // 1. Thêm Account
  const sqlAcc = `INSERT INTO accounts 
    (game, username, loginPass, phone, withdrawPass, bank, accountNumber, accountHolder, device) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  db.run(sqlAcc, [game, username, loginPass, phone, withdrawPass, bank, accountNumber, accountHolder, device], function (err) {
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
        // 3. Nếu chưa có thì thêm UserProfile mới
        const sqlProfile = `INSERT INTO user_profiles (username, status, device, balance) VALUES (?, ?, ?, ?)`;
        db.run(sqlProfile, [username, "Mới Tạo", device || "", 0], function (err2) {
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
        // Nếu đã có UserProfile rồi thì chỉ trả account thôi
        res.json({
          success: true,
          account: {
            id: accountId,
            username,
            game,
            device
          },
          userProfileCreated: false
        });
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


// ------------------- Lấy 1 user theo username -------------------
app.get('/api/users/:username', (req, res) => {
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
  const username = req.params.username;
  const fields = req.body;

  const updates = [];
  const values = [];

  // ✅ Chỉ cho phép cập nhật các cột này
  const allowedFields = [
    'status', 'name', 'phone', 'email', 'note', 'balance', 'jwt', 'nickname',
    // thêm các trường streak:
    'streak_date',
    'streak_current_type',
    'streak_current_len',
    'streak_win_today',
    'streak_lose_today',
    'streak_last_alert_win',
    'streak_last_alert_lose'
  ];


  for (const key in fields) {
    if (allowedFields.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }

  // ⚠️ Nếu không có field hợp lệ
  if (updates.length === 0) {
    return res.status(400).json({ error: "Không có trường hợp lệ để cập nhật" });
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

    // Trả về user sau khi update
    db.get(`SELECT * FROM user_profiles WHERE username = ?`, [username], (err3, row) => {
      if (err3) {
        return res.status(500).json({ error: "Lỗi khi lấy user sau update" });
      }
      res.json(row);
    });
  });
});

// Lấy streak của 1 user
app.get('/api/users/:username/streak', (req, res) => {
  const sql = `SELECT username, streak_date, streak_current_type, streak_current_len,
                      streak_win_today, streak_lose_today
               FROM user_profiles WHERE username = ?`;
  db.get(sql, [req.params.username], (err, row) => {
    if (err)   return res.status(500).json({ error: "Lỗi server", detail: err.message });
    if (!row)  return res.status(404).json({ error: "Không tìm thấy user" });
    res.json(row);
  });
});

// ------------------- Đổi tên username an toàn -------------------
app.post('/api/users/rename', (req, res) => {
  const { oldUsername, newUsername } = req.body;

  if (!oldUsername || !newUsername) {
    return res.status(400).json({ success: false, error: "Thiếu oldUsername hoặc newUsername" });
  }

  if (oldUsername === newUsername) {
    return res.status(400).json({ success: false, error: "Username cũ và mới giống nhau" });
  }

  // Kiểm tra username mới đã tồn tại chưa
  db.get(`SELECT username FROM user_profiles WHERE username = ?`, [newUsername], (err, row) => {
    if (err) {
      return res.status(500).json({ success: false, error: "Lỗi kiểm tra username: " + err.message });
    }
    if (row) {
      return res.status(409).json({ success: false, error: `Username "${newUsername}" đã tồn tại` });
    }

    // Bắt đầu transaction
    db.serialize(() => {
      db.run("BEGIN TRANSACTION", (err) => {
        if (err) {
          return res.status(500).json({ success: false, error: "Không thể bắt đầu transaction: " + err.message });
        }

        let totalUpdated = 0;
        const updates = [];
        const errors = [];

        // Danh sách các bảng cần update
        const tables = [
          { name: 'user_profiles', required: true },
          { name: 'accounts', required: true },
          { name: 'transaction_details', required: false },
          { name: 'deposit_orders', required: false },
          { name: 'bet_history', required: false },
          { name: 'bet_totals', required: false },
          { name: 'streaks', required: false }
        ];

        let completed = 0;

        tables.forEach(table => {
          db.run(`UPDATE ${table.name} SET username = ? WHERE username = ?`, [newUsername, oldUsername], function(err) {
            if (err) {
              if (table.required || !err.message.includes("no such table")) {
                errors.push(`${table.name}: ${err.message}`);
              }
            } else {
              const changes = this.changes || 0;
              if (changes > 0) {
                updates.push(`${table.name}: ${changes} row(s)`);
                totalUpdated += changes;
              }
            }

            completed++;

            // Khi tất cả tables đã xử lý xong
            if (completed === tables.length) {
              if (errors.length > 0) {
                db.run("ROLLBACK", () => {
                  console.error(`❌ Rollback đổi username: ${errors.join(", ")}`);
                  res.status(500).json({ 
                    success: false, 
                    error: errors.join("; "),
                    details: errors
                  });
                });
              } else {
                db.run("COMMIT", (commitErr) => {
                  if (commitErr) {
                    console.error(`❌ Lỗi commit: ${commitErr.message}`);
                    return res.status(500).json({ success: false, error: "Lỗi commit: " + commitErr.message });
                  }

                  console.log(`✅ Đổi username thành công: ${oldUsername} → ${newUsername}`);
                  console.log(`   Tổng cập nhật: ${totalUpdated} records`);
                  console.log(`   Chi tiết: ${updates.join(', ')}`);

                  res.json({ 
                    success: true, 
                    totalUpdated,
                    oldUsername, 
                    newUsername,
                    updates
                  });
                });
              }
            }
          });
        });
      });
    });
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
  const sql = `SELECT * FROM accounts WHERE username = ?`;
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
  const username = req.params.username;
  const fields = req.body;

  // build SET động
  const updates = [];
  const values = [];
  for (const key in fields) {
    updates.push(`${key} = ?`);
    values.push(fields[key]);
  }
  values.push(username);

  const sql = `UPDATE accounts SET ${updates.join(", ")} WHERE username = ?`;

  db.run(sql, values, function (err) {
    if (err) {
      console.error("❌ Lỗi khi cập nhật tài khoản:", err.message);
      return res.status(500).json({ error: "Không thể cập nhật tài khoản" });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: "Không tìm thấy tài khoản" });
    }

    // 🔁 Nếu có status -> đồng bộ sang UserProfile
    if (typeof fields.status !== "undefined") {
      const sqlUser = `UPDATE user_profiles SET status = ? WHERE username = ?`;
      db.run(sqlUser, [fields.status, username], (err2) => {
        if (err2) {
          console.error("❌ Lỗi khi đồng bộ status sang UserProfile:", err2.message);
        }
      });
    }

    // Lấy lại record sau khi update
    db.get(`SELECT * FROM accounts WHERE username = ?`, [username], (err3, row) => {
      if (err3) {
        return res.status(500).json({ error: "Lỗi khi lấy tài khoản sau update" });
      }
      res.json(row);
    });
  });
});

// ------------------- Xóa tài khoản theo username -------------------
app.delete('/api/accounts/:username', (req, res) => {
  const sql = `DELETE FROM accounts WHERE username = ?`;
  db.run(sql, [req.params.username], function (err) {
    if (err) {
      console.error("❌ Lỗi khi xoá tài khoản:", err.message);
      return res.status(500).json({ error: "Không thể xoá tài khoản" });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: "Không tìm thấy tài khoản" });
    }
    res.json({ success: true });
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
    const sqlInsertTxn = `INSERT INTO transaction_details (username, hinhThuc, transactionId, amount, time, deviceNap) 
                          VALUES (?, 'Nạp tiền', ?, ?, datetime('now'), ?)`;
    const txnId = `TXN_${Date.now()}`;
    db.run(sqlInsertTxn, [username, txnId, numericAmount, fromDevice || ""], (err2) => {
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
        (username, hinhThuc, transactionId, amount, time, deviceNap) 
        VALUES (?, 'Rút tiền', ?, ?, datetime('now'), ?)`;
      db.run(sqlInsertTxn, [username, txnId, numericAmount, acc.device || ""], (err3) => {
        if (err3) {
          console.error("❌ Lỗi khi thêm TransactionDetail:", err3.message);
        }
      });

      // 4️⃣ Cộng tiền vào DeviceBalance theo device
      if (acc.device) {
        db.get(`SELECT * FROM device_balances WHERE device = ?`, [acc.device], (err4, row) => {
          if (err4) {
            console.error("❌ Lỗi khi kiểm tra DeviceBalance:", err4.message);
          }
          if (row) {
            // đã có → update
            const sqlUpdateDevice = `UPDATE device_balances 
                                     SET balance = balance + ?, updatedAt = datetime('now') 
                                     WHERE device = ?`;
            db.run(sqlUpdateDevice, [numericAmount, acc.device], (err5) => {
              if (err5) console.error("❌ Lỗi khi update DeviceBalance:", err5.message);
            });
          } else {
            // chưa có → insert mới
            const sqlInsertDevice = `INSERT INTO device_balances (device, balance, updatedAt) 
                                     VALUES (?, ?, datetime('now'))`;
            db.run(sqlInsertDevice, [acc.device, numericAmount], (err6) => {
              if (err6) console.error("❌ Lỗi khi insert DeviceBalance:", err6.message);
            });
          }
        });
      }

      // 5️⃣ Trả kết quả account sau khi update
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
      AND time BETWEEN ? AND ?
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
  const offset = (page - 1) * limit;

  // 1️⃣ Đếm tổng số bản ghi
  const sqlCount = `SELECT COUNT(*) as total FROM transaction_details`;
  db.get(sqlCount, [], (err, countRow) => {
    if (err) {
      console.error("❌ Lỗi khi đếm giao dịch:", err.message);
      return res.status(500).json({ error: "Lỗi server" });
    }

    const total = countRow.total;

    // 2️⃣ Lấy dữ liệu theo trang (🆕 thêm transactionId)
    const sqlData = `SELECT username, deviceNap AS device, hinhThuc AS type, amount, time, transactionId
                     FROM transaction_details
                     ORDER BY time DESC
                     LIMIT ? OFFSET ?`;

    db.all(sqlData, [limit, offset], (err2, rows) => {
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
        time: dayjs(t.time).tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD HH:mm:ss')
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

// ------------------- API: Lưu lịch sử cược -------------------
app.post("/api/bet-history", (req, res) => {
  try {
    const { game, device, username, amount, door, status, balance, prize, dices } = req.body;

    const sql = `INSERT INTO bet_history 
      (game, device, username, amount, door, status, balance, prize, dices, time) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`;

    db.run(
      sql,
      [
        game || null,
        device || null,
        username || null,
        amount || 0,
        door || null,
        status || "placed",
        balance || 0,
        prize || 0,
        dices ? JSON.stringify(dices) : null
      ],
      async function (err) {
        if (err) {
          console.error("❌ Lỗi khi lưu bet-history:", err.message);
          return res.status(500).json({ error: "Không thể lưu lịch sử cược" });
        }

        // ➜ Sau khi lưu bet_history → cập nhật bet_totals
        try {
          await updateTotals(username, amount);
        } catch (totalErr) {
          console.error("❌ Lỗi khi cập nhật bet_totals:", totalErr);
        }

        res.json({ success: true, id: this.lastID });
      }
    );
  } catch (err) {
    console.error("❌ Lỗi khi lưu bet-history:", err);
    res.status(500).json({ error: err.message });
  }
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

  // 🔍 Query theo UTC
  const queries = {
    day: `SELECT SUM(amount) as total FROM bet_history WHERE game='LC79' AND time BETWEEN ? AND ?`,
    week: `SELECT SUM(amount) as total FROM bet_history WHERE game='LC79' AND time BETWEEN ? AND ?`,
    month: `SELECT SUM(amount) as total FROM bet_history WHERE game='LC79' AND time BETWEEN ? AND ?`
  };

  db.get(queries.day, [startOfDayUTC, endOfDayUTC], (err1, dRow) => {
    if (err1) return res.status(500).json({ error: err1.message });

    db.get(queries.week, [startOfWeekUTC, endOfWeekUTC], (err2, wRow) => {
      if (err2) return res.status(500).json({ error: err2.message });

      db.get(queries.month, [startOfMonthUTC, endOfMonthUTC], (err3, mRow) => {
        if (err3) return res.status(500).json({ error: err3.message });

        res.json({
          game: "LC79",
          totalDay: dRow?.total || 0,
          totalWeek: wRow?.total || 0,
          totalMonth: mRow?.total || 0,
          range: {
            day: [startOfDayUTC, endOfDayUTC],
            week: [startOfWeekUTC, endOfWeekUTC],
            month: [startOfMonthUTC, endOfMonthUTC],
          },
        });
      });
    });
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

  const sqlDay = `
    SELECT a.username, SUM(b.amount) as totalDay
    FROM accounts a
    LEFT JOIN bet_history b 
      ON a.username = b.username
      AND b.game='LC79'
      AND b.time BETWEEN ? AND ?
    GROUP BY a.username
    ORDER BY a.id ASC
  `;

  const sqlWeek = `
    SELECT a.username, SUM(b.amount) as totalWeek
    FROM accounts a
    LEFT JOIN bet_history b 
      ON a.username = b.username
      AND b.game='LC79'
      AND b.time BETWEEN ? AND ?
    GROUP BY a.username
    ORDER BY a.id ASC
  `;

  const sqlMonth = `
    SELECT a.username, SUM(b.amount) as totalMonth
    FROM accounts a
    LEFT JOIN bet_history b 
      ON a.username = b.username
      AND b.game='LC79'
      AND b.time BETWEEN ? AND ?
    GROUP BY a.username
    ORDER BY a.id ASC
  `;

  const sqlAll = `
    SELECT a.username, SUM(b.amount) as totalAll
    FROM accounts a
    LEFT JOIN bet_history b 
      ON a.username = b.username
      AND b.game='LC79'
    GROUP BY a.username
    ORDER BY a.id ASC
  `;


  const statsMap = {};
  let startedAt = new Date();
  db.all(sqlDay, [startOfDayUTC, endOfDayUTC], (err1, dRows) => {
    console.log(`⏱️ Truy vấn tổng cược NGÀY xong sau ${new Date() - startedAt} ms`);
    if (err1) return res.status(500).json({ error: err1.message });
    dRows.forEach(d => statsMap[d.username] = { username: d.username, totalDay: d.totalDay || 0, totalWeek: 0, totalMonth: 0, totalAll: 0 });

    startedAt = new Date();
    db.all(sqlWeek, [startOfWeekUTC, endOfWeekUTC], (err2, wRows) => {
      console.log(`⏱️ Truy vấn tổng cược TUẦN xong sau ${new Date() - startedAt} ms`);
      if (err2) return res.status(500).json({ error: err2.message });
      wRows.forEach(w => {
        if (!statsMap[w.username]) statsMap[w.username] = { username: w.username, totalDay: 0, totalWeek: 0, totalMonth: 0, totalAll: 0 };
        statsMap[w.username].totalWeek = w.totalWeek || 0;
      });

      startedAt = new Date();
      db.all(sqlMonth, [startOfMonthUTC, endOfMonthUTC], (err3, mRows) => {
        console.log(`⏱️ Truy vấn tổng cược THÁNG xong sau ${new Date() - startedAt} ms`);
        if (err3) return res.status(500).json({ error: err3.message });
        mRows.forEach(m => {
          if (!statsMap[m.username]) statsMap[m.username] = { username: m.username, totalDay: 0, totalWeek: 0, totalMonth: 0, totalAll: 0 };
          statsMap[m.username].totalMonth = m.totalMonth || 0;
        });

        // ➕ Gộp totalAll
        startedAt = new Date();
        db.all(sqlAll, [], (err4, aRows) => {
          console.log(`⏱️ Truy vấn tổng cược TẤT CẢ xong sau ${new Date() - startedAt} ms`);
          if (err4) return res.status(500).json({ error: err4.message });
          aRows.forEach(a => {
            if (!statsMap[a.username]) statsMap[a.username] = { username: a.username, totalDay: 0, totalWeek: 0, totalMonth: 0, totalAll: 0 };
            statsMap[a.username].totalAll = a.totalAll || 0;
          });

          res.json({
            game: "LC79",
            stats: Object.values(statsMap),
            range: { 
              day: [startOfDayUTC, endOfDayUTC], 
              week: [startOfWeekUTC, endOfWeekUTC], 
              month: [startOfMonthUTC, endOfMonthUTC] 
            }
          });
        });
      });
    });
  });
});


// ------------------- Lấy lịch sử cược (bet history) -------------------
app.get('/api/bet-history', (req, res) => {
  const sql = `SELECT * FROM bet_history ORDER BY time DESC`;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: "Lỗi server" });

    const result = rows.map(r => ({
      ...r,
      dices: r.dices ? JSON.parse(r.dices) : []
    }));

    res.json(result);
  });
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


// ------------------- Thống kê tổng cược theo thiết bị + game -------------------
app.get('/api/bet-history/stats', (req, res) => {
  const now = dayjs().tz('Asia/Ho_Chi_Minh');
  const startOfDay = now.startOf('day').format("YYYY-MM-DD HH:mm:ss");
  const dow = now.day();
  const startOfWeek = now.subtract(dow, 'day').startOf('day').format("YYYY-MM-DD HH:mm:ss");
  let startOfMonth;
  if (now.date() >= 31) {
    startOfMonth = now.startOf('day').format("YYYY-MM-DD HH:mm:ss");
  } else {
    startOfMonth = now.subtract(1, 'month').date(31).startOf('day').format("YYYY-MM-DD HH:mm:ss");
  }

  const runAgg = (from) => `SELECT device, game, SUM(amount) as total FROM bet_history WHERE time >= ? GROUP BY device, game`;

  db.all(runAgg(startOfDay), [startOfDay], (err1, dayRows) => {
    if (err1) return res.status(500).json({ error: err1.message });
    db.all(runAgg(startOfWeek), [startOfWeek], (err2, weekRows) => {
      if (err2) return res.status(500).json({ error: err2.message });
      db.all(runAgg(startOfMonth), [startOfMonth], (err3, monthRows) => {
        if (err3) return res.status(500).json({ error: err3.message });

        const keys = new Set([
          ...dayRows.map(r => JSON.stringify({ device: r.device, game: r.game })),
          ...weekRows.map(r => JSON.stringify({ device: r.device, game: r.game })),
          ...monthRows.map(r => JSON.stringify({ device: r.device, game: r.game }))
        ]);

        const result = Array.from(keys).map(k => {
          const key = JSON.parse(k);
          return {
            device: key.device,
            game: key.game,
            dayTotal: dayRows.find(r => r.device === key.device && r.game === key.game)?.total || 0,
            weekTotal: weekRows.find(r => r.device === key.device && r.game === key.game)?.total || 0,
            monthTotal: monthRows.find(r => r.device === key.device && r.game === key.game)?.total || 0,
          };
        });

        res.json(result);
      });
    });
  });
});


// ===================== API: Lưu giao dịch + cập nhật số dư device nếu là Rút tiền =====================
app.post('/api/transaction-details', (req, res) => {
  const { username, nickname, hinhThuc, transactionId, amount, time, deviceNap } = req.body;

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
      (username, nickname, hinhThuc, transactionId, amount, time, deviceNap) 
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(sqlInsert, [username, nickname || "", hinhThuc, transactionId, amount, time || dayjs().format("YYYY-MM-DD HH:mm:ss"), deviceNap || ""], function (err2) {
      if (err2) {
        console.error("❌ Lỗi khi lưu transaction_details:", err2.message);
        return res.status(500).json({ error: "Không thể lưu transaction", detail: err2.message });
      }

      console.log(`✅ Đã thêm giao dịch ${hinhThuc} cho user ${username}, amount = ${amount}, txn = ${transactionId}`);

      // 3️⃣ Nếu là Rút tiền → Cộng tiền vào device
      if (hinhThuc === "Rút tiền") {
        db.get(`SELECT device FROM accounts WHERE username = ?`, [username], (err3, acc) => {
          if (err3) {
            console.error("❌ Lỗi khi lấy device từ accounts:", err3.message);
            return;
          }
          if (!acc || !acc.device) {
            console.warn(`⚠️ User ${username} không có device → bỏ qua cộng tiền`);
            return;
          }

          const device = acc.device;
          console.log(`💰 Cộng ${amount} vào device ${device} (từ giao dịch rút của ${username})`);

          // Kiểm tra device có tồn tại chưa
          db.get(`SELECT * FROM device_balances WHERE device = ?`, [device], (err4, rowDevice) => {
            if (err4) {
              console.error("❌ Lỗi khi kiểm tra device_balances:", err4.message);
              return;
            }

            if (rowDevice) {
              // ✅ Đã có → update
              db.run(
                `UPDATE device_balances SET balance = balance + ?, updatedAt = datetime('now') WHERE device = ?`,
                [amount, device],
                function (err5) {
                  if (err5) console.error("❌ Lỗi khi cộng tiền device:", err5.message);
                  else console.log(`✅ Đã cộng ${amount} vào device ${device}, balance mới ≈ ${rowDevice.balance + amount}`);
                }
              );
            } else {
              // 🆕 Chưa có → insert mới
              db.run(
                `INSERT INTO device_balances (device, balance, updatedAt) VALUES (?, ?, datetime('now'))`,
                [device, amount],
                function (err6) {
                  if (err6) console.error("❌ Lỗi khi insert device:", err6.message);
                  else console.log(`✅ Đã tạo mới device ${device} với balance = ${amount}`);
                }
              );
            }
          });
        });
      }

      // 4️⃣ Trả kết quả sau khi insert
      const responseData = { 
        success: true, 
        id: this.lastID,
        transactionId: transactionId,
        type: hinhThuc,
        amount: amount,
        username: username
      };
      
      // Thêm thông tin nếu là lệnh nạp đầu tiên trong ngày >= 200k (đồng nhất với API kiểm tra)
      if (hinhThuc === "Nạp tiền") {
        const startOfDayVN = dayjs().tz('Asia/Ho_Chi_Minh').startOf('day').format('YYYY-MM-DD HH:mm:ss');
        db.get(
          `SELECT * FROM transaction_details 
           WHERE username = ? AND hinhThuc = 'Nạp tiền' 
           AND time >= ? 
           ORDER BY time ASC, id ASC LIMIT 1`,
          [username, startOfDayVN],
          (errFirst, firstRow) => {
            if (!errFirst && firstRow && firstRow.id === this.lastID && amount >= 200000) {
              responseData.isFirstDepositToday = true;
              responseData.isEligibleForBonus = true;
              responseData.message = `🎉 Lệnh nạp ĐẦU TIÊN trong ngày >= 200k`;
              console.log(`🎉 [${username}] ${responseData.message}: ${amount.toLocaleString('vi-VN')}đ`);
            } else {
              responseData.isFirstDepositToday = false;
              responseData.isEligibleForBonus = false;
            }
            if (!res.headersSent) {
              res.status(201).json(responseData);
            }
          }
        );
      } else {
        // Không phải nạp tiền, trả về luôn
        res.status(201).json(responseData);
      }
    });
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
    res.json(row);
  });
});
// ------------------- Cập nhật 1 device theo tên (cho phép đổi tên đồng bộ) -------------------
app.put('/api/device-balances/:device', (req, res) => {
  const oldDevice = req.params.device;
  const {
    device: bodyDevice,   // tên mới nếu form gửi theo key "device"
    newDevice,            // hoặc bạn có thể gửi theo key "newDevice"
    balance,
    bank,
    username,
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
            bank = ?,
            username = ?,
            accountNumber = ?,
            accountHolder = ?,
            updatedAt = datetime('now')
        WHERE device = ?
      `;
      const rMain = await run(sqlUpdateMain, [
        targetDevice,
        balance || 0,
        bank || "",
        username || "",
        accountNumber || "",
        accountHolder || "",
        oldDevice
      ]);
      if (rMain.changes === 0) {
        await run(`ROLLBACK`);
        return res.status(404).json({ error: "Device không tồn tại" });
      }

      // 4) Nếu có đổi tên -> đồng bộ các bảng liên quan
      if (targetDevice !== oldDevice) {
        await run(`UPDATE user_profiles SET device = ? WHERE device = ?`, [targetDevice, oldDevice]);
        await run(`UPDATE accounts SET device = ? WHERE device = ?`, [targetDevice, oldDevice]);
        await run(`UPDATE proxies SET device = ? WHERE device = ?`, [targetDevice, oldDevice]);
        await run(`UPDATE transaction_details SET deviceNap = ? WHERE deviceNap = ?`, [targetDevice, oldDevice]);
        await run(`UPDATE bet_history SET device = ? WHERE device = ?`, [targetDevice, oldDevice]);
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

// GET /api/bet-totals?page=1&limit=50
app.get('/api/bet-totals', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 500);
    const offset = (page - 1) * limit;
    const username = req.query.username;

    if (username) {
      await refreshBetTotalsForUser(username);
      return db.get(`SELECT * FROM bet_totals WHERE username = ?`, [username], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Không tìm thấy username' });
        return res.json(row);
      });
    }

    await refreshBetTotalsAll(); // ✅ reset theo VN nếu đổi ngày/tuần/tháng mà chưa có bet

    db.get(`SELECT COUNT(*) as total FROM bet_totals`, [], (err, countRow) => {
      if (err) return res.status(500).json({ error: err.message });
      const total = countRow?.total || 0;
      db.all(
        `SELECT * FROM bet_totals
         ORDER BY total_all DESC
         LIMIT ? OFFSET ?`,
        [limit, offset],
        (err2, rows) => {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ page, limit, totalItems: total, totalPages: Math.ceil(total/limit), data: rows });
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
                      SUM(CASE WHEN hinhThuc='Rút tiền' THEN amount ELSE 0 END) AS withdraw
               FROM transaction_details
               GROUP BY username`;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const map = {};
    rows.forEach(r => { map[r.username] = { deposit: r.deposit || 0, withdraw: r.withdraw || 0 }; });
    res.json(map);
  });
});

// ------------------- Cập nhật device cho transaction -------------------
app.put('/api/transactions/:transactionId/device', (req, res) => {
  const { transactionId } = req.params;
  const { device } = req.body;

  if (!device) {
    return res.status(400).json({ error: "Thiếu device" });
  }

  const sql = `UPDATE transaction_details SET deviceNap = ? WHERE transactionId = ?`;
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
  const { device, balance, bank, username, accountNumber, accountHolder } = req.body;

  if (!device) {
   
    return res.status(400).json({ error: "Thiếu tên device" });
  }

  const sql = `INSERT INTO device_balances (device, balance, bank, username, accountNumber, accountHolder, updatedAt) 
               VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`;

  db.run(sql, [device, balance || 0, bank || "", username || "", accountNumber || "", accountHolder || ""], function (err) {
    if (err) {
      console.error("❌ Lỗi khi thêm device:", err.message);
      return res.status(500).json({ error: "Không thể thêm device", detail: err.message });
    }
    res.json({ success: true, id: this.lastID });
  });
});

// ------------------- Lấy toàn bộ device balances -------------------
app.get('/api/device-balances', (req, res) => {
  const sql = `SELECT * FROM device_balances`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});
// ------------------- Xoá toàn bộ lịch sử cược của 1 user -------------------
app.delete('/api/bet-history/:username', (req, res) => {
  const username = req.params.username;

  if (!username) {
    return res.status(400).json({ error: "Thiếu username" });
  }

  const sql = `DELETE FROM bet_history WHERE username = ?`;
  db.run(sql, [username], function (err) {
    if (err) {
      console.error("❌ Lỗi khi xoá bet_history:", err.message);
      return res.status(500).json({ error: "Không thể xoá lịch sử cược" });
    }
    res.json({
      success: true,
      deletedRows: this.changes,
      message: `Đã xoá ${this.changes} dòng lịch sử cược của user ${username}`
    });
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
app.listen(PORT, (err) => {
  if (err) return console.error("❌ Lỗi khi khởi động server:", err);
  console.log(`Server  1 running on http://0.0.0.0:${PORT}`);
});

const path = require('path');

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
