import { Vector3 } from 'three';

// Cinematic camera. It never snaps: a critically-damped spring chases a desired
// pose that changes with the shot phase, giving a broadcast tracer feel.
//
// Phases:
//   address  - over-the-shoulder behind the tee, looking down the target line
//   chase    - trails behind and just below the ball so we look *up* at the
//              rising shot, pulling back as ball speed increases
//   descent  - as the ball falls, the rig lifts and eases back to reveal the
//              landing zone
//   result   - a slow 3/4 push-in on the ball at rest
export class CameraDirector {
  constructor(camera) {
    this.camera = camera;
    this.pos = camera.position.clone();
    this.look = new Vector3(0, 1, -30);
    this._look = this.look.clone();
    this.phase = 'address';
    this.aim = new Vector3(0, 0, -1);
    this._tmp = new Vector3();
    this._resultAngle = 0;
  }

  setAddress(ballPos, aimDir, firstTargetZ = -50) {
    this.phase = 'address';
    this.aim.copy(aimDir).normalize();
    // Behind and above the ball, offset to the trail side (over the shoulder).
    const back = this.aim.clone().multiplyScalar(-4.5);
    this.pos.copy(ballPos).add(back).add(new Vector3(1.6, 2.0, 0));
    this.look.copy(ballPos).add(this.aim.clone().multiplyScalar(30));
    this.look.y = ballPos.y + 1.2;
    this._snap();
  }

  onLaunch(ball) {
    this.phase = 'chase';
    this._launchDir = new Vector3(ball.velocity.x, 0, ball.velocity.z).normalize();
  }

  update(dt, ball) {
    if (this.phase === 'chase' || this.phase === 'descent') this._flight(ball);
    else if (this.phase === 'result') this._result(dt, ball);
    // address pose is static until launch

    // Damp toward the desired pose. Rate chosen for a smooth but responsive rig.
    const kp = this.phase === 'result' ? 1.6 : 3.2;
    const a = 1 - Math.exp(-kp * dt);
    this.camera.position.lerp(this.pos, a);
    this._look.lerp(this.look, 1 - Math.exp(-4.5 * dt));
    this.camera.lookAt(this._look);
  }

  _flight(ball) {
    const p = ball.position;
    const v = ball.velocity;
    const speed = v.length();
    const hv = this._tmp.set(v.x, 0, v.z);
    const hs = hv.length();
    if (hs > 0.1) hv.multiplyScalar(1 / hs);
    else hv.copy(this._launchDir);

    const rising = v.y > 0.5;
    this.phase = rising ? 'chase' : 'descent';

    // Trail distance and height scale with speed; while rising we stay lower
    // than the ball (look up), while descending we lift to open up the landing.
    const dist = Math.min(9 + hs * 0.9, 42);
    const baseH = rising ? 1.4 : 4.5 + Math.min(hs * 0.4, 14);

    this.pos.copy(p).addScaledVector(hv, -dist);
    this.pos.y = p.y * (rising ? 0.35 : 0.7) + baseH + ball.start.y;
    // Slight lateral so the ball isn't dead-center (broadcast framing).
    this.pos.x += 1.0;

    // Look slightly ahead of the ball along its path for lead room.
    this.look.copy(p).addScaledVector(hv, Math.min(hs * 0.25, 8));
    this.look.y = p.y + 0.5;
  }

  onRest(ball) {
    this.phase = 'result';
    this._resultAngle = Math.atan2(ball.velocity.x || 1, ball.velocity.z || -1) + 2.4;
    this._restPos = ball.position.clone();
  }

  _result(dt, ball) {
    this._resultAngle += dt * 0.15;
    const p = ball.position;
    const r = 6;
    this.pos.set(
      p.x + Math.sin(this._resultAngle) * r,
      p.y + 2.4,
      p.z + Math.cos(this._resultAngle) * r,
    );
    this.look.copy(p);
    this.look.y += 0.1;
  }

  _snap() {
    this.camera.position.copy(this.pos);
    this._look.copy(this.look);
    this.camera.lookAt(this._look);
  }
}
