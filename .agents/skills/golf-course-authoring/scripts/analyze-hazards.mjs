#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)), repoRoot = resolve(here, "../../../..");
const { strFromU8, unzipSync } = await import(pathToFileURL(resolve(repoRoot, "apps/web/node_modules/fflate/esm/index.mjs")).href);
const coursePath = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!coursePath) { console.error("Usage: node scripts/analyze-hazards.mjs <course.golfcourse> [--strict]"); process.exit(2); }
const archive = unzipSync(new Uint8Array(readFileSync(resolve(coursePath)))), manifest = JSON.parse(strFromU8(archive["course.json"])), surfaces = archive["surfaces.u8"], water = archive["water.u8"];
if (!manifest || !surfaces || !water) throw new Error("Incomplete .golfcourse archive");
const hazards = (manifest.features ?? []).filter((feature) => feature.kind === "waterHazard"), warnings = [], reports = [];
const surfaceAt = (x, north) => { const col = Math.max(0, Math.min(manifest.surfaceWidth - 1, Math.round((x + manifest.widthM / 2) / manifest.widthM * (manifest.surfaceWidth - 1)))), row = Math.max(0, Math.min(manifest.surfaceHeight - 1, Math.round((manifest.depthM / 2 - north) / manifest.depthM * (manifest.surfaceHeight - 1)))); return { surface: surfaces[row * manifest.surfaceWidth + col], wet: water[row * manifest.surfaceWidth + col] }; };
for (const hazard of hazards) {
  const center = hazard.controlPointsM.reduce((sum, point) => [sum[0] + point[0] / hazard.controlPointsM.length, sum[1] + point[1] / hazard.controlPointsM.length], [0, 0]);
  let disagreement = 0; for (const point of hazard.controlPointsM) { const sample = surfaceAt(point[0] * .94 + center[0] * .06, point[1] * .94 + center[1] * .06); if (!sample.wet || sample.surface !== 8) disagreement++; }
  if (disagreement) warnings.push(`${hazard.id}: ${disagreement} shoreline controls disagree with the water physics mask.`);
  const carries = (manifest.tees ?? [{ id: "default", label: "Default", playerClass: "tour", positionM: manifest.teeM }]).map((tee) => {
    const dx = manifest.cupM[0] - tee.positionM[0], dz = manifest.cupM[1] - tee.positionM[1], length = Math.hypot(dx, dz), fx = dx / length, fz = dz / length, lx = -fz, lz = fx;
    const projected = hazard.controlPointsM.map(([x, north]) => ({ down: (x - tee.positionM[0]) * fx + (north - tee.positionM[1]) * fz, side: (x - tee.positionM[0]) * lx + (north - tee.positionM[1]) * lz }));
    const front = Math.min(...projected.map((point) => point.down)), clear = Math.max(...projected.map((point) => point.down)), mid = (front + clear) * .5;
    let widestDryM = 0, run = 0; for (let side = -120; side <= 120; side += 2) { const sample = surfaceAt(tee.positionM[0] + fx * mid + lx * side, tee.positionM[1] + fz * mid + lz * side); if (sample.wet) run = 0; else { run += 2; widestDryM = Math.max(widestDryM, run); } }
    if (widestDryM < (tee.playerClass === "casual" ? 35 : tee.playerClass === "skilled" ? 28 : 24)) warnings.push(`${hazard.id}: ${tee.label} dry bailout is only ${widestDryM.toFixed(0)} m.`);
    return { tee: tee.label, playerClass: tee.playerClass, carryToFrontM: +front.toFixed(1), carryToClearM: +clear.toFixed(1), widestDryCorridorM: widestDryM };
  });
  reports.push({ id: hazard.id, penaltyRule: hazard.penaltyRule, shoreline: hazard.shoreline, waterElevationM: hazard.waterElevationM, carries, maskDisagreementControls: disagreement });
}
if (!hazards.length) warnings.push("Course has no vector water-hazard features.");
console.log(JSON.stringify({ course: manifest.name, hazards: reports, warnings, note: "Carries are plan-view geometry checks; authoritative shot traces remain required." }, null, 2));
if (process.argv.includes("--strict") && warnings.length) process.exit(1);
