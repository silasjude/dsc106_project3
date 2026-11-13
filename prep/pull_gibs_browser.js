// Browser version of prep/pull_gibs.py (this is what produced the committed data).
// Paste into the devtools console on any https://gibs.earthdata.nasa.gov page (same origin, so the
// canvas can read pixels). It downloads p3_modis_header.json and p3_modis_monthly.bin; move both
// into prep/raw/ and run `python prep/build_data.py`.

const W = 600, H = 400, N = W * H, F = 5, BBOX = '-75,-18,-45,2';
const YEARS = Array.from({ length: 26 }, (_, i) => 2001 + i), MONTHS = [7, 8, 9];
const LAYERS = [['ndvi', 'MODIS_Terra_L3_NDVI_Monthly', 'MODIS_L3_NDVI'],
                ['lst', 'MODIS_Terra_L3_Land_Surface_Temp_Monthly_Day', 'MODIS_Land_Surface_Temp']];

async function colormap(name, k) {
  const doc = new DOMParser().parseFromString(await (await fetch(`/colormaps/v1.3/${name}.xml`)).text(), 'text/xml');
  const m = new Map();
  for (const e of doc.getElementsByTagName('ColorMapEntry')) {
    const v = e.getAttribute('value'); if (!v || e.getAttribute('nodata')) continue;
    const [a, b] = v.replace(/[\[\)\]]/g, '').split(',').map(Number);
    let val = (a + b) / 2;
    if (k === 'ndvi' && e.getAttribute('transparent') === 'true') val = NaN;   // water / negative NDVI
    if (k === 'lst') val = (a < 250 || a >= 350) ? NaN : val - 273.15;
    const [r, g, bl] = e.getAttribute('rgb').split(',').map(Number);
    m.set((r << 16) | (g << 8) | bl, val);
  }
  return m;
}

async function grab(layer, time, cm, w, h) {
  const url = `/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=${layer}&SRS=EPSG:4326` +
              `&BBOX=${BBOX}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png&TRANSPARENT=TRUE&TIME=${time}`;
  const bmp = await createImageBitmap(await (await fetch(url)).blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const ctx = new OffscreenCanvas(w, h).getContext('2d'); ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data, out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const v = px[i * 4 + 3] ? cm.get((px[i * 4] << 16) | (px[i * 4 + 1] << 8) | px[i * 4 + 2]) : NaN;
    out[i] = v === undefined ? NaN : v;
  }
  return out;
}

const buf = new Uint8Array(2 * YEARS.length * 3 * N).fill(255);
for (let vi = 0; vi < 2; vi++) {
  const [k, layer, cmName] = LAYERS[vi], cm = await colormap(cmName, k);
  for (let yi = 0; yi < YEARS.length; yi++) await Promise.all(MONTHS.map(async (mo, mi) => {
    const off = ((vi * YEARS.length + yi) * 3 + mi) * N, when = `${YEARS[yi]}-0${mo}-01`;
    if (k === 'lst') {
      const r = await grab(layer, when, cm, W, H);
      for (let i = 0; i < N; i++) if (!isNaN(r[i])) buf[off + i] = Math.max(0, Math.min(250, Math.round((r[i] - 10) * 5)));
    } else {                                    // 0.01 deg request, mean of each 5x5 block
      const r = await grab(layer, when, cm, W * F, H * F);
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        let s = 0, c = 0;
        for (let dj = 0; dj < F; dj++) for (let di = 0; di < F; di++) { const v = r[(j * F + dj) * W * F + i * F + di]; if (!isNaN(v)) { s += v; c++; } }
        buf[off + j * W + i] = c >= 13 ? Math.max(0, Math.min(250, Math.round((s / c) * 200 + 20))) : 255;
      }
    }
  }));
}
const save = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); };
save(new Blob([JSON.stringify({ W, H, bbox: [-75, -18, -45, 2], years: YEARS, months: MONTHS, vars: ['ndvi', 'lst'],
  enc: { ndvi: 'v=(b-20)/200', lst: 'v=b/5+10 (degC)', nodata: 255 }, layers: LAYERS.map(l => l[1]),
  source: 'NASA GIBS WMS epsg4326/best, colormap-decoded', pulled: new Date().toISOString() })], { type: 'application/json' }), 'p3_modis_header.json');
save(new Blob([buf]), 'p3_modis_monthly.bin');
