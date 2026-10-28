/** All map coordinates are in centimeters; x grows right, y grows down. */

export interface PathStroke {
  kind: 'path';
  points: Array<[number, number]>;
  width: number;
  color: string;
}

export interface ShapeStroke {
  kind: 'rect' | 'ellipse';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export type Stroke = PathStroke | ShapeStroke;

interface ObstacleBase {
  /** Height in cm; sensors mounted higher do not see it. Default 10. */
  height?: number;
  /** Color the color sensor sees when facing it. Default gray. */
  color?: string;
}

export interface RectObstacle extends ObstacleBase {
  kind: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CircleObstacle extends ObstacleBase {
  kind: 'circle';
  x: number;
  y: number;
  r: number;
}

export const DEFAULT_OBSTACLE_HEIGHT = 10;
export const DEFAULT_OBSTACLE_COLOR = '#6b7280';
export const DEFAULT_WALL_HEIGHT = 15;
export const WALL_COLOR = '#d1d5db';

export type Obstacle = RectObstacle | CircleObstacle;

export interface MapData {
  version: 1;
  name: string;
  width: number;
  height: number;
  /** Image drawn under the strokes, stretched over the whole map. */
  background?: string;
  strokes: Stroke[];
  obstacles: Obstacle[];
  start: { x: number; y: number; heading: number };
  walls: boolean;
  /** Height of the border walls in cm. Default 15. */
  wallHeight?: number;
}

export function emptyMap(width = 200, height = 150): MapData {
  return {
    version: 1,
    name: 'New map',
    width,
    height,
    strokes: [],
    obstacles: [],
    start: { x: 30, y: height / 2, heading: 0 },
    walls: true,
  };
}

/** An oval black line to follow, a few colored patches and two obstacles. */
export function defaultMap(): MapData {
  const cx = 120;
  const cy = 80;
  const points: Array<[number, number]> = [];
  for (let k = 0; k <= 72; k++) {
    const a = (k / 72) * Math.PI * 2;
    points.push([cx + Math.cos(a) * 75, cy + Math.sin(a) * 45]);
  }
  return {
    version: 1,
    name: 'Line-following track',
    width: 240,
    height: 160,
    strokes: [
      { kind: 'path', points, width: 2.5, color: '#111111' },
      { kind: 'rect', x: 10, y: 10, w: 20, h: 20, color: '#d32f2f' },
      { kind: 'rect', x: 210, y: 10, w: 20, h: 20, color: '#1976d2' },
      { kind: 'rect', x: 10, y: 130, w: 20, h: 20, color: '#388e3c' },
      { kind: 'rect', x: 210, y: 130, w: 20, h: 20, color: '#fbc02d' },
    ],
    obstacles: [
      { kind: 'rect', x: 100, y: 65, w: 40, h: 30 },
      { kind: 'circle', x: 222, y: 80, r: 6 },
    ],
    start: { x: 120, y: 35, heading: 0 },
    walls: true,
  };
}

export function parseMap(json: string): MapData {
  const m = JSON.parse(json);
  if (!m || typeof m !== 'object' || typeof m.width !== 'number' || typeof m.height !== 'number') {
    throw new Error('This is not a valid map file');
  }
  return {
    version: 1,
    name: String(m.name ?? 'Map'),
    width: m.width,
    height: m.height,
    background: typeof m.background === 'string' ? m.background : undefined,
    strokes: Array.isArray(m.strokes) ? m.strokes : [],
    obstacles: Array.isArray(m.obstacles) ? m.obstacles : [],
    start: m.start ?? { x: 20, y: m.height / 2, heading: 0 },
    walls: m.walls !== false,
    wallHeight: typeof m.wallHeight === 'number' ? m.wallHeight : undefined,
  };
}
