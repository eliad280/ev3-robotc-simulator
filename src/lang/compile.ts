import { Program } from './ast';
import { check } from './checker';
import { CompileError, Diagnostic } from './errors';
import { lex, PragmaConfig } from './lexer';
import { parse } from './parser';
import { CONSTANTS, MOTOR_PORTS, SENSOR_PORTS } from './robotc-api';

export type SensorKind = 'none' | 'touch' | 'color' | 'ultrasonic' | 'gyro' | 'ir';
export type ColorMode = 'reflected' | 'ambient' | 'color' | 'rgb';

export interface SensorConfig {
  kind: SensorKind;
  /** For the color sensor: what SensorValue[] returns. Gyro: 'angle' or 'rate'. */
  mode: string;
  name?: string;
  /** Set when a `#pragma config` line configured this port. */
  pragmaLine?: number;
  /** The mode token as written in the pragma (e.g. modeEV3Color_Reflected). */
  modeToken?: string;
}

export interface MotorConfig {
  kind: 'large' | 'medium' | 'none';
  reversed: boolean;
  name?: string;
  pragmaLine?: number;
}

/** Default measuring mode for a sensor kind when the code does not choose one. */
export function defaultMode(kind: SensorKind): string {
  return kind === 'color' ? 'color' : kind === 'gyro' ? 'angle' : kind === 'ultrasonic' ? 'cm' : kind === 'touch' ? 'touch' : '';
}

export interface PortConfig {
  sensors: SensorConfig[];
  motors: MotorConfig[];
}

/** The EV3 Educator robot: touch S1, gyro S2, color S3, ultrasonic S4; medium motor on A, drive on B and C. */
export function defaultPorts(): PortConfig {
  return {
    sensors: [
      { kind: 'touch', mode: 'touch' },
      { kind: 'gyro', mode: 'angle' },
      { kind: 'color', mode: 'color' },
      { kind: 'ultrasonic', mode: 'cm' },
    ],
    motors: [
      { kind: 'medium', reversed: false },
      { kind: 'large', reversed: false },
      { kind: 'large', reversed: false },
      { kind: 'large', reversed: false },
    ],
  };
}

export interface CompileResult {
  ok: boolean;
  program?: Program;
  globalCount: number;
  ports: PortConfig;
  diagnostics: Diagnostic[];
}

const SENSOR_KIND: Record<string, SensorKind> = {
  sensorNone: 'none',
  sensorEV3_Touch: 'touch',
  sensorEV3_Color: 'color',
  sensorEV3_Ultrasonic: 'ultrasonic',
  sensorEV3_Gyro: 'gyro',
  sensorEV3_IRSensor: 'ir',
};

const MODE: Record<string, string> = {
  modeEV3Color_Reflected: 'reflected',
  modeEV3Color_Ambient: 'ambient',
  modeEV3Color_Color: 'color',
  modeEV3Color_RGB_Raw: 'rgb',
  modeEV3Gyro_Angle: 'angle',
  modeEV3Gyro_Rate: 'rate',
  modeEV3Gyro_RateAndAngle: 'angle',
};

function applyPragmas(pragmas: PragmaConfig[], ports: PortConfig, aliases: Map<string, number>, diags: Diagnostic[]) {
  for (const p of pragmas) {
    const [what, port, name, type, ...opts] = p.args;
    const warn = (message: string) => diags.push({ line: p.line, col: 1, severity: 'warning', message });
    if (what === 'Sensor') {
      const idx = SENSOR_PORTS.indexOf(port);
      if (idx < 0) {
        warn(`Unknown sensor port '${port}' in #pragma config`);
        continue;
      }
      const kind = SENSOR_KIND[type];
      if (!kind) {
        warn(`Sensor type '${type}' is not simulated; port ${port} is left empty`);
        ports.sensors[idx] = { kind: 'none', mode: '', name, pragmaLine: p.line };
        continue;
      }
      const modeToken = opts.find((o) => MODE[o]);
      const mode = modeToken ? MODE[modeToken] : defaultMode(kind);
      ports.sensors[idx] = {
        kind,
        mode: kind === 'color' ? (['reflected', 'ambient', 'color', 'rgb'].includes(mode) ? mode : 'color') : kind === 'gyro' ? (mode === 'rate' ? 'rate' : 'angle') : mode,
        name,
        pragmaLine: p.line,
        modeToken,
      };
      if (name && name !== port) aliases.set(name, idx);
    } else if (what === 'Motor') {
      const idx = MOTOR_PORTS.indexOf(port);
      if (idx < 0) {
        warn(`Unknown motor port '${port}' in #pragma config`);
        continue;
      }
      const kind = type === 'tmotorEV3_Medium' ? 'medium' : type === 'tmotorNone' ? 'none' : 'large';
      ports.motors[idx] = { kind, reversed: opts.includes('reversed'), name, pragmaLine: p.line };
      if (name && name !== port) aliases.set(name, idx);
    }
    // StandardModel, Hubs, etc. have no effect here.
  }
}

export function compile(source: string): CompileResult {
  const ports = defaultPorts();
  const diagnostics: Diagnostic[] = [];
  try {
    const lexed = lex(source);
    diagnostics.push(...lexed.warnings);
    const aliases = new Map<string, number>();
    applyPragmas(lexed.pragmas, ports, aliases, diagnostics);
    for (const name of aliases.keys()) {
      if (name in CONSTANTS) aliases.delete(name);
    }
    const { program, enumConsts } = parse(lexed.tokens, lexed.defines, aliases);
    const consts = new Map([...aliases, ...enumConsts]);
    const { diagnostics: errs, globalCount } = check(program, consts);
    diagnostics.push(...errs);
    diagnostics.sort((a, b) => a.line - b.line || a.col - b.col);
    const ok = !diagnostics.some((d) => d.severity === 'error');
    return { ok, program: ok ? program : undefined, globalCount, ports, diagnostics };
  } catch (e) {
    if (e instanceof CompileError) {
      diagnostics.push({ line: e.line, col: e.col, message: e.message, severity: 'error' });
      return { ok: false, globalCount: 0, ports, diagnostics };
    }
    throw e;
  }
}
