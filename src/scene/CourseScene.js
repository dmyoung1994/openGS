import { PlayableCourseScene } from './PlayableCourseScene.js';

// Routed-course composition. The compiled schema-v4 site supplies every hole and
// transition to the same reusable primitives used by Range; this class owns only
// multi-hole lifecycle and rejects non-routed data.
export class CourseScene extends PlayableCourseScene {
  constructor(scene, camera, course, options = {}) {
    if (!course?.routing && options.allowNonRouted !== true) {
      throw new Error('CourseScene requires a compiled shared-site routing contract.');
    }
    super(scene, camera, course, { ...options, sceneKind: options.sceneKind ?? 'course' });
  }

  setActiveHole(holeId) {
    if (!this.routing) throw new Error('Hole selection requires a routed course.');
    const hole = this.routingHoles.find((entry) => entry.holeId === holeId);
    if (!hole) throw new Error(`Unknown routed hole "${holeId}".`);
    this.activeHoleId = holeId;
    this.tee = hole.tees[0];
    return hole;
  }
}
