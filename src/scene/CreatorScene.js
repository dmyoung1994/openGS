import { CourseScene } from './CourseScene.js';

// Course-authoring composition. Creator owns this scene for both its disposable
// green canvas and the routed course under active revision; it never borrows the
// practice Range composition. Rendering primitives remain in PlayableCourseScene.
export class CreatorScene extends CourseScene {
  constructor(scene, camera, course, options = {}) {
    if (!course?.routing && options.creatorCanvas !== true) {
      throw new Error('CreatorScene requires either a creator canvas or a routed course.');
    }
    super(scene, camera, course, {
      ...options,
      allowNonRouted: options.creatorCanvas === true,
      sceneKind: 'creator',
    });
  }
}
