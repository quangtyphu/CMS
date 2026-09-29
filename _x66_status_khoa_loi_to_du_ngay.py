# -*- coding: utf-8 -*-
"""Chuyen trang thai Khoá + Lỗi proxy -> Đủ ngày (xoso66 accounts)."""
import json
import os
import sqlite3
import sys
from datetime import datetime

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE = r"C:\Users\Quang\Documents\CMS"
X66_DB = os.path.join(BASE, "game_data", "xoso66.db")
BACKUP_DIR = os.path.join(BASE, "backups")
os.makedirs(BACKUP_DIR, exist_ok=True)

FROM_STATUSES = ("Khoá", "Khóa", "Lỗi proxy", "Proxy Lỗi", "Lỗi Proxy")
TO_STATUS = "Đủ ngày"

ts = datetime.now().strftime("%Y%m%d_%H%M%S")
now_iso = datetime.now().isoformat(timespec="seconds")

conn = sqlite3.connect(X66_DB)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

before = [
    dict(r)
    for r in cur.execute(
        f"""
        SELECT id, username, device, status, proxy, balance, daily_bet_total
        FROM accounts
        WHERE status IN ({",".join("?" * len(FROM_STATUSES))})
        ORDER BY id
        """,
        FROM_STATUSES,
    ).fetchall()
]

print(f"Tim thay {len(before)} account can doi sang {TO_STATUS!r}")
by_old = {}
for r in before:
    by_old[r["status"]] = by_old.get(r["status"], 0) + 1
for st, n in sorted(by_old.items(), key=lambda x: -x[1]):
    print(f"  {st}: {n}")

if not before:
    print("Khong co gi de cap nhat.")
    raise SystemExit(0)

bk_path = os.path.join(BACKUP_DIR, f"before_x66_status_to_du_ngay_{ts}.json")
with open(bk_path, "w", encoding="utf-8") as f:
    json.dump(
        {
            "saved_at": now_iso,
            "from_statuses": list(FROM_STATUSES),
            "to_status": TO_STATUS,
            "count": len(before),
            "rows": before,
        },
        f,
        ensure_ascii=False,
        indent=2,
    )
print(f"Backup: {bk_path}")

cur.execute(
    f"""
    UPDATE accounts
    SET status = ?, updated_at = ?
    WHERE status IN ({",".join("?" * len(FROM_STATUSES))})
    """,
    (TO_STATUS, now_iso, *FROM_STATUSES),
)
updated = cur.rowcount or 0
conn.commit()

after_counts = cur.execute(
    "SELECT status, COUNT(*) AS n FROM accounts GROUP BY status ORDER BY n DESC"
).fetchall()

map_path = os.path.join(BACKUP_DIR, f"x66_status_to_du_ngay_map_{ts}.json")
with open(map_path, "w", encoding="utf-8") as f:
    json.dump(
        {
            "updated_at": now_iso,
            "updated": updated,
            "mapping": [
                {
                    "id": r["id"],
                    "username": r["username"],
                    "device": r["device"],
                    "old_status": r["status"],
                    "new_status": TO_STATUS,
                }
                for r in before
            ],
        },
        f,
        ensure_ascii=False,
        indent=2,
    )

print(f"\nDa cap nhat: {updated} account -> {TO_STATUS!r}")
print("Trang thai sau khi doi:")
for r in after_counts:
    print(f"  {r['status']}: {r['n']}")
print(f"Map: {map_path}")

conn.close()
