/* The Heat Left Behind — DSC 106 Project 3, Team 11
 * D3 v7 only. Data files are built by prep/build_data.py (see README).
 *
 * Layout of this file
 *   1. data loading + grid helpers
 *   2. state + derived data (3-year frames, selection, time series)
 *   3. map (canvas raster + SVG overlay, brush, hover)
 *   4. scatter (2-D histogram, brush filter)
 *   5. time-series charts
 *   6. readout, legend, controls
 *   7. hero swipe
 *   8. guided tour
 */
(async function () {
  'use strict';

  // ---------------------------------------------------------------- 1. data
  // The grids are stored as lossless 8-bit grayscale PNGs (planes stacked vertically).
  // Drawing one to a canvas and reading the red channel gives back the exact bytes.
  async function loadPlanes(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    const c2 = cv.getContext('2d', { willReadFrequently: true });
    c2.drawImage(bmp, 0, 0);
    const rgba = c2.getImageData(0, 0, bmp.width, bmp.height).data;
    const out = new Uint8Array(bmp.width * bmp.height);
    for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4];
    return out;
  }
  const toInt8 = (u8) => { const a = new Int8Array(u8.length); for (let i = 0; i < u8.length; i++) a[i] = u8[i] - 128; return a; };

  const [META, ST, DNb, DLb, BORDERS] = await Promise.all([
    d3.json('data/meta.json'),
    loadPlanes('data/static.png'),
    loadPlanes('data/dndvi.png'),
    loadPlanes('data/dlst.png'),
    d3.json('data/borders.json'),
  ]);

  const W = META.W, H = META.H, N = W * H;
  const [WEST, SOUTH, EAST, NORTH] = META.bbox;
  const DEG = META.cell_deg;
  const YEARS = META.years;                    // 2001 … 2022
  const NY = YEARS.length;
  const DROP = META.rules.drop;                // 0.20
  const STABLE = META.rules.stable;            // 0.05
  const MIN_CLEARED = 20;                      // fewer cleared squares than this → don't report an effect

  const baseN = ST.subarray(0, N);             // b/250, 255 = no data
  const baseL = ST.subarray(N, 2 * N);         // b/5 + 10
  const clr = ST.subarray(2 * N, 3 * N);       // year-2000, 0 = never, 255 = no data
  const DN = toInt8(DNb);                      // b/200, -128 = no data
  const DL = toInt8(DLb);                      // b/10

  const lonOf = (i) => WEST + (i + 0.5) * DEG;
  const latOf = (j) => NORTH - (j + 0.5) * DEG;
  const xOfLon = (lon) => ((lon - WEST) / (EAST - WEST)) * W;
  const yOfLat = (lat) => ((NORTH - lat) / (NORTH - SOUTH)) * H;
  const cellArea = new Float32Array(H);
  for (let j = 0; j < H; j++) cellArea[j] = Math.cos((latOf(j) * Math.PI) / 180);

  const REGIONS = {
    all: { name: 'Whole map', box: null },
    rondonia: { name: 'Rondônia', box: META.regions.rondonia.bbox, color: 'var(--c-rondonia)', hex: '#2a78d6' },
    para: { name: 'Pará (BR-163)', box: META.regions.para.bbox, color: 'var(--c-para)', hex: '#eb6834' },
    control: { name: 'Intact forest (control)', box: META.regions.control.bbox, color: 'var(--c-control)', hex: '#6f6d68' },
  };
  // lon/lat box → cell index box [i0, j0, i1, j1) (exclusive ends)
  const cellBox = ([w, s, e, n]) => [Math.round(xOfLon(w)), Math.round(yOfLat(n)), Math.round(xOfLon(e)), Math.round(yOfLat(s))];

  const fmtSigned = d3.format('+.1f');
  const fmtSigned2 = d3.format('+.2f');
  const fmtInt = d3.format(',');
  const fmtLat = (v) => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'S' : 'N'}`;
  const fmtLon = (v) => `${Math.abs(v).toFixed(2)}°${v < 0 ? 'W' : 'E'}`;
  const windowLabel = (y) => (y <= 2001 ? '2001' : `${Math.max(2001, y - 2)}–${String(y).slice(2)}`);
  const minus = (s) => s.replace('-', '−');

  // ---------------------------------------------------------------- 2. state
  const state = {
    layer: 'ndvi',
    year: 2022,
    preset: 'rondonia',
    box: cellBox(REGIONS.rondonia.box),  // null = whole map
    filter: null,                        // scatter brush: {x0, x1, y0, y1} in data units
  };

  // 3-year trailing mean of single-year changes, per cell (the "frame" shown everywhere)
  const fN = new Float32Array(N), fL = new Float32Array(N);
  function frameAt(yi, k, arr, scale) {
    let s = 0, c = 0;
    for (let y = Math.max(0, yi - 2); y <= yi; y++) {
      const v = arr[y * N + k];
      if (v !== -128) { s += v; c++; }
    }
    return c ? s / c / scale : NaN;
  }
  function computeFrame() {
    const yi = YEARS.indexOf(state.year);
    for (let k = 0; k < N; k++) {
      if (baseN[k] === 255) { fN[k] = NaN; fL[k] = NaN; continue; }
      fN[k] = frameAt(yi, k, DN, 200);
      fL[k] = frameAt(yi, k, DL, 10);
    }
  }

  // cells inside the current selection
  let selCells = new Int32Array(0);
  function computeSelection() {
    const [i0, j0, i1, j1] = state.box || [0, 0, W, H];
    const out = [];
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      const k = j * W + i;
      if (baseN[k] !== 255) out.push(k);
    }
    selCells = Int32Array.from(out);
  }

  // per-year summary of a set of cells: cleared vs stable temperature change, % area cleared
  function seriesFor(cells) {
    let areaTot = 0;
    for (const k of cells) areaTot += cellArea[(k / W) | 0];
    return YEARS.map((year, yi) => {
      let sC = 0, nC = 0, sS = 0, nS = 0, sA = 0, nA = 0, aCl = 0;
      for (const k of cells) {
        const dn = frameAt(yi, k, DN, 200), dl = frameAt(yi, k, DL, 10);
        if (!Number.isNaN(dl)) { sA += dl; nA++; }
        if (!Number.isNaN(dn) && !Number.isNaN(dl)) {
          if (dn < -DROP) { sC += dl; nC++; } else if (Math.abs(dn) < STABLE) { sS += dl; nS++; }
        }
        const c = clr[k];
        if (c !== 0 && c !== 255 && c + 2000 <= year) aCl += cellArea[(k / W) | 0];
      }
      const cleared = nC ? sC / nC : NaN, stable = nS ? sS / nS : NaN;
      return {
        year, cleared, stable, all: nA ? sA / nA : NaN, nC, nS,
        effect: nC >= MIN_CLEARED && nS >= MIN_CLEARED ? cleared - stable : NaN,
        pctCleared: areaTot ? (100 * aCl) / areaTot : 0,
      };
    });
  }
  function cellsInBox(box) {
    const [i0, j0, i1, j1] = box, out = [];
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) { const k = j * W + i; if (baseN[k] !== 255) out.push(k); }
    return out;
  }
  const controlSeries = seriesFor(cellsInBox(cellBox(REGIONS.control.box)));
  let selSeries = [];

  // ---------------------------------------------------------------- color scales
  const NDVI_DOM = 0.3, LST_DOM = 5;
  const NODATA_RGB = [201, 199, 189], UNCLEARED_RGB = [240, 239, 236], FADE_RGB = [228, 226, 219];
  const rgbOf = (c) => { const o = d3.rgb(c); return [o.r, o.g, o.b]; };
  const LUT = (interp) => d3.range(256).map((i) => rgbOf(interp(i / 255)));
  const lutNDVI = LUT(d3.interpolateBrBG);
  const lutLST = LUT((t) => d3.interpolateRdBu(1 - t));
  const yearColor = d3.scaleSequential((t) => d3.interpolateYlOrBr(0.22 + 0.78 * t)).domain([2004, 2022]);
  const lutIndex = (v, dom) => Math.max(0, Math.min(255, Math.round(((v + dom) / (2 * dom)) * 255)));
  const colorNDVI = (v) => d3.interpolateBrBG(Math.max(0, Math.min(1, (v + NDVI_DOM) / (2 * NDVI_DOM))));
  const colorLST = (v) => d3.interpolateRdBu(1 - Math.max(0, Math.min(1, (v + LST_DOM) / (2 * LST_DOM))));

  // ---------------------------------------------------------------- 3. map
  const canvas = document.getElementById('map-canvas');
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const mapSvg = d3.select('#map-svg');

  function inFilter(k) {
    const f = state.filter;
    if (!f) return true;
    const x = fN[k], y = fL[k];
    return x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1;
  }

  function drawMap() {
    const d = img.data, layer = state.layer, f = state.filter;
    for (let k = 0; k < N; k++) {
      let rgb;
      if (baseN[k] === 255) rgb = NODATA_RGB;
      else if (layer === 'ndvi') rgb = Number.isNaN(fN[k]) ? NODATA_RGB : lutNDVI[lutIndex(fN[k], NDVI_DOM)];
      else if (layer === 'lst') rgb = Number.isNaN(fL[k]) ? NODATA_RGB : lutLST[lutIndex(fL[k], LST_DOM)];
      else {
        const c = clr[k];
        rgb = c !== 0 && c !== 255 && c + 2000 <= state.year ? yearRGB[c] : UNCLEARED_RGB;
      }
      if (f && baseN[k] !== 255 && !inFilter(k)) {
        rgb = [rgb[0] * 0.15 + FADE_RGB[0] * 0.85, rgb[1] * 0.15 + FADE_RGB[1] * 0.85, rgb[2] * 0.15 + FADE_RGB[2] * 0.85];
      }
      const o = k * 4;
      d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  // year colors are looked up often in the "cleared" layer; cache them
  const yearRGB = {};
  for (let y = 2004; y <= 2022; y++) yearRGB[y - 2000] = rgbOf(yearColor(y));

  // static overlay: graticule, borders, labels, region boxes, annotations
  const projection = d3.geoTransform({ point(lon, lat) { this.stream.point(xOfLon(lon), yOfLat(lat)); } });
  const geoPath = d3.geoPath(projection);
  const gBase = mapSvg.append('g');
  for (let lon = -70; lon <= -50; lon += 5) gBase.append('line').attr('class', 'graticule').attr('x1', xOfLon(lon)).attr('x2', xOfLon(lon)).attr('y1', 0).attr('y2', H);
  for (let lat = -15; lat <= 0; lat += 5) gBase.append('line').attr('class', 'graticule').attr('y1', yOfLat(lat)).attr('y2', yOfLat(lat)).attr('x1', 0).attr('x2', W);
  gBase.append('g').selectAll('path').data(BORDERS.features).join('path').attr('class', 'border').attr('d', geoPath);
  for (let lon = -70; lon <= -50; lon += 5) gBase.append('text').attr('class', 'tick-label').attr('x', xOfLon(lon) + 3).attr('y', H - 5).text(`${-lon}°W`);
  for (let lat = -15; lat <= 0; lat += 5) gBase.append('text').attr('class', 'tick-label').attr('x', 4).attr('y', yOfLat(lat) - 3).text(lat === 0 ? '0°' : `${-lat}°S`);
  const annos = [
    { lon: -61.6, lat: -15.6, text: 'the “arc of deforestation”' },
    { lon: -61.2, lat: -2.15, text: 'Amazon River' },
    { lon: -50.5, lat: -16.6, text: 'Cerrado (savanna)' },
  ];
  gBase.selectAll('text.anno').data(annos).join('text').attr('class', 'anno').attr('x', (d) => xOfLon(d.lon)).attr('y', (d) => yOfLat(d.lat)).text((d) => d.text);

  const brushG = mapSvg.append('g').attr('class', 'brush');
  const gRegions = mapSvg.append('g');
  const hoverRect = mapSvg.append('rect').attr('class', 'hover-cell').attr('width', 1).attr('height', 1).style('display', 'none');

  function drawRegions() {
    const data = ['rondonia', 'para', 'control'].map((key) => ({ key, ...REGIONS[key], cb: cellBox(REGIONS[key].box) }));
    gRegions.selectAll('g.region').data(data, (d) => d.key).join((enter) => {
      const g = enter.append('g').attr('class', 'region');
      g.append('rect').attr('class', 'region-box');
      g.append('text').attr('class', 'region-label');
      return g;
    })
      .each(function (d) {
        const g = d3.select(this), [i0, j0, i1, j1] = d.cb, active = state.preset === d.key;
        g.select('rect').attr('x', i0).attr('y', j0).attr('width', i1 - i0).attr('height', j1 - j0)
          .attr('stroke', d.hex).attr('stroke-opacity', active ? 1 : 0.55).attr('stroke-dasharray', active ? null : '3 3');
        g.select('text').attr('x', i0 + 2).attr('y', j0 - 4).attr('fill', d.hex).text(d.key === 'control' ? 'Intact forest (control)' : d.name)
          .on('click', (ev) => { ev.stopPropagation(); setPreset(d.key); });
      });
  }

  // brush = choose an area
  let programmaticBrush = false;
  const mapBrush = d3.brush().extent([[0, 0], [W, H]])
    .on('end', (ev) => {
      if (programmaticBrush) return;
      if (!ev.selection) { setArea('all', null); return; }
      const [[x0, y0], [x1, y1]] = ev.selection;
      const box = [Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1)];
      if (box[2] - box[0] < 3 || box[3] - box[1] < 3) { setArea('all', null); return; }
      setArea('custom', box);
      hideHint();
    });
  brushG.call(mapBrush);
  function moveMapBrush(box) {
    programmaticBrush = true;
    brushG.call(mapBrush.move, box ? [[box[0], box[1]], [box[2], box[3]]] : null);
    programmaticBrush = false;
  }

  // hover tooltip with per-square history
  const tooltip = d3.select('#tooltip');
  let brushing = false;
  brushG.on('pointerdown.flag', () => { brushing = true; tooltip.attr('hidden', true); });
  window.addEventListener('pointerup', () => { brushing = false; });
  mapSvg.on('pointermove', (ev) => {
    if (brushing) return;
    const [mx, my] = d3.pointer(ev, mapSvg.node());
    const i = Math.floor(mx), j = Math.floor(my);
    if (i < 0 || j < 0 || i >= W || j >= H) return hideTooltip();
    const k = j * W + i;
    hoverRect.style('display', null).attr('x', i).attr('y', j);
    showTooltip(ev, k, i, j);
  }).on('pointerleave', hideTooltip);

  function hideTooltip() { tooltip.attr('hidden', true); hoverRect.style('display', 'none'); }

  function showTooltip(ev, k, i, j) {
    const node = tooltip.node();
    if (baseN[k] === 255) {
      node.innerHTML = `<h5>${fmtLat(latOf(j))}, ${fmtLon(lonOf(i))}</h5><div>Water or no data</div>`;
    } else {
      const b = baseN[k] / 250, c = clr[k];
      const status = c && c !== 255 ? `<b style="color:var(--c-cleared)">cleared in ${c + 2000}</b>`
        : Math.abs(fN[k]) < STABLE ? '<b style="color:var(--c-stable)">stable</b>' : '<b>changed, not cleared</b>';
      const cover = b >= 0.75 ? 'dense forest' : b >= 0.55 ? 'open forest / mixed' : 'savanna, crops or pasture';
      node.innerHTML = `
        <h5>${fmtLat(latOf(j))}, ${fmtLon(lonOf(i))}</h5>
        <div class="tt-row"><span>2001–03 greenness</span><b>${b.toFixed(2)} <span class="muted">(${cover})</span></b></div>
        <div class="tt-row"><span>Greenness change, ${windowLabel(state.year)}</span><b>${Number.isNaN(fN[k]) ? '—' : minus(fmtSigned2(fN[k]))}</b></div>
        <div class="tt-row"><span>Temperature change</span><b>${Number.isNaN(fL[k]) ? '—' : minus(fmtSigned(fL[k])) + ' °C'}</b></div>
        <div class="tt-row"><span>Status</span>${status}</div>
        <div class="spark-title">Greenness change by year (single dry seasons)</div><div class="spark" id="spark-n"></div>
        <div class="spark-title">Temperature change by year, °C</div><div class="spark" id="spark-l"></div>`;
      sparkline('#spark-n', YEARS.map((y, yi) => DN[yi * N + k] === -128 ? NaN : DN[yi * N + k] / 200), '#8c510a', c && c !== 255 ? c + 2000 : null);
      sparkline('#spark-l', YEARS.map((y, yi) => DL[yi * N + k] === -128 ? NaN : DL[yi * N + k] / 10), '#b2182b', c && c !== 255 ? c + 2000 : null);
    }
    tooltip.attr('hidden', null);
    const r = node.getBoundingClientRect();
    let x = ev.clientX + 16, y = ev.clientY + 16;
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - 16;
    if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - 16;
    node.style.left = `${x}px`; node.style.top = `${y}px`;
  }

  function sparkline(sel, vals, color, markYear) {
    const w = 250, h = 38, m = { l: 26, r: 4, t: 4, b: 4 };
    const x = d3.scaleLinear().domain([2001, 2022]).range([m.l, w - m.r]);
    const ext = d3.extent(vals.filter((v) => !Number.isNaN(v)).concat([0]));
    const y = d3.scaleLinear().domain(ext[0] === ext[1] ? [-1, 1] : ext).nice(2).range([h - m.b, m.t]);
    const svg = d3.select(sel).append('svg').attr('width', w).attr('height', h);
    svg.append('line').attr('x1', m.l).attr('x2', w - m.r).attr('y1', y(0)).attr('y2', y(0)).attr('stroke', '#c3c2b7');
    svg.append('text').attr('x', m.l - 4).attr('y', y(y.domain()[1]) + 8).attr('text-anchor', 'end').attr('font-size', 9).attr('fill', '#898781').text(minus(d3.format('+.2~f')(y.domain()[1])));
    svg.append('text').attr('x', m.l - 4).attr('y', y(y.domain()[0])).attr('text-anchor', 'end').attr('font-size', 9).attr('fill', '#898781').text(minus(d3.format('+.2~f')(y.domain()[0])));
    if (markYear) svg.append('line').attr('x1', x(markYear)).attr('x2', x(markYear)).attr('y1', m.t).attr('y2', h - m.b).attr('stroke', '#b2182b').attr('stroke-dasharray', '2 2');
    svg.append('rect').attr('x', x(state.year - 2)).attr('width', x(state.year) - x(state.year - 2)).attr('y', m.t).attr('height', h - m.t - m.b).attr('fill', '#000').attr('opacity', 0.05);
    svg.append('path').datum(vals.map((v, i) => [YEARS[i], v]))
      .attr('d', d3.line().defined((d) => !Number.isNaN(d[1])).x((d) => x(d[0])).y((d) => y(d[1])))
      .attr('fill', 'none').attr('stroke', color).attr('stroke-width', 1.6);
  }

  const hint = document.getElementById('map-hint');
  function hideHint() { hint.style.opacity = 0; }

  // ---------------------------------------------------------------- 4. scatter
  const SC = { w: 420, h: 290, m: { l: 42, r: 12, t: 12, b: 36 } };
  const sx = d3.scaleLinear().domain([-0.5, 0.2]).range([SC.m.l, SC.w - SC.m.r]);
  const sy = d3.scaleLinear().domain([-3, 9]).range([SC.h - SC.m.b, SC.m.t]);
  const BX = 0.02, BY = 0.3;
  const nbx = Math.round((sx.domain()[1] - sx.domain()[0]) / BX), nby = Math.round((sy.domain()[1] - sy.domain()[0]) / BY);
  const scSvg = d3.select('#scatter').append('svg').attr('viewBox', `0 0 ${SC.w} ${SC.h}`).attr('role', 'img')
    .attr('aria-label', 'Two-dimensional histogram of greenness change versus temperature change');
  scSvg.append('rect').attr('class', 'band').attr('x', sx(-STABLE)).attr('width', sx(STABLE) - sx(-STABLE)).attr('y', SC.m.t).attr('height', SC.h - SC.m.t - SC.m.b);
  scSvg.append('g').attr('class', 'axis').attr('transform', `translate(0,${SC.h - SC.m.b})`)
    .call(d3.axisBottom(sx).ticks(7).tickFormat((d) => minus(d3.format('+.1~f')(d))).tickSizeOuter(0));
  scSvg.append('g').attr('class', 'axis').attr('transform', `translate(${SC.m.l},0)`)
    .call(d3.axisLeft(sy).ticks(6).tickFormat((d) => minus(d3.format('+~f')(d))).tickSize(-(SC.w - SC.m.l - SC.m.r)))
    .call((g) => g.selectAll('.tick line').attr('class', 'gridline')).call((g) => g.select('.domain').remove());
  scSvg.append('text').attr('class', 'axis-title').attr('x', SC.w - SC.m.r).attr('y', SC.h - 4).attr('text-anchor', 'end').text('greenness change (NDVI) →');
  scSvg.append('text').attr('class', 'axis-title').attr('x', SC.m.l).attr('y', SC.h - 4).text('← less green');
  scSvg.append('text').attr('class', 'axis-title').attr('transform', `translate(11,${SC.m.t}) rotate(-90)`).attr('text-anchor', 'end').text('temperature change, °C →');
  const scBg = scSvg.append('g'), scFg = scSvg.append('g');
  scSvg.append('line').attr('class', 'ref').attr('x1', SC.m.l).attr('x2', SC.w - SC.m.r).attr('y1', sy(0)).attr('y2', sy(0));
  scSvg.append('line').attr('class', 'ref-dash').attr('x1', sx(-DROP)).attr('x2', sx(-DROP)).attr('y1', SC.m.t).attr('y2', SC.h - SC.m.b);
  scSvg.append('text').attr('x', sx(-DROP) - 4).attr('y', SC.m.t + 10).attr('text-anchor', 'end').attr('class', 'label-strong').style('fill', 'var(--c-cleared)').text('← cleared');
  scSvg.append('text').attr('x', sx(0)).attr('y', SC.m.t + 10).attr('text-anchor', 'middle').attr('class', 'label-strong').style('fill', 'var(--c-stable)').text('stable');
  const scMedian = scSvg.append('path').attr('class', 'median-line');
  const scMeans = scSvg.append('g');
  const scBrushG = scSvg.append('g').attr('class', 'brush');
  let programmaticScBrush = false;
  const scBrush = d3.brush().extent([[SC.m.l, SC.m.t], [SC.w - SC.m.r, SC.h - SC.m.b]])
    .on('brush end', (ev) => {
      if (programmaticScBrush) return;
      if (!ev.selection) { state.filter = null; }
      else {
        const [[x0, y0], [x1, y1]] = ev.selection;
        state.filter = { x0: sx.invert(x0), x1: sx.invert(x1), y0: sy.invert(y1), y1: sy.invert(y0) };
      }
      drawMap();
    });
  scBrushG.call(scBrush);
  function setFilter(f) {
    state.filter = f;
    programmaticScBrush = true;
    scBrushG.call(scBrush.move, f ? [[sx(f.x0), sy(f.y1)], [sx(f.x1), sy(f.y0)]] : null);
    programmaticScBrush = false;
  }

  d3.select('#scatter-legend').html(`
    <span><i style="background:linear-gradient(90deg,#c6dbef,#08306b)"></i>squares in selected area (darker = more)</span>
    <span><i style="background:#e4e2db"></i>rest of map</span>
    <span><i style="background:#0b0b0b;height:2px"></i>median</span>`);

  function binCounts(cells) {
    const counts = new Uint32Array(nbx * nby);
    const [x0] = sx.domain(), [y0] = sy.domain();
    for (const k of cells) {
      const x = fN[k], y = fL[k];
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      const bi = Math.floor((x - x0) / BX), bj = Math.floor((y - y0) / BY);
      if (bi < 0 || bj < 0 || bi >= nbx || bj >= nby) continue;
      counts[bj * nbx + bi]++;
    }
    const out = [];
    for (let bj = 0; bj < nby; bj++) for (let bi = 0; bi < nbx; bi++) {
      const c = counts[bj * nbx + bi];
      if (c) out.push({ bi, bj, c });
    }
    return out;
  }
  let allCellsList = null;
  function drawScatter() {
    const [x0] = sx.domain(), [y0] = sy.domain();
    const bw = sx(x0 + BX) - sx(x0), bh = sy(y0) - sy(y0 + BY);
    const place = (s) => s.attr('x', (d) => sx(x0 + d.bi * BX)).attr('y', (d) => sy(y0 + (d.bj + 1) * BY)).attr('width', bw + 0.3).attr('height', bh + 0.3);
    // background: whole map, only when a sub-area is selected
    if (!allCellsList) { const a = []; for (let k = 0; k < N; k++) if (baseN[k] !== 255) a.push(k); allCellsList = Int32Array.from(a); }
    const bg = state.box ? binCounts(allCellsList) : [];
    scBg.selectAll('rect').data(bg, (d) => d.bj * nbx + d.bi).join('rect').call(place).attr('fill', '#e4e2db');
    const fg = binCounts(selCells);
    const maxC = d3.max(fg, (d) => d.c) || 1;
    const col = d3.scaleSequentialLog((t) => d3.interpolateBlues(0.28 + 0.72 * t)).domain([1, Math.max(2, maxC)]);
    scFg.selectAll('rect').data(fg, (d) => d.bj * nbx + d.bi).join('rect').call(place).attr('fill', (d) => col(d.c));

    // median temperature change per 0.05-wide greenness bin (≥ 20 squares)
    const edges = d3.range(-0.5, 0.2001, 0.05), groups = edges.slice(0, -1).map(() => []);
    for (const k of selCells) {
      const x = fN[k], y = fL[k];
      if (Number.isNaN(x) || Number.isNaN(y) || x < -0.5 || x >= 0.2) continue;
      groups[Math.floor((x + 0.5) / 0.05)].push(y);
    }
    const med = groups.map((g, i) => [edges[i] + 0.025, g.length >= 20 ? d3.median(g) : NaN]);
    scMedian.attr('d', d3.line().defined((d) => !Number.isNaN(d[1])).x((d) => sx(d[0])).y((d) => sy(Math.max(-3, Math.min(9, d[1]))))(med));

    // group means and the bracket showing the clearing effect
    const s = selSeries[YEARS.indexOf(state.year)];
    scMeans.selectAll('*').remove();
    if (s && !Number.isNaN(s.effect)) {
      const yc = sy(s.cleared), ys = sy(s.stable), bx = sx(-0.125);
      scMeans.append('line').attr('x1', sx(-0.5)).attr('x2', sx(-DROP)).attr('y1', yc).attr('y2', yc).attr('stroke', 'var(--c-cleared)').attr('stroke-width', 2);
      scMeans.append('line').attr('x1', sx(-STABLE)).attr('x2', sx(STABLE)).attr('y1', ys).attr('y2', ys).attr('stroke', 'var(--c-stable)').attr('stroke-width', 2);
      scMeans.append('line').attr('x1', sx(-DROP)).attr('x2', bx).attr('y1', yc).attr('y2', yc).attr('stroke', 'var(--c-cleared)').attr('stroke-dasharray', '2 2');
      scMeans.append('line').attr('x1', bx).attr('x2', sx(-STABLE)).attr('y1', ys).attr('y2', ys).attr('stroke', 'var(--c-stable)').attr('stroke-dasharray', '2 2');
      scMeans.append('path').attr('d', `M${bx - 4},${yc}H${bx}V${ys}H${bx - 4}`).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 1.3);
      scMeans.append('text').attr('x', bx + 4).attr('y', (yc + ys) / 2 + 4).attr('class', 'label-strong halo').text(`${minus(fmtSigned(s.effect))} °C`);
      scMeans.append('text').attr('x', sx(-0.5) + 2).attr('y', yc - 5).attr('class', 'halo').attr('font-size', 10).style('fill', 'var(--c-cleared)').text(`cleared avg ${minus(fmtSigned(s.cleared))}`);
      scMeans.append('text').attr('x', sx(STABLE) + 3).attr('y', ys + 12).attr('class', 'halo').attr('font-size', 10).style('fill', 'var(--c-stable)').text(`stable avg ${minus(fmtSigned(s.stable))}`);
    }
  }

  // ---------------------------------------------------------------- 5. time series
  const TS = { w: 420, h: 200, m: { l: 42, r: 92, t: 12, b: 22 } };
  const tx = d3.scaleLinear().domain([2001, 2022]).range([TS.m.l, TS.w - TS.m.r]);
  const ty = d3.scaleLinear().range([TS.h - TS.m.b, TS.m.t]);
  const tsSvg = d3.select('#ts').append('svg').attr('viewBox', `0 0 ${TS.w} ${TS.h}`).attr('role', 'img')
    .attr('aria-label', 'Line chart of temperature change over time for cleared squares, stable squares and the intact control');
  const tsX = tsSvg.append('g').attr('class', 'axis').attr('transform', `translate(0,${TS.h - TS.m.b})`);
  const tsY = tsSvg.append('g').attr('class', 'axis').attr('transform', `translate(${TS.m.l},0)`);
  tsSvg.append('text').attr('class', 'axis-title').attr('transform', `translate(11,${TS.m.t}) rotate(-90)`).attr('text-anchor', 'end').text('temperature change, °C');
  const tsGap = tsSvg.append('path').attr('fill', '#fbe5e3');
  const tsZero = tsSvg.append('line').attr('class', 'ref');
  const tsLines = tsSvg.append('g');
  const tsCursor = tsSvg.append('g');
  const tsHit = tsSvg.append('rect').attr('x', TS.m.l).attr('y', TS.m.t).attr('width', TS.w - TS.m.l - TS.m.r).attr('height', TS.h - TS.m.t - TS.m.b).attr('fill', 'transparent').style('cursor', 'pointer');

  const TA = { w: 420, h: 84, m: { l: 42, r: 92, t: 18, b: 20 } };
  const ay = d3.scaleLinear().range([TA.h - TA.m.b, TA.m.t]);
  const taSvg = d3.select('#ts-area').append('svg').attr('viewBox', `0 0 ${TA.w} ${TA.h}`).attr('role', 'img').attr('aria-label', 'Area chart of the share of the selected area cleared over time');
  const taY = taSvg.append('g').attr('class', 'axis').attr('transform', `translate(${TA.m.l},0)`);
  const taX = taSvg.append('g').attr('class', 'axis').attr('transform', `translate(0,${TA.h - TA.m.b})`);
  taSvg.append('text').attr('x', TA.m.l).attr('y', 10).attr('class', 'label-strong').text('Share of selected area cleared (cumulative)');
  const taArea = taSvg.append('path').attr('fill', '#d9b37a');
  const taLine = taSvg.append('path').attr('fill', 'none').attr('stroke', '#8c510a').attr('stroke-width', 2);
  const taCursor = taSvg.append('g');
  const taHit = taSvg.append('rect').attr('x', TA.m.l).attr('y', TA.m.t).attr('width', TA.w - TA.m.l - TA.m.r).attr('height', TA.h - TA.m.t - TA.m.b).attr('fill', 'transparent').style('cursor', 'pointer');

  const pickYear = (ev, svg) => { const [mx] = d3.pointer(ev, svg.node()); setYear(Math.round(Math.max(2001, Math.min(2022, tx.invert(mx))))); };
  tsHit.on('click', (ev) => pickYear(ev, tsSvg)).on('pointermove', (ev) => { if (ev.buttons) pickYear(ev, tsSvg); });
  taHit.on('click', (ev) => pickYear(ev, taSvg)).on('pointermove', (ev) => { if (ev.buttons) pickYear(ev, taSvg); });

  function drawTS() {
    const ser = selSeries, ctrl = controlSeries;
    const showCtrl = state.preset !== 'control';
    const vals = ser.flatMap((d) => [d.nC >= MIN_CLEARED ? d.cleared : NaN, d.stable]).concat(showCtrl ? ctrl.map((d) => d.all) : [], [0]).filter((v) => !Number.isNaN(v));
    ty.domain(d3.extent(vals)).nice();
    tsX.call(d3.axisBottom(tx).tickValues([2001, 2005, 2010, 2015, 2022]).tickFormat(d3.format('d')).tickSizeOuter(0));
    tsY.call(d3.axisLeft(ty).ticks(5).tickFormat((d) => minus(d3.format('+~f')(d))).tickSize(-(TS.w - TS.m.l - TS.m.r)))
      .call((g) => g.selectAll('.tick line').attr('class', 'gridline')).call((g) => g.select('.domain').remove());
    tsZero.attr('x1', TS.m.l).attr('x2', TS.w - TS.m.r).attr('y1', ty(0)).attr('y2', ty(0));

    const okC = (d) => d.nC >= MIN_CLEARED && !Number.isNaN(d.cleared);
    tsGap.attr('d', d3.area().defined((d) => okC(d) && !Number.isNaN(d.stable)).x((d) => tx(d.year)).y0((d) => ty(d.stable)).y1((d) => ty(d.cleared))(ser));
    const lines = [
      // faint dotted line where only 5–19 squares count as cleared (too few to trust, but shows the trend)
      { key: 'cleared-few', label: null, color: '#b2182b', pts: ser.map((d) => [d.year, d.nC >= 5 ? d.cleared : NaN]), w: 1.2, dash: '1.5 3', opacity: 0.6 },
      { key: 'cleared', label: 'Cleared', color: '#b2182b', pts: ser.map((d) => [d.year, okC(d) ? d.cleared : NaN]), w: 2.2 },
      { key: 'stable', label: 'Stable forest', color: '#01665e', pts: ser.map((d) => [d.year, d.stable]), w: 2.2 },
    ];
    if (showCtrl) lines.push({ key: 'control', label: 'Intact control', color: '#898781', pts: ctrl.map((d) => [d.year, d.all]), w: 1.4, dash: '4 3' });
    const line = d3.line().defined((d) => !Number.isNaN(d[1])).x((d) => tx(d[0])).y((d) => ty(d[1]));
    tsLines.selectAll('path').data(lines, (d) => d.key).join('path').attr('fill', 'none').attr('stroke', (d) => d.color).attr('stroke-width', (d) => d.w)
      .attr('stroke-dasharray', (d) => d.dash || null).attr('opacity', (d) => d.opacity ?? 1).attr('d', (d) => line(d.pts));
    // direct labels at the line ends, nudged apart
    const ends = lines.filter((l) => l.label).map((l) => { const last = [...l.pts].reverse().find((p) => !Number.isNaN(p[1])); return last ? { ...l, y: ty(last[1]) } : null; }).filter(Boolean).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
    tsLines.selectAll('text').data(ends, (d) => d.key).join('text').attr('x', TS.w - TS.m.r + 6).attr('y', (d) => d.y + 4).attr('fill', (d) => d.color).attr('font-weight', 600).text((d) => d.label);

    ay.domain([0, Math.max(1, d3.max(ser, (d) => d.pctCleared))]).nice();
    taY.call(d3.axisLeft(ay).ticks(2).tickFormat((d) => `${d}%`).tickSize(-(TA.w - TA.m.l - TA.m.r))).call((g) => g.selectAll('.tick line').attr('class', 'gridline')).call((g) => g.select('.domain').remove());
    taX.call(d3.axisBottom(tx).tickValues([2001, 2005, 2010, 2015, 2022]).tickFormat(d3.format('d')).tickSizeOuter(0));
    taArea.attr('d', d3.area().x((d) => tx(d.year)).y0(ay(0)).y1((d) => ay(d.pctCleared))(ser));
    taLine.attr('d', d3.line().x((d) => tx(d.year)).y((d) => ay(d.pctCleared))(ser));
    drawCursor();
  }

  function drawCursor() {
    const yi = YEARS.indexOf(state.year), s = selSeries[yi], c = controlSeries[yi], X = tx(state.year);
    tsCursor.selectAll('*').remove();
    tsCursor.append('rect').attr('x', tx(Math.max(2001, state.year - 2))).attr('width', X - tx(Math.max(2001, state.year - 2))).attr('y', TS.m.t).attr('height', TS.h - TS.m.t - TS.m.b).attr('fill', '#000').attr('opacity', 0.04);
    tsCursor.append('line').attr('x1', X).attr('x2', X).attr('y1', TS.m.t).attr('y2', TS.h - TS.m.b).attr('stroke', 'var(--ink)').attr('stroke-width', 1);
    const dots = [[s.nC >= MIN_CLEARED ? s.cleared : NaN, '#b2182b'], [s.stable, '#01665e']];
    if (state.preset !== 'control') dots.push([c.all, '#898781']);
    for (const [v, col] of dots) if (!Number.isNaN(v)) tsCursor.append('circle').attr('cx', X).attr('cy', ty(v)).attr('r', 4).attr('fill', col).attr('stroke', '#fff').attr('stroke-width', 2);
    taCursor.selectAll('*').remove();
    taCursor.append('line').attr('x1', X).attr('x2', X).attr('y1', TA.m.t).attr('y2', TA.h - TA.m.b).attr('stroke', 'var(--ink)');
    taCursor.append('circle').attr('cx', X).attr('cy', ay(s.pctCleared)).attr('r', 4).attr('fill', '#8c510a').attr('stroke', '#fff').attr('stroke-width', 2);
    taCursor.append('text').attr('x', TA.w - TA.m.r + 6).attr('y', ay(s.pctCleared) + 4).attr('class', 'label-strong').text(`${s.pctCleared.toFixed(1)}% by ${state.year}`);
  }

  // ---------------------------------------------------------------- 6. readout, legend, controls
  function areaName() {
    if (state.preset === 'custom') { const [i0, j0, i1, j1] = state.box; return `Your area · ${fmtInt(selCells.length)} squares`; }
    return REGIONS[state.preset].name;
  }
  function drawReadout() {
    const s = selSeries[YEARS.indexOf(state.year)], win = windowLabel(state.year);
    const swatch = REGIONS[state.preset] && REGIONS[state.preset].hex ? `<i class="sw" style="--c:${REGIONS[state.preset].hex}"></i>` : '';
    d3.select('#readout-area').html(swatch + areaName());
    const num = d3.select('#readout-num'), text = d3.select('#readout-text');
    if (state.preset === 'control') {
      num.classed('na', false).text(`${minus(fmtSigned(s.all))} °C`);
      text.html(`This is our <b>control</b>: forest that was never cleared. By ${win} it averaged <b>${minus(fmtSigned(s.all))} °C</b> warmer than in 2001–03, and only <b>${s.nC}</b> of its ${fmtInt(selCells.length)} squares lost enough greenness to count as cleared. That background warming (climate, droughts) also hits cleared land, which is why we compare cleared squares with stable ones nearby.`);
    } else if (Number.isNaN(s.effect)) {
      num.classed('na', true).text(state.year < 2005 ? 'Too early to tell' : 'Not enough cleared land');
      text.html(state.year < 2005
        ? `In ${win} almost nothing had been cleared yet relative to the 2001–03 baseline. Press ▶ or drag the year slider forward.`
        : `Only <b>${s.nC}</b> squares here lost more than 0.20 NDVI by ${win} (we need at least ${MIN_CLEARED} to compare). Try Rondônia or Pará, or drag a box over the brown areas of the map.`);
    } else {
      num.classed('na', false).text(`${minus(fmtSigned(s.effect))} °C`);
      text.html(`extra warming from clearing, ${win}. The <b>${fmtInt(s.nC)}</b> cleared squares here warmed <b style="color:#ff9b8c">${minus(fmtSigned(s.cleared))} °C</b> since 2001–03; the <b>${fmtInt(s.nS)}</b> stable forest squares around them warmed <b style="color:#7fd3c6">${minus(fmtSigned(s.stable))} °C</b>.`);
    }
  }

  const TITLES = {
    ndvi: ['Change in dry-season greenness (NDVI)', (w) => `${w} average minus 2001–03 baseline, July–September, MODIS Terra. Brown = less green.`],
    lst: ['Change in dry-season daytime land surface temperature', (w) => `${w} average minus 2001–03 baseline, °C, July–September, ~10:30 am overpass, MODIS Terra. Red = hotter.`],
    cleared: ['When each square was cleared', (w, y) => `First year (from 2004) that NDVI fell ≥ 0.20 below its 2001–03 baseline and stayed down 3 years. Showing clearing through ${y}.`],
  };
  function drawTitles() {
    const [t, sub] = TITLES[state.layer];
    d3.select('#map-title').text(t);
    d3.select('#map-sub').text(sub(windowLabel(state.year), state.year));
    d3.select('#year-range-label').text(state.layer === 'cleared' ? `to ${state.year}` : windowLabel(state.year));
  }

  function drawLegend() {
    const el = d3.select('#map-legend'); el.selectAll('*').remove();
    const w = 340, h = 40, svg = el.append('svg').attr('width', w).attr('height', h);
    const id = `lg-${state.layer}`;
    if (state.layer === 'cleared') {
      const yrs = d3.range(2004, 2023), bw = 9;
      svg.selectAll('rect.y').data(yrs).join('rect').attr('x', (d, i) => i * bw).attr('y', 4).attr('width', bw - 1).attr('height', 12).attr('fill', (d) => yearColor(d)).attr('opacity', (d) => (d <= state.year ? 1 : 0.25));
      svg.append('text').attr('x', 0).attr('y', 30).text('2004');
      svg.append('text').attr('x', yrs.length * bw - 1).attr('y', 30).attr('text-anchor', 'end').text('2022');
      const x2 = yrs.length * bw + 12;
      svg.append('rect').attr('x', x2).attr('y', 4).attr('width', 12).attr('height', 12).attr('fill', 'rgb(240,239,236)').attr('stroke', '#ccc');
      svg.append('text').attr('x', x2 + 16).attr('y', 14).text('not cleared');
      svg.append('rect').attr('x', x2).attr('y', 22).attr('width', 12).attr('height', 12).attr('fill', 'rgb(201,199,189)');
      svg.append('text').attr('x', x2 + 16).attr('y', 32).text('water / no data');
      return;
    }
    const isN = state.layer === 'ndvi', dom = isN ? NDVI_DOM : LST_DOM, colorFn = isN ? colorNDVI : colorLST;
    const grad = svg.append('defs').append('linearGradient').attr('id', id);
    d3.range(0, 1.0001, 0.1).forEach((t) => grad.append('stop').attr('offset', t).attr('stop-color', colorFn(-dom + 2 * dom * t)));
    const lw = 250, x = d3.scaleLinear().domain([-dom, dom]).range([0, lw]);
    svg.append('rect').attr('x', 0).attr('y', 4).attr('width', lw).attr('height', 12).attr('rx', 2).attr('fill', `url(#${id})`);
    const ticks = isN ? [-0.3, 0, 0.3] : [-5, 0, 5];
    ticks.forEach((t) => {
      svg.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', 16).attr('y2', 20).attr('stroke', '#898781');
      svg.append('text').attr('x', x(t)).attr('y', 31).attr('text-anchor', t === -dom ? 'start' : t === dom ? 'end' : 'middle')
        .text((t > 0 ? '+' : t < 0 ? '−' : '') + Math.abs(t) + (isN ? '' : ''));
    });
    svg.append('text').attr('x', x(-dom * 0.5)).attr('y', 31).attr('text-anchor', 'middle').attr('fill', '#898781').text(isN ? 'less green' : 'cooler');
    svg.append('text').attr('x', x(dom * 0.5)).attr('y', 31).attr('text-anchor', 'middle').attr('fill', '#898781').text(isN ? 'greener' : 'hotter');
    svg.append('text').attr('x', lw + 8).attr('y', 14).text(isN ? 'NDVI' : '°C');
    svg.append('text').attr('x', lw + 8).attr('y', 28).attr('fill', '#898781').text(isN ? '(ends ≥ ±0.3)' : '(ends ≥ ±5)');
  }

  // --- state setters
  function setLayer(layer) {
    state.layer = layer;
    d3.selectAll('#layer-seg button').attr('aria-checked', function () { return this.dataset.layer === layer; });
    drawMap(); drawTitles(); drawLegend();
  }
  function setYear(y) {
    state.year = y;
    document.getElementById('year-slider').value = y;
    computeFrame();
    drawMap(); drawTitles(); drawScatter(); drawCursor(); drawReadout();
    if (state.layer === 'cleared') drawLegend();
  }
  function setArea(preset, box) {
    state.preset = preset; state.box = box;
    d3.selectAll('#preset-chips button').attr('aria-pressed', function () { return this.dataset.preset === preset; });
    computeSelection();
    selSeries = seriesFor(selCells);
    drawRegions(); drawScatter(); drawTS(); drawReadout();
  }
  function setPreset(key) {
    const box = REGIONS[key].box ? cellBox(REGIONS[key].box) : null;
    moveMapBrush(box);
    setArea(key, box);
  }

  d3.selectAll('#layer-seg button').on('click', function () { stopPlay(); setLayer(this.dataset.layer); });
  d3.selectAll('#preset-chips button').on('click', function () { setPreset(this.dataset.preset); });
  d3.select('#year-slider').on('input', function () { stopPlay(); setYear(+this.value); });

  let playTimer = null;
  const playBtn = d3.select('#play-btn');
  function stopPlay() { if (playTimer) { playTimer.stop(); playTimer = null; } playBtn.text('▶').attr('aria-label', 'Play through the years'); }
  function play(from = null, delay = 420) {
    stopPlay();
    let y = from ?? (state.year >= 2022 ? 2003 : state.year);
    setYear(y);
    playBtn.text('❚❚').attr('aria-label', 'Pause');
    let last = 0;
    playTimer = d3.timer((elapsed) => {
      if (elapsed - last < delay) return;
      last = elapsed;
      y += 1;
      if (y > 2022) { stopPlay(); return; }
      setYear(y);
    });
  }
  playBtn.on('click', () => (playTimer ? stopPlay() : play()));

  // ---------------------------------------------------------------- initial render
  computeFrame();
  setLayer('ndvi');
  setPreset('rondonia');
  setYear(2022);

  // hero numbers from the data (so the page never disagrees with itself)
  const lastIdx = NY - 1;
  const heroEff = (key) => seriesFor(cellsInBox(cellBox(REGIONS[key].box)))[lastIdx];
  const hr = heroEff('rondonia'), hp = heroEff('para');
  d3.select('[data-stat="rondonia"]').text(`${minus(fmtSigned(hr.effect))} °C`);
  d3.select('[data-stat="para"]').text(`${minus(fmtSigned(hp.effect))} °C`);
  d3.select('[data-stat="control"]').text(`${minus(fmtSigned(controlSeries[lastIdx].all))} °C`);

  // ---------------------------------------------------------------- 7. hero swipe
  (function buildSwipe() {
    const S = 1200, BB = [-64, -11.5, -61, -8.5];   // west, south, east, north of the images
    const px = (lon) => ((lon - BB[0]) / (BB[2] - BB[0])) * S, py = (lat) => ((BB[3] - lat) / (BB[3] - BB[1])) * S;
    const svg = d3.select('#swipe').append('svg').attr('viewBox', `0 0 ${S} ${S}`);
    svg.append('defs').append('clipPath').attr('id', 'swipe-clip').append('rect').attr('id', 'swipe-clip-rect').attr('x', 0).attr('y', 0).attr('height', S).attr('width', S / 2);
    svg.append('image').attr('href', 'img/rondonia_2021-07-13.jpg').attr('width', S).attr('height', S);
    svg.append('image').attr('href', 'img/rondonia_2001-08-02.jpg').attr('width', S).attr('height', S).attr('clip-path', 'url(#swipe-clip)');
    const towns = [
      { name: 'Porto Velho', lon: -63.90, lat: -8.76 }, { name: 'Ariquemes', lon: -63.04, lat: -9.91 },
      { name: 'Jaru', lon: -62.47, lat: -10.44 }, { name: 'Ji-Paraná', lon: -61.95, lat: -10.88 },
    ];
    const tg = svg.append('g');
    tg.selectAll('circle').data(towns).join('circle').attr('class', 'city-dot').attr('cx', (d) => px(d.lon)).attr('cy', (d) => py(d.lat)).attr('r', 5);
    tg.selectAll('text').data(towns).join('text').attr('class', 'city').attr('x', (d) => px(d.lon) + 9).attr('y', (d) => py(d.lat) + 4).attr('font-size', 30).text((d) => d.name);
    svg.append('text').attr('class', 'yr-label').attr('x', 28).attr('y', S - 64).attr('font-size', 72).text('2001');
    svg.append('text').attr('class', 'yr-sub').attr('x', 32).attr('y', S - 30).attr('font-size', 26).text('2 AUGUST');
    svg.append('text').attr('class', 'yr-label').attr('x', S - 28).attr('y', S - 64).attr('text-anchor', 'end').attr('font-size', 72).text('2021');
    svg.append('text').attr('class', 'yr-sub').attr('x', S - 32).attr('y', S - 30).attr('text-anchor', 'end').attr('font-size', 26).text('13 JULY');
    const handle = svg.append('g').attr('class', 'handle');
    handle.append('line').attr('class', 'handle-line').attr('y1', 0).attr('y2', S).attr('stroke-width', 4);
    handle.append('circle').attr('class', 'handle-knob').attr('cy', S / 2).attr('r', 34);
    handle.append('path').attr('class', 'handle-arrows').attr('d', `M-8,${S / 2 - 12}l-12,12l12,12zM8,${S / 2 - 12}l12,12l-12,12z`);
    const clipRect = svg.select('#swipe-clip-rect');
    let pos = S / 2;
    const setPos = (x) => { pos = Math.max(0, Math.min(S, x)); clipRect.attr('width', pos); handle.attr('transform', `translate(${pos},0)`); };
    setPos(S / 2);
    let touched = false;
    svg.call(d3.drag().on('start drag', (ev) => { touched = true; svg.interrupt(); setPos(d3.pointer(ev, svg.node())[0]); }));
    svg.on('click', (ev) => { touched = true; svg.interrupt(); setPos(d3.pointer(ev, svg.node())[0]); });
    // keyboard
    d3.select('#swipe').attr('tabindex', 0).on('keydown', (ev) => {
      if (ev.key === 'ArrowLeft') { setPos(pos - 60); ev.preventDefault(); }
      if (ev.key === 'ArrowRight') { setPos(pos + 60); ev.preventDefault(); }
    });
    // one gentle sweep when the image first scrolls into view, to show it is draggable
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        if (!entries[0].isIntersecting || touched) return;
        io.disconnect();
        svg.transition().delay(500).duration(1400).ease(d3.easeCubicInOut).tween('pos', () => { const i = d3.interpolate(pos, S * 0.88); return (t) => setPos(i(t)); })
          .transition().duration(1800).ease(d3.easeCubicInOut).tween('pos', () => { const i = d3.interpolate(S * 0.88, S * 0.12); return (t) => setPos(i(t)); })
          .transition().duration(1100).ease(d3.easeCubicInOut).tween('pos', () => { const i = d3.interpolate(S * 0.12, S * 0.5); return (t) => setPos(i(t)); });
      }, { threshold: 0.6 });
      io.observe(document.getElementById('swipe'));
    }
  })();

  // ---------------------------------------------------------------- 8. guided tour
  const fmtEff = (key) => { const s = seriesFor(cellsInBox(cellBox(REGIONS[key].box)))[lastIdx]; return minus(fmtSigned(s.effect)); };
  const TOUR = [
    {
      title: 'Where the forest went',
      text: 'Brown squares lost dry-season greenness between 2001–03 and 2020–22. They trace the "arc of deforestation" along the southern and eastern edge of the Amazon, where highways opened the forest to cattle ranching and soy.',
      run() { setFilter(null); setLayer('ndvi'); setPreset('all'); setYear(2022); },
    },
    {
      title: 'Watch it spread',
      text: 'Now each square lights up in the year it was cleared, lightest for 2004 and darkest for 2022. Clearing moves outward from the roads year after year.',
      run() { setFilter(null); setLayer('cleared'); setPreset('all'); play(2004, 380); },
    },
    {
      title: 'Now look at temperature',
      text: 'Same map, but showing how much hotter or cooler each square got at about 10:30 am in the dry season. The hottest patches line up almost square for square with the cleared ones.',
      run() { stopPlay(); setFilter(null); setLayer('lst'); setPreset('all'); setYear(2022); },
    },
    {
      title: 'Zoom in on Rondônia',
      text: () => `In the scatter, moving left (less green) also moves up (hotter): the black median line climbs. Cleared squares warmed ${fmtEff('rondonia')} °C more than the stable forest next to them. The line chart shows that gap opening as clearing spread.`,
      run() { stopPlay(); setFilter(null); setLayer('lst'); setPreset('rondonia'); setYear(2022); },
    },
    {
      title: 'Check against the control',
      text: () => `A box of untouched forest far from roads: its squares stay bunched at zero greenness change, and it warmed only ${minus(fmtSigned(controlSeries[lastIdx].all))} °C. That's the background trend. Comparing cleared squares with stable ones nearby subtracts it out.`,
      run() { stopPlay(); setFilter(null); setLayer('lst'); setPreset('control'); setYear(2022); },
    },
    {
      title: 'Your turn',
      text: 'We boxed the most-cleared squares in the scatter, so only they stay lit on the map. Drag your own box on the map or the scatter, press ▶ to replay the years, or hover any square for its 22-year history.',
      run() { stopPlay(); setLayer('ndvi'); setPreset('all'); setYear(2022); setFilter({ x0: -0.5, x1: -DROP, y0: -3, y1: 9 }); },
    },
  ];
  let tourI = 0;
  const tourEl = d3.select('#tour');
  function showStep(i) {
    tourI = i;
    const s = TOUR[i];
    s.run();
    d3.select('#tour-step-label').text(`Step ${i + 1} of ${TOUR.length}`);
    d3.select('#tour-title').text(s.title);
    d3.select('#tour-text').text(typeof s.text === 'function' ? s.text() : s.text);
    d3.select('#tour-dots').selectAll('i').data(TOUR).join('i').classed('on', (d, j) => j === i);
    d3.select('#tour-back').attr('disabled', i === 0 ? true : null);
    d3.select('#tour-next').text(i === TOUR.length - 1 ? 'Done' : 'Next');
  }
  function endTour() { tourEl.attr('hidden', true); }
  d3.select('#tour-btn').on('click', () => {
    document.getElementById('explore').scrollIntoView({ behavior: 'smooth', block: 'start' });
    tourEl.attr('hidden', null); hideHint(); showStep(0);
  });
  d3.select('#tour-next').on('click', () => (tourI === TOUR.length - 1 ? endTour() : showStep(tourI + 1)));
  d3.select('#tour-back').on('click', () => tourI > 0 && showStep(tourI - 1));
  d3.select('#tour-exit').on('click', endTour);
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { endTour(); hideTooltip(); } });
})().catch((err) => {
  console.error(err);
  const el = document.getElementById('map-hint');
  if (el) el.textContent = `Could not load data: ${err.message}`;
});
