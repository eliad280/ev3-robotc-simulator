/** Maps world centimeters to canvas pixels (CSS pixels) with zoom and pan. */
export class Viewport {
  scale = 3;
  ox = 0;
  oy = 0;

  fit(worldW: number, worldH: number, w: number, h: number, margin = 24) {
    this.scale = Math.max(0.2, Math.min((w - margin * 2) / worldW, (h - margin * 2) / worldH));
    this.ox = (w - worldW * this.scale) / 2;
    this.oy = (h - worldH * this.scale) / 2;
  }

  toWorld(px: number, py: number): [number, number] {
    return [(px - this.ox) / this.scale, (py - this.oy) / this.scale];
  }

  zoomAt(px: number, py: number, factor: number) {
    const [wx, wy] = this.toWorld(px, py);
    this.scale = Math.max(0.2, Math.min(60, this.scale * factor));
    this.ox = px - wx * this.scale;
    this.oy = py - wy * this.scale;
  }

  centerOn(wx: number, wy: number, w: number, h: number) {
    this.ox = w / 2 - wx * this.scale;
    this.oy = h / 2 - wy * this.scale;
  }

  /** Sets a canvas context so drawing happens in world units. */
  apply(ctx: CanvasRenderingContext2D, dpr: number) {
    ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, dpr * this.ox, dpr * this.oy);
  }
}

/** Keeps a canvas's pixel size in sync with its CSS size; returns the device pixel ratio. */
export function syncCanvasSize(canvas: HTMLCanvasElement): number {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}

/** Keeps receiving pointer events while dragging outside the element. Never throws. */
export function capturePointer(e: React.PointerEvent) {
  try {
    (e.target as Element).setPointerCapture(e.pointerId);
  } catch {
    // no active pointer (e.g. a synthetic event); dragging still works inside the element
  }
}
