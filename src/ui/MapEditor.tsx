import { useCallback, useEffect, useRef, useState } from 'react';
import { pointInObstacle } from '../sim/geometry';
import {
  DEFAULT_OBSTACLE_COLOR, DEFAULT_OBSTACLE_HEIGHT, DEFAULT_WALL_HEIGHT, MapData, Obstacle, Stroke, defaultMap, emptyMap, parseMap,
} from '../sim/map';
import { drawGrid, drawMapFrame, drawObstacle, drawStartMarker } from './render';
import { downloadText, pickFile, readFileAsDataUrl } from './storage';
import { drawFloor, loadImage } from './surface';
import { Viewport, capturePointer, syncCanvasSize } from './viewport';

type Tool = 'select' | 'pen' | 'line' | 'rect' | 'ellipse' | 'wall' | 'pillar' | 'start' | 'erase';

const TOOLS: Array<{ id: Tool; label: string; hint: string }> = [
  { id: 'select', label: 'Select', hint: 'Drag an item to move it. Delete removes it.' },
  { id: 'pen', label: 'Pen', hint: 'Draw a freehand line on the floor.' },
  { id: 'line', label: 'Line', hint: 'Drag from one point to another.' },
  { id: 'rect', label: 'Color rectangle', hint: 'A colored area on the floor (the color sensor sees it).' },
  { id: 'ellipse', label: 'Color ellipse', hint: 'A colored area on the floor.' },
  { id: 'wall', label: 'Wall / box', hint: 'A rectangular obstacle the robot bumps into and the ultrasonic sensor sees.' },
  { id: 'pillar', label: 'Pillar', hint: 'A round obstacle: drag from the center outward.' },
  { id: 'start', label: 'Start point', hint: 'Click to place it, drag to aim it.' },
  { id: 'erase', label: 'Erase', hint: 'Click an item or line to delete it.' },
];

const PALETTE = ['#111111', '#ffffff', '#d32f2f', '#388e3c', '#1976d2', '#fbc02d', '#795548'];
const WIDTHS = [1, 2, 2.5, 4, 8];

type Hit = { kind: 'obstacle'; index: number } | { kind: 'stroke'; index: number } | { kind: 'start' };

function hitTest(map: MapData, x: number, y: number): Hit | null {
  if (Math.hypot(x - map.start.x, y - map.start.y) < 7) return { kind: 'start' };
  for (let k = map.obstacles.length - 1; k >= 0; k--) {
    if (pointInObstacle([x, y], map.obstacles[k])) return { kind: 'obstacle', index: k };
  }
  for (let k = map.strokes.length - 1; k >= 0; k--) {
    const s = map.strokes[k];
    if (s.kind === 'path') {
      const tol = s.width / 2 + 1;
      for (let i = 0; i < s.points.length; i++) {
        const a = s.points[i];
        const b = s.points[Math.min(i + 1, s.points.length - 1)];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len2)) : 0;
        if (Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y) <= tol) return { kind: 'stroke', index: k };
      }
    } else if (s.kind === 'rect') {
      if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return { kind: 'stroke', index: k };
    } else {
      const rx = s.w / 2;
      const ry = s.h / 2;
      if (((x - s.x - rx) / rx) ** 2 + ((y - s.y - ry) / ry) ** 2 <= 1) return { kind: 'stroke', index: k };
    }
  }
  return null;
}

function moveStroke(s: Stroke, dx: number, dy: number): Stroke {
  if (s.kind === 'path') return { ...s, points: s.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
  return { ...s, x: s.x + dx, y: s.y + dy };
}

function moveObstacle(o: Obstacle, dx: number, dy: number): Obstacle {
  return { ...o, x: o.x + dx, y: o.y + dy };
}

const norm = (x0: number, y0: number, x1: number, y1: number) => ({
  x: Math.min(x0, x1),
  y: Math.min(y0, y1),
  w: Math.abs(x1 - x0),
  h: Math.abs(y1 - y0),
});

interface Props {
  map: MapData;
  onChange(map: MapData): void;
}

export function MapEditor({ map, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef(new Viewport());
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#111111');
  const [width, setWidth] = useState(2.5);
  const [snap, setSnap] = useState(1);
  const [grid, setGrid] = useState(true);
  const [selected, setSelected] = useState<Hit | null>(null);
  const [bg, setBg] = useState<HTMLImageElement | undefined>();
  const [message, setMessage] = useState('');
  const undo = useRef<MapData[]>([]);
  const redo = useRef<MapData[]>([]);
  /** Uncommitted map while dragging. */
  const draft = useRef<MapData | null>(null);
  const gesture = useRef<{
    start: [number, number];
    last: [number, number];
    panFrom?: [number, number];
    hit?: Hit | null;
    points?: Array<[number, number]>;
  } | null>(null);
  const preview = useRef<((ctx: CanvasRenderingContext2D, scale: number) => void) | null>(null);
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    let cancelled = false;
    if (!map.background) setBg(undefined);
    else loadImage(map.background).then((img) => !cancelled && setBg(img), () => !cancelled && setBg(undefined));
    return () => {
      cancelled = true;
    };
  }, [map.background]);

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const m = draft.current ?? mapRef.current;
    const dpr = syncCanvasSize(c);
    const ctx = c.getContext('2d')!;
    const v = view.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(0, 0, c.width, c.height);
    v.apply(ctx, dpr);
    drawFloor(ctx, m, bg);
    if (grid) drawGrid(ctx, m, v.scale);
    drawMapFrame(ctx, m, v.scale);
    drawStartMarker(ctx, m, v.scale, selected?.kind === 'start');
    if (selected?.kind === 'obstacle' && m.obstacles[selected.index]) drawObstacle(ctx, m.obstacles[selected.index], true);
    if (selected?.kind === 'stroke' && m.strokes[selected.index]) {
      const s = m.strokes[selected.index];
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2 / v.scale;
      ctx.setLineDash([4 / v.scale, 3 / v.scale]);
      if (s.kind === 'path') {
        const xs = s.points.map((p) => p[0]);
        const ys = s.points.map((p) => p[1]);
        const pad = s.width / 2 + 1;
        ctx.strokeRect(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + pad * 2, Math.max(...ys) - Math.min(...ys) + pad * 2);
      } else ctx.strokeRect(s.x - 1, s.y - 1, s.w + 2, s.h + 2);
      ctx.setLineDash([]);
    }
    preview.current?.(ctx, v.scale);
  }, [bg, grid, selected]);

  const fit = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    view.current.fit(mapRef.current.width, mapRef.current.height, c.clientWidth, c.clientHeight);
  }, []);

  useEffect(() => {
    fit();
    const c = canvasRef.current!;
    const ro = new ResizeObserver(() => {
      fit();
      draw();
    });
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map.width, map.height]);

  useEffect(() => {
    draw();
  }, [map, draw]);

  const commit = useCallback(
    (next: MapData) => {
      undo.current.push(mapRef.current);
      if (undo.current.length > 100) undo.current.shift();
      redo.current = [];
      onChange(next);
    },
    [onChange],
  );

  const doUndo = useCallback(() => {
    const prev = undo.current.pop();
    if (!prev) return;
    redo.current.push(mapRef.current);
    setSelected(null);
    onChange(prev);
  }, [onChange]);

  const doRedo = useCallback(() => {
    const next = redo.current.pop();
    if (!next) return;
    undo.current.push(mapRef.current);
    setSelected(null);
    onChange(next);
  }, [onChange]);

  const deleteSelected = useCallback(() => {
    const m = mapRef.current;
    if (selected?.kind === 'obstacle') commit({ ...m, obstacles: m.obstacles.filter((_, k) => k !== selected.index) });
    if (selected?.kind === 'stroke') commit({ ...m, strokes: m.strokes.filter((_, k) => k !== selected.index) });
    setSelected(null);
  }, [commit, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        doRedo();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        deleteSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doUndo, doRedo, deleteSelected]);

  const worldAt = (e: React.PointerEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return view.current.toWorld(e.clientX - rect.left, e.clientY - rect.top);
  };
  const snapped = ([x, y]: [number, number]): [number, number] => (snap ? [Math.round(x / snap) * snap, Math.round(y / snap) * snap] : [x, y]);

  const onPointerDown = (e: React.PointerEvent) => {
    capturePointer(e);
    const raw = worldAt(e);
    if (e.button === 1 || e.button === 2) {
      gesture.current = { start: raw, last: raw, panFrom: [e.clientX, e.clientY] };
      return;
    }
    const p = tool === 'pen' || tool === 'erase' || tool === 'select' ? raw : snapped(raw);
    const m = mapRef.current;
    gesture.current = { start: p, last: p };
    if (tool === 'select') {
      const hit = hitTest(m, raw[0], raw[1]);
      setSelected(hit);
      gesture.current.hit = hit;
      if (!hit) gesture.current.panFrom = [e.clientX, e.clientY];
    } else if (tool === 'erase') {
      const hit = hitTest(m, raw[0], raw[1]);
      if (hit?.kind === 'obstacle') commit({ ...m, obstacles: m.obstacles.filter((_, k) => k !== hit.index) });
      else if (hit?.kind === 'stroke') commit({ ...m, strokes: m.strokes.filter((_, k) => k !== hit.index) });
      gesture.current = null;
    } else if (tool === 'pen') {
      gesture.current.points = [p];
    } else if (tool === 'start') {
      draft.current = { ...m, start: { ...m.start, x: p[0], y: p[1] } };
    }
    draw();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (g.panFrom) {
      view.current.ox += e.clientX - g.panFrom[0];
      view.current.oy += e.clientY - g.panFrom[1];
      g.panFrom = [e.clientX, e.clientY];
      draw();
      return;
    }
    const raw = worldAt(e);
    const p = tool === 'pen' || tool === 'select' ? raw : snapped(raw);
    const [x0, y0] = g.start;
    const m = mapRef.current;
    switch (tool) {
      case 'select': {
        if (!g.hit) break;
        const [dx, dy] = snapped([p[0] - x0, p[1] - y0]);
        const h = g.hit;
        if (h.kind === 'start') draft.current = { ...m, start: { ...m.start, x: m.start.x + dx, y: m.start.y + dy } };
        else if (h.kind === 'obstacle') draft.current = { ...m, obstacles: m.obstacles.map((o, k) => (k === h.index ? moveObstacle(o, dx, dy) : o)) };
        else draft.current = { ...m, strokes: m.strokes.map((s, k) => (k === h.index ? moveStroke(s, dx, dy) : s)) };
        break;
      }
      case 'pen': {
        const last = g.points![g.points!.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.4) g.points!.push(p);
        const pts = g.points!;
        preview.current = (ctx) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          for (const q of pts) ctx.lineTo(q[0], q[1]);
          ctx.stroke();
        };
        break;
      }
      case 'line':
        preview.current = (ctx) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(p[0], p[1]);
          ctx.stroke();
        };
        break;
      case 'rect':
      case 'ellipse':
      case 'wall': {
        const r = norm(x0, y0, p[0], p[1]);
        preview.current = (ctx, scale) => {
          ctx.fillStyle = tool === 'wall' ? 'rgba(107,114,128,0.7)' : color;
          ctx.strokeStyle = '#2563eb';
          ctx.lineWidth = 1 / scale;
          ctx.beginPath();
          if (tool === 'ellipse') ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
          else ctx.rect(r.x, r.y, r.w, r.h);
          ctx.fill();
          ctx.stroke();
        };
        break;
      }
      case 'pillar': {
        const rad = Math.hypot(p[0] - x0, p[1] - y0);
        preview.current = (ctx) => drawObstacle(ctx, { kind: 'circle', x: x0, y: y0, r: rad });
        break;
      }
      case 'start': {
        const heading = Math.round((Math.atan2(raw[1] - y0, raw[0] - x0) * 180) / Math.PI / 5) * 5;
        if (Math.hypot(raw[0] - x0, raw[1] - y0) > 2) draft.current = { ...m, start: { x: x0, y: y0, heading } };
        break;
      }
    }
    g.last = p;
    draw();
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    preview.current = null;
    if (!g || g.panFrom) {
      draft.current = null;
      draw();
      return;
    }
    const m = mapRef.current;
    const [x0, y0] = g.start;
    const [x1, y1] = g.last;
    const r = norm(x0, y0, x1, y1);
    switch (tool) {
      case 'select':
      case 'start':
        if (draft.current) commit(draft.current);
        break;
      case 'pen':
        commit({ ...m, strokes: [...m.strokes, { kind: 'path', points: g.points!, width, color }] });
        break;
      case 'line':
        if (Math.hypot(x1 - x0, y1 - y0) > 0.5) {
          commit({ ...m, strokes: [...m.strokes, { kind: 'path', points: [[x0, y0], [x1, y1]], width, color }] });
        }
        break;
      case 'rect':
      case 'ellipse':
        if (r.w > 0.5 && r.h > 0.5) commit({ ...m, strokes: [...m.strokes, { kind: tool, ...r, color }] });
        break;
      case 'wall':
        if (r.w > 0.5 && r.h > 0.5) commit({ ...m, obstacles: [...m.obstacles, { kind: 'rect', ...r }] });
        break;
      case 'pillar': {
        const rad = Math.hypot(x1 - x0, y1 - y0);
        if (rad > 0.5) commit({ ...m, obstacles: [...m.obstacles, { kind: 'circle', x: x0, y: y0, r: rad }] });
        break;
      }
    }
    draft.current = null;
    draw();
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    view.current.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    draw();
  };

  const setSize = (w: number, h: number) => {
    if (!(w >= 20 && w <= 1000 && h >= 20 && h <= 1000)) {
      setMessage('The map size must be between 20 and 1000 cm');
      return;
    }
    setMessage('');
    commit({ ...map, width: w, height: h });
  };

  const uploadBackground = async () => {
    const file = await pickFile('image/*');
    if (!file) return;
    const url = await readFileAsDataUrl(file);
    const img = await loadImage(url);
    // Keep the map width and derive the height from the image proportions.
    const height = Math.round((map.width * img.height) / img.width);
    commit({ ...map, background: url, height: Math.max(20, Math.min(1000, height)) });
    setMessage(`Image loaded. Check that the width (${map.width} cm) matches the real size of the mat.`);
  };

  const loadJson = async () => {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    try {
      commit(parseMap(await file.text()));
      setSelected(null);
      setMessage('');
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  const hint = TOOLS.find((t) => t.id === tool)!.hint;

  return (
    <div className="map-editor">
      <div className="map-props">
        <label>
          Name
          <input value={map.name} onChange={(e) => onChange({ ...map, name: e.target.value })} />
        </label>
        <SizeInput label="Width (cm)" value={map.width} onCommit={(w) => setSize(w, map.height)} />
        <SizeInput label="Height (cm)" value={map.height} onCommit={(h) => setSize(map.width, h)} />
        <label className="check">
          <input type="checkbox" checked={map.walls} onChange={(e) => commit({ ...map, walls: e.target.checked })} />
          Border walls
        </label>
        {map.walls && (
          <SizeInput
            label="Wall height (cm)"
            value={map.wallHeight ?? DEFAULT_WALL_HEIGHT}
            onCommit={(h) => h > 0 && h <= 200 && commit({ ...map, wallHeight: h })}
          />
        )}
        <button onClick={uploadBackground}>Use an image as the floor…</button>
        {map.background && <button onClick={() => commit({ ...map, background: undefined })}>Remove image</button>}
        <span className="sep" />
        <button onClick={() => { commit(emptyMap()); setSelected(null); }}>Empty map</button>
        <button onClick={() => { commit(defaultMap()); setSelected(null); }}>Default map</button>
        <button onClick={loadJson}>Open map…</button>
        <button onClick={() => downloadText(`${map.name || 'map'}.json`, JSON.stringify(map), 'application/json')}>Save map</button>
      </div>
      <div className="map-tools">
        {TOOLS.map((t) => (
          <button key={t.id} className={tool === t.id ? 'active' : ''} onClick={() => setTool(t.id)}>
            {t.label}
          </button>
        ))}
        <span className="sep" />
        <div className="palette">
          {PALETTE.map((c) => (
            <button key={c} className={`swatch ${color === c ? 'active' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
          ))}
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Other color" />
        </div>
        <label>
          Width
          <select value={width} onChange={(e) => setWidth(Number(e.target.value))}>
            {WIDTHS.map((w) => (
              <option key={w} value={w}>{w} cm</option>
            ))}
          </select>
        </label>
        <label>
          Snap
          <select value={snap} onChange={(e) => setSnap(Number(e.target.value))}>
            <option value={0}>None</option>
            <option value={1}>1 cm</option>
            <option value={5}>5 cm</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} />
          Grid
        </label>
        <button onClick={doUndo} title="Ctrl+Z">Undo</button>
        <button onClick={doRedo} title="Ctrl+Y">Redo</button>
        {selected && selected.kind !== 'start' && <button onClick={deleteSelected}>Delete selected</button>}
        {selected?.kind === 'obstacle' && map.obstacles[selected.index] && (
          <>
            <SizeInput
              label="Obstacle height (cm)"
              value={map.obstacles[selected.index].height ?? DEFAULT_OBSTACLE_HEIGHT}
              onCommit={(h) => {
                if (!(h > 0 && h <= 200)) return;
                commit({ ...map, obstacles: map.obstacles.map((o, k) => (k === selected.index ? { ...o, height: h } : o)) });
              }}
            />
            <label>
              Obstacle color
              <input
                type="color"
                value={map.obstacles[selected.index].color ?? DEFAULT_OBSTACLE_COLOR}
                onChange={(e) => commit({ ...map, obstacles: map.obstacles.map((o, k) => (k === selected.index ? { ...o, color: e.target.value } : o)) })}
              />
            </label>
          </>
        )}
      </div>
      <div className="map-hint">
        {hint} · Wheel: zoom · Right-drag: pan{message && <strong> · {message}</strong>}
      </div>
      <canvas
        ref={canvasRef}
        className={`map-canvas tool-${tool}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        onDoubleClick={() => {
          fit();
          draw();
        }}
      />
    </div>
  );
}

function SizeInput({ label, value, onCommit }: { label: string; value: number; onCommit(v: number): void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const done = () => {
    const v = Number(text);
    if (v !== value) onCommit(v);
  };
  return (
    <label>
      {label}
      <input
        className="num-input"
        type="number"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => e.key === 'Enter' && done()}
      />
    </label>
  );
}
