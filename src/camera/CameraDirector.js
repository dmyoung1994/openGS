import { Matrix4, Quaternion, Vector3 } from 'three';

const GRAVITY = 9.80665;
const CHASE_MIN_DOWN_PITCH = 0;
const DESCENT_MIN_DOWN_PITCH = 4 * Math.PI / 180;
const RETURN_DURATION = 3.6;
const RESULT_ORBIT_RATE = 0.025;

// Cinematic camera. A damped rig chases a desired pose through four continuous
// phases: address, rising flight, landing reveal, and the result orbit. Automatic
// reset uses a fifth `return` phase so the landing view glides back to the tee.
export class CameraDirector {
  constructor(camera) {
    this.camera = camera;
    this.pos = camera.position.clone();
    this.look = new Vector3(0, 1, -30);
    this._look = this.look.clone();
    this._viewLook = this.look.clone();
    this.phase = 'address';
    this.aim = new Vector3(0, 0, -1);
    this._horizontal = new Vector3();
    this._flightSide = new Vector3();
    this._resultAngle = 0;
    this._launchDir = new Vector3(0, 0, -1);
    this._launchY = 0;
    this._apexY = 0;
    this._returnElapsed = 0;
    this._returnStartPosition = new Vector3();
    this._returnStartQuaternion = new Quaternion();
    this._returnEndQuaternion = new Quaternion();
    this._returnLookMatrix = new Matrix4();
  }

  setAddress(ballPos, aimDir, firstTargetZ = -50) {
    void firstTargetZ;
    this.phase = 'address';
    this._setAddressPose(ballPos, aimDir);
    this._snap();
  }

  returnToAddress(ballPos, aimDir) {
    this.phase = 'return';
    this._returnElapsed = 0;
    this._returnStartPosition.copy(this.camera.position);
    this._returnStartQuaternion.copy(this.camera.quaternion);
    this._setAddressPose(ballPos, aimDir);
    this._returnLookMatrix.lookAt(this.pos, this.look, this.camera.up);
    this._returnEndQuaternion.setFromRotationMatrix(this._returnLookMatrix);
  }

  _setAddressPose(ballPos, aimDir) {
    this.aim.copy(aimDir).normalize();
    // Start directly on the target line behind the ball so the opening composition
    // reads straight down-range rather than as an offset over-the-shoulder view.
    this.pos.copy(ballPos).addScaledVector(this.aim, -4.5);
    // Keep a golfer-height lens and pitch it down enough to hold the physical ball
    // just above the floating address control. The focal point is below grade only
    // to define that broadcast pitch; the visible target line remains down-range.
    this.pos.y += 1.45;
    this.look.copy(ballPos).addScaledVector(this.aim, 30);
    this.look.y = ballPos.y - 2.5;
    if (this.addressViewport) {
      const { height, bottom } = this.addressViewport;
      const down = Math.max(0, 1 - 2 * (bottom + 28) / height);
      const pitch = Math.atan2(1.45, 4.5) - Math.atan(down * Math.tan(this.camera.getEffectiveFOV() * Math.PI / 360));
      this.look.y = Math.min(this.look.y, this.pos.y - Math.tan(pitch) * 34.5);
    }
  }

  onLaunch(ball) {
    this.phase = 'chase';
    this._launchDir.set(ball.velocity.x, 0, ball.velocity.z);
    if (this._launchDir.lengthSq() > 1e-4) this._launchDir.normalize();
    else this._launchDir.copy(this.aim);
    this._launchY = ball.start?.y ?? ball.position.y;
    this._apexY = ball.position.y;
  }

  update(dt, ball) {
    if (this.phase === 'chase' || this.phase === 'descent') this._flight(ball);
    else if (this.phase === 'result') this._result(dt, ball);
    // Address and return poses are static targets.

    if (this.phase === 'return') {
      this._returnElapsed = Math.min(RETURN_DURATION, this._returnElapsed + dt);
      const linear = this._returnElapsed / RETURN_DURATION;
      const eased = linear * linear * (3 - 2 * linear);
      this.camera.position.lerpVectors(this._returnStartPosition, this.pos, eased);
      this.camera.quaternion.slerpQuaternions(
        this._returnStartQuaternion,
        this._returnEndQuaternion,
        eased,
      );
      this._look.lerpVectors(this._returnStartPosition, this.look, eased);
      if (linear >= 1) this.phase = 'address';
      return;
    }

    // Flight needs a responsive but still damped chase. The former 3.2 rate added
    // roughly 20 m of spring lag to an already 42 m desired offset on a driver.
    const positionRate = this.phase === 'result' ? 1.6
      : (this.phase === 'chase' || this.phase === 'descent' ? 10.0 : 3.2);
    const lookRate = this.phase === 'chase' || this.phase === 'descent' ? 8.0 : 4.5;
    this.camera.position.lerp(this.pos, 1 - Math.exp(-positionRate * dt));
    this._look.lerp(this.look, 1 - Math.exp(-lookRate * dt));

    if (this.phase === 'chase' || this.phase === 'descent') {
      // A fast-rising ball can outrun an ordinary spring. Keep the flight camera above
      // it explicitly; horizontal motion remains damped, while vertical motion climbs
      // with the shot until the apex and is free to descend afterward.
      this.camera.position.y = Math.max(this.camera.position.y, ball.position.y + 1.5);
      this._applyFlightLookConstraint();
    } else {
      this.camera.lookAt(this._look);
    }
  }

  _applyFlightLookConstraint() {
    this._viewLook.copy(this._look);
    const dx = this._viewLook.x - this.camera.position.x;
    const dz = this._viewLook.z - this.camera.position.z;
    const horizontalDistance = Math.max(0.01, Math.hypot(dx, dz));
    const minPitch = this.phase === 'descent' ? DESCENT_MIN_DOWN_PITCH : CHASE_MIN_DOWN_PITCH;
    const highestTargetY = this.camera.position.y - Math.tan(minPitch) * horizontalDistance;
    this._viewLook.y = Math.min(this._viewLook.y, highestTargetY);
    this.camera.lookAt(this._viewLook);
  }

  _flight(ball) {
    const p = ball.position;
    const v = ball.velocity;
    const hv = this._horizontal.set(v.x, 0, v.z);
    const hs = hv.length();
    if (hs > 0.1) hv.multiplyScalar(1 / hs);
    else hv.copy(this._launchDir);

    this._apexY = Math.max(this._apexY, p.y);
    const rising = v.y > 0.5;
    this.phase = rising ? 'chase' : 'descent';

    // Stay close enough to read the physical ball while leaving enough baseline
    // to see the trajectory bend. A camera almost directly behind the velocity
    // vector collapses a real parabolic tracer into a straight HUD-like stripe.
    const dist = Math.min(6 + hs * 0.08, 12.5);
    this.pos.copy(p).addScaledVector(hv, -dist);
    // A trajectory-relative broadcast offset reveals the arc instead of looking
    // straight down its tangent. It follows shaped shots and remains deterministic
    // without introducing a second camera path or a fixed world-X composition.
    this._flightSide.set(hv.z, 0, -hv.x).multiplyScalar(-7.0);
    this.pos.add(this._flightSide);

    if (rising) {
      // Rise with the shot while remaining above it. This keeps the horizon and course
      // in frame instead of making the audience look up into empty sky.
      this.pos.y = p.y + 2.4;
      this.look.copy(p).addScaledVector(hv, Math.min(hs * 0.055, 2.2));
      this.look.y = p.y - 0.35;
      return;
    }

    // After apex, ease downward from the acquired height and lead the view toward an
    // estimated landing point. Terrain is sampled when available, so the reveal reads
    // correctly over elevated greens and rolling fairways rather than assuming y=0.
    const altitude = Math.max(0, p.y - this._launchY);
    this.pos.y = this._launchY + 2.4 + altitude * 0.78;

    let landingX = p.x;
    let landingZ = p.z;
    let landingY = this._launchY;
    for (let iteration = 0; iteration < 2; iteration++) {
      if (ball.terrain?.heightAt) landingY = ball.terrain.heightAt(landingX, landingZ) + (ball.radius || 0);
      const fall = Math.max(0, p.y - landingY);
      const timeToGround = (v.y + Math.sqrt(Math.max(0, v.y * v.y + 2 * GRAVITY * fall))) / GRAVITY;
      const lead = Math.min(Math.max(0, hs * timeToGround), 36);
      landingX = p.x + hv.x * lead;
      landingZ = p.z + hv.z * lead;
    }
    // Bias strongly toward the ball while retaining a modest look-ahead cue. The
    // pitch constraint below still guarantees that the ground/landing zone remains
    // visible instead of letting the camera tilt back up at the descending ball.
    this.look.set(landingX, landingY + 0.25, landingZ).lerp(p, 0.85);
  }

  onRest(ball) {
    this.phase = 'result';
    // Settle into a three-quarter rear view of the real shot line. Rest velocity is
    // normally zero, so deriving this pose from it made identical shots land in an
    // arbitrary world-relative composition.
    const heading = Math.atan2(this._launchDir.x, this._launchDir.z);
    this._resultAngle = heading + Math.PI + 0.55;
  }

  _result(dt, ball) {
    // The result card persists for ten seconds. A restrained drift keeps the scene
    // alive without turning that readable hold into a fast, arcade-style orbit.
    this._resultAngle += dt * RESULT_ORBIT_RATE;
    const p = ball.position;
    // A wider, golfer-height orbit keeps the landing area, course, and horizon in
    // the result composition. The former six-metre / 2.4-metre pose looked almost
    // straight down at turf, leaving the results surface with no environment to
    // optically integrate into.
    const r = 13;
    this.pos.set(
      p.x + Math.sin(this._resultAngle) * r,
      p.y + 2.0,
      p.z + Math.cos(this._resultAngle) * r,
    );
    this.look.copy(p);
    this.look.y += 0.5;
  }

  _snap() {
    this.camera.position.copy(this.pos);
    this._look.copy(this.look);
    this.camera.lookAt(this._look);
  }
}
