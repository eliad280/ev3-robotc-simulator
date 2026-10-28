import { RobotSettings, deriveRobot, educatorDesign } from './design';

/** The physical Educator robot, used until the user builds their own. */
export function educatorRobot(): RobotSettings {
  return deriveRobot(educatorDesign()).robot!;
}

export const MAX_SPEED_DEG_S = { large: 1050, medium: 1560, none: 0 };
const ACCEL = 9000; // deg/s² when driven or braking
const COAST_DECEL = 1200; // deg/s² when coasting

export interface SyncLimit {
  m1: number;
  m2: number;
  master: number;
  kind: 'degrees' | 'time';
  value: number;
  start: number;
}

/** One EV3 motor. Power, target and encoder are in the program's ("logical") direction. */
export class Motor {
  kind: 'large' | 'medium' | 'none' = 'large';
  reversed = false;
  brake = true;
  mode: 'power' | 'target' = 'power';
  power = 0;
  target = 0;
  targetSpeed = 0;
  targetDone = true;
  /** Actual speed in deg/s, logical direction. */
  speed = 0;
  encoder = 0;

  get maxSpeed() {
    return MAX_SPEED_DEG_S[this.kind];
  }

  setPower(p: number) {
    this.mode = 'power';
    this.power = p;
  }

  setTarget(target: number, speed: number) {
    this.mode = 'target';
    this.target = target;
    this.targetSpeed = Math.abs(speed);
    this.power = Math.abs(speed) * Math.sign(target - this.encoder);
    this.targetDone = Math.abs(target - this.encoder) < 0.5;
  }

  stop() {
    this.mode = 'power';
    this.power = 0;
  }

  get busy() {
    if (this.mode === 'target') return !this.targetDone;
    return this.power !== 0 || Math.abs(this.speed) > 5;
  }

  step(dt: number) {
    let desired: number;
    let accel = ACCEL;
    if (this.mode === 'target') {
      const remaining = this.target - this.encoder;
      if (this.targetDone || Math.abs(remaining) < 0.5) {
        this.targetDone = true;
        desired = 0;
        // hold position: settle exactly on the target
        if (Math.abs(this.speed) < 30) {
          this.encoder += remaining * Math.min(1, dt * 20);
        }
      } else {
        const vmax = (this.targetSpeed / 100) * this.maxSpeed;
        // slow down near the target so it stops on it
        desired = Math.sign(remaining) * Math.min(vmax, Math.abs(remaining) * 12 + 15);
      }
    } else {
      desired = (this.power / 100) * this.maxSpeed;
      if (this.power === 0 && !this.brake) accel = COAST_DECEL;
    }
    const dv = desired - this.speed;
    const maxDv = accel * dt;
    this.speed += Math.abs(dv) <= maxDv ? dv : Math.sign(dv) * maxDv;
    this.encoder += this.speed * dt;
  }

  /** Speed of the output shaft in deg/s in the physical direction. */
  get physicalSpeed() {
    return this.reversed ? -this.speed : this.speed;
  }
}
