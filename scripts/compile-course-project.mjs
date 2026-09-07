import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compileActiveCourse } from '../src/course/CourseProject.js';

const root = process.cwd();
const projectPath = resolve(root, process.argv[2] || 'course.project.json');
const runtimePath = resolve(root, process.argv[3] || 'course.json');
const temporaryPath = `${runtimePath}.tmp`;

const project = JSON.parse(await readFile(projectPath, 'utf8'));
const { hole, runtime, normalized } = compileActiveCourse(project);
await writeFile(temporaryPath, `${JSON.stringify(runtime, null, 2)}\n`, 'utf8');
await rename(temporaryPath, runtimePath);

const environment = normalized.environment;
console.log(JSON.stringify({
  ok: true,
  activeHoleId: hole.id,
  name: runtime.meta.name,
  par: hole.par,
  yards: hole.greens[0]?.yards ?? null,
  environmentObjects: environment.objectCount,
}, null, 2));
