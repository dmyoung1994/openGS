import { CourseScene } from './CourseScene.js';

// Player-facing routed-course composition. It shares authored course primitives
// and multi-hole lifecycle with CourseScene while keeping page/runtime ownership
// distinct from the editor.
export class PlayScene extends CourseScene {
  constructor(scene, camera, course, options = {}) {
    super(scene, camera, course, { ...options, sceneKind: 'play' });
  }
}
