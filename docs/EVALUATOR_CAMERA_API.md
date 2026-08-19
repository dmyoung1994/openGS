# Evaluator camera API

The production page exposes a versioned, engine-level camera controller at
`window.golf.evaluatorCamera` (`version === "1.0"`). It is intended for deterministic
capture and evaluation harnesses; it does not require keyboard, mouse, or browser
automation.

```js
const cam = window.golf.evaluatorCamera;
cam.enter();
cam.setPose({ position: [3, 4, 5], lookAt: [3, 4, 0], fov: 50 });
// Or: cam.setPose({ position: [3, 4, 5], quaternion: [x, y, z, w] });
cam.orbit({ target: [0, 0, -30], radius: 18, azimuth: 0.4, elevation: 0.25 });
cam.freeze();
await cam.waitForFrames(3);
const resolved = cam.getState();
cam.unfreeze();
cam.exit(); // restores the previous director/free-camera pose and ownership
```

`enter()` suspends FreeCamera input and gives the evaluator priority over the
cinematic director and menu camera. `setPose()` and `orbit()` immediately update the
live camera and invalidate temporal history for cuts (including FOV/projection cuts).
`getState()` returns resolved position, quaternion, one-unit `lookAt`, FOV, ownership,
freeze state, API version, and the last notified frame. `waitForFrames()` resolves only
after distinct live frames; the production loop calls the deterministic `notifyFrame()`
hook once per update. `freeze()`/`unfreeze()` freeze simulation while rendering continues.

