#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const { strFromU8, unzipSync } = await import(
  pathToFileURL(resolve(repoRoot, "apps/web/node_modules/fflate/esm/index.mjs")).href
);
const coursePath = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
if (!coursePath) {
  console.error("Usage: node scripts/analyze-bunkers.mjs <course.golfcourse> [--strict]");
  process.exit(2);
}

const archive = unzipSync(new Uint8Array(readFileSync(resolve(coursePath))));
const manifest = JSON.parse(strFromU8(archive["course.json"]));
const surfaces = archive["surfaces.u8"];
const water = archive["water.u8"];
if (!manifest || !surfaces || !water) throw new Error("Incomplete .golfcourse archive");

const sampleSpline = (controlPoints, samples = 12) => {
  const points = [], count = controlPoints.length;
  for (let index = 0; index < count; index++) {
    const p0 = controlPoints[(index - 1 + count) % count], p1 = controlPoints[index], p2 = controlPoints[(index + 1) % count], p3 = controlPoints[(index + 2) % count];
    for (let sample = 0; sample < samples; sample++) {
      const t = sample / samples, t2 = t * t, t3 = t2 * t;
      points.push([
        .5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        .5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  points.push(points[0]);
  return points;
};
const inside = (x, north, polygon) => {
  let result = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index], b = polygon[previous];
    if ((a[1] > north) !== (b[1] > north) && x < (b[0] - a[0]) * (north - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
};
const cellAt = (x, north) => {
  const col = Math.max(0, Math.min(manifest.surfaceWidth - 1, Math.round((x + manifest.widthM / 2) / manifest.widthM * (manifest.surfaceWidth - 1))));
  const row = Math.max(0, Math.min(manifest.surfaceHeight - 1, Math.round((manifest.depthM / 2 - north) / manifest.depthM * (manifest.surfaceHeight - 1))));
  const index = row * manifest.surfaceWidth + col;
  return { surface: surfaces[index], wet: Boolean(water[index]) };
};

const warnings = [], reports = [];
const bunkers = (manifest.features ?? []).filter((feature) => feature.kind === "carvedBunker");
const signatures = new Set();
for (const bunker of bunkers) {
  const spline = sampleSpline(bunker.controlPointsM, bunker.splineSamplesPerSegment);
  const xs = spline.map((point) => point[0]), norths = spline.map((point) => point[1]);
  const minX = Math.floor(Math.min(...xs)), maxX = Math.ceil(Math.max(...xs));
  const minNorth = Math.floor(Math.min(...norths)), maxNorth = Math.ceil(Math.max(...norths));
  let interiorSamples = 0, maskDisagreements = 0, wetSamples = 0;
  for (let north = minNorth; north <= maxNorth; north++) for (let x = minX; x <= maxX; x++) {
    if (!inside(x, north, spline)) continue;
    interiorSamples++;
    const cell = cellAt(x, north);
    if (cell.surface !== 4) maskDisagreements++;
    if (cell.wet) wetSamples++;
  }
  const areaM2 = Math.abs(spline.slice(0, -1).reduce((sum, point, index) => {
    const next = spline[index + 1];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
  const signature = bunker.controlPointsM.map(([x, north]) => `${Math.round((x - minX) * 2)},${Math.round((north - minNorth) * 2)}`).join(";");
  if (signatures.has(signature)) warnings.push(`${bunker.id}: repeats another bunker outline.`);
  signatures.add(signature);
  if (maskDisagreements) warnings.push(`${bunker.id}: ${maskDisagreements} interior samples disagree with bunker physics.`);
  if (wetSamples) warnings.push(`${bunker.id}: ${wetSamples} interior samples overlap water.`);
  if (bunker.depthM < .25 || bunker.depthM > 2.5) warnings.push(`${bunker.id}: depth ${bunker.depthM} m is outside the construction default range.`);
  if (bunker.edgeSoftnessM < 1.5 || bunker.edgeSoftnessM > 12) warnings.push(`${bunker.id}: transition ${bunker.edgeSoftnessM} m is outside the construction default range.`);
  if (bunker.lipHeightM > .6) warnings.push(`${bunker.id}: lip ${bunker.lipHeightM} m is too severe.`);
  if (bunker.floorSlopePercent <= 0 || bunker.floorSlopePercent > 3) warnings.push(`${bunker.id}: floor drainage ${bunker.floorSlopePercent}% needs review.`);
  reports.push({ id: bunker.id, areaM2: +areaM2.toFixed(1), interiorSamples, maskDisagreements, wetSamples, depthM: bunker.depthM, transitionM: bunker.edgeSoftnessM, lipHeightM: bunker.lipHeightM, floorSlopePercent: bunker.floorSlopePercent });
}
if (!bunkers.length) warnings.push("Course has no carved bunker features.");
console.log(JSON.stringify({ course: manifest.name, bunkers: reports, warnings, note: "Geometry checks support architectural review; camera visibility and recovery play still require playtesting." }, null, 2));
if (process.argv.includes("--strict") && warnings.length) process.exit(1);
