import { test } from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import * as GeoTIFF from 'geotiff';
import '../js/change.js';
import '../js/imagery.js';

const C = globalThis.GCChange;
const I = globalThis.GCImagery;

// Kingston upon Thames: UTM zone 30N.
const LAT = 51.4091, LON = -0.3049;
const UTM = C.utmCode(32630);
const toUtm = proj4('EPSG:4326', UTM).forward;

test('grid is ~10 m and square', () => {
  const g = C.makeGrid(LAT, LON, 1000);
  assert.equal(g.width, 100);
  assert.equal(g.height, 100);
  const [x0, y0] = toUtm([g.west, g.south]);
  const [x1] = toUtm([g.east, g.south]);
  const [, y1] = toUtm([g.west, g.north]);
  assert.ok(Math.abs(x1 - x0 - 1000) < 15, `width ${x1 - x0}`);
  assert.ok(Math.abs(y1 - y0 - 1000) < 15, `height ${y1 - y0}`);
});

test('window maths for a north-up raster', () => {
  const win = C.windowFor({ minX: 500105, maxX: 500195, minY: 5699805, maxY: 5699895 }, [500000, 5700000], [10, -10], 1000, 1000);
  assert.deepEqual(win, [10, 10, 20, 20]);
  assert.equal(C.windowFor({ minX: 0, maxX: 1, minY: 0, maxY: 1 }, [500000, 5700000], [10, -10], 10, 10), null);
});

test('NDVI with cloud mask and processing-baseline offset', () => {
  const red = [800, 800, 800], nir = [4000, 4000, 4000], scl = [4, 9, 5];
  const { ndvi, validFraction } = C.sceneNdvi(red, nir, scl, { scale: 1e-4, offset: -0.1 });
  // reflectances: red 0.08-0.1 -> clamped 0; nir 0.3 -> NDVI 1
  assert.equal(ndvi[0], 1);
  assert.ok(Number.isNaN(ndvi[1]), 'cloud masked');
  assert.equal(validFraction, 2 / 3);
  const plain = C.sceneNdvi([1000], [3000], [4]).ndvi[0];
  assert.ok(Math.abs(plain - 0.5) < 1e-6);
});

test('median composite ignores missing values', () => {
  const { value, count } = C.medianComposite([
    Float32Array.from([0.2, NaN, 0.9]), Float32Array.from([0.4, NaN, 0.1]), Float32Array.from([0.9, 0.5, NaN]),
  ]);
  assert.ok(Math.abs(value[0] - 0.4) < 1e-6);
  assert.ok(Math.abs(value[1] - 0.5) < 1e-6);
  assert.ok(Math.abs(value[2] - 0.5) < 1e-6);
  assert.deepEqual([...count], [3, 1, 2]);
});

test('classify and find patches', () => {
  const g = C.makeGrid(LAT, LON, 100); // 10 x 10
  const before = new Float32Array(100).fill(0.7);
  const after = new Float32Array(100).fill(0.7);
  for (const i of [11, 12, 21, 22, 23]) after[i] = 0.2; // a 5-cell clearing
  after[88] = 0.2; // single pixel: too small to report
  for (const i of [55, 56, 65, 66, 75]) { before[i] = 0.1; after[i] = 0.6; } // 5-cell gain
  before[99] = NaN;
  const raw = C.classify(before, after);
  assert.equal(raw.cls[11], 2);
  assert.equal(raw.cls[55], 3);
  assert.equal(raw.cls[0], 1);
  assert.equal(raw.cls[99], 0);
  assert.equal(raw.cls[88], 2);
  const cls = C.sieve(g, raw.cls);
  assert.equal(cls[88], 1, 'single pixel sieved out of the totals');
  const loss = C.patches(g, cls, raw.delta, 2);
  assert.equal(loss.length, 1);
  assert.equal(loss[0].pixels, 5);
  assert.equal(loss[0].areaM2, 500);
  assert.ok(loss[0].meanDelta < -0.4);
  const gain = C.patches(g, cls, raw.delta, 3);
  assert.equal(gain.length, 1);
  const s = C.summary(g, cls, before, after);
  assert.ok(Math.abs(s.lossHa - 0.05) < 1e-9, String(s.lossHa));
  assert.ok(Math.abs(s.gainHa - 0.05) < 1e-9);
  const gj = C.patchesToGeoJSON(g, loss);
  assert.equal(gj.features[0].geometry.coordinates.length, 5);
});

test('a dry summer is not loss: green that stays green, only browner, does not count', () => {
  const g = C.makeGrid(LAT, LON, 200); // 20 x 20
  const before = new Float32Array(400).fill(0.78);
  const after = new Float32Array(400).fill(0.48); // grass browned: a 0.30 drop everywhere
  for (let r = 2; r < 6; r++) for (let c = 2; c < 6; c++) after[r * 20 + c] = 0.12; // a real 16-cell clearing
  const cls = C.sieve(g, C.classify(before, after).cls);
  const s = C.summary(g, cls, before, after);
  assert.ok(Math.abs(s.lossHa - 0.16) < 1e-9, `only the clearing counts, got ${s.lossHa} ha`);
  assert.ok(C.greennessShift(before, after) < -0.25, 'the overall browning is reported as a warning instead');
});

test('pixels need two clear readings in each year to change', () => {
  const before = Float32Array.from([0.8, 0.8]);
  const after = Float32Array.from([0.1, 0.1]);
  const { cls } = C.classify(before, after, { minCount: 2, countBefore: Uint8Array.from([3, 1]), countAfter: Uint8Array.from([2, 3]) });
  assert.deepEqual([...cls], [2, 1]);
});

test('greenest composite ignores one hazy or shadowed reading', () => {
  const clear1 = Float32Array.from([0.80, 0.30]);
  const hazy = Float32Array.from([0.35, 0.10]);
  const clear2 = Float32Array.from([0.78, 0.28]);
  const g = C.greenestComposite([clear1, hazy, clear2]);
  assert.ok(Math.abs(g.value[0] - 0.78) < 1e-6); // second highest of three
  assert.ok(Math.abs(g.value[1] - 0.28) < 1e-6);
  const m = C.medianComposite([clear1, hazy, hazy]);
  assert.ok(m.value[0] < 0.4, 'a median of mostly hazy readings would have looked like loss');
});

test('cells next to clouds and shadows are masked', () => {
  const w = 7, n = 49;
  const scl = new Float32Array(n).fill(4);
  scl[24] = 9; // a cloud in the middle
  const red = new Float32Array(n).fill(500), nir = new Float32Array(n).fill(3000);
  const { ndvi } = C.sceneNdvi(red, nir, scl, { width: w, buffer: 2 });
  assert.ok(Number.isNaN(ndvi[24]));
  assert.ok(Number.isNaN(ndvi[24 - 2]) && Number.isNaN(ndvi[24 + 2 * w]), 'two cells around are masked');
  assert.ok(!Number.isNaN(ndvi[0]), 'far cells are kept');
});

test('scaling from STAC raster:bands, falling back on processing baseline', () => {
  assert.deepEqual(C.scaling({ assets: { red: { 'raster:bands': [{ scale: 0.0001, offset: -0.1 }] } } }, 'red'), { scale: 0.0001, offset: -0.1 });
  assert.deepEqual(C.scaling({ assets: { red: {} }, properties: { 's2:processing_baseline': '05.09' } }, 'red'), { scale: 1e-4, offset: -0.1 });
  assert.deepEqual(C.scaling({ assets: { red: {} }, properties: { 's2:processing_baseline': '02.14' } }, 'red'), { scale: 1e-4, offset: 0 });
});

// ---------------------------------------------------------------------------
// End to end with synthetic COGs
// ---------------------------------------------------------------------------
function tiff(width, height, values, ox, oy, res) {
  return GeoTIFF.writeArrayBuffer(values, {
    width, height, ModelPixelScale: [res, res, 0], ModelTiepoint: [0, 0, 0, ox, oy, 0],
    ProjectedCSTypeGeoKey: 32630, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, BitsPerSample: [8], SampleFormat: [1],
  });
}

test('yearComposite + classify finds a cleared patch in synthetic imagery', async () => {
  const grid = C.makeGrid(LAT, LON, 400); // 40 x 40 cells
  const [cx, cy] = toUtm([LON, LAT]);
  const ox = Math.floor(cx - 400), oy = Math.ceil(cy + 400); // 80 x 80 px of 10 m around the centre
  const W = 80;
  const make = (fn) => { const a = new Uint8Array(W * W); for (let r = 0; r < W; r++) for (let c = 0; c < W; c++) a[r * W + c] = fn(r, c); return a; };
  // Reflectance = DN * 0.004. Vegetation: red 0.04, nir 0.40 (NDVI 0.82). Cleared: red 0.16, nir 0.20 (NDVI 0.11).
  const cleared = (r, c) => r >= 36 && r < 44 && c >= 36 && c < 44; // 80 m x 80 m in the middle
  const files = {
    'b/red.tif': tiff(W, W, make(() => 10), ox, oy, 10),
    'b/nir.tif': tiff(W, W, make(() => 100), ox, oy, 10),
    'b/scl.tif': tiff(40, 40, new Uint8Array(1600).fill(4), ox, oy, 20),
    'a/red.tif': tiff(W, W, make((r, c) => (cleared(r, c) ? 40 : 10)), ox, oy, 10),
    'a/nir.tif': tiff(W, W, make((r, c) => (cleared(r, c) ? 50 : 100)), ox, oy, 10),
    'a/scl.tif': tiff(40, 40, new Uint8Array(1600).fill(4), ox, oy, 20),
  };
  const item = (y, dir) => ({
    id: `S2_${y}`, bbox: [-1, 50, 1, 53], properties: { datetime: `${y}-07-01T11:00:00Z`, 'eo:cloud_cover': 1, 'proj:epsg': 32630 },
    assets: {
      red: { href: `mem://${dir}/red.tif`, 'raster:bands': [{ scale: 0.004, offset: 0 }] },
      nir: { href: `mem://${dir}/nir.tif` }, scl: { href: `mem://${dir}/scl.tif` },
    },
  });
  const fetchFn = async (url) => ({
    ok: true, status: 200,
    json: async () => ({ features: [url.includes('2019') ? item(2019, 'b') : item(2024, 'a')] }),
  });
  const GT = { fromUrl: async (href) => GeoTIFF.fromArrayBuffer(files[href.replace('mem://', '')]) };
  const reader = I.createReader({ GeoTIFF: GT, proj4 });
  const before = await I.yearComposite({ fetchFn, reader, grid, year: 2019, season: 'summer' });
  const after = await I.yearComposite({ fetchFn, reader, grid, year: 2024, season: 'summer' });
  assert.equal(before.scenes.length, 1);
  assert.equal(before.scenes[0].validFraction, 1);
  const { cls, delta } = C.classify(before.ndvi, after.ndvi);
  const loss = C.patches(grid, cls, delta, 2);
  assert.equal(loss.length, 1, 'one cleared patch');
  // 8x8 source pixels = 64 cells of 10 m (allow a little for resampling)
  assert.ok(loss[0].pixels >= 49 && loss[0].pixels <= 81, `pixels ${loss[0].pixels}`);
  assert.ok(Math.abs(loss[0].lat - LAT) < 0.0003 && Math.abs(loss[0].lon - LON) < 0.0005, 'patch is at the centre');
  assert.equal(C.patches(grid, cls, delta, 3).length, 0, 'no gain');
});

test('searchScenes keeps covering scenes, one per date, clearest first', async () => {
  const grid = C.makeGrid(LAT, LON, 1000);
  const f = (id, date, cloud, bbox = [-1, 50, 1, 53]) => ({
    id, bbox, properties: { datetime: `${date}T11:00:00Z`, 'eo:cloud_cover': cloud },
    assets: { red: { href: 'r' }, nir: { href: 'n' }, scl: { href: 's' } },
  });
  let url;
  const fetchFn = async (u) => { url = u; return { ok: true, json: async () => ({ features: [
    f('A', '2024-07-01', 20), f('B', '2024-07-01', 5), f('C', '2024-06-10', 2), f('D', '2024-08-01', 1, [0, 50, 1, 53]),
  ] }) }; };
  const list = await I.searchScenes(fetchFn, grid, 2024, 'summer');
  assert.deepEqual(list.map((x) => x.id), ['C', 'B']);
  assert.match(url, /datetime=2024-06-01T00:00:00Z\/2024-08-31T23:59:59Z/);
  assert.match(url, /collections=sentinel-2-l2a/);
});
