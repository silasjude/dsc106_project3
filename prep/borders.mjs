// Build a small GeoJSON of country borders around the study area from world-atlas (Natural Earth 1:50m).
// Usage: node prep/borders.mjs <path-to-countries-50m.json> <path-to-topojson-client.js> > data/borders.json
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const [,, topoPath, clientPath] = process.argv;
const topojson = require(clientPath);
const topo = JSON.parse(fs.readFileSync(topoPath, 'utf8'));
const fc = topojson.feature(topo, topo.objects.countries);
const [W, S, E, N] = [-80, -23, -40, 7];                 // study box + margin
const inBox = ([x, y]) => x >= W && x <= E && y >= S && y <= N;
const r3 = (v) => Math.round(v * 1000) / 1000;
const out = [];
for (const f of fc.features) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
  const keep = polys.filter(p => p[0].some(inBox)).map(p => p.map(ring => ring.map(([x, y]) => [r3(x), r3(y)])));
  if (keep.length) out.push({ type: 'Feature', properties: { name: f.properties.name }, geometry: { type: 'MultiPolygon', coordinates: keep } });
}
process.stdout.write(JSON.stringify({ type: 'FeatureCollection', features: out }));
