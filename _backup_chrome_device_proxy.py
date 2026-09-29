# -*- coding: utf-8 -*-
"""Backup device + proxy tu chrome_profiles (game_data.db)."""
import csv
import json
import os
import sqlite3
from datetime import datetime

BASE = r"C:\Users\Quang\Documents\CMS"
BACKUP_DIR = os.path.join(BASE, "backups")
os.makedirs(BACKUP_DIR, exist_ok=True)

ts = datetime.now().strftime("%Y%m%d_%H%M%S")
now_iso = datetime.now().isoformat(timespec="seconds")

conn = sqlite3.connect(os.path.join(BASE, "game_data.db"))
conn.row_factory = sqlite3.Row
rows = conn.execute(
    """
    SELECT id, device, name, proxy, bank, lc79_username, session_id,
           phone, account_number, account_holder, startup_urls
    FROM chrome_profiles ORDER BY id
    """
).fetchall()
conn.close()

profiles = [dict(r) for r in rows]
device_proxy_map = {
    r["device"]: r["proxy"] for r in profiles if (r.get("device") or "").strip()
}

payload = {
    "saved_at": now_iso,
    "total": len(profiles),
    "rows": profiles,
    "device_proxy_map": device_proxy_map,
}

json_path = os.path.join(BACKUP_DIR, f"chrome_profiles_proxy_device_{ts}.json")
txt_path = os.path.join(BACKUP_DIR, f"chrome_profiles_proxy_device_{ts}.txt")
csv_path = os.path.join(BACKUP_DIR, f"chrome_profiles_proxy_device_{ts}.csv")

with open(json_path, "w", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False, indent=2)

lines = []
for r in profiles:
    dev = (r.get("device") or "").strip()
    proxy = (r.get("proxy") or "").strip()
    bank = (r.get("bank") or "").strip()
    name = (r.get("name") or "").strip()
    if dev:
        lines.append(f"Device {dev}  Proxy {proxy}  Bank {bank}  Name {name}")

with open(txt_path, "w", encoding="utf-8") as f:
    f.write(f"# Backup chrome_profiles device+proxy — {now_iso}\n")
    f.write(f"# Total: {len(profiles)}\n\n")
    f.write("\n".join(lines))

with open(csv_path, "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f)
    w.writerow(["id", "device", "proxy", "bank", "name", "lc79_username"])
    for r in profiles:
        w.writerow([
            r["id"],
            r.get("device") or "",
            r.get("proxy") or "",
            r.get("bank") or "",
            r.get("name") or "",
            r.get("lc79_username") or "",
        ])

print(f"JSON: {json_path}")
print(f"TXT:  {txt_path}")
print(f"CSV:  {csv_path}")
print(f"Total profiles: {len(profiles)}")
print()
print("--- Preview (first 10) ---")
for line in lines[:10]:
    print(line)
print("...")
print("--- Preview (last 5) ---")
for line in lines[-5:]:
    print(line)
