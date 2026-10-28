import { describe, expect, it } from 'vitest';
import { compile } from './compile';
import { Hardware, SensorReading } from './hardware';
import { Interpreter } from './interpreter';
import { EXAMPLES } from '../examples';

class FakeHardware implements Hardware {
  t = 0;
  out = '';
  lcd: string[] = [];
  power = [0, 0, 0, 0];
  enc = [0, 0, 0, 0];
  sensor: Partial<Record<SensorReading, number>> = {};
  now() {
    return this.t;
  }
  setMotorPower(p: number, v: number) {
    this.power[p] = v;
  }
  getMotorPower(p: number) {
    return this.power[p];
  }
  stopMotor(p: number) {
    this.power[p] = 0;
  }
  setMotorTarget(p: number, target: number) {
    this.enc[p] = target;
  }
  isMotorBusy() {
    return false;
  }
  getEncoder(p: number) {
    return this.enc[p];
  }
  setEncoder(p: number, v: number) {
    this.enc[p] = v;
  }
  getMotorRPM() {
    return 0;
  }
  setBrakeMode() {}
  setReversed() {}
  setSync(m1: number, m2: number, _r: number, speed: number) {
    this.power[m1] = speed;
    this.power[m2] = speed;
  }
  readSensor(_p: number, what: SensorReading) {
    return this.sensor[what] ?? 0;
  }
  readColorRGB(): [number, number, number] {
    return [10, 20, 30];
  }
  resetSensor() {}
  lcdText(line: number, text: string) {
    this.lcd[line] = text;
  }
  lcdClearLine() {}
  lcdClear() {
    this.lcd = [];
  }
  debug(text: string) {
    this.out += text;
  }
  clearDebug() {
    this.out = '';
  }
  isButtonPressed() {
    return false;
  }
  setLed() {}
  playTone() {}
  playSound() {}
  setVolume() {}
  stopSounds() {}
  isSoundActive() {
    return false;
  }
}

/** Compiles and runs a program for up to `ms` simulated milliseconds. */
function run(src: string, ms = 1000, hw = new FakeHardware()) {
  const c = compile(src);
  if (!c.ok) throw new Error(c.diagnostics.map((d) => `${d.line}: ${d.message}`).join('\n'));
  const it = new Interpreter(c.program!, c.globalCount, hw);
  it.start();
  while (!it.ended && hw.t < ms) {
    it.tick();
    hw.t++;
  }
  return { hw, it, out: hw.out };
}

const errorsOf = (src: string) => compile(src).diagnostics.filter((d) => d.severity === 'error');

describe('language', () => {
  it('runs arithmetic with C integer rules', () => {
    const { out } = run(`
      task main() {
        int a = 7, b = 2;
        float f = 7 / 2.0;
        writeDebugStreamLine("%d %d %d %.2f", a / b, a % b, -7 / 2, f);
        char c = 200;
        ubyte u = 300;
        writeDebugStreamLine("%d %d", c, u);
      }`);
    expect(out).toBe('3 1 -3 3.50\n-56 44\n');
  });

  it('supports loops, switch, functions and recursion', () => {
    const { out } = run(`
      int fact(int n) { if (n <= 1) return 1; return n * fact(n - 1); }
      void inc(int &x) { x++; }
      task main() {
        int sum = 0;
        for (int i = 0; i < 10; i++) { if (i == 5) continue; sum += i; }
        int k = 0;
        while (true) { k++; if (k > 3) break; }
        do { k--; } while (k > 0);
        inc(k);
        switch (k) { case 1: writeDebugStream("one "); case 2: writeDebugStream("two "); break; default: writeDebugStream("x"); }
        writeDebugStreamLine("%d %d %d", sum, fact(5), k);
      }`);
    expect(out).toBe('one two 40 120 1\n');
  });

  it('supports arrays, strings and globals', () => {
    const { out } = run(`
      int data[5] = {3, 1, 4, 1, 5};
      int grid[2][3];
      string name = "EV3";
      int total(int a[], int n) { int s = 0; for (int i = 0; i < n; i++) s += a[i]; return s; }
      task main() {
        grid[1][2] = 9;
        string s = name + " robot";
        s += "!";
        string t;
        sprintf(t, "%s=%d", "sum", total(data, 5));
        writeDebugStreamLine("%s %s %d %d", s, t, grid[1][2], strlen(s));
      }`);
    expect(out).toBe('EV3 robot! sum=14 9 10\n');
  });

  it('reports a runtime error with its line', () => {
    const { it: interp } = run(`
      task main() {
        int a[3];
        int i = 3;
        a[i] = 1;
      }`);
    expect(interp.endReason).toBe('error');
    expect(interp.error?.line).toBe(5);
  });

  it('sleep waits simulated time and tasks run in parallel', () => {
    const { out } = run(
      `
      task blink() { while (true) { writeDebugStream("b"); sleep(100); } }
      task main() {
        startTask(blink);
        sleep(350);
        writeDebugStreamLine(" t=%d", nPgmTime);
      }`,
      2000,
    );
    expect(out).toBe('bbbb t=350\n');
  });

  it('a busy loop does not freeze the scheduler', () => {
    const { out, hw } = run(
      `
      task main() {
        clearTimer(T1);
        long n = 0;
        while (time1[T1] < 50) n++;
        writeDebugStreamLine("done");
      }`,
      1000,
    );
    expect(out).toBe('done\n');
    expect(hw.t).toBeGreaterThanOrEqual(50);
  });

  it('drives motors and reads sensors through the ROBOTC API', () => {
    const hw = new FakeHardware();
    hw.sensor.colorName = 5;
    hw.sensor.distance = 42.5;
    const { out } = run(
      `
      #pragma config(Sensor, S3, colorSensor, sensorEV3_Color)
      #define SPEED 50
      task main() {
        setMotorSpeed(motorB, SPEED);
        motor[motorC] = -SPEED * 3;
        if (getColorName(colorSensor) == colorRed) writeDebugStream("red ");
        long r, g, b;
        getColorRGB(S3, r, g, b);
        writeDebugStreamLine("%d %d %.1f", g, motor[motorC], getUSDistance(S4));
      }`,
      100,
      hw,
    );
    expect(out).toBe('red 20 -100 42.5\n');
  });

  it('stops motors when main ends', () => {
    const { hw } = run(`task main() { setMotorSpeed(motorB, 80); sleep(10); }`);
    expect(hw.power[1]).toBe(0);
  });
});

describe('examples', () => {
  it.each(EXAMPLES.map((e) => [e.id, e.code]))('example %s compiles', (_id, code) => {
    expect(errorsOf(code)).toEqual([]);
  });

  it('waitUntil re-checks its condition', () => {
    const { out } = run(`task main() { clearTimer(T1); waitUntil(time1[T1] >= 120); writeDebugStreamLine("%d", nPgmTime); }`);
    expect(out).toBe('120\n');
  });
});

describe('compile errors', () => {
  it('reports undeclared names with line numbers', () => {
    const errs = errorsOf(`task main() {\n  int x = 1;\n  y = x;\n}`);
    expect(errs).toHaveLength(1);
    expect(errs[0].line).toBe(3);
    expect(errs[0].message).toContain("'y' is not declared");
  });

  it('reports wrong argument counts and types', () => {
    const errs = errorsOf(`task main() {\n  setMotorSpeed(motorB);\n  string s = 5;\n}`);
    expect(errs.map((e) => e.line)).toEqual([2, 3]);
  });

  it('requires task main', () => {
    expect(errorsOf(`void f() {}`)[0].message).toContain('task main');
  });

  it('reports a syntax error', () => {
    const errs = errorsOf(`task main() {\n  int x = 1\n  x++;\n}`);
    expect(errs[0].line).toBe(2);
  });
});
