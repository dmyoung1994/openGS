import { Vector3 } from 'three';
import { sampleHeightfield, sampleHeightfieldNormal } from '../terrain/Heightfield.js';
import { signedDistanceToFeature } from '../course/featureGeometry.js';
import { solveLoadingGreenPutt } from './LoadingGreenPutt.js';

let terrain;
self.onmessage = ({ data }) => {
  try {
    if (data.terrain) {
      terrain = {
        ...data.terrain,
        heightAt(x, z) { return sampleHeightfield(this, x, z); },
        normalAt(x, z, out = new Vector3()) { return sampleHeightfieldNormal(this, x, z, out); },
        surfaceAt(x, z) { return signedDistanceToFeature(data.green, x, z) > 0 ? 'green' : 'fringe'; },
      };
      return;
    }
    self.postMessage({ requestId: data.requestId, putt: solveLoadingGreenPutt(terrain, data.start, data.cup) });
  } catch (error) {
    self.postMessage({ requestId: data.requestId, error: error?.message || String(error) });
  }
};
