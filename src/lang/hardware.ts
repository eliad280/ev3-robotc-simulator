/** What a running ROBOTC program can do to the (simulated) EV3 brick. */
export interface Hardware {
  /** Simulation time in ms. */
  now(): number;

  // motors (port 0..3 = motorA..motorD)
  setMotorPower(port: number, power: number): void;
  getMotorPower(port: number): number;
  stopMotor(port: number): void;
  /** Run to an absolute encoder position at |speed|, then hold. */
  setMotorTarget(port: number, target: number, speed: number): void;
  isMotorBusy(port: number): boolean;
  getEncoder(port: number): number;
  setEncoder(port: number, value: number): void;
  getMotorRPM(port: number): number;
  setBrakeMode(port: number, brake: boolean): void;
  setReversed(port: number, reversed: boolean): void;
  /** Drive two motors together. `limit` stops both after degrees (of the faster motor) or ms. */
  setSync(m1: number, m2: number, turnRatio: number, speed: number, limit?: { kind: 'degrees' | 'time'; value: number }): void;

  // sensors (port 0..3 = S1..S4)
  readSensor(port: number, what: SensorReading): number;
  readColorRGB(port: number): [number, number, number];
  resetSensor(port: number): void;

  // brick
  lcdText(line: number, text: string, big: boolean, centered: boolean): void;
  lcdClearLine(line: number): void;
  lcdClear(): void;
  debug(text: string): void;
  clearDebug(): void;
  isButtonPressed(button: number): boolean;
  setLed(pattern: number): void;
  playTone(frequency: number, ms: number): void;
  playSound(sound: number): void;
  setVolume(volume: number): void;
  stopSounds(): void;
  isSoundActive(): boolean;
}

export type SensorReading =
  | 'value'
  | 'colorName'
  | 'reflected'
  | 'ambient'
  | 'hue'
  | 'gyroAngle'
  | 'gyroRate'
  | 'distance'
  | 'touch'
  | 'bumped'
  | 'ir';
