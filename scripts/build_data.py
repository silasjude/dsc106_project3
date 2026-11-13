"""Build the static data files that index.html loads.

Source: NASA MODIS (Terra) monthly Level-3 layers served by GIBS, the same
source and the same decoding approach as deforestation.ipynb:

  1. request a WMS image of the layer for one month,
  2. turn each pixel colour back into a number with the layer's colour map,
  3. take the median of the dry-season months (Jul-Sep) for each year.

Output (written to data/):
  ndvi.bin.gz   uint8  [year, row, col]  NDVI * 250          (255 = no data)
  lst.bin.gz    uint16 [year, row, col]  (deg C + 50) * 100  (65535 = no data)
  meta.json     grid description and encodings
  borders.json  country and Brazilian state outlines (Natural Earth)

Run from the repository root:  python scripts/build_data.py
Downloads are cached in data/cache/ (git-ignored), so re-runs are fast.
"""
import gzip
import hashlib
import io
import json
import re
import time
import warnings
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import requests
from PIL import Image

GIBS = "https://gibs.earthdata.nasa.gov"
WMS_URL = f"{GIBS}/wms/epsg4326/best/wms.cgi"
WMTS_CAPS_URL = f"{GIBS}/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml"

NDVI = "MODIS_Terra_L3_NDVI_Monthly"
LST = "MODIS_Terra_L3_Land_Surface_Temp_Monthly_Day"

BBOX = (-75, -18, -45, 2)       # west, south, east, north
DEG = 0.05                      # ~5.5 km, the native LST grid
YEARS = list(range(2001, 2023)) # stop at 2022: Terra's orbit drifts afterwards
MONTHS = (7, 8, 9)              # dry season

OUT = Path("data")
CACHE = OUT / "cache"
session = requests.Session()
session.headers["User-Agent"] = "dsc106-project3/1.0"

NS = {"w": "http://www.opengis.net/wmts/1.0", "ows": "http://www.opengis.net/ows/1.1"}
HREF = "{http://www.w3.org/1999/xlink}href"


def cached_get(url, path, **params):
    path = Path(path)
    if path.exists():
        return path.read_bytes()
    for attempt in range(4):
        r = session.get(url, params=params or None, timeout=120)
        if r.ok:
            break
        time.sleep(2 ** attempt)
    else:
        raise RuntimeError(f"{url}: {r.status_code} {r.text[:200]}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(r.content)
    return r.content


def colormap_url(layer):
    root = ET.fromstring(cached_get(WMTS_CAPS_URL, CACHE / "WMTSCapabilities.xml"))
    for el in root.iter(f"{{{NS['w']}}}Layer"):
        if el.find("ows:Identifier", NS).text == layer:
            for m in el.findall("ows:Metadata", NS):
                if "/colormaps/v1.3/" in (m.get(HREF) or ""):
                    return m.get(HREF)
    raise KeyError(layer)


NUM = r"([+-]?(?:INF|\d*\.?\d+(?:[eE][+-]?\d+)?))"
RANGE_RE = re.compile(rf"^\s*[\[(]{NUM}\s*,\s*{NUM}\s*[\])]\s*$")
SINGLE_RE = re.compile(rf"^\s*\[?{NUM}\]?\s*$")


def _num(s):
    s = s.upper()
    return float("inf") if s in ("INF", "+INF") else float("-inf") if s == "-INF" else float(s)


def load_colormap(layer):
    """Return (sorted packed-RGB keys, value per key). Classes / no-data map to NaN."""
    url = colormap_url(layer)
    root = ET.fromstring(cached_get(url, CACHE / "colormaps" / Path(url).name))
    table, numeric, units = {}, [], None
    for cm in root.iter("ColorMap"):
        for e in cm.iter("ColorMapEntry"):
            r, g, b = map(int, e.get("rgb").split(","))
            key = (r << 16) | (g << 8) | b
            v = e.get("value")
            if e.get("nodata") == "true" or v is None:
                table.setdefault(key, np.nan)
                continue
            units = units or cm.get("units")
            if (m := RANGE_RE.match(v)):
                lo, hi = _num(m.group(1)), _num(m.group(2))
                val = hi if np.isinf(lo) else lo if np.isinf(hi) else (lo + hi) / 2
            else:
                val = _num(SINGLE_RE.match(v).group(1))
            if key not in table:
                table[key] = val
                numeric.append(val)
    keys = np.array(sorted(table), np.int64)
    values = np.array([table[k] for k in keys], float)
    print(f"{layer}: {len(numeric)} bins, {min(numeric):g} to {max(numeric):g} {units}")
    return keys, values, units


def fetch(layer, year, month, cmap):
    west, south, east, north = BBOX
    width, height = round((east - west) / DEG), round((north - south) / DEG)
    when = f"{year}-{month:02d}-01"
    tag = hashlib.md5(f"{BBOX}{DEG}".encode()).hexdigest()[:8]
    path = CACHE / "wms" / layer / f"{when}_{tag}.png"
    if not path.exists():
        params = dict(SERVICE="WMS", REQUEST="GetMap", VERSION="1.3.0", LAYERS=layer,
                      CRS="EPSG:4326", BBOX=f"{south},{west},{north},{east}",
                      WIDTH=width, HEIGHT=height, FORMAT="image/png", TIME=when)
        for attempt in range(4):
            r = session.get(WMS_URL, params=params, timeout=120)
            if r.ok and r.headers.get("content-type", "").startswith("image/"):
                break
            time.sleep(2 ** attempt)
        else:
            raise RuntimeError(f"GIBS error {layer} {when}: {r.status_code} {r.text[:200]}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(r.content)
    rgba = np.array(Image.open(path).convert("RGBA")).astype(np.int64)
    key = (rgba[..., 0] << 16) | (rgba[..., 1] << 8) | rgba[..., 2]
    keys, values, _ = cmap
    pos = np.clip(np.searchsorted(keys, key), 0, len(keys) - 1)
    ok = (keys[pos] == key) & (rgba[..., 3] > 0)
    return np.where(ok, values[pos], np.nan)


def dry_season_stack(layer):
    cmap = load_colormap(layer)
    out = []
    for y in YEARS:
        months = np.stack([fetch(layer, y, m, cmap) for m in MONTHS])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            out.append(np.nanmedian(months, axis=0))
        print(f"  {layer} {y}: {np.isfinite(out[-1]).mean():.0%} of cells have data", flush=True)
    return np.stack(out), cmap[2]


def build_borders():
    """Country and Brazilian state outlines that touch the map, rounded to 0.01 deg."""
    base = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
    west, south, east, north = BBOX

    def touches(coords):
        pts = np.array(coords, float).reshape(-1, 2) if not isinstance(coords[0][0], list) else None
        if pts is None:
            return any(touches(c) for c in coords)
        return bool(((pts[:, 0] >= west - 1) & (pts[:, 0] <= east + 1) &
                     (pts[:, 1] >= south - 1) & (pts[:, 1] <= north + 1)).any())

    def rounded(coords):
        if isinstance(coords[0], (int, float)):
            return [round(coords[0], 2), round(coords[1], 2)]
        return [rounded(c) for c in coords]

    feats = []
    for fname, kind in [("ne_50m_admin_0_countries.geojson", "country"),
                        ("ne_50m_admin_1_states_provinces.geojson", "state")]:
        gj = json.loads(cached_get(base + fname, CACHE / fname))
        for f in gj["features"]:
            p = f["properties"]
            if kind == "state" and p.get("iso_a2") != "BR":
                continue
            if not touches(f["geometry"]["coordinates"]):
                continue
            feats.append({"type": "Feature",
                          "properties": {"kind": kind, "name": p.get("NAME") or p.get("name")},
                          "geometry": {"type": f["geometry"]["type"],
                                       "coordinates": rounded(f["geometry"]["coordinates"])}})
    (OUT / "borders.json").write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                                                  separators=(",", ":")))
    print(f"borders.json: {len(feats)} features")


def main():
    OUT.mkdir(exist_ok=True)
    ndvi, _ = dry_season_stack(NDVI)
    lst, lst_units = dry_season_stack(LST)
    if lst_units and lst_units.strip().upper().startswith("K"):
        lst = lst - 273.15
    print(f"NDVI range {np.nanmin(ndvi):.2f}..{np.nanmax(ndvi):.2f}   "
          f"LST range {np.nanmin(lst):.1f}..{np.nanmax(lst):.1f} C")

    n8 = np.where(np.isfinite(ndvi), np.clip(np.round(ndvi * 250), 0, 254), 255).astype(np.uint8)
    l16 = np.where(np.isfinite(lst), np.clip(np.round((lst + 50) * 100), 0, 65534), 65535).astype("<u2")
    for name, arr in [("ndvi", n8), ("lst", l16)]:
        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as gz:
            gz.write(arr.tobytes())
        (OUT / f"{name}.bin.gz").write_bytes(buf.getvalue())
        print(f"{name}.bin.gz: {len(buf.getvalue()) / 1e6:.2f} MB")

    west, south, east, north = BBOX
    meta = dict(bbox=BBOX, deg=DEG, width=n8.shape[2], height=n8.shape[1], years=YEARS,
                months=list(MONTHS),
                ndvi=dict(file="ndvi.bin.gz", dtype="uint8", scale=250, offset=0, nodata=255, layer=NDVI),
                lst=dict(file="lst.bin.gz", dtype="uint16", scale=100, offset=50, nodata=65535, layer=LST))
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    build_borders()


if __name__ == "__main__":
    main()
