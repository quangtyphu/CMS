const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const tz = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(tz);

const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("game_data.db"); // sửa tên DB nếu khác

(async () => {
  console.log("🚀 Bắt đầu migrate dữ liệu…");

  const nowVN = dayjs().tz("Asia/Ho_Chi_Minh");

  // ====== DAY RANGE ======
  const startOfDayUTC = nowVN.startOf("day").utc().format("YYYY-MM-DD HH:mm:ss");
  const endOfDayUTC   = nowVN.endOf("day").utc().format("YYYY-MM-DD HH:mm:ss");

  // ====== WEEK RANGE (Chủ nhật → Thứ 7) ======
  const dow = nowVN.day(); // 0=CN
  const startOfWeekVN = nowVN.subtract(dow, "day").startOf("day");
  const endOfWeekVN   = startOfWeekVN.add(6, "day").endOf("day");

  const startOfWeekUTC = startOfWeekVN.utc().format("YYYY-MM-DD HH:mm:ss");
  const endOfWeekUTC   = endOfWeekVN.utc().format("YYYY-MM-DD HH:mm:ss");

  // ====== MONTH RANGE (30 → 29) ======
  let startVNOfMonth, endVNOfMonth;

  if (nowVN.date() >= 30) {
    startVNOfMonth = nowVN.date(30).startOf("day");
    endVNOfMonth   = nowVN.add(1, "month").date(29).endOf("day");
  } else {
    startVNOfMonth = nowVN.subtract(1, "month").date(30).startOf("day");
    endVNOfMonth   = nowVN.date(29).endOf("day");
  }

  const startOfMonthUTC = startVNOfMonth.utc().format("YYYY-MM-DD HH:mm:ss");
  const endOfMonthUTC   = endVNOfMonth.utc().format("YYYY-MM-DD HH:mm:ss");

  // ====== Lấy danh sách user ======
  const users = await allAsync(db, `SELECT username FROM accounts`);

  for (const u of users) {
    const username = u.username;

    // tổng all
    const totalAll = await getSum(`
      SELECT SUM(amount) AS s 
      FROM bet_history 
      WHERE username = ? AND game='LC79'
    `, [username]);

    // tổng ngày
    const totalDay = await getSum(`
      SELECT SUM(amount) AS s 
      FROM bet_history 
      WHERE username = ? AND game='LC79'
      AND time BETWEEN ? AND ?
    `, [username, startOfDayUTC, endOfDayUTC]);

    // tổng tuần
    const totalWeek = await getSum(`
      SELECT SUM(amount) AS s 
      FROM bet_history 
      WHERE username = ? AND game='LC79'
      AND time BETWEEN ? AND ?
    `, [username, startOfWeekUTC, endOfWeekUTC]);

    // tổng tháng
    const totalMonth = await getSum(`
      SELECT SUM(amount) AS s 
      FROM bet_history 
      WHERE username = ? AND game='LC79'
      AND time BETWEEN ? AND ?
    `, [username, startOfMonthUTC, endOfMonthUTC]);

    // insert dữ liệu
    await runAsync(db, `
      INSERT INTO bet_totals 
      (username, total_all, total_day, day_start, total_week, week_start, total_month, month_start)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      username,
      totalAll || 0,
      totalDay || 0,
      nowVN.format("YYYY-MM-DD"),
      totalWeek || 0,
      startOfWeekVN.format("YYYY-MM-DD"),
      totalMonth || 0,
      startVNOfMonth.format("YYYY-MM-DD")
    ]);

    console.log(`✔ Migrated: ${username}`);
  }

  console.log("🎉 Xong migrate!");
  process.exit();
})();

// =================== Helper Functions ===================
function allAsync(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function getSum(sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row?.s || 0);
    });
  });
}

function runAsync(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(true);
    });
  });
}
