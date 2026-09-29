# -*- coding: utf-8 -*-
"""Kiem tra do lech proxy giua chrome_profiles -> user_profiles / accounts."""
import os
import sqlite3

BASE = r"C:\Users\Quang\Documents\CMS"
GAME_DB = os.path.join(BASE, "game_data.db")
X66_DB = os.path.join(BASE, "game_data", "xoso66.db")

g = sqlite3.connect(GAME_DB)
g.row_factory = sqlite3.Row
gc = g.cursor()

profiles = gc.execute(
    "SELECT id, device, lc79_username, proxy FROM chrome_profiles ORDER BY id"
).fetchall()
print(f"chrome_profiles: {len(profiles)}")

up_cols = [r[1] for r in gc.execute("PRAGMA table_info(user_profiles)").fetchall()]
print("user_profiles cols:", up_cols)

need_lc79 = 0
need_x66 = 0
no_match = []

x66 = None
if os.path.exists(X66_DB):
    x66 = sqlite3.connect(X66_DB)
    x66.row_factory = sqlite3.Row
    xc = x66.cursor()
else:
    print("!! khong thay xoso66.db:", X66_DB)

for p in profiles:
    dev = (p["device"] or "").strip().lower()
    proxy = (p["proxy"] or "").strip()
    if not dev:
        continue
    rows = gc.execute(
        """SELECT username, proxy FROM user_profiles
           WHERE username IN (SELECT username FROM accounts WHERE LOWER(TRIM(device)) = ?)
              OR LOWER(TRIM(device)) = ?""",
        (dev, dev),
    ).fetchall()
    hit = 0
    for r in rows:
        if (r["proxy"] or "").strip() != proxy:
            need_lc79 += 1
        hit += 1
    if x66:
        xrows = xc.execute(
            "SELECT username, proxy FROM accounts WHERE LOWER(TRIM(device)) = ?", (dev,)
        ).fetchall()
        for r in xrows:
            if (r["proxy"] or "").strip() != proxy:
                need_x66 += 1
            hit += 1
    if hit == 0:
        no_match.append((p["id"], p["device"], p["lc79_username"]))

print(f"user_profiles can update: {need_lc79}")
print(f"xoso66 accounts can update: {need_x66}")
print(f"device khong khop o dau ca: {len(no_match)}")
for r in no_match[:15]:
    print("  ", r)

g.close()
if x66:
    x66.close()
