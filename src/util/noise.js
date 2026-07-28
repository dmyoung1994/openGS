import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

// Fractal Brownian motion over Perlin noise, used for terrain elevation and
// texture variation. Computed on the CPU at load time only (never per frame).
export class Noise {
  constructor(seed = 1) {
    this.perlin = new ImprovedNoise();
    // Seed by offsetting the sample space; ImprovedNoise itself is fixed.
    this.ox = (seed * 137.13) % 1000;
    this.oy = (seed * 91.71) % 1000;
  }

  // Single octave in [-1, 1].
  noise2(x, y) {
    return this.perlin.noise(x + this.ox, y + this.oy, 0.5);
  }

  // fBm in roughly [-1, 1].
  fbm(x, y, { octaves = 5, lacunarity = 2.0, gain = 0.5, frequency = 1 } = {}) {
    let amp = 0.5;
    let freq = frequency;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.perlin.noise(x * freq + this.ox, y * freq + this.oy, i * 0.37);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  // Ridged variant for firmer, more sculpted landforms (dunes, greens shoulders).
  ridged(x, y, opts = {}) {
    return 1 - Math.abs(this.fbm(x, y, opts));
  }
}
