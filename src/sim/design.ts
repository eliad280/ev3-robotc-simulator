/**
 * A robot built from LEGO parts in top view, and how it turns into the physical robot the
 * simulation drives. Design coordinates are in cm: x forward, y to the right.
 */
import type { PortConfig, SensorKind } from '../lang/compile';
import type { Diagnostic } from '../lang/errors';
import { Vec } from './geometry';

export const STUD = 0.8; // cm

export type PartKind =
  | 'brick'
  | 'largeMotor'
  | 'mediumMotor'
  | 'wheel'
  | 'caster'
  | 'beam'
  | 'frame'
  | 'touch'
  | 'color'
  | 'ultrasonic'
  | 'gyro'
  | 'ir';

export interface Part {
  id: string;
  kind: PartKind;
  /** Center, cm. */
  x: number;
  y: number;
  /** Rotation in the plane, degrees clockwise. For a sensor this is the direction it faces. */
  rot: number;
  /** Motor port 0..3 (A..D) or sensor port 0..3 (S1..S4). */
  port?: number;
  /** Wheel size id from WHEELS. */
  wheel?: string;
  /** Wheel: the motor port that drives it; undefined = free wheel. */
  drivenBy?: number;
  /** Beam length in holes. */
  holes?: number;
  /** Sensor tilt in degrees: -90 down, 0 level, +90 up. For the gyro: tilt of its measuring axis. */
  pitch?: number;
  /** Sensor height above the floor, cm. */
  height?: number;
}

export interface RobotDesign {
  version: 1;
  name: string;
  parts: Part[];
}

export const WHEELS = [
  { id: '30.4x14', d: 3.04, w: 1.4 },
  { id: '43.2x22', d: 4.32, w: 2.2 },
  { id: '56x28', d: 5.6, w: 2.8 },
  { id: '62.4x20', d: 6.24, w: 2.0 },
  { id: '68.8x36', d: 6.88, w: 3.6 },
  { id: '81.6x15', d: 8.16, w: 1.5 },
];

export const BEAM_LENGTHS = [3, 5, 7, 9, 11, 13, 15];

export interface PartInfo {
  label: string;
  sensor?: SensorKind;
  motor?: 'large' | 'medium';
  /** Default height above the floor for sensors, cm. */
  height?: number;
  pitch?: number;
}

export const PART_INFO: Record<PartKind, PartInfo> = {
  brick: { label: 'EV3 Brick' },
  largeMotor: { label: 'Large Motor', motor: 'large' },
  mediumMotor: { label: 'Medium Motor', motor: 'medium' },
  wheel: { label: 'Wheel' },
  caster: { label: 'Ball Caster' },
  beam: { label: 'Beam' },
  frame: { label: 'Frame 5×7' },
  touch: { label: 'Touch Sensor', sensor: 'touch', height: 3, pitch: 0 },
  color: { label: 'Color Sensor', sensor: 'color', height: 1, pitch: -90 },
  ultrasonic: { label: 'Ultrasonic Sensor', sensor: 'ultrasonic', height: 6, pitch: 0 },
  gyro: { label: 'Gyro Sensor', sensor: 'gyro', height: 5, pitch: 0 },
  ir: { label: 'IR Sensor', sensor: 'ir', height: 6, pitch: 0 },
};

export const wheelSize = (id?: string) => WHEELS.find((w) => w.id === id) ?? WHEELS[2];

/** Footprint in top view before rotation: [length along x, width along y], cm. */
export function partSize(p: Part): [number, number] {
  switch (p.kind) {
    case 'brick':
      return [12.8, 8.8];
    case 'largeMotor':
      return [9.6, 2.4];
    case 'mediumMotor':
      return [4.8, 3.2];
    case 'wheel': {
      const w = wheelSize(p.wheel);
      return [w.d, w.w];
    }
    case 'caster':
      return [2.4, 2.4];
    case 'beam':
      return [(p.holes ?? 5) * STUD, STUD];
    case 'frame':
      return [5.6, 4.0];
    case 'touch':
      return [4.8, 2.4];
    case 'color':
      return [3.2, 2.4];
    case 'ultrasonic':
    case 'ir':
      return [4.0, 6.4];
    case 'gyro':
      return [2.4, 2.4];
  }
}

export function partCorners(p: Part): Vec[] {
  const [l, w] = partSize(p);
  const a = (p.rot * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return ([[l / 2, -w / 2], [l / 2, w / 2], [-l / 2, w / 2], [-l / 2, -w / 2]] as Vec[]).map(([x, y]) => [
    p.x + x * c - y * s,
    p.y + x * s + y * c,
  ]);
}

export function convexHull(points: Vec[]): Vec[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Vec, a: Vec, b: Vec) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec[] = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// ---------- the physical robot ----------

export interface SensorMount {
  kind: SensorKind;
  /** Position in the robot frame (origin = middle of the drive axle). */
  at: Vec;
  /** Direction in the plane, degrees clockwise from forward. */
  yaw: number;
  pitch: number;
  height: number;
  /** Distance from `at` to the sensor's front face, cm (where the touch sensor feels). */
  reach: number;
}

export interface RobotSettings {
  leftWheelDiameter: number;
  rightWheelDiameter: number;
  trackWidth: number;
  leftMotor: number;
  rightMotor: number;
  /** Convex outline of all parts, robot frame. */
  footprint: Vec[];
  motors: Array<'large' | 'medium' | 'none'>;
  sensors: SensorMount[];
  /** All parts moved into the robot frame, for drawing. */
  parts: Part[];
}

export interface DesignIssue {
  severity: 'error' | 'warning';
  message: string;
  partIds: string[];
}

const PORT_LETTERS = 'ABCD';

const angleNorm = (a: number) => ((a % 360) + 360) % 360;

/** Checks a design and builds the physical robot from it. `robot` is undefined when there are errors. */
export function deriveRobot(design: RobotDesign): { robot?: RobotSettings; issues: DesignIssue[] } {
  const issues: DesignIssue[] = [];
  const err = (message: string, parts: Part[] = []) => issues.push({ severity: 'error', message, partIds: parts.map((p) => p.id) });
  const warn = (message: string, parts: Part[] = []) => issues.push({ severity: 'warning', message, partIds: parts.map((p) => p.id) });
  const parts = design.parts;

  const bricks = parts.filter((p) => p.kind === 'brick');
  if (bricks.length === 0) err('The robot has no EV3 brick');
  if (bricks.length > 1) err('The robot has more than one EV3 brick', bricks);

  // ports
  const motors = parts.filter((p) => PART_INFO[p.kind].motor);
  const sensors = parts.filter((p) => PART_INFO[p.kind].sensor);
  for (let port = 0; port < 4; port++) {
    const onMotor = motors.filter((m) => m.port === port);
    if (onMotor.length > 1) err(`More than one motor is connected to port ${PORT_LETTERS[port]}`, onMotor);
    const onSensor = sensors.filter((s) => s.port === port);
    if (onSensor.length > 1) err(`More than one sensor is connected to port S${port + 1}`, onSensor);
  }
  for (const m of motors) if (m.port === undefined) warn(`${PART_INFO[m.kind].label} is not connected to a port`, [m]);
  for (const s of sensors) if (s.port === undefined) warn(`${PART_INFO[s.kind].label} is not connected to a port`, [s]);

  // drive
  const wheels = parts.filter((p) => p.kind === 'wheel');
  const driven = wheels.filter((w) => w.drivenBy !== undefined);
  for (const w of driven) {
    if (!motors.some((m) => m.port === w.drivenBy)) err(`The wheel is driven by port ${PORT_LETTERS[w.drivenBy!]}, but no motor is connected there`, [w]);
    if (angleNorm(w.rot) % 180 !== 0) err('A driven wheel must be turned so it rolls forward and backward', [w]);
  }
  let axle: { left: Part; right: Part } | undefined;
  if (driven.length !== 2) {
    err(`The robot needs exactly two driven wheels (it has ${driven.length})`, driven);
  } else {
    const [a, b] = driven;
    if (Math.abs(a.x - b.x) > 0.4) err('The two driven wheels must be on the same axle (same forward/back position)', driven);
    else if (Math.abs(a.y - b.y) < 2) err('The driven wheels are too close to each other', driven);
    else if (a.drivenBy === b.drivenBy) err('Each driven wheel needs its own motor', driven);
    else axle = a.y < b.y ? { left: a, right: b } : { left: b, right: a };
  }
  const supports = parts.filter((p) => p.kind === 'caster' || (p.kind === 'wheel' && p.drivenBy === undefined));
  if (axle && supports.length === 0) warn('There is no third support (a ball caster or a free wheel). The simulation works, but a real robot would tip over');

  if (issues.some((i) => i.severity === 'error') || !axle) return { issues };

  const ox = (axle.left.x + axle.right.x) / 2;
  const oy = (axle.left.y + axle.right.y) / 2;
  const local = parts.map((p) => ({ ...p, x: p.x - ox, y: p.y - oy }));

  const motorKinds: RobotSettings['motors'] = ['none', 'none', 'none', 'none'];
  for (const m of local) if (PART_INFO[m.kind].motor && m.port !== undefined) motorKinds[m.port] = PART_INFO[m.kind].motor!;

  const mounts: SensorMount[] = [0, 1, 2, 3].map(() => ({ kind: 'none', at: [0, 0], yaw: 0, pitch: 0, height: 0, reach: 0 }));
  for (const s of local) {
    const info = PART_INFO[s.kind];
    if (!info.sensor || s.port === undefined) continue;
    mounts[s.port] = {
      kind: info.sensor,
      at: [s.x, s.y],
      yaw: s.rot,
      pitch: s.pitch ?? info.pitch ?? 0,
      height: s.height ?? info.height ?? 0,
      reach: partSize(s)[0] / 2,
    };
  }

  return {
    issues,
    robot: {
      leftWheelDiameter: wheelSize(axle.left.wheel).d,
      rightWheelDiameter: wheelSize(axle.right.wheel).d,
      trackWidth: Math.abs(axle.right.y - axle.left.y),
      leftMotor: axle.left.drivenBy!,
      rightMotor: axle.right.drivenBy!,
      footprint: convexHull(local.flatMap(partCorners)),
      motors: motorKinds,
      sensors: mounts,
      parts: local,
    },
  };
}

// ---------- presets ----------

let nextId = 1;
export const newPartId = () => `p${Date.now().toString(36)}${(nextId++).toString(36)}`;

const part = (kind: PartKind, x: number, y: number, extra: Partial<Part> = {}): Part => ({
  id: newPartId(),
  kind,
  x,
  y,
  rot: 0,
  ...extra,
});

/** The EV3 Educator robot: touch S1, gyro S2, color S3 (looking down), ultrasonic S4; drive on B and C. */
export function educatorDesign(): RobotDesign {
  return {
    version: 1,
    name: 'Educator',
    parts: [
      part('largeMotor', -2, -3.2, { port: 1 }),
      part('largeMotor', -2, 3.2, { port: 2 }),
      part('wheel', 0, -6, { wheel: '56x28', drivenBy: 1 }),
      part('wheel', 0, 6, { wheel: '56x28', drivenBy: 2 }),
      part('brick', -4.8, 0),
      part('caster', -11.2, 0),
      part('mediumMotor', 1.6, 0, { port: 0 }),
      part('touch', 8, 0, { port: 0, height: 3, pitch: 0 }),
      part('gyro', -3.2, 0, { port: 1, height: 5, pitch: 0 }),
      part('color', 3.2, 0, { port: 2, height: 1, pitch: -90 }),
      part('ultrasonic', 5.6, 0, { port: 3, height: 7, pitch: 0 }),
    ],
  };
}

/** Line follower with two color sensors (S2 left, S3 right) and a gyro. */
export function twoColorDesign(): RobotDesign {
  return {
    version: 1,
    name: 'Two-sensor line follower',
    parts: [
      part('largeMotor', -2, -3.2, { port: 1 }),
      part('largeMotor', -2, 3.2, { port: 2 }),
      part('wheel', 0, -6, { wheel: '56x28', drivenBy: 1 }),
      part('wheel', 0, 6, { wheel: '56x28', drivenBy: 2 }),
      part('brick', -4.8, 0),
      part('caster', -11.2, 0),
      part('beam', 4.8, 0, { holes: 11, rot: 90 }),
      part('gyro', -3.2, 0, { port: 0, height: 5, pitch: 0 }),
      part('color', 6.4, -2.4, { port: 1, height: 1, pitch: -90 }),
      part('color', 6.4, 2.4, { port: 2, height: 1, pitch: -90 }),
      part('ultrasonic', 3.2, 0, { port: 3, height: 7, pitch: 0 }),
    ],
  };
}

export function parseDesign(json: string): RobotDesign {
  const d = JSON.parse(json);
  if (!d || !Array.isArray(d.parts)) throw new Error('This is not a valid robot file');
  const kinds = Object.keys(PART_INFO);
  const parts: Part[] = d.parts
    .filter((p: Part) => p && kinds.includes(p.kind) && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p: Part) => ({ ...p, id: typeof p.id === 'string' ? p.id : newPartId(), rot: Number(p.rot) || 0 }));
  return { version: 1, name: String(d.name ?? 'Robot'), parts };
}

// ---------- #pragma config ----------

const SENSOR_PRAGMA: Record<string, { type: string; mode?: string; name: string }> = {
  touch: { type: 'sensorEV3_Touch', name: 'touchSensor' },
  color: { type: 'sensorEV3_Color', mode: 'modeEV3Color_Color', name: 'colorSensor' },
  ultrasonic: { type: 'sensorEV3_Ultrasonic', name: 'sonarSensor' },
  gyro: { type: 'sensorEV3_Gyro', mode: 'modeEV3Gyro_RateAndAngle', name: 'gyroSensor' },
  ir: { type: 'sensorEV3_IRSensor', name: 'irSensor' },
};

export interface ExistingPragma {
  kind: string;
  name?: string;
  modeToken?: string;
}

/**
 * `#pragma config` lines describing the robot. Names and modes already used in the code
 * for the same kind of device on the same port are kept, so the program keeps compiling.
 */
export function pragmaLines(robot: RobotSettings, existingSensors: Array<ExistingPragma | undefined>, existingMotors: Array<ExistingPragma | undefined>): string[] {
  const lines: string[] = [];
  const used = new Set<string>();
  const unique = (name: string, suffix: string) => {
    let n = name;
    if (used.has(n)) n = `${name}${suffix}`;
    used.add(n);
    return n;
  };
  const colorCount = robot.sensors.filter((s) => s.kind === 'color').length;
  robot.sensors.forEach((s, k) => {
    if (s.kind === 'none') return;
    const spec = SENSOR_PRAGMA[s.kind];
    const prev = existingSensors[k]?.kind === s.kind ? existingSensors[k] : undefined;
    let name = prev?.name ?? spec.name;
    if (!prev && s.kind === 'color' && colorCount > 1) name = s.at[1] < 0 ? 'colorLeft' : s.at[1] > 0 ? 'colorRight' : 'colorCenter';
    name = unique(name, `S${k + 1}`);
    const mode = prev?.modeToken ?? spec.mode;
    lines.push(`#pragma config(Sensor, S${k + 1}, ${name}, ${spec.type}${mode ? `, ${mode}` : ''})`);
  });
  robot.motors.forEach((m, k) => {
    if (m === 'none') return;
    const prev = existingMotors[k]?.kind === m ? existingMotors[k] : undefined;
    const drive = k === robot.leftMotor ? 'driveLeft' : k === robot.rightMotor ? 'driveRight' : '';
    const fallback = k === robot.leftMotor ? 'leftMotor' : k === robot.rightMotor ? 'rightMotor' : m === 'medium' ? 'armMotor' : `motor${PORT_LETTERS[k]}Motor`;
    const name = unique(prev?.name ?? fallback, PORT_LETTERS[k]);
    const type = m === 'medium' ? 'tmotorEV3_Medium' : 'tmotorEV3_Large';
    lines.push(`#pragma config(Motor, motor${PORT_LETTERS[k]}, ${name}, ${type}, PIDControl${drive ? `, ${drive}` : ''}, encoder)`);
  });
  return lines;
}

const KIND_TEXT: Record<string, string> = {
  none: 'nothing',
  touch: 'a touch sensor',
  color: 'a color sensor',
  ultrasonic: 'an ultrasonic sensor',
  gyro: 'a gyro sensor',
  ir: 'an IR sensor',
  large: 'a large motor',
  medium: 'a medium motor',
};

/** Warnings on `#pragma config` lines that describe something other than what the robot has (B-9). */
export function portWarnings(robot: RobotSettings, ports: PortConfig): Diagnostic[] {
  const out: Diagnostic[] = [];
  ports.sensors.forEach((s, k) => {
    const actual = robot.sensors[k].kind;
    if (s.pragmaLine !== undefined && s.kind !== actual) {
      out.push({
        line: s.pragmaLine,
        col: 1,
        severity: 'warning',
        message: `S${k + 1}: the code expects ${KIND_TEXT[s.kind]}, but the robot has ${KIND_TEXT[actual]} on this port`,
      });
    }
  });
  ports.motors.forEach((m, k) => {
    const actual = robot.motors[k];
    if (m.pragmaLine !== undefined && m.kind !== actual) {
      out.push({
        line: m.pragmaLine,
        col: 1,
        severity: 'warning',
        message: `motor${PORT_LETTERS[k]}: the code expects ${KIND_TEXT[m.kind]}, but the robot has ${KIND_TEXT[actual]} on this port`,
      });
    }
  });
  return out;
}

/** Replaces the `#pragma config` lines at the top of the code (or inserts them). */
export function replacePragmas(code: string, lines: string[]): string {
  const src = code.split('\n');
  const kept = src.filter((l) => !/^\s*#\s*pragma\s+config\s*\(\s*(Sensor|Motor)\b/.test(l));
  // drop blank lines left at the very top
  while (kept.length && kept[0].trim() === '') kept.shift();
  return [...lines, '', ...kept].join('\n');
}
