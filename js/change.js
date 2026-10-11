(function () {
'use strict';

// Green Change Monitor: analysis core. Pure functions (no DOM, no network) so
// they can be tested in Node. Exposes globalThis.GCChange.

// Sentinel-2 L2A Scene Classification (SCL) classes we trust for surface readings:
// 4 vegetation, 5 not vegetated, 6 water, 7 unclassified. Everything else
// (no data, saturated, dark/shadow, cloud shadow, clouds, cirrus, snow) is masked.
const SCL_VALID = new Set([4, 5, 6, 7]);
// Clouds and their shadows. Their edges are often missed by SCL and read as
// "less green", so pixels next to them are masked too (see sceneNdvi).
const SCL_CLOUDY = new Set([3, 8, 9, 10]);

const DEFAULTS = {
  vegetated: 0.5, // NDVI at or above this counts as vegetation
  bare: 0.35, // NDVI below this counts as no longer vegetated (bare ground, buildings, water)
  delta: 0.25, // NDVI change needed to count as loss or gain
  minPixels: 5, // smallest patch reported (5 pixels = 500 m², 0.05 ha)
  minCount: 2, // clear readings needed in each year before a pixel can count as changed
  cloudBuffer: 2, // grid cells (10 m) masked around clouds and cloud shadows
};

const M_PER_DEG_LAT = 111320;

/**
 * A regular lat/lon grid of ~`res` metre cells over a square box of `sizeM`
 * metres centred on (lat, lon). Using lat/lon keeps the overlay aligned on a
 * web map, whatever UTM zone the imagery is in.
 */
function makeGrid(lat, lon, sizeM, res = 10) {
  const half = sizeM / 2;
  const dLat = res / M_PER_DEG_LAT;
  const dLon = res / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  const n = Math.round(sizeM / res);
  const south = lat - half / M_PER_DEG_LAT;
  const west = lon - half / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  return {
    width: n, height: n, dLat, dLon, res,
    west, south, east: west + n * dLon, north: south + n * dLat,
    pixelAreaM2: res * res,
  };
}

/** Centre of grid cell (col, row); row 0 is the northern edge. */
function cellCenter(grid, col, row) {
  return { lon: grid.west + (col + 0.5) * grid.dLon, lat: grid.north - (row + 0.5) * grid.dLat };
}

function utmCode(epsg) {
  const e = Number(epsg);
  if (e >= 32601 && e <= 32660) return `+proj=utm +zone=${e - 32600} +datum=WGS84 +units=m +no_defs`;
  if (e >= 32701 && e <= 32760) return `+proj=utm +zone=${e - 32700} +south +datum=WGS84 +units=m +no_defs`;
  throw new Error(`Unsupported projection EPSG:${epsg}`);
}

/** Bounding box of the grid in a projected CRS, padded by `pad` metres. */
function gridBoundsIn(grid, toProj, pad = 30) {
  const pts = [[grid.west, grid.south], [grid.east, grid.south], [grid.east, grid.north], [grid.west, grid.north]]
    .map((p) => toProj(p));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minY: Math.min(...ys) - pad, maxY: Math.max(...ys) + pad };
}

/**
 * Pixel window [x0, y0, x1, y1] of a north-up raster covering projected bounds.
 * origin = [x, y] of the top-left corner; resolution = [xRes, yRes] (yRes negative).
 */
function windowFor(bounds, origin, resolution, width, height) {
  const [ox, oy] = origin;
  const [rx, ry] = resolution;
  const x0 = Math.max(0, Math.floor((bounds.minX - ox) / rx));
  const x1 = Math.min(width, Math.ceil((bounds.maxX - ox) / rx));
  const y0 = Math.max(0, Math.floor((bounds.maxY - oy) / ry));
  const y1 = Math.min(height, Math.ceil((bounds.minY - oy) / ry));
  if (x1 <= x0 || y1 <= y0) return null;
  return [x0, y0, x1, y1];
}

/**
 * Sample a raster window onto the grid (nearest neighbour).
 * win = {data, x0, y0, w, h, origin, resolution}; toProj maps [lon, lat] -> [x, y].
 * Returns a Float32Array of grid size; NaN where outside or nodata.
 */
function sampleToGrid(grid, win, toProj, nodata = 0) {
  const out = new Float32Array(grid.width * grid.height).fill(NaN);
  const [ox, oy] = win.origin;
  const [rx, ry] = win.resolution;
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      const c = cellCenter(grid, col, row);
      const [x, y] = toProj([c.lon, c.lat]);
      const px = Math.floor((x - ox) / rx) - win.x0;
      const py = Math.floor((y - oy) / ry) - win.y0;
      if (px < 0 || py < 0 || px >= win.w || py >= win.h) continue;
      const v = win.data[py * win.w + px];
      if (v === nodata || v == null) continue;
      out[row * grid.width + col] = v;
    }
  }
  return out;
}

/** Mask of cells within `buffer` cells of a cloud or cloud shadow (grid of `width` columns). */
function cloudBufferMask(scl, width, buffer = DEFAULTS.cloudBuffer) {
  const n = scl.length, height = Math.round(n / width);
  const near = new Uint8Array(n);
  if (!buffer || !width) return near;
  for (let i = 0; i < n; i++) {
    if (!SCL_CLOUDY.has(scl[i])) continue;
    const r = Math.floor(i / width), c = i % width;
    for (let rr = Math.max(0, r - buffer); rr <= Math.min(height - 1, r + buffer); rr++) {
      for (let cc = Math.max(0, c - buffer); cc <= Math.min(width - 1, c + buffer); cc++) near[rr * width + cc] = 1;
    }
  }
  return near;
}

/**
 * NDVI for one scene, masked by SCL. Reflectance = DN * scale + offset.
 * With `width` (grid columns), cells next to clouds and cloud shadows are masked too.
 */
function sceneNdvi(red, nir, scl, { scale = 1e-4, offset = 0, width = 0, buffer = DEFAULTS.cloudBuffer } = {}) {
  const n = red.length;
  const out = new Float32Array(n).fill(NaN);
  const near = cloudBufferMask(scl, width, buffer);
  let valid = 0;
  for (let i = 0; i < n; i++) {
    if (!SCL_VALID.has(scl[i]) || near[i]) continue;
    const r = Math.max(0, red[i] * scale + offset);
    const ni = Math.max(0, nir[i] * scale + offset);
    if (Number.isNaN(r) || Number.isNaN(ni) || r + ni <= 0) continue;
    out[i] = (ni - r) / (ni + r);
    valid++;
  }
  return { ndvi: out, validFraction: n ? valid / n : 0 };
}

/** Share of grid cells with a usable (cloud-free) reading in an SCL grid. */
function validFraction(scl) {
  let v = 0;
  for (let i = 0; i < scl.length; i++) if (SCL_VALID.has(scl[i])) v++;
  return scl.length ? v / scl.length : 0;
}

/** Per-pixel median across scenes, ignoring NaN. Returns {value, count}. */
function medianComposite(layers) {
  const n = layers[0].length;
  const value = new Float32Array(n).fill(NaN);
  const count = new Uint8Array(n);
  const buf = [];
  for (let i = 0; i < n; i++) {
    buf.length = 0;
    for (const l of layers) if (!Number.isNaN(l[i])) buf.push(l[i]);
    count[i] = buf.length;
    if (!buf.length) continue;
    buf.sort((a, b) => a - b);
    const m = buf.length >> 1;
    value[i] = buf.length % 2 ? buf[m] : (buf[m - 1] + buf[m]) / 2;
  }
  return { value, count };
}

/**
 * "Greenest" composite: for each pixel, the second-highest clear NDVI of the
 * season (the highest if there are fewer than three readings). Leftover haze,
 * cloud edges and shadows, and grass browning in a dry spell all make a pixel
 * look *less* green, so taking the green end of the season keeps them from
 * showing up as loss. Returns {value, count}.
 */
function greenestComposite(layers) {
  const n = layers[0].length;
  const value = new Float32Array(n).fill(NaN);
  const count = new Uint8Array(n);
  const buf = [];
  for (let i = 0; i < n; i++) {
    buf.length = 0;
    for (const l of layers) if (!Number.isNaN(l[i])) buf.push(l[i]);
    count[i] = buf.length;
    if (!buf.length) continue;
    buf.sort((a, b) => a - b);
    value[i] = buf.length >= 3 ? buf[buf.length - 2] : buf[buf.length - 1];
  }
  return { value, count };
}

/**
 * Classify change between two NDVI composites.
 * Loss: vegetated before, no longer vegetated after, and a big enough drop.
 * Gain: the reverse. A pixel that stays green but a bit less so (thinning,
 * a dry summer, a different date) is not counted as loss.
 * Pixels without `minCount` clear readings in both years can't change
 * (pass counts as opts.countBefore / opts.countAfter).
 * Returns class codes: 0 no data, 1 stable, 2 loss, 3 gain, plus delta per pixel.
 */
function classify(before, after, opts = {}) {
  const { vegetated, bare, delta, minCount, countBefore, countAfter } = { ...DEFAULTS, ...opts };
  const n = before.length;
  const cls = new Uint8Array(n);
  const d = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const b = before[i], a = after[i];
    if (Number.isNaN(b) || Number.isNaN(a)) continue;
    d[i] = a - b;
    const sure = (!countBefore || countBefore[i] >= minCount) && (!countAfter || countAfter[i] >= minCount);
    if (sure && b >= vegetated && a < bare && a - b <= -delta) cls[i] = 2;
    else if (sure && a >= vegetated && b < bare && a - b >= delta) cls[i] = 3;
    else cls[i] = 1;
  }
  return { cls, delta: d };
}

/**
 * Minimum mapping unit: loss/gain pixels in patches smaller than `minPixels`
 * go back to stable, so the headline areas only count changes big enough to report.
 */
function sieve(grid, cls, minPixels = DEFAULTS.minPixels) {
  const out = Uint8Array.from(cls);
  const { width: w, height: h } = grid;
  const seen = new Uint8Array(w * h);
  const stack = [], cells = [];
  for (let start = 0; start < w * h; start++) {
    const t = out[start];
    if (seen[start] || (t !== 2 && t !== 3)) continue;
    cells.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      cells.push(i);
      const r = Math.floor(i / w), c = i % w;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if ((!dr && !dc) || rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        const j = rr * w + cc;
        if (!seen[j] && out[j] === t) { seen[j] = 1; stack.push(j); }
      }
    }
    if (cells.length < minPixels) for (const i of cells) out[i] = 1;
  }
  return out;
}

/**
 * How much greener or browner the whole box is in the second year, measured on
 * pixels that were vegetated before (median NDVI change). A big drop usually means
 * a dry summer or different dates, not real loss.
 */
function greennessShift(before, after, vegetated = DEFAULTS.vegetated) {
  const v = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] >= vegetated && !Number.isNaN(after[i])) v.push(after[i] - before[i]);
  }
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  return v[v.length >> 1];
}

/** Connected patches (8-neighbour) of one class, largest first. */
function patches(grid, cls, delta, target, minPixels = DEFAULTS.minPixels) {
  const { width: w, height: h } = grid;
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || cls[start] !== target) continue;
    const cells = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      cells.push(i);
      const r = Math.floor(i / w), c = i % w;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
          const j = rr * w + cc;
          if (!seen[j] && cls[j] === target) { seen[j] = 1; stack.push(j); }
        }
      }
    }
    if (cells.length < minPixels) continue;
    let sumLat = 0, sumLon = 0, sumD = 0;
    let minR = h, maxR = 0, minC = w, maxC = 0;
    for (const i of cells) {
      const r = Math.floor(i / w), c = i % w;
      const cc = cellCenter(grid, c, r);
      sumLat += cc.lat; sumLon += cc.lon; sumD += delta[i];
      minR = Math.min(minR, r); maxR = Math.max(maxR, r); minC = Math.min(minC, c); maxC = Math.max(maxC, c);
    }
    out.push({
      kind: target === 2 ? 'loss' : 'gain',
      pixels: cells.length,
      areaM2: cells.length * grid.pixelAreaM2,
      lat: sumLat / cells.length, lon: sumLon / cells.length,
      meanDelta: sumD / cells.length,
      bounds: [[grid.north - (maxR + 1) * grid.dLat, grid.west + minC * grid.dLon], [grid.north - minR * grid.dLat, grid.west + (maxC + 1) * grid.dLon]],
      cells,
    });
  }
  return out.sort((a, b) => b.pixels - a.pixels);
}

/** Headline figures. */
function summary(grid, cls, before, after, opts = {}) {
  const { vegetated } = { ...DEFAULTS, ...opts };
  let valid = 0, loss = 0, gain = 0, vegB = 0, vegA = 0;
  for (let i = 0; i < cls.length; i++) {
    if (!cls[i]) continue;
    valid++;
    if (cls[i] === 2) loss++;
    if (cls[i] === 3) gain++;
    if (before[i] >= vegetated) vegB++;
    if (after[i] >= vegetated) vegA++;
  }
  const ha = (px) => (px * grid.pixelAreaM2) / 10000;
  return {
    coverage: valid / cls.length,
    lossHa: ha(loss), gainHa: ha(gain), netHa: ha(gain - loss),
    vegBeforeHa: ha(vegB), vegAfterHa: ha(vegA),
    vegBeforePct: valid ? (100 * vegB) / valid : null, vegAfterPct: valid ? (100 * vegA) / valid : null,
  };
}

/** RGBA pixels for the change overlay. */
function changeImage(grid, cls) {
  const px = new Uint8ClampedArray(grid.width * grid.height * 4);
  for (let i = 0; i < cls.length; i++) {
    const o = i * 4;
    if (cls[i] === 2) { px[o] = 220; px[o + 1] = 38; px[o + 2] = 38; px[o + 3] = 220; } // loss
    else if (cls[i] === 3) { px[o] = 37; px[o + 1] = 106; px[o + 2] = 191; px[o + 3] = 200; } // gain
    else if (cls[i] === 0) { px[o] = 120; px[o + 1] = 120; px[o + 2] = 120; px[o + 3] = 90; } // no data
  }
  return px;
}

/** RGBA pixels from three 8-bit true colour grids. */
function rgbImage(grid, r, g, b) {
  const px = new Uint8ClampedArray(grid.width * grid.height * 4);
  for (let i = 0; i < r.length; i++) {
    const o = i * 4;
    if (Number.isNaN(r[i])) continue;
    px[o] = r[i]; px[o + 1] = g[i]; px[o + 2] = b[i]; px[o + 3] = 255;
  }
  return px;
}

/** GeoJSON of patches as unions of 10 m cells (one MultiPolygon per patch). */
function patchesToGeoJSON(grid, list, extra = () => ({})) {
  return {
    type: 'FeatureCollection',
    features: list.map((p, k) => ({
      type: 'Feature',
      properties: { id: k + 1, kind: p.kind, area_m2: Math.round(p.areaM2), mean_ndvi_change: Number(p.meanDelta.toFixed(3)), ...extra(p) },
      geometry: {
        type: 'MultiPolygon',
        coordinates: p.cells.map((i) => {
          const r = Math.floor(i / grid.width), c = i % grid.width;
          const w = grid.west + c * grid.dLon, e = w + grid.dLon, n = grid.north - r * grid.dLat, s = n - grid.dLat;
          const f = (x) => Number(x.toFixed(7));
          return [[[f(w), f(s)], [f(e), f(s)], [f(e), f(n)], [f(w), f(n)], [f(w), f(s)]]];
        }),
      },
    })),
  };
}

/** Reflectance scale/offset for a STAC asset (handles the 2022 processing baseline change). */
function scaling(item, assetKey) {
  const a = item.assets && item.assets[assetKey];
  const rb = a && a['raster:bands'] && a['raster:bands'][0];
  if (rb && typeof rb.scale === 'number') return { scale: rb.scale, offset: rb.offset || 0 };
  const pb = parseFloat((item.properties && item.properties['s2:processing_baseline']) || '0');
  return { scale: 1e-4, offset: pb >= 4 ? -0.1 : 0 };
}

globalThis.GCChange = {
  SCL_VALID, SCL_CLOUDY, DEFAULTS, makeGrid, cellCenter, utmCode, gridBoundsIn, windowFor, sampleToGrid,
  cloudBufferMask, sceneNdvi, validFraction, medianComposite, greenestComposite, classify, sieve, greennessShift,
  patches, summary, changeImage, rgbImage,
  patchesToGeoJSON, scaling,
};
})();
