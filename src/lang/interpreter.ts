import { Call, Expr, FuncDecl, Ident, Program, Stmt, Type, VarDeclItem, isArray } from './ast';
import { RuntimeError } from './errors';
import { FormatArg, format, valueToString } from './format';
import { Hardware } from './hardware';
import { BUILTINS, ParamKind } from './robotc-api';

/** Yielded after each statement: one unit of CPU time. */
const STEP = 0;
/** Yielded to suspend the task until a simulation time. */
interface Wait {
  until: number;
}
type Yield = typeof STEP | Wait;
type Gen<T> = Generator<Yield, T, void>;

const NORMAL = 0;
const BREAK = 1;
const CONTINUE = 2;
const RETURN = 3;

const MAX_CALL_DEPTH = 256;

interface Ref {
  get(): any;
  set(v: any): void;
}

class SlotRef implements Ref {
  constructor(
    private arr: any[],
    private i: number,
  ) {}
  get() {
    return this.arr[this.i];
  }
  set(v: any) {
    this.arr[this.i] = v;
  }
}

class Frame {
  slots: any[];
  ret: any;
  constructor(size: number) {
    this.slots = new Array(size);
  }
}

interface TaskState {
  name: string;
  gen: Gen<unknown>;
  wakeAt: number;
  stopped: boolean;
  line: number;
  depth: number;
}

export type EndReason = 'done' | 'stopped' | 'error';

/** Converts a value to a declared type the way a C assignment does. */
export function convert(v: any, t: Type): any {
  switch (t.kind) {
    case 'float':
      return typeof v === 'number' ? v : Number(v);
    case 'bool':
      return v ? 1 : 0;
    case 'string':
      return typeof v === 'string' ? v : String(v);
    case 'int': {
      let n = Math.trunc(v);
      if (!Number.isFinite(n)) n = 0;
      if (t.bits === 8) return t.unsigned ? n & 0xff : (n << 24) >> 24;
      if (t.bits === 16) return t.unsigned ? n & 0xffff : (n << 16) >> 16;
      return t.unsigned ? n >>> 0 : n | 0;
    }
    default:
      return v;
  }
}

function defaultValue(t: Type, depth = 0): any {
  if (depth < t.dims.length) {
    return Array.from({ length: t.dims[depth] }, () => defaultValue(t, depth + 1));
  }
  return t.kind === 'string' ? '' : 0;
}

/** Arithmetic on two numbers; `kind` is the result kind ('int' wraps to 32 bits). */
function arith(op: string, a: number, b: number, kind: string, line: number): number {
  const int = kind !== 'float';
  switch (op) {
    case '+':
      return int ? (a + b) | 0 : a + b;
    case '-':
      return int ? (a - b) | 0 : a - b;
    case '*':
      return int ? Math.imul(a, b) : a * b;
    case '/':
      if (int) {
        if (b === 0) throw new RuntimeError('Division by zero', line);
        return Math.trunc(a / b) | 0;
      }
      return a / b;
    case '%':
      if (b === 0) throw new RuntimeError('Division by zero (%)', line);
      return a % b;
    case '&':
      return a & b;
    case '|':
      return a | b;
    case '^':
      return a ^ b;
    case '<<':
      return a << b;
    case '>>':
      return a >> b;
  }
  throw new RuntimeError(`Unknown operator ${op}`, line);
}

function compare(op: string, a: any, b: any): number {
  switch (op) {
    case '==':
      return a === b ? 1 : 0;
    case '!=':
      return a !== b ? 1 : 0;
    case '<':
      return a < b ? 1 : 0;
    case '>':
      return a > b ? 1 : 0;
    case '<=':
      return a <= b ? 1 : 0;
    default:
      return a >= b ? 1 : 0;
  }
}

const COMPARE_OPS = new Set(['==', '!=', '<', '>', '<=', '>=']);

const isSysArray = (e: Expr) => e.type === 'ident' && e.bind?.kind === 'sysarray';

const clampSpeed = (v: number) => Math.max(-100, Math.min(100, v));

/**
 * Runs a checked ROBOTC program. Each task is a generator that yields after every
 * statement; `tick()` gives every runnable task a slice of statements per simulated ms.
 */
export class Interpreter {
  private globals: any[];
  private tasks = new Map<string, TaskState>();
  private functions = new Map<string, FuncDecl>();
  private timers = [0, 0, 0, 0];
  private startTime = 0;
  private seed = 12345;
  private cur!: TaskState;
  ended = false;
  endReason?: EndReason;
  error?: RuntimeError;
  /** Statements each task may run per simulated millisecond. */
  stepsPerMs = 100;
  onEnd?: (reason: EndReason, error?: RuntimeError) => void;

  constructor(
    private program: Program,
    globalCount: number,
    private hw: Hardware,
  ) {
    this.globals = new Array(globalCount);
    for (const f of program.functions) if (f.body) this.functions.set(f.name, f);
  }

  /** Initializes globals and starts `task main`. */
  start() {
    this.startTime = this.hw.now();
    this.timers = [this.startTime, this.startTime, this.startTime, this.startTime];
    const initTask: TaskState = { name: '<init>', gen: undefined!, wakeAt: 0, stopped: false, line: 1, depth: 0 };
    this.cur = initTask;
    const dummy = new Frame(0);
    try {
      for (const g of this.program.globals) {
        for (const it of g.items) {
          initTask.line = it.line;
          this.globals[it.slot!] = this.runSync(this.initValue(it, dummy));
        }
      }
    } catch (e) {
      this.fail(e);
      return;
    }
    this.startTask('main');
  }

  /** Line each task is currently on (for highlighting in the editor). */
  taskLines(): Array<{ name: string; line: number }> {
    return [...this.tasks.values()].map((t) => ({ name: t.name, line: t.line }));
  }

  stop() {
    this.end('stopped');
  }

  /** Runs one simulated millisecond of every task that is awake. */
  tick() {
    if (this.ended) return;
    const now = this.hw.now();
    for (const t of [...this.tasks.values()]) {
      if (t.stopped || t.wakeAt > now) continue;
      this.cur = t;
      let budget = this.stepsPerMs;
      try {
        while (budget > 0) {
          const r = t.gen.next();
          if (this.ended || t.stopped) break;
          if (r.done) {
            this.tasks.delete(t.name);
            if (t.name === 'main') this.end('done');
            break;
          }
          if (r.value === STEP) budget--;
          else {
            t.wakeAt = r.value.until;
            break;
          }
        }
      } catch (e) {
        this.fail(e);
      }
      if (this.ended) return;
    }
  }

  private fail(e: unknown) {
    if (e instanceof RuntimeError) {
      this.error = e;
    } else if (e instanceof RangeError) {
      this.error = new RuntimeError('Out of stack space (infinite recursion?)', this.cur.line);
    } else {
      this.error = new RuntimeError(`Internal error: ${(e as Error)?.message ?? e}`, this.cur.line);
    }
    this.end('error');
  }

  private end(reason: EndReason) {
    if (this.ended) return;
    this.ended = true;
    this.endReason = reason;
    for (const t of this.tasks.values()) t.stopped = true;
    this.tasks.clear();
    for (let p = 0; p < 4; p++) this.hw.stopMotor(p);
    this.onEnd?.(reason, this.error);
  }

  private startTask(name: string) {
    const fn = this.functions.get(name)!;
    const existing = this.tasks.get(name);
    if (existing) existing.stopped = true;
    const state: TaskState = { name, gen: undefined!, wakeAt: 0, stopped: false, line: fn.line, depth: 0 };
    state.gen = this.invoke(fn, [], state);
    this.tasks.set(name, state);
  }

  /** Runs a generator to completion; used for global initializers, which cannot wait. */
  private runSync<T>(g: Gen<T>): T {
    for (;;) {
      const r = g.next();
      if (r.done) return r.value;
      if (r.value !== STEP) throw new RuntimeError('Cannot wait while initializing globals', this.cur.line);
    }
  }

  // ---------- statements ----------

  private *invoke(fn: FuncDecl, args: any[], task?: TaskState): Gen<any> {
    const t = task ?? this.cur;
    if (++t.depth > MAX_CALL_DEPTH) throw new RuntimeError(`Too many nested calls of '${fn.name}' (infinite recursion?)`, fn.line);
    const frame = new Frame(fn.frameSize ?? 0);
    fn.params.forEach((p, k) => {
      frame.slots[k] = p.byRef || isArray(p.ptype) ? args[k] : convert(args[k], p.ptype);
    });
    yield* this.block(fn.body!.body, frame);
    t.depth--;
    return fn.ret.kind === 'void' ? undefined : convert(frame.ret ?? 0, fn.ret);
  }

  private *block(body: Stmt[], f: Frame): Gen<number> {
    for (const s of body) {
      const r = yield* this.exec(s, f);
      if (r !== NORMAL) return r;
    }
    return NORMAL;
  }

  private *exec(s: Stmt, f: Frame): Gen<number> {
    this.cur.line = s.line;
    yield STEP;
    switch (s.type) {
      case 'expr':
        if (s.expr.y) yield* this.evalG(s.expr, f);
        else this.eval(s.expr, f);
        return NORMAL;
      case 'var':
        for (const it of s.items) f.slots[it.slot!] = yield* this.initValue(it, f);
        return NORMAL;
      case 'if': {
        const c = s.test.y ? yield* this.evalG(s.test, f) : this.eval(s.test, f);
        if (c) return yield* this.exec(s.then, f);
        if (s.else) return yield* this.exec(s.else, f);
        return NORMAL;
      }
      case 'while':
        for (;;) {
          const c = s.test.y ? yield* this.evalG(s.test, f) : this.eval(s.test, f);
          if (!c) return NORMAL;
          const r = yield* this.exec(s.body, f);
          if (r === BREAK) return NORMAL;
          if (r === RETURN) return RETURN;
          this.cur.line = s.line;
        }
      case 'do':
        for (;;) {
          const r = yield* this.exec(s.body, f);
          if (r === BREAK) return NORMAL;
          if (r === RETURN) return RETURN;
          this.cur.line = s.line;
          const c = s.test.y ? yield* this.evalG(s.test, f) : this.eval(s.test, f);
          if (!c) return NORMAL;
        }
      case 'for': {
        if (s.init) yield* this.exec(s.init, f);
        for (;;) {
          if (s.test) {
            const c = s.test.y ? yield* this.evalG(s.test, f) : this.eval(s.test, f);
            if (!c) return NORMAL;
          }
          const r = yield* this.exec(s.body, f);
          if (r === BREAK) return NORMAL;
          if (r === RETURN) return RETURN;
          this.cur.line = s.line;
          if (s.update) {
            if (s.update.y) yield* this.evalG(s.update, f);
            else this.eval(s.update, f);
          }
        }
      }
      case 'switch': {
        const d = s.disc.y ? yield* this.evalG(s.disc, f) : this.eval(s.disc, f);
        let start = s.cases.findIndex((c) => c.test && c.value === d);
        if (start < 0) start = s.cases.findIndex((c) => !c.test);
        if (start < 0) return NORMAL;
        for (let k = start; k < s.cases.length; k++) {
          const r = yield* this.block(s.cases[k].body, f);
          if (r === BREAK) return NORMAL;
          if (r !== NORMAL) return r;
        }
        return NORMAL;
      }
      case 'break':
        return BREAK;
      case 'continue':
        return CONTINUE;
      case 'return':
        if (s.value) f.ret = s.value.y ? yield* this.evalG(s.value, f) : this.eval(s.value, f);
        return RETURN;
      case 'block':
        return yield* this.block(s.body, f);
      case 'empty':
        return NORMAL;
    }
  }

  private *initValue(it: VarDeclItem, f: Frame): Gen<any> {
    const t = it.vtype;
    if (!it.init) return defaultValue(t);
    if (!isArray(t)) {
      const v = it.init.y ? yield* this.evalG(it.init, f) : this.eval(it.init, f);
      return convert(v, t);
    }
    if (it.init.type === 'str') {
      const arr = defaultValue(t) as number[];
      for (let k = 0; k < it.init.value.length; k++) arr[k] = it.init.value.charCodeAt(k);
      return arr;
    }
    const scalar: Type = { ...t, dims: [] };
    const self = this;
    function* build(e: Expr, depth: number): Gen<any> {
      if (depth === t.dims.length) {
        const v = e.y ? yield* self.evalG(e, f) : self.eval(e, f);
        return convert(v, scalar);
      }
      const arr = defaultValue({ ...t, dims: t.dims.slice(depth) });
      if (e.type === 'init') {
        for (let k = 0; k < e.items.length; k++) arr[k] = yield* build(e.items[k], depth + 1);
      }
      return arr;
    }
    return yield* build(it.init, 0);
  }

  // ---------- expressions (fast path: cannot suspend) ----------

  private eval(e: Expr, f: Frame): any {
    switch (e.type) {
      case 'num':
      case 'str':
        return e.value;
      case 'ident':
        return this.readIdent(e, f);
      case 'unary':
        return this.unary(e.op, this.eval(e.arg, f), e.ty!.kind);
      case 'update':
        return this.update(e, this.loc(e.arg, f));
      case 'binary':
        if (e.op === '&&') return this.eval(e.left, f) ? (this.eval(e.right, f) ? 1 : 0) : 0;
        if (e.op === '||') return this.eval(e.left, f) ? 1 : this.eval(e.right, f) ? 1 : 0;
        return this.binary(e, this.eval(e.left, f), this.eval(e.right, f));
      case 'assign':
        return this.assign(e, f, this.loc(e.target, f), this.eval(e.value, f));
      case 'cond':
        return this.eval(e.test, f) ? this.eval(e.then, f) : this.eval(e.else, f);
      case 'cast':
        return convert(this.eval(e.arg, f), e.to);
      case 'index':
        return this.readIndex(e, isSysArray(e.obj) ? null : this.eval(e.obj, f), this.eval(e.index, f));
      case 'call':
        return this.builtin(e, this.args(e, f));
      case 'init':
        throw new RuntimeError('Unexpected {...}', e.line);
    }
  }

  // ---------- expressions (slow path: may suspend) ----------

  private *evalG(e: Expr, f: Frame): Gen<any> {
    if (!e.y) return this.eval(e, f);
    switch (e.type) {
      case 'call': {
        if (e.callee === 'waitUntil') {
          // A macro in ROBOTC: re-evaluates its condition every millisecond.
          const cond = e.args[0];
          while (!(cond.y ? yield* this.evalG(cond, f) : this.eval(cond, f))) yield { until: this.hw.now() + 1 };
          return undefined;
        }
        const args = yield* this.argsG(e, f);
        const target = e.target!;
        if (target.kind === 'user') {
          const saved = this.cur.line;
          const r = yield* this.invoke(target.fn, args);
          this.cur.line = saved;
          return r;
        }
        if (BUILTINS[e.callee].yields) return yield* this.builtinG(e, args);
        return this.builtin(e, args);
      }
      case 'unary':
        return this.unary(e.op, yield* this.evalG(e.arg, f), e.ty!.kind);
      case 'update':
        return this.update(e, yield* this.locG(e.arg, f));
      case 'binary': {
        if (e.op === '&&') return (yield* this.evalG(e.left, f)) ? ((yield* this.evalG(e.right, f)) ? 1 : 0) : 0;
        if (e.op === '||') return (yield* this.evalG(e.left, f)) ? 1 : (yield* this.evalG(e.right, f)) ? 1 : 0;
        const a = yield* this.evalG(e.left, f);
        const b = yield* this.evalG(e.right, f);
        return this.binary(e, a, b);
      }
      case 'assign': {
        const target = yield* this.locG(e.target, f);
        const v = yield* this.evalG(e.value, f);
        return this.assign(e, f, target, v);
      }
      case 'cond':
        return (yield* this.evalG(e.test, f)) ? yield* this.evalG(e.then, f) : yield* this.evalG(e.else, f);
      case 'cast':
        return convert(yield* this.evalG(e.arg, f), e.to);
      case 'index': {
        const obj = isSysArray(e.obj) ? null : yield* this.evalG(e.obj, f);
        const idx = yield* this.evalG(e.index, f);
        return this.readIndex(e, obj, idx);
      }
      default:
        return this.eval(e, f);
    }
  }

  private paramKinds(e: Call): (ParamKind | 'any' | 'uref' | 'uval')[] {
    const t = e.target!;
    if (t.kind === 'user') return t.fn.params.map((p) => (p.byRef ? 'uref' : 'uval'));
    return BUILTINS[e.callee].params;
  }

  private args(e: Call, f: Frame): any[] {
    const kinds = this.paramKinds(e);
    return e.args.map((a, k) => {
      const kind = kinds[k] ?? 'any';
      if (kind === 'task') return (a as Ident).name;
      if (kind === 'ref' || kind === 'sref' || kind === 'uref') return this.loc(a, f);
      return this.eval(a, f);
    });
  }

  private *argsG(e: Call, f: Frame): Gen<any[]> {
    const kinds = this.paramKinds(e);
    const out: any[] = [];
    for (let k = 0; k < e.args.length; k++) {
      const a = e.args[k];
      const kind = kinds[k] ?? 'any';
      if (kind === 'task') out.push((a as Ident).name);
      else if (kind === 'ref' || kind === 'sref' || kind === 'uref') out.push(yield* this.locG(a, f));
      else out.push(a.y ? yield* this.evalG(a, f) : this.eval(a, f));
    }
    return out;
  }

  // ---------- reading and writing ----------

  private readIdent(e: Ident, f: Frame): any {
    const b = e.bind!;
    switch (b.kind) {
      case 'local': {
        const v = f.slots[b.slot];
        return b.byRef ? (v as Ref).get() : v;
      }
      case 'global':
        return this.globals[b.slot];
      case 'const':
        return b.value;
      case 'sysvar':
        return this.readSysVar(b.name);
      case 'sysarray':
        throw new RuntimeError(`'${e.name}' must be used with an index, like ${e.name}[0]`, e.line);
      case 'task':
        throw new RuntimeError(`'${e.name}' is a task`, e.line);
    }
  }

  private loc(e: Expr, f: Frame): Ref {
    if (e.type === 'ident') {
      const b = e.bind!;
      if (b.kind === 'local') return b.byRef ? (f.slots[b.slot] as Ref) : new SlotRef(f.slots, b.slot);
      if (b.kind === 'global') return new SlotRef(this.globals, b.slot);
      if (b.kind === 'sysvar') return this.sysVarRef(b.name, e.line);
      throw new RuntimeError(`Cannot change '${e.name}'`, e.line);
    }
    if (e.type === 'index') return this.indexRef(e, this.eval(e.index, f), f);
    throw new RuntimeError('Cannot assign to this expression', e.line);
  }

  private *locG(e: Expr, f: Frame): Gen<Ref> {
    if (!e.y) return this.loc(e, f);
    if (e.type === 'index') {
      const idx = yield* this.evalG(e.index, f);
      if (e.obj.type === 'ident' && e.obj.bind?.kind === 'sysarray') return this.sysArrayRef(e.obj.name, idx, e.line);
      const arr = yield* this.evalG(e.obj, f);
      return this.arrayRef(arr, idx, e.line);
    }
    return this.loc(e, f);
  }

  private indexRef(e: Extract<Expr, { type: 'index' }>, idx: number, f: Frame): Ref {
    if (e.obj.type === 'ident' && e.obj.bind?.kind === 'sysarray') return this.sysArrayRef(e.obj.name, idx, e.line);
    return this.arrayRef(this.eval(e.obj, f), idx, e.line);
  }

  private arrayRef(arr: any[], idx: number, line: number): Ref {
    if (idx < 0 || idx >= arr.length || !Number.isInteger(idx)) {
      throw new RuntimeError(`Index ${idx} is outside the array (size ${arr.length})`, line);
    }
    return new SlotRef(arr, idx);
  }

  private readIndex(e: Extract<Expr, { type: 'index' }>, obj: any, idx: number): any {
    if (e.obj.type === 'ident' && e.obj.bind?.kind === 'sysarray') return this.sysArrayRef(e.obj.name, idx, e.line).get();
    const arr = obj as any[];
    if (!Array.isArray(arr)) throw new RuntimeError('Not an array', e.line);
    if (idx < 0 || idx >= arr.length || !Number.isInteger(idx)) {
      throw new RuntimeError(`Index ${idx} is outside the array (size ${arr.length})`, e.line);
    }
    return arr[idx];
  }

  private unary(op: string, a: number, kind: string): number {
    switch (op) {
      case '-':
        return kind === 'float' ? -a : -a | 0;
      case '!':
        return a ? 0 : 1;
      case '~':
        return ~a;
      default:
        return a;
    }
  }

  private binary(e: Extract<Expr, { type: 'binary' }>, a: any, b: any): any {
    if (COMPARE_OPS.has(e.op)) return compare(e.op, a, b);
    if (e.ty!.kind === 'string') return valueToString(a, e.left.ty!) + valueToString(b, e.right.ty!);
    return arith(e.op, a, b, e.ty!.kind, e.line);
  }

  private update(e: Extract<Expr, { type: 'update' }>, ref: Ref): number {
    const old = ref.get();
    const nv = convert(e.op === '++' ? old + 1 : old - 1, e.arg.ty!);
    ref.set(nv);
    return e.prefix ? nv : old;
  }

  private assign(e: Extract<Expr, { type: 'assign' }>, _f: Frame, ref: Ref, v: any): any {
    const t = e.target.ty!;
    let nv: any;
    if (e.op === '=') nv = convert(v, t);
    else if (t.kind === 'string') nv = ref.get() + valueToString(v, e.value.ty!);
    else {
      const kind = t.kind === 'float' || e.value.ty!.kind === 'float' ? 'float' : 'int';
      nv = convert(arith(e.op.slice(0, -1), ref.get(), v, kind, e.line), t);
    }
    ref.set(nv);
    return nv;
  }

  // ---------- system variables ----------

  private readSysVar(name: string): number {
    switch (name) {
      case 'nSysTime':
        return Math.floor(this.hw.now());
      case 'nPgmTime':
        return Math.floor(this.hw.now() - this.startTime);
      case 'bSoundActive':
        return this.hw.isSoundActive() ? 1 : 0;
      case 'nImmediateBatteryLevel':
        return 8000;
    }
    return 0;
  }

  private sysVarRef(name: string, line: number): Ref {
    throw new RuntimeError(`'${name}' is read-only`, line);
  }

  private sysArrayRef(name: string, idx: number, line: number): Ref {
    const hw = this.hw;
    switch (name) {
      case 'motor':
        this.motorPort(idx, line);
        return { get: () => hw.getMotorPower(idx), set: (v) => hw.setMotorPower(idx, clampSpeed(v)) };
      case 'nMotorEncoder':
        this.motorPort(idx, line);
        return { get: () => Math.round(hw.getEncoder(idx)), set: (v) => hw.setEncoder(idx, v) };
      case 'SensorValue':
        this.sensorPort(idx, line);
        return {
          get: () => hw.readSensor(idx, 'value'),
          set: (v) => {
            if (v === 0) hw.resetSensor(idx);
          },
        };
      case 'time1':
      case 'time10':
      case 'time100': {
        if (idx < 0 || idx > 3) throw new RuntimeError(`Timer ${idx} does not exist (use T1..T4)`, line);
        const unit = name === 'time1' ? 1 : name === 'time10' ? 10 : 100;
        return {
          get: () => Math.floor((hw.now() - this.timers[idx]) / unit),
          set: (v) => {
            this.timers[idx] = hw.now() - v * unit;
          },
        };
      }
    }
    throw new RuntimeError(`Unknown system array ${name}`, line);
  }

  private motorPort(p: number, line: number) {
    if (!(p >= 0 && p <= 3 && Number.isInteger(p))) throw new RuntimeError(`${p} is not a motor port (use motorA..motorD)`, line);
    return p;
  }

  private sensorPort(p: number, line: number) {
    if (!(p >= 0 && p <= 3 && Number.isInteger(p))) throw new RuntimeError(`${p} is not a sensor port (use S1..S4)`, line);
    return p;
  }

  private random() {
    // mulberry32: deterministic, so a run can be repeated exactly
    let t = (this.seed = (this.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ---------- builtins ----------

  private fmtArgs(e: Call, args: any[], from: number): [string, FormatArg[]] {
    return [args[from], args.slice(from + 1).map((value, k) => ({ value, ty: e.args[from + 1 + k].ty! }))];
  }

  private *builtinG(e: Call, a: any[]): Gen<void> {
    const hw = this.hw;
    switch (e.callee) {
      case 'sleep':
      case 'wait1Msec':
        yield { until: hw.now() + Math.max(0, a[0]) };
        return;
      case 'wait10Msec':
        yield { until: hw.now() + Math.max(0, a[0]) * 10 };
        return;
      case 'wait':
        yield { until: hw.now() + Math.max(0, a[0]) * 1000 };
        return;
      case 'waitUntilMotorStop': {
        const p = this.motorPort(a[0], e.line);
        yield { until: hw.now() + 1 };
        while (hw.isMotorBusy(p)) yield { until: hw.now() + 1 };
        return;
      }
      case 'waitForButtonPress':
        while (!hw.isButtonPressed(7)) yield { until: hw.now() + 5 };
        return;
      case 'abortTimeslice':
      case 'releaseCPU':
      case 'EndTimeSlice':
        yield { until: hw.now() };
        return;
    }
    throw new RuntimeError(`'${e.callee}' is not implemented yet`, e.line);
  }

  private builtin(e: Call, a: any[]): any {
    const hw = this.hw;
    const line = e.line;
    const m = () => this.motorPort(a[0], line);
    const s = () => this.sensorPort(a[0], line);
    switch (e.callee) {
      // motors
      case 'setMotorSpeed':
      case 'setMotor':
        return hw.setMotorPower(m(), clampSpeed(a[1]));
      case 'stopMotor':
        return hw.stopMotor(m());
      case 'stopAllMotors':
        for (let p = 0; p < 4; p++) hw.stopMotor(p);
        return;
      case 'setMotorTarget':
        return hw.setMotorTarget(m(), a[1], clampSpeed(a[2]));
      case 'moveMotorTarget':
        return hw.setMotorTarget(m(), hw.getEncoder(m()) + a[1], clampSpeed(a[2]));
      case 'getMotorEncoder':
        return Math.round(hw.getEncoder(m()));
      case 'resetMotorEncoder':
        return hw.setEncoder(m(), 0);
      case 'getMotorRunning':
        return hw.isMotorBusy(m()) ? 1 : 0;
      case 'getMotorSpeed':
        return hw.getMotorPower(m());
      case 'getMotorRPM':
        return hw.getMotorRPM(m());
      case 'setMotorBrakeMode':
        return hw.setBrakeMode(m(), a[1] === 1);
      case 'setMotorReversed':
        return hw.setReversed(m(), !!a[1]);
      case 'setMotorSync':
        this.motorPort(a[1], line);
        return hw.setSync(m(), a[1], Math.max(-100, Math.min(100, a[2])), clampSpeed(a[3]));
      case 'setMotorSyncEncoder':
        this.motorPort(a[1], line);
        return hw.setSync(m(), a[1], Math.max(-100, Math.min(100, a[2])), clampSpeed(a[4]), { kind: 'degrees', value: Math.abs(a[3]) });
      case 'setMotorSyncTime':
        this.motorPort(a[1], line);
        return hw.setSync(m(), a[1], Math.max(-100, Math.min(100, a[2])), clampSpeed(a[4]), { kind: 'time', value: Math.max(0, a[3]) });

      // sensors
      case 'getColorName':
        return hw.readSensor(s(), 'colorName');
      case 'getColorReflected':
        return hw.readSensor(s(), 'reflected');
      case 'getColorAmbient':
        return hw.readSensor(s(), 'ambient');
      case 'getColorHue':
        return hw.readSensor(s(), 'hue');
      case 'getColorRGB': {
        const [r, g, b] = hw.readColorRGB(s());
        (a[1] as Ref).set(convert(r, e.args[1].ty!));
        (a[2] as Ref).set(convert(g, e.args[2].ty!));
        (a[3] as Ref).set(convert(b, e.args[3].ty!));
        return;
      }
      case 'getGyroDegrees':
        return hw.readSensor(s(), 'gyroAngle');
      case 'getGyroHeading':
        return ((hw.readSensor(s(), 'gyroAngle') % 360) + 360) % 360;
      case 'getGyroRate':
        return hw.readSensor(s(), 'gyroRate');
      case 'getUSDistance':
        return hw.readSensor(s(), 'distance');
      case 'getTouchValue':
        return hw.readSensor(s(), 'touch');
      case 'getBumpedValue':
        return hw.readSensor(s(), 'bumped');
      case 'getIRDistance':
        return hw.readSensor(s(), 'ir');
      case 'getSensorValue':
        return hw.readSensor(s(), 'value');
      case 'resetGyro':
      case 'resetBumpedValue':
      case 'resetSensor':
        return hw.resetSensor(s());

      // timers
      case 'clearTimer':
        if (a[0] < 0 || a[0] > 3) throw new RuntimeError('Use a timer T1..T4', line);
        this.timers[a[0]] = hw.now();
        return;
      case 'getTimerValue':
        if (a[0] < 0 || a[0] > 3) throw new RuntimeError('Use a timer T1..T4', line);
        return Math.floor(hw.now() - this.timers[a[0]]);

      // tasks
      case 'startTask':
        return this.startTask(a[0]);
      case 'stopTask': {
        const t = this.tasks.get(a[0]);
        if (t) {
          t.stopped = true;
          this.tasks.delete(a[0]);
        }
        if (a[0] === 'main') this.end('stopped');
        return;
      }
      case 'stopAllTasks':
        return this.end('stopped');

      // display
      case 'displayTextLine':
      case 'displayString':
        return hw.lcdText(a[0], format(...this.fmtArgs(e, a, 1)), false, false);
      case 'displayBigTextLine':
        return hw.lcdText(a[0], format(...this.fmtArgs(e, a, 1)), true, false);
      case 'displayCenteredTextLine':
        return hw.lcdText(a[0], format(...this.fmtArgs(e, a, 1)), false, true);
      case 'displayCenteredBigTextLine':
        return hw.lcdText(a[0], format(...this.fmtArgs(e, a, 1)), true, true);
      case 'displayClearTextLine':
        return hw.lcdClearLine(a[0]);
      case 'eraseDisplay':
        return hw.lcdClear();
      case 'writeDebugStream':
        return hw.debug(format(...this.fmtArgs(e, a, 0)));
      case 'writeDebugStreamLine':
        return hw.debug(format(...this.fmtArgs(e, a, 0)) + '\n');
      case 'clearDebugStream':
        return hw.clearDebug();

      // buttons, LED, sound
      case 'getButtonPress':
        return hw.isButtonPressed(a[0]) ? 1 : 0;
      case 'setLEDColor':
        return hw.setLed(a[0]);
      case 'playTone':
        return hw.playTone(a[0], a[1] * 10);
      case 'playSound':
        return hw.playSound(a[0]);
      case 'setSoundVolume':
        return hw.setVolume(a[0]);
      case 'clearSounds':
        return hw.stopSounds();

      // math
      case 'abs':
      case 'fabs':
        return Math.abs(a[0]);
      case 'sgn':
        return Math.sign(a[0]);
      case 'sqrt':
        return Math.sqrt(a[0]);
      case 'pow':
        return Math.pow(a[0], a[1]);
      case 'exp':
        return Math.exp(a[0]);
      case 'log':
        return Math.log(a[0]);
      case 'log10':
        return Math.log10(a[0]);
      case 'sin':
        return Math.sin(a[0]);
      case 'cos':
        return Math.cos(a[0]);
      case 'tan':
        return Math.tan(a[0]);
      case 'asin':
        return Math.asin(a[0]);
      case 'acos':
        return Math.acos(a[0]);
      case 'atan':
        return Math.atan(a[0]);
      case 'atan2':
        return Math.atan2(a[0], a[1]);
      case 'sinDegrees':
        return Math.sin((a[0] * Math.PI) / 180);
      case 'cosDegrees':
        return Math.cos((a[0] * Math.PI) / 180);
      case 'radiansToDegrees':
        return (a[0] * 180) / Math.PI;
      case 'degreesToRadians':
        return (a[0] * Math.PI) / 180;
      case 'round':
        return Math.round(a[0]);
      case 'floor':
        return Math.floor(a[0]);
      case 'ceil':
        return Math.ceil(a[0]);
      case 'min':
        return Math.min(a[0], a[1]);
      case 'max':
        return Math.max(a[0], a[1]);
      case 'random':
        return Math.floor(this.random() * (Math.trunc(a[0]) + 1));
      case 'srand':
        this.seed = a[0] | 0;
        return;

      // strings
      case 'strlen':
        return (a[0] as string).length;
      case 'strcat':
        return (a[0] as Ref).set((a[0] as Ref).get() + a[1]);
      case 'strcpy':
        return (a[0] as Ref).set(a[1]);
      case 'strcmp':
        return a[0] < a[1] ? -1 : a[0] > a[1] ? 1 : 0;
      case 'sprintf':
        return (a[0] as Ref).set(format(...this.fmtArgs(e, a, 1)));
      case 'atoi':
        return parseInt(a[0], 10) || 0;
      case 'atof':
        return parseFloat(a[0]) || 0;
    }
    throw new RuntimeError(`'${e.callee}' is not implemented yet`, line);
  }
}
