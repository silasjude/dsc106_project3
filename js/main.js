/* Exploring vegetation and temperature changes in the Amazon — DSC 106 Project 3, Team 11
 * D3 v7 only. Data files are built by prep/build_data.py (see README).
 *
 * Layout of this file
 *   1. data loading + grid helpers
 *   2. state + derived data (3-year frames, selection, per-area summary)
 *   3. map (canvas raster + SVG overlay, hover)
 *   4. readout, legend, year slider, controls
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
    matogrosso: { name: 'Northern Mato Grosso', box: [-58, -13, -52, -9.5], color: 'var(--c-matogrosso)', hex: '#7b3fc4' },
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
    preset: 'all',
    box: null,  // null = whole map
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
  let selSeries = [];

  // ---------------------------------------------------------------- color scales
  const NDVI_DOM = 0.3, LST_DOM = 5;
  const NODATA_RGB = [38, 43, 39];
  const rgbOf = (c) => { const o = d3.rgb(c); return [o.r, o.g, o.b]; };
  const LUT = (interp) => d3.range(256).map((i) => rgbOf(interp(i / 255)));
  const lutNDVI = LUT(d3.interpolateBrBG);
  const lutLST = LUT((t) => d3.interpolateRdBu(1 - t));
  const lutIndex = (v, dom) => Math.max(0, Math.min(255, Math.round(((v + dom) / (2 * dom)) * 255)));
  const colorNDVI = (v) => d3.interpolateBrBG(Math.max(0, Math.min(1, (v + NDVI_DOM) / (2 * NDVI_DOM))));
  const colorLST = (v) => d3.interpolateRdBu(1 - Math.max(0, Math.min(1, (v + LST_DOM) / (2 * LST_DOM))));

  // ---------------------------------------------------------------- 3. map
  const canvas = document.getElementById('map-canvas');
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const mapSvg = d3.select('#map-svg');

  function drawMap() {
    const d = img.data, isN = state.layer === 'ndvi';
    for (let k = 0; k < N; k++) {
      let rgb;
      if (baseN[k] === 255) rgb = NODATA_RGB;
      else if (isN) rgb = Number.isNaN(fN[k]) ? NODATA_RGB : lutNDVI[lutIndex(fN[k], NDVI_DOM)];
      else rgb = Number.isNaN(fL[k]) ? NODATA_RGB : lutLST[lutIndex(fL[k], LST_DOM)];
      const o = k * 4;
      d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  // static overlay: graticule, borders, labels, region boxes, annotations
  const projection = d3.geoTransform({ point(lon, lat) { this.stream.point(xOfLon(lon), yOfLat(lat)); } });
  const geoPath = d3.geoPath(projection);
  const gBase = mapSvg.append('g');
  for (let lon = -70; lon <= -50; lon += 5) gBase.append('line').attr('class', 'graticule').attr('x1', xOfLon(lon)).attr('x2', xOfLon(lon)).attr('y1', 0).attr('y2', H);
  for (let lat = -15; lat <= 0; lat += 5) gBase.append('line').attr('class', 'graticule').attr('y1', yOfLat(lat)).attr('y2', yOfLat(lat)).attr('x1', 0).attr('x2', W);
  gBase.append('g').selectAll('path').data(BORDERS.features.filter((f) => f.properties.kind === 'state')).join('path').attr('class', 'border-state').attr('d', geoPath);
  gBase.append('g').selectAll('path').data(BORDERS.features.filter((f) => f.properties.kind !== 'state')).join('path').attr('class', 'border').attr('d', geoPath);
  const places = [
    { lon: -61.5, lat: -5.6, text: 'AMAZONAS' }, { lon: -51.3, lat: -3.4, text: 'PARÁ' }, { lon: -55.0, lat: -14.4, text: 'MATO GROSSO' },
    { lon: -70.4, lat: -9.2, text: 'ACRE' }, { lon: -64.8, lat: -16.9, text: 'BOLIVIA' }, { lon: -73.2, lat: -12.2, text: 'PERU' },
  ];
  gBase.selectAll('text.state-label').data(places).join('text').attr('class', 'state-label').attr('x', (d) => xOfLon(d.lon)).attr('y', (d) => yOfLat(d.lat)).text((d) => d.text);
  for (let lon = -70; lon <= -50; lon += 5) gBase.append('text').attr('class', 'tick-label').attr('x', xOfLon(lon) + 3).attr('y', H - 5).text(`${-lon}°W`);
  for (let lat = -15; lat <= 0; lat += 5) gBase.append('text').attr('class', 'tick-label').attr('x', 4).attr('y', yOfLat(lat) - 3).text(lat === 0 ? '0°' : `${-lat}°S`);
  const annos = [
    { lon: -61.6, lat: -15.6, text: 'the “arc of deforestation”' },
    { lon: -61.2, lat: -2.15, text: 'Amazon River' },
    { lon: -50.5, lat: -16.6, text: 'Cerrado (savanna)' },
  ];
  gBase.selectAll('text.anno').data(annos).join('text').attr('class', 'anno').attr('x', (d) => xOfLon(d.lon)).attr('y', (d) => yOfLat(d.lat)).text((d) => d.text);

  const gRegions = mapSvg.append('g');
  const hoverRect = mapSvg.append('circle').attr('class', 'hover-cell').style('display', 'none');

  function drawRegions() {
    const data = ['rondonia', 'para', 'matogrosso', 'control'].map((key) => ({ key, ...REGIONS[key], cb: cellBox(REGIONS[key].box) }));
    gRegions.selectAll('g.region').data(data, (d) => d.key).join((enter) => {
      const g = enter.append('g').attr('class', 'region');
      g.append('rect').attr('class', 'region-box');
      g.append('text').attr('class', 'region-label');
      return g;
    })
      .each(function (d) {
        const g = d3.select(this), [i0, j0, i1, j1] = d.cb, active = state.preset === d.key;
        g.select('rect').attr('x', i0).attr('y', j0).attr('width', i1 - i0).attr('height', j1 - j0)
          .attr('stroke', d.hex).attr('stroke-opacity', active ? 1 : 0.55).classed('inactive', !active);
        g.select('text').attr('x', i0 + 2).attr('y', j0 - 4).attr('fill', d.hex).text(d.key === 'control' ? 'Intact forest (control)' : d.key === 'matogrosso' ? 'N. Mato Grosso' : d.name)
          .on('click', (ev) => { ev.stopPropagation(); setPreset(d.key); });
      });
  }

  // zoom: move a "camera" rectangle (map fractions) straight from the current view to the target box
  const zoomEl = document.getElementById('map-zoom');
  let view = { x: 0, y: 0, w: 1 };                  // left, top, width of the visible part (height follows)
  function applyView(v) {
    const z = 1 / v.w;
    zoomEl.style.transform = `scale(${z}) translate(${-v.x * 100}%, ${-v.y * 100}%)`;
    zoomEl.style.setProperty('--z', z);
  }
  function zoomTo(box) {
    let target = { x: 0, y: 0, w: 1 };
    if (box) {
      const [i0, j0, i1, j1] = box, pad = 1.6;
      const w = Math.min(1, Math.max(((i1 - i0) * pad) / W, ((j1 - j0) * pad) / H, 0.25));
      const clamp = (v) => Math.max(0, Math.min(1 - w, v));
      target = { x: clamp((i0 + i1) / 2 / W - w / 2), y: clamp((j0 + j1) / 2 / H - w / 2), w };
    }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const from = { ...view };
    d3.select(zoomEl).interrupt().transition().duration(reduce ? 0 : 750).ease(d3.easeCubicInOut)
      .tween('zoom', () => (t) => { view = { x: from.x + (target.x - from.x) * t, y: from.y + (target.y - from.y) * t, w: from.w + (target.w - from.w) * t }; applyView(view); });
  }

  // hover tooltip: averages the squares inside a small circle (~15 km across) that follows the pointer
  const RADIUS = 1.5;                               // in squares
  const tooltip = d3.select('#tooltip');
  const hint = document.getElementById('map-hint');
  hoverRect.attr('r', RADIUS);
  mapSvg.on('pointermove', (ev) => {
    const r = zoomEl.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * W, y = ((ev.clientY - r.top) / r.height) * H;
    if (x < 0 || y < 0 || x >= W || y >= H) return hideTooltip();
    hint.style.opacity = 0;
    hoverRect.style('display', null).attr('cx', x).attr('cy', y);
    fillTooltip(x, y);
    tooltip.attr('hidden', null);
    placeTooltip(ev);
  }).on('pointerleave', hideTooltip);

  function hideTooltip() { tooltip.attr('hidden', true); hoverRect.style('display', 'none'); }

  const meanOf = (vals) => { const v = vals.filter((n) => !Number.isNaN(n)); return v.length ? d3.mean(v) : NaN; };

  function cellsNear(x, y) {
    const out = [];
    for (let j = Math.floor(y - RADIUS); j <= Math.floor(y + RADIUS); j++) {
      for (let i = Math.floor(x - RADIUS); i <= Math.floor(x + RADIUS); i++) {
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        if ((i + 0.5 - x) ** 2 + (j + 0.5 - y) ** 2 > RADIUS ** 2) continue;
        const k = j * W + i;
        if (baseN[k] !== 255) out.push(k);
      }
    }
    return out;
  }

  function fillTooltip(x, y) {
    const node = tooltip.node();
    const cells = cellsNear(x, y);
    const where = `${fmtLat(NORTH - y * DEG)}, ${fmtLon(WEST + x * DEG)}`;
    if (!cells.length) { node.innerHTML = `<div class="tt-head">Water or no data</div><div class="tt-foot">${where}</div>`; return; }

    const dn = meanOf(cells.map((k) => fN[k])), dl = meanOf(cells.map((k) => fL[k]));
    const nCleared = cells.filter((k) => { const c = clr[k]; return c !== 0 && c !== 255 && c + 2000 <= state.year; }).length;
    const pct = Math.round((100 * nCleared) / cells.length);
    const arrow = (v) => (Number.isNaN(v) || v === 0 ? '' : v > 0 ? ' ▲' : ' ▼');
    node.innerHTML = `
      <div class="tt-head">${pct}% of this area cleared since 2004</div>
      <div class="tt-row"><span>Greenness</span><b class="tt-num">${Number.isNaN(dn) ? '—' : minus(fmtSigned2(dn)) + arrow(dn)}</b></div>
      <div class="tt-row"><span>Temperature</span><b class="tt-num" style="color:${dl > 0 ? 'var(--c-cleared)' : 'var(--ink)'}">${Number.isNaN(dl) ? '—' : minus(fmtSigned(dl)) + ' °C' + arrow(dl)}</b></div>
      <div class="tt-foot">Change from 2001–03 to ${windowLabel(state.year)} · ${where}</div>`;
  }

  function placeTooltip(ev) {
    const node = tooltip.node(), r = node.getBoundingClientRect();
    let x = ev.clientX + 18, y = ev.clientY + 18;
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - 18;
    if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - 18;
    node.style.left = `${Math.max(4, x)}px`; node.style.top = `${Math.max(4, y)}px`;
  }

  // ---------------------------------------------------------------- 4. readout, legend, controls
  function areaName() {
    return REGIONS[state.preset].name;
  }
  function drawReadout() {
    const s = selSeries[YEARS.indexOf(state.year)], win = windowLabel(state.year);
    d3.select('#readout-area').text(areaName());
    const num = d3.select('#readout-num'), text = d3.select('#readout-text');
    if (state.preset === 'control') {
      num.classed('na', false).text(`${minus(fmtSigned(s.all))} °C`);
      text.html(`warming of never-cleared forest by ${win}: the background trend (climate, drought) that cleared land also gets.`);
    } else if (Number.isNaN(s.effect)) {
      num.classed('na', true).text(state.year < 2005 ? 'Too early to tell' : 'Not enough cleared land');
      text.html(state.year < 2005
        ? `In ${win} almost nothing had been cleared yet relative to the 2001–03 baseline. Press ▶ or drag the year slider forward.`
        : `Only <b>${s.nC}</b> squares here count as cleared by ${win} (we need ${MIN_CLEARED}). Try Rondônia or Pará.`);
    } else {
      num.classed('na', false).text(`${minus(fmtSigned(s.effect))} °C`);
      text.html(`extra warming from clearing, ${win}. Cleared land warmed <b style="color:#ff9b8c">${minus(fmtSigned(s.cleared))} °C</b> since 2001–03; nearby stable forest warmed <b style="color:#7fd3c6">${minus(fmtSigned(s.stable))} °C</b>.`);
    }
  }


  const TITLES = {
    ndvi: ['Change in dry-season greenness (NDVI)', (w) => `${w} average minus 2001–03 baseline, July–September, MODIS Terra. Brown = less green.`],
    lst: ['Change in dry-season daytime land surface temperature', (w) => `${w} average minus 2001–03 baseline, °C, July–September, ~10:30 am overpass, MODIS Terra. Red = hotter.`],
  };
  function drawTitles() {
    const [t, sub] = TITLES[state.layer];
    d3.select('#map-title').text(t);
    d3.select('#map-sub').text(sub(windowLabel(state.year)));
    d3.select('#year-range-label').text(windowLabel(state.year));
  }

  function drawLegend() {
    const el = d3.select('#map-legend'); el.selectAll('*').remove();
    const w = 240, h = 40, svg = el.append('svg').attr('width', w).attr('height', h);
    const id = `lg-${state.layer}`;
    const isN = state.layer === 'ndvi', dom = isN ? NDVI_DOM : LST_DOM, colorFn = isN ? colorNDVI : colorLST;
    const grad = svg.append('defs').append('linearGradient').attr('id', id);
    d3.range(0, 1.0001, 0.1).forEach((t) => grad.append('stop').attr('offset', t).attr('stop-color', colorFn(-dom + 2 * dom * t)));
    const lw = 170, x = d3.scaleLinear().domain([-dom, dom]).range([0, lw]);
    svg.append('rect').attr('x', 0).attr('y', 4).attr('width', lw).attr('height', 12).attr('rx', 2).attr('fill', `url(#${id})`);
    const ticks = isN ? [-0.3, 0, 0.3] : [-5, 0, 5];
    const words = isN ? ['less green', 'greener'] : ['cooler', 'hotter'];
    ticks.forEach((t, n) => {
      const num = (t > 0 ? '+' : t < 0 ? '−' : '') + Math.abs(t);
      svg.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', 16).attr('y2', 20).attr('stroke', '#9aa097');
      if (n === 1) return;
      svg.append('text').attr('x', x(t)).attr('y', 31).attr('text-anchor', n === 0 ? 'start' : 'end')
        .text(n === 0 ? `${num} ${words[0]}` : `${words[1]} ${num}`);
    });
    svg.append('text').attr('x', lw + 8).attr('y', 14).text(isN ? 'NDVI' : '°C');
  }

  // --- year slider
  const slider = document.getElementById('year-slider');
  slider.addEventListener('input', () => { stopPlay(); setYear(+slider.value); });

  // --- state setters
  function setLayer(layer) {
    state.layer = layer;
    d3.selectAll('#layer-seg button').attr('aria-checked', function () { return this.dataset.layer === layer; });
    drawMap(); drawTitles(); drawLegend();
  }
  function setYear(y) {
    state.year = y;
    computeFrame();
    slider.value = y;
    drawMap(); drawTitles(); drawReadout();
  }
  function setPreset(key) {
    state.preset = key;
    state.box = REGIONS[key].box ? cellBox(REGIONS[key].box) : null;
    d3.selectAll('#preset-chips button').attr('aria-pressed', function () { return this.dataset.preset === key; });
    computeSelection();
    selSeries = seriesFor(selCells);
    drawRegions(); drawReadout(); zoomTo(state.box);
  }

  d3.selectAll('#layer-seg button').on('click', function () { setLayer(this.dataset.layer); });
  d3.selectAll('#preset-chips button').on('click', function () { setPreset(this.dataset.preset); });

  let playTimer = null;
  const playBtn = d3.select('#play-btn');
  function stopPlay() { if (playTimer) { playTimer.stop(); playTimer = null; } playBtn.text('▶').attr('aria-label', 'Play through the years'); }
  function play(delay = 420) {
    stopPlay();
    let y = state.year >= 2022 ? 2003 : state.year;
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
  setPreset('all');
  setYear(2022);

  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hideTooltip(); });
})().catch((err) => {
  console.error(err);
  const el = document.getElementById('map-hint');
  if (el) el.textContent = `Could not load data: ${err.message}`;
});
