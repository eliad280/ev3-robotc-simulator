import { describe, expect, it } from 'vitest';
import { compile } from '../lang/compile';
import { EXAMPLES } from '../examples';
import { defaultMap, emptyMap, MapData, PathStroke } from './map';
import { Simulation, Surface, classifyColor } from './simulation';

/** White floor with a black horizontal band 4 cm tall at y = 70..74. */
const bandSurface = (map: MapData): Surface => ({
  sample: (x, y) => {
    if (x < 0 || y < 0 || x > map.width || y > map.height) return null;
    return y >= 70 && y <= 74 ? [20, 20, 20] : [245, 245, 245];
  },
});

function runSim(src: string, ms: number, map = emptyMap(300, 150)) {
  const sim = new Simulation(map, bandSurface(map));
  const c = compile(src);
  if (!c.ok) throw new Error(c.diagnostics.map((d) => `${d.line}: ${d.message}`).join('\n'));
  sim.run(c);
  for (let k = 0; k < ms; k++) sim.step();
  return sim;
}

describe('simulation', () => {
  it('drives straight at the expected speed', () => {
    const sim = runSim(`task main() { setMotorSpeed(motorB, 50); setMotorSpeed(motorC, 50); sleep(2000); }`, 2000);
    // 50% of 1050 deg/s on 5.6 cm wheels = 25.7 cm/s
    expect(sim.pose.x - 30).toBeGreaterThan(48);
    expect(sim.pose.x - 30).toBeLessThan(53);
    expect(Math.abs(sim.pose.y - 75)).toBeLessThan(0.01);
  });

  it('turns in place and the gyro measures it (clockwise positive)', () => {
    const sim = runSim(
      `task main() {
        resetGyro(S2);
        setMotorSpeed(motorB, 30); setMotorSpeed(motorC, -30);
        while (getGyroDegrees(S2) < 90) sleep(1);
        stopAllMotors();
        sleep(300);
        writeDebugStreamLine("%d", getGyroDegrees(S2));
      }`,
      5000,
    );
    const angle = Number(sim.debugText.trim());
    expect(angle).toBeGreaterThanOrEqual(90);
    expect(angle).toBeLessThan(100);
    expect(sim.status).toBe('done');
  });

  it('moveMotorTarget stops on the target', () => {
    const sim = runSim(
      `task main() {
        moveMotorTarget(motorA, 360, 50);
        waitUntilMotorStop(motorA);
        writeDebugStreamLine("%d", getMotorEncoder(motorA));
      }`,
      5000,
    );
    expect(Number(sim.debugText.trim())).toBeCloseTo(360, -1);
  });

  it('stops at a wall and the touch sensor feels it', () => {
    const sim = runSim(
      `task main() {
        setMotorSpeed(motorB, 60); setMotorSpeed(motorC, 60);
        while (getTouchValue(S1) == 0) sleep(1);
        stopAllMotors();
        writeDebugStreamLine("hit %d", getBumpedValue(S1));
      }`,
      30000,
    );
    expect(sim.debugText).toBe('hit 1\n');
    expect(sim.pose.x).toBeGreaterThan(280);
  });

  it('sees the wall with the ultrasonic sensor', () => {
    const map = emptyMap(300, 150);
    const sim = runSim(`task main() { writeDebugStreamLine("%.0f", getUSDistance(S4)); }`, 10, map);
    // robot at x=30, sensor 5.6 cm ahead of the axle; wall at x=300
    expect(Number(sim.debugText.trim())).toBe(255);
    map.start.x = 200;
    const sim2 = runSim(`task main() { writeDebugStreamLine("%.1f", getUSDistance(S4)); }`, 10, map);
    expect(Number(sim2.debugText.trim())).toBe(94.4);
  });

  it('follows a line with the color sensor', () => {
    const map = emptyMap(300, 150);
    map.start = { x: 20, y: 72, heading: 0 };
    const sim = runSim(
      `task main() {
        while (true) {
          if (getColorReflected(S3) < 40) { setMotorSpeed(motorB, 30); setMotorSpeed(motorC, 15); }
          else { setMotorSpeed(motorB, 15); setMotorSpeed(motorC, 30); }
          sleep(5);
        }
      }`,
      6000,
      map,
    );
    expect(sim.pose.x).toBeGreaterThan(80);
    expect(Math.abs(sim.pose.y - 72)).toBeLessThan(8);
  });

  it('the line-follower example goes around the default track', () => {
    const map = defaultMap();
    const path = (map.strokes[0] as PathStroke).points;
    const nearLine = (x: number, y: number) => {
      for (let k = 1; k < path.length; k++) {
        const [ax, ay] = path[k - 1];
        const [bx, by] = path[k];
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
        if (Math.hypot(ax + t * dx - x, ay + t * dy - y) <= 1.25) return true;
      }
      return false;
    };
    const surface: Surface = { sample: (x, y) => (nearLine(x, y) ? [17, 17, 17] : [255, 255, 255]) };
    const sim = new Simulation(map, surface);
    sim.run(compile(EXAMPLES[0].code));
    let maxX = 0;
    let maxY = 0;
    for (let k = 0; k < 40000; k++) {
      sim.step();
      maxX = Math.max(maxX, sim.pose.x);
      maxY = Math.max(maxY, sim.pose.y);
    }
    // reached the right end and the bottom of the oval, and never hit anything
    expect(maxX).toBeGreaterThan(185);
    expect(maxY).toBeGreaterThan(118);
    expect(sim.status).toBe('running');
  });

  it('warns when a sensor is read on the wrong port', () => {
    const sim = runSim(`task main() { getColorName(S1); }`, 10);
    expect(sim.debugText).toContain('S1 is a touch sensor, not a color sensor');
  });

  it('classifies LEGO colors', () => {
    expect(classifyColor(10, 10, 10)).toBe(1);
    expect(classifyColor(250, 250, 250)).toBe(6);
    expect(classifyColor(210, 40, 40)).toBe(5);
    expect(classifyColor(30, 120, 210)).toBe(2);
    expect(classifyColor(50, 140, 60)).toBe(3);
    expect(classifyColor(250, 200, 40)).toBe(4);
  });
});
