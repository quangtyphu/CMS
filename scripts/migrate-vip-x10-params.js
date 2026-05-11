/**
 * One-off / safe re-run: migrate user_vip_x10_params to x10_next_reward_total_bet
 * if DB still has x10_missing (legacy "còn thiếu").
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'game_data.db');
const db = new sqlite3.Database(dbPath);

const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

const all = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });

const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

(async () => {
  const master = await get(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_vip_x10_params'`
  );
  if (!master || !master.sql) {
    console.log('No table user_vip_x10_params — nothing to do.');
    db.close();
    return;
  }

  const cols = await all(`PRAGMA table_info(user_vip_x10_params)`);
  const names = cols.map((c) => c.name);
  const hasMissing = names.includes('x10_missing');
  const hasNext = names.includes('x10_next_reward_total_bet');

  console.log('Columns:', names.join(', '));

  if (!hasMissing && hasNext) {
    console.log('Already migrated (has x10_next_reward_total_bet, no x10_missing).');
    db.close();
    return;
  }

  if (hasMissing && hasNext) {
    // Both columns: backfill next from total + missing where next looks unset
    await run(
      `UPDATE user_vip_x10_params
       SET x10_next_reward_total_bet = x10_total_bet + COALESCE(x10_missing, 0)
       WHERE (x10_next_reward_total_bet IS NULL OR x10_next_reward_total_bet = 0)
         AND COALESCE(x10_missing, 0) > 0`
    );
    console.log('Backfilled x10_next_reward_total_bet from x10_total_bet + x10_missing where needed.');
    db.close();
    return;
  }

  if (hasMissing && !hasNext) {
    const def = String(master.sql);
    const needsRelaxVip = /vip\s*<=\s*10000/i.test(def);

    await run(`DROP TABLE IF EXISTS user_vip_x10_params_new`);
    await run(`
      CREATE TABLE user_vip_x10_params_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        onboarding_task INTEGER NOT NULL CHECK(onboarding_task IN (1, 2, 3)),
        vip INTEGER NOT NULL DEFAULT 0 CHECK(vip >= 0),
        x10_total_bet INTEGER NOT NULL DEFAULT 0 CHECK(x10_total_bet >= 0),
        x10_next_reward_total_bet INTEGER NOT NULL DEFAULT 0 CHECK(x10_next_reward_total_bet >= 0),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    await run(
      `
      INSERT INTO user_vip_x10_params_new
        (id, username, onboarding_task, vip, x10_total_bet, x10_next_reward_total_bet, created_at, updated_at)
      SELECT
        id,
        username,
        onboarding_task,
        vip,
        x10_total_bet,
        (x10_total_bet + COALESCE(x10_missing, 0)) AS x10_next_reward_total_bet,
        created_at,
        updated_at
      FROM user_vip_x10_params
    `
    );

    await run(`DROP TABLE user_vip_x10_params`);
    await run(`ALTER TABLE user_vip_x10_params_new RENAME TO user_vip_x10_params`);

    console.log(
      'Rebuilt table: x10_missing -> x10_next_reward_total_bet (next = total + missing).' +
        (needsRelaxVip ? ' (vip CHECK relaxed to >=0)' : '')
    );
    db.close();
    return;
  }

  console.log('Unexpected schema; manual review needed.');
  db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
