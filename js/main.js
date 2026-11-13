/* When the forest goes, the ground heats up.
 * Data: data/amazon/ (exported by exploration.ipynb, Phase 3.4).
 *   clearing.png  1 km codes: 0 no data, 1 not forest in 2001–03, 2 forest never cleared, 4–22 = year cleared − 2000
 *   lst.png       5 km daytime LST anomaly frames (dry season ×22, then whole year ×22); value = round(°C×10)+128, 0 = no data
 *   meta.json     bounds, years, group series, yearly cleared area, place labels
 */
(async function () {
  const DATA = "data/amazon/";
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmtSigned = d3.format("+.1f");
  const fmtInt = d3.format(",.0f");
  const fmtPct = d3.format(".0%");
  const TEMP_MAX = 6; // °C, symmetric color domain

  // ---------- load ----------
  function loadGray(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
        const out = new Uint8Array(c.width * c.height);
        for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4];
        resolve({ w: c.width, h: c.height, data: out });
      };
      img.onerror = () => reject(new Error("could not load " + src));
      img.src = src;
    });
  }

  let meta, clearing, lstImg;
  try {
    meta = await d3.json(DATA + "meta.json");
    [clearing, lstImg] = await Promise.all([loadGray(DATA + meta.clearing.file), loadGray(DATA + meta.lst.file)]);
  } catch (err) {
    document.querySelector(".maps").insertAdjacentHTML("beforebegin",
      `<p class="loading">Could not load the data (${err.message}). If you opened this file directly, serve the folder instead, e.g. <code>python -m http.server</code>.</p>`);
    throw err;
  }

  // ---------- derived data ----------
  const years = meta.years;
  const NY = years.length;
  const Y0 = years[0];
  const [WEST, SOUTH, EAST, NORTH] = meta.bbox;
  const W = clearing.w, H = clearing.h;
  const codes = clearing.data;
  const K = Math.round(meta.lst.deg / meta.clearing.deg);
  const CW = W / K, CH = H / K, NC = CW * CH;
  const provisional = new Set(meta.clearing.provisional_years);
  const yearOffset = meta.clearing.year_offset;

  // per 5 km cell: valid 1 km pixels, baseline forest pixels, cumulative cleared pixels by year
  const valid = new Uint16Array(NC), f0 = new Uint16Array(NC), clr = new Uint16Array(NC * NY);
  for (let r = 0; r < H; r++) {
    const rowBase = ((r / K) | 0) * CW;
    for (let c = 0; c < W; c++) {
      const v = codes[r * W + c];
      if (!v) continue;
      const ci = rowBase + ((c / K) | 0);
      valid[ci]++;
      if (v >= 2) {
        f0[ci]++;
        if (v >= 4) clr[ci * NY + (v + yearOffset - Y0)]++;
      }
    }
  }
  for (let ci = 0; ci < NC; ci++) {
    let s = 0;
    for (let i = 0; i < NY; i++) { s += clr[ci * NY + i]; clr[ci * NY + i] = s; }
  }
  const forestShare = (ci, yi) => (valid[ci] ? (f0[ci] - clr[ci * NY + yi]) / valid[ci] : NaN);
  const lostShare = (ci, yi) => (valid[ci] ? clr[ci * NY + yi] / valid[ci] : NaN);

  // LST anomaly frames
  const lstRaw = lstImg.data;
  const frameOffset = (season, yi) => ((season === "dry" ? 0 : NY) + yi) * NC;
  const anomaly = (season, yi, ci) => {
    const v = lstRaw[frameOffset(season, yi) + ci];
    return v === 0 ? NaN : (v - meta.lst.offset) * meta.lst.scale;
  };

  // standing-forest control (same definition as the notebook)
  const standing = new Uint8Array(NC);
  for (let ci = 0; ci < NC; ci++) {
    if (valid[ci] && f0[ci] / valid[ci] >= 0.8 && lostShare(ci, NY - 1) < 0.05) standing[ci] = 1;
  }

  // ---------- state ----------
  const state = { yi: NY - 1, season: "dry", playing: false, sel: null };
  let timer = null;

  // ---------- color ----------
  let colors;
  function readColors() {
    colors = {
      forest: d3.rgb(css("--map-forest")), cleared: d3.rgb(css("--map-cleared")), fresh: d3.rgb(css("--map-new")),
      nonforest: d3.rgb(css("--map-nonforest")), nodata: d3.rgb(css("--map-nodata")),
      clearedLine: css("--cleared"), standingLine: css("--standing"), selectionLine: css("--selection"),
    };
  }
  readColors();
  const tempColor = (t) => d3.interpolateRdBu(0.5 - Math.max(-1, Math.min(1, t / TEMP_MAX)) / 2);
  const pack = (c) => (255 << 24) | (c.b << 16) | (c.g << 8) | c.r; // little-endian RGBA as Uint32

  // ---------- maps ----------
  const forestMap = setupMap("#map-forest", W, H);
  const tempMap = setupMap("#map-temp", CW, CH);
  const forestImage = forestMap.ctx.createImageData(W, H);
  const forest32 = new Uint32Array(forestImage.data.buffer);
  const tempImage = tempMap.ctx.createImageData(CW, CH);
  const temp32 = new Uint32Array(tempImage.data.buffer);

  function setupMap(sel, w, h) {
    const root = d3.select(sel);
    const canvas = root.select("canvas").attr("width", w).attr("height", h).node();
    const ctx = canvas.getContext("2d");
    const svg = root.select("svg.overlay");
    const gPlaces = svg.append("g").attr("class", "places");
    const gBrush = svg.append("g").attr("class", "brush");
    const gHover = svg.append("g").attr("class", "hover");
    return { root, canvas, ctx, svg, gPlaces, gBrush, gHover, x: null, y: null, brush: null };
  }

  function drawForest() {
    const year = years[state.yi];
    const lut = new Uint32Array(256);
    lut[0] = pack(colors.nodata);
    lut[1] = pack(colors.nonforest);
    lut[2] = pack(colors.forest);
    for (let code = 4; code < 256; code++) {
      const cy = code + yearOffset;
      lut[code] = pack(cy > year ? colors.forest : cy === year ? colors.fresh : colors.cleared);
    }
    for (let i = 0; i < forest32.length; i++) forest32[i] = lut[codes[i]];
    forestMap.ctx.putImageData(forestImage, 0, 0);
  }

  const tempLut = new Uint32Array(256);
  function buildTempLut() {
    tempLut[0] = pack(colors.nodata);
    for (let v = 1; v < 256; v++) tempLut[v] = pack(d3.rgb(tempColor((v - meta.lst.offset) * meta.lst.scale)));
  }
  buildTempLut();
  function drawTemp() {
    const off = frameOffset(state.season, state.yi);
    for (let i = 0; i < NC; i++) temp32[i] = tempLut[lstRaw[off + i]];
    tempMap.ctx.putImageData(tempImage, 0, 0);
  }

  // overlay geometry, places, brushes
  function layoutMaps() {
    for (const m of [forestMap, tempMap]) {
      const { width, height } = m.root.node().getBoundingClientRect();
      m.x = d3.scaleLinear([WEST, EAST], [0, width]);
      m.y = d3.scaleLinear([NORTH, SOUTH], [0, height]);
      m.svg.attr("viewBox", `0 0 ${width} ${height}`);

      const p = m.gPlaces.selectAll("g.place").data(meta.places, (d) => d.name)
        .join((enter) => {
          const g = enter.append("g").attr("class", "place");
          g.append("circle").attr("r", 3);
          g.append("text").attr("dy", "0.35em");
          return g;
        });
      p.attr("transform", (d) => `translate(${m.x(d.lon)},${m.y(d.lat)})`);
      // labels sit right of the dot unless near the right edge; "above" labels avoid close neighbours
      const above = new Set(["São Félix do Xingu"]);
      p.select("text").text((d) => d.name)
        .attr("x", (d) => (above.has(d.name) ? 0 : m.x(d.lon) > width - 110 ? -6 : 6))
        .attr("y", (d) => (above.has(d.name) ? -10 : 0))
        .attr("text-anchor", (d) => (above.has(d.name) ? (m.x(d.lon) > width - 70 ? "end" : "middle")
          : m.x(d.lon) > width - 110 ? "end" : "start"));

      m.brush = d3.brush().extent([[0, 0], [width, height]])
        .on("end", (event) => onBrush(event, m));
      m.gBrush.call(m.brush);
      m.gBrush.select(".selection").attr("class", "selection");
    }
    syncBrushes(null);
  }

  function selToPx(m) {
    if (!state.sel) return null;
    const s = state.sel;
    return [[m.x(s.west), m.y(s.north)], [m.x(s.east), m.y(s.south)]];
  }

  function syncBrushes(source) {
    for (const m of [forestMap, tempMap]) {
      if (m === source) continue;
      m.gBrush.call(m.brush.move, selToPx(m));
    }
  }

  function onBrush(event, m) {
    if (!event.sourceEvent) return; // programmatic move
    if (!event.selection) {
      state.sel = null;
    } else {
      const [[x0, y0], [x1, y1]] = event.selection;
      if (Math.abs(x1 - x0) < 4 || Math.abs(y1 - y0) < 4) { state.sel = null; }
      else state.sel = { west: m.x.invert(x0), east: m.x.invert(x1), north: m.y.invert(y0), south: m.y.invert(y1) };
    }
    syncBrushes(m);
    if (!state.sel) m.gBrush.call(m.brush.move, null);
    updateCharts();
  }

  // hover: ring on both maps + tooltip
  const tooltip = d3.select("#tooltip");
  function cellAt(lon, lat) {
    const c = Math.floor((lon - WEST) / meta.lst.deg), r = Math.floor((NORTH - lat) / meta.lst.deg);
    if (c < 0 || r < 0 || c >= CW || r >= CH) return -1;
    return r * CW + c;
  }
  function onHover(event, m) {
    const [mx, my] = d3.pointer(event, m.svg.node());
    const lon = m.x.invert(mx), lat = m.y.invert(my);
    const ci = cellAt(lon, lat);
    if (ci < 0 || !valid[ci]) return hideHover();
    for (const t of [forestMap, tempMap]) {
      const ring = t.gHover.selectAll("circle").data([0, 1]).join("circle")
        .attr("class", (d) => (d ? "hover-ring" : "hover-ring-outer")).attr("r", 7);
      ring.attr("cx", t.x(lon)).attr("cy", t.y(lat));
    }
    const yi = state.yi, year = years[yi];
    const a = anomaly(state.season, yi, ci);
    const fs0 = f0[ci] / valid[ci], fsY = forestShare(ci, yi);
    showTooltip(event, `
      <div class="tt-title">${Math.abs(lat).toFixed(2)}°S, ${Math.abs(lon).toFixed(2)}°W <span style="color:var(--muted);font-weight:400">· 5 km cell</span></div>
      <div class="tt-row"><span>Forest 2001–03</span><span>${fmtPct(fs0)}</span></div>
      <div class="tt-row"><span>Forest ${year}</span><span>${fmtPct(fsY)}</span></div>
      <div class="tt-row"><span>${seasonName()} temp. ${year}</span><span>${Number.isFinite(a) ? fmtSigned(a) + " °C" : "no data"}</span></div>`);
  }
  function hideHover() {
    forestMap.gHover.selectAll("*").remove();
    tempMap.gHover.selectAll("*").remove();
    tooltip.attr("hidden", true);
  }
  function showTooltip(event, html) {
    tooltip.html(html).attr("hidden", null);
    const node = tooltip.node(), pad = 14;
    const { width, height } = node.getBoundingClientRect();
    let left = event.clientX + pad, top = event.clientY + pad;
    if (left + width > window.innerWidth - 8) left = event.clientX - width - pad;
    if (top + height > window.innerHeight - 8) top = event.clientY - height - pad;
    node.style.left = Math.max(8, left) + "px";
    node.style.top = Math.max(8, top) + "px";
  }
  for (const m of [forestMap, tempMap]) {
    m.svg.on("pointermove", (e) => onHover(e, m)).on("pointerleave", hideHover);
  }

  // ---------- legends ----------
  function drawLegends() {
    const items = [
      ["--map-forest", "Forest standing"],
      ["--map-new", "Cleared this year"],
      ["--map-cleared", "Cleared in an earlier year (since 2004)"],
      ["--map-nonforest", "Not forest in 2001–03 (savanna, or cleared earlier)"],
    ];
    d3.select("#legend-forest").selectAll("li").data(items).join("li")
      .html(([v, label]) => `<span class="swatch" style="background:var(${v})"></span>${label}`);

    const box = d3.select("#legend-temp").html("");
    const w = Math.min(360, box.node().getBoundingClientRect().width || 360);
    const svg = box.append("svg").attr("viewBox", `0 0 ${w} 28`);
    const id = "temp-grad";
    const grad = svg.append("defs").append("linearGradient").attr("id", id);
    d3.range(0, 1.0001, 0.1).forEach((t) => grad.append("stop").attr("offset", t).attr("stop-color", tempColor((t - 0.5) * 2 * TEMP_MAX)));
    svg.append("rect").attr("x", 0).attr("y", 0).attr("width", w).attr("height", 10).attr("rx", 3).attr("fill", `url(#${id})`);
    const sx = d3.scaleLinear([-TEMP_MAX, TEMP_MAX], [0, w]);
    svg.selectAll("text").data([-6, -3, 0, 3, 6]).join("text")
      .attr("x", (d) => sx(d)).attr("y", 25)
      .attr("text-anchor", (d) => (d === -6 ? "start" : d === 6 ? "end" : "middle"))
      .text((d) => (d === -6 ? "≤ −6 °C" : d === 6 ? "≥ +6 °C" : d === 0 ? "0" : (d > 0 ? "+" : "−") + Math.abs(d)));
  }

  // ---------- timeline (year slider) ----------
  const tl = d3.select("#timeline");
  const tlMargin = { left: 4, right: 4, top: 4, bottom: 16 };
  let tlX = null;
  function drawTimeline() {
    const width = tl.node().getBoundingClientRect().width;
    const height = 72;
    tl.attr("viewBox", `0 0 ${width} ${height}`);
    tlX = d3.scaleBand(years, [tlMargin.left, width - tlMargin.right]).paddingInner(0.18);
    const yMax = d3.max(meta.cleared_km2);
    const ty = d3.scaleLinear([0, yMax], [height - tlMargin.bottom, tlMargin.top + 8]);
    const year = years[state.yi];

    tl.selectAll("rect.tl-hit").data([0]).join("rect").attr("class", "tl-hit")
      .attr("x", 0).attr("y", 0).attr("width", width).attr("height", height).attr("fill", "transparent");
    tl.selectAll("rect.tl-bar").data(years).join("rect")
      .attr("class", (d) => "tl-bar" + (provisional.has(d) ? " provisional" : "") + (d > year ? " future" : ""))
      .attr("x", (d) => tlX(d)).attr("width", tlX.bandwidth())
      .attr("y", (d, i) => ty(meta.cleared_km2[i]))
      .attr("height", (d, i) => Math.max(0, ty(0) - ty(meta.cleared_km2[i])))
      .attr("rx", 2);
    const every = width < 520 ? 3 : 1;
    tl.selectAll("text.tl-year").data(years).join("text")
      .attr("class", (d) => "tl-year" + (d === year ? " current" : ""))
      .attr("x", (d) => tlX(d) + tlX.bandwidth() / 2).attr("y", height - 3)
      .attr("text-anchor", "middle")
      .text((d, i) => (d === year || i % every === 0 ? (width < 700 ? "'" + String(d).slice(2) : d) : ""));
    const px = tlX(year) + tlX.bandwidth() / 2;
    tl.selectAll("line.tl-handle").data([0]).join("line").attr("class", "tl-handle")
      .attr("x1", px).attr("x2", px).attr("y1", 2).attr("y2", height - tlMargin.bottom + 1);
    const p0 = d3.min([...provisional]);
    tl.selectAll("text.tl-note").data(provisional.size ? [0] : []).join("text").attr("class", "tl-note")
      .attr("x", tlX(p0) + tlX.bandwidth()).attr("y", 9).attr("text-anchor", "end").text("provisional");
    tl.attr("aria-valuenow", year).attr("aria-valuetext", `${year}: ${fmtInt(meta.cleared_km2[state.yi])} km² newly cleared`);
  }
  function yearFromPointer(event) {
    const [mx] = d3.pointer(event, tl.node());
    const step = tlX.step();
    const i = Math.round((mx - tlX(years[0]) - tlX.bandwidth() / 2) / step);
    return Math.max(0, Math.min(NY - 1, i));
  }
  let dragging = false;
  tl.on("pointerdown", (e) => { dragging = true; tl.node().setPointerCapture(e.pointerId); stop(); setYear(yearFromPointer(e)); })
    .on("pointermove", (e) => {
      if (dragging) return setYear(yearFromPointer(e));
      const i = yearFromPointer(e);
      showTooltip(e, `<div class="tt-title">${years[i]}${provisional.has(years[i]) ? " (provisional)" : ""}</div>
        <div class="tt-row"><span>Newly cleared</span><span>${fmtInt(meta.cleared_km2[i])} km²</span></div>
        <div class="tt-row"><span>Forest left</span><span>${fmtInt(meta.forest_km2[i])} km²</span></div>`);
    })
    .on("pointerup pointercancel", () => { dragging = false; })
    .on("pointerleave", () => tooltip.attr("hidden", true))
    .on("keydown", (e) => {
      const keys = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -5, PageUp: 5 };
      if (e.key in keys) { e.preventDefault(); stop(); setYear(Math.max(0, Math.min(NY - 1, state.yi + keys[e.key]))); }
      else if (e.key === "Home") { e.preventDefault(); stop(); setYear(0); }
      else if (e.key === "End") { e.preventDefault(); stop(); setYear(NY - 1); }
    });

  // ---------- play ----------
  const playBtn = d3.select("#play");
  function stop() {
    state.playing = false;
    clearInterval(timer);
    playBtn.classed("playing", false).attr("aria-label", "Play animation");
  }
  function play() {
    if (state.yi >= NY - 1) setYear(0);
    state.playing = true;
    playBtn.classed("playing", true).attr("aria-label", "Pause animation");
    timer = setInterval(() => {
      if (state.yi >= NY - 1) return stop();
      setYear(state.yi + 1);
    }, 700);
  }
  playBtn.on("click", () => (state.playing ? stop() : play()));

  // ---------- season ----------
  const seasonName = () => (state.season === "dry" ? "Dry-season" : "Whole-year");
  d3.selectAll(".segmented button").on("click", function () {
    state.season = this.dataset.season;
    d3.selectAll(".segmented button").attr("aria-pressed", function () { return String(this.dataset.season === state.season); });
    drawTemp();
    updateText();
    updateCharts();
  });

  // ---------- selection series ----------
  function selectionSeries() {
    if (!state.sel) return null;
    const s = state.sel;
    const c0 = Math.max(0, Math.floor((s.west - WEST) / meta.lst.deg)), c1 = Math.min(CW - 1, Math.floor((s.east - WEST) / meta.lst.deg));
    const r0 = Math.max(0, Math.floor((NORTH - s.north) / meta.lst.deg)), r1 = Math.min(CH - 1, Math.floor((NORTH - s.south) / meta.lst.deg));
    const temp = new Array(NY).fill(0), n = new Array(NY).fill(0);
    let v = 0, f = 0;
    const forestPx = new Array(NY).fill(0);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const ci = r * CW + c;
      if (!valid[ci]) continue;
      v += valid[ci]; f += f0[ci];
      for (let i = 0; i < NY; i++) {
        forestPx[i] += f0[ci] - clr[ci * NY + i];
        const a = anomaly(state.season, i, ci);
        if (Number.isFinite(a)) { temp[i] += a; n[i]++; }
      }
    }
    if (!v) return null;
    return {
      temp: temp.map((t, i) => (n[i] ? t / n[i] : null)),
      forest: forestPx.map((p) => p / v), forest0: f / v,
      cells: (r1 - r0 + 1) * (c1 - c0 + 1),
    };
  }

  // ---------- line chart ----------
  const lineBox = d3.select("#line-chart");
  const lineSvg = lineBox.append("svg");
  const gl = {
    grid: lineSvg.append("g").attr("class", "gridline"),
    xAxis: lineSvg.append("g").attr("class", "axis"),
    yAxis: lineSvg.append("g").attr("class", "axis"),
    zero: lineSvg.append("line").attr("class", "zero-line"),
    area: lineSvg.append("path").attr("class", "gap-area"),
    lines: lineSvg.append("g"),
    rule: lineSvg.append("line").attr("class", "year-rule"),
    bracket: lineSvg.append("g"),
    dots: lineSvg.append("g"),
    labels: lineSvg.append("g"),
    hover: lineSvg.append("line").attr("class", "hover-rule").attr("visibility", "hidden"),
    hit: lineSvg.append("rect").attr("fill", "transparent").style("cursor", "pointer"),
    ytitle: lineSvg.append("text").attr("class", "axis-title"),
  };

  function lineSeries() {
    const g = meta.groups;
    const out = [
      { key: "cleared", label: "Cleared by 2022", color: colors.clearedLine, dash: null, values: g.cleared[state.season] },
      { key: "standing", label: "Standing forest", color: colors.standingLine, dash: "6 4", values: g.standing[state.season] },
    ];
    const sel = selectionSeries();
    if (sel) out.push({ key: "selection", label: "Your selection", color: colors.selectionLine, dash: null, values: sel.temp, sel });
    return out;
  }

  function drawLineChart(series) {
    const width = lineBox.node().getBoundingClientRect().width;
    const narrow = width < 520;
    const m = { top: 22, right: narrow ? 92 : 120, bottom: 28, left: 40 };
    const height = Math.max(260, Math.min(360, width * 0.5));
    lineSvg.attr("viewBox", `0 0 ${width} ${height}`).attr("height", height);
    const x = d3.scaleLinear([years[0], years[NY - 1]], [m.left, width - m.right]);
    const all = series.flatMap((s) => s.values).filter((v) => v != null);
    const y = d3.scaleLinear([Math.min(-0.5, d3.min(all)), Math.max(1, d3.max(all))], [height - m.bottom, m.top]).nice();

    gl.grid.attr("transform", `translate(${m.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickSize(-(width - m.left - m.right)).tickFormat(""));
    gl.yAxis.attr("transform", `translate(${m.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(8).tickFormat((d) => (d > 0 ? "+" : d < 0 ? "−" : "") + Math.abs(d)))
      .call((g) => g.select(".domain").remove());
    gl.xAxis.attr("transform", `translate(0,${height - m.bottom})`)
      .call(d3.axisBottom(x).ticks(narrow ? 4 : 8).tickFormat(d3.format("d")).tickSizeOuter(0));
    gl.ytitle.attr("x", m.left - 36).attr("y", 10).text("°C vs. 2001–03");
    gl.zero.attr("x1", m.left).attr("x2", width - m.right).attr("y1", y(0)).attr("y2", y(0));

    const line = d3.line().defined((d) => d != null).x((d, i) => x(years[i])).y((d) => y(d));
    const c = series[0].values, s = series[1].values;
    gl.area.attr("d", d3.area().x((d, i) => x(years[i])).y0((d, i) => y(s[i])).y1((d) => y(d))(c));

    gl.lines.selectAll("path").data(series, (d) => d.key).join("path")
      .attr("class", "series-line").attr("stroke", (d) => d.color).attr("stroke-dasharray", (d) => d.dash)
      .attr("d", (d) => line(d.values));

    // current year
    const yi = state.yi, xr = x(years[yi]);
    gl.rule.attr("x1", xr).attr("x2", xr).attr("y1", m.top - 8).attr("y2", height - m.bottom);
    gl.dots.selectAll("circle").data(series.filter((d) => d.values[yi] != null), (d) => d.key).join("circle")
      .attr("class", "value-dot").attr("r", 5).attr("fill", (d) => d.color)
      .attr("cx", xr).attr("cy", (d) => y(d.values[yi]));

    // gap bracket at current year
    const gap = c[yi] - s[yi];
    const bx = xr + 10 > width - m.right - 70 ? xr - 10 : xr + 10;
    const leftSide = bx < xr;
    const bracket = gl.bracket.selectAll("g").data(Number.isFinite(gap) && Math.abs(y(c[yi]) - y(s[yi])) > 14 ? [gap] : []).join((enter) => {
      const g = enter.append("g");
      g.append("path").attr("class", "bracket");
      g.append("text").attr("class", "gap-label");
      return g;
    });
    const tick = leftSide ? 5 : -5;
    bracket.select("path").attr("d", `M${bx + tick},${y(c[yi])}H${bx}V${y(s[yi])}H${bx + tick}`);
    bracket.select("text").attr("x", leftSide ? bx - 6 : bx + 6).attr("y", (y(c[yi]) + y(s[yi])) / 2).attr("dy", "0.35em")
      .attr("text-anchor", leftSide ? "end" : "start").text((d) => `${fmtSigned(d)} °C`);

    // direct end labels, nudged apart
    const ends = series.map((d) => {
      const lastIdx = d3.max(d.values.map((v, i) => (v != null ? i : -1)));
      return { ...d, ly: y(d.values[lastIdx]), ty: y(d.values[lastIdx]) };
    }).sort((a, b) => a.ty - b.ty);
    for (let i = 1; i < ends.length; i++) if (ends[i].ty - ends[i - 1].ty < 15) ends[i].ty = ends[i - 1].ty + 15;
    gl.labels.selectAll("text").data(ends, (d) => d.key).join("text")
      .attr("class", "end-label").attr("x", width - m.right + 8).attr("y", (d) => d.ty).attr("dy", "0.35em")
      .text((d) => d.label);

    // hover crosshair + click to set year
    gl.hit.attr("x", m.left).attr("y", m.top).attr("width", width - m.left - m.right).attr("height", height - m.top - m.bottom)
      .on("pointermove", (e) => {
        const [mx] = d3.pointer(e, lineSvg.node());
        const i = Math.max(0, Math.min(NY - 1, Math.round(x.invert(mx) - years[0])));
        gl.hover.attr("visibility", "visible").attr("x1", x(years[i])).attr("x2", x(years[i])).attr("y1", m.top).attr("y2", height - m.bottom);
        const rows = series.map((d) => `<div class="tt-row"><span><span class="tt-key" style="background:${d.color}"></span>${d.label}</span><span>${d.values[i] == null ? "–" : fmtSigned(d.values[i]) + " °C"}</span></div>`).join("");
        const g = c[i] - s[i];
        showTooltip(e, `<div class="tt-title">${years[i]} · ${seasonName().toLowerCase()}</div>${rows}
          <div class="tt-row" style="border-top:1px solid var(--border);margin-top:3px;padding-top:3px"><span>Gap (cleared − standing)</span><span>${fmtSigned(g)} °C</span></div>
          <div style="color:var(--muted);font-size:12px;margin-top:2px">Click to jump to ${years[i]}</div>`);
      })
      .on("pointerleave", () => { gl.hover.attr("visibility", "hidden"); tooltip.attr("hidden", true); })
      .on("click", (e) => {
        const [mx] = d3.pointer(e, lineSvg.node());
        stop();
        setYear(Math.max(0, Math.min(NY - 1, Math.round(x.invert(mx) - years[0]))));
      });

    // legend (always present; lines are also direct-labeled)
    d3.select("#legend-lines").selectAll("li").data(series, (d) => d.key).join("li")
      .html((d) => `<span class="line-key${d.dash ? " dashed" : ""}" style="border-color:${d.color}"></span>${
        d.key === "cleared" ? `Cells cleared 2004–22 (lost ≥ 30% of area to clearing; ${fmtInt(meta.groups.cleared.cells)} cells)`
        : d.key === "standing" ? `Standing forest (${fmtInt(meta.groups.standing.cells)} cells)`
        : `Your selection (${fmtInt(d.sel.cells)} cells; forest ${fmtPct(d.sel.forest0)} → ${fmtPct(d.sel.forest[state.yi])} by ${years[state.yi]})`}`);
  }

  // ---------- dose-response bars ----------
  const BINS = [
    { lo: 0, hi: 0.05, label: "< 5%" }, { lo: 0.05, hi: 0.2, label: "5–20%" }, { lo: 0.2, hi: 0.4, label: "20–40%" },
    { lo: 0.4, hi: 0.6, label: "40–60%" }, { lo: 0.6, hi: 1.01, label: "60%+" },
  ];
  const doseBox = d3.select("#dose-chart");
  const doseSvg = doseBox.append("svg");
  function doseData() {
    const yi = state.yi;
    let sSum = 0, sN = 0;
    const sums = BINS.map(() => [0, 0]);
    for (let ci = 0; ci < NC; ci++) {
      if (!valid[ci] || valid[ci] < 13) continue;
      const a = anomaly(state.season, yi, ci);
      if (!Number.isFinite(a)) continue;
      if (standing[ci]) { sSum += a; sN++; }
      if (f0[ci] / valid[ci] < 0.5) continue;
      const lost = lostShare(ci, yi);
      const b = BINS.findIndex((bin) => lost >= bin.lo && lost < bin.hi);
      if (b >= 0) { sums[b][0] += a; sums[b][1]++; }
    }
    const base = sN ? sSum / sN : NaN;
    return BINS.map((bin, i) => ({ ...bin, n: sums[i][1], value: sums[i][1] >= 20 ? sums[i][0] / sums[i][1] - base : null }));
  }
  function drawDose() {
    const data = doseData();
    const width = doseBox.node().getBoundingClientRect().width;
    const height = 280;
    const m = { top: 22, right: 8, bottom: 44, left: 36 };
    doseSvg.attr("viewBox", `0 0 ${width} ${height}`).attr("height", height);
    const x = d3.scaleBand(data.map((d) => d.label), [m.left, width - m.right]).padding(0.28);
    const vals = data.map((d) => d.value).filter((v) => v != null);
    const y = d3.scaleLinear([Math.min(0, d3.min(vals) ?? 0), Math.max(1, d3.max(vals) ?? 1)], [height - m.bottom, m.top]).nice();

    doseSvg.selectAll("g.gridline").data([0]).join("g").attr("class", "gridline").attr("transform", `translate(${m.left},0)`)
      .call(d3.axisLeft(y).ticks(4).tickSize(-(width - m.left - m.right)).tickFormat(""));
    doseSvg.selectAll("g.y").data([0]).join("g").attr("class", "axis y").attr("transform", `translate(${m.left},0)`)
      .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(6).tickFormat((d) => (d > 0 ? "+" : d < 0 ? "−" : "") + Math.abs(d)))
      .call((g) => g.select(".domain").remove());
    doseSvg.selectAll("g.x").data([0]).join("g").attr("class", "axis x").attr("transform", `translate(0,${height - m.bottom})`)
      .call(d3.axisBottom(x).tickSize(0).tickPadding(6)).call((g) => g.select(".domain").remove());
    doseSvg.selectAll("text.x-title").data([0]).join("text").attr("class", "axis-title x-title")
      .attr("x", (m.left + width - m.right) / 2).attr("y", height - 6).attr("text-anchor", "middle")
      .text(`Share of 5 km cell cleared by ${years[state.yi]}`);
    doseSvg.selectAll("line.zero-line").data([0]).join("line").attr("class", "zero-line")
      .attr("x1", m.left).attr("x2", width - m.right).attr("y1", y(0)).attr("y2", y(0));

    const bars = data.filter((d) => d.value != null);
    const r = 4;
    const barPath = (d) => {
      const x0 = x(d.label), w = x.bandwidth(), y0 = y(0), y1 = y(d.value);
      const h = Math.abs(y0 - y1), rr = Math.min(r, h, w / 2);
      if (d.value >= 0) return `M${x0},${y0}V${y1 + rr}Q${x0},${y1} ${x0 + rr},${y1}H${x0 + w - rr}Q${x0 + w},${y1} ${x0 + w},${y1 + rr}V${y0}Z`;
      return `M${x0},${y0}V${y1 - rr}Q${x0},${y1} ${x0 + rr},${y1}H${x0 + w - rr}Q${x0 + w},${y1} ${x0 + w},${y1 - rr}V${y0}Z`;
    };
    doseSvg.selectAll("path.dose-bar").data(bars, (d) => d.label).join("path").attr("class", "dose-bar")
      .attr("fill", colors.clearedLine).attr("d", barPath)
      .on("pointermove", (e, d) => showTooltip(e, `<div class="tt-title">${d.label} of cell cleared by ${years[state.yi]}</div>
        <div class="tt-row"><span>vs. standing forest</span><span>${fmtSigned(d.value)} °C</span></div>
        <div class="tt-row"><span>Cells</span><span>${fmtInt(d.n)}</span></div>`))
      .on("pointerleave", () => tooltip.attr("hidden", true));
    doseSvg.selectAll("text.bar-label").data(bars, (d) => d.label).join("text").attr("class", "bar-label")
      .attr("x", (d) => x(d.label) + x.bandwidth() / 2)
      .attr("y", (d) => (d.value >= 0 ? y(d.value) - 6 : y(d.value) + 14))
      .attr("text-anchor", "middle").text((d) => fmtSigned(d.value));
    doseSvg.selectAll("text.y-title").data([0]).join("text").attr("class", "axis-title y-title")
      .attr("x", m.left - 30).attr("y", 10).text("°C vs. standing forest");
    d3.select("#dose-sub").text(`${seasonName()} temperature in ${years[state.yi]}, for 5 km cells that were at least half forest in 2001–03`);
  }

  // ---------- text ----------
  function updateText() {
    const yi = state.yi, year = years[yi];
    d3.select("#year-readout").text(year);
    d3.select("#forest-title").text(`Forest in ${year}`);
    const lost = meta.forest_km2[0] - meta.forest_km2[yi];
    d3.select("#forest-sub").text(year < 2004
      ? "Baseline years — clearing is measured from 2004 on"
      : `${fmtInt(lost)} km² cleared since 2004 (${fmtPct(lost / meta.forest_km2[0])} of the 2001–03 forest)${provisional.has(year) ? " · this year is provisional" : ""}`);
    d3.select("#temp-title").text(`${seasonName()} daytime temperature, ${year}`);
    const c = meta.groups.cleared[state.season][yi], s = meta.groups.standing[state.season][yi];
    const gap = c - s;
    d3.select("#headline").text(year <= 2003
      ? `${year}: before the clearing, both groups had the same temperature`
      : `In ${year}, land being cleared was ${d3.format(".1f")(Math.abs(gap))} °C ${gap >= 0 ? "hotter" : "cooler"} than standing forest`);
    d3.select("#headline-sub").text(`${seasonName()} daytime land surface temperature, compared with the same months in 2001–03. Both groups felt the same weather, so the gap shows the effect of clearing.`);
    d3.select("#selection-hint").classed("has-selection", !!state.sel);
  }

  // ---------- table ----------
  function drawTable() {
    const g = meta.groups;
    const head = ["Year", "Newly cleared (km²)", "Forest left (km²)", "Cleared, dry season (°C)", "Standing, dry season (°C)", "Gap, dry (°C)", "Gap, whole year (°C)"];
    const rows = years.map((yr, i) => [
      yr + (provisional.has(yr) ? "*" : ""), fmtInt(meta.cleared_km2[i]), fmtInt(meta.forest_km2[i]),
      fmtSigned(g.cleared.dry[i]), fmtSigned(g.standing.dry[i]),
      fmtSigned(g.cleared.dry[i] - g.standing.dry[i]), fmtSigned(g.cleared.annual[i] - g.standing.annual[i]),
    ]);
    const t = d3.select("#data-table");
    t.append("thead").append("tr").selectAll("th").data(head).join("th").text((d) => d);
    t.append("tbody").selectAll("tr").data(rows).join("tr").selectAll("td").data((d) => d).join("td").text((d) => d);
    d3.select(".table-view").append("p").style("font-size", "12px").style("color", "var(--muted)").text("* provisional: fewer than 3 later years to confirm the clearing.");
  }

  // ---------- update orchestration ----------
  function updateCharts() {
    drawLineChart(lineSeries());
    drawDose();
    updateText();
  }
  function setYear(i) {
    if (i === state.yi) return;
    state.yi = i;
    drawForest();
    drawTemp();
    drawTimeline();
    updateCharts();
  }
  function layoutAll() {
    layoutMaps();
    drawLegends();
    drawTimeline();
    updateCharts();
  }

  drawForest();
  drawTemp();
  drawTable();
  layoutAll();
  let resizeTimer;
  new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layoutAll, 80); }).observe(document.querySelector(".page"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    readColors(); buildTempLut(); drawForest(); drawTemp(); layoutAll();
  });

  // ---------- self-check (open with ?check) ----------
  if (new URLSearchParams(location.search).has("check")) {
    let sumCodes = 0, sumLst = 0;
    for (const v of codes) sumCodes += v;
    for (const v of lstRaw) sumLst += v;
    const mean = (season, mask) => years.map((_, yi) => {
      let s = 0, n = 0;
      for (let ci = 0; ci < NC; ci++) if (mask(ci)) { const a = anomaly(season, yi, ci); if (Number.isFinite(a)) { s += a; n++; } }
      return +(s / n).toFixed(2);
    });
    const clearedMask = (ci) => valid[ci] && (f0[ci] - (f0[ci] - clr[ci * NY + NY - 1])) / valid[ci] >= 0.3;
    const out = {
      sumCodes, sumLst, W, H, CW, CH,
      cleared_cells: d3.sum(d3.range(NC), (ci) => (clearedMask(ci) ? 1 : 0)), standing_cells: d3.sum(standing),
      cleared_dry_js: mean("dry", clearedMask), cleared_dry_meta: meta.groups.cleared.dry,
      standing_dry_js: mean("dry", (ci) => standing[ci]), standing_dry_meta: meta.groups.standing.dry,
    };
    d3.select("#check").attr("hidden", null).text(JSON.stringify(out));
  }
})();
