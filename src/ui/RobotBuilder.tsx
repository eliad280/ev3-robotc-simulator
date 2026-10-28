import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BEAM_LENGTHS, DesignIssue, PART_INFO, Part, PartKind, RobotDesign, RobotSettings, STUD, WHEELS,
  educatorDesign, newPartId, parseDesign, partCorners, twoColorDesign,
} from '../sim/design';
import { DRAW_ORDER, drawPart, drawPartLabel } from './parts';
import { downloadText, pickFile } from './storage';
import { Viewport, capturePointer, syncCanvasSize } from './viewport';

const CATALOG: Array<{ title: string; kinds: PartKind[] }> = [
  { title: 'Structure', kinds: ['brick', 'beam', 'frame'] },
  { title: 'Drive', kinds: ['largeMotor', 'mediumMotor', 'wheel', 'caster'] },
  { title: 'Sensors', kinds: ['touch', 'color', 'ultrasonic', 'gyro', 'ir'] },
];

const SENSOR_KINDS: PartKind[] = ['touch', 'color', 'ultrasonic', 'gyro', 'ir'];
const isSensor = (k: PartKind) => SENSOR_KINDS.includes(k);
const isMotor = (k: PartKind) => k === 'largeMotor' || k === 'mediumMotor';
const SNAP = STUD / 2;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;
const round1 = (v: number) => Math.round(v * 10) / 10;

function pointInPart(p: Part, x: number, y: number): boolean {
  const c = partCorners(p);
  let inside = false;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
    if (c[i][1] > y !== c[j][1] > y && x < ((c[j][0] - c[i][0]) * (y - c[i][1])) / (c[j][1] - c[i][1]) + c[i][0]) inside = !inside;
  }
  return inside;
}

interface Props {
  design: RobotDesign;
  onChange(d: RobotDesign): void;
  robot?: RobotSettings;
  issues: DesignIssue[];
  /** Writes `#pragma config` lines for this robot into the code. */
  onInsertPragmas(): void;
}

export function RobotBuilder({ design, onChange, robot, issues, onInsertPragmas }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef(new Viewport());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const undo = useRef<RobotDesign[]>([]);
  const redo = useRef<RobotDesign[]>([]);
  const draft = useRef<RobotDesign | null>(null);
  const gesture = useRef<{ id?: string; start: [number, number]; orig?: Part; panFrom?: [number, number] } | null>(null);
  const designRef = useRef(design);
  designRef.current = design;

  const selected = design.parts.find((p) => p.id === selectedId);
  const errorIds = new Set(issues.filter((i) => i.severity === 'error').flatMap((i) => i.partIds));

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const d = draft.current ?? designRef.current;
    const dpr = syncCanvasSize(c);
    const ctx = c.getContext('2d')!;
    const v = view.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, c.width, c.height);
    v.apply(ctx, dpr);
    // stud grid
    const [x0, y0] = v.toWorld(0, 0);
    const [x1, y1] = v.toWorld(c.clientWidth, c.clientHeight);
    ctx.lineWidth = 1 / v.scale;
    for (const [step, color] of [[STUD, 'rgba(0,0,0,0.05)'], [STUD * 5, 'rgba(0,0,0,0.12)']] as const) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
      }
      for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) {
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
      }
      ctx.stroke();
    }
    // "forward" arrow
    ctx.strokeStyle = '#16a34a';
    ctx.fillStyle = '#16a34a';
    ctx.lineWidth = 2 / v.scale;
    ctx.beginPath();
    ctx.moveTo(14, -16);
    ctx.lineTo(20, -16);
    ctx.lineTo(18.5, -17.2);
    ctx.moveTo(20, -16);
    ctx.lineTo(18.5, -14.8);
    ctx.stroke();
    ctx.font = `${12 / v.scale}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('forward', 17, -17.8);

    const parts = [...d.parts].sort((a, b) => DRAW_ORDER[a.kind] - DRAW_ORDER[b.kind]);
    for (const p of parts) drawPart(ctx, p, v.scale, { selected: p.id === selectedId, error: errorIds.has(p.id) });
    for (const p of parts) drawPartLabel(ctx, p, v.scale);
    // drive axle
    if (robot) {
      const wheels = d.parts.filter((p) => p.kind === 'wheel' && p.drivenBy !== undefined);
      if (wheels.length === 2) {
        ctx.strokeStyle = 'rgba(37,99,235,0.5)';
        ctx.lineWidth = 1.5 / v.scale;
        ctx.setLineDash([4 / v.scale, 3 / v.scale]);
        ctx.beginPath();
        ctx.moveTo(wheels[0].x, wheels[0].y);
        ctx.lineTo(wheels[1].x, wheels[1].y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, issues, robot]);

  useEffect(() => {
    const c = canvasRef.current!;
    const fit = () => view.current.fit(44, 34, c.clientWidth, c.clientHeight, 10);
    fit();
    view.current.centerOn(-2, 0, c.clientWidth, c.clientHeight);
    const ro = new ResizeObserver(() => {
      fit();
      view.current.centerOn(-2, 0, c.clientWidth, c.clientHeight);
      draw();
    });
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    draw();
  }, [design, draw]);

  const commit = useCallback(
    (next: RobotDesign) => {
      undo.current.push(designRef.current);
      if (undo.current.length > 100) undo.current.shift();
      redo.current = [];
      onChange(next);
    },
    [onChange],
  );

  const updatePart = (id: string, change: Partial<Part>) => {
    commit({ ...designRef.current, parts: designRef.current.parts.map((p) => (p.id === id ? { ...p, ...change } : p)) });
  };

  const addPart = (kind: PartKind) => {
    const info = PART_INFO[kind];
    const d = designRef.current;
    const usedSensorPorts = new Set(d.parts.filter((p) => isSensor(p.kind)).map((p) => p.port));
    const usedMotorPorts = new Set(d.parts.filter((p) => isMotor(p.kind)).map((p) => p.port));
    const free = (used: Set<number | undefined>) => [0, 1, 2, 3].find((k) => !used.has(k));
    const part: Part = {
      id: newPartId(),
      kind,
      x: 14,
      y: 8,
      rot: 0,
      ...(isSensor(kind) ? { port: free(usedSensorPorts), height: info.height, pitch: info.pitch } : {}),
      ...(isMotor(kind) ? { port: free(usedMotorPorts) } : {}),
      ...(kind === 'wheel' ? { wheel: '56x28' } : {}),
      ...(kind === 'beam' ? { holes: 7 } : {}),
    };
    commit({ ...d, parts: [...d.parts, part] });
    setSelectedId(part.id);
  };

  const removeSelected = useCallback(() => {
    if (!selectedId) return;
    commit({ ...designRef.current, parts: designRef.current.parts.filter((p) => p.id !== selectedId) });
    setSelectedId(null);
  }, [commit, selectedId]);

  const rotateSelected = useCallback(
    (by: number) => {
      const p = designRef.current.parts.find((q) => q.id === selectedId);
      if (p) updatePart(p.id, { rot: (((p.rot + by) % 360) + 360) % 360 });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const stackFrom = e.shiftKey ? redo : undo;
        const stackTo = e.shiftKey ? undo : redo;
        const d = stackFrom.current.pop();
        if (d) {
          stackTo.current.push(designRef.current);
          onChange(d);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        const d = redo.current.pop();
        if (d) {
          undo.current.push(designRef.current);
          onChange(d);
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') removeSelected();
      else if (e.key === 'r' || e.key === 'R' || e.key === '\u05e8') /* R on a Hebrew keyboard layout */ rotateSelected(e.shiftKey ? -90 : 90);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onChange, removeSelected, rotateSelected]);

  const worldAt = (e: React.PointerEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return view.current.toWorld(e.clientX - rect.left, e.clientY - rect.top);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    capturePointer(e);
    const w = worldAt(e);
    if (e.button !== 0) {
      gesture.current = { start: w, panFrom: [e.clientX, e.clientY] };
      return;
    }
    // topmost part under the pointer
    const hits = [...designRef.current.parts].sort((a, b) => DRAW_ORDER[b.kind] - DRAW_ORDER[a.kind]).filter((p) => pointInPart(p, w[0], w[1]));
    const hit = hits.find((p) => p.id === selectedId && hits.length > 1 && e.altKey) ?? hits[0];
    setSelectedId(hit?.id ?? null);
    gesture.current = hit ? { id: hit.id, start: w, orig: hit } : { start: w, panFrom: [e.clientX, e.clientY] };
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
    const w = worldAt(e);
    const o = g.orig!;
    const moved = { ...o, x: snap(o.x + w[0] - g.start[0]), y: snap(o.y + w[1] - g.start[1]) };
    draft.current = { ...designRef.current, parts: designRef.current.parts.map((p) => (p.id === o.id ? moved : p)) };
    draw();
  };

  const onPointerUp = () => {
    const d = draft.current;
    draft.current = null;
    gesture.current = null;
    if (d) commit(d);
    else draw();
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    view.current.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    draw();
  };

  const loadPreset = (d: RobotDesign) => {
    commit(d);
    setSelectedId(null);
  };

  const openFile = async () => {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    try {
      loadPreset(parseDesign(await file.text()));
      setMessage('');
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  return (
    <div className="builder">
      <aside className="catalog">
        {CATALOG.map((group) => (
          <div key={group.title}>
            <h3>{group.title}</h3>
            {group.kinds.map((k) => (
              <button key={k} onClick={() => addPart(k)}>
                + {PART_INFO[k].label}
              </button>
            ))}
          </div>
        ))}
        <h3>Ready-made robots</h3>
        <button onClick={() => loadPreset(educatorDesign())}>Educator</button>
        <button onClick={() => loadPreset(twoColorDesign())}>Two color sensors</button>
        <h3>File</h3>
        <button onClick={openFile}>Open robot…</button>
        <button onClick={() => downloadText(`${design.name || 'robot'}.json`, JSON.stringify(design, null, 1), 'application/json')}>Save robot</button>
      </aside>

      <section className="builder-main">
        <div className="map-hint">
          Click a part in the catalog to add it, then drag it into place. R: rotate 90° · Delete: remove · Ctrl+Z: undo · Wheel: zoom · Right-drag: pan. Grid squares are LEGO studs (8 mm).
          {message && <strong> · {message}</strong>}
        </div>
        <canvas
          ref={canvasRef}
          className="builder-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
        />
      </section>

      <aside className="inspector">
        <label className="stack">
          Robot name
          <input value={design.name} onChange={(e) => onChange({ ...design, name: e.target.value })} />
        </label>

        {selected ? (
          <PartInspector
            part={selected}
            onChange={(c) => updatePart(selected.id, c)}
            onRotate={rotateSelected}
            onDelete={removeSelected}
          />
        ) : (
          <p className="muted">Select a part to edit it.</p>
        )}

        <div className="issues">
          {errors.length === 0 && robot ? (
            <div className="ok">
              ✓ The robot is valid · track width {round1(robot.trackWidth)} cm · wheels {robot.leftWheelDiameter * 10}/{robot.rightWheelDiameter * 10} mm
            </div>
          ) : null}
          {[...errors, ...warnings].map((i, k) => (
            <div key={k} className={i.severity} onClick={() => i.partIds[0] && setSelectedId(i.partIds[0])}>
              {i.severity === 'error' ? '✗' : '!'} {i.message}
            </div>
          ))}
        </div>

        <button className="primary" disabled={!robot} onClick={onInsertPragmas}>
          Update the #pragma lines in the code
        </button>
        <p className="muted small">
          The robot decides which sensor is on each port. The lines written at the top of the code will match it, and names already used in the code are kept.
        </p>
      </aside>
    </div>
  );
}

const PITCH_PRESETS = [
  { label: 'Down', value: -90 },
  { label: 'Diagonal', value: -45 },
  { label: 'Forward', value: 0 },
  { label: 'Up', value: 90 },
];

const GYRO_PRESETS = [
  { label: 'Upright', value: 0 },
  { label: 'On its side', value: 90 },
  { label: 'Upside down', value: 180 },
];

function NumberField({ label, value, min, max, step = 1, onCommit }: { label: string; value: number; min: number; max: number; step?: number; onCommit(v: number): void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const done = () => {
    const v = Number(text);
    if (Number.isFinite(v) && v !== value) onCommit(Math.max(min, Math.min(max, v)));
    else setText(String(value));
  };
  return (
    <label>
      {label}
      <input className="num-input" type="number" step={step} min={min} max={max} value={text} onChange={(e) => setText(e.target.value)} onBlur={done} onKeyDown={(e) => e.key === 'Enter' && done()} />
    </label>
  );
}

function PartInspector({ part, onChange, onRotate, onDelete }: { part: Part; onChange(c: Partial<Part>): void; onRotate(by: number): void; onDelete(): void }) {
  const info = PART_INFO[part.kind];
  const sensor = isSensor(part.kind);
  return (
    <div className="part-inspector">
      <h3>{info.label}</h3>
      <div className="row">
        <NumberField label="Forward (cm)" value={round1(part.x)} min={-60} max={60} step={0.4} onCommit={(x) => onChange({ x })} />
        <NumberField label="Right (cm)" value={round1(part.y)} min={-60} max={60} step={0.4} onCommit={(y) => onChange({ y })} />
      </div>

      <div className="row">
        {sensor && part.kind !== 'gyro' ? (
          <NumberField label="Facing (°)" value={part.rot} min={0} max={359} onCommit={(rot) => onChange({ rot })} />
        ) : (
          <span>Rotation: {part.rot}°</span>
        )}
        <button onClick={() => onRotate(-90)} title="Shift+R">⟲ 90°</button>
        <button onClick={() => onRotate(90)} title="R">⟳ 90°</button>
      </div>

      {(isMotor(part.kind) || sensor) && (
        <label>
          Port
          <select value={part.port ?? ''} onChange={(e) => onChange({ port: e.target.value === '' ? undefined : Number(e.target.value) })}>
            <option value="">Not connected</option>
            {[0, 1, 2, 3].map((k) => (
              <option key={k} value={k}>{sensor ? `S${k + 1}` : `motor${'ABCD'[k]}`}</option>
            ))}
          </select>
        </label>
      )}

      {part.kind === 'wheel' && (
        <>
          <label>
            Size
            <select value={part.wheel ?? '56x28'} onChange={(e) => onChange({ wheel: e.target.value })}>
              {WHEELS.map((w) => (
                <option key={w.id} value={w.id}>{w.id.replace('x', ' × ')} mm</option>
              ))}
            </select>
          </label>
          <label>
            Driven by
            <select value={part.drivenBy ?? ''} onChange={(e) => onChange({ drivenBy: e.target.value === '' ? undefined : Number(e.target.value) })}>
              <option value="">Free wheel</option>
              {[0, 1, 2, 3].map((k) => (
                <option key={k} value={k}>motor{'ABCD'[k]}</option>
              ))}
            </select>
          </label>
        </>
      )}

      {part.kind === 'beam' && (
        <label>
          Length
          <select value={part.holes ?? 7} onChange={(e) => onChange({ holes: Number(e.target.value) })}>
            {BEAM_LENGTHS.map((n) => (
              <option key={n} value={n}>{n} holes</option>
            ))}
          </select>
        </label>
      )}

      {sensor && (
        <>
          <div className="row wrap">
            <span>{part.kind === 'gyro' ? 'Axis tilt:' : 'Tilt:'}</span>
            {(part.kind === 'gyro' ? GYRO_PRESETS : PITCH_PRESETS).map((pr) => (
              <button key={pr.value} className={(part.pitch ?? 0) === pr.value ? 'active' : ''} onClick={() => onChange({ pitch: pr.value })}>
                {pr.label}
              </button>
            ))}
          </div>
          <div className="row">
            <NumberField
              label="Tilt (°)"
              value={part.pitch ?? 0}
              min={part.kind === 'gyro' ? -180 : -90}
              max={part.kind === 'gyro' ? 180 : 90}
              onCommit={(pitch) => onChange({ pitch })}
            />
            <NumberField label="Height (cm)" value={part.height ?? info.height ?? 0} min={0} max={40} step={0.5} onCommit={(height) => onChange({ height })} />
          </div>
          {part.kind !== 'gyro' && <SideView pitch={part.pitch ?? 0} height={part.height ?? info.height ?? 0} />}
        </>
      )}

      <button className="danger" onClick={onDelete}>Delete part</button>
    </div>
  );
}

/** Side view of a sensor: its height above the floor and where it points (B-6). */
function SideView({ pitch, height }: { pitch: number; height: number }) {
  const W = 220;
  const H = 110;
  const floorY = 92;
  const scale = 6; // px per cm
  const sy = floorY - Math.min(height, 13) * scale;
  const sx = 70;
  const a = (-pitch * Math.PI) / 180;
  const len = 60;
  const ex = sx + Math.cos(a) * len;
  const ey = Math.min(floorY, sy + Math.sin(a) * len);
  return (
    <svg className="side-view" width="100%" viewBox={`0 0 ${W} ${H}`} style={{ direction: 'ltr' }}>
      <rect x={0} y={floorY} width={W} height={H - floorY} fill="#e5e7eb" />
      <line x1={0} y1={floorY} x2={W} y2={floorY} stroke="#6b7280" />
      <line x1={sx - 30} y1={floorY} x2={sx - 30} y2={sy} stroke="#9ca3af" strokeDasharray="3 2" />
      <text x={sx - 34} y={(floorY + sy) / 2 + 4} fontSize="11" textAnchor="end" fill="#374151">{height} cm</text>
      <line x1={sx} y1={sy} x2={ex} y2={ey} stroke="#f59e0b" strokeWidth="2" strokeDasharray="5 3" />
      <g transform={`translate(${sx} ${sy}) rotate(${pitch === undefined ? 0 : -pitch})`}>
        <rect x={-12} y={-6} width={16} height={12} rx={2} fill="#374151" />
        <circle cx={4} cy={0} r={3} fill="#f9fafb" stroke="#dc2626" />
      </g>
      <text x={W - 6} y={14} fontSize="11" textAnchor="end" fill="#6b7280">Side view · forward →</text>
    </svg>
  );
}
