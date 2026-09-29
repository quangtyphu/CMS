# -*- coding: utf-8 -*-
"""Retest proxy bi danh dau chet — multi endpoint, concurrency thap hon."""
import io
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from urllib.parse import quote

import requests

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

BASE = r"C:\Users\Quang\Documents\CMS"
PREV = os.path.join(BASE, "backups", "proxy_alive_check_20260815_201136.json")
OUT_DIR = os.path.join(BASE, "backups")
TIMEOUT = 15
WORKERS = 12
TEST_URLS = [
    "http://ip-api.com/json/?fields=query,status",
    "http://api.ipify.org?format=json",
    "https://api.ipify.org?format=json",
]


def to_socks_url(proxy: str) -> str:
    host, port, user, pwd = proxy.strip().split(":")
    return f"socks5h://{quote(user, safe='')}:{quote(pwd, safe='')}@{host}:{port}"


def check_one(row: dict) -> dict:
    proxy = row["proxy"]
    out = {
        "id": row["id"],
        "device": row["device"],
        "name": row["name"],
        "proxy": proxy,
        "ok": False,
        "ms": None,
        "ip": None,
        "via": None,
        "error": None,
        "prev_error": row.get("error"),
    }
    url = to_socks_url(proxy)
    proxies = {"http": url, "https": url}
    errors = []
    for test in TEST_URLS:
        try:
            t0 = datetime.now()
            r = requests.get(test, proxies=proxies, timeout=TIMEOUT)
            ms = int((datetime.now() - t0).total_seconds() * 1000)
            if r.status_code != 200:
                errors.append(f"{test} -> http {r.status_code}")
                continue
            ip = None
            try:
                data = r.json()
                ip = data.get("query") or data.get("ip") or data.get("origin")
            except Exception:
                ip = (r.text or "").strip()[:64]
            if ip:
                out.update(ok=True, ms=ms, ip=ip, via=test, error=None)
                return out
            errors.append(f"{test} -> empty body")
        except Exception as e:
            errors.append(f"{test} -> {type(e).__name__}: {e}")
    out["error"] = " | ".join(errors)[:500]
    return out


def main():
    prev = json.load(open(PREV, encoding="utf-8"))
    dead = [r for r in prev["rows"] if not r["ok"]]
    print(f"Retest {len(dead)} proxy truoc do bi danh DEAD...")

    results = []
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(check_one, r): r for r in dead}
        for fut in as_completed(futs):
            res = fut.result()
            results.append(res)
            done += 1
            mark = "OK  " if res["ok"] else "DEAD"
            extra = f"{res['ip']} via {res['via']} ({res['ms']}ms)" if res["ok"] else res["error"][:120]
            print(f"[{done}/{len(dead)}] {mark} {res['device']:<12} {res['proxy']} | {extra}", flush=True)

    results.sort(key=lambda x: x["id"])
    revived = [r for r in results if r["ok"]]
    still_dead = [r for r in results if not r["ok"]]

    # ghep lai ket qua cuoi
    prev_alive = [r for r in prev["rows"] if r["ok"]]
    final_alive = prev_alive + revived
    final_dead = still_dead

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = os.path.join(OUT_DIR, f"proxy_alive_recheck_{ts}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "checked_at": datetime.now().isoformat(timespec="seconds"),
                "prev_alive": len(prev_alive),
                "revived": len(revived),
                "still_dead": len(still_dead),
                "final_alive": len(final_alive),
                "final_dead": len(final_dead),
                "still_dead_rows": still_dead,
                "revived_rows": revived,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    print("\n========== KET QUA RETEST ==========")
    print(f"Song lan 1     : {len(prev_alive)}")
    print(f"Song lai (retest): {len(revived)}")
    print(f"Tong song      : {len(final_alive)}")
    print(f"Van chet       : {len(final_dead)}")
    print(f"File           : {out_path}")
    if final_dead:
        print("\n=== PROXY CHET (xac nhan 2 lan) ===")
        for r in final_dead:
            print(f"  id={r['id']:<4} device={r['device']:<12} name={r['name']:<20} proxy={r['proxy']}")


if __name__ == "__main__":
    main()
