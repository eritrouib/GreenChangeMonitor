(function () {
'use strict';

// Green Change Monitor: finding and reading Sentinel-2 imagery.
// Scenes come from Element 84's Earth Search STAC catalogue (free, no key) and
// are read as Cloud-Optimised GeoTIFFs straight from the public AWS bucket:
// only the bytes for the area being analysed are downloaded.
// Exposes globalThis.GCImagery. Needs GCChange; GeoTIFF and proj4 are passed in.

const C = globalThis.GCChange;
const EARTH_SEARCH = 'https://earth-search.aws.element84.com/v1';

const SEASONS = {
  summer: { label: 'Summer (June–August)', months: [6, 8] },
  growing: { label: 'Growing season (May–September)', months: [5, 9] },
};

function lastDay(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function covers(itemBbox, grid) {
  if (!itemBbox) return false;
  const [w, s, e, n] = itemBbox;
  return w <= grid.west && s <= grid.south && e >= grid.east && n >= grid.north;
}

/** Candidate scenes for one year and season, clearest first, one per date. */
async function searchScenes(fetchFn, grid, year, season = 'summer', maxCloud = 40) {
  const [m0, m1] = (SEASONS[season] || SEASONS.summer).months;
  const pad = (n) => String(n).padStart(2, '0');
  const datetime = `${year}-${pad(m0)}-01T00:00:00Z/${year}-${pad(m1)}-${lastDay(year, m1)}T23:59:59Z`;
  const bbox = [grid.west, grid.south, grid.east, grid.north].map((x) => x.toFixed(6)).join(',');
  const query = encodeURIComponent(JSON.stringify({ 'eo:cloud_cover': { lt: maxCloud } }));
  const url = `${EARTH_SEARCH}/search?collections=sentinel-2-l2a&bbox=${bbox}&datetime=${datetime}&limit=100&query=${query}`;
  const res = await fetchFn(url, { headers: { Accept: 'application/geo+json' } });
  if (!res.ok) throw new Error(`Image search failed (HTTP ${res.status})`);
  const data = await res.json();
  const byDate = new Map();
  for (const f of data.features || []) {
    if (!covers(f.bbox, grid)) continue;
    const a = f.assets || {};
    if (!a.red || !a.nir || !a.scl) continue;
    const date = String(f.properties.datetime).slice(0, 10);
    const prev = byDate.get(date);
    if (!prev || f.properties['eo:cloud_cover'] < prev.properties['eo:cloud_cover']) byDate.set(date, f);
  }
  return [...byDate.values()].sort((x, y) => x.properties['eo:cloud_cover'] - y.properties['eo:cloud_cover']);
}

function epsgOf(item) {
  const p = item.properties || {};
  if (p['proj:epsg']) return p['proj:epsg'];
  if (p['proj:code']) return Number(String(p['proj:code']).split(':')[1]);
  throw new Error('Image has no projection information');
}

/** Opens COGs and reads grid-aligned windows. */
function createReader({ GeoTIFF, proj4 }) {
  const images = new Map();
  async function open(href) {
    if (!images.has(href)) {
      images.set(href, GeoTIFF.fromUrl(href, { allowFullFile: true }).then((t) => t.getImage()).catch((e) => {
        images.delete(href);
        throw e;
      }));
    }
    return images.get(href);
  }

  /** Read bands of one file onto the grid. Returns an array of Float32Array (NaN = no data). */
  async function readToGrid(href, grid, epsg, { samples = [0], nodata = 0 } = {}) {
    const image = await open(href);
    const toProj = proj4('EPSG:4326', C.utmCode(epsg)).forward;
    const origin = image.getOrigin();
    const resolution = image.getResolution();
    const bounds = C.gridBoundsIn(grid, toProj, Math.abs(resolution[0]) * 2);
    const win = C.windowFor(bounds, origin, resolution, image.getWidth(), image.getHeight());
    if (!win) return samples.map(() => new Float32Array(grid.width * grid.height).fill(NaN));
    const rasters = await image.readRasters({ window: win, samples });
    return samples.map((_, k) => C.sampleToGrid(grid, {
      data: rasters[k], x0: win[0], y0: win[1], w: win[2] - win[0], h: win[3] - win[1], origin, resolution,
    }, toProj, nodata));
  }
  return { readToGrid };
}

/**
 * Order scenes so they spread across the season: the clearest scene of each
 * month first, then the next clearest of each month, and so on. A composite
 * built from several dates is far less sensitive to one odd day.
 */
function spreadAcrossSeason(candidates) {
  const byMonth = new Map();
  for (const item of candidates) {               // candidates are clearest first
    const m = String(item.properties.datetime).slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(item);
  }
  const queues = [...byMonth.values()];
  const out = [];
  for (let round = 0; out.length < candidates.length; round++) {
    for (const q of queues) if (q[round]) out.push(q[round]);
  }
  return out;
}

/**
 * Build a cloud-free "greenest" NDVI composite for one year from up to
 * `maxScenes` clear scenes spread across the season.
 * Returns {ndvi, count, scenes: [{id, date, cloud, validFraction}], visual: {r,g,b}|null}.
 */
async function yearComposite({ fetchFn, reader, grid, year, season, maxScenes = 5, minValid = 0.5, onStatus = () => {} }) {
  onStatus(`Searching ${year} images…`);
  const candidates = spreadAcrossSeason(await searchScenes(fetchFn, grid, year, season));
  if (!candidates.length) throw new Error(`No ${year} images with little cloud were found for this area.`);
  const chosen = [];
  for (const item of candidates.slice(0, 12)) {
    if (chosen.length >= maxScenes) break;
    const date = item.properties.datetime.slice(0, 10);
    onStatus(`${year}: checking clouds on ${date}…`);
    const epsg = epsgOf(item);
    let scl;
    try {
      [scl] = await reader.readToGrid(item.assets.scl.href, grid, epsg);
    } catch (e) {
      continue;
    }
    const vf = C.validFraction(scl);
    if (vf < minValid) continue;
    chosen.push({ item, epsg, scl, validFraction: vf, date });
  }
  if (!chosen.length) throw new Error(`Every ${year} image found was too cloudy over this area. Try the growing season or another year.`);

  const layers = [];
  for (const c of chosen) {
    onStatus(`${year}: reading ${c.date}…`);
    const [[red], [nir]] = await Promise.all([
      reader.readToGrid(c.item.assets.red.href, grid, c.epsg),
      reader.readToGrid(c.item.assets.nir.href, grid, c.epsg),
    ]);
    const { scale, offset } = C.scaling(c.item, 'red');
    layers.push(C.sceneNdvi(red, nir, c.scl, { scale, offset, width: grid.width }).ndvi);
  }
  const comp = C.greenestComposite(layers);

  let visual = null;
  const best = chosen.reduce((a, b) => (b.validFraction > a.validFraction ? b : a));
  if (best.item.assets.visual) {
    try {
      onStatus(`${year}: reading true colour…`);
      const [r, g, b] = await reader.readToGrid(best.item.assets.visual.href, grid, best.epsg, { samples: [0, 1, 2], nodata: -1 });
      visual = { r, g, b, date: best.date };
    } catch (e) { /* optional */ }
  }
  return {
    ndvi: comp.value, count: comp.count, visual,
    scenes: chosen.map((c) => ({ id: c.item.id, date: c.date, cloud: c.item.properties['eo:cloud_cover'], validFraction: c.validFraction })),
  };
}

globalThis.GCImagery = { EARTH_SEARCH, SEASONS, searchScenes, spreadAcrossSeason, createReader, yearComposite, epsgOf };
})();
