# -*- coding: utf-8 -*-
"""Khoi phuc chrome_profiles tu before_all_proxy_replace (proxy cu truoc isabella)."""
import json
import os
import sqlite3
import sys
from datetime import datetime

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE = r"C:\Users\Quang\Documents\CMS"
GAME_DB = os.path.join(BASE, "game_data.db")
BACKUP_DIR = os.path.join(BASE, "backups")
BACKUP_FILE = os.path.join(BACKUP_DIR, "before_all_proxy_replace_20260826_050446.json")

ts = datetime.now().strftime("%Y%m%d_%H%M%S")
now_iso = datetime.now().isoformat(timespec="seconds")

with open(BACKUP_FILE, encoding="utf-8") as f:
    bk = json.load(f)

rows = bk.get("chrome_profiles") or []
dev_to_proxy = {}
for r in rows:
    dev = (r.get("device") or "").strip()
    if not dev:
        continue
    dev_to_proxy[dev.lower()] = (dev, (r.get("proxy") or "").strip())

print(f"Source: {BACKUP_FILE}")
print(f"saved_at backup: {bk.get('saved_at')}")
print(f"Devices in backup: {len(dev_to_proxy)}")

con = sqlite3.connect(GAME_DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

before = [
    dict(r)
    for r in cur.execute(
        "SELECT id, device, name, proxy, lc79_username FROM chrome_profiles ORDER BY id"
    ).fetchall()
]
before_path = os.path.join(BACKUP_DIR, f"chrome_profiles_before_restore_{ts}.json")
with open(before_path, "w", encoding="utf-8") as f:
    json.dump({"saved_at": now_iso, "rows": before}, f, ensure_ascii=False, indent=2)
print(f"Snapshot hien tai: {before_path}")

updated = unchanged = 0
no_backup = []
changes = []
for row in before:
    key = (row["device"] or "").strip().lower()
    if key not in dev_to_proxy:
        no_backup.append((row["id"], row["device"]))
        continue
    _, new_proxy = dev_to_proxy[key]
    if (row["proxy"] or "") == new_proxy:
        unchanged += 1
        continue
    cur.execute(
        "UPDATE chrome_profiles SET proxy = ?, updated_at = datetime('now') WHERE id = ?",
        (new_proxy, row["id"]),
    )
    updated += 1
    changes.append(
        {
            "id": row["id"],
            "device": row["device"],
            "old_proxy": row["proxy"],
            "new_proxy": new_proxy,
        }
    )

con.commit()

map_path = os.path.join(BACKUP_DIR, f"proxy_restore_map_{ts}.json")
with open(map_path, "w", encoding="utf-8") as f:
    json.dump(
        {
            "restored_at": now_iso,
            "source": BACKUP_FILE,
            "updated": updated,
            "unchanged": unchanged,
            "rows": changes,
        },
        f,
        ensure_ascii=False,
        indent=2,
    )

print(f"Updated: {updated} | unchanged: {unchanged} | no backup: {len(no_backup)}")
if no_backup:
    print(" missing:", no_backup[:10])
print(f"Map: {map_path}")
print("\n=== Preview ===")
for r in cur.execute(
    "SELECT device, proxy FROM chrome_profiles ORDER BY id LIMIT 5"
).fetchall():
    print(f"  {r['device']} -> {r['proxy']}")

con.close()
