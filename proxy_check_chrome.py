"""
Đăng nhập proxy.vn → lấy SOCKS5 từ donhangproxy + donhangcombo
→ so với chrome_profiles.proxy
→ kiểm tra sống/chết toàn bộ proxy web + proxy đang dùng.

Chạy: python proxy_check_chrome.py

Kết quả:
  proxy_chua_dung.txt       Proxy trên web, còn sống, chưa dùng trong Chrome
  proxy_chet.txt            Proxy chết trong toàn bộ tập kiểm tra
  proxy_chet_trong_web.txt  Proxy chết nhưng vẫn còn trên proxy.vn
  proxy_chet_trong_chrome.txt Proxy chết đang gắn trong Chrome
"""

from __future__ import annotations

import io
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import requests
from bs4 import BeautifulSoup

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

CMS_DIR = Path(__file__).resolve().parent
GAME_DATA_DB = CMS_DIR / "game_data.db"
COOKIES_FILE = CMS_DIR / "proxy_vn_cookies.txt"

BASE_URL = "https://proxy.vn"
PROXY_PAGES = [
    f"{BASE_URL}/?home=donhangproxy",
    f"{BASE_URL}/?home=donhangcombo",
]
CHECK_URLS = [
    "http://ip-api.com/json/?fields=query,status",
    "http://api.ipify.org?format=json",
    "https://api.ipify.org?format=json",
]
CHECK_TIMEOUT = 15
CHECK_WORKERS = 16

# Tài khoản proxy.vn (hardcode)
PROXY_VN_USER = "0972333999"
PROXY_VN_PASS = "Valentine1"


def normalize_proxy(s: str) -> str:
    if not s or not isinstance(s, str):
        return ""
    s = s.strip()
    for prefix in ("socks5h://", "socks5://", "http://", "https://"):
        if s.lower().startswith(prefix):
            s = s[len(prefix) :]
    return s.strip().lower()


def login_http(username: str, password: str) -> dict | None:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json, text/plain, */*",
            "Origin": BASE_URL,
            "Referer": BASE_URL + "/",
        }
    )
    try:
        session.get(BASE_URL + "/", timeout=15)
        r = session.post(
            BASE_URL + "/login.php",
            data={"user": username, "pass": password},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=15,
            allow_redirects=True,
        )
        login_ok = False
        try:
            data = r.json()
            login_ok = str(data.get("status", "")).lower() == "ok"
        except Exception:
            login_ok = (
                ("Đăng xuất" in r.text)
                or ("Thành công" in r.text)
                or ("donhangcombo" in r.url)
                or ("donhangproxy" in r.url)
            )

        if login_ok:
            cookies = {c.name: c.value for c in session.cookies}
            if cookies:
                with open(COOKIES_FILE, "w", encoding="utf-8") as f:
                    for k, v in cookies.items():
                        f.write(f"{k}={v}\n")
                return cookies
    except Exception:
        pass
    return None


def fetch_socks5_from_page(cookies: dict, url: str) -> list[str]:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Referer": BASE_URL + "/",
    }
    resp = requests.get(url, cookies=cookies, headers=headers, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    table = soup.find("table", id="proxyTable")
    if not table:
        raise ValueError(f"Không tìm thấy bảng proxy trên {url}")

    tbody = table.find("tbody") or []
    proxies: list[str] = []
    for tr in tbody.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) < 7:
            continue
        proxy_goc = (tds[4].get_text(strip=True) or "").strip()
        proxy_tg = (tds[5].get_text(strip=True) or "").strip()
        ptype = (tds[6].get_text(strip=True) or "").strip().upper()
        if ptype != "SOCKS5":
            continue
        proxy = proxy_tg or proxy_goc
        if proxy:
            proxies.append(proxy)
    return proxies


def get_socks5_from_proxy_vn(cookies: dict) -> list[str]:
    """Lấy SOCKS5 từ 2 trang, bỏ trùng theo normalize."""
    seen: set[str] = set()
    result: list[str] = []
    for url in PROXY_PAGES:
        print(f"  Đang lấy: {url}")
        for proxy in fetch_socks5_from_page(cookies, url):
            key = normalize_proxy(proxy)
            if key and key not in seen:
                seen.add(key)
                result.append(proxy)
    return result


def get_chrome_used_proxies() -> dict[str, str]:
    """Lấy normalize -> proxy gốc từ chrome_profiles."""
    if not GAME_DATA_DB.is_file():
        return {}
    con = sqlite3.connect(str(GAME_DATA_DB))
    try:
        rows = con.execute(
            "SELECT proxy FROM chrome_profiles WHERE TRIM(COALESCE(proxy,'')) != ''"
        )
        used: dict[str, str] = {}
        for (proxy,) in rows:
            n = normalize_proxy(str(proxy))
            if n:
                used[n] = str(proxy).strip()
        return used
    finally:
        con.close()


def proxy_url(proxy: str) -> str:
    """Chuyển host:port:user:pass thành SOCKS5 URL."""
    parts = proxy.strip().split(":")
    if len(parts) != 4:
        raise ValueError("Sai định dạng host:port:user:pass")
    host, port, user, password = parts
    return (
        f"socks5h://{quote(user, safe='')}:{quote(password, safe='')}"
        f"@{host}:{port}"
    )


def check_proxy(proxy: str) -> dict:
    """Thử tối đa 3 endpoint; chỉ kết luận chết khi tất cả đều lỗi."""
    result = {"proxy": proxy, "alive": False, "ip": "", "error": ""}
    try:
        socks_url = proxy_url(proxy)
    except Exception as exc:
        result["error"] = str(exc)
        return result

    proxies = {"http": socks_url, "https": socks_url}
    errors: list[str] = []
    for url in CHECK_URLS:
        try:
            response = requests.get(url, proxies=proxies, timeout=CHECK_TIMEOUT)
            if response.status_code != 200:
                errors.append(f"HTTP {response.status_code}")
                continue
            try:
                data = response.json()
                ip = data.get("query") or data.get("ip") or data.get("origin")
            except Exception:
                ip = response.text.strip()[:64]
            if ip:
                result["alive"] = True
                result["ip"] = str(ip)
                return result
            errors.append("Phản hồi rỗng")
        except Exception as exc:
            errors.append(f"{type(exc).__name__}: {exc}")
    result["error"] = " | ".join(errors)[:500]
    return result


def write_proxy_file(path: Path, proxies: list[str]) -> None:
    """Mỗi proxy đúng một dòng, không header."""
    path.write_text(
        "".join(f"{proxy}\n" for proxy in proxies),
        encoding="utf-8",
    )


def main() -> None:
    print("Đang đăng nhập proxy.vn...", end=" ")
    cookies = login_http(PROXY_VN_USER, PROXY_VN_PASS)
    if not cookies:
        print("❌")
        print("Không đăng nhập được. Kiểm tra tài khoản/mật khẩu.")
        sys.exit(1)
    print("OK")

    print("Đang lấy SOCKS5 từ proxy.vn...")
    try:
        proxies_web = get_socks5_from_proxy_vn(cookies)
    except Exception as e:
        print(f"❌ Lỗi lấy proxy: {e}")
        sys.exit(1)

    if not proxies_web:
        print("❌ Không có proxy SOCKS5.")
        sys.exit(1)

    web_map = {normalize_proxy(p): p.strip() for p in proxies_web if normalize_proxy(p)}
    used_map = get_chrome_used_proxies()
    all_map = dict(web_map)
    all_map.update(used_map)

    print(f"\nSOCKS5 từ proxy.vn       : {len(web_map)}")
    print(f"Proxy đang dùng trong Chrome: {len(used_map)}")
    print(f"Tổng proxy cần kiểm tra  : {len(all_map)}")
    print(
        f"Đang kiểm tra sống/chết (workers={CHECK_WORKERS}, "
        f"timeout={CHECK_TIMEOUT}s x {len(CHECK_URLS)} endpoint)..."
    )

    results: dict[str, dict] = {}
    done = 0
    with ThreadPoolExecutor(max_workers=CHECK_WORKERS) as executor:
        futures = {
            executor.submit(check_proxy, proxy): key
            for key, proxy in all_map.items()
        }
        for future in as_completed(futures):
            key = futures[future]
            result = future.result()
            results[key] = result
            done += 1
            mark = "SỐNG" if result["alive"] else "CHẾT"
            detail = result["ip"] if result["alive"] else result["error"][:100]
            print(
                f"[{done:>3}/{len(all_map)}] {mark:<5} "
                f"{result['proxy']} | {detail}",
                flush=True,
            )

    alive_keys = {key for key, result in results.items() if result["alive"]}
    dead_keys = set(results) - alive_keys

    unused_alive = [
        proxy
        for key, proxy in web_map.items()
        if key not in used_map and key in alive_keys
    ]
    dead_all = [all_map[key] for key in all_map if key in dead_keys]
    dead_web = [web_map[key] for key in web_map if key in dead_keys]
    dead_chrome = [used_map[key] for key in used_map if key in dead_keys]
    chrome_not_on_web = [used_map[key] for key in used_map if key not in web_map]

    unused_path = CMS_DIR / "proxy_chua_dung.txt"
    dead_path = CMS_DIR / "proxy_chet.txt"
    dead_web_path = CMS_DIR / "proxy_chet_trong_web.txt"
    dead_chrome_path = CMS_DIR / "proxy_chet_trong_chrome.txt"
    write_proxy_file(unused_path, unused_alive)
    write_proxy_file(dead_path, dead_all)
    write_proxy_file(dead_web_path, dead_web)
    write_proxy_file(dead_chrome_path, dead_chrome)

    print("\n========== KẾT QUẢ ==========")
    print(f"Proxy web còn sống, chưa dùng : {len(unused_alive)}")
    print(f"Proxy chết trong danh sách web: {len(dead_web)}")
    print(f"Proxy chết đang gắn Chrome    : {len(dead_chrome)}")
    print(f"Proxy Chrome không còn trên web: {len(chrome_not_on_web)}")
    print(f"Tổng proxy chết               : {len(dead_all)}")

    print(f"\n----- PROXY CHƯA DÙNG ({len(unused_alive)}) -----")
    if unused_alive:
        for proxy in unused_alive:
            print(proxy)
    else:
        print("(không có)")

    print(f"\n----- PROXY CHẾT ({len(dead_all)}) -----")
    if dead_all:
        for proxy in dead_all:
            print(proxy)
    else:
        print("(không có)")

    print(f"\nChưa dùng : {unused_path}")
    print(f"Chết      : {dead_path}")
    print(f"Chết/web  : {dead_web_path}")
    print(f"Chết/Chrome: {dead_chrome_path}")
    print(f"Hoàn tất lúc: {datetime.now().isoformat(timespec='seconds')}")


if __name__ == "__main__":
    main()
