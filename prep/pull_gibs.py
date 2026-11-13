"""
Download MODIS Terra dry-season NDVI and daytime LST from NASA GIBS and decode the PNG colors back
to values with each layer's GIBS colormap (same idea as the helpers in our exploration.ipynb).

Writes prep/raw/p3_modis_monthly.bin (uint8, shape [var=2, year, month=3, 400, 600]) and
prep/raw/p3_modis_header.json. Then run prep/build_data.py.

  * NDVI (MODIS_Terra_L3_NDVI_Monthly, ~1 km) is requested at 0.01 deg and averaged into 5x5 blocks,
    so every 0.05 deg cell is the mean of ~25 one-km pixels (cells with < 13 valid pixels = no data).
  * LST (MODIS_Terra_L3_Land_Surface_Temp_Monthly_Day, ~5 km) is requested at 0.05 deg directly.
  * Encoding: NDVI byte = round(ndvi*200 + 20); LST byte = round((degC - 10)*5); 255 = no data.

Takes ~10 minutes (234 requests). Needs: requests, numpy, pillow.
(The committed data was pulled with the identical browser version, prep/pull_gibs_browser.js.)
"""
import io
import json
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests
from PIL import Image

GIBS = "https://gibs.earthdata.nasa.gov"
BBOX = (-75, -18, -45, 2)  # west, south, east, north
W, H = 600, 400
YEARS = list(range(2001, 2027))
MONTHS = [7, 8, 9]
LAYERS = {
    "ndvi": ("MODIS_Terra_L3_NDVI_Monthly", "MODIS_L3_NDVI"),
    "lst": ("MODIS_Terra_L3_Land_Surface_Temp_Monthly_Day", "MODIS_Land_Surface_Temp"),
}
OUT = Path(__file__).resolve().parent / "raw"
s = requests.Session()


def colormap(name, var):
    root = ET.fromstring(s.get(f"{GIBS}/colormaps/v1.3/{name}.xml", timeout=60).content)
    lut = {}
    for e in root.iter("ColorMapEntry"):
        v = e.get("value")
        if v is None or e.get("nodata") == "true":
            continue
        a, b = (float(x) for x in v.strip("[]()").split(","))
        val = (a + b) / 2
        if var == "ndvi" and e.get("transparent") == "true":
            val = np.nan  # negative NDVI (water)
        if var == "lst":
            val = val - 273.15 if 250 <= a < 350 else np.nan
        r, g, bl = (int(x) for x in e.get("rgb").split(","))
        lut[(r << 16) | (g << 8) | bl] = val
    return lut


def grab(layer, when, lut, w, h):
    p = dict(SERVICE="WMS", REQUEST="GetMap", VERSION="1.1.1", LAYERS=layer, SRS="EPSG:4326",
             BBOX=",".join(map(str, BBOX)), WIDTH=w, HEIGHT=h, FORMAT="image/png", TRANSPARENT="TRUE", TIME=when)
    r = s.get(f"{GIBS}/wms/epsg4326/best/wms.cgi", params=p, timeout=180)
    r.raise_for_status()
    px = np.array(Image.open(io.BytesIO(r.content)).convert("RGBA")).astype(np.int64)
    key = (px[..., 0] << 16) | (px[..., 1] << 8) | px[..., 2]
    out = np.vectorize(lambda k: lut.get(k, np.nan), otypes=[np.float32])(key)
    out[px[..., 3] == 0] = np.nan
    return out


def main():
    OUT.mkdir(exist_ok=True)
    buf = np.full((2, len(YEARS), 3, H, W), 255, np.uint8)
    for vi, (var, (layer, cmap)) in enumerate(LAYERS.items()):
        lut = colormap(cmap, var)
        for yi, y in enumerate(YEARS):
            for mi, m in enumerate(MONTHS):
                when = f"{y}-{m:02d}-01"
                if var == "ndvi":
                    hi = grab(layer, when, lut, W * 5, H * 5).reshape(H, 5, W, 5)
                    valid = np.isfinite(hi).sum(axis=(1, 3))
                    with np.errstate(all="ignore"):
                        v = np.nanmean(hi, axis=(1, 3))
                    v[valid < 13] = np.nan
                    q = np.round(v * 200 + 20)
                else:
                    v = grab(layer, when, lut, W, H)
                    q = np.round((v - 10) * 5)
                q = np.clip(q, 0, 250)
                q[~np.isfinite(v)] = 255
                buf[vi, yi, mi] = q.astype(np.uint8)
                print(var, when, "ok")
    buf.tofile(OUT / "p3_modis_monthly.bin")
    (OUT / "p3_modis_header.json").write_text(json.dumps({
        "W": W, "H": H, "bbox": list(BBOX), "years": YEARS, "months": MONTHS, "vars": ["ndvi", "lst"],
        "enc": {"ndvi": "v=(b-20)/200", "lst": "v=b/5+10 (degC)", "nodata": 255},
        "layers": [l for l, _ in LAYERS.values()],
        "source": "NASA GIBS WMS epsg4326/best, colormap-decoded",
        "pulled": datetime.now(timezone.utc).isoformat(),
    }))


if __name__ == "__main__":
    main()
