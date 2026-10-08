# Green Change Monitor

**Where were trees and green space lost or gained?** Pick an area and two years, and this maps patches of vegetation loss and gain using free Sentinel-2 satellite imagery. It runs entirely in the browser: no server, no account, no storage.

In England it also flags patches inside **conservation areas** and **tree preservation (TPO) areas**, using planning.data.gov.uk, so planning and enforcement teams can see where to look first.

**Live site:** https://eritrouib.github.io/GreenChangeMonitor/ (once GitHub Pages is enabled)

## How it works

1. **Find images.** For each year, it searches Element 84's free [Earth Search](https://earth-search.aws.element84.com/v1) STAC catalogue for Sentinel-2 Level-2A scenes covering the box in the chosen season, clearest first.
2. **Read only what's needed.** Sentinel-2 is stored as Cloud-Optimised GeoTIFFs on AWS. The browser ([geotiff.js](https://geotiffjs.github.io/)) reads just the tiles under the box: typically 10 to 30 MB in total, about 20 to 60 seconds.
3. **Remove clouds.** Each scene's Scene Classification layer masks clouds, cloud shadows, cirrus and snow. Scenes less than 50% clear over the box are skipped.
4. **Build a cloud-free greenness map per year.** NDVI from red and near-infrared, median of up to three clear scenes. Reflectance scaling follows each scene's metadata (including the 2022 processing-baseline offset).
5. **Compare.** A pixel that was vegetated (NDVI ≥ 0.45) and fell by at least the chosen threshold is **loss**; the reverse is **gain**. Patches under about 300 m² (3 pixels) are ignored.
6. **Context.** Patches are checked against conservation areas and TPO areas from planning.data.gov.uk.

Results can be downloaded as GeoJSON (patch outlines) or CSV.

```
index.html
css/app.css
js/change.js    analysis: grid, NDVI, cloud mask, composite, change, patches (pure, tested)
js/imagery.js   Earth Search STAC search and windowed COG reading
js/app.js       map, analysis box, results
tests/          Node tests, including an end-to-end run on synthetic GeoTIFFs
```

## Limits

- **10 m pixels.** It sees groups of trees, hedgerows, lawns and fields, not single small trees or house extensions.
- **Not everything that looks like loss is loss.** Drought (e.g. summer 2022), mowing, crop rotation, flooding and late leaf-out can all lower greenness. Use the true colour views to check, and choose comparable seasons.
- **A pointer, not evidence.** Confirm on the ground or with aerial photography before acting.
- Planning designations are only shown in England, and only where councils publish them to Planning Data.

## Ideas for next versions

- Environment Agency LiDAR (1 m) to measure canopy height change at individual trees
- Monitor every TPO area in a borough and email a monthly summary (GitHub Actions)
- Building footprint change with higher-resolution aerial imagery where licensed

## Development

```
npm install
npm test
```

Serve the folder (`python -m http.server`) or open `index.html` directly.

## Licence & attribution

Created by **@ET**.

Contains modified Copernicus Sentinel data, processed by ESA, accessed via Element 84 Earth Search on AWS. Planning designations from planning.data.gov.uk (Open Government Licence v3.0). Basemaps © Esri.
