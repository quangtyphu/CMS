# -*- coding: utf-8 -*-
"""Kiem tra proxy trong chrome_profiles con song hay chet (SOCKS5)."""
import io
import json
import os
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from urllib.parse import quote

import requests

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

BASE = r"C:\Users\Quang\Documents\CMS"
GAME_DB = os.path.join(BASE, "game_data.db")
OUT_DIR = os.path.join(BASE, "backups")
TEST_URL = "http://httpbin.org/ip"
TIMEOUT = 12
WORKERS = 25


def to_socks_url(proxy: str) -> str:
    parts = proxy.strip().split(":")
    if len(parts) != 4:
        raise ValueError(f"bad format: {proxy}")
    host, port, user, pwd = parts
    return f"socks5h://{quote(user, safe='')}:{quote(pwd, safe='')}@{host}:{port}"


def check_one(row: dict) -> dict:
    proxy = (row["proxy"] or "").strip()
    out = {
        "id": row["id"],
        "device": row["device"],
        "name": row["name"],
        "proxy": proxy,
        "ok": False,
        "ms": None,
        "ip": None,
        "error": None,
    }
    if not proxy:
        out["error"] = "empty"
        return out
    try:
        url = to_socks_url(proxy)
        t0 = datetime.now()
        r = requests.get(
            TEST_URL,
            proxies={"http": url, "https": url},
            timeout=TIMEOUT,
        )
        ms = int((datetime.now() - t0).total_seconds() * 1000)
        out["ms"] = ms
        if r.status_code == 200:
            try:
                data = r.json()
                out["ip"] = data.get("origin") or data.get("ip")
            except Exception:
                out["ip"] = (r.text or "")[:80]
            out["ok"] = True
        else:
            out["error"] = f"http {r.status_code}"
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
    return out


def main():
    con = sqlite3.connect(GAME_DB)
    con.row_factory = sqlite3.Row
    rows = [
        dict(r)
        for r in con.execute(
            "SELECT id, device, name, proxy FROM chrome_profiles ORDER BY id"
        ).fetchall()
    ]
    con.close()
    print(f"Kiem tra {len(rows)} proxy (timeout={TIMEOUT}s, workers={WORKERS})...")

    results = []
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(check_one, r): r for r in rows}
        for fut in as_completed(futs):
            res = fut.result()
            results.append(res)
            done += 1
            mark = "OK" if res["ok"] else "DEAD"
            extra = res["ip"] if res["ok"] else res["error"]
            print(
                f"[{done}/{len(rows)}] {mark:4} id={res['id']:<4} "
                f"device={res['device']:<12} {res['proxy']} | {extra}",
                flush=True,
            )

    results.sort(key=lambda x: x["id"])
    alive = [r for r in results if r["ok"]]
    dead = [r for r in results if not r["ok"]]

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = os.path.join(OUT_DIR, f"proxy_alive_check_{ts}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "checked_at": datetime.now().isoformat(timespec="seconds"),
                "total": len(results),
                "alive": len(alive),
                "dead": len(dead),
                "rows": results,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    print("\n========== KET QUA ==========")
    print(f"Tong : {len(results)}")
    print(f"Song : {len(alive)}")
    print(f"Chet : {len(dead)}")
    print(f"File : {out_path}")
    if dead:
        print("\n=== PROXY CHET ===")
        for r in dead:
            print(
                f"  id={r['id']:<4} device={r['device']:<12} "
                f"name={r['name']:<20} proxy={r['proxy']}"
            )
            print(f"         error={r['error']}")
    else:
        print("\nTat ca proxy deu song.")


if __name__ == "__main__":
    main()
