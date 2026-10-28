import { Part, STUD, partSize } from '../sim/design';

const PORT_LETTERS = 'ABCD';

/** Draws one LEGO part in top view, in a context whose units are cm. */
export function drawPart(ctx: CanvasRenderingContext2D, p: Part, scale: number, opts: { selected?: boolean; error?: boolean } = {}) {
  const [l, w] = partSize(p);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate((p.rot * Math.PI) / 180);
  const line = 1 / scale;
  const box = (fill: string, stroke = '#374151', r = 0.4) => {
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.roundRect(-l / 2, -w / 2, l, w, Math.min(r, l / 2, w / 2));
    ctx.fill();
    ctx.stroke();
  };
  const circle = (x: number, y: number, r: number, fill: string, stroke?: string) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = line;
      ctx.stroke();
    }
  };

  switch (p.kind) {
    case 'brick':
      box('#e5e7eb', '#4b5563', 0.8);
      ctx.fillStyle = '#9fae7a';
      ctx.fillRect(l / 2 - 5.4, -2.6, 4, 5.2); // screen
      ctx.fillStyle = '#4b5563';
      ctx.fillRect(-l / 2 + 1.2, -1.2, 2.4, 2.4); // buttons
      ctx.fillStyle = '#9ca3af';
      ctx.fillRect(-l / 2 + 1.8, -0.6, 1.2, 1.2);
      break;
    case 'largeMotor':
      box('#f9fafb', '#4b5563', 1);
      circle(l / 2 - 1.2, 0, 1, '#dc2626', '#7f1d1d');
      break;
    case 'mediumMotor':
      box('#f9fafb', '#4b5563', 0.6);
      circle(0, 0, 1, '#dc2626', '#7f1d1d');
      break;
    case 'wheel':
      box('#111827', '#000', 0.6);
      ctx.strokeStyle = '#4b5563';
      ctx.lineWidth = line;
      ctx.beginPath();
      for (let x = -l / 2 + 0.6; x < l / 2; x += 0.8) {
        ctx.moveTo(x, -w / 2 + 0.2);
        ctx.lineTo(x, w / 2 - 0.2);
      }
      ctx.stroke();
      if (p.drivenBy === undefined) circle(0, 0, 0.4, '#9ca3af');
      break;
    case 'caster':
      box('#9ca3af', '#4b5563', 0.5);
      circle(0, 0, 0.8, '#e5e7eb', '#6b7280');
      break;
    case 'beam':
      box('#4b5563', '#1f2937', STUD / 2);
      for (let k = 0; k < (p.holes ?? 5); k++) circle(-l / 2 + STUD / 2 + k * STUD, 0, 0.24, '#d1d5db');
      break;
    case 'frame':
      box('#9ca3af', '#4b5563', 0.4);
      ctx.fillStyle = '#d1d5db';
      ctx.fillRect(-l / 2 + 0.8, -w / 2 + 0.8, l - 1.6, w - 1.6);
      ctx.strokeRect(-l / 2 + 0.8, -w / 2 + 0.8, l - 1.6, w - 1.6);
      break;
    case 'touch':
      box('#f9fafb', '#4b5563');
      ctx.fillStyle = '#dc2626';
      ctx.fillRect(l / 2 - 0.6, -0.7, 1, 1.4);
      break;
    case 'color':
      box('#374151', '#111827');
      circle(l / 2 - 0.9, 0, 0.55, '#f9fafb', '#dc2626');
      break;
    case 'ultrasonic':
      box('#374151', '#111827');
      circle(l / 2 - 0.6, -1.6, 0.9, '#d1d5db', '#111827');
      circle(l / 2 - 0.6, 1.6, 0.9, '#d1d5db', '#111827');
      break;
    case 'ir':
      box('#374151', '#111827');
      circle(l / 2 - 0.6, -1.6, 0.9, '#7f1d1d', '#111827');
      circle(l / 2 - 0.6, 1.6, 0.9, '#7f1d1d', '#111827');
      break;
    case 'gyro':
      box('#f9fafb', '#4b5563');
      circle(0, 0, 0.5, '#dc2626');
      break;
  }

  // Facing of a sensor: an arrow forward, a dot when looking down, a ring when looking up.
  if (p.kind === 'color' || p.kind === 'ultrasonic' || p.kind === 'ir' || p.kind === 'touch') {
    const pitch = p.pitch ?? 0;
    ctx.strokeStyle = '#f59e0b';
    ctx.fillStyle = '#f59e0b';
    ctx.lineWidth = 2 / scale;
    if (pitch <= -30) circle(0, 0, 0.45, '#f59e0b');
    else if (pitch >= 30) {
      ctx.beginPath();
      ctx.arc(0, 0, 0.6, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(l / 2 + 0.3, 0);
      ctx.lineTo(l / 2 + 1.6, 0);
      ctx.moveTo(l / 2 + 1.1, -0.5);
      ctx.lineTo(l / 2 + 1.6, 0);
      ctx.lineTo(l / 2 + 1.1, 0.5);
      ctx.stroke();
    }
  }

  if (opts.selected || opts.error) {
    ctx.strokeStyle = opts.error ? '#dc2626' : '#2563eb';
    ctx.lineWidth = 2.5 / scale;
    ctx.setLineDash([4 / scale, 3 / scale]);
    ctx.strokeRect(-l / 2 - 0.3, -w / 2 - 0.3, l + 0.6, w + 0.6);
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/** The port tag (A..D / S1..S4) of a part; drawn after all parts so none hides it. */
export function drawPartLabel(ctx: CanvasRenderingContext2D, p: Part, scale: number) {
  if (p.port !== undefined) {
    const sensor = p.kind === 'touch' || p.kind === 'color' || p.kind === 'ultrasonic' || p.kind === 'gyro' || p.kind === 'ir';
    const text = sensor ? `S${p.port + 1}` : PORT_LETTERS[p.port];
    ctx.save();
    ctx.translate(p.x, p.y);
    const size = Math.max(1.1, 11 / scale);
    ctx.font = `bold ${size}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width + size * 0.5;
    ctx.fillStyle = sensor ? 'rgba(37,99,235,0.9)' : 'rgba(22,163,74,0.9)';
    ctx.fillRect(-tw / 2, -size * 0.65, tw, size * 1.3);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
}

/** Parts are drawn bottom-up: wheels and beams first, sensors on top. */
export const DRAW_ORDER: Record<string, number> = {
  wheel: 0,
  caster: 0,
  beam: 1,
  frame: 1,
  largeMotor: 2,
  mediumMotor: 2,
  brick: 3,
  gyro: 4,
  color: 5,
  touch: 5,
  ultrasonic: 6,
  ir: 6,
};
