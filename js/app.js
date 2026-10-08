(function () {
'use strict';

/* global L, proj4, GeoTIFF */
const C = window.GCChange;
const I = window.GCImagery;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PLANNING_API = 'https://www.planning.data.gov.uk';

const state = { running: false, result: null, layers: {}, view: 'change' };

// ---------------------------------------------------------------------------
// Map and analysis box
// ---------------------------------------------------------------------------
const map = L.map('map').setView([51.4091, -0.3049], 15);
const imagery = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
}).addTo(map);
const grey = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19, maxNativeZoom: 16, attribution: 'Basemap &copy; Esri',
});
L.control.layers({ 'Aerial (Esri)': imagery, 'Light grey (Esri)': grey }, {}, { collapsed: true }).addTo(map);

const box = L.rectangle([[0, 0], [0, 0]], { color: '#a3e635', weight: 3, fill: false, dashArray: '8 6', interactive: false }).addTo(map);
function currentGrid() {
  const c = map.getCenter();
  return C.makeGrid(c.lat, c.lng, Number($('#size').value));
}
function drawBox() {
  if (state.running) return;
  const g = currentGrid();
  box.setBounds([[g.south, g.west], [g.north, g.east]]);
}
map.on('move', drawBox);
$('#size').addEventListener('change', () => {
  drawBox();
  const g = currentGrid();
  map.fitBounds([[g.south, g.west], [g.north, g.east]], { padding: [40, 40] });
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
(function years() {
  const now = new Date();
  // The latest full summer: this year once September has started.
  const last = now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const opts = [];
  for (let y = last; y >= 2017; y--) opts.push(`<option value="${y}">${y}</option>`);
  $('#y0').innerHTML = opts.join('');
  $('#y1').innerHTML = opts.join('');
  $('#y1').value = String(last);
  $('#y0').value = String(Math.max(2017, last - 4));
})();

async function goTo(text) {
  const t = text.trim();
  if (!t) return;
  status('Finding place…', true);
  try {
    let lat, lon;
    const pc = t.match(/^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})$/i);
    if (pc) {
      const r = await (await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(`${pc[1]} ${pc[2]}`)}`)).json();
      if (!r.result) throw new Error('Postcode not found');
      ({ latitude: lat, longitude: lon } = r.result);
    } else {
      const r = await (await fetch(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: t, format: 'jsonv2', limit: '1' })}`)).json();
      if (!r.length) throw new Error('Place not found');
      lat = +r[0].lat; lon = +r[0].lon;
    }
    map.setView([lat, lon], 15);
    status('');
  } catch (e) {
    status(e.message, false, true);
  }
}
$('#go').addEventListener('click', () => goTo($('#place').value));
$('#place').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goTo($('#place').value); } });

function status(text, busy = false, error = false) {
  const el = $('#status');
  el.className = `status${error ? ' error' : ''}`;
  el.innerHTML = `${busy ? '<span class="spinner"></span>' : ''}<span>${esc(text)}</span>`;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
$('#controls').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.running) return;
  const y0 = Number($('#y0').value), y1 = Number($('#y1').value);
  if (y0 === y1) { status('Choose two different years.', false, true); return; }
  const [before, after] = y0 < y1 ? [y0, y1] : [y1, y0];
  const grid = currentGrid();
  const season = $('#season').value;
  const delta = Number($('#sens').value);
  state.running = true;
  $('#run').disabled = true;
  $('#results').innerHTML = '';
  clearOverlays();
  try {
    const reader = I.createReader({ GeoTIFF, proj4 });
    const onStatus = (t) => status(t, true);
    const b = await I.yearComposite({ fetchFn: fetch, reader, grid, year: before, season, onStatus });
    const a = await I.yearComposite({ fetchFn: fetch, reader, grid, year: after, season, onStatus });
    status('Comparing…', true);
    const { cls, delta: d } = C.classify(b.ndvi, a.ndvi, { delta });
    const loss = C.patches(grid, cls, d, 2);
    const gain = C.patches(grid, cls, d, 3);
    const sum = C.summary(grid, cls, b.ndvi, a.ndvi);
    state.result = { grid, before: b, after: a, years: [before, after], cls, loss, gain, sum, season, delta };
    status('Checking planning designations…', true);
    state.result.designations = await designations(grid).catch(() => null);
    tagPatches(state.result);
    drawResult();
    status('');
  } catch (err) {
    console.error(err);
    status(err.message || 'Something went wrong reading the imagery.', false, true);
  } finally {
    state.running = false;
    $('#run').disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Planning designations in the box (England only; optional)
// ---------------------------------------------------------------------------
async function designations(grid) {
  const wkt = `POLYGON((${grid.west} ${grid.south},${grid.east} ${grid.south},${grid.east} ${grid.north},${grid.west} ${grid.north},${grid.west} ${grid.south}))`;
  const get = async (dataset) => {
    for (const enc of [(s) => s.replace(/ /g, '%20'), encodeURIComponent]) {
      try {
        const r = await fetch(`${PLANNING_API}/entity.geojson?dataset=${dataset}&geometry_relation=intersects&geometry=${enc(wkt)}&limit=500`);
        if (!r.ok) continue;
        const fc = await r.json();
        const feats = (fc.features || []).filter((f) => f.geometry && (!f.properties.dataset || f.properties.dataset === dataset));
        // An ignored filter returns unrelated records: require every feature to touch the box.
        if (feats.every((f) => intersectsBox(f.geometry, grid))) return feats;
      } catch (e) { /* try next */ }
    }
    return [];
  };
  const [ca, tpz] = await Promise.all([get('conservation-area'), get('tree-preservation-zone')]);
  return { ca, tpz };
}

function coordsOf(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return g.coordinates.flat();
  if (g.type === 'MultiPolygon') return g.coordinates.flat(2);
  if (g.type === 'Point') return [g.coordinates];
  return [];
}
function intersectsBox(g, grid) {
  const pts = coordsOf(g);
  if (!pts.length) return false;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of pts) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return !(e < grid.west || w > grid.east || n < grid.south || s > grid.north);
}
function inPolygon(lat, lon, g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return polys.some((p) => inRing(p[0]) && !p.slice(1).some(inRing));
}
function tagPatches(r) {
  const d = r.designations;
  for (const p of [...r.loss, ...r.gain]) {
    p.tags = [];
    if (!d) continue;
    const ca = d.ca.find((f) => inPolygon(p.lat, p.lon, f.geometry));
    const tpz = d.tpz.find((f) => inPolygon(p.lat, p.lon, f.geometry));
    if (tpz) p.tags.push('TPO area');
    if (ca) p.tags.push(`Conservation area${ca.properties.name ? `: ${titleCase(ca.properties.name)}` : ''}`);
  }
}
function titleCase(s) {
  return String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ Conservation Area$/, '');
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
function clearOverlays() {
  for (const l of Object.values(state.layers)) l.remove();
  state.layers = {};
  $('#legend').hidden = true;
}

function imageLayer(grid, rgba, opacity = 1) {
  const cv = document.createElement('canvas');
  cv.width = grid.width; cv.height = grid.height;
  cv.getContext('2d').putImageData(new ImageData(rgba, grid.width, grid.height), 0, 0);
  return L.imageOverlay(cv.toDataURL(), [[grid.south, grid.west], [grid.north, grid.east]], { opacity, interactive: false });
}

function setView(view) {
  state.view = view;
  const L_ = state.layers;
  for (const k of ['change', 'before', 'after']) if (L_[k]) (k === view ? L_[k].addTo(map) : L_[k].remove());
  if (L_.patches) L_.patches.bringToFront();
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
}

function drawResult() {
  const r = state.result;
  const { grid, sum, loss, gain, before, after, years } = r;
  clearOverlays();
  state.layers.change = imageLayer(grid, C.changeImage(grid, r.cls), 0.9);
  if (before.visual) state.layers.before = imageLayer(grid, C.rgbImage(grid, before.visual.r, before.visual.g, before.visual.b));
  if (after.visual) state.layers.after = imageLayer(grid, C.rgbImage(grid, after.visual.r, after.visual.g, after.visual.b));
  if (r.designations) {
    state.layers.ca = L.geoJSON(r.designations.ca, { style: { color: '#0f766e', weight: 2, fill: false }, interactive: false }).addTo(map);
    state.layers.tpz = L.geoJSON(r.designations.tpz, { style: { color: '#15803d', weight: 1.5, dashArray: '4 3', fill: false }, interactive: false }).addTo(map);
  }
  state.layers.patches = L.featureGroup(loss.concat(gain).map((p, k) => L.rectangle(p.bounds, {
    color: p.kind === 'loss' ? '#dc2626' : '#256abf', weight: 1.5, fill: false,
  }).bindPopup(patchPopup(p)))).addTo(map);
  $('#legend').hidden = false;
  setView('change');
  box.setBounds([[grid.south, grid.west], [grid.north, grid.east]]);

  const ha = (x) => (x < 1 ? x.toFixed(2) : x.toFixed(1));
  const covWarn = sum.coverage < 0.8
    ? `<div class="note warn">Only ${Math.round(sum.coverage * 100)}% of the box had clear readings in both years (clouds or image edges). Grey areas weren't compared.</div>` : '';
  const sceneList = (y, s) => `${y}: ${s.scenes.map((x) => `${x.date} (${Math.round(x.validFraction * 100)}% clear)`).join(', ')}`;
  const list = (arr, max) => arr.slice(0, max).map((p) => {
    const i = (p.kind === 'loss' ? loss : gain).indexOf(p);
    return `<li><button data-kind="${p.kind}" data-i="${i}">
      <span class="dot ${p.kind}"></span>
      <span><span class="a">${Math.round(p.areaM2).toLocaleString('en-GB')} m² ${p.kind}</span>${p.tags && p.tags.length ? `<br><span class="tags">${esc(p.tags.join(' · '))}</span>` : ''}</span>
      <span class="d">${p.meanDelta > 0 ? '+' : ''}${p.meanDelta.toFixed(2)} NDVI</span>
    </button></li>`;
  }).join('');
  const flagged = loss.filter((p) => p.tags && p.tags.length).length;

  $('#results').innerHTML = `
    <section class="block">
      <h2>${years[0]} → ${years[1]}</h2>
      <div class="tiles">
        <div class="tile loss"><div class="num">${ha(sum.lossHa)} ha</div><div class="lbl">vegetation lost (${loss.length} patch${loss.length === 1 ? '' : 'es'})</div></div>
        <div class="tile gain"><div class="num">${ha(sum.gainHa)} ha</div><div class="lbl">vegetation gained (${gain.length} patch${gain.length === 1 ? '' : 'es'})</div></div>
        <div class="tile"><div class="num">${Math.round(sum.vegBeforePct)}% → ${Math.round(sum.vegAfterPct)}%</div><div class="lbl">of the box green</div></div>
        <div class="tile"><div class="num">${flagged}</div><div class="lbl">loss patches in a TPO or conservation area</div></div>
      </div>
      ${covWarn}
      <div class="views" role="group" aria-label="Map view">
        <button class="btn btn-small" data-view="change" aria-pressed="true">Change</button>
        ${before.visual ? `<button class="btn btn-small" data-view="before" aria-pressed="false">${years[0]} true colour</button>` : ''}
        ${after.visual ? `<button class="btn btn-small" data-view="after" aria-pressed="false">${years[1]} true colour</button>` : ''}
      </div>
      <div class="scenes">Images used. ${esc(sceneList(years[0], before))}. ${esc(sceneList(years[1], after))}.</div>
      ${r.designations === null ? '<div class="note">Planning designations couldn\'t be loaded, so patches aren\'t checked against TPO and conservation areas.</div>' : ''}
      ${loss.length ? `<h2>Largest losses</h2><ul class="patches">${list(loss, 15)}</ul>` : '<p class="small">No patches of vegetation loss above the size limit.</p>'}
      ${gain.length ? `<h2>Largest gains</h2><ul class="patches">${list(gain, 8)}</ul>` : ''}
      <div class="row">
        <button class="btn btn-small" id="dl-geojson" type="button">Download GeoJSON</button>
        <button class="btn btn-small" id="dl-csv" type="button">Download CSV</button>
      </div>
    </section>`;
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  document.querySelectorAll('.patches button').forEach((b) => b.addEventListener('click', () => {
    const p = (b.dataset.kind === 'loss' ? loss : gain)[Number(b.dataset.i)];
    map.fitBounds(p.bounds, { maxZoom: 18, padding: [80, 80] });
    L.popup().setLatLng([p.lat, p.lon]).setContent(patchPopup(p)).openOn(map);
  }));
  $('#dl-geojson').addEventListener('click', () => {
    const gj = C.patchesToGeoJSON(grid, loss.concat(gain), (p) => ({ tags: (p.tags || []).join('; '), before_year: years[0], after_year: years[1] }));
    download(`green-change-${years[0]}-${years[1]}.geojson`, JSON.stringify(gj), 'application/geo+json');
  });
  $('#dl-csv').addEventListener('click', () => {
    const rows = [['id', 'kind', 'area_m2', 'mean_ndvi_change', 'lat', 'lon', 'tags', 'before_year', 'after_year']];
    loss.concat(gain).forEach((p, k) => rows.push([k + 1, p.kind, Math.round(p.areaM2), p.meanDelta.toFixed(3), p.lat.toFixed(6), p.lon.toFixed(6), (p.tags || []).join('; '), years[0], years[1]]));
    download(`green-change-${years[0]}-${years[1]}.csv`, rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
  });
}

function patchPopup(p) {
  return `<strong>${Math.round(p.areaM2).toLocaleString('en-GB')} m² ${p.kind}</strong><br>Greenness change ${p.meanDelta > 0 ? '+' : ''}${p.meanDelta.toFixed(2)} NDVI`
    + `${p.tags && p.tags.length ? `<br>${esc(p.tags.join(' · '))}` : ''}`
    + `<br><a href="https://www.openstreetmap.org/?mlat=${p.lat.toFixed(6)}&mlon=${p.lon.toFixed(6)}#map=19/${p.lat.toFixed(6)}/${p.lon.toFixed(6)}" target="_blank" rel="noopener">Open in OpenStreetMap</a>`;
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

drawBox();
})();
