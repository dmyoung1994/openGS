#!/usr/bin/env node

// Deterministic Pineglass route sweep built on the repository's canonical
// strict-WebGPU Puppeteer harness. Each pose gets a fresh headful Chrome process
// so a failed launch/backend/readiness/health check fails that sample closed.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const arg = (name, fallback) => {
  const flag = `--${name}`;
  const index = argv.indexOf(flag);
  if (index !== -1) return argv[index + 1];
  const assignment = argv.find((value) => value.startsWith(`${flag}=`));
  return assignment === undefined ? fallback : assignment.slice(flag.length + 1);
};

const POSES = Object.freeze([
  { name: 'h1-tee', holeId: 'pineglass-hole-1', position: [-299.857183, 0, 307.998300], lift: 2.1, look: [-291.196512, 0, 59.167444], lookLift: 1, fov: 48 },
  { name: 'h1-landing', holeId: 'pineglass-hole-1', position: [-291.018957, 0, 132.604277], lift: 4.2, look: [-285.510759, 0, 18.819931], lookLift: 1, fov: 48 },
  { name: 'h1-approach', holeId: 'pineglass-hole-1', position: [-274.457202, 0, -26.722295], lift: 3.2, look: [-272, 0, -74.9], lookLift: 0.4, fov: 48 },
  { name: 'h1-green-back', holeId: 'pineglass-hole-1', position: [-263.074881, 0, -88.840669], lift: 2.7, look: [-272, 0, -74.9], lookLift: 0.35, fov: 42 },
  { name: 'h2-tee', holeId: 'pineglass-hole-2', position: [-220.998800, 0, -119.880024], lift: 2.1, look: [-69.936440, 0, -125.528871], lookLift: 1, fov: 48 },
  { name: 'h2-landing', holeId: 'pineglass-hole-2', position: [-142.358446, 0, -113.850700], lift: 4.2, look: [-62.1, 0, -126], lookLift: 1, fov: 48 },
  { name: 'h2-approach', holeId: 'pineglass-hole-2', position: [-109.773440, 0, -119.126639], lift: 3.2, look: [-62.1, 0, -126], lookLift: 0.4, fov: 48 },
  { name: 'h2-green-back', holeId: 'pineglass-hole-2', position: [-46.706952, 0, -119.912795], lift: 2.7, look: [-62.1, 0, -126], lookLift: 0.35, fov: 42 },
  { name: 'h3-tee', holeId: 'pineglass-hole-3', position: [-92.245089, 0, -57.509575], lift: 2.1, look: [-176.821456, 0, 183.812330], lookLift: 1, fov: 48 },
  { name: 'h3-landing', holeId: 'pineglass-hole-3', position: [-160.329343, 0, 101.882394], lift: 4.2, look: [-190.135529, 0, 245.217500], lookLift: 1, fov: 48 },
  { name: 'h3-layup', holeId: 'pineglass-hole-3', position: [-201.612379, 0, 253.545510], lift: 4.2, look: [-201.114089, 0, 313.098607], lookLift: 1, fov: 48 },
  { name: 'h3-approach', holeId: 'pineglass-hole-3', position: [-214.610118, 0, 371.322986], lift: 3.2, look: [-220.611777, 0, 418.894371], lookLift: 0.4, fov: 48 },
  { name: 'h3-green-back', holeId: 'pineglass-hole-3', position: [-230.867090, 0, 431.887776], lift: 2.7, look: [-220.611777, 0, 418.894371], lookLift: 0.35, fov: 42 },
  { name: 'course-overview', holeId: 'pineglass-hole-1', position: [-160, 0, 155], lift: 540, look: [-175, 0, 175], lookLift: 0, fov: 55 },
]);

const requestedPose = arg('pose', null);
const selected = requestedPose
  ? POSES.filter(({ name }) => name === requestedPose)
  : has('quick')
    ? POSES.filter(({ name }) => ['h1-tee', 'h1-approach', 'h2-tee', 'h3-layup', 'course-overview'].includes(name))
    : POSES;
if (!selected.length) throw new Error(`Unknown course performance pose: ${requestedPose}`);
const outputArg = arg('output', null);
const temporary = outputArg === null;
const outputDir = temporary
  ? await mkdtemp(join(tmpdir(), 'pineglass-course-performance-'))
  : resolve(outputArg);
await mkdir(outputDir, { recursive: true });
const routeBytes = await readFile(resolve('course.json'));
const routeHash = createHash('sha256').update(routeBytes).digest('hex');
const expectedTreeCount = JSON.parse(routeBytes).environment.proceduralTrees.length;
const mode = arg('mode', 'balanced');
if (!['battery', 'balanced', 'quality', 'ultra'].includes(mode)) throw new Error('Invalid fixed quality mode');
const size = arg('size', '1920x1080');
const expectedCourseName = 'Pineglass Forest — Needle Bend';
const requestedFrameTiming = Number(arg('frame-timing', '150'));
const requestedGpuFrames = Number(arg('gpu', '24'));
const near = (a, b, epsilon = 1e-5) => Number.isFinite(a) && Math.abs(a - b) <= epsilon;

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: resolve('.'), env: process.env });
    const deadline = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      reject(new Error(`${command} exceeded the 180 second benchmark deadline`));
    }, 180000);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.on('error', (error) => { clearTimeout(deadline); reject(error); });
    child.on('close', (code) => {
      clearTimeout(deadline);
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

const reports = [];
const motionReports = [];
try {
  for (const pose of selected) {
    const screenshot = join(outputDir, `${pose.name}.png`);
    const qaReport = join(outputDir, `${pose.name}.json`);
    const commandArgs = [
      'scripts/shot.mjs', '--game', '--route=/creator.html', '--authored-course',
      `--hole=${pose.holeId}`,
      `--presentation-mode=${mode}`, `--size=${size}`, '--presentation-scale=1', '--gpu-live',
      `--cam=${pose.position.join(',')}`, `--terrain-lift=${pose.lift}`,
      `--look=${pose.look.join(',')}`, `--look-terrain-lift=${pose.lookLift}`,
      `--fov=${pose.fov}`, `--frames=${arg('frames', '120')}`,
      `--frame-timing=${requestedFrameTiming}`, `--gpu=${requestedGpuFrames}`,
      `--out=${screenshot}`, `--qa-report=${qaReport}`,
    ];
    console.log(`\n[course-performance] ${pose.name}`);
    await run(process.execPath, commandArgs);
    const report = JSON.parse(await readFile(qaReport, 'utf8'));
    const currentRouteHash = createHash('sha256').update(await readFile(resolve('course.json'))).digest('hex');
    const resolvedCamera = report.qa?.semantic?.evaluatorCamera;
    const scene = report.qa?.semantic?.scene;
    const terrainClearance = report.qa?.semantic?.terrainClearance;
    const gpu = report.gpu;
    const frameTiming = report.frameTiming;
    const cpu = report.cpu;
    if (!report.qa?.content?.nonBlank
        || !report.qa?.renderer?.webgpuBackend
        || report.qa?.health?.consoleNetworkErrors?.length
        || report.qa?.semantic?.courseName !== expectedCourseName
        || scene?.sceneKind !== 'creator'
        || scene?.creatorCanvasActive !== false
        || scene?.routed !== true
        || report.qa?.semantic?.activeHoleId !== pose.holeId
        || resolvedCamera?.owned !== true
        || resolvedCamera?.frozen !== true
        || !near(resolvedCamera?.position?.[0], pose.position[0])
        || !near(resolvedCamera?.position?.[2], pose.position[2])
        || !near(terrainClearance?.camera, pose.lift)
        || !near(resolvedCamera?.lookAt?.[0], pose.look[0])
        || !near(resolvedCamera?.lookAt?.[2], pose.look[2])
        || !near(terrainClearance?.lookAt, pose.lookLift)
        || resolvedCamera?.fov !== pose.fov
        || report.qa?.semantic?.treeWorkload?.sourceCount !== expectedTreeCount
        || currentRouteHash !== routeHash
        || gpu?.available !== true
        || gpu?.complete !== true
        || gpu?.unavailablePassCount !== 0
        || gpu?.framesRequested !== requestedGpuFrames
        || gpu?.framesPlanned !== requestedGpuFrames
        || gpu?.framesCaptured !== requestedGpuFrames
        || gpu?.activeGpu?.samples !== requestedGpuFrames
        || !(gpu?.activeGpu?.meanMs > 0)
        || !(gpu?.passes?.length > 0)
        || frameTiming?.samples !== requestedFrameTiming
        || !(frameTiming?.evaluatorFramesPresented >= requestedFrameTiming)
        || !(frameTiming?.meanMs > 0)
        || !(frameTiming?.p50Ms > 0)
        || !(frameTiming?.p95Ms > 0)
        || !(frameTiming?.maxMs > 0)
        || !(cpu?.taskDurationMsPerFrame > 0)
        || !(cpu?.scriptDurationMsPerFrame >= 0)) {
      throw new Error(`${pose.name} failed strict QA: ${JSON.stringify({ qa: report.qa, gpu, frameTiming, cpu })}`);
    }
    reports.push({ name: pose.name, pose, ...report });
  }

  if (has('motion')) {
    const forward = POSES.find(({ name }) => name === 'h1-tee');
    const reverse = POSES.find(({ name }) => name === 'h1-landing');
    for (const [name, from, to] of [
      ['h1-route-forward', forward, reverse],
      ['h1-route-reverse', reverse, forward],
    ]) {
      const motionOut = join(outputDir, `${name}.png`);
      const motionQa = join(outputDir, `${name}.json`);
      await run(process.execPath, [
        'scripts/shot.mjs', '--game', '--route=/creator.html', '--authored-course',
        `--hole=${from.holeId}`, `--presentation-mode=${mode}`, `--size=${size}`, '--presentation-scale=1',
        `--cam=${from.position.join(',')}`, `--terrain-lift=${from.lift}`,
        `--look=${from.look.join(',')}`, `--look-terrain-lift=${from.lookLift}`,
        `--cam-to=${to.position.join(',')}`, `--terrain-lift-to=${to.lift}`,
        `--look-to=${to.look.join(',')}`, `--look-terrain-lift-to=${to.lookLift}`,
        `--fov=${from.fov}`, '--frames=60', `--seq=${arg('motion-frames', '90')}`,
        `--out=${motionOut}`, `--qa-report=${motionQa}`,
      ]);
      const sequence = JSON.parse(await readFile(motionOut.replace(/\.png$/, '-seq/report.json'), 'utf8'));
      const first = sequence.frames?.[0]?.diagnostics;
      const last = sequence.frames?.at(-1)?.diagnostics;
      const currentRouteHash = createHash('sha256').update(await readFile(resolve('course.json'))).digest('hex');
      if (currentRouteHash !== routeHash
          || sequence.health?.consoleNetworkErrors?.length
          || sequence.qa?.courseName !== expectedCourseName
          || sequence.qa?.activeHoleId !== from.holeId
          || sequence.qa?.creatorCanvasActive !== false
          || sequence.qa?.sceneKind !== 'creator'
          || sequence.qa?.routed !== true
          || first?.evaluator?.owned !== true
          || first?.evaluator?.frozen !== true
          || !near(first?.evaluator?.position?.[0], from.position[0])
          || !near(first?.evaluator?.position?.[2], from.position[2])
          || !near(first?.cameraClearance, from.lift)
          || !near(first?.lookAtClearance, from.lookLift)
          || !near(last?.evaluator?.position?.[0], to.position[0])
          || !near(last?.evaluator?.position?.[2], to.position[2])
          || !near(last?.cameraClearance, to.lift)
          || !near(last?.lookAtClearance, to.lookLift)
          || last?.evaluator?.continuousMotionActive !== true) {
        throw new Error(`${name} failed strict motion QA: ${JSON.stringify(sequence)}`);
      }
      motionReports.push({ name, from: from.name, to: to.name, report: sequence });
    }
  }

  const gpuValues = reports.map((report) => report.gpu?.activeGpu?.meanMs).filter(Number.isFinite);
  const p95Values = reports.map((report) => report.gpu?.completionP95Ms).filter(Number.isFinite);
  const summary = {
    capturedAt: new Date().toISOString(),
    contract: {
      route: '/creator.html',
      scene: 'authored-course',
      renderer: 'strict-webgpu',
      mode: 'balanced',
      renderScale: 1,
      terrainRelative: true,
      productionFrames: true,
      routeSha256: routeHash,
    },
    poseCount: reports.length,
    activeGpuMsPerFrame: {
      mean: gpuValues.reduce((sum, value) => sum + value, 0) / gpuValues.length,
      worstObserved: Math.max(...gpuValues),
    },
    completionP95Ms: {
      mean: p95Values.reduce((sum, value) => sum + value, 0) / p95Values.length,
      worstObserved: Math.max(...p95Values),
    },
    poses: reports,
    motions: motionReports,
  };
  await writeFile(join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n[course-performance] summary ${join(outputDir, 'summary.json')}`);
} finally {
  if (temporary && has('cleanup')) await rm(outputDir, { recursive: true, force: true });
}
