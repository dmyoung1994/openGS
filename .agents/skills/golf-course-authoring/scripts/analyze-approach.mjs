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
  return index >= 0 ? args[index + 1] : fallback;
};
if (!coursePath) {
  console.error(
    "Usage: node scripts/analyze-approach.mjs <course.golfcourse> [--topology connected|island] [--strict]",
  );
  process.exit(2);
}
const topology = option("--topology", "connected");
if (!new Set(["connected", "island"]).has(topology))
  throw new Error("--topology must be connected or island");

const archive = unzipSync(new Uint8Array(readFileSync(resolve(coursePath))));
const manifest = JSON.parse(strFromU8(archive["course.json"]));
const surface = archive["surfaces.u8"], water = archive["water.u8"];
if (!manifest || !surface)
  throw new Error("Incomplete .golfcourse archive");
const width = manifest.surfaceWidth,
  height = manifest.surfaceHeight,
  spacingX = manifest.widthM / (width - 1),
  spacingN = manifest.depthM / (height - 1),
  indexAt = (east, north) => {
    const col = Math.max(0, Math.min(width - 1, Math.round(((east + manifest.widthM / 2) / manifest.widthM) * (width - 1))));
    const row = Math.max(0, Math.min(height - 1, Math.round(((manifest.depthM / 2 - north) / manifest.depthM) * (height - 1))));
    return row * width + col;
  },
  maintained = (id) => id === 1 || id === 2 || id === 3,
  green = new Uint8Array(surface.length),
  boundary = [];
for (let index = 0; index < surface.length; index++) green[index] = surface[index] === 1 ? 1 : 0;
for (let row = 0; row < height; row++)
  for (let col = 0; col < width; col++) {
    const index = row * width + col;
    if (!green[index]) continue;
    if (
      row === 0 || row === height - 1 || col === 0 || col === width - 1 ||
      !green[index - width] || !green[index + width] || !green[index - 1] || !green[index + 1]
    ) boundary.push([row, col]);
  }

const ring = new Uint8Array(surface.length),
  ringRadiusM = 6,
  rowRadius = Math.ceil(ringRadiusM / spacingN),
  colRadius = Math.ceil(ringRadiusM / spacingX);
let openEntryWidthM = 0, nearestFairwayGapM = Infinity;
for (const [row, col] of boundary) {
  for (const [dr, dc, edgeM] of [[-1, 0, spacingX], [1, 0, spacingX], [0, -1, spacingN], [0, 1, spacingN]]) {
    const rr = row + dr, cc = col + dc;
    if (rr >= 0 && rr < height && cc >= 0 && cc < width && [2, 3].includes(surface[rr * width + cc])) openEntryWidthM += edgeM;
  }
  for (let dr = -rowRadius; dr <= rowRadius; dr++)
    for (let dc = -colRadius; dc <= colRadius; dc++) {
      const rr = row + dr, cc = col + dc, distance = Math.hypot(dr * spacingN, dc * spacingX);
      if (distance <= ringRadiusM && rr >= 0 && rr < height && cc >= 0 && cc < width) {
        const index = rr * width + cc;
        if (!green[index]) ring[index] = 1;
        if (surface[index] === 2) nearestFairwayGapM = Math.min(nearestFairwayGapM, distance);
      }
    }
}

const ringCounts = { fairway: 0, rough: 0, bunker: 0, native: 0, water: 0, other: 0 };
for (let index = 0; index < ring.length; index++) {
  if (!ring[index]) continue;
  if (water?.[index] || surface[index] === 8) ringCounts.water++;
  else if (surface[index] === 2) ringCounts.fairway++;
  else if (surface[index] === 3) ringCounts.rough++;
  else if (surface[index] === 4) ringCounts.bunker++;
  else if (surface[index] === 5) ringCounts.native++;
  else ringCounts.other++;
}
const ringTotal = Object.values(ringCounts).reduce((sum, value) => sum + value, 0),
  nativeFraction = ringTotal ? ringCounts.native / ringTotal : 0,
  waterFraction = ringTotal ? ringCounts.water / ringTotal : 0,
  recoverySurfaceKinds = Object.entries(ringCounts).filter(([, count]) => count > 0).map(([name]) => name);

const tees = manifest.tees?.length ? manifest.tees : [{ positionM: manifest.teeM }],
  visited = new Uint8Array(surface.length), queue = [];
for (const tee of tees) {
  const seed = indexAt(tee.positionM[0], tee.positionM[1]);
  if (maintained(surface[seed]) && !visited[seed]) { visited[seed] = 1; queue.push(seed); }
}
for (let cursor = 0; cursor < queue.length; cursor++) {
  const index = queue[cursor], row = Math.floor(index / width), col = index % width;
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = row + dr, cc = col + dc;
      if (rr < 0 || rr >= height || cc < 0 || cc >= width) continue;
      const next = rr * width + cc;
      if (!visited[next] && maintained(surface[next])) { visited[next] = 1; queue.push(next); }
    }
}
const connectedToTeeNetwork = boundary.some(([row, col]) => visited[row * width + col]);
const warnings = [];
if (topology === "connected") {
  if (!connectedToTeeNetwork) warnings.push("Green is disconnected from the tee-maintained surface network.");
  if (openEntryWidthM < 12) warnings.push(`Readable maintained entry is ${openEntryWidthM.toFixed(1)} m; target at least 12 m.`);
  if (nearestFairwayGapM > 2) warnings.push(`Nearest fairway is ${Number.isFinite(nearestFairwayGapM) ? nearestFairwayGapM.toFixed(1) : "unavailable"} m from the green; target no more than 2 m.`);
  if (nativeFraction > 0.7) warnings.push(`Native terrain occupies ${(nativeFraction * 100).toFixed(1)}% of the 6 m green ring; review accidental target isolation.`);
} else if (waterFraction < 0.5) {
  warnings.push(`Island topology declared but water occupies only ${(waterFraction * 100).toFixed(1)}% of the 6 m green ring.`);
}
if (recoverySurfaceKinds.length < 2)
  warnings.push("Near-green ring provides fewer than two distinct recovery-surface families.");

console.log(JSON.stringify({
  course: manifest.name,
  topology,
  approach: {
    connectedToTeeNetwork,
    openEntryWidthM: +openEntryWidthM.toFixed(1),
    nearestFairwayGapM: Number.isFinite(nearestFairwayGapM) ? +nearestFairwayGapM.toFixed(1) : null,
    ringRadiusM,
    ringComposition: ringCounts,
    nativeFraction: +nativeFraction.toFixed(3),
    waterFraction: +waterFraction.toFixed(3),
    recoverySurfaceKinds,
  },
  warnings,
  note: "Project heuristics detect accidental isolation; topology and playtesting remain architectural decisions.",
}, null, 2));
if (args.includes("--strict") && warnings.length) process.exit(1);
