# -*- coding: utf-8 -*-
"""Thay toan bo proxy chrome_profiles (154) + sync LC79 + xoso66 theo device."""
import json
import os
import sqlite3
from datetime import datetime

BASE = r"C:\Users\Quang\Documents\CMS"
GAME_DB = os.path.join(BASE, "game_data.db")
X66_DB = os.path.join(BASE, "game_data", "xoso66.db")
BACKUP_DIR = os.path.join(BASE, "backups")
PROXY_FILE = os.path.join(BACKUP_DIR, "new_proxies_154.txt")
os.makedirs(BACKUP_DIR, exist_ok=True)

with open(PROXY_FILE, encoding="utf-8") as f:
    proxies = [ln.strip() for ln in f if ln.strip()]

bad = [p for p in proxies if len(p.split(":")) != 4]
if bad:
    raise SystemExit(f"Proxy sai dinh dang: {bad[:5]}")
if len(set(proxies)) != len(proxies):
    raise SystemExit("Co proxy trung lap trong list moi")

ts = datetime.now().strftime("%Y%m%d_%H%M%S")
now_iso = datetime.now().isoformat(timespec="seconds")

g = sqlite3.connect(GAME_DB)
g.row_factory = sqlite3.Row
gc = g.cursor()

x66 = sqlite3.connect(X66_DB)
x66.row_factory = sqlite3.Row
xc = x66.cursor()

targets = gc.execute(
    """
    SELECT id, device, name, proxy, lc79_username
    FROM chrome_profiles
    ORDER BY id
    """
).fetchall()

print(f"Proxy moi: {len(proxies)}")
print(f"chrome_profiles: {len(targets)}")
if len(targets) != len(proxies):
    raise SystemExit(f"Khong khop: {len(proxies)} proxy vs {len(targets)} profile")

before_cp = [dict(r) for r in gc.execute(
    "SELECT id, device, name, proxy, lc79_username FROM chrome_profiles ORDER BY id"
).fetchall()]
before_up = [dict(r) for r in gc.execute(
    "SELECT username, proxy, device FROM user_profiles"
).fetchall()]
before_x66 = [dict(r) for r in xc.execute(
    "SELECT username, device, proxy FROM accounts"
).fetchall()]

bk_path = os.path.join(BACKUP_DIR, f"before_all_proxy_replace_{ts}.json")
with open(bk_path, "w", encoding="utf-8") as f:
    json.dump(
        {
            "saved_at": now_iso,
            "chrome_profiles": before_cp,
            "user_profiles": before_up,
            "xoso66_accounts": before_x66,
        },
        f,
        ensure_ascii=False,
        indent=2,
    )
print(f"Backup: {bk_path}")

mapping = []
total_lc79 = 0
total_x66 = 0
no_match = []

for row, new_proxy in zip(targets, proxies):
    old_proxy = row["proxy"] or ""
    gc.execute(
        "UPDATE chrome_profiles SET proxy = ?, updated_at = datetime('now') WHERE id = ?",
        (new_proxy, row["id"]),
    )

    dev = (row["device"] or "").strip().lower()
    n_lc79 = 0
    n_x66 = 0
    if dev:
        cur = gc.execute(
            """UPDATE user_profiles SET proxy = ?
               WHERE username IN (SELECT username FROM accounts WHERE LOWER(TRIM(device)) = ?)
                  OR LOWER(TRIM(device)) = ?""",
            (new_proxy, dev, dev),
        )
        n_lc79 += cur.rowcount or 0

        cur = xc.execute(
            "UPDATE accounts SET proxy = ?, updated_at = ? WHERE LOWER(TRIM(device)) = ?",
            (new_proxy, now_iso, dev),
        )
        n_x66 += cur.rowcount or 0

    user = (row["lc79_username"] or "").strip()
    if user:
        cur = gc.execute(
            "UPDATE user_profiles SET proxy = ? WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))",
            (new_proxy, user),
        )
        n_lc79 += cur.rowcount or 0
        cur = xc.execute(
            "UPDATE accounts SET proxy = ?, updated_at = ? WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))",
            (new_proxy, now_iso, user),
        )
        n_x66 += cur.rowcount or 0

    total_lc79 += n_lc79
    total_x66 += n_x66
    if n_lc79 == 0 and n_x66 == 0:
        no_match.append(row["device"])

    mapping.append(
        {
            "id": row["id"],
            "device": row["device"],
            "name": row["name"],
            "lc79_username": row["lc79_username"],
            "old_proxy": old_proxy,
            "new_proxy": new_proxy,
            "lc79_updated": n_lc79,
            "xoso66_updated": n_x66,
        }
    )

g.commit()
x66.commit()

map_path = os.path.join(BACKUP_DIR, f"all_proxy_replace_map_{ts}.json")
with open(map_path, "w", encoding="utf-8") as f:
    json.dump(
        {
            "replaced_at": now_iso,
            "count": len(mapping),
            "note": "Proxy STT n -> chrome_profiles id thu n (ORDER BY id)",
            "rows": mapping,
        },
        f,
        ensure_ascii=False,
        indent=2,
    )

need_lc79 = need_x66 = 0
for m in mapping:
    dev = (m["device"] or "").strip().lower()
    proxy = m["new_proxy"]
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

print(f"\nDa cap nhat chrome_profiles: {len(mapping)}")
print(f"Sync LC79 user_profiles : {total_lc79} luot")
print(f"Sync xoso66 accounts    : {total_x66} luot")
print(f"Device khong khop LC79/xoso66: {len(no_match)}")
if no_match:
    print(" ", no_match[:20], "..." if len(no_match) > 20 else "")
print(f"Con lech sau sync -> LC79: {need_lc79} | xoso66: {need_x66}")
print(f"Map: {map_path}")

print("\n=== Preview 5 dong dau ===")
for m in mapping[:5]:
    print(f"  id={m['id']} {m['device']:<8} -> {m['new_proxy']}")
print("=== Preview 5 dong cuoi ===")
for m in mapping[-5:]:
    print(f"  id={m['id']} {m['device']:<8} -> {m['new_proxy']}")

g.close()
x66.close()
