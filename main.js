import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

// ---------- settings ----------
const BASE_YEARS = [2001, 2002, 2003];   // "before"
const WINDOW = 3;                         // years averaged for "after"
const FOREST_NDVI = 0.7;                  // baseline NDVI that counts as dense forest
const CLEARED_DROP = 0.2;                 // NDVI loss by 2020-22 that counts as cleared
const INTACT_BAND = 0.05;                 // |NDVI change| below this counts as intact
const MIN_CELLS = 20;                     // smallest group we are willing to average

const NDVI_RANGE = 0.4;                   // map colour scale: +/- NDVI
const LST_RANGE = 6;                      // map colour scale: +/- deg C

const X_DOMAIN = [-0.6, 0.2], X_STEP = 0.02;   // scatter: NDVI change
const Y_DOMAIN = [-4, 10], Y_STEP = 0.25;      // scatter: LST change (deg C)
const MEDIAN_STEP = 0.05;

const PRESETS = [
  { name: "Whole map", bbox: null },
  { name: "Rondônia", bbox: [-64, -12, -60, -8] },
  { name: "Pará (BR-163)", bbox: [-57, -9, -53, -5] },
  { name: "Northern Mato Grosso", bbox: [-58, -13, -52, -9.5] },
  { name: "Intact interior", bbox: [-68, -6, -64, -2] },
];

const PLACES = [
  { name: "Brazil", lon: -50.2, lat: -1.2, country: true },
  { name: "Peru", lon: -73.6, lat: -9.6, country: true },
  { name: "Bolivia", lon: -64.6, lat: -16.2, country: true },
  { name: "Colombia", lon: -72.6, lat: 1.2, country: true },
  { name: "Amazonas", lon: -64.5, lat: -4.4 },
  { name: "Pará", lon: -52.5, lat: -4.2 },
  { name: "Rondônia", lon: -63.2, lat: -10.9 },
  { name: "Mato Grosso", lon: -55.6, lat: -13.6 },
  { name: "Acre", lon: -70.4, lat: -9.2 },
];

const NODATA_RGB = [195, 194, 183];
const FADE_RGB = [244, 243, 239];
const MUTED_RGB = [233, 232, 226];

const fmtSigned = (v, digits = 1) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(digits);
const fmtInt = d3.format(",");

// ---------- state ----------
const state = {
  measure: "ndvi",
  year: 2022,
  sel: null,          // {c0, r0, c1, r1} in grid cells (exclusive end), or null for the whole map
  selName: "the whole map",
  ndviBrush: null,    // [lo, hi] NDVI-change range picked on the scatter
  hover: null,        // cell index under the pointer
  playing: null,
};

let meta, W, H, N, T, years;
let ndvi, lst;                    // Float32Array [T * N], NaN = no data
let baseN, baseT;                 // 2001-03 means
let dN, dT;                       // change to the current window
let forest, group;                // Uint8Array per cell; group: 1 cleared, 2 intact, 0 neither
let finalDN;

// ---------- loading ----------
async function loadGrid(spec) {
  const res = await fetch(`data/${spec.file}`);
  if (!res.ok) throw new Error(`${spec.file}: ${res.status}`);
  let buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 0x1f && head[1] === 0x8b) {       // still gzipped: inflate in the browser
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    buf = await new Response(stream).arrayBuffer();
  }
  const raw = spec.dtype === "uint16" ? new Uint16Array(buf) : new Uint8Array(buf);
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw[i] === spec.nodata ? NaN : raw[i] / spec.scale - spec.offset;
  }
  return out;
}

function meanOfYears(stack, yearList) {
  const out = new Float32Array(N), cnt = new Uint8Array(N);
  for (const y of yearList) {
    const off = years.indexOf(y) * N;
    for (let i = 0; i < N; i++) {
      const v = stack[off + i];
      if (v === v) { out[i] += v; cnt[i]++; }
    }
  }
  for (let i = 0; i < N; i++) out[i] = cnt[i] ? out[i] / cnt[i] : NaN;
  return out;
}

const windowYears = (y) => d3.range(y - WINDOW + 1, y + 1);
const windowLabel = (y) => `${y - WINDOW + 1}–${String(y).slice(2)}`;

function computeWindow() {
  const yl = windowYears(state.year);
  const n = meanOfYears(ndvi, yl), t = meanOfYears(lst, yl);
  dN = n; dT = t;
  for (let i = 0; i < N; i++) { dN[i] -= baseN[i]; dT[i] -= baseT[i]; }
}

// ---------- map ----------
const canvas = document.getElementById("map-canvas");
const ctx = canvas.getContext("2d");
let image;
const mapSvg = d3.select("#map-svg");
let mapBrush, mapBrushG, hoverRect;

const lut = { ndvi: buildLut(d3.interpolateBrBG), lst: buildLut((t) => d3.interpolateRdBu(1 - t)) };

function buildLut(interp) {
  const full = new Uint8Array(256 * 3), faded = new Uint8Array(256 * 3);
  for (let k = 0; k < 256; k++) {
    const c = d3.rgb(interp(k / 255));
    [c.r, c.g, c.b].forEach((v, j) => {
      full[k * 3 + j] = v;
      faded[k * 3 + j] = Math.round(v * 0.32 + FADE_RGB[j] * 0.68);
    });
  }
  return { full, faded };
}

function drawMap() {
  const values = state.measure === "ndvi" ? dN : dT;
  const range = state.measure === "ndvi" ? NDVI_RANGE : LST_RANGE;
  const { full, faded } = lut[state.measure];
  const px = image.data;
  const b = state.ndviBrush;
  for (let i = 0; i < N; i++) {
    const v = values[i];
    let r, g, bl;
    if (v !== v) {
      [r, g, bl] = NODATA_RGB;
    } else if (b && !(forest[i] && dN[i] >= b[0] && dN[i] < b[1] && dT[i] === dT[i])) {
      [r, g, bl] = MUTED_RGB;
    } else {
      let k = Math.round(((v + range) / (2 * range)) * 255);
      k = k < 0 ? 0 : k > 255 ? 255 : k;
      const table = forest[i] ? full : faded;
      r = table[k * 3]; g = table[k * 3 + 1]; bl = table[k * 3 + 2];
    }
    const o = i * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = bl; px[o + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

function lonToX(lon) { return (lon - meta.bbox[0]) / meta.deg; }
function latToY(lat) { return (meta.bbox[3] - lat) / meta.deg; }

function initMap(borders) {
  const path = d3.geoPath(d3.geoTransform({
    point(lon, lat) { this.stream.point(lonToX(lon), latToY(lat)); },
  }));
  mapSvg.append("g").selectAll("path")
    .data(borders.features.filter((f) => f.properties.kind === "state"))
    .join("path").attr("class", "border-state").attr("d", path);
  mapSvg.append("g").selectAll("path")
    .data(borders.features.filter((f) => f.properties.kind === "country"))
    .join("path").attr("class", "border-country").attr("d", path);
  mapSvg.append("g").selectAll("text").data(PLACES).join("text")
    .attr("class", (d) => "place" + (d.country ? " country" : ""))
    .attr("x", (d) => lonToX(d.lon)).attr("y", (d) => latToY(d.lat))
    .text((d) => d.name);

  mapBrush = d3.brush().extent([[0, 0], [W, H]]).on("brush end", onMapBrush);
  mapBrushG = mapSvg.append("g").attr("class", "map-brush").call(mapBrush);
  hoverRect = mapSvg.append("rect").attr("class", "hover-cell")
    .attr("width", 5).attr("height", 5).attr("display", "none");

  mapSvg.on("pointermove", onMapHover).on("pointerleave", () => setHover(null));
}

function onMapBrush(event) {
  if (!event.selection) {
    state.sel = null;
  } else {
    const [[x0, y0], [x1, y1]] = event.selection;
    const c0 = Math.max(0, Math.floor(x0)), r0 = Math.max(0, Math.floor(y0));
    const c1 = Math.min(W, Math.ceil(x1)), r1 = Math.min(H, Math.ceil(y1));
    state.sel = c1 > c0 && r1 > r0 ? { c0, r0, c1, r1 } : null;
  }
  if (event.sourceEvent) {            // a brush dragged by hand has no preset name
    state.selName = state.sel ? "the selected area" : "the whole map";
    markPreset(state.sel ? null : "Whole map");
  }
  scheduleCharts();
}

function applyPreset(p) {
  state.selName = p.bbox ? p.name : "the whole map";
  markPreset(p.name);
  if (!p.bbox) { mapBrushG.call(mapBrush.move, null); return; }
  const [w, s, e, n] = p.bbox;
  mapBrushG.call(mapBrush.move, [[lonToX(w), latToY(n)], [lonToX(e), latToY(s)]]);
}

function markPreset(name) {
  d3.selectAll("#presets button").classed("active", (d) => d.name === name);
}

const tooltip = d3.select("#tooltip");

function onMapHover(event) {
  const [x, y] = d3.pointer(event, mapSvg.node());
  const c = Math.floor(x), r = Math.floor(y);
  if (c < 0 || r < 0 || c >= W || r >= H) { setHover(null); return; }
  setHover(r * W + c, event);
}

function setHover(i, event) {
  state.hover = i;
  if (i == null) {
    tooltip.attr("hidden", true);
    hoverRect.attr("display", "none");
    hoverDot.attr("display", "none");
    return;
  }
  const c = i % W, r = Math.floor(i / W);
  hoverRect.attr("display", null).attr("x", c - 2).attr("y", r - 2);
  const lat = meta.bbox[3] - (r + 0.5) * meta.deg, lon = meta.bbox[0] + (c + 0.5) * meta.deg;
  const where = `${Math.abs(lat).toFixed(2)}°${lat < 0 ? "S" : "N"}, ${Math.abs(lon).toFixed(2)}°W`;
  const win = windowLabel(state.year);
  const row = (label, base, delta, digits, unit) => {
    if (!(base === base) || !(delta === delta)) return `<tr><td>${label}</td><td class="dim" colspan="2">no data</td></tr>`;
    return `<tr><td>${label}</td><td>${base.toFixed(digits)} → ${(base + delta).toFixed(digits)}${unit}</td>` +
           `<td><b>${fmtSigned(delta, digits)}</b></td></tr>`;
  };
  let status = "";
  if (baseN[i] === baseN[i]) {
    status = !forest[i] ? "Not dense forest in 2001–03"
      : group[i] === 1 ? "Forest in 2001–03, cleared by 2020–22"
      : group[i] === 2 ? "Forest that stayed intact"
      : "Forest in 2001–03, partly changed";
  }
  tooltip.html(
    `<b>${where}</b><div class="dim">2001–03 → ${win}</div><table>` +
    row("Greenness (NDVI)", baseN[i], dN[i], 2, "") +
    row("Surface temp.", baseT[i], dT[i], 1, " °C") +
    `</table><div class="dim">${status}</div>`
  ).attr("hidden", null);
  if (event) placeTooltip(event);
  updateHoverDot();
}

function placeTooltip(event) {
  const node = tooltip.node();
  const w = node.offsetWidth, h = node.offsetHeight;
  let x = event.clientX + 14, y = event.clientY + 14;
  if (x + w > window.innerWidth - 8) x = event.clientX - w - 14;
  if (y + h > window.innerHeight - 8) y = event.clientY - h - 14;
  tooltip.style("left", `${Math.max(4, x)}px`).style("top", `${Math.max(4, y)}px`);
}

function drawLegend() {
  const svg = d3.select("#map-legend");
  svg.selectAll("*").remove();
  const isN = state.measure === "ndvi";
  const range = isN ? NDVI_RANGE : LST_RANGE;
  const x = d3.scaleLinear([-range, range], [14, 316]);
  const table = lut[state.measure].full;
  const steps = 151, w = (316 - 14) / steps;
  svg.append("g").selectAll("rect").data(d3.range(steps)).join("rect")
    .attr("x", (k) => 14 + k * w).attr("y", 14).attr("width", w + 0.5).attr("height", 10)
    .attr("fill", (k) => {
      const j = Math.round((k / (steps - 1)) * 255) * 3;
      return `rgb(${table[j]},${table[j + 1]},${table[j + 2]})`;
    });
  svg.append("g").attr("class", "axis").attr("transform", "translate(0,24)")
    .call(d3.axisBottom(x).ticks(5).tickSize(4)
      .tickFormat((v) => (v === 0 ? "0" : fmtSigned(v, isN ? 1 : 0)) + (isN ? "" : "°")))
    .call((g) => g.select(".domain").remove());
  svg.append("text").attr("class", "anno").attr("x", 14).attr("y", 9)
    .text(isN ? "◀ less green" : "◀ cooler");
  svg.append("text").attr("class", "anno").attr("x", 316).attr("y", 9).attr("text-anchor", "end")
    .text(isN ? "greener ▶" : "hotter ▶");
  svg.append("text").attr("class", "anno").attr("x", 165).attr("y", 9).attr("text-anchor", "middle")
    .text(isN ? "NDVI change" : "°C change");
}

// ---------- scatter (2D histogram) ----------
const SC = { w: 470, h: 330, m: { t: 12, r: 14, b: 40, l: 46 } };
const NX = Math.round((X_DOMAIN[1] - X_DOMAIN[0]) / X_STEP);
const NY = Math.round((Y_DOMAIN[1] - Y_DOMAIN[0]) / Y_STEP);
const sx = d3.scaleLinear(X_DOMAIN, [SC.m.l, SC.w - SC.m.r]);
const sy = d3.scaleLinear(Y_DOMAIN, [SC.h - SC.m.b, SC.m.t]);
const scatter = d3.select("#scatter");
let binG, medianPath, medianDots, hoverDot, xBrush, xBrushG, countLegend;

function initScatter() {
  scatter.append("g").attr("class", "grid").attr("transform", `translate(${SC.m.l},0)`)
    .call(d3.axisLeft(sy).ticks(7).tickSize(-(SC.w - SC.m.l - SC.m.r)).tickFormat(""));
  binG = scatter.append("g");
  scatter.append("line").attr("class", "ref-line")
    .attr("x1", SC.m.l).attr("x2", SC.w - SC.m.r).attr("y1", sy(0)).attr("y2", sy(0));
  scatter.append("line").attr("class", "ref-line")
    .attr("x1", sx(0)).attr("x2", sx(0)).attr("y1", SC.m.t).attr("y2", SC.h - SC.m.b);
  scatter.append("line").attr("class", "ref-dash")
    .attr("x1", sx(-CLEARED_DROP)).attr("x2", sx(-CLEARED_DROP)).attr("y1", SC.m.t).attr("y2", SC.h - SC.m.b);
  scatter.append("text").attr("class", "anno").attr("text-anchor", "end")
    .attr("x", sx(-CLEARED_DROP) - 5).attr("y", SC.h - SC.m.b - 6).text("◀ cleared");
  scatter.append("text").attr("class", "anno")
    .attr("x", sx(0) + 5).attr("y", SC.h - SC.m.b - 6).text("no change");

  scatter.append("g").attr("class", "axis").attr("transform", `translate(0,${SC.h - SC.m.b})`)
    .call(d3.axisBottom(sx).ticks(8).tickFormat((v) => (v === 0 ? "0" : fmtSigned(v, 1))));
  scatter.append("g").attr("class", "axis").attr("transform", `translate(${SC.m.l},0)`)
    .call(d3.axisLeft(sy).ticks(7).tickFormat((v) => (v === 0 ? "0" : fmtSigned(v, 0)) + "°"));
  scatter.append("text").attr("class", "axis-label").attr("text-anchor", "middle")
    .attr("x", (SC.m.l + SC.w - SC.m.r) / 2).attr("y", SC.h - 6)
    .text("Change in greenness (NDVI)");
  scatter.append("text").attr("class", "axis-label").attr("text-anchor", "middle")
    .attr("transform", `translate(12,${(SC.m.t + SC.h - SC.m.b) / 2}) rotate(-90)`)
    .text("Change in surface temperature (°C)");

  xBrush = d3.brushX()
    .extent([[SC.m.l, SC.m.t], [SC.w - SC.m.r, SC.h - SC.m.b]])
    .on("brush end", onScatterBrush);
  xBrushG = scatter.append("g").attr("class", "x-brush").call(xBrush);

  medianPath = scatter.append("path").attr("class", "median-line").attr("pointer-events", "none");
  medianDots = scatter.append("g").attr("pointer-events", "none");
  hoverDot = scatter.append("circle").attr("class", "hover-dot").attr("r", 5).attr("display", "none");

  countLegend = scatter.append("g").attr("transform", `translate(${SC.w - SC.m.r - 118},${SC.m.t + 4})`)
    .attr("pointer-events", "none");
}

function onScatterBrush(event) {
  if (!event.selection) {
    state.ndviBrush = null;
  } else {
    // snap to bin edges so the selection is an exact set of columns
    const snap = (px) => Math.round((sx.invert(px) - X_DOMAIN[0]) / X_STEP) * X_STEP + X_DOMAIN[0];
    let lo = snap(event.selection[0]), hi = snap(event.selection[1]);
    if (hi - lo < X_STEP / 2) hi = lo + X_STEP;
    state.ndviBrush = [lo - 1e-6, hi - 1e-6];
    if (event.type === "end" && event.sourceEvent) {
      xBrushG.call(xBrush.move, [sx(lo), sx(hi)]);
      return;
    }
  }
  scheduleMap();
  scheduleCharts();
}

function updateHoverDot() {
  const i = state.hover;
  if (i == null || !forest[i] || !(dN[i] === dN[i]) || !(dT[i] === dT[i])) {
    hoverDot.attr("display", "none");
    return;
  }
  const clamp = (v, [a, b]) => Math.max(a, Math.min(b, v));
  hoverDot.attr("display", null)
    .attr("cx", sx(clamp(dN[i], X_DOMAIN))).attr("cy", sy(clamp(dT[i], Y_DOMAIN)));
}

// ---------- line chart ----------
const LN = { w: 470, h: 250, m: { t: 16, r: 16, b: 28, l: 46 } };
const lx = d3.scaleLinear([2000.5, 2022.5], [LN.m.l, LN.w - LN.m.r]);
const ly = d3.scaleLinear().range([LN.h - LN.m.b, LN.m.t]);
const lines = d3.select("#lines");
let lineYAxis, lineGrid, bandWindow, gapArea, seriesG, lineZero, lineEmpty, bandLabel;

function initLines() {
  lineGrid = lines.append("g").attr("class", "grid").attr("transform", `translate(${LN.m.l},0)`);
  lines.append("rect").attr("class", "band-base")
    .attr("x", lx(2000.5)).attr("width", lx(2003.5) - lx(2000.5))
    .attr("y", LN.m.t).attr("height", LN.h - LN.m.b - LN.m.t);
  lines.append("text").attr("class", "anno").attr("x", lx(2000.5) + 4).attr("y", LN.m.t + 11).text("baseline");
  bandWindow = lines.append("rect").attr("class", "band-window")
    .attr("y", LN.m.t).attr("height", LN.h - LN.m.b - LN.m.t);
  bandLabel = lines.append("text").attr("class", "anno").attr("y", LN.m.t + 11).attr("text-anchor", "middle");
  lineZero = lines.append("line").attr("class", "ref-line").attr("x1", LN.m.l).attr("x2", LN.w - LN.m.r);
  gapArea = lines.append("path").attr("class", "gap-area");
  seriesG = lines.append("g");
  lineEmpty = lines.append("text").attr("class", "empty-msg")
    .attr("x", (LN.m.l + LN.w - LN.m.r) / 2).attr("y", LN.h / 2);
  lines.append("g").attr("class", "axis").attr("transform", `translate(0,${LN.h - LN.m.b})`)
    .call(d3.axisBottom(lx).tickValues([2001, 2004, 2007, 2010, 2013, 2016, 2019, 2022]).tickFormat(d3.format("d")));
  lineYAxis = lines.append("g").attr("class", "axis").attr("transform", `translate(${LN.m.l},0)`);
  lines.append("text").attr("class", "axis-label").attr("text-anchor", "middle")
    .attr("transform", `translate(12,${(LN.m.t + LN.h - LN.m.b) / 2}) rotate(-90)`)
    .text("°C vs. 2001–03");

  const pick = (event) => {
    const [x] = d3.pointer(event, lines.node());
    setYear(Math.round(lx.invert(x)));
  };
  lines.append("rect").attr("fill", "transparent").style("cursor", "ew-resize")
    .attr("x", LN.m.l).attr("y", LN.m.t)
    .attr("width", LN.w - LN.m.l - LN.m.r).attr("height", LN.h - LN.m.t - LN.m.b)
    .on("pointerdown", (event) => { stopPlay(); event.currentTarget.setPointerCapture(event.pointerId); pick(event); })
    .on("pointermove", (event) => { if (event.buttons & 1) pick(event); });
}

// ---------- chart updates ----------
function updateCharts() {
  const s = state.sel || { c0: 0, r0: 0, c1: W, r1: H };
  const win = windowLabel(state.year);
  const b = state.ndviBrush;

  // one pass over the selected cells
  const bins = new Uint32Array(NX * NY);
  const NM = Math.round((X_DOMAIN[1] - X_DOMAIN[0]) / MEDIAN_STEP);
  const medBuckets = Array.from({ length: NM }, () => []);
  const sum = [null, new Float64Array(T), new Float64Array(T)];
  const cnt = [null, new Uint32Array(T), new Uint32Array(T)];
  const groupN = [0, 0, 0];
  let total = 0, outside = 0, brushed = 0, brushedT = 0;

  for (let r = s.r0; r < s.r1; r++) {
    for (let c = s.c0; c < s.c1; c++) {
      const i = r * W + c;
      if (!forest[i]) continue;
      const g = group[i];
      if (g) {
        groupN[g]++;
        const bt = baseT[i];
        if (bt === bt) {
          for (let t = 0; t < T; t++) {
            const v = lst[t * N + i];
            if (v === v) { sum[g][t] += v - bt; cnt[g][t]++; }
          }
        }
      }
      const x = dN[i], y = dT[i];
      if (!(x === x) || !(y === y)) continue;
      total++;
      if (b && x >= b[0] && x < b[1]) { brushed++; brushedT += y; }
      const bx = Math.floor((x - X_DOMAIN[0]) / X_STEP), by = Math.floor((y - Y_DOMAIN[0]) / Y_STEP);
      if (bx < 0 || bx >= NX || by < 0 || by >= NY) { outside++; continue; }
      bins[by * NX + bx]++;
      medBuckets[Math.min(NM - 1, Math.floor((x - X_DOMAIN[0]) / MEDIAN_STEP))].push(y);
    }
  }

  // --- scatter ---
  const cells = [];
  let maxCount = 1;
  for (let k = 0; k < bins.length; k++) {
    if (bins[k]) { cells.push({ k, n: bins[k] }); if (bins[k] > maxCount) maxCount = bins[k]; }
  }
  const color = d3.scaleSequentialLog([1, Math.max(10, maxCount)], (t) => d3.interpolateBlues(0.18 + 0.82 * t));
  const bw = sx(X_DOMAIN[0] + X_STEP) - sx(X_DOMAIN[0]), bh = sy(Y_DOMAIN[0]) - sy(Y_DOMAIN[0] + Y_STEP);
  binG.selectAll("rect").data(cells, (d) => d.k).join("rect")
    .attr("x", (d) => sx(X_DOMAIN[0] + (d.k % NX) * X_STEP))
    .attr("y", (d) => sy(Y_DOMAIN[0] + (Math.floor(d.k / NX) + 1) * Y_STEP))
    .attr("width", bw + 0.4).attr("height", bh + 0.4)
    .attr("fill", (d) => color(d.n))
    .attr("opacity", (d) => {
      if (!b) return 1;
      const x0 = X_DOMAIN[0] + (d.k % NX) * X_STEP + X_STEP / 2;
      return x0 >= b[0] && x0 < b[1] ? 1 : 0.3;
    });

  const med = medBuckets
    .map((arr, j) => ({ x: X_DOMAIN[0] + (j + 0.5) * MEDIAN_STEP, y: arr.length >= MIN_CELLS ? d3.median(arr) : NaN }))
    .filter((d) => d.y === d.y);
  medianPath.attr("d", d3.line().x((d) => sx(d.x)).y((d) => sy(d.y))(med));
  medianDots.selectAll("circle").data(med).join("circle")
    .attr("class", "median-dot").attr("r", 3).attr("cx", (d) => sx(d.x)).attr("cy", (d) => sy(d.y));

  countLegend.selectAll("*").remove();
  if (total) {
    const stops = [1, Math.sqrt(Math.max(10, maxCount)), Math.max(10, maxCount)];
    countLegend.append("rect").attr("x", -6).attr("y", -4).attr("width", 124).attr("height", 44)
      .attr("fill", "rgba(255,255,255,0.86)");
    countLegend.append("text").attr("class", "anno").attr("y", 7).text("cells per rectangle");
    stops.forEach((v, j) => {
      countLegend.append("rect").attr("x", j * 38).attr("y", 13).attr("width", 12).attr("height", 10).attr("fill", color(v));
      countLegend.append("text").attr("class", "anno").attr("x", j * 38 + 15).attr("y", 22)
        .text(d3.format(v >= 1000 ? ".1s" : "d")(Math.round(v)));
    });
    countLegend.append("line").attr("x1", 0).attr("x2", 14).attr("y1", 33).attr("y2", 33).attr("stroke", "#111").attr("stroke-width", 2);
    countLegend.append("text").attr("class", "anno").attr("x", 18).attr("y", 36).text("median");
  }

  d3.select("#scatter-sub").text(
    `Each rectangle counts 5 km cells in ${state.selName} by how much their greenness and temperature ` +
    `changed from 2001–03 to ${win}. Only cells that were dense forest in 2001–03 (${fmtInt(total)} here).`);

  let note = b
    ? (brushed
        ? `Selected NDVI change ${fmtSigned(b[0] + 1e-6, 2)} to ${fmtSigned(b[1] + 1e-6, 2)}: ${fmtInt(brushed)} cells, ` +
          `average temperature change ${fmtSigned(brushedT / brushed)} °C. Click the plot to clear.`
        : "No cells in that range here. Click the plot to clear.")
    : "Drag sideways on this plot to show only those cells on the map.";
  if (outside) note += ` ${fmtInt(outside)} cells fall outside the axes.`;
  d3.select("#scatter-note").text(note);

  // --- lines ---
  const series = [
    { g: 1, name: "Cleared by 2020–22", color: "var(--cleared)" },
    { g: 2, name: "Stayed forest", color: "var(--intact)" },
  ].map((d) => ({
    ...d, n: groupN[d.g],
    pts: groupN[d.g] >= MIN_CELLS
      ? years.map((y, t) => ({ year: y, v: cnt[d.g][t] >= MIN_CELLS ? sum[d.g][t] / cnt[d.g][t] : NaN })).filter((p) => p.v === p.v)
      : [],
  }));
  const all = series.flatMap((d) => d.pts.map((p) => p.v));
  const ext = all.length ? d3.extent(all) : [0, 1];
  ly.domain([Math.min(-1, ext[0] - 0.3), Math.max(3, ext[1] + 0.5)]).nice();
  lineYAxis.call(d3.axisLeft(ly).ticks(6).tickFormat((v) => (v === 0 ? "0" : fmtSigned(v, Number.isInteger(v) ? 0 : 1)) + "°"));
  lineGrid.call(d3.axisLeft(ly).ticks(6).tickSize(-(LN.w - LN.m.l - LN.m.r)).tickFormat(""));
  lineZero.attr("y1", ly(0)).attr("y2", ly(0));
  bandWindow.attr("x", lx(state.year - WINDOW + 0.5)).attr("width", lx(state.year + 0.5) - lx(state.year - WINDOW + 0.5));
  bandLabel.attr("x", Math.min(LN.w - LN.m.r - 22, lx(state.year - 1))).text(win);

  const line = d3.line().x((p) => lx(p.year)).y((p) => ly(p.v));
  seriesG.selectAll("g.s").data(series, (d) => d.g).join((enter) => {
    const g = enter.append("g").attr("class", "s");
    g.append("path").attr("class", "series");
    g.append("text").attr("class", "series-label");
    return g;
  }).each(function (d) {
    const g = d3.select(this);
    g.select("path").attr("stroke", d.color).attr("d", d.pts.length ? line(d.pts) : null);
    // keep the label clear of its own line: above the cleared line's peak, below the intact line's dip
    const near = d.pts.filter((p) => p.year >= 2006 && p.year <= 2016).map((p) => p.v);
    const yLabel = !near.length ? 0 : d.g === 1 ? ly(d3.max(near)) - 9 : ly(d3.min(near)) + 17;
    g.select("text").attr("fill", d.color).attr("display", near.length ? null : "none")
      .attr("text-anchor", "middle")
      .attr("x", lx(2011)).attr("y", Math.max(LN.m.t + 10, Math.min(LN.h - LN.m.b - 4, yLabel)))
      .text(`${d.name} (${fmtInt(d.n)} cells)`);
  });

  const [cl, it] = series;
  if (cl.pts.length && it.pts.length) {
    const byYear = new Map(it.pts.map((p) => [p.year, p.v]));
    const both = cl.pts.filter((p) => byYear.has(p.year));
    gapArea.attr("d", d3.area().x((p) => lx(p.year)).y0((p) => ly(byYear.get(p.year))).y1((p) => ly(p.v))(both));
  } else {
    gapArea.attr("d", null);
  }
  lineEmpty.text(!cl.pts.length && !it.pts.length ? "Not enough forest cells in this area" : "");

  d3.select("#line-sub").text(
    `Dry-season surface temperature each year, minus the same cells' 2001–03 average, in ${state.selName}. ` +
    `Cleared = lost 0.2 or more NDVI by 2020–22. Stayed forest = changed by less than 0.05.`);

  // --- readout ---
  const windowMean = (d) => {
    const pts = d.pts.filter((p) => p.year > state.year - WINDOW && p.year <= state.year);
    return pts.length ? d3.mean(pts, (p) => p.v) : NaN;
  };
  const a = windowMean(cl), c = windowMean(it);
  const where = state.selName.charAt(0).toUpperCase() + state.selName.slice(1);
  let html;
  if (a === a && c === c) {
    html = `<b>${where}, ${win}:</b> forest that was <span class="c-cleared">cleared</span> is ` +
      `<strong>${fmtSigned(a)} °C</strong> against its 2001–03 temperature. Forest that ` +
      `<span class="c-intact">stayed</span> is <strong>${fmtSigned(c)} °C</strong>. ` +
      `The difference, ${fmtSigned(a - c)} °C, is the part that follows the clearing.`;
  } else if (c === c) {
    html = `<b>${where}, ${win}:</b> fewer than ${MIN_CELLS} cells here were cleared, so there is nothing to compare. ` +
      `Forest that <span class="c-intact">stayed</span> is <strong>${fmtSigned(c)} °C</strong> against its 2001–03 temperature.`;
  } else if (a === a) {
    html = `<b>${where}, ${win}:</b> forest that was <span class="c-cleared">cleared</span> is ` +
      `<strong>${fmtSigned(a)} °C</strong> against its 2001–03 temperature. Too little intact forest here to compare with.`;
  } else {
    html = `<b>${where}:</b> not enough forest cells here to compare. Try a larger area.`;
  }
  d3.select("#readout").html(html);
  if (state.hover != null) setHover(state.hover);   // keep an open tooltip in step with the year
}

function updateMapText() {
  const win = windowLabel(state.year);
  const isN = state.measure === "ndvi";
  d3.select("#map-title").text(isN
    ? "Change in dry-season greenness (NDVI)"
    : "Change in dry-season daytime surface temperature");
  d3.select("#map-sub").text(
    `Average of ${win} minus average of 2001–03, July to September, 5 km cells. ` +
    (isN ? "Brown lost greenness, teal gained it." : "Red got hotter, blue got cooler.") +
    (state.ndviBrush ? " Showing only the cells selected on the scatter plot." : ""));
  d3.select("#year-out").text(win);
}

// ---------- scheduling ----------
let mapDirty = false, chartsDirty = false, frame = null;
function flush() {
  frame = null;
  if (mapDirty) { drawMap(); updateMapText(); mapDirty = false; }
  if (chartsDirty) { updateCharts(); chartsDirty = false; }
}
function scheduleMap() { mapDirty = true; frame ??= requestAnimationFrame(flush); }
function scheduleCharts() { chartsDirty = true; frame ??= requestAnimationFrame(flush); }

function setYear(y) {
  y = Math.max(2006, Math.min(2022, y));
  if (y === state.year) return;
  state.year = y;
  document.getElementById("year").value = y;
  computeWindow();
  scheduleMap();
  scheduleCharts();
}

const playBtn = document.getElementById("play");
function stopPlay() {
  if (state.playing) { clearInterval(state.playing); state.playing = null; }
  playBtn.textContent = "▶ Play";
}
function startPlay() {
  if (state.year >= 2022) setYear(2006);
  playBtn.textContent = "❚❚ Pause";
  state.playing = setInterval(() => {
    if (state.year >= 2022) { stopPlay(); return; }
    setYear(state.year + 1);
  }, 750);
}

function initControls() {
  d3.selectAll(".segmented button").on("click", function () {
    state.measure = this.dataset.measure;
    d3.selectAll(".segmented button")
      .classed("active", function () { return this.dataset.measure === state.measure; })
      .attr("aria-pressed", function () { return this.dataset.measure === state.measure; });
    drawLegend();
    scheduleMap();
  });
  d3.select("#year").on("input", function () { stopPlay(); setYear(+this.value); });
  playBtn.addEventListener("click", () => (state.playing ? stopPlay() : startPlay()));
  d3.select("#presets").selectAll("button").data(PRESETS).join("button")
    .attr("type", "button").text((d) => d.name)
    .classed("active", (d) => !d.bbox)
    .on("click", (event, d) => applyPreset(d));
}

// ---------- start ----------
async function main() {
  meta = await d3.json("data/meta.json");
  W = meta.width; H = meta.height; N = W * H; years = meta.years; T = years.length;
  const [n, t, borders] = await Promise.all([loadGrid(meta.ndvi), loadGrid(meta.lst), d3.json("data/borders.json")]);
  ndvi = n; lst = t;

  baseN = meanOfYears(ndvi, BASE_YEARS);
  baseT = meanOfYears(lst, BASE_YEARS);
  finalDN = meanOfYears(ndvi, windowYears(2022));
  forest = new Uint8Array(N);
  group = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    finalDN[i] -= baseN[i];
    forest[i] = baseN[i] >= FOREST_NDVI ? 1 : 0;
    if (forest[i] && finalDN[i] === finalDN[i]) {
      group[i] = finalDN[i] <= -CLEARED_DROP ? 1 : Math.abs(finalDN[i]) < INTACT_BAND ? 2 : 0;
    }
  }

  image = ctx.createImageData(W, H);
  initControls();
  initMap(borders);
  initScatter();
  initLines();
  computeWindow();
  drawLegend();

  document.getElementById("loading").hidden = true;
  document.getElementById("viz").hidden = false;
  drawMap();
  updateMapText();
  updateCharts();
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById("loading");
  el.classList.add("error");
  el.textContent = "The data could not be loaded. Please reload the page.";
});
