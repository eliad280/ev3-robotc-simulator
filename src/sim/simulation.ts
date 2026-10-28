import { CompileResult, PortConfig, SensorKind, defaultMode, defaultPorts } from '../lang/compile';
import { RuntimeError } from '../lang/errors';
import { Hardware, SensorReading } from '../lang/hardware';
import { EndReason, Interpreter } from '../lang/interpreter';
import { RobotSettings, SensorMount } from './design';
import {
  Pose, Vec, castRay, pointInObstacle, polygonHitsObstacle, polygonOutsideMap, toWorld,
} from './geometry';
import { DEFAULT_OBSTACLE_HEIGHT, DEFAULT_WALL_HEIGHT, MapData } from './map';
import { Motor, SyncLimit, educatorRobot } from './robot';

const DEG = Math.PI / 180;

function parseCssColor(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** What a color sensor sees: an RGB sample and how strongly it reflects back (1 = full). */
interface ColorView {
  rgb: [number, number, number] | null;
  strength: number;
  /** The sensor is close enough to name the color. */
  canName: boolean;
  facing: 'down' | 'level' | 'up';
}

/** Gives the color of the map surface under a point (RGB 0..255), or null outside the map. */
export interface Surface {
  sample(x: number, y: number, radius: number): [number, number, number] | null;
}

export interface LcdLine {
  text: string;
  big: boolean;
  centered: boolean;
}

export type SimStatus = 'idle' | 'running' | 'done' | 'stopped' | 'error';

export interface SoundEvent {
  frequency: number;
  ms: number;
  volume: number;
  /** Start this many ms from now (for multi-note sounds). */
  delay: number;
}

const SOUND_PRESETS: Record<number, Array<[number, number]>> = {
  0: [[1200, 60]], // blip
  1: [[1000, 100], [0, 60], [1000, 100]], // beep beep
  2: [[1200, 120], [900, 120], [600, 160]], // downward
  3: [[600, 120], [900, 120], [1200, 160]], // upward
  4: [[150, 400]], // low buzz
  5: [[700, 60], [1000, 60], [1300, 60], [1600, 80]], // fast upward
  6: [[1500, 30]], // short blip
  7: [[400, 150], [300, 250]], // exception
};

const SENSOR_FOR: Partial<Record<SensorReading, SensorKind>> = {
  colorName: 'color',
  reflected: 'color',
  ambient: 'color',
  hue: 'color',
  gyroAngle: 'gyro',
  gyroRate: 'gyro',
  distance: 'ultrasonic',
  touch: 'touch',
  bumped: 'touch',
  ir: 'ir',
};

const KIND_NAMES: Record<SensorKind, string> = {
  none: 'empty',
  touch: 'a touch sensor',
  color: 'a color sensor',
  ultrasonic: 'an ultrasonic sensor',
  gyro: 'a gyro sensor',
  ir: 'an IR sensor',
};

/** LEGO color number (TLegoColors) for an RGB sample. */
export function classifyColor(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const v = max;
  const s = max === 0 ? 0 : (max - min) / max;
  if (v < 0.22) return 1; // black
  if (s < 0.28) return v >= 0.5 ? 6 : 1; // white / black
  const h = hue(r, g, b);
  if (h < 15 || h >= 320) return 5; // red
  if (h < 40) return v < 0.7 ? 7 : 5; // brown / orange-red
  if (h < 75) return 4; // yellow
  if (h < 170) return 3; // green
  if (h < 270) return 2; // blue
  return 5;
}

function hue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return Math.round(((h * 60) + 360) % 360);
}

/** The simulated EV3 robot and its world. Advances in 1 ms steps. */
export class Simulation implements Hardware {
  time = 0;
  pose: Pose = { x: 0, y: 0, heading: 0 };
  motors = [new Motor(), new Motor(), new Motor(), new Motor()];
  /** Ports as the program sees them: kinds from the robot, names and modes from #pragma config. */
  ports: PortConfig = defaultPorts();
  private pragmaPorts: PortConfig = defaultPorts();
  lcd: Array<LcdLine | undefined> = [];
  led = 1;
  buttons = new Set<number>();
  debugText = '';
  trail: Vec[] = [];
  blocked = false;
  status: SimStatus = 'idle';
  error?: RuntimeError;
  program?: Interpreter;
  volume = 75;
  onSound?: (e: SoundEvent) => void;
  onStatus?: (status: SimStatus) => void;

  private syncLimits: SyncLimit[] = [];
  private gyroTotal = 0; // degrees, clockwise
  private gyroRate = 0;
  private gyroZero = [0, 0, 0, 0];
  private touchState = [false, false, false, false];
  private bumps = [0, 0, 0, 0];
  private soundUntil = 0;
  private warned = new Set<string>();

  constructor(
    public map: MapData,
    public surface: Surface,
    public robot: RobotSettings = educatorRobot(),
  ) {
    this.reset();
  }

  /** Puts the robot back at the start and clears the brick. */
  reset() {
    this.program?.stop();
    this.program = undefined;
    this.time = 0;
    this.pose = { x: this.map.start.x, y: this.map.start.y, heading: (this.map.start.heading * Math.PI) / 180 };
    this.motors = [new Motor(), new Motor(), new Motor(), new Motor()];
    this.applyPorts(this.pragmaPorts);
    this.syncLimits = [];
    this.gyroTotal = 0;
    this.gyroRate = 0;
    this.gyroZero = [0, 0, 0, 0];
    this.touchState = [false, false, false, false];
    this.bumps = [0, 0, 0, 0];
    this.lcd = [];
    this.led = 1;
    this.trail = [[this.pose.x, this.pose.y]];
    this.blocked = false;
    this.error = undefined;
    this.warned.clear();
    this.setStatus('idle');
  }

  setMap(map: MapData, surface: Surface) {
    this.map = map;
    this.surface = surface;
    this.reset();
  }

  setRobot(robot: RobotSettings) {
    this.robot = robot;
    this.reset();
  }

  /** Combines the built robot (what is plugged in where) with the program's #pragma config (names, modes). */
  applyPorts(pragma: PortConfig) {
    this.pragmaPorts = pragma;
    this.ports = {
      sensors: this.robot.sensors.map((m, k) => {
        const p = pragma.sensors[k];
        const fromPragma = p.pragmaLine !== undefined;
        return {
          kind: m.kind,
          mode: fromPragma && p.kind === m.kind ? p.mode : defaultMode(m.kind),
          name: fromPragma ? p.name : undefined,
        };
      }),
      motors: this.robot.motors.map((kind, k) => ({
        kind,
        reversed: pragma.motors[k].reversed,
        name: pragma.motors[k].pragmaLine !== undefined ? pragma.motors[k].name : undefined,
      })),
    };
    this.ports.motors.forEach((m, k) => {
      this.motors[k].kind = m.kind;
      this.motors[k].reversed = m.reversed;
    });
  }

  /** Starts a compiled program from the current robot position. */
  run(compiled: CompileResult) {
    if (!compiled.ok || !compiled.program) return;
    this.program?.stop();
    this.applyPorts(compiled.ports);
    this.error = undefined;
    const interp = new Interpreter(compiled.program, compiled.globalCount, this);
    interp.onEnd = (reason: EndReason, err?: RuntimeError) => {
      this.error = err;
      this.setStatus(reason === 'done' ? 'done' : reason === 'error' ? 'error' : 'stopped');
    };
    this.program = interp;
    this.setStatus('running');
    interp.start();
  }

  stopProgram() {
    this.program?.stop();
  }

  private setStatus(s: SimStatus) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus?.(s);
  }

  step() {
    if (this.program && !this.program.ended) this.program.tick();
    this.physics(0.001);
    this.time += 1;
  }

  // ---------- physics ----------

  private bodyPolygon(p: Pose): Vec[] {
    return this.robot.footprint.map((v) => toWorld(p, v));
  }

  collides(p: Pose): boolean {
    const poly = this.bodyPolygon(p);
    if (this.map.walls && polygonOutsideMap(poly, this.map)) return true;
    return this.map.obstacles.some((o) => polygonHitsObstacle(poly, o));
  }

  private physics(dt: number) {
    for (const m of this.motors) m.step(dt);
    this.checkSyncLimits();

    const r = this.robot;
    const vl = (this.motors[r.leftMotor].physicalSpeed * Math.PI * r.leftWheelDiameter) / 360;
    const vr = (this.motors[r.rightMotor].physicalSpeed * Math.PI * r.rightWheelDiameter) / 360;
    const v = (vl + vr) / 2;
    const w = (vl - vr) / r.trackWidth; // rad/s, clockwise
    const p = this.pose;
    const h = p.heading + w * dt;
    const mid = p.heading + (w * dt) / 2;
    const candidates: Pose[] = [
      { x: p.x + v * Math.cos(mid) * dt, y: p.y + v * Math.sin(mid) * dt, heading: h },
      { x: p.x, y: p.y, heading: h },
      { x: p.x + v * Math.cos(p.heading) * dt, y: p.y + v * Math.sin(p.heading) * dt, heading: p.heading },
    ];
    const moving = v !== 0 || w !== 0;
    const next = moving ? candidates.find((c) => !this.collides(c)) : p;
    this.blocked = moving && next !== candidates[0];
    const old = p.heading;
    if (next) this.pose = next;
    const dh = ((this.pose.heading - old) * 180) / Math.PI;
    this.gyroTotal += dh;
    this.gyroRate = dh / dt;

    for (let k = 0; k < 4; k++) {
      if (this.ports.sensors[k].kind !== 'touch') continue;
      const pressed = this.touchPressed(k);
      if (pressed && !this.touchState[k]) this.bumps[k]++;
      this.touchState[k] = pressed;
    }

    if (this.time % 50 === 0) {
      const last = this.trail[this.trail.length - 1];
      if (!last || Math.hypot(last[0] - this.pose.x, last[1] - this.pose.y) > 0.3) {
        this.trail.push([this.pose.x, this.pose.y]);
        if (this.trail.length > 5000) this.trail.splice(0, 1000);
      }
    }
  }

  private checkSyncLimits() {
    this.syncLimits = this.syncLimits.filter((l) => {
      const reached =
        l.kind === 'degrees'
          ? Math.abs(this.motors[l.master].encoder - l.start) >= l.value
          : this.time - l.start >= l.value;
      if (reached) {
        this.motors[l.m1].stop();
        this.motors[l.m2].stop();
      }
      return !reached;
    });
  }

  // ---------- sensors ----------

  /** World position of a sensor and the direction it faces in the plane (radians). */
  sensorPosition(port: number): { at: Vec; angle: number; mount: SensorMount } {
    const m = this.robot.sensors[port];
    return { at: toWorld(this.pose, m.at), angle: this.pose.heading + m.yaw * DEG, mount: m };
  }

  /** Where a sensor's line of sight meets the floor (only when it looks down). */
  floorPoint(port: number): { point: Vec; dist: number } | null {
    const { at, angle, mount } = this.sensorPosition(port);
    if (mount.pitch >= 0) return null;
    const down = -mount.pitch * DEG;
    const ahead = mount.height / Math.tan(down);
    return {
      point: [at[0] + Math.cos(angle) * ahead, at[1] + Math.sin(angle) * ahead],
      dist: mount.height / Math.sin(down),
    };
  }

  private touchPressed(port: number): boolean {
    const { at, angle, mount } = this.sensorPosition(port);
    if (mount.pitch <= -60) return mount.height <= 0.5; // pointing at the floor
    if (mount.pitch >= 60) return false; // pointing at the ceiling
    const reach = mount.reach + 0.5;
    const tip: Vec = [at[0] + Math.cos(angle) * reach, at[1] + Math.sin(angle) * reach];
    if (this.map.walls && (tip[0] < 0 || tip[1] < 0 || tip[0] > this.map.width || tip[1] > this.map.height)) {
      return mount.height <= (this.map.wallHeight ?? DEFAULT_WALL_HEIGHT);
    }
    return this.map.obstacles.some((o) => pointInObstacle(tip, o) && mount.height <= (o.height ?? DEFAULT_OBSTACLE_HEIGHT));
  }

  /**
   * Distance seen by an ultrasonic / IR sensor in cm (255 = nothing), along a 3D ray: it hits
   * the floor when tilted down, and only sees obstacles that are tall enough where the ray passes.
   */
  rangeDistance(port: number): number {
    const { at, angle, mount } = this.sensorPosition(port);
    const pitch = mount.pitch * DEG;
    let d = 255;
    if (pitch < 0) d = Math.min(d, mount.height / Math.sin(-pitch));
    const cos = Math.cos(pitch);
    if (cos > 1e-3) {
      const tan = Math.tan(pitch);
      const accept = (t: number, h: number) => {
        const z = mount.height + tan * t;
        return z >= 0 && z <= h;
      };
      for (const off of [-0.12, 0, 0.12]) {
        const hit = castRay(at, angle + off, this.map, 255 * cos, accept);
        d = Math.min(d, hit.dist / cos);
      }
    }
    return Math.min(255, Math.max(3, d));
  }

  /** What the color sensor sees, depending on which way it faces (O-1, O-2, O-3). */
  private colorView(port: number): ColorView {
    const { at, angle, mount } = this.sensorPosition(port);
    if (mount.pitch <= -30) {
      const fp = this.floorPoint(port)!;
      if (fp.dist > 4) return { rgb: null, strength: 0, canName: false, facing: 'down' };
      const rgb = this.surface.sample(fp.point[0], fp.point[1], 0.3 + 0.25 * fp.dist);
      const strength = fp.dist <= 1 ? 1 : Math.max(0, 1 - (fp.dist - 1) / 3);
      return { rgb, strength, canName: fp.dist <= 2.5, facing: 'down' };
    }
    if (mount.pitch < 30) {
      const accept = (_t: number, h: number) => mount.height <= h;
      const hit = castRay(at, angle, this.map, 3, accept);
      if (hit.dist >= 3 || !hit.color) return { rgb: null, strength: 0, canName: false, facing: 'level' };
      const strength = hit.dist <= 1 ? 1 : Math.max(0, 1 - (hit.dist - 1) / 2);
      return { rgb: parseCssColor(hit.color), strength, canName: hit.dist <= 2, facing: 'level' };
    }
    return { rgb: null, strength: 0, canName: false, facing: 'up' };
  }

  private warnOnce(msg: string) {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    this.debug(`[Warning] ${msg}\n`);
  }

  readSensor(port: number, what: SensorReading): number {
    const cfg = this.ports.sensors[port];
    if (what === 'value') {
      switch (cfg.kind) {
        case 'touch':
          return this.readSensor(port, 'touch');
        case 'color':
          return this.readSensor(port, cfg.mode === 'reflected' ? 'reflected' : cfg.mode === 'ambient' ? 'ambient' : 'colorName');
        case 'ultrasonic':
          return Math.round(this.readSensor(port, 'distance'));
        case 'gyro':
          return this.readSensor(port, cfg.mode === 'rate' ? 'gyroRate' : 'gyroAngle');
        case 'ir':
          return this.readSensor(port, 'ir');
        default:
          return 0;
      }
    }
    const need = SENSOR_FOR[what];
    if (need && cfg.kind !== need) {
      this.warnOnce(`S${port + 1} is ${KIND_NAMES[cfg.kind]}, not ${KIND_NAMES[need]}. Check #pragma config.`);
      return 0;
    }
    switch (what) {
      case 'colorName': {
        const v = this.colorView(port);
        return v.rgb && v.canName ? classifyColor(...v.rgb) : 0;
      }
      case 'reflected': {
        const v = this.colorView(port);
        if (!v.rgb) return 1;
        const lum = (0.299 * v.rgb[0] + 0.587 * v.rgb[1] + 0.114 * v.rgb[2]) / 255;
        return Math.max(1, Math.round((3 + lum * 87) * v.strength));
      }
      case 'ambient': {
        const f = this.colorView(port).facing;
        return f === 'up' ? 45 : f === 'level' ? 15 : 4;
      }
      case 'hue': {
        const v = this.colorView(port);
        return v.rgb ? hue(...v.rgb) : 0;
      }
      case 'gyroAngle':
        return Math.round((this.gyroTotal - this.gyroZero[port]) * this.gyroFactor(port));
      case 'gyroRate':
        return Math.round(this.gyroRate * this.gyroFactor(port));
      case 'distance':
        return Math.round(this.rangeDistance(port) * 10) / 10;
      case 'touch':
        return this.touchPressed(port) ? 1 : 0;
      case 'bumped':
        return this.bumps[port];
      case 'ir':
        return Math.min(100, Math.round(this.rangeDistance(port) / 0.7));
    }
    return 0;
  }

  readColorRGB(port: number): [number, number, number] {
    if (this.ports.sensors[port].kind !== 'color') {
      this.warnOnce(`S${port + 1} is ${KIND_NAMES[this.ports.sensors[port].kind]}, not a color sensor`);
      return [0, 0, 0];
    }
    const v = this.colorView(port);
    if (!v.rgb) return [0, 0, 0];
    return [Math.round(v.rgb[0] * v.strength), Math.round(v.rgb[1] * v.strength), Math.round(v.rgb[2] * v.strength)];
  }

  /** A gyro measures turning around its own axis: cos(tilt) of the robot's turn (O-6). */
  private gyroFactor(port: number) {
    const f = Math.cos(this.robot.sensors[port].pitch * DEG);
    return Math.abs(f) < 1e-9 ? 0 : f;
  }

  resetSensor(port: number) {
    this.gyroZero[port] = this.gyroTotal;
    this.bumps[port] = 0;
  }

  // ---------- Hardware: motors ----------

  now() {
    return this.time;
  }

  private dropLimits(port: number) {
    this.syncLimits = this.syncLimits.filter((l) => l.m1 !== port && l.m2 !== port);
  }

  setMotorPower(port: number, power: number) {
    this.dropLimits(port);
    this.motors[port].setPower(Math.round(power));
  }

  getMotorPower(port: number) {
    return this.motors[port].power;
  }

  stopMotor(port: number) {
    this.dropLimits(port);
    this.motors[port].stop();
  }

  setMotorTarget(port: number, target: number, speed: number) {
    this.dropLimits(port);
    this.motors[port].setTarget(target, speed);
  }

  isMotorBusy(port: number) {
    return this.motors[port].busy || this.syncLimits.some((l) => l.m1 === port || l.m2 === port);
  }

  getEncoder(port: number) {
    return this.motors[port].encoder;
  }

  setEncoder(port: number, value: number) {
    const m = this.motors[port];
    if (m.mode === 'target') m.target += value - m.encoder;
    m.encoder = value;
  }

  getMotorRPM(port: number) {
    return Math.round((this.motors[port].speed / 6) * 10) / 10;
  }

  setBrakeMode(port: number, brake: boolean) {
    this.motors[port].brake = brake;
  }

  setReversed(port: number, reversed: boolean) {
    this.motors[port].reversed = reversed;
  }

  setSync(m1: number, m2: number, turnRatio: number, speed: number, limit?: { kind: 'degrees' | 'time'; value: number }) {
    let p1 = speed;
    let p2 = speed;
    if (turnRatio > 0) p2 = speed * (1 - turnRatio / 50);
    else if (turnRatio < 0) p1 = speed * (1 + turnRatio / 50);
    this.dropLimits(m1);
    this.dropLimits(m2);
    this.motors[m1].setPower(Math.round(p1));
    this.motors[m2].setPower(Math.round(p2));
    if (limit) {
      const master = Math.abs(p1) >= Math.abs(p2) ? m1 : m2;
      this.syncLimits.push({
        m1,
        m2,
        master,
        kind: limit.kind,
        value: limit.value,
        start: limit.kind === 'degrees' ? this.motors[master].encoder : this.time,
      });
    }
  }

  // ---------- Hardware: brick ----------

  lcdText(line: number, text: string, big: boolean, centered: boolean) {
    if (line < 0 || line > 15) return;
    this.lcd[line] = { text, big, centered };
    if (big) this.lcd[line + 1] = undefined;
  }

  lcdClearLine(line: number) {
    this.lcd[line] = undefined;
  }

  lcdClear() {
    this.lcd = [];
  }

  debug(text: string) {
    this.debugText += text;
    if (this.debugText.length > 100_000) this.debugText = this.debugText.slice(-80_000);
  }

  clearDebug() {
    this.debugText = '';
  }

  isButtonPressed(button: number) {
    return button === 7 ? this.buttons.size > 0 : this.buttons.has(button);
  }

  setLed(pattern: number) {
    this.led = pattern;
  }

  playTone(frequency: number, ms: number) {
    this.soundUntil = this.time + ms;
    this.onSound?.({ frequency, ms, volume: this.volume, delay: 0 });
  }

  playSound(sound: number) {
    const notes = SOUND_PRESETS[sound] ?? SOUND_PRESETS[0];
    let total = 0;
    for (const [f, ms] of notes) {
      if (f) this.onSound?.({ frequency: f, ms, volume: this.volume, delay: total });
      total += ms;
    }
    this.soundUntil = this.time + total;
  }

  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(100, volume));
  }

  stopSounds() {
    this.soundUntil = this.time;
  }

  isSoundActive() {
    return this.time < this.soundUntil;
  }
}
