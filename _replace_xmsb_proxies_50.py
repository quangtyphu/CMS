# -*- coding: utf-8 -*-
"""Thay proxy cho 50 XMSB device dau (sort theo ten) + sync LC79 + xoso66."""
import json
import os
import sqlite3
from datetime import datetime

BASE = r"C:\Users\Quang\Documents\CMS"
GAME_DB = os.path.join(BASE, "game_data.db")
X66_DB = os.path.join(BASE, "game_data", "xoso66.db")
BACKUP_DIR = os.path.join(BASE, "backups")
os.makedirs(BACKUP_DIR, exist_ok=True)

NEW_PROXIES = """
171.246.106.201:22294:isabella209:odg0nzcwmdmy
14.187.158.147:51869:isabella209:odg0nzcwmdmy
14.187.138.168:19722:isabella209:odg0nzcwmdmy
14.231.201.62:39713:isabella209:odg0nzcwmdmy
14.231.201.99:40228:isabella209:odg0nzcwmdmy
14.246.13.14:45404:isabella209:odg0nzcwmdmy
14.231.237.43:13718:isabella209:odg0nzcwmdmy
14.231.205.62:35383:isabella209:odg0nzcwmdmy
14.231.205.194:62123:isabella209:odg0nzcwmdmy
14.246.9.194:5890:isabella209:odg0nzcwmdmy
14.187.146.71:53099:isabella209:odg0nzcwmdmy
14.187.145.195:37306:isabella209:odg0nzcwmdmy
14.187.144.127:38467:isabella209:odg0nzcwmdmy
171.252.32.18:18483:isabella209:odg0nzcwmdmy
14.187.147.202:22998:isabella209:odg0nzcwmdmy
14.250.78.90:39179:isabella209:odg0nzcwmdmy
14.187.150.234:50817:isabella209:odg0nzcwmdmy
14.246.13.13:61923:isabella209:odg0nzcwmdmy
14.187.147.158:31736:isabella209:odg0nzcwmdmy
14.231.201.63:14081:isabella209:odg0nzcwmdmy
14.187.144.35:2515:isabella209:odg0nzcwmdmy
171.246.104.211:20663:isabella209:odg0nzcwmdmy
14.187.147.124:7077:isabella209:odg0nzcwmdmy
14.187.149.186:52710:isabella209:odg0nzcwmdmy
14.246.9.160:28322:isabella209:odg0nzcwmdmy
14.231.187.139:38843:isabella209:odg0nzcwmdmy
14.187.140.245:4286:isabella209:odg0nzcwmdmy
14.250.78.42:23198:isabella209:odg0nzcwmdmy
14.231.201.69:59975:isabella209:odg0nzcwmdmy
14.231.205.47:33629:isabella209:odg0nzcwmdmy
14.231.185.47:1257:isabella209:odg0nzcwmdmy
14.231.203.140:63551:isabella209:odg0nzcwmdmy
14.187.142.185:48555:isabella209:odg0nzcwmdmy
14.231.203.117:62445:isabella209:odg0nzcwmdmy
14.246.9.250:21903:isabella209:odg0nzcwmdmy
14.187.142.115:6964:isabella209:odg0nzcwmdmy
27.64.199.247:14917:isabella209:odg0nzcwmdmy
14.187.142.169:39475:isabella209:odg0nzcwmdmy
171.246.123.161:58668:isabella209:odg0nzcwmdmy
14.187.149.230:7790:isabella209:odg0nzcwmdmy
14.231.203.153:61431:isabella209:odg0nzcwmdmy
14.187.148.151:9840:isabella209:odg0nzcwmdmy
14.231.183.117:64808:isabella209:odg0nzcwmdmy
14.250.78.29:59029:isabella209:odg0nzcwmdmy
14.246.9.234:23441:isabella209:odg0nzcwmdmy
14.187.149.133:41651:isabella209:odg0nzcwmdmy
14.231.203.142:23074:isabella209:odg0nzcwmdmy
14.187.147.45:27137:isabella209:odg0nzcwmdmy
14.231.205.87:34780:isabella209:odg0nzcwmdmy
14.187.146.25:3574:isabella209:odg0nzcwmdmy
""".strip().splitlines()

proxies = [p.strip() for p in NEW_PROXIES if p.strip()]
bad = [p for p in proxies if len(p.split(":")) != 4]
if bad:
    raise SystemExit(f"Proxy sai dinh dang: {bad}")
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
    WHERE UPPER(device) LIKE 'XMSB%'
    ORDER BY device COLLATE NOCASE
    LIMIT ?
    """,
    (len(proxies),),
).fetchall()

print(f"Proxy moi: {len(proxies)}")
print(f"XMSB target: {len(targets)}")
if len(targets) != len(proxies):
    raise SystemExit(f"Khong khop: {len(proxies)} proxy vs {len(targets)} XMSB profile")

before_cp = [dict(r) for r in gc.execute(
    "SELECT id, device, name, proxy, lc79_username FROM chrome_profiles ORDER BY id"
).fetchall()]
before_up = [dict(r) for r in gc.execute(
    "SELECT username, proxy, device FROM user_profiles"
).fetchall()]
before_x66 = [dict(r) for r in xc.execute(
    "SELECT username, device, proxy FROM accounts"
).fetchall()]

bk_path = os.path.join(BACKUP_DIR, f"before_xmsb_proxy_replace_{ts}.json")
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
            "stt": len(mapping) + 1,
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

map_path = os.path.join(BACKUP_DIR, f"xmsb_proxy_replace_map_{ts}.json")
with open(map_path, "w", encoding="utf-8") as f:
    json.dump(
        {
            "replaced_at": now_iso,
            "count": len(mapping),
            "note": "STT n -> XMSB device thu n khi sort theo ten (50 dau)",
            "rows": mapping,
        },
        f,
        ensure_ascii=False,
        indent=2,
    )

# Verify sync
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
    print(" ", no_match)
print(f"Con lech sau sync -> LC79: {need_lc79} | xoso66: {need_x66}")
print(f"Map: {map_path}")

print("\n=== Preview 5 dong dau ===")
for m in mapping[:5]:
    print(f"  STT{m['stt']} {m['device']:<8} -> {m['new_proxy']}")
print("=== Preview 5 dong cuoi ===")
for m in mapping[-5:]:
    print(f"  STT{m['stt']} {m['device']:<8} -> {m['new_proxy']}")

g.close()
x66.close()
