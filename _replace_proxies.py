# -*- coding: utf-8 -*-
"""Thay toan bo proxy trong chrome_profiles bang list proxy moi (theo thu tu id)."""
import sqlite3
import json
import os
from datetime import datetime

BASE = r"C:\Users\Quang\Documents\CMS"
DB = os.path.join(BASE, "game_data.db")
BACKUP_DIR = os.path.join(BASE, "backups")

NEW_PROXIES = """
14.187.233.104:2978:oliver915:otm5mjazntk1
14.246.13.3:3321:oliver915:otm5mjazntk1
123.23.84.115:11146:oliver915:otm5mjazntk1
14.231.185.64:22648:oliver915:otm5mjazntk1
14.187.218.63:13841:oliver915:otm5mjazntk1
14.187.217.169:25020:oliver915:otm5mjazntk1
14.231.205.113:35006:oliver915:otm5mjazntk1
113.190.152.218:49920:oliver915:otm5mjazntk1
14.187.218.41:58806:william73:otuwotcwmdu1
123.22.100.113:55604:william73:otuwotcwmdu1
14.237.225.235:23982:william73:otuwotcwmdu1
14.231.202.66:1319:william73:otuwotcwmdu1
123.22.103.168:53109:william73:otuwotcwmdu1
14.187.204.18:25784:william73:otuwotcwmdu1
14.187.150.172:57804:william73:otuwotcwmdu1
14.231.203.159:2131:william73:otuwotcwmdu1
113.188.184.133:62516:william73:otuwotcwmdu1
14.246.9.252:60504:william73:otuwotcwmdu1
123.25.217.171:60292:william73:otuwotcwmdu1
14.250.78.187:50087:william73:otuwotcwmdu1
123.25.217.120:45280:william73:otuwotcwmdu1
14.187.233.45:21023:william73:otuwotcwmdu1
14.187.174.217:31507:william73:otuwotcwmdu1
14.187.241.7:46294:william73:otuwotcwmdu1
14.187.240.100:64827:william73:otuwotcwmdu1
14.187.217.245:46384:william73:otuwotcwmdu1
171.226.227.44:30256:william73:otuwotcwmdu1
14.187.204.163:50845:william73:otuwotcwmdu1
123.22.102.193:44747:william73:otuwotcwmdu1
14.187.131.4:43791:william73:otuwotcwmdu1
14.187.233.170:48738:william73:otuwotcwmdu1
14.187.218.111:11979:william73:otuwotcwmdu1
171.241.49.7:3285:william73:otuwotcwmdu1
14.231.205.58:21254:william73:otuwotcwmdu1
14.246.9.211:31274:william73:otuwotcwmdu1
14.161.147.32:28887:william73:otuwotcwmdu1
14.187.213.141:35779:william73:otuwotcwmdu1
14.187.218.80:64445:william73:otuwotcwmdu1
113.190.152.219:18232:william73:otuwotcwmdu1
14.231.203.149:54009:william73:otuwotcwmdu1
14.231.205.54:1839:william73:otuwotcwmdu1
14.231.185.127:23555:william73:otuwotcwmdu1
14.250.78.176:26379:william73:otuwotcwmdu1
14.246.9.238:60938:william73:otuwotcwmdu1
14.231.243.36:39713:william73:otuwotcwmdu1
14.231.205.90:43330:william73:otuwotcwmdu1
14.231.201.83:52708:william73:otuwotcwmdu1
14.231.242.47:39918:william73:otuwotcwmdu1
171.246.97.72:3092:william73:otuwotcwmdu1
14.231.203.192:30408:william73:otuwotcwmdu1
42.114.51.243:64325:william73:otuwotcwmdu1
14.246.9.249:42572:william73:otuwotcwmdu1
123.23.235.153:58936:william73:otuwotcwmdu1
14.231.203.199:47081:william73:otuwotcwmdu1
123.25.217.142:7620:william73:otuwotcwmdu1
14.231.252.196:35359:william73:otuwotcwmdu1
113.190.152.223:36173:william73:otuwotcwmdu1
123.22.100.228:18006:william73:otuwotcwmdu1
14.231.203.219:62127:william73:otuwotcwmdu1
14.187.218.70:13714:william73:otuwotcwmdu1
14.173.17.173:48076:william73:otuwotcwmdu1
14.231.233.82:52108:william73:otuwotcwmdu1
14.187.217.220:49604:william73:otuwotcwmdu1
14.187.233.69:10940:william73:otuwotcwmdu1
14.231.185.94:38259:william73:otuwotcwmdu1
14.231.205.137:39714:william73:otuwotcwmdu1
14.231.242.49:32142:william73:otuwotcwmdu1
118.68.213.191:38772:william73:otuwotcwmdu1
14.187.162.108:49346:william73:otuwotcwmdu1
123.25.216.181:20814:william73:otuwotcwmdu1
14.187.175.204:55615:william73:otuwotcwmdu1
14.231.181.166:45553:william73:otuwotcwmdu1
14.240.107.153:12591:william73:otuwotcwmdu1
14.231.203.169:52951:william73:otuwotcwmdu1
14.184.54.144:43596:william73:otuwotcwmdu1
14.187.177.13:14020:william73:otuwotcwmdu1
14.250.78.192:4519:william73:otuwotcwmdu1
123.22.100.102:12713:william73:otuwotcwmdu1
14.231.205.124:63208:william73:otuwotcwmdu1
113.188.184.250:25478:william73:otuwotcwmdu1
113.188.124.189:21301:william73:otuwotcwmdu1
14.231.231.236:14044:william73:otuwotcwmdu1
14.250.78.150:42541:william73:otuwotcwmdu1
14.240.107.24:36594:william73:otuwotcwmdu1
113.188.125.142:25455:william73:otuwotcwmdu1
123.23.234.78:59923:william73:otuwotcwmdu1
14.187.218.99:52837:william73:otuwotcwmdu1
14.246.9.193:62674:william73:otuwotcwmdu1
14.187.130.141:11980:william73:otuwotcwmdu1
14.187.131.170:10519:william73:otuwotcwmdu1
14.187.203.241:54543:william73:otuwotcwmdu1
14.246.9.144:4924:william73:otuwotcwmdu1
14.246.9.196:4185:william73:otuwotcwmdu1
14.187.134.238:31006:william73:otuwotcwmdu1
14.250.78.67:10575:william73:otuwotcwmdu1
14.250.78.73:21045:william73:otuwotcwmdu1
123.25.216.117:22884:william73:otuwotcwmdu1
14.246.9.195:53686:william73:otuwotcwmdu1
14.246.9.235:23220:william73:otuwotcwmdu1
14.187.240.95:56925:william73:otuwotcwmdu1
113.188.124.166:41298:william73:otuwotcwmdu1
14.187.213.110:62662:william73:otuwotcwmdu1
113.190.152.213:47718:william73:otuwotcwmdu1
14.246.9.158:13890:william73:otuwotcwmdu1
14.187.206.113:5186:william73:otuwotcwmdu1
14.187.233.79:58452:william73:otuwotcwmdu1
14.187.213.164:61677:william73:otuwotcwmdu1
14.187.213.17:48617:william73:otuwotcwmdu1
14.246.9.241:21998:william73:otuwotcwmdu1
14.231.205.103:35303:william73:otuwotcwmdu1
14.187.218.90:1253:william73:otuwotcwmdu1
14.231.203.205:49840:william73:otuwotcwmdu1
123.22.101.8:1733:william73:otuwotcwmdu1
113.188.184.97:53349:william73:otuwotcwmdu1
14.187.178.72:23356:william73:otuwotcwmdu1
14.250.78.152:6268:william73:otuwotcwmdu1
14.187.130.85:39378:william73:otuwotcwmdu1
14.187.164.95:30118:william73:otuwotcwmdu1
171.241.76.197:28068:william73:otuwotcwmdu1
14.187.218.139:21847:william73:otuwotcwmdu1
14.187.204.47:64206:william73:otuwotcwmdu1
14.187.213.152:54120:william73:otuwotcwmdu1
14.250.78.183:13979:william73:otuwotcwmdu1
14.231.203.168:37381:william73:otuwotcwmdu1
123.25.217.47:4733:william73:otuwotcwmdu1
14.231.211.181:57509:william73:otuwotcwmdu1
14.250.78.186:20178:william73:otuwotcwmdu1
14.187.204.97:63549:william73:otuwotcwmdu1
14.187.205.251:46858:william73:otuwotcwmdu1
113.188.124.195:41806:william73:otuwotcwmdu1
14.240.106.249:5129:william73:otuwotcwmdu1
14.246.9.237:56396:william73:otuwotcwmdu1
113.190.153.54:46252:william73:otuwotcwmdu1
14.231.203.201:64977:william73:otuwotcwmdu1
14.231.205.127:12248:william73:otuwotcwmdu1
14.187.165.204:59377:william73:otuwotcwmdu1
14.187.233.133:5628:william73:otuwotcwmdu1
123.23.235.36:28891:william73:otuwotcwmdu1
""".strip().splitlines()

proxies = [p.strip() for p in NEW_PROXIES if p.strip()]

# Sanity check dinh dang host:port:user:pass
bad = [p for p in proxies if len(p.split(":")) != 4]
if bad:
    raise SystemExit(f"Proxy sai dinh dang: {bad}")

dup = len(proxies) - len(set(proxies))
print(f"Proxy moi: {len(proxies)} (trung lap: {dup})")

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

rows = cur.execute("SELECT id, device, name, proxy FROM chrome_profiles ORDER BY id").fetchall()
print(f"chrome_profiles: {len(rows)} dong")

if len(proxies) != len(rows):
    raise SystemExit(f"So luong khong khop: {len(proxies)} proxy vs {len(rows)} profile")

mapping = []
for row, new_proxy in zip(rows, proxies):
    mapping.append(
        {
            "id": row["id"],
            "device": row["device"],
            "name": row["name"],
            "old_proxy": row["proxy"],
            "new_proxy": new_proxy,
        }
    )

cur.executemany(
    "UPDATE chrome_profiles SET proxy = ?, updated_at = datetime('now') WHERE id = ?",
    [(m["new_proxy"], m["id"]) for m in mapping],
)
con.commit()

ts = datetime.now().strftime("%Y%m%d_%H%M%S")
map_path = os.path.join(BACKUP_DIR, f"proxy_swap_map_{ts}.json")
with open(map_path, "w", encoding="utf-8") as f:
    json.dump(
        {"swapped_at": datetime.now().isoformat(timespec="seconds"), "count": len(mapping), "rows": mapping},
        f,
        ensure_ascii=False,
        indent=2,
    )

check = cur.execute("SELECT id, device, proxy FROM chrome_profiles ORDER BY id").fetchall()
matched = sum(1 for r, p in zip(check, proxies) if r["proxy"] == p)
print(f"Da cap nhat: {matched}/{len(check)} dong khop proxy moi")
print(f"Map doi proxy: {map_path}")
print("\n=== Preview 5 dong dau ===")
for r in check[:5]:
    print(f"  id={r['id']} device={r['device']!r} proxy={r['proxy']}")

con.close()
