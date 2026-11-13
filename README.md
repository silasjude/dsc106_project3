# The Heat Left Behind

**DSC 106 Project 3 · Team 11** — Silas Jude, Ethan Lam, McAllister Blair, Rami Abukhater

An interactive D3 visualization of 22 dry seasons (2001–2022) of NASA MODIS data over the southern Amazon:
where the forest lost greenness (NDVI), and how much hotter the land surface got (daytime LST).
Cleared 5 km squares warmed about **+3.8 °C** (Rondônia) and **+4.0 °C** (Pará, BR-163) more than stable forest nearby.

Repo: https://github.com/silasjude/dsc106_project3 (branch `heat-left-behind`)

## Run locally

The page loads data with `fetch`, so it needs a local web server (opening `index.html` as a file won't work):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy (GitHub Pages)

1. Push this folder to the root of a **public** repo.
2. Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`.
3. To publish from this branch instead, pick `heat-left-behind` / `(root)` (or merge it into `main`).

## Files

```
index.html           page: hero, explorer, methods
writeup.html         design rationale + development process
css/style.css
js/d3.v7.min.js      D3 v7.9 (bundled locally; the only library used)
js/main.js           all visualization code (map, scatter, time series, tooltip, swipe, tour)
data/meta.json       grid info, region boxes, per-region summaries
data/static.png      per-square baseline NDVI, baseline LST, clearing year (3 planes of 600×400)
data/dndvi.png       NDVI change from baseline, one plane per year (22 planes)
data/dlst.png        LST change from baseline, one plane per year (22 planes)
data/borders.json country borders (Natural Earth 1:50m via world-atlas)
img/                 MODIS true-color images for the header swipe (NASA GIBS)
prep/                data pipeline (below)
```

## Data pipeline

```bash
pip install requests numpy pillow
python prep/pull_gibs.py      # ~10 min: downloads MODIS Terra monthly NDVI + LST, Jul–Sep 2001–2026, from NASA GIBS
python prep/build_data.py     # builds data/*.png + data/meta.json and prints a check table
```

* `pull_gibs.py` requests the GIBS WMS images and decodes each pixel's color back to a value using the
  layer's published colormap. NDVI (~1 km) is requested at 0.01° and averaged into 0.05° blocks; LST (~5 km) at 0.05°.
  `prep/pull_gibs_browser.js` does the same thing from a browser console and is what produced the committed data.
* `build_data.py`: dry-season median per year → change from the 2001–03 baseline → clearing year
  (NDVI ≥ 0.20 below baseline for 3 years) → quantized 8-bit planes saved as lossless grayscale PNGs (stacked vertically; see meta.json "encoding"). Same rules as our `deforestation.ipynb`.
* Years stop at 2022 because Terra's orbit drift after that makes daytime LST read cooler.

Expected check output (2020–22): Rondônia effect 3.84 °C (385 cleared squares), Pará 4.0 °C (195), control 0 cleared, +0.74 °C overall.

## Credits

NASA EOSDIS GIBS: `MODIS_Terra_L3_NDVI_Monthly`, `MODIS_Terra_L3_Land_Surface_Temp_Monthly_Day`,
`MODIS_Terra_CorrectedReflectance_TrueColor`. Borders: Natural Earth. Color scales: ColorBrewer (via d3-scale-chromatic).
