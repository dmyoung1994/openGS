import { PlayableCourseScene } from './PlayableCourseScene.js';

// Practice-range composition. Terrain, hazards, vegetation, water, targets, and
// presentation primitives live in PlayableCourseScene; Range only selects the
// legacy single-corridor practice behavior.
export class Range extends PlayableCourseScene {
  constructor(scene, camera, course, options = {}) {
    if (course?.routing) throw new Error('Range accepts only a single-corridor practice course; use CourseScene for routed sites.');
    super(scene, camera, course, { ...options, sceneKind: 'range' });
  }
}
