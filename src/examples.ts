export interface Example {
  id: string;
  title: string;
  code: string;
}

export const EXAMPLES: Example[] = [
  {
    id: 'line',
    title: 'Line follower (P controller)',
    code: `#pragma config(Sensor, S3, colorSensor, sensorEV3_Color, modeEV3Color_Reflected)
#pragma config(Motor, motorB, leftMotor, tmotorEV3_Large, PIDControl, driveLeft, encoder)
#pragma config(Motor, motorC, rightMotor, tmotorEV3_Large, PIDControl, driveRight, encoder)

// Follows the left edge of a black line.
task main()
{
  int target = 48;    // halfway between black (~9) and white (~87)
  float kp = 0.6;
  int baseSpeed = 25;

  while (true)
  {
    int light = getColorReflected(colorSensor);
    float turn = kp * (light - target);

    setMotorSpeed(leftMotor, baseSpeed + turn);
    setMotorSpeed(rightMotor, baseSpeed - turn);

    displayTextLine(1, "Light: %d", light);
    displayTextLine(2, "Turn:  %.1f", turn);
    sleep(10);
  }
}
`,
  },
  {
    id: 'square',
    title: 'Drive a square with the gyro',
    code: `#pragma config(Sensor, S2, gyro, sensorEV3_Gyro, modeEV3Gyro_RateAndAngle)

void driveForward(int degrees)
{
  resetMotorEncoder(motorB);
  setMotorSync(motorB, motorC, 0, 40);
  while (getMotorEncoder(motorB) < degrees)
    sleep(1);
  stopAllMotors();
  sleep(200);
}

void turnRight(int angle)
{
  int start = getGyroDegrees(gyro);
  setMotorSpeed(motorB, 20);
  setMotorSpeed(motorC, -20);
  while (getGyroDegrees(gyro) - start < angle)
    sleep(1);
  stopAllMotors();
  sleep(200);
}

task main()
{
  resetGyro(gyro);
  for (int side = 0; side < 4; side++)
  {
    displayBigTextLine(2, "Side %d", side + 1);
    driveForward(720);
    turnRight(90);
  }
  playSound(soundUpwardTones);
  writeDebugStreamLine("Done! Gyro: %d", getGyroDegrees(gyro));
}
`,
  },
  {
    id: 'avoid',
    title: 'Obstacle avoidance (ultrasonic)',
    code: `#pragma config(Sensor, S4, sonar, sensorEV3_Ultrasonic)

task main()
{
  while (true)
  {
    float distance = getUSDistance(sonar);
    displayTextLine(1, "Distance: %.1f cm", distance);

    if (distance < 25)
    {
      setLEDColor(ledRed);
      setMotorSpeed(motorB, -30);
      setMotorSpeed(motorC, -30);
      sleep(400);
      setMotorSpeed(motorB, 30);
      setMotorSpeed(motorC, -30);
      sleep(450);
    }
    else
    {
      setLEDColor(ledGreen);
      setMotorSpeed(motorB, 40);
      setMotorSpeed(motorC, 40);
    }
    sleep(10);
  }
}
`,
  },
  {
    id: 'bumper',
    title: 'Touch sensor bumper',
    code: `#pragma config(Sensor, S1, bumper, sensorEV3_Touch)

task main()
{
  while (getBumpedValue(bumper) < 3)
  {
    setMotorSpeed(motorB, 50);
    setMotorSpeed(motorC, 50);
    waitUntil(getTouchValue(bumper) == 1);
    playTone(440, 20);

    // back up and turn a random amount
    setMotorSpeed(motorB, -40);
    setMotorSpeed(motorC, -40);
    sleep(500);
    setMotorSpeed(motorB, 40);
    setMotorSpeed(motorC, -40);
    sleep(300 + random(500));
    displayTextLine(1, "Bumps: %d", getBumpedValue(bumper));
  }
  stopAllMotors();
  displayBigTextLine(4, "Finished");
}
`,
  },
  {
    id: 'colors',
    title: 'Color detection',
    code: `#pragma config(Sensor, S3, colorSensor, sensorEV3_Color, modeEV3Color_Color)

string colorName(int c)
{
  switch (c)
  {
    case colorBlack:  return "Black";
    case colorBlue:   return "Blue";
    case colorGreen:  return "Green";
    case colorYellow: return "Yellow";
    case colorRed:    return "Red";
    case colorWhite:  return "White";
    case colorBrown:  return "Brown";
  }
  return "None";
}

task main()
{
  int last = -1;
  setMotorSpeed(motorB, 20);
  setMotorSpeed(motorC, 20);
  while (true)
  {
    int c = getColorName(colorSensor);
    if (c != last)
    {
      writeDebugStreamLine("%5d ms: %s", nPgmTime, colorName(c));
      displayBigTextLine(3, "%s", colorName(c));
      last = c;
    }
    sleep(20);
  }
}
`,
  },
  {
    id: 'tasks',
    title: 'Parallel tasks and buttons',
    code: `int speed = 30;

task blink()
{
  while (true)
  {
    setLEDColor(ledGreen);
    sleep(300);
    setLEDColor(ledOrange);
    sleep(300);
  }
}

task main()
{
  startTask(blink);
  displayTextLine(1, "Up/Down: speed");
  displayTextLine(2, "Enter: stop");

  while (!getButtonPress(buttonEnter))
  {
    if (getButtonPress(buttonUp) && speed < 100) speed += 10;
    if (getButtonPress(buttonDown) && speed > -100) speed -= 10;
    setMotorSpeed(motorB, speed);
    setMotorSpeed(motorC, speed);
    displayBigTextLine(5, "Speed %d", speed);
    sleep(150);
  }
  stopTask(blink);
  setLEDColor(ledOff);
}
`,
  },
];

export const DEFAULT_CODE = EXAMPLES[0].code;
