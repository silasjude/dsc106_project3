"""
Build the static data files the visualization loads.

Input  (not committed, ~37 MB): prep/raw/p3_modis_monthly.bin + prep/raw/p3_modis_header.json
        made by prep/pull_gibs.py (or the browser version, prep/pull_gibs_browser.js).
Output: data/static.png, data/dndvi.png, data/dlst.png, data/meta.json

Method (same choices as our deforestation.ipynb):
  * Grid: 0.05 deg (~5.5 km) cells over 75W-45W, 18S-2N. NDVI is the mean of the 5x5 block of
    ~1 km MODIS pixels in each cell; LST is native ~5 km.
  * Dry season = Jul-Sep. Each year's value = median of that year's three monthly composites.
  * Baseline = mean of 2001-2003. Change = year - baseline.
  * Years stop at 2022: after that Terra's orbit drifts to an earlier overpass, which cools daytime LST.
  * "Cleared in year Y": first year >= 2004 where NDVI is >= 0.20 below its own baseline and stays there
    for 3 years (cloudy years don't break or count toward the run).
  * Clearing effect = mean LST change of cleared cells (NDVI change < -0.20)
                      - mean LST change of stable cells (|NDVI change| < 0.05).

Run:  python prep/build_data.py
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "prep" / "raw"
OUT = ROOT / "data"

hdr = json.loads((RAW / "p3_modis_header.json").read_text())
W, H = hdr["W"], hdr["H"]
west, south, east, north = hdr["bbox"]
all_years = np.array(hdr["years"])
raw = np.fromfile(RAW / "p3_modis_monthly.bin", dtype=np.uint8)
raw = raw.reshape(2, len(all_years), 3, H, W)  # var, year, month, row, col


def decode(b, var):
    v = b.astype(np.float32)
    v[b == 255] = np.nan
    return (v - 20) / 200 if var == "ndvi" else v / 5 + 10


ndvi_m = decode(raw[0], "ndvi")
lst_m = decode(raw[1], "lst")
with np.errstate(all="ignore"):
    import warnings
    warnings.simplefilter("ignore", RuntimeWarning)
    ndvi_all = np.nanmedian(ndvi_m, axis=1)  # (year, H, W) dry-season median
    lst_all = np.nanmedian(lst_m, axis=1)

YEARS = np.arange(2001, 2023)
keep = np.isin(all_years, YEARS)
ndvi, lst = ndvi_all[keep], lst_all[keep]
BASE = (YEARS >= 2001) & (YEARS <= 2003)
warnings.simplefilter("ignore", RuntimeWarning)
base_n = np.nanmean(ndvi[BASE], axis=0)
base_l = np.nanmean(lst[BASE], axis=0)
d_n = ndvi - base_n
d_l = lst - base_l

# --- clearing year (team rule) ---
DROP, PERSIST, START = 0.20, 3, 2004
below = ndvi < (base_n - DROP)
unknown = np.isnan(ndvi)
clear = np.full((H, W), np.nan, np.float32)
for i in np.flatnonzero(YEARS >= START):
    w = slice(i, min(i + PERSIST, len(YEARS)))
    hit = below[i] & (below[w] | unknown[w]).all(axis=0) & np.isnan(clear)
    clear[hit] = YEARS[i]
clear[~np.isfinite(base_n)] = np.nan

# --- encode ---
def q_int8(a, scale):
    out = np.round(a * scale)
    out = np.clip(out, -127, 127)
    out[~np.isfinite(a)] = -128
    return out.astype(np.int8)


def q_uint8(a, lo, scale):
    out = np.clip(np.round((a - lo) * scale), 0, 250)
    out[~np.isfinite(a)] = 255
    return out.astype(np.uint8)


static = np.stack([
    q_uint8(base_n, 0, 250),          # baseline NDVI      v = b/250
    q_uint8(base_l, 10, 5),           # baseline LST (C)   v = b/5 + 10
    np.where(np.isfinite(clear), clear - 2000, 0).astype(np.uint8),  # 0 = never cleared
])
static[2][~np.isfinite(base_n)] = 255

# Stored as lossless 8-bit grayscale PNGs (planes stacked vertically): small, and every browser decodes them.
# int8 planes are shifted by +128 so that "no data" (-128) becomes 0.
OUT.mkdir(exist_ok=True)
for name, arr in [("static", static), ("dndvi", q_int8(d_n, 200)), ("dlst", q_int8(d_l, 10))]:
    planes = arr.astype(np.int16) + (128 if arr.dtype == np.int8 else 0)
    Image.fromarray(planes.reshape(-1, W).astype(np.uint8), mode="L").save(OUT / f"{name}.png", optimize=True)

# --- summaries (used for annotations and to check the JS numbers) ---
lats = north - (np.arange(H) + 0.5) * (north - south) / H
lons = west + (np.arange(W) + 0.5) * (east - west) / W
area = np.broadcast_to((np.cos(np.deg2rad(lats)) * (0.05 * 111.32) ** 2)[:, None], (H, W))

REGIONS = {
    "rondonia": {"name": "Rondônia", "bbox": [-64, -12, -60, -8]},
    "para": {"name": "Pará (BR-163)", "bbox": [-57, -9, -53, -5]},
    "control": {"name": "Intact Amazon (control)", "bbox": [-68, -6, -64, -2]},
}


def box_mask(b):
    w, s, e, n = b
    return (lons[None, :] >= w) & (lons[None, :] < e) & (lats[:, None] >= s) & (lats[:, None] < n)


def trailing(a, i):
    return np.nanmean(a[max(0, i - 2): i + 1], axis=0)


summ = {}
for key, r in REGIONS.items():
    m = box_mask(r["bbox"]) & np.isfinite(base_n)
    series = []
    for i, y in enumerate(YEARS):
        dn3, dl3 = trailing(d_n, i)[m], trailing(d_l, i)[m]
        cl = dn3 < -DROP
        st = np.abs(dn3) < 0.05
        eff = np.nanmean(dl3[cl]) - np.nanmean(dl3[st]) if cl.sum() >= 20 else None
        cleared_area = area[m][(clear[m] <= y)].sum()
        series.append({
            "year": int(y),
            "dndvi": round(float(np.nanmean(dn3)), 4),
            "dlst": round(float(np.nanmean(dl3)), 3),
            "pct_cleared": round(float(100 * cleared_area / area[m].sum()), 2),
            "effect": None if eff is None or not np.isfinite(eff) else round(float(eff), 2),
            "n_cleared": int(cl.sum()),
        })
    summ[key] = {**r, "series": series}

# Orbit-drift evidence: raw dry-season LST of the intact control, all years pulled.
cm = box_mask(REGIONS["control"]["bbox"])
drift = [{"year": int(y), "lst": round(float(np.nanmean(lst_all[i][cm])), 2),
          "ndvi": round(float(np.nanmean(ndvi_all[i][cm])), 3)} for i, y in enumerate(all_years)]

meta = {
    "W": W, "H": H, "bbox": [west, south, east, north], "cell_deg": 0.05,
    "years": YEARS.tolist(), "base_years": [2001, 2003],
    "encoding": {
        "format": "8-bit grayscale PNG, planes of W x H stacked vertically",
        "static": "3 planes: [baseline NDVI p/250, baseline LST p/5+10 C, clearing year p+2000 (0 never)]; 255 = no data",
        "dndvi": "one plane per year: NDVI change = (p-128)/200; p = 0 is no data",
        "dlst": "one plane per year: LST change (C) = (p-128)/10; p = 0 is no data",
        "row_order": "row 0 = north edge, column 0 = west edge",
    },
    "rules": {"drop": DROP, "persist": PERSIST, "stable": 0.05, "search_from": START},
    "regions": summ,
    "control_raw_all_years": drift,
    "source": hdr,
}
(OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")))

# --- print a check table ---
print(f"land cells: {np.isfinite(base_n).sum()} / {W*H}   cleared by 2022: {np.isfinite(clear).sum()}")
for k, r in summ.items():
    s = r["series"][-1]
    print(f"{r['name']:<26} dNDVI {s['dndvi']:+.3f}  dLST {s['dlst']:+.2f}C  cleared {s['pct_cleared']:5.1f}%  effect {s['effect']}  n={s['n_cleared']}")
print("control raw LST by year:", [(d["year"], d["lst"]) for d in drift])
for f in sorted(OUT.glob("*")):
    print(f"{f.name:<20} {f.stat().st_size/1e3:8.1f} kB")
