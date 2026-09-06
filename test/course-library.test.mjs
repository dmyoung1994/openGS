import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readCourseLibrary } from '../scripts/lib/course-library.mjs';
import { savedCoursePath } from '../src/course/CourseLibrary.js';

test('Play discovers the current course and saved runtime courses with stable URLs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'course-library-'));
  try {
    await mkdir(path.join(root, 'public/courses'), { recursive: true });
    await writeFile(path.join(root, 'course.json'), JSON.stringify({ meta: { name: 'Current design' }, routing: { holes: [{}, {}, {}] } }));
    await writeFile(path.join(root, 'public/courses/meadow.json'), JSON.stringify({ meta: { name: 'Meadow' } }));
    await writeFile(path.join(root, 'public/courses/index.json'), '[]');
    const list = await readCourseLibrary(root);
    assert.deepEqual(list, [
      { id: 'current', url: '/course.json', name: 'Current design', holes: 3 },
      { id: 'meadow', url: '/courses/meadow.json', name: 'Meadow', holes: 1 },
    ]);
    assert.equal(savedCoursePath(list, 'meadow'), '/courses/meadow.json');
    assert.throws(() => savedCoursePath(list, '../private'), /not found/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
