# -*- coding: utf-8 -*-
"""Thay proxy chet trong chrome_profiles bang proxy chua dung (con song) tu proxy.vn.

Dong thoi sync sang LC79 (user_profiles) + xoso66 (accounts) theo device.
"""
import json
import os
import sqlite3
from datetime import datetime

BASE = r"C:\Users\Quang\Documents\CMS"
GAME_DB = os.path.join(BASE, "game_data.db")
X66_DB = os.path.join(BASE, "game_data", "xoso66.db")
BACKUP_DIR = os.path.join(BASE, "backups")
UNUSED_FILE = os.path.join(BASE, "proxy_chua_dung.txt")
DEAD_FILE = os.path.join(BASE, "proxy_chet_trong_chrome.txt")

ts = datetime.now().strftime("%Y%m%d_%H%M%S")
now_iso = datetime.now().isoformat(timespec="seconds")


def normalize(s: str) -> str:
    s = (s or "").strip()
    for prefix in ("socks5h://", "socks5://", "http://", "https://"):
        if s.lower().startswith(prefix):
            s = s[len(prefix) :]
    return s.strip().lower()


unused = [
    line.strip()
    for line in open(UNUSED_FILE, encoding="utf-8")
    if line.strip()
]
dead_list = [
    line.strip()
    for line in open(DEAD_FILE, encoding="utf-8")
    if line.strip()
]
dead_set = {normalize(p) for p in dead_list}

if len(unused) < len(dead_list):
    raise SystemExit(
        f"Khong du proxy chua dung: {len(unused)} < {len(dead_list)} chet"
    )

g = sqlite3.connect(GAME_DB)
g.row_factory = sqlite3.Row
gc = g.cursor()

x66 = sqlite3.connect(X66_DB)
x66.row_factory = sqlite3.Row
xc = x66.cursor()

# Backup truoc khi ghi
before_cp = [
    dict(r)
    for r in gc.execute(
        "SELECT id, device, name, proxy, lc79_username FROM chrome_profiles ORDER BY id"
    ).fetchall()
]
before_up = [
    dict(r)
    for r in gc.execute("SELECT username, proxy, device FROM user_profiles").fetchall()
]
before_x66 = [
    dict(r)
    for r in xc.execute("SELECT username, device, proxy FROM accounts").fetchall()
]
bk_path = os.path.join(BACKUP_DIR, f"before_replace_dead_{ts}.json")
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

# Tim cac chrome profile dang dung proxy chet
dead_rows = []
for r in before_cp:
    if normalize(r["proxy"] or "") in dead_set:
        dead_rows.append(r)

print(f"Chrome profile dang dung proxy chet: {len(dead_rows)}")
if len(dead_rows) != len(dead_list):
    print(
        f"CANH BAO: so profile chet trong DB ({len(dead_rows)}) "
        f"khac file ({len(dead_list)})"
    )

# Map dead proxy -> new unused (theo thu tu file unused)
pool = list(unused)
mapping = []
for row in dead_rows:
    new_proxy = pool.pop(0)
    mapping.append(
        {
            "id": row["id"],
            "device": row["device"],
            "name": row["name"],
            "lc79_username": row["lc79_username"],
            "old_proxy": row["proxy"],
            "new_proxy": new_proxy,
        }
    )

# Update chrome_profiles
for m in mapping:
    gc.execute(
        "UPDATE chrome_profiles SET proxy = ?, updated_at = datetime('now') WHERE id = ?",
        (m["new_proxy"], m["id"]),
    )

# Sync sang LC79 + xoso66 theo device (va lc79_username neu co)
total_lc79 = 0
total_x66 = 0
no_match = []
for m in mapping:
    dev = (m["device"] or "").strip().lower()
    proxy = m["new_proxy"]
    if not dev:
        no_match.append(m)
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

    user = (m["lc79_username"] or "").strip()
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

    m["lc79_updated"] = n_lc79
    m["xoso66_updated"] = n_x66
    total_lc79 += n_lc79
    total_x66 += n_x66
    if n_lc79 == 0 and n_x66 == 0:
        no_match.append(m)

g.commit()
x66.commit()

map_path = os.path.join(BACKUP_DIR, f"replace_dead_map_{ts}.json")
with open(map_path, "w", encoding="utf-8") as f:
    json.dump(
        {
            "replaced_at": now_iso,
            "count": len(mapping),
            "unused_remaining": pool,
            "rows": mapping,
        },
        f,
        ensure_ascii=False,
        indent=2,
    )

# Verify chrome
still_dead = 0
dead_norm = dead_set
for r in gc.execute("SELECT proxy FROM chrome_profiles").fetchall():
    if normalize(r["proxy"] or "") in dead_norm:
        still_dead += 1

print(f"\nDa thay chrome_profiles: {len(mapping)}")
print(f"Sync LC79 user_profiles : {total_lc79} luot")
print(f"Sync xoso66 accounts    : {total_x66} luot")
print(f"Con proxy chet cu trong chrome: {still_dead}")
print(f"Profile khong khop LC79/xoso66: {len(no_match)}")
for m in no_match:
    print(f"  id={m['id']} device={m['device']!r} name={m['name']}")
print(f"Con lai proxy chua dung: {len(pool)}")
print(f"Map: {map_path}")

print("\n=== Preview 10 dong dau ===")
for m in mapping[:10]:
    print(f"  {m['device']:<12} {m['old_proxy']}  ->  {m['new_proxy']}")

g.close()
x66.close()
