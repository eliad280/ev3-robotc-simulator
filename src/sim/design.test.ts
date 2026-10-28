import { describe, expect, it } from 'vitest';
import { compile } from '../lang/compile';
import { Part, RobotDesign, deriveRobot, educatorDesign, pragmaLines, replacePragmas, twoColorDesign } from './design';
import { emptyMap } from './map';
import { Simulation, Surface } from './simulation';

const white: Surface = { sample: () => [250, 250, 250] };

/** The Educator robot with one sensor replaced. */
function withSensor(change: Partial<Part> & { kind: Part['kind'] }): RobotDesign {
  const d = educatorDesign();
  const port = change.port!;
  d.parts = d.parts.filter((p) => !(p.port === port && ['touch', 'color', 'ultrasonic', 'gyro', 'ir'].includes(p.kind)));
  d.parts.push({ id: 'test', x: 5, y: 0, rot: 0, ...change });
  return d;
}

function simWith(design: RobotDesign, map = emptyMap(300, 150)) {
  const { robot, issues } = deriveRobot(design);
  if (!robot) throw new Error(issues.map((i) => i.message).join('; '));
  return new Simulation(map, white, robot);
}

describe('robot design', () => {
  it('derives the Educator robot', () => {
    const { robot, issues } = deriveRobot(educatorDesign());
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(robot!.trackWidth).toBe(12);
    expect(robot!.leftWheelDiameter).toBe(5.6);
    expect(robot!.leftMotor).toBe(1);
    expect(robot!.rightMotor).toBe(2);
    expect(robot!.sensors.map((s) => s.kind)).toEqual(['touch', 'gyro', 'color', 'ultrasonic']);
    expect(robot!.motors).toEqual(['medium', 'large', 'large', 'none']);
  });

  it('reports a missing brick, a bad axle and port conflicts', () => {
    const d = educatorDesign();
    d.parts = d.parts.filter((p) => p.kind !== 'brick');
    d.parts.find((p) => p.kind === 'wheel' && p.drivenBy === 2)!.x = 3;
    d.parts.push({ id: 'x', kind: 'color', x: 0, y: 0, rot: 0, port: 0 });
    const { robot, issues } = deriveRobot(d);
    expect(robot).toBeUndefined();
    const msgs = issues.map((i) => i.message).join('\n');
    expect(msgs).toContain('no EV3 brick');
    expect(msgs).toContain('same axle');
    expect(msgs).toContain('S1');
  });

  it('needs two driven wheels, each on an existing motor', () => {
    const d = educatorDesign();
    d.parts.find((p) => p.kind === 'wheel')!.drivenBy = 3;
    const msgs = deriveRobot(d).issues.map((i) => i.message).join('\n');
    expect(msgs).toContain('port D');
  });

  it('uses different wheel sizes per side', () => {
    const d = educatorDesign();
    d.parts.find((p) => p.kind === 'wheel' && p.drivenBy === 1)!.wheel = '81.6x15';
    const sim = simWith(d);
    const c = compile(`task main() { setMotorSpeed(motorB, 30); setMotorSpeed(motorC, 30); sleep(1000); }`);
    sim.run(c);
    for (let k = 0; k < 1000; k++) sim.step();
    // the bigger left wheel goes further, so the robot turns right (clockwise)
    expect(sim.pose.heading).toBeGreaterThan(0.3);
  });

  it('generates #pragma config lines that compile and keep existing names', () => {
    const { robot } = deriveRobot(twoColorDesign());
    const existing = compile(`#pragma config(Sensor, S2, leftEye, sensorEV3_Color, modeEV3Color_Reflected)\ntask main() {}`).ports;
    const lines = pragmaLines(
      robot!,
      existing.sensors.map((s) => (s.pragmaLine ? { kind: s.kind, name: s.name, modeToken: s.modeToken } : undefined)),
      existing.motors.map(() => undefined),
    );
    expect(lines).toContain('#pragma config(Sensor, S2, leftEye, sensorEV3_Color, modeEV3Color_Reflected)');
    expect(lines).toContain('#pragma config(Sensor, S3, colorRight, sensorEV3_Color, modeEV3Color_Color)');
    expect(lines).toContain('#pragma config(Motor, motorB, leftMotor, tmotorEV3_Large, PIDControl, driveLeft, encoder)');
    const code = replacePragmas(`#pragma config(Sensor, S2, leftEye, sensorEV3_Color)\ntask main() { getColorReflected(leftEye); getColorName(colorRight); }`, lines);
    expect(compile(code).ok).toBe(true);
  });
});

describe('sensor orientation', () => {
  const read = (sim: Simulation, expr: string) => {
    sim.run(compile(`task main() { writeDebugStreamLine("%d", ${expr}); }`));
    for (let k = 0; k < 5; k++) sim.step();
    return Number(sim.debugText.trim());
  };

  it('a color sensor looking down reads the floor; looking up sees nothing', () => {
    expect(read(simWith(withSensor({ kind: 'color', port: 2, height: 1, pitch: -90 })), 'getColorName(S3)')).toBe(6);
    expect(read(simWith(withSensor({ kind: 'color', port: 2, height: 1, pitch: 90 })), 'getColorName(S3)')).toBe(0);
    expect(read(simWith(withSensor({ kind: 'color', port: 2, height: 1, pitch: 90 })), 'getColorAmbient(S3)')).toBe(45);
  });

  it('a color sensor mounted too high reads weak light and no color', () => {
    const high = read(simWith(withSensor({ kind: 'color', port: 2, height: 3, pitch: -90 })), 'getColorReflected(S3)');
    const low = read(simWith(withSensor({ kind: 'color', port: 2, height: 1, pitch: -90 })), 'getColorReflected(S3)');
    expect(high).toBeLessThan(low);
    expect(read(simWith(withSensor({ kind: 'color', port: 2, height: 3, pitch: -90 })), 'getColorName(S3)')).toBe(0);
  });

  it('a color sensor facing forward reads the color of an obstacle in front of it', () => {
    const map = emptyMap(300, 150);
    map.obstacles.push({ kind: 'rect', x: 37, y: 60, w: 10, h: 30, color: '#1976d2' });
    // sensor at x = 30 + 5, its face 1.6 cm further: about 0.4 cm from the box
    expect(read(simWith(withSensor({ kind: 'color', port: 2, height: 2, pitch: 0 }), map), 'getColorName(S3)')).toBe(2);
  });

  it('an ultrasonic sensor pointing down measures its height', () => {
    expect(read(simWith(withSensor({ kind: 'ultrasonic', port: 3, height: 8, pitch: -90 })), 'getUSDistance(S4)')).toBe(8);
  });

  it('an ultrasonic sensor does not see an obstacle lower than itself', () => {
    const map = emptyMap(300, 150);
    map.walls = false;
    map.obstacles.push({ kind: 'rect', x: 80, y: 0, w: 10, h: 150, height: 5 });
    expect(read(simWith(withSensor({ kind: 'ultrasonic', port: 3, height: 7, pitch: 0 }), map), 'getUSDistance(S4)')).toBe(255);
    expect(read(simWith(withSensor({ kind: 'ultrasonic', port: 3, height: 3, pitch: 0 }), map), 'getUSDistance(S4)')).toBe(45);
  });

  it('a sensor facing sideways looks sideways', () => {
    // robot at y = 75 on a 150 cm map: the wall to the right is 75 cm away
    expect(read(simWith(withSensor({ kind: 'ultrasonic', port: 3, x: 0, y: 0, rot: 90, height: 7, pitch: 0 })), 'getUSDistance(S4)')).toBe(75);
  });

  it('a gyro lying on its side does not measure turning', () => {
    const sim = simWith(withSensor({ kind: 'gyro', port: 1, height: 5, pitch: 90 }));
    sim.run(compile(`task main() { setMotorSpeed(motorB, 30); setMotorSpeed(motorC, -30); sleep(500); writeDebugStreamLine("%d", getGyroDegrees(S2)); }`));
    for (let k = 0; k < 600; k++) sim.step();
    expect(Number(sim.debugText.trim())).toBe(0);
  });
});
