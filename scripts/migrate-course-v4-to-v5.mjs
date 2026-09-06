#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compileActiveCourse, migrateCourseProjectV4 } from '../src/course/CourseProject.js';

const projectPath = resolve(process.argv[2] || 'course.project.json');
const runtimePath = resolve(process.argv[3] || 'course.json');
const project = migrateCourseProjectV4(JSON.parse(await readFile(projectPath, 'utf8')));
const { runtime } = compileActiveCourse(project);

for (const [path, value] of [[projectPath, project], [runtimePath, runtime]]) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}
console.log(JSON.stringify({ ok: true, schema: project.meta.schema, definitions: project.site.environment.proceduralTreeDefinitions.length, trees: project.site.environment.proceduralTrees.length }, null, 2));
