/**
 * The ROBOTC for EV3 surface the simulator understands: built-in constants, system
 * variables and arrays, and function signatures. Implementations live in interpreter.ts.
 */
import { Kind } from './ast';

export const MOTOR_PORTS = ['motorA', 'motorB', 'motorC', 'motorD'];
export const SENSOR_PORTS = ['S1', 'S2', 'S3', 'S4'];

export const COLORS = {
  colorNone: 0,
  colorBlack: 1,
  colorBlue: 2,
  colorGreen: 3,
  colorYellow: 4,
  colorRed: 5,
  colorWhite: 6,
  colorBrown: 7,
};

export const BUTTONS = {
  buttonNone: 0,
  buttonUp: 1,
  buttonEnter: 2,
  buttonDown: 3,
  buttonRight: 4,
  buttonLeft: 5,
  buttonBack: 6,
  buttonAny: 7,
};

export const LED_PATTERNS = {
  ledOff: 0,
  ledGreen: 1,
  ledRed: 2,
  ledOrange: 3,
  ledGreenFlash: 4,
  ledRedFlash: 5,
  ledOrangeFlash: 6,
  ledGreenPulse: 7,
  ledRedPulse: 8,
  ledOrangePulse: 9,
};

export const SOUNDS = {
  soundBlip: 0,
  soundBeepBeep: 1,
  soundDownwardTones: 2,
  soundUpwardTones: 3,
  soundLowBuzz: 4,
  soundFastUpwardTones: 5,
  soundShortBlip: 6,
  soundException: 7,
};

/** Sensor types accepted in `#pragma config(Sensor, ...)`. */
export const SENSOR_TYPES = {
  sensorNone: 0,
  sensorEV3_Touch: 1,
  sensorEV3_Color: 2,
  sensorEV3_Ultrasonic: 3,
  sensorEV3_Gyro: 4,
  sensorEV3_IRSensor: 5,
};

export const SENSOR_MODES = {
  modeEV3Color_Reflected: 0,
  modeEV3Color_Ambient: 1,
  modeEV3Color_Color: 2,
  modeEV3Color_RGB_Raw: 4,
  modeEV3Gyro_Angle: 0,
  modeEV3Gyro_Rate: 1,
  modeEV3Gyro_RateAndAngle: 3,
  modeEV3Ultrasonic_Cm: 0,
  modeEV3Touch_Touch: 0,
  modeEV3IR_Proximity: 0,
};

export const MOTOR_TYPES = {
  tmotorEV3_Large: 1,
  tmotorEV3_Medium: 2,
};

export const CONSTANTS: Record<string, number> = {
  motorA: 0,
  motorB: 1,
  motorC: 2,
  motorD: 3,
  S1: 0,
  S2: 1,
  S3: 2,
  S4: 3,
  T1: 0,
  T2: 1,
  T3: 2,
  T4: 3,
  motorBrake: 1,
  motorCoast: 0,
  NULL: 0,
  PI: Math.PI,
  ...COLORS,
  ...BUTTONS,
  ...LED_PATTERNS,
  ...SOUNDS,
  ...SENSOR_TYPES,
  ...MOTOR_TYPES,
};

/** Read-only (or writable where noted) system variables. */
export const SYS_VARS: Record<string, { kind: Kind; writable?: boolean; doc: string }> = {
  nSysTime: { kind: 'int', doc: 'Milliseconds since the brick (simulator) started' },
  nPgmTime: { kind: 'int', doc: 'Milliseconds since the program started' },
  bSoundActive: { kind: 'bool', doc: 'True while a sound is playing' },
  nImmediateBatteryLevel: { kind: 'int', doc: 'Battery level in millivolts (always 8000 in the simulator)' },
};

/** System arrays indexed by a port or timer: `motor[motorB] = 50`, `SensorValue[S1]`. */
export const SYS_ARRAYS: Record<string, { kind: Kind; writable: boolean; doc: string }> = {
  motor: { kind: 'int', writable: true, doc: 'Motor power -100..100' },
  nMotorEncoder: { kind: 'int', writable: true, doc: 'Motor encoder in degrees (write 0 to reset)' },
  SensorValue: { kind: 'int', writable: true, doc: 'Sensor value in the configured mode (write 0 to reset)' },
  time1: { kind: 'int', writable: true, doc: 'Timer value in 1 ms units' },
  time10: { kind: 'int', writable: true, doc: 'Timer value in 10 ms units' },
  time100: { kind: 'int', writable: true, doc: 'Timer value in 100 ms units' },
};

/**
 * Parameter kinds:
 *  n    a number
 *  s    a string
 *  fmt  a printf-style format string; the remaining arguments are its values
 *  ref  a numeric variable passed by reference (getColorRGB)
 *  sref a string variable passed by reference (sprintf, strcat)
 *  task a task name (startTask)
 */
export type ParamKind = 'n' | 's' | 'fmt' | 'ref' | 'sref' | 'task';

export interface BuiltinSpec {
  params: ParamKind[];
  /** Number of trailing optional parameters. */
  optional?: number;
  ret: Kind;
  /** Calling it can suspend the task (sleep, wait...). */
  yields?: boolean;
  doc: string;
}

const fn = (params: ParamKind[], ret: Kind, doc: string, extra: Partial<BuiltinSpec> = {}): BuiltinSpec => ({
  params,
  ret,
  doc,
  ...extra,
});

export const BUILTINS: Record<string, BuiltinSpec> = {
  // ---- motors ----
  setMotorSpeed: fn(['n', 'n'], 'void', 'setMotorSpeed(motor, speed): run a motor at -100..100'),
  setMotor: fn(['n', 'n'], 'void', 'setMotor(motor, speed): same as setMotorSpeed'),
  stopMotor: fn(['n'], 'void', 'stopMotor(motor): stop one motor'),
  stopAllMotors: fn([], 'void', 'stopAllMotors(): stop every motor'),
  setMotorTarget: fn(['n', 'n', 'n'], 'void', 'setMotorTarget(motor, position, speed): move to an absolute encoder position (degrees)'),
  moveMotorTarget: fn(['n', 'n', 'n'], 'void', 'moveMotorTarget(motor, degrees, speed): move a relative number of degrees'),
  waitUntilMotorStop: fn(['n'], 'void', 'waitUntilMotorStop(motor): wait until a target move finishes', { yields: true }),
  getMotorEncoder: fn(['n'], 'float', 'getMotorEncoder(motor): encoder position in degrees'),
  resetMotorEncoder: fn(['n'], 'void', 'resetMotorEncoder(motor): set the encoder to 0'),
  getMotorRunning: fn(['n'], 'bool', 'getMotorRunning(motor): true while the motor is moving'),
  getMotorSpeed: fn(['n'], 'int', 'getMotorSpeed(motor): the speed last set (-100..100)'),
  getMotorRPM: fn(['n'], 'float', 'getMotorRPM(motor): measured speed in rotations per minute'),
  setMotorBrakeMode: fn(['n', 'n'], 'void', 'setMotorBrakeMode(motor, motorBrake | motorCoast)'),
  setMotorReversed: fn(['n', 'n'], 'void', 'setMotorReversed(motor, true|false)'),
  setMotorSync: fn(['n', 'n', 'n', 'n'], 'void', 'setMotorSync(motor1, motor2, turnRatio, speed): drive two motors together; turnRatio -100..100'),
  setMotorSyncEncoder: fn(['n', 'n', 'n', 'n', 'n'], 'void', 'setMotorSyncEncoder(motor1, motor2, turnRatio, degrees, speed)'),
  setMotorSyncTime: fn(['n', 'n', 'n', 'n', 'n'], 'void', 'setMotorSyncTime(motor1, motor2, turnRatio, timeMs, speed)'),

  // ---- sensors ----
  getColorName: fn(['n'], 'int', 'getColorName(sensor): colorBlack, colorWhite, colorRed...'),
  getColorReflected: fn(['n'], 'int', 'getColorReflected(sensor): reflected light 0..100'),
  getColorAmbient: fn(['n'], 'int', 'getColorAmbient(sensor): ambient light 0..100'),
  getColorRGB: fn(['n', 'ref', 'ref', 'ref'], 'void', 'getColorRGB(sensor, r, g, b): raw color components 0..255'),
  getColorHue: fn(['n'], 'int', 'getColorHue(sensor): hue 0..360'),
  getGyroDegrees: fn(['n'], 'int', 'getGyroDegrees(sensor): angle since reset, clockwise positive'),
  getGyroHeading: fn(['n'], 'int', 'getGyroHeading(sensor): angle since reset, 0..359'),
  getGyroRate: fn(['n'], 'int', 'getGyroRate(sensor): turn rate in degrees per second'),
  resetGyro: fn(['n'], 'void', 'resetGyro(sensor): set the gyro angle to 0'),
  getUSDistance: fn(['n'], 'float', 'getUSDistance(sensor): distance in cm (255 = nothing seen)'),
  getTouchValue: fn(['n'], 'int', 'getTouchValue(sensor): 1 while pressed, else 0'),
  getBumpedValue: fn(['n'], 'int', 'getBumpedValue(sensor): number of presses since reset'),
  resetBumpedValue: fn(['n'], 'void', 'resetBumpedValue(sensor): set the press count to 0'),
  getIRDistance: fn(['n'], 'int', 'getIRDistance(sensor): proximity 0..100'),
  getSensorValue: fn(['n'], 'int', 'getSensorValue(sensor): value in the configured mode'),
  resetSensor: fn(['n'], 'void', 'resetSensor(sensor): reset the gyro angle / touch counter'),

  // ---- timing ----
  sleep: fn(['n'], 'void', 'sleep(ms): wait this many milliseconds', { yields: true }),
  waitUntil: fn(['n'], 'void', 'waitUntil(condition): wait until the condition is true', { yields: true }),
  wait1Msec: fn(['n'], 'void', 'wait1Msec(ms): wait this many milliseconds', { yields: true }),
  wait10Msec: fn(['n'], 'void', 'wait10Msec(n): wait n × 10 milliseconds', { yields: true }),
  wait: fn(['n'], 'void', 'wait(seconds): wait this many seconds', { yields: true }),
  clearTimer: fn(['n'], 'void', 'clearTimer(T1): reset a timer to 0'),
  getTimerValue: fn(['n'], 'int', 'getTimerValue(T1): timer value in ms'),

  // ---- tasks ----
  startTask: fn(['task'], 'void', 'startTask(name): run a task in parallel'),
  stopTask: fn(['task'], 'void', 'stopTask(name): stop a running task'),
  stopAllTasks: fn([], 'void', 'stopAllTasks(): end the program'),
  abortTimeslice: fn([], 'void', 'abortTimeslice(): let other tasks run now', { yields: true }),
  releaseCPU: fn([], 'void', 'releaseCPU(): let other tasks run now', { yields: true }),
  EndTimeSlice: fn([], 'void', 'EndTimeSlice(): let other tasks run now', { yields: true }),

  // ---- display ----
  displayTextLine: fn(['n', 'fmt'], 'void', 'displayTextLine(line, format, ...): print on the LCD (lines 0..15)'),
  displayBigTextLine: fn(['n', 'fmt'], 'void', 'displayBigTextLine(line, format, ...): print in large font'),
  displayCenteredTextLine: fn(['n', 'fmt'], 'void', 'displayCenteredTextLine(line, format, ...)'),
  displayCenteredBigTextLine: fn(['n', 'fmt'], 'void', 'displayCenteredBigTextLine(line, format, ...)'),
  displayString: fn(['n', 'fmt'], 'void', 'displayString(line, format, ...)'),
  displayClearTextLine: fn(['n'], 'void', 'displayClearTextLine(line): clear one line'),
  eraseDisplay: fn([], 'void', 'eraseDisplay(): clear the LCD'),

  // ---- debug stream ----
  writeDebugStream: fn(['fmt'], 'void', 'writeDebugStream(format, ...): print to the Debug Stream'),
  writeDebugStreamLine: fn(['fmt'], 'void', 'writeDebugStreamLine(format, ...): print a line to the Debug Stream'),
  clearDebugStream: fn([], 'void', 'clearDebugStream(): clear the Debug Stream'),

  // ---- buttons, LED, sound ----
  getButtonPress: fn(['n'], 'bool', 'getButtonPress(buttonEnter): true while the brick button is pressed'),
  waitForButtonPress: fn([], 'void', 'waitForButtonPress(): wait until any brick button is pressed', { yields: true }),
  setLEDColor: fn(['n'], 'void', 'setLEDColor(ledGreen | ledRed | ledOrange | ledOff ...)'),
  playTone: fn(['n', 'n'], 'void', 'playTone(frequency, duration10ms)'),
  playSound: fn(['n'], 'void', 'playSound(soundBeepBeep ...)'),
  setSoundVolume: fn(['n'], 'void', 'setSoundVolume(0..100)'),
  clearSounds: fn([], 'void', 'clearSounds(): stop sounds'),

  // ---- math ----
  abs: fn(['n'], 'float', 'abs(x)'),
  fabs: fn(['n'], 'float', 'fabs(x)'),
  sgn: fn(['n'], 'int', 'sgn(x): -1, 0 or 1'),
  sqrt: fn(['n'], 'float', 'sqrt(x)'),
  pow: fn(['n', 'n'], 'float', 'pow(x, y)'),
  exp: fn(['n'], 'float', 'exp(x)'),
  log: fn(['n'], 'float', 'log(x): natural logarithm'),
  log10: fn(['n'], 'float', 'log10(x)'),
  sin: fn(['n'], 'float', 'sin(radians)'),
  cos: fn(['n'], 'float', 'cos(radians)'),
  tan: fn(['n'], 'float', 'tan(radians)'),
  asin: fn(['n'], 'float', 'asin(x)'),
  acos: fn(['n'], 'float', 'acos(x)'),
  atan: fn(['n'], 'float', 'atan(x)'),
  atan2: fn(['n', 'n'], 'float', 'atan2(y, x)'),
  sinDegrees: fn(['n'], 'float', 'sinDegrees(degrees)'),
  cosDegrees: fn(['n'], 'float', 'cosDegrees(degrees)'),
  radiansToDegrees: fn(['n'], 'float', 'radiansToDegrees(x)'),
  degreesToRadians: fn(['n'], 'float', 'degreesToRadians(x)'),
  round: fn(['n'], 'int', 'round(x)'),
  floor: fn(['n'], 'float', 'floor(x)'),
  ceil: fn(['n'], 'float', 'ceil(x)'),
  min: fn(['n', 'n'], 'float', 'min(a, b)'),
  max: fn(['n', 'n'], 'float', 'max(a, b)'),
  random: fn(['n'], 'int', 'random(n): random integer 0..n'),
  srand: fn(['n'], 'void', 'srand(seed)'),

  // ---- strings ----
  strlen: fn(['s'], 'int', 'strlen(s)'),
  strcat: fn(['sref', 's'], 'void', 'strcat(dest, src): append src to dest'),
  strcpy: fn(['sref', 's'], 'void', 'strcpy(dest, src)'),
  strcmp: fn(['s', 's'], 'int', 'strcmp(a, b)'),
  sprintf: fn(['sref', 'fmt'], 'void', 'sprintf(dest, format, ...)'),
  atoi: fn(['s'], 'int', 'atoi(s)'),
  atof: fn(['s'], 'float', 'atof(s)'),
};

/** Builtins whose return kind follows their argument (abs(int) is int). */
export const RETURNS_ARG_KIND = new Set(['abs', 'min', 'max']);
