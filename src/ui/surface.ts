import { MapData } from '../sim/map';
import { Surface } from '../sim/simulation';

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the image'));
    img.src = src;
  });
}

/**
 * Draws the floor of a map (background image + strokes) into a context whose
 * units are already scaled to centimeters.
 */
export function drawFloor(ctx: CanvasRenderingContext2D, map: MapData, background?: HTMLImageElement) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, map.width, map.height);
  if (background) ctx.drawImage(background, 0, 0, map.width, map.height);
  for (const s of map.strokes) {
    if (s.kind === 'path') {
      if (s.points.length === 0) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(s.points[0][0], s.points[0][1]);
      for (const p of s.points.slice(1)) ctx.lineTo(p[0], p[1]);
      if (s.points.length === 1) ctx.lineTo(s.points[0][0] + 0.01, s.points[0][1]);
      ctx.stroke();
    } else if (s.kind === 'rect') {
      ctx.fillStyle = s.color;
      ctx.fillRect(s.x, s.y, s.w, s.h);
    } else {
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** The map floor rendered to pixels, so the color sensor can read it. */
export class CanvasSurface implements Surface {
  readonly canvas: HTMLCanvasElement;
  private data: Uint8ClampedArray;
  private pxPerCm: number;

  constructor(
    private map: MapData,
    background?: HTMLImageElement,
  ) {
    this.pxPerCm = Math.min(5, 3000 / Math.max(map.width, map.height));
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.max(1, Math.round(map.width * this.pxPerCm));
    this.canvas.height = Math.max(1, Math.round(map.height * this.pxPerCm));
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.scale(this.pxPerCm, this.pxPerCm);
    drawFloor(ctx, map, background);
    this.data = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
  }

  static async create(map: MapData): Promise<CanvasSurface> {
    let bg: HTMLImageElement | undefined;
    if (map.background) {
      try {
        bg = await loadImage(map.background);
      } catch {
        bg = undefined;
      }
    }
    return new CanvasSurface(map, bg);
  }

  sample(x: number, y: number, radius: number): [number, number, number] | null {
    if (x < 0 || y < 0 || x > this.map.width || y > this.map.height) return null;
    const s = this.pxPerCm;
    const cx = x * s;
    const cy = y * s;
    const r = Math.max(1, radius * s);
    const w = this.canvas.width;
    const h = this.canvas.height;
    let rs = 0;
    let gs = 0;
    let bs = 0;
    let n = 0;
    for (let py = Math.floor(cy - r); py <= Math.ceil(cy + r); py++) {
      if (py < 0 || py >= h) continue;
      for (let px = Math.floor(cx - r); px <= Math.ceil(cx + r); px++) {
        if (px < 0 || px >= w) continue;
        if ((px - cx) ** 2 + (py - cy) ** 2 > r * r) continue;
        const i = (py * w + px) * 4;
        rs += this.data[i];
        gs += this.data[i + 1];
        bs += this.data[i + 2];
        n++;
      }
    }
    if (!n) return null;
    return [rs / n, gs / n, bs / n];
  }
}
