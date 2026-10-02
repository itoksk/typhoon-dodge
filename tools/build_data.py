#!/usr/bin/env python3
"""タイフーンドッジ用データ生成スクリプト

データソース（いずれも再配布可能な公開データ）:
  - 気象庁 RSMC Tokyo ベストトラック (bst_all.txt)
      https://www.jma.go.jp/jma/jma-eng/jma-center/rsmc-hp-pub-eg/besttrack.html
      ※気象庁が公表する観測事実データ。出典: 気象庁
  - world-atlas (TopoJSON, ISC License / Natural Earth = パブリックドメイン)
      https://github.com/topojson/world-atlas

出力:
  data/map.json            日本列島 + 陸地ポリゴン（経度緯度の配列）
  data/tracks/index.json   年選択画面用サマリ
  data/tracks/YYYY.json    年ごとの台風経路
"""
import json
import math
import os
import sys
import urllib.request
import zipfile
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "tools", ".cache")
OUT_DATA = os.path.join(ROOT, "data")

BST_ZIP_URL = "https://www.jma.go.jp/jma/jma-eng/jma-center/rsmc-hp-pub-eg/Besttracks/bst_all.zip"
COUNTRIES_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json"
LAND_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json"

# ゲームの描画範囲（余白込み）。この外側の陸地・経路は削って軽量化
VIEW_LON_MIN, VIEW_LON_MAX = 95.0, 225.0   # 225 = -135（日付変更線またぎ）
VIEW_LAT_MIN, VIEW_LAT_MAX = -12.0, 68.0

# 気象庁が顕著な災害に命名した台風（年, 国際番号下2桁, 国際名, 命名）
# ※ build 時に実データと照合し、一致したものだけ採用する
NAMED = [
    (1954, 15, "MARIE", "洞爺丸台風"),
    (1959, 14, "SARAH", "宮古島台風"),
    (1959, 15, "VERA", "伊勢湾台風"),
    (1961, 18, "NANCY", "第2室戸台風"),
    (1966, 18, "CORA", "第2宮古島台風"),
    (1968, 16, "DELLA", "第3宮古島台風"),
    (2019, 15, "FAXAI", "令和元年房総半島台風"),
    (2019, 19, "HAGIBIS", "令和元年東日本台風"),
]


def fetch(url: str, dest: str) -> str:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if not os.path.exists(dest):
        print(f"download: {url}")
        urllib.request.urlretrieve(url, dest)
    return dest


def full_year(yy: int) -> int:
    return 1900 + yy if yy >= 51 else 2000 + yy


def parse_best_track(path: str):
    """bst_all.txt -> {year: [storm,...]}"""
    years = {}
    cur = None
    with open(path, encoding="ascii", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            if line.startswith("66666"):
                parts = line.split()
                sid = parts[1]                      # 例 "5915"
                year, num = full_year(int(sid[:2])), int(sid[2:])
                # 末尾は8桁の更新日付、その1つ前が国際名（新旧フォーマットで位置がずれる）
                name = None
                if len(parts) >= 8:
                    cand = parts[-2] if (parts[-1].isdigit() and len(parts[-1]) == 8) else parts[-1]
                    if all(ch.isalpha() or ch == "-" for ch in cand):
                        name = cand
                cur = {"id": sid, "num": num, "name": name, "pts": []}
                years.setdefault(year, []).append(cur)
                continue
            p = line.split()
            if cur is None or len(p) < 6:
                continue
            try:
                dt, grade = p[0], int(p[1])
                lat10, lon10, pres = int(p[3]), int(p[4]), int(p[5])
                wind = int(p[6]) if len(p) > 6 and p[6].isdigit() else 0
            except ValueError:
                continue
            yy, mo, dd, hh = int(dt[:2]), int(dt[2:4]), int(dt[4:6]), int(dt[6:8])
            year = full_year(yy)
            try:
                t = (datetime(year, mo, dd, hh) - datetime(year, 1, 1)).total_seconds() / 3600.0
            except ValueError:
                continue
            cur["pts"].append([int(t), lat10, lon10, pres, wind, grade])
    return years


def storm_in_view(storm) -> bool:
    for _, lat10, lon10, *_ in storm["pts"]:
        lat, lon = lat10 / 10.0, lon10 / 10.0
        if VIEW_LAT_MIN <= lat <= VIEW_LAT_MAX and VIEW_LON_MIN <= lon <= VIEW_LON_MAX:
            return True
    return False


def decode_topo(topo, obj_name):
    """TopoJSON -> [polygon, ...] （polygon = [ring, ...], ring = [[lon,lat], ...]）"""
    sc, tr = topo["transform"]["scale"], topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append([round(x * sc[0] + tr[0], 3), round(y * sc[1] + tr[1], 3)])
        arcs.append(pts)

    def ring(idx_list):
        out = []
        for i in idx_list:
            a = arcs[~i][::-1] if i < 0 else arcs[i]
            out += a[1:] if out else a
        return out

    polys = []
    for g in topo["objects"][obj_name]["geometries"]:
        if g["type"] == "Polygon":
            polys.append([ring(r) for r in g["arcs"]])
        elif g["type"] == "MultiPolygon":
            polys += [[ring(r) for r in poly] for poly in g["arcs"]]
    return polys


def poly_max_lat(poly):
    return max(c[1] for c in poly[0])


def poly_in_view(poly):
    lons = [c[0] for c in poly[0]]
    lats = [c[1] for c in poly[0]]
    # 日付変更線またぎのポリゴンは 180 超に正規化して判定
    lons = [l + 360 if l < VIEW_LON_MIN - 90 else l for l in lons]
    return (max(lats) >= VIEW_LAT_MIN and min(lats) <= VIEW_LAT_MAX
            and max(lons) >= VIEW_LON_MIN and min(lons) <= VIEW_LON_MAX)


def main():
    os.makedirs(OUT_DATA, exist_ok=True)
    os.makedirs(os.path.join(OUT_DATA, "tracks"), exist_ok=True)

    # ---- 地図 ----
    countries = json.load(open(fetch(COUNTRIES_URL, os.path.join(CACHE, "countries-110m.json"))))
    land_topo = json.load(open(fetch(LAND_URL, os.path.join(CACHE, "land-110m.json"))))

    japan = None
    for g in countries["objects"]["countries"]["geometries"]:
        if str(g.get("id")) == "392":
            sc, tr = countries["transform"]["scale"], countries["transform"]["translate"]
            sub = dict(countries, arcs=countries["arcs"])
            sub["objects"] = {"x": {"type": "GeometryCollection", "geometries": [g]}}
            japan = decode_topo(sub, "x")
            break
    if japan is None:
        sys.exit("Japan polygon not found")

    land = [p for p in decode_topo(land_topo, "land")
            if poly_max_lat(p) > -55 and poly_in_view(p)]

    with open(os.path.join(OUT_DATA, "map.json"), "w") as f:
        json.dump({"japan": japan, "land": land}, f, separators=(",", ":"))
    print(f"map.json: japan={len(japan)} polys, land={len(land)} polys, "
          f"{os.path.getsize(os.path.join(OUT_DATA, 'map.json'))//1024} KB")

    # ---- 台風経路 ----
    bst_zip = fetch(BST_ZIP_URL, os.path.join(CACHE, "bst_all.zip"))
    bst_txt = os.path.join(CACHE, "bst_all.txt")
    if not os.path.exists(bst_txt) or os.path.getmtime(bst_zip) > os.path.getmtime(bst_txt):
        with zipfile.ZipFile(bst_zip) as z:
            z.extractall(CACHE)
    years = parse_best_track(bst_txt)

    named_hit = set()
    index = []
    for year in sorted(years):
        storms = [s for s in years[year] if storm_in_view(s) and len(s["pts"]) >= 2]
        if not storms:
            continue
        for s in storms:
            for (ny, nn, en, jp) in NAMED:
                if year == ny and s["num"] == nn and (s["name"] or "").upper() == en:
                    s["jp"] = jp
                    named_hit.add((ny, nn))
        out = {"year": year, "storms": storms}
        with open(os.path.join(OUT_DATA, "tracks", f"{year}.json"), "w") as f:
            json.dump(out, f, separators=(",", ":"))
        minp = min((p[3] for s in storms for p in s["pts"] if p[3] > 0), default=0)
        index.append({
            "y": year,
            "n": len(storms),
            "minP": minp,
            "named": [s["jp"] for s in storms if "jp" in s],
            "t0": min(s["pts"][0][0] for s in storms),
            "t1": max(s["pts"][-1][0] for s in storms),
        })

    with open(os.path.join(OUT_DATA, "tracks", "index.json"), "w") as f:
        json.dump({"years": index}, f, separators=(",", ":"), ensure_ascii=False)

    for (ny, nn, en, jp) in NAMED:
        if (ny, nn) not in named_hit:
            print(f"WARNING: 命名台風 {ny} #{nn} ({en}={jp}) はデータと一致しませんでした")
    total = sum(os.path.getsize(os.path.join(OUT_DATA, "tracks", f)) for f in os.listdir(os.path.join(OUT_DATA, "tracks")))
    print(f"tracks: {len(index)} years, total {total//1024} KB")


if __name__ == "__main__":
    main()
