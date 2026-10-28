import { useEffect, useRef } from 'react';
import { Simulation } from '../sim/simulation';

const COLOR_NAMES = ['None', 'Black', 'Blue', 'Green', 'Yellow', 'Red', 'White', 'Brown'];
const KIND_LABEL: Record<string, string> = {
  none: '—',
  touch: 'Touch',
  color: 'Color',
  ultrasonic: 'Ultrasonic',
  gyro: 'Gyro',
  ir: 'IR',
};

function sensorText(sim: Simulation, k: number): string {
  const s = sim.ports.sensors[k];
  switch (s.kind) {
    case 'touch':
      return `${sim.readSensor(k, 'touch') ? 'pressed' : 'released'} · ${sim.readSensor(k, 'bumped')} bumps`;
    case 'color': {
      const name = COLOR_NAMES[sim.readSensor(k, 'colorName')];
      return `${name} · light ${sim.readSensor(k, 'reflected')}`;
    }
    case 'ultrasonic': {
      const d = sim.readSensor(k, 'distance');
      return d >= 255 ? '255 cm (nothing)' : `${d.toFixed(1)} cm`;
    }
    case 'gyro':
      return `${sim.readSensor(k, 'gyroAngle')}° · ${sim.readSensor(k, 'gyroRate')}°/s`;
    case 'ir':
      return `proximity ${sim.readSensor(k, 'ir')}`;
    default:
      return '';
  }
}

/** Live sensor and motor values. */
export function Readouts({ sim }: { sim: Simulation }) {
  return (
    <div className="readouts">
      <table>
        <tbody>
          {sim.ports.sensors.map((s, k) => (
            <tr key={`s${k}`}>
              <th dir="ltr">S{k + 1}</th>
              <td>{KIND_LABEL[s.kind]}{s.name ? <span className="muted" dir="ltr"> {s.name}</span> : null}</td>
              <td className="num">{sensorText(sim, k)}</td>
            </tr>
          ))}
          {sim.motors.map((m, k) => (
            <tr key={`m${k}`}>
              <th dir="ltr">motor{'ABCD'[k]}</th>
              <td>{m.kind === 'medium' ? 'Medium' : m.kind === 'large' ? 'Large' : '—'}{m.reversed ? ' (reversed)' : ''}</td>
              <td className="num" dir="ltr">
                pwr {m.power} · enc {Math.round(m.encoder)}° · {Math.round(m.speed / 6)} rpm
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The ROBOTC Debug Stream window. */
export function DebugStream({ text, onClear }: { text: string; onClear: () => void }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <div className="debug">
      <div className="panel-title">
        <span>Debug Stream</span>
        <button className="small" onClick={onClear}>Clear</button>
      </div>
      <pre ref={ref} dir="ltr">{text || ' '}</pre>
    </div>
  );
}
