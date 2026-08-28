#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { migrateCourseV3 } from '../src/course/CourseProject.js';
import { atomicJsonCheckpoint } from './lib/atomic-json.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const input = resolve(root, process.argv[2] || 'course.json');
const output = resolve(root, process.argv[3] || 'course.project.json');
const raw = JSON.parse(await readFile(input, 'utf8'));
const project = migrateCourseV3(raw);
await atomicJsonCheckpoint(output, project);
process.stdout.write(`Migrated schema v3 course to ${output}\n`);
