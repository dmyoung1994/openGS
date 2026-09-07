import assert from 'node:assert/strict';
import test from 'node:test';
import { Birds, birdFlightAt } from '../src/scene/Birds.js';

test('bird flight is deterministic, continuous, bounded and follows the environment clock', () => {
  const environment = { time: { value: 0 } };
  const options = {
    course: { environmentSeed: 42, biome: 'temperate-maritime', bounds: { minX: -100, maxX: 100, minZ: -300, maxZ: 30 } },
    terrain: { heightAt: () => 7 }, environment,
  };
  const flock = new Birds(options);
  const twin = new Birds(options);
  for (let time = 0; time < 120; time += 0.1) {
    environment.time.value = time;
    flock.update();
    twin.update();
    for (let i = 0; i < flock.birds.length; i++) {
      const bird = flock.birds[i];
      assert.deepEqual(bird.root.position.toArray(), twin.birds[i].root.position.toArray());
      assert.ok(bird.root.position.y > 28);
      const next = birdFlightAt(time + 0.001, bird);
      assert.ok(Math.hypot(next.x - bird.pose.x, next.y - bird.pose.y, next.z - bird.pose.z) < 0.01);
      assert.ok(Math.abs(bird.pose.flap) <= 0.5);
    }
  }
  const before = flock.birds.map(bird => bird.root.position.toArray());
  flock.update();
  assert.deepEqual(flock.birds.map(bird => bird.root.position.toArray()), before);
});
