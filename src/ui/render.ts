import { toWorld } from '../sim/geometry';
import { MapData, Obstacle } from '../sim/map';
import { Simulation } from '../sim/simulation';
import { DRAW_ORDER, drawPart } from './parts';

export function drawObstacle(ctx: CanvasRenderingContext2D, o: Obstacle, selected = false) {
  ctx.fillStyle = o.color ?? '#6b7280';
  ctx.strokeStyle = selected ? '#2563eb' : '#374151';
  ctx.lineWidth = selected ? 0.8 : 0.4;
  ctx.beginPath();
  if (o.kind === 'rect') ctx.rect(o.x, o.y, o.w, o.h);
  else ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

export function drawMapFrame(ctx: CanvasRenderingContext2D, map: MapData, scale: number) {
  for (const o of map.obstacles) drawObstacle(ctx, o);
  ctx.strokeStyle = map.walls ? '#374151' : '#9ca3af';
  ctx.lineWidth = (map.walls ? 3 : 1) / scale;
  ctx.setLineDash(map.walls ? [] : [6 / scale, 4 / scale]);
  ctx.strokeRect(0, 0, map.width, map.height);
  ctx.setLineDash([]);
}

export function drawStartMarker(ctx: CanvasRenderingContext2D, map: MapData, scale: number, highlight = false) {
  const { x, y, heading } = map.start;
  const a = (heading * Math.PI) / 180;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.strokeStyle = highlight ? '#2563eb' : '#16a34a';
  ctx.fillStyle = highlight ? 'rgba(37,99,235,0.15)' : 'rgba(22,163,74,0.12)';
  ctx.lineWidth = 2 / scale;
  ctx.setLineDash([4 / scale, 3 / scale]);
  ctx.beginPath();
  ctx.rect(-12, -7.5, 19, 15);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(12, 0);
  ctx.moveTo(9, -3);
  ctx.lineTo(12, 0);
  ctx.lineTo(9, 3);
  ctx.stroke();
  ctx.restore();
}

export function drawGrid(ctx: CanvasRenderingContext2D, map: MapData, scale: number, step = 10) {
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 1 / scale;
  ctx.beginPath();
  for (let x = step; x < map.width; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, map.height);
  }
  for (let y = step; y < map.height; y += step) {
    ctx.moveTo(0, y);
    ctx.lineTo(map.width, y);
  }
  ctx.stroke();
}

export function drawRobot(ctx: CanvasRenderingContext2D, sim: Simulation, scale: number, showRays: boolean) {
  const r = sim.robot;
  const p = sim.pose;

  // trail
  if (sim.trail.length > 1) {
    ctx.strokeStyle = 'rgba(37,99,235,0.55)';
    ctx.lineWidth = 1.5 / scale;
    ctx.beginPath();
    ctx.moveTo(sim.trail[0][0], sim.trail[0][1]);
    for (const t of sim.trail) ctx.lineTo(t[0], t[1]);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  // the parts the robot was built from
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.heading);
  const parts = [...r.parts].sort((a, b) => DRAW_ORDER[a.kind] - DRAW_ORDER[b.kind]);
  for (const part of parts) drawPart(ctx, part, scale);
  if (sim.blocked) {
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 2.5 / scale;
    ctx.beginPath();
    r.footprint.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();

  sim.ports.sensors.forEach((s, k) => {
    const mount = r.sensors[k];
    if (s.kind === 'ultrasonic' || s.kind === 'ir') {
      if (!showRays) return;
      const { at, angle } = sim.sensorPosition(k);
      const d = sim.rangeDistance(k);
      const flat = d * Math.cos((mount.pitch * Math.PI) / 180);
      const end = [at[0] + Math.cos(angle) * flat, at[1] + Math.sin(angle) * flat];
      ctx.strokeStyle = d < 255 ? 'rgba(220,38,38,0.7)' : 'rgba(220,38,38,0.25)';
      ctx.lineWidth = 1 / scale;
      ctx.setLineDash([3 / scale, 3 / scale]);
      ctx.beginPath();
      ctx.moveTo(at[0], at[1]);
      ctx.lineTo(end[0], end[1]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (d < 255) {
        ctx.fillStyle = 'rgba(220,38,38,0.8)';
        ctx.beginPath();
        ctx.arc(end[0], end[1], 2.5 / scale + 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (s.kind === 'color') {
      // the spot the sensor reads, filled with the color it sees
      const fp = sim.floorPoint(k);
      const spot = fp && fp.dist <= 4 ? fp.point : toWorld(p, mount.at);
      const c = sim.readColorRGB(k);
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 1.5 / scale;
      ctx.beginPath();
      ctx.arc(spot[0], spot[1], 0.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (s.kind === 'touch' && sim.readSensor(k, 'touch') === 1) {
      const { at, angle } = sim.sensorPosition(k);
      const tip = mount.reach + 0.5;
      ctx.fillStyle = '#dc2626';
      ctx.beginPath();
      ctx.arc(at[0] + Math.cos(angle) * tip, at[1] + Math.sin(angle) * tip, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}
