# EV3 Simulator · ROBOTC

A browser-based simulator for the LEGO MINDSTORMS EV3 robot: write code in ROBOTC, run it on a virtual robot, build the robot from LEGO parts, and design maps. Requirements: [docs/requirements.md](docs/requirements.md).

## Running

```bash
npm install
npm run dev
```

Then open http://localhost:5173. Tests: `npm test`. Production build: `npm run build`.

## Code layout

| Folder | Contents |
| --- | --- |
| `src/lang` | The ROBOTC interpreter: lexer, parser, checker (names, types, errors with line numbers), interpreter (parallel tasks on a simulated clock) and the API list |
| `src/sim` | The robot and its world: robot design from LEGO parts, motors, differential drive, collisions, sensors (color, ultrasonic, gyro, touch, IR) with direction, tilt and height, display, buttons and sounds |
| `src/ui` | The interface: code editor (Monaco), simulation view, virtual brick, sensor readouts, Debug Stream, robot builder and map editor |

The code is not compiled to WebAssembly as first proposed in the requirements. Instead it runs on an interpreter written in TypeScript, so no compiler needs to be installed.
