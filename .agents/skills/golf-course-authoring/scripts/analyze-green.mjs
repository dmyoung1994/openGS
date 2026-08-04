#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const { strFromU8, unzipSync } = await import(
  pathToFileURL(resolve(repoRoot, "apps/web/node_modules/fflate/esm/index.mjs"))
    .href
);
const args = process.argv.slice(2);
const coursePath = args.find((arg) => !arg.startsWith("--"));
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
if (!coursePath) {
  console.error(
    "Usage: node scripts/analyze-green.mjs <course.golfcourse> [--speed 10.5] [--edge-clearance 4.5] [--site-spacing 9] [--strict]",
  );
  process.exit(2);
}

const speedFt = option("--speed", 10.5),
  edgeClearanceM = option("--edge-clearance", 4.5),
  siteSpacingM = option("--site-spacing", 9);
const pinSlopeLimit =
  speedFt <= 9 ? 3.25 : speedFt <= 10 ? 3 : speedFt <= 11 ? 2.75 : 2.5;
const archive = unzipSync(new Uint8Array(readFileSync(resolve(coursePath))));
const manifest = JSON.parse(strFromU8(archive["course.json"]));
const heightBytes = archive["heights.f32"],
  surface = archive["surfaces.u8"];
if (!manifest || !heightBytes || !surface)
  throw new Error("Incomplete .golfcourse archive");
const heights = new Float32Array(
  heightBytes.buffer.slice(
    heightBytes.byteOffset,
    heightBytes.byteOffset + heightBytes.byteLength,
  ),
);
const spacingX = manifest.widthM / (manifest.heightWidth - 1),
  spacingZ = manifest.depthM / (manifest.heightHeight - 1);
const surfaceSpacingX = manifest.widthM / (manifest.surfaceWidth - 1),
  surfaceSpacingZ = manifest.depthM / (manifest.surfaceHeight - 1);
const surfaceAtHeightCell = (row, col) => {
  const surfaceCol = Math.round(
    (col / (manifest.heightWidth - 1)) * (manifest.surfaceWidth - 1),
  );
  const surfaceRow = Math.round(
    (row / (manifest.heightHeight - 1)) * (manifest.surfaceHeight - 1),
  );
  return surface[surfaceRow * manifest.surfaceWidth + surfaceCol];
};
const green = new Uint8Array(manifest.heightWidth * manifest.heightHeight);
for (let row = 0; row < manifest.heightHeight; row++)
  for (let col = 0; col < manifest.heightWidth; col++)
    green[row * manifest.heightWidth + col] =
      surfaceAtHeightCell(row, col) === 1 ? 1 : 0;
const heightAt = (row, col) => heights[row * manifest.heightWidth + col];
const slopeAt = (row, col) =>
  Math.hypot(
    (heightAt(row, col + 1) - heightAt(row, col - 1)) / (2 * spacingX),
    (heightAt(row - 1, col) - heightAt(row + 1, col)) / (2 * spacingZ),
  ) * 100;
const hasClearance = (row, col) => {
  const rowRadius = Math.ceil(edgeClearanceM / spacingZ),
    colRadius = Math.ceil(edgeClearanceM / spacingX);
  for (let dr = -rowRadius; dr <= rowRadius; dr++)
    for (let dc = -colRadius; dc <= colRadius; dc++) {
      if (Math.hypot(dc * spacingX, dr * spacingZ) > edgeClearanceM) continue;
      const checkRow = row + dr,
        checkCol = col + dc;
      if (
        checkRow < 0 ||
        checkRow >= manifest.heightHeight ||
        checkCol < 0 ||
        checkCol >= manifest.heightWidth ||
        !green[checkRow * manifest.heightWidth + checkCol]
      )
        return false;
    }
  return true;
};
const cells = [],
  pinCandidates = [],
  potentialSinks = [];
for (let row = 1; row < manifest.heightHeight - 1; row++)
  for (let col = 1; col < manifest.heightWidth - 1; col++) {
    if (!green[row * manifest.heightWidth + col]) continue;
    const slopePercent = slopeAt(row, col),
      x = -manifest.widthM / 2 + col * spacingX,
      north = manifest.depthM / 2 - row * spacingZ;
    cells.push({
      row,
      col,
      x,
      north,
      slopePercent,
      elevationM: heightAt(row, col),
    });
    if (slopePercent <= pinSlopeLimit && hasClearance(row, col))
      pinCandidates.push({ x, north, slopePercent });
    let closedLow = true;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++)
        if (
          (dr || dc) &&
          (!green[(row + dr) * manifest.heightWidth + col + dc] ||
            heightAt(row + dr, col + dc) <= heightAt(row, col) + 0.01)
        )
          closedLow = false;
    if (closedLow)
      potentialSinks.push({ x, north, elevationM: heightAt(row, col) });
  }
pinCandidates.sort((a, b) => a.slopePercent - b.slopePercent);
const pinSites = [];
for (const candidate of pinCandidates)
  if (
    pinSites.every(
      (site) =>
        Math.hypot(site.x - candidate.x, site.north - candidate.north) >=
        siteSpacingM,
    )
  )
    pinSites.push(candidate);
const slopes = cells.map((cell) => cell.slopePercent).sort((a, b) => a - b);
const elevations = cells.map((cell) => cell.elevationM);
const quantile = (values, fraction) =>
  values.length ? values[Math.floor((values.length - 1) * fraction)] : null;
const cupCol = Math.max(
  1,
  Math.min(
    manifest.heightWidth - 2,
    Math.round((manifest.cupM[0] + manifest.widthM / 2) / spacingX),
  ),
);
const cupRow = Math.max(
  1,
  Math.min(
    manifest.heightHeight - 2,
    Math.round((manifest.depthM / 2 - manifest.cupM[1]) / spacingZ),
  ),
);
let greenSurfaceCells = 0;
for (const value of surface) if (value === 1) greenSurfaceCells++;
const greenAreaM2 = greenSurfaceCells * surfaceSpacingX * surfaceSpacingZ;
const greenSurfacePoints = [];
let rasterPerimeterM = 0;
for (let row = 0; row < manifest.surfaceHeight; row++)
  for (let col = 0; col < manifest.surfaceWidth; col++) {
    if (surface[row * manifest.surfaceWidth + col] !== 1) continue;
    greenSurfacePoints.push({
      x: -manifest.widthM / 2 + col * surfaceSpacingX,
      north: manifest.depthM / 2 - row * surfaceSpacingZ,
    });
    if (row === 0 || surface[(row - 1) * manifest.surfaceWidth + col] !== 1)
      rasterPerimeterM += surfaceSpacingX;
    if (
      row === manifest.surfaceHeight - 1 ||
      surface[(row + 1) * manifest.surfaceWidth + col] !== 1
    )
      rasterPerimeterM += surfaceSpacingX;
    if (col === 0 || surface[row * manifest.surfaceWidth + col - 1] !== 1)
      rasterPerimeterM += surfaceSpacingZ;
    if (
      col === manifest.surfaceWidth - 1 ||
      surface[row * manifest.surfaceWidth + col + 1] !== 1
    )
      rasterPerimeterM += surfaceSpacingZ;
  }
const centroid = greenSurfacePoints.reduce(
  (sum, point) => ({ x: sum.x + point.x, north: sum.north + point.north }),
  { x: 0, north: 0 },
);
if (greenSurfacePoints.length) {
  centroid.x /= greenSurfacePoints.length;
  centroid.north /= greenSurfacePoints.length;
}
const covariance = greenSurfacePoints.reduce(
  (sum, point) => {
    const dx = point.x - centroid.x,
      dn = point.north - centroid.north;
    sum.xx += dx * dx;
    sum.nn += dn * dn;
    sum.xn += dx * dn;
    return sum;
  },
  { xx: 0, nn: 0, xn: 0 },
);
if (greenSurfacePoints.length) {
  covariance.xx /= greenSurfacePoints.length;
  covariance.nn /= greenSurfacePoints.length;
  covariance.xn /= greenSurfacePoints.length;
}
const covarianceTrace = covariance.xx + covariance.nn;
const covarianceRoot = Math.sqrt(
  Math.max(0, ((covariance.xx - covariance.nn) / 2) ** 2 + covariance.xn ** 2),
);
const majorVariance = covarianceTrace / 2 + covarianceRoot,
  minorVariance = covarianceTrace / 2 - covarianceRoot;
const silhouetteAspectRatio =
  minorVariance > 0 ? Math.sqrt(majorVariance / minorVariance) : null;
const rasterCompactness =
  rasterPerimeterM > 0
    ? (4 * Math.PI * greenAreaM2) / rasterPerimeterM ** 2
    : null;
const pinableAreaM2 = pinCandidates.length * spacingX * spacingZ;
const pinableFraction = greenAreaM2
  ? Math.min(1, pinableAreaM2 / greenAreaM2)
  : 0;
const warnings = [];
const cupSlopePercent = slopeAt(cupRow, cupCol);
if (surfaceAtHeightCell(cupRow, cupCol) !== 1)
  warnings.push("Cup is not on the green surface mask.");
if (cupSlopePercent > pinSlopeLimit)
  warnings.push(
    `Cup slope ${cupSlopePercent.toFixed(2)}% exceeds the ${pinSlopeLimit.toFixed(2)}% project heuristic for ${speedFt} ft speed.`,
  );
if (pinableFraction < 0.3)
  warnings.push(
    `Estimated pinable fraction ${(pinableFraction * 100).toFixed(1)}% is below the 30% project warning threshold.`,
  );
if (pinSites.length < 4)
  warnings.push(
    `Only ${pinSites.length} separated pin sites were found; target at least four.`,
  );
if ((silhouetteAspectRatio ?? Infinity) < 1.12)
  warnings.push(
    "Green has a near-radial footprint; confirm that symmetry is a recorded strategic choice rather than a generic default.",
  );
if (
  elevations.length &&
  Math.max(...elevations) - Math.min(...elevations) < 0.45 &&
  (quantile(slopes, 0.9) ?? Infinity) < 1.75
)
  warnings.push(
    "Green has very little macro relief and no legible primary contour; review the ridge, shelf, crown, or feeder concept from the approach view.",
  );
if ((quantile(slopes, 0.95) ?? 0) > 12)
  warnings.push(
    "More than 5% of the sampled green surface exceeds 12% slope; confirm these cells are intentional transitions rather than cup regions.",
  );
if (potentialSinks.length)
  warnings.push(
    `${potentialSinks.length} potential closed surface low point(s) require drainage review.`,
  );
const report = {
  course: manifest.name,
  targetSpeedFt: speedFt,
  heuristics: {
    pinSlopeLimitPercent: pinSlopeLimit,
    edgeClearanceM,
    siteSpacingM,
  },
  green: {
    areaM2: +greenAreaM2.toFixed(1),
    elevationReliefM: elevations.length
      ? +(Math.max(...elevations) - Math.min(...elevations)).toFixed(2)
      : null,
    silhouette: {
      aspectRatio:
        silhouetteAspectRatio === null
          ? null
          : +silhouetteAspectRatio.toFixed(2),
      rasterCompactness:
        rasterCompactness === null ? null : +rasterCompactness.toFixed(3),
    },
    slopePercent: {
      median: quantile(slopes, 0.5),
      p90: quantile(slopes, 0.9),
      p95: quantile(slopes, 0.95),
      maximum: quantile(slopes, 1),
    },
    pinableAreaM2: +pinableAreaM2.toFixed(1),
    pinableFraction: +pinableFraction.toFixed(3),
    estimatedSeparatedPinSites: pinSites.length,
    cupSlopePercent: +cupSlopePercent.toFixed(2),
    potentialSurfaceSinks: potentialSinks,
  },
  warnings,
  note: "Project heuristics support design review; they are not USGA rules or substitutes for playtesting.",
};
console.log(JSON.stringify(report, null, 2));
if (args.includes("--strict") && warnings.length) process.exit(1);
