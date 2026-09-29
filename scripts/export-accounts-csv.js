#!/usr/bin/env node
/**
 * Xuất danh sách tài khoản từ game_data.db (cùng thư mục server.js).
 *
 *   node scripts/export-accounts-csv.js
 *   node scripts/export-accounts-csv.js --game LC79
 *   node scripts/export-accounts-csv.js -o C:\temp\acc.csv
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const CMS_DIR = path.resolve(__dirname, '..');
const DB_PATH = path.join(CMS_DIR, 'game_data.db');

function parseArgs(argv) {
  const out = { game: '', output: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--game' || a === '-g') out.game = String(argv[++i] || '').trim();
    else if (a === '--output' || a === '-o') out.output = String(argv[++i] || '').trim();
  }
  return out;
}

function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function run() {
  const { game, output } = parseArgs(process.argv);
  if (!fs.existsSync(DB_PATH)) {
    console.error('Không thấy DB:', DB_PATH);
    process.exit(1);
  }

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

  const db = new sqlite3.Database(DB_PATH);
  db.all(sql, params, (err, rows) => {
    db.close();
    if (err) {
      console.error(err.message);
      process.exit(1);
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
    const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const outPath =
      output ||
      path.join(CMS_DIR, `accounts_export${game ? `_${game}` : ''}_${ts}.csv`);
    fs.writeFileSync(outPath, body, 'utf8');
    console.log(`Đã xuất ${(rows || []).length} dòng → ${outPath}`);
  });
}

run();
