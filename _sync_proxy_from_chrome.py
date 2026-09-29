# -*- coding: utf-8 -*-
"""Dong bo proxy tu chrome_profiles -> user_profiles (game_data.db) + accounts (xoso66.db).

Mo phong syncProxyByDevice() trong server.js:
  1) user_profiles.proxy WHERE username IN (SELECT username FROM accounts WHERE device=dev) OR device=dev
  2) xoso66.accounts.proxy WHERE device=dev
  3) neu profile co lc79_username: update theo username o ca 2 bang
"""
import json
import os
import sqlite3
from datetime import datetime

BASE = r"C:\Users\Quang\Documents\CMS"
GAME_DB = os.path.join(BASE, "game_data.db")
X66_DB = os.path.join(BASE, "game_data", "xoso66.db")
BACKUP_DIR = os.path.join(BASE, "backups")
os.makedirs(BACKUP_DIR, exist_ok=True)

ts = datetime.now().strftime("%Y%m%d_%H%M%S")
now_iso = datetime.now().isoformat()

g = sqlite3.connect(GAME_DB)
g.row_factory = sqlite3.Row
gc = g.cursor()

x66 = sqlite3.connect(X66_DB)
x66.row_factory = sqlite3.Row
xc = x66.cursor()

# --- Backup truoc khi ghi ---
before_up = [dict(r) for r in gc.execute("SELECT username, proxy FROM user_profiles").fetchall()]
before_x66 = [dict(r) for r in xc.execute("SELECT username, device, proxy FROM accounts").fetchall()]
bk_path = os.path.join(BACKUP_DIR, f"proxy_sync_before_{ts}.json")
with open(bk_path, "w", encoding="utf-8") as f:
    json.dump(
        {"saved_at": now_iso, "user_profiles": before_up, "xoso66_accounts": before_x66},
        f,
        ensure_ascii=False,
        indent=2,
    )
print(f"Backup truoc khi sync: {bk_path}")
print(f"  user_profiles: {len(before_up)} | xoso66 accounts: {len(before_x66)}")

profiles = gc.execute(
    "SELECT id, device, lc79_username, proxy FROM chrome_profiles ORDER BY id"
).fetchall()

total_lc79 = 0
total_x66 = 0
no_match = []

for p in profiles:
    dev = (p["device"] or "").strip().lower()
    proxy = (p["proxy"] or "").strip()
    if not dev:
        continue

    cur = gc.execute(
        """UPDATE user_profiles SET proxy = ?
           WHERE username IN (SELECT username FROM accounts WHERE LOWER(TRIM(device)) = ?)
              OR LOWER(TRIM(device)) = ?""",
        (proxy, dev, dev),
    )
    n_lc79 = cur.rowcount or 0

    cur = xc.execute(
        "UPDATE accounts SET proxy = ?, updated_at = ? WHERE LOWER(TRIM(device)) = ?",
        (proxy, now_iso, dev),
    )
    n_x66 = cur.rowcount or 0

    user = (p["lc79_username"] or "").strip()
    if user:
        cur = gc.execute(
            "UPDATE user_profiles SET proxy = ? WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))",
            (proxy, user),
        )
        n_lc79 += cur.rowcount or 0
        cur = xc.execute(
            "UPDATE accounts SET proxy = ?, updated_at = ? WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))",
            (proxy, now_iso, user),
        )
        n_x66 += cur.rowcount or 0

    total_lc79 += n_lc79
    total_x66 += n_x66
    if n_lc79 == 0 and n_x66 == 0:
        no_match.append((p["id"], p["device"], user))

g.commit()
x66.commit()

print(f"\nDa update user_profiles (LC79): {total_lc79} luot")
print(f"Da update xoso66 accounts     : {total_x66} luot")
print(f"Profile khong khop o dau ca   : {len(no_match)}")
for r in no_match:
    print("   ", r)

# --- Kiem tra lai do lech ---
need_lc79 = 0
need_x66 = 0
for p in profiles:
    dev = (p["device"] or "").strip().lower()
    proxy = (p["proxy"] or "").strip()
    if not dev:
        continue
    for r in gc.execute(
        """SELECT proxy FROM user_profiles
           WHERE username IN (SELECT username FROM accounts WHERE LOWER(TRIM(device)) = ?)
              OR LOWER(TRIM(device)) = ?""",
        (dev, dev),
    ).fetchall():
        if (r["proxy"] or "").strip() != proxy:
            need_lc79 += 1
    for r in xc.execute(
        "SELECT proxy FROM accounts WHERE LOWER(TRIM(device)) = ?", (dev,)
    ).fetchall():
        if (r["proxy"] or "").strip() != proxy:
            need_x66 += 1

print(f"\nCon lech sau sync -> user_profiles: {need_lc79} | xoso66: {need_x66}")

g.close()
x66.close()
