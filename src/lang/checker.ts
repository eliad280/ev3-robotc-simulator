import {
  Binding, Expr, FuncDecl, Ident, Program, Stmt, T, Type, VarDeclItem, elementType, isArray, isNumeric, typeName,
} from './ast';
import { CompileError, Diagnostic } from './errors';
import { BUILTINS, CONSTANTS, RETURNS_ARG_KIND, SYS_ARRAYS, SYS_VARS } from './robotc-api';

interface Scope {
  vars: Map<string, { slot: number; type: Type; byRef: boolean; isConst: boolean }>;
}

export interface CheckResult {
  diagnostics: Diagnostic[];
  globalCount: number;
}

/**
 * Resolves every name, computes expression types, assigns variable slots and reports
 * errors. Annotates the AST in place for the interpreter.
 */
export function check(program: Program, consts: Map<string, number>): CheckResult {
  const diagnostics: Diagnostic[] = [];
  const globals = new Map<string, { slot: number; type: Type; isConst: boolean }>();
  const functions = new Map<string, FuncDecl>();
  let globalCount = 0;

  const error = (msg: string, node: { line: number; col: number }): never => {
    throw new CompileError(msg, node.line, node.col);
  };
  const report = (e: unknown) => {
    if (e instanceof CompileError) diagnostics.push({ line: e.line, col: e.col, message: e.message, severity: 'error' });
    else throw e;
  };

  for (const f of program.functions) {
    const prev = functions.get(f.name);
    if (prev && prev.body && f.body) {
      report(new CompileError(`'${f.name}' is defined twice`, f.line, f.col));
      continue;
    }
    if (f.name in BUILTINS) {
      report(new CompileError(`'${f.name}' is a built-in ROBOTC function and cannot be redefined`, f.line, f.col));
      continue;
    }
    // A prototype followed by the definition: keep the one with a body.
    if (!prev || f.body) functions.set(f.name, f);
  }

  // ---------- per-function state ----------
  let scopes: Scope[] = [];
  let slotCount = 0;
  let current: FuncDecl | undefined;
  let loopDepth = 0;
  let switchDepth = 0;

  const lookupLocal = (name: string) => {
    for (let k = scopes.length - 1; k >= 0; k--) {
      const v = scopes[k].vars.get(name);
      if (v) return v;
    }
    return undefined;
  };

  const declare = (item: VarDeclItem, isConst: boolean) => {
    if (current) {
      const scope = scopes[scopes.length - 1];
      if (scope.vars.has(item.name)) error(`'${item.name}' is already declared in this block`, item);
      item.slot = slotCount++;
      scope.vars.set(item.name, { slot: item.slot, type: item.vtype, byRef: false, isConst });
    } else {
      if (globals.has(item.name)) error(`'${item.name}' is already declared`, item);
      if (functions.has(item.name)) error(`'${item.name}' is already a function name`, item);
      item.slot = globalCount++;
      item.isGlobal = true;
      globals.set(item.name, { slot: item.slot, type: item.vtype, isConst });
    }
  };

  const resolve = (id: Ident): { bind: Binding; type: Type; isConst?: boolean } => {
    const local = lookupLocal(id.name);
    if (local) return { bind: { kind: 'local', slot: local.slot, byRef: local.byRef }, type: local.type, isConst: local.isConst };
    const g = globals.get(id.name);
    if (g) return { bind: { kind: 'global', slot: g.slot }, type: g.type, isConst: g.isConst };
    if (consts.has(id.name)) {
      const v = consts.get(id.name)!;
      return { bind: { kind: 'const', value: v }, type: Number.isInteger(v) ? T.int() : T.float(), isConst: true };
    }
    if (id.name in CONSTANTS) {
      const v = CONSTANTS[id.name];
      return { bind: { kind: 'const', value: v }, type: Number.isInteger(v) ? T.int() : T.float(), isConst: true };
    }
    if (id.name in SYS_VARS) {
      const sv = SYS_VARS[id.name];
      return { bind: { kind: 'sysvar', name: id.name }, type: { ...T.int(), kind: sv.kind }, isConst: !sv.writable };
    }
    if (id.name in SYS_ARRAYS) {
      return { bind: { kind: 'sysarray', name: id.name }, type: { ...T.int(), dims: [-1] }, isConst: true };
    }
    const f = functions.get(id.name);
    if (f?.isTask) return { bind: { kind: 'task', name: f.name }, type: T.void(), isConst: true };
    if (f || id.name in BUILTINS) error(`'${id.name}' is a function; call it with ()`, id);
    return error(`'${id.name}' is not declared`, id);
  };

  const numericKind = (a: Type, b: Type): Type =>
    a.kind === 'float' || b.kind === 'float' ? T.float() : T.int();

  const requireNumeric = (e: Expr, what: string) => {
    if (!isNumeric(e.ty!)) error(`${what} must be a number, not ${typeName(e.ty!)}`, e);
  };

  const isLvalue = (e: Expr) => e.type === 'ident' || e.type === 'index';

  /** Checks that `e` can be assigned to and returns its type. */
  const checkLvalue = (e: Expr, what: string): Type => {
    if (e.type === 'ident') {
      const r = resolve(e);
      e.bind = r.bind;
      e.ty = r.type;
      if (r.bind.kind === 'sysvar' && r.isConst) error(`'${e.name}' is read-only`, e);
      if (r.bind.kind === 'const' || r.bind.kind === 'task') error(`Cannot ${what} '${e.name}': it is a constant`, e);
      if (r.isConst) error(`Cannot ${what} '${e.name}': it is declared const`, e);
      if (isArray(r.type)) error(`Cannot ${what} a whole array; use an index like ${e.name}[0]`, e);
      return r.type;
    }
    if (e.type === 'index') {
      const t = expr(e);
      if (isArray(t)) error(`Cannot ${what} a whole array row`, e);
      return t;
    }
    return error(`Cannot ${what} this expression`, e);
  };

  const convertible = (to: Type, from: Type) => {
    if (isArray(to) || isArray(from)) return false;
    if (to.kind === 'string') return from.kind === 'string';
    if (to.kind === 'void' || from.kind === 'void') return false;
    return from.kind !== 'string';
  };

  const expr = (e: Expr): Type => {
    const t = exprInner(e);
    e.ty = t;
    return t;
  };

  const exprInner = (e: Expr): Type => {
    switch (e.type) {
      case 'num':
        if (e.ty) return e.ty;
        return e.isFloat ? T.float() : e.isChar ? T.char() : T.int();
      case 'str':
        return T.string();
      case 'ident': {
        const r = resolve(e);
        e.bind = r.bind;
        if (r.bind.kind === 'task') error(`'${e.name}' is a task; use startTask(${e.name})`, e);
        return r.type;
      }
      case 'unary': {
        const a = expr(e.arg);
        e.y = e.arg.y;
        requireNumeric(e.arg, `The operand of '${e.op}'`);
        if (e.op === '!') return T.bool();
        if (e.op === '~') {
          if (a.kind === 'float') error("'~' needs an integer", e);
          return T.int();
        }
        return a.kind === 'float' ? T.float() : T.int();
      }
      case 'update': {
        const t = checkLvalue(e.arg, 'change');
        e.y = e.arg.y;
        if (!isNumeric(t)) error(`'${e.op}' needs a number`, e);
        return t;
      }
      case 'binary': {
        const a = expr(e.left);
        const b = expr(e.right);
        e.y = e.left.y || e.right.y;
        const op = e.op;
        if (isArray(a) || isArray(b)) error(`Operator '${op}' cannot be used on an array`, e);
        if (op === '+' && (a.kind === 'string' || b.kind === 'string')) return T.string();
        if ((op === '==' || op === '!=' || op === '<' || op === '>' || op === '<=' || op === '>=') &&
            a.kind === 'string' && b.kind === 'string') return T.bool();
        requireNumeric(e.left, `The left side of '${op}'`);
        requireNumeric(e.right, `The right side of '${op}'`);
        switch (op) {
          case '&&': case '||': case '==': case '!=': case '<': case '>': case '<=': case '>=':
            return T.bool();
          case '%': case '&': case '|': case '^': case '<<': case '>>':
            if (a.kind === 'float' || b.kind === 'float') error(`'${op}' needs integers, not float`, e);
            return T.int();
          default:
            return numericKind(a, b);
        }
      }
      case 'assign': {
        const t = checkLvalue(e.target, 'assign to');
        const v = expr(e.value);
        e.y = e.target.y || e.value.y;
        if (e.value.type === 'init') error('A {...} list can only initialize an array declaration', e.value);
        if (e.op === '=') {
          if (!convertible(t, v)) error(`Cannot assign ${typeName(v)} to ${typeName(t)}`, e);
        } else if (e.op === '+=' && t.kind === 'string') {
          if (isArray(v) || v.kind === 'void') error(`Cannot append ${typeName(v)} to a string`, e);
        } else {
          if (!isNumeric(t) || !isNumeric(v)) error(`'${e.op}' needs numbers`, e);
          if ((e.op === '%=' || e.op === '&=' || e.op === '|=' || e.op === '^=' || e.op === '<<=' || e.op === '>>=') &&
              (t.kind === 'float' || v.kind === 'float')) error(`'${e.op}' needs integers`, e);
        }
        return t;
      }
      case 'cond': {
        expr(e.test);
        requireNumeric(e.test, 'The condition');
        const a = expr(e.then);
        const b = expr(e.else);
        e.y = e.test.y || e.then.y || e.else.y;
        if (a.kind === 'string' && b.kind === 'string') return T.string();
        if (!isNumeric(a) || !isNumeric(b)) error("Both sides of '? :' must be numbers or both strings", e);
        return numericKind(a, b);
      }
      case 'cast': {
        expr(e.arg);
        e.y = e.arg.y;
        requireNumeric(e.arg, 'A cast operand');
        if (e.to.kind === 'string' || e.to.kind === 'void') error(`Cannot cast to ${e.to.name}`, e);
        return e.to;
      }
      case 'index': {
        const ot = e.obj.type === 'ident' ? (() => {
          const r = resolve(e.obj);
          e.obj.bind = r.bind;
          e.obj.ty = r.type;
          return r.type;
        })() : expr(e.obj);
        const it = expr(e.index);
        e.y = e.obj.y || e.index.y;
        if (!isNumeric(it) || it.kind === 'float') error('An array index must be an integer', e.index);
        if (e.obj.type === 'ident' && e.obj.bind?.kind === 'sysarray') {
          const sa = SYS_ARRAYS[e.obj.name];
          return { ...T.int(), kind: sa.kind };
        }
        if (!isArray(ot)) error(`'${exprName(e.obj)}' is not an array`, e);
        return elementType(ot);
      }
      case 'init':
        return error('A {...} list can only initialize an array declaration', e);
      case 'call':
        return call(e);
    }
  };

  const call = (e: Extract<Expr, { type: 'call' }>): Type => {
    const user = functions.get(e.callee);
    if (user) {
      if (user.isTask) error(`'${e.callee}' is a task; use startTask(${e.callee})`, e);
      e.target = { kind: 'user', fn: user };
      e.y = true;
      if (e.args.length !== user.params.length) {
        error(`'${e.callee}' expects ${user.params.length} argument(s) but got ${e.args.length}`, e);
      }
      e.args.forEach((a, k) => {
        const p = user.params[k];
        if (p.byRef || isArray(p.ptype)) {
          if (!isLvalue(a)) error(`Argument ${k + 1} of '${e.callee}' must be a variable`, a);
          const at = a.type === 'ident' ? (() => {
            const r = resolve(a);
            a.bind = r.bind;
            a.ty = r.type;
            if (r.bind.kind === 'const' || r.bind.kind === 'task') error(`Argument ${k + 1} of '${e.callee}' must be a variable`, a);
            return r.type;
          })() : expr(a);
          if (isArray(p.ptype) !== isArray(at) || p.ptype.dims.length !== at.dims.length) {
            error(`Argument ${k + 1} of '${e.callee}' must be ${typeName(p.ptype)}, not ${typeName(at)}`, a);
          }
          if ((p.ptype.kind === 'string') !== (at.kind === 'string')) {
            error(`Argument ${k + 1} of '${e.callee}' must be ${typeName(p.ptype)}, not ${typeName(at)}`, a);
          }
        } else {
          const at = expr(a);
          if (!convertible(p.ptype, at)) error(`Argument ${k + 1} of '${e.callee}' must be ${typeName(p.ptype)}, not ${typeName(at)}`, a);
        }
      });
      return user.ret;
    }
    const spec = BUILTINS[e.callee];
    if (!spec) return error(`'${e.callee}' is not a known function`, e);
    e.target = { kind: 'builtin', name: e.callee };
    e.y = !!spec.yields;
    const hasFmt = spec.params.includes('fmt');
    const min = spec.params.length - (spec.optional ?? 0);
    if (e.args.length < min || (!hasFmt && e.args.length > spec.params.length)) {
      error(`'${e.callee}' expects ${spec.params.length} argument(s) but got ${e.args.length}`, e);
    }
    e.args.forEach((a, k) => {
      const kind = k < spec.params.length ? spec.params[k] : 'any';
      if (kind === 'task') {
        if (a.type !== 'ident' || !functions.get(a.name)?.isTask) error(`'${e.callee}' needs the name of a task`, a);
        (a as Ident).bind = { kind: 'task', name: (a as Ident).name };
        a.ty = T.void();
        return;
      }
      if (kind === 'ref' || kind === 'sref') {
        const t = checkLvalue(a, 'pass');
        e.y ||= a.y;
        if (kind === 'ref' && !isNumeric(t)) error(`Argument ${k + 1} of '${e.callee}' must be a number variable`, a);
        if (kind === 'sref' && t.kind !== 'string') error(`Argument ${k + 1} of '${e.callee}' must be a string variable`, a);
        return;
      }
      const t = expr(a);
      e.y ||= a.y;
      if (kind === 'n') requireNumeric(a, `Argument ${k + 1} of '${e.callee}'`);
      if ((kind === 's' || kind === 'fmt') && t.kind !== 'string') {
        error(`Argument ${k + 1} of '${e.callee}' must be a string`, a);
      }
      if (kind === 'any' && (t.kind === 'void' || (isArray(t) && !(t.dims.length === 1 && t.isChar)))) {
        error(`Argument ${k + 1} of '${e.callee}' cannot be ${typeName(t)}`, a);
      }
    });
    if (RETURNS_ARG_KIND.has(e.callee)) {
      return e.args.some((a) => a.ty?.kind === 'float') ? T.float() : T.int();
    }
    return { ...T.int(), kind: spec.ret, name: spec.ret };
  };

  /** Checks an array initializer against the declared dimensions; fills in a `[]` size. */
  const checkInit = (item: VarDeclItem) => {
    const init = item.init!;
    const t = item.vtype;
    if (!isArray(t)) {
      const v = expr(init);
      if (!convertible(t, v)) error(`Cannot initialize ${typeName(t)} with ${typeName(v)}`, init);
      return;
    }
    if (init.type === 'str' && t.dims.length === 1 && t.isChar) {
      init.ty = T.string();
      if (t.dims[0] < 0) t.dims[0] = init.value.length + 1;
      else if (init.value.length + 1 > t.dims[0]) error(`The string is longer than ${item.name}[${t.dims[0]}]`, init);
      return;
    }
    if (init.type !== 'init') error(`An array must be initialized with {...}`, init);
    const walk = (e: Expr, dims: number[], depth: number) => {
      if (dims.length === 0) {
        const v = expr(e);
        if (!convertible({ ...t, dims: [] }, v)) error(`Cannot put ${typeName(v)} in ${typeName({ ...t, dims: [] })} array`, e);
        return;
      }
      if (e.type !== 'init') return error('Expected a nested {...} list', e);
      if (dims[0] < 0) {
        if (depth > 0) error('Only the first array size can be left empty', e);
        dims[0] = e.items.length;
      }
      if (e.items.length > dims[0]) error(`Too many values: the array holds ${dims[0]}`, e);
      for (const it of e.items) walk(it, dims.slice(1), depth + 1);
      e.ty = t;
    };
    const dims = [...t.dims];
    walk(init, dims, 0);
    t.dims[0] = dims[0];
  };

  const checkDeclItem = (item: VarDeclItem, isConst: boolean) => {
    if (item.vtype.kind === 'void') error(`'${item.name}' cannot be void`, item);
    if (item.init) checkInit(item);
    if (item.vtype.dims.some((d) => d < 0)) error(`The size of array '${item.name}' is missing`, item);
    declare(item, isConst);
  };

  const stmt = (s: Stmt) => {
    switch (s.type) {
      case 'var':
        for (const it of s.items) checkDeclItem(it, false);
        return;
      case 'expr':
        expr(s.expr);
        return;
      case 'if':
        expr(s.test);
        requireNumeric(s.test, 'The if condition');
        stmtScoped(s.then);
        if (s.else) stmtScoped(s.else);
        return;
      case 'while':
      case 'do':
        expr(s.test);
        requireNumeric(s.test, 'The loop condition');
        loopDepth++;
        stmtScoped(s.body);
        loopDepth--;
        return;
      case 'for':
        scopes.push({ vars: new Map() });
        if (s.init) stmt(s.init);
        if (s.test) {
          expr(s.test);
          requireNumeric(s.test, 'The loop condition');
        }
        if (s.update) expr(s.update);
        loopDepth++;
        stmtScoped(s.body);
        loopDepth--;
        scopes.pop();
        return;
      case 'switch': {
        const dt = expr(s.disc);
        if (!isNumeric(dt) || dt.kind === 'float') error('switch needs an integer value', s.disc);
        const seen = new Set<number>();
        let sawDefault = false;
        switchDepth++;
        scopes.push({ vars: new Map() });
        for (const c of s.cases) {
          if (c.test) {
            expr(c.test);
            const v = constValue(c.test);
            if (v === undefined) error('A case label must be a constant', c.test);
            if (seen.has(v!)) error(`Duplicate case ${v}`, c);
            seen.add(v!);
            c.value = v;
          } else {
            if (sawDefault) error('Duplicate default', c);
            sawDefault = true;
          }
          for (const b of c.body) guarded(b);
        }
        scopes.pop();
        switchDepth--;
        return;
      }
      case 'break':
        if (!loopDepth && !switchDepth) error("'break' outside a loop or switch", s);
        return;
      case 'continue':
        if (!loopDepth) error("'continue' outside a loop", s);
        return;
      case 'return': {
        const ret = current!.ret;
        if (s.value) {
          const v = expr(s.value);
          if (ret.kind === 'void') error(`'${current!.name}' is void and cannot return a value`, s);
          if (!convertible(ret, v)) error(`Cannot return ${typeName(v)} from a function returning ${typeName(ret)}`, s);
        } else if (ret.kind !== 'void') error(`'${current!.name}' must return a ${typeName(ret)} value`, s);
        return;
      }
      case 'block':
        scopes.push({ vars: new Map() });
        for (const b of s.body) guarded(b);
        scopes.pop();
        return;
      case 'empty':
        return;
    }
  };

  const stmtScoped = (s: Stmt) => {
    scopes.push({ vars: new Map() });
    guarded(s);
    scopes.pop();
  };

  const guarded = (s: Stmt) => {
    try {
      stmt(s);
    } catch (e) {
      report(e);
    }
  };

  const constValue = (e: Expr): number | undefined => {
    if (e.type === 'num') return e.value;
    if (e.type === 'ident' && e.bind?.kind === 'const' && typeof e.bind.value === 'number') return e.bind.value;
    if (e.type === 'unary' && e.op === '-') {
      const v = constValue(e.arg);
      return v === undefined ? undefined : -v;
    }
    return undefined;
  };

  // ---------- walk the program in source order ----------
  for (const entry of program.order) {
    if (entry.kind === 'var') {
      for (const it of entry.decl.items) {
        try {
          checkDeclItem(it, false);
          if (it.init && containsYield(it.init)) error('A global variable cannot be initialized with a function call', it.init);
        } catch (e) {
          report(e);
        }
      }
      continue;
    }
    const f = entry.decl;
    if (!f.body || functions.get(f.name) !== f) continue;
    current = f;
    scopes = [{ vars: new Map() }];
    slotCount = 0;
    loopDepth = 0;
    switchDepth = 0;
    for (const p of f.params) {
      if (scopes[0].vars.has(p.name)) report(new CompileError(`Duplicate parameter '${p.name}'`, p.line, p.col));
      scopes[0].vars.set(p.name, { slot: slotCount++, type: p.ptype, byRef: p.byRef, isConst: false });
    }
    scopes.push({ vars: new Map() });
    for (const s of f.body.body) guarded(s);
    f.frameSize = slotCount;
    current = undefined;
  }

  for (const f of functions.values()) {
    if (!f.body) report(new CompileError(`'${f.name}' is declared but never defined`, f.line, f.col));
  }
  const main = functions.get('main');
  if (!main) diagnostics.push({ line: 1, col: 1, severity: 'error', message: "The program needs a 'task main()'" });
  else if (!main.isTask) report(new CompileError("'main' must be declared as 'task main()'", main.line, main.col));

  return { diagnostics, globalCount };
}

const containsYield = (e: Expr): boolean => !!e.y;

const exprName = (e: Expr) => (e.type === 'ident' ? e.name : 'expression');
