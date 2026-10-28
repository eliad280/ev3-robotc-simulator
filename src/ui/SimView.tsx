import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { MapData } from '../sim/map';
import { Simulation } from '../sim/simulation';
import { drawMapFrame, drawRobot, drawStartMarker } from './render';
import { Viewport, capturePointer, syncCanvasSize } from './viewport';

export interface SimViewHandle {
  draw(): void;
  fit(): void;
}

interface Props {
  sim: Simulation;
  map: MapData;
  floor: HTMLCanvasElement | null;
  follow: boolean;
  showRays: boolean;
}

/** Draws the map and the robot. Drag to pan, wheel to zoom; drag the robot to move it while no program runs. */
export const SimView = forwardRef<SimViewHandle, Props>(function SimView({ sim, map, floor, follow, showRays }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef(new Viewport());
  const drag = useRef<{ mode: 'pan' | 'move' | 'rotate'; x: number; y: number } | null>(null);
  const props = useRef({ sim, map, floor, follow, showRays });
  props.current = { sim, map, floor, follow, showRays };

  const fit = () => {
    const c = canvasRef.current;
    if (!c) return;
    view.current.fit(props.current.map.width, props.current.map.height, c.clientWidth, c.clientHeight);
  };

  const draw = () => {
    const c = canvasRef.current;
    if (!c) return;
    const { sim, map, floor, follow, showRays } = props.current;
    const dpr = syncCanvasSize(c);
    const ctx = c.getContext('2d')!;
    const v = view.current;
    if (follow) v.centerOn(sim.pose.x, sim.pose.y, c.clientWidth, c.clientHeight);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(0, 0, c.width, c.height);
    v.apply(ctx, dpr);
    if (floor) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(floor, 0, 0, map.width, map.height);
    } else {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, map.width, map.height);
    }
    drawMapFrame(ctx, map, v.scale);
    if (sim.status !== 'running') drawStartMarker(ctx, map, v.scale);
    drawRobot(ctx, sim, v.scale, showRays);
  };

  useImperativeHandle(ref, () => ({ draw, fit }));

  useEffect(() => {
    fit();
    draw();
    const c = canvasRef.current!;
    const ro = new ResizeObserver(() => {
      fit();
      draw();
    });
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map.width, map.height]);

  const onWheel = (e: React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    view.current.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    draw();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const [wx, wy] = view.current.toWorld(px, py);
    const s = props.current.sim;
    const onRobot = Math.hypot(wx - s.pose.x, wy - s.pose.y) < 11 && s.status !== 'running';
    drag.current = { mode: onRobot ? (e.shiftKey ? 'rotate' : 'move') : 'pan', x: px, y: py };
    capturePointer(e);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const s = props.current.sim;
    if (d.mode === 'pan') {
      view.current.ox += px - d.x;
      view.current.oy += py - d.y;
    } else if (d.mode === 'move') {
      const [wx, wy] = view.current.toWorld(px, py);
      const [ox, oy] = view.current.toWorld(d.x, d.y);
      const next = { ...s.pose, x: s.pose.x + wx - ox, y: s.pose.y + wy - oy };
      if (!s.collides(next)) s.pose = next;
      s.trail = [[s.pose.x, s.pose.y]];
    } else {
      const [wx, wy] = view.current.toWorld(px, py);
      const next = { ...s.pose, heading: Math.atan2(wy - s.pose.y, wx - s.pose.x) };
      if (!s.collides(next)) s.pose = next;
    }
    d.x = px;
    d.y = py;
    draw();
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      className="sim-canvas"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => {
        fit();
        draw();
      }}
    />
  );
});
