# -*- coding: utf-8 -*-
"""Khoi phuc proxy dung vao dung device trong chrome_profiles tu file backup.

- Doc backup device->proxy (chrome_profiles_proxy_device_20260814_233932.json)
- Backup chrome_profiles hien tai truoc khi ghi
- Update chrome_profiles.proxy theo device (khop chinh xac)
Sau buoc nay chay _sync_proxy_from_chrome.py de day sang LC79 + xoso66.
"""
import json
import os
import sqlite3
from datetime import datetime

BASE = r"C:\Users\Quang\Documents\CMS"
GAME_DB = os.path.join(BASE, "game_data.db")
BACKUP_DIR = os.path.join(BASE, "backups")
BACKUP_FILE = os.path.join(
    BACKUP_DIR, "chrome_profiles_proxy_device_20260814_233932.json"
)

ts = datetime.now().strftime("%Y%m%d_%H%M%S")

with open(BACKUP_FILE, encoding="utf-8") as f:
    bk = json.load(f)
brows = bk["rows"]

# device -> proxy tu backup
dev_to_proxy = {}
for r in brows:
    dev = (r.get("device") or "").strip()
    if not dev:
        continue
    dev_to_proxy[dev.lower()] = (dev, r.get("proxy") or "")

print(f"Backup: {len(brows)} dong -> {len(dev_to_proxy)} device co proxy")

con = sqlite3.connect(GAME_DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

# --- Backup chrome_profiles hien tai ---
before = [
    dict(r)
    for r in cur.execute(
        "SELECT id, device, name, proxy, lc79_username FROM chrome_profiles ORDER BY id"
    ).fetchall()
]
before_path = os.path.join(BACKUP_DIR, f"chrome_profiles_before_restore_{ts}.json")
with open(before_path, "w", encoding="utf-8") as f:
    json.dump(
        {"saved_at": datetime.now().isoformat(timespec="seconds"), "rows": before},
        f,
        ensure_ascii=False,
        indent=2,
    )
print(f"Da backup chrome_profiles hien tai: {before_path} ({len(before)} dong)")

# --- Khoi phuc theo device ---
updated = 0
unchanged = 0
no_backup = []
changes = []
for row in before:
    dev_key = (row["device"] or "").strip().lower()
    if dev_key not in dev_to_proxy:
        no_backup.append((row["id"], row["device"]))
        continue
    _, new_proxy = dev_to_proxy[dev_key]
    if (row["proxy"] or "") == (new_proxy or ""):
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
            "restored_at": datetime.now().isoformat(timespec="seconds"),
            "updated": updated,
            "unchanged": unchanged,
            "rows": changes,
        },
        f,
        ensure_ascii=False,
        indent=2,
    )

print(f"\nDa khoi phuc chrome_profiles theo device:")
print(f"  cap nhat : {updated}")
print(f"  giu nguyen: {unchanged}")
print(f"  device khong co trong backup: {len(no_backup)} -> {no_backup}")
print(f"Map khoi phuc: {map_path}")

# --- Verify ---
mismatch = 0
for row in cur.execute("SELECT id, device, proxy FROM chrome_profiles").fetchall():
    dev_key = (row["device"] or "").strip().lower()
    if dev_key in dev_to_proxy and (row["proxy"] or "") != (dev_to_proxy[dev_key][1] or ""):
        mismatch += 1
print(f"Con lech so voi backup sau khi ghi: {mismatch}")

print("\n=== Preview 5 dong dau ===")
for r in cur.execute("SELECT id, device, proxy FROM chrome_profiles ORDER BY id LIMIT 5").fetchall():
    print(f"  id={r['id']} device={r['device']!r} proxy={r['proxy']}")

con.close()
