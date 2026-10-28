import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CompileResult, compile } from './lang/compile';
import { Diagnostic } from './lang/errors';
import { DEFAULT_CODE, EXAMPLES } from './examples';
import { RobotDesign, deriveRobot, educatorDesign, parseDesign, portWarnings, pragmaLines, replacePragmas } from './sim/design';
import { MapData, defaultMap, parseMap } from './sim/map';
import { Simulation } from './sim/simulation';
import { playTone, unlockAudio } from './ui/audio';
import { BrickPanel } from './ui/BrickPanel';
import { CodeEditor, EditorApi } from './ui/CodeEditor';
import { MapEditor } from './ui/MapEditor';
import { DebugStream, Readouts } from './ui/Readouts';
import { RobotBuilder } from './ui/RobotBuilder';
import { SimView, SimViewHandle } from './ui/SimView';
import { downloadText, loadItem, pickFile, saveItem } from './ui/storage';
import { CanvasSurface } from './ui/surface';

const SPEEDS = [0.25, 0.5, 1, 2, 4];

const STATUS_TEXT: Record<string, string> = {
  idle: 'Ready',
  running: 'Running…',
  done: 'Program finished',
  stopped: 'Stopped',
  error: 'Runtime error',
};

const blankSurface = { sample: () => [255, 255, 255] as [number, number, number] };

export default function App() {
  const [code, setCode] = useState(() => loadItem('code', (s) => s) ?? DEFAULT_CODE);
  const [map, setMap] = useState<MapData>(() => loadItem('map', parseMap) ?? defaultMap());
  const [design, setDesign] = useState<RobotDesign>(() => loadItem('robot', parseDesign) ?? educatorDesign());
  const derived = useMemo(() => deriveRobot(design), [design]);
  const [tab, setTab] = useState<'sim' | 'map' | 'robot'>('sim');
  const [speed, setSpeed] = useState(1);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(false);
  const [showRays, setShowRays] = useState(true);
  const [muted, setMuted] = useState(false);
  const [compiled, setCompiled] = useState<CompileResult>(() => compile(code));
  const [floor, setFloor] = useState<HTMLCanvasElement | null>(null);
  const [, setUiTick] = useState(0);
  const [notice, setNotice] = useState('');

  const sim = useMemo(() => new Simulation(map, blankSurface), []); // eslint-disable-line react-hooks/exhaustive-deps
  const simView = useRef<SimViewHandle>(null);
  const editorApi = useRef<EditorApi | null>(null);
  const loop = useRef({ speed, paused, muted });
  loop.current = { speed, paused, muted };

  // Rebuild the pixel floor whenever the map changes, and put the robot on the new start.
  useEffect(() => {
    let cancelled = false;
    CanvasSurface.create(map).then((surface) => {
      if (cancelled) return;
      sim.setMap(map, surface);
      setFloor(surface.canvas);
      simView.current?.fit();
    });
    const t = setTimeout(() => {
      if (!saveItem('map', JSON.stringify(map))) {
        setNotice('The map is too large to save automatically in the browser. Save it as a file.');
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [map, sim]);

  // The simulation always drives the last valid robot that was built.
  useEffect(() => {
    if (derived.robot) sim.setRobot(derived.robot);
    const t = setTimeout(() => saveItem('robot', JSON.stringify(design)), 300);
    return () => clearTimeout(t);
  }, [derived, design, sim]);

  // Live error checking while typing.
  useEffect(() => {
    const t = setTimeout(() => {
      setCompiled(compile(code));
      saveItem('code', code);
    }, 300);
    return () => clearTimeout(t);
  }, [code]);

  useEffect(() => {
    sim.onSound = (e) => playTone(e, loop.current.muted);
    sim.onStatus = () => setUiTick((t) => t + 1);
  }, [sim]);

  // Main loop: advance the simulation in 1 ms steps, draw, and refresh panels ~10 times a second.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let lastUi = 0;
    const frame = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      if (!loop.current.paused) {
        acc += dt * loop.current.speed;
        const n = Math.min(Math.floor(acc), 400);
        acc -= Math.floor(acc);
        for (let k = 0; k < n; k++) sim.step();
      }
      simView.current?.draw();
      if (now - lastUi > 100) {
        lastUi = now;
        setUiTick((t) => t + 1);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [sim]);

  const run = useCallback(() => {
    unlockAudio();
    if (!derived.robot) {
      setNotice('Your robot has errors. Fix them in the "Robot builder" tab and try again.');
      setTab('robot');
      return;
    }
    const c = compile(code);
    setCompiled(c);
    if (!c.ok) {
      const first = c.diagnostics.find((d) => d.severity === 'error');
      if (first) editorApi.current?.revealLine(first.line);
      return;
    }
    sim.reset();
    sim.clearDebug();
    sim.run(c);
    setPaused(false);
    setTab('sim');
  }, [code, sim, derived]);

  const insertPragmas = () => {
    if (!derived.robot) return;
    const ports = compile(code).ports;
    const lines = pragmaLines(
      derived.robot,
      ports.sensors.map((s) => (s.pragmaLine !== undefined ? { kind: s.kind, name: s.name, modeToken: s.modeToken } : undefined)),
      ports.motors.map((m) => (m.pragmaLine !== undefined ? { kind: m.kind, name: m.name } : undefined)),
    );
    setCode(replacePragmas(code, lines));
    setNotice('The #pragma lines at the top of the code now match the robot.');
    setTab('sim');
  };

  const stop = () => sim.stopProgram();
  const reset = () => {
    sim.reset();
    setUiTick((t) => t + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run]);

  const openCode = async () => {
    const file = await pickFile('.c,.h,.txt');
    if (file) setCode(await file.text());
  };

  const diagnostics: Diagnostic[] = useMemo(() => {
    const list = [...compiled.diagnostics];
    if (derived.robot) list.push(...portWarnings(derived.robot, compiled.ports));
    if (sim.status === 'error' && sim.error) {
      list.push({ line: sim.error.line, col: 1, severity: 'error', message: `Runtime error: ${sim.error.message}` });
    }
    return list.sort((a, b) => a.line - b.line);
  }, [compiled, derived, sim.status, sim.error]);

  const execLines = sim.status === 'running' && sim.program ? [...new Set(sim.program.taskLines().map((t) => t.line))] : [];
  const errorCount = compiled.diagnostics.filter((d) => d.severity === 'error').length;

  return (
    <div className="app">
      <header className="toolbar">
        <h1>EV3 Simulator · ROBOTC</h1>
        <nav className="tabs">
          <button className={tab === 'sim' ? 'active' : ''} onClick={() => setTab('sim')}>Code & simulation</button>
          <button className={tab === 'robot' ? 'active' : ''} onClick={() => setTab('robot')}>
            Robot builder{derived.robot ? '' : ' ⚠'}
          </button>
          <button className={tab === 'map' ? 'active' : ''} onClick={() => setTab('map')}>Map editor</button>
        </nav>
        <div className="controls">
          <button className="primary" onClick={run} title="F5">▶ Run</button>
          <button onClick={stop} disabled={sim.status !== 'running'}>■ Stop</button>
          <button onClick={reset} title="Put the robot back at the start">↺ Reset</button>
          <button onClick={() => setPaused((p) => !p)}>{paused ? '⏵ Resume' : '⏸ Pause'}</button>
          <label>
            Speed
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {SPEEDS.map((s) => (
                <option key={s} value={s}>×{s}</option>
              ))}
            </select>
          </label>
          <span className={`status status-${sim.status}`}>
            {STATUS_TEXT[sim.status]}
            {sim.status === 'error' && sim.error ? ` (line ${sim.error.line})` : ''} · {(sim.time / 1000).toFixed(1)} s
          </span>
        </div>
      </header>

      {tab === 'map' ? (
        <MapEditor map={map} onChange={setMap} />
      ) : tab === 'robot' ? (
        <RobotBuilder design={design} onChange={setDesign} robot={derived.robot} issues={derived.issues} onInsertPragmas={insertPragmas} />
      ) : (
        <main className="workspace">
          <section className="code-pane">
            <div className="pane-bar">
              <select
                value=""
                onChange={(e) => {
                  const ex = EXAMPLES.find((x) => x.id === e.target.value);
                  if (ex && (code === ex.code || confirm('Replace the current code with this example?'))) setCode(ex.code);
                }}
              >
                <option value="">Examples…</option>
                {EXAMPLES.map((ex) => (
                  <option key={ex.id} value={ex.id}>{ex.title}</option>
                ))}
              </select>
              <button onClick={openCode}>Open file…</button>
              <button onClick={() => downloadText('program.c', code)}>Save file</button>
              <span className={`compile-state ${errorCount ? 'bad' : 'good'}`}>
                {errorCount ? `${errorCount} error${errorCount === 1 ? '' : 's'}` : 'No errors'}
              </span>
            </div>
            <CodeEditor
              value={code}
              onChange={setCode}
              diagnostics={diagnostics}
              execLines={execLines}
              onReady={(api) => (editorApi.current = api)}
            />
            {diagnostics.length > 0 && (
              <ul className="problems" dir="ltr">
                {diagnostics.map((d, k) => (
                  <li key={k} className={d.severity} onClick={() => editorApi.current?.revealLine(d.line)}>
                    <span className="line">Line {d.line}</span> {d.message}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="sim-pane">
            <div className="pane-bar">
              <span className="map-name">{map.name}</span>
              <label className="check">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
                Follow robot
              </label>
              <label className="check">
                <input type="checkbox" checked={showRays} onChange={(e) => setShowRays(e.target.checked)} />
                Sensor rays
              </label>
              <label className="check">
                <input type="checkbox" checked={muted} onChange={(e) => setMuted(e.target.checked)} />
                Mute
              </label>
              <span className="muted hint">Drag the robot to move it · Shift+drag to turn it · Double-click: fit to window</span>
            </div>
            <SimView ref={simView} sim={sim} map={map} floor={floor} follow={follow} showRays={showRays} />
            <div className="bottom-panels">
              <BrickPanel sim={sim} />
              <Readouts sim={sim} />
              <DebugStream text={sim.debugText} onClear={() => sim.clearDebug()} />
            </div>
          </section>
        </main>
      )}
      {notice && (
        <div className="notice" onClick={() => setNotice('')}>
          {notice}
        </div>
      )}
    </div>
  );
}
