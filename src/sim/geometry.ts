import { DEFAULT_OBSTACLE_COLOR, DEFAULT_OBSTACLE_HEIGHT, DEFAULT_WALL_HEIGHT, MapData, Obstacle, WALL_COLOR } from './map';

export type Vec = [number, number];

export interface Pose {
  x: number;
  y: number;
  /** Radians, 0 = facing +x, growing clockwise on screen. */
  heading: number;
}

/** Converts a point in the robot's frame (x forward, y to the right) to map coordinates. */
export function toWorld(p: Pose, local: Vec): Vec {
  const c = Math.cos(p.heading);
  const s = Math.sin(p.heading);
  return [p.x + local[0] * c - local[1] * s, p.y + local[0] * s + local[1] * c];
}

function projectPolygon(poly: Vec[], axis: Vec): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of poly) {
    const d = v[0] * axis[0] + v[1] * axis[1];
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

/** Separating-axis test for two convex polygons. */
function polygonsOverlap(a: Vec[], b: Vec[]): boolean {
  for (const poly of [a, b]) {
    for (let k = 0; k < poly.length; k++) {
      const p1 = poly[k];
      const p2 = poly[(k + 1) % poly.length];
      const axis: Vec = [p2[1] - p1[1], p1[0] - p2[0]];
      const [aMin, aMax] = projectPolygon(a, axis);
      const [bMin, bMax] = projectPolygon(b, axis);
      if (aMax <= bMin || bMax <= aMin) return false;
    }
  }
  return true;
}

function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentPointDistance(a: Vec, b: Vec, p: Vec): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

const rectPolygon = (o: { x: number; y: number; w: number; h: number }): Vec[] => [
  [o.x, o.y],
  [o.x + o.w, o.y],
  [o.x + o.w, o.y + o.h],
  [o.x, o.y + o.h],
];

export function polygonHitsObstacle(poly: Vec[], o: Obstacle): boolean {
  if (o.kind === 'rect') return polygonsOverlap(poly, rectPolygon(o));
  const c: Vec = [o.x, o.y];
  if (pointInPolygon(c, poly)) return true;
  for (let k = 0; k < poly.length; k++) {
    if (segmentPointDistance(poly[k], poly[(k + 1) % poly.length], c) < o.r) return true;
  }
  return false;
}

export function pointInObstacle(p: Vec, o: Obstacle): boolean {
  if (o.kind === 'rect') return p[0] >= o.x && p[0] <= o.x + o.w && p[1] >= o.y && p[1] <= o.y + o.h;
  return Math.hypot(p[0] - o.x, p[1] - o.y) <= o.r;
}

export function polygonOutsideMap(poly: Vec[], map: MapData): boolean {
  return poly.some(([x, y]) => x < 0 || y < 0 || x > map.width || y > map.height);
}

export interface RayHit {
  /** Distance in the plane, cm; maxDist when nothing was hit. */
  dist: number;
  color?: string;
}

/**
 * Casts a ray in the plane and returns the first obstacle or wall it hits. `accept(t, height)`
 * can skip a hit, e.g. when a tilted 3D ray passes over an obstacle that is too low.
 */
export function castRay(
  origin: Vec,
  angle: number,
  map: MapData,
  maxDist: number,
  accept: (t: number, height: number) => boolean = () => true,
): RayHit {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const best: RayHit = { dist: maxDist };
  const consider = (t: number, height: number, color: string) => {
    if (t >= 0 && t < best.dist && accept(t, height)) {
      best.dist = t;
      best.color = color;
    }
  };
  const segment = (a: Vec, b: Vec, height: number, color: string) => {
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) return;
    const t = ((a[0] - origin[0]) * ey - (a[1] - origin[1]) * ex) / den;
    const u = ((a[0] - origin[0]) * dy - (a[1] - origin[1]) * dx) / den;
    if (u >= 0 && u <= 1) consider(t, height, color);
  };
  if (map.walls) {
    const w = map.width;
    const h = map.height;
    const wh = map.wallHeight ?? DEFAULT_WALL_HEIGHT;
    segment([0, 0], [w, 0], wh, WALL_COLOR);
    segment([w, 0], [w, h], wh, WALL_COLOR);
    segment([w, h], [0, h], wh, WALL_COLOR);
    segment([0, h], [0, 0], wh, WALL_COLOR);
  }
  for (const o of map.obstacles) {
    const height = o.height ?? DEFAULT_OBSTACLE_HEIGHT;
    const color = o.color ?? DEFAULT_OBSTACLE_COLOR;
    if (o.kind === 'rect') {
      const p = rectPolygon(o);
      for (let k = 0; k < 4; k++) segment(p[k], p[(k + 1) % 4], height, color);
    } else {
      const fx = origin[0] - o.x;
      const fy = origin[1] - o.y;
      const b = fx * dx + fy * dy;
      const c = fx * fx + fy * fy - o.r * o.r;
      const disc = b * b - c;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        consider(c < 0 ? 0 : -b - sq, height, color);
      }
    }
  }
  return best;
}
