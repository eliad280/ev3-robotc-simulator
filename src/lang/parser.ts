import {
  Block, Expr, FuncDecl, Param, Program, Stmt, SwitchCase, T, Type, VarDecl, VarDeclItem,
} from './ast';
import { CompileError } from './errors';
import { Token } from './lexer';

/** Integer-valued type names besides the C ones: ROBOTC's enum types. */
export const ROBOTC_INT_TYPES = new Set([
  'tMotor', 'tSensors', 'TLegoColors', 'TEV3Buttons', 'TEV3LEDPatterns', 'TTimers',
  'tMotorBrakeModes', 'TSounds', 'TSensorTypes', 'TSensorModes',
]);

const PRIMITIVE_TYPES: Record<string, () => Type> = {
  int: () => ({ kind: 'int', bits: 32, name: 'int', dims: [] }),
  long: () => ({ kind: 'int', bits: 32, name: 'long', dims: [] }),
  short: () => ({ kind: 'int', bits: 16, name: 'short', dims: [] }),
  word: () => ({ kind: 'int', bits: 16, name: 'word', dims: [] }),
  char: () => T.char(),
  byte: () => ({ kind: 'int', bits: 8, name: 'byte', dims: [] }),
  sbyte: () => ({ kind: 'int', bits: 8, name: 'sbyte', dims: [] }),
  ubyte: () => ({ kind: 'int', bits: 8, unsigned: true, name: 'ubyte', dims: [] }),
  float: () => T.float(),
  double: () => ({ kind: 'float', name: 'double', dims: [] }),
  bool: () => T.bool(),
  string: () => T.string(),
  void: () => T.void(),
};

const TYPE_MODIFIERS = new Set(['const', 'static', 'unsigned', 'signed', 'volatile']);

const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6,
  '<': 7, '>': 7, '<=': 7, '>=': 7,
  '<<': 8, '>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
};

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

export interface ParseResult {
  program: Program;
  /** Values of user enum constants (`enum { A, B = 5 }`). */
  enumConsts: Map<string, number>;
}

export function parse(input: Token[], defines: Map<string, Token[]>, extraConsts: Map<string, number>): ParseResult {
  const toks = expandDefines(input, defines);
  let p = 0;
  const enumConsts = new Map<string, number>();
  const userTypes = new Map<string, Type>();

  const peek = (o = 0) => toks[Math.min(p + o, toks.length - 1)];
  const next = () => toks[p++];
  const fail = (msg: string, t: Token = peek()): never => {
    throw new CompileError(msg, t.line, t.col);
  };
  const is = (v: string, o = 0) => {
    const t = peek(o);
    return (t.kind === 'op' || t.kind === 'ident') && t.value === v;
  };
  const accept = (v: string) => (is(v) ? (p++, true) : false);
  const expect = (v: string, what?: string) => {
    if (!is(v)) {
      const msg = `Expected '${v}'${what ? ` ${what}` : ''} but found '${peek().value}'`;
      // A missing ';' or ')' belongs to the end of the previous token's line, like C compilers report it.
      const prev = toks[p - 1];
      if ((v === ';' || v === ')') && prev && prev.line < peek().line) {
        throw new CompileError(msg, prev.line, prev.col + prev.value.length);
      }
      fail(msg);
    }
    return next();
  };
  const ident = (what = 'a name') => {
    const t = peek();
    if (t.kind !== 'ident') fail(`Expected ${what} but found '${t.value}'`);
    return next();
  };

  const isTypeName = (o = 0): boolean => {
    let k = o;
    while (peek(k).kind === 'ident' && TYPE_MODIFIERS.has(peek(k).value)) k++;
    const t = peek(k);
    if (t.kind !== 'ident') return k > o; // e.g. `unsigned x`
    return t.value in PRIMITIVE_TYPES || ROBOTC_INT_TYPES.has(t.value) || userTypes.has(t.value) || t.value === 'enum';
  };

  const parseBaseType = (): Type => {
    let unsigned = false;
    let sawModifier = false;
    while (peek().kind === 'ident' && TYPE_MODIFIERS.has(peek().value)) {
      if (next().value === 'unsigned') unsigned = true;
      sawModifier = true;
    }
    const t = peek();
    if (t.kind === 'ident' && t.value === 'enum') return parseEnum();
    if (t.kind === 'ident' && t.value in PRIMITIVE_TYPES) {
      next();
      // `long int`, `short int`, `unsigned long`
      if ((t.value === 'long' || t.value === 'short') && is('int')) next();
      const ty = PRIMITIVE_TYPES[t.value]();
      if (unsigned && ty.kind === 'int') ty.unsigned = true;
      return ty;
    }
    if (t.kind === 'ident' && ROBOTC_INT_TYPES.has(t.value)) {
      next();
      return { kind: 'int', bits: 32, name: t.value, dims: [] };
    }
    if (t.kind === 'ident' && userTypes.has(t.value)) {
      next();
      return { ...userTypes.get(t.value)!, dims: [] };
    }
    if (sawModifier) return { kind: 'int', bits: 32, unsigned, name: unsigned ? 'unsigned int' : 'int', dims: [] };
    if (t.kind === 'ident' && t.value === 'struct') fail('struct is not supported yet');
    return fail(`Expected a type but found '${t.value}'`);
  };

  const parseEnum = (): Type => {
    const kw = expect('enum');
    let name = 'enum';
    if (peek().kind === 'ident' && !is('{')) name = next().value;
    if (accept('{')) {
      let value = 0;
      while (!is('}')) {
        const id = ident('an enum value');
        if (accept('=')) value = constInt(parseAssign(), 'an enum value');
        enumConsts.set(id.value, value++);
        if (!accept(',')) break;
      }
      expect('}');
    } else if (!userTypes.has(name)) {
      fail(`Unknown enum '${name}'`, kw);
    }
    const ty: Type = { kind: 'int', bits: 32, name, dims: [] };
    if (name !== 'enum') userTypes.set(name, ty);
    return ty;
  };

  /** Evaluates a constant integer expression (array sizes, case labels, enum values). */
  const constInt = (e: Expr, what: string): number => {
    const v = constEval(e);
    if (v === undefined || !Number.isFinite(v)) throw new CompileError(`${what} must be a constant number`, e.line, e.col);
    return Math.trunc(v);
  };
  const constEval = (e: Expr): number | undefined => {
    switch (e.type) {
      case 'num':
        return e.value;
      case 'ident':
        return enumConsts.get(e.name) ?? extraConsts.get(e.name);
      case 'unary': {
        const a = constEval(e.arg);
        if (a === undefined) return undefined;
        return e.op === '-' ? -a : e.op === '+' ? a : e.op === '!' ? (a ? 0 : 1) : ~a;
      }
      case 'binary': {
        const a = constEval(e.left);
        const b = constEval(e.right);
        if (a === undefined || b === undefined) return undefined;
        switch (e.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return b === 0 ? undefined : Math.trunc(a / b);
          case '%': return b === 0 ? undefined : a % b;
          case '<<': return a << b;
          case '>>': return a >> b;
          case '|': return a | b;
          case '&': return a & b;
          case '^': return a ^ b;
        }
        return undefined;
      }
      case 'cast':
        return constEval(e.arg);
    }
    return undefined;
  };

  /** Parses `[3][4]` after a declarator name. `[]` gives -1 (size from initializer or unsized param). */
  const parseDims = (): number[] => {
    const dims: number[] = [];
    while (is('[')) {
      next();
      if (accept(']')) {
        dims.push(-1);
        continue;
      }
      const e = parseExpr();
      const n = constInt(e, 'An array size');
      if (n <= 0) throw new CompileError('An array size must be positive', e.line, e.col);
      dims.push(n);
      expect(']');
    }
    return dims;
  };

  // ---------- expressions ----------

  const parseExpr = (): Expr => parseAssign();

  const parseAssign = (): Expr => {
    const left = parseCond();
    const t = peek();
    if (t.kind === 'op' && ASSIGN_OPS.has(t.value)) {
      next();
      const value = parseAssign();
      return { type: 'assign', op: t.value, target: left, value, line: t.line, col: t.col };
    }
    return left;
  };

  const parseCond = (): Expr => {
    const test = parseBinary(1);
    if (is('?')) {
      const q = next();
      const then = parseAssign();
      expect(':', "in '? :' expression");
      const els = parseCond();
      return { type: 'cond', test, then, else: els, line: q.line, col: q.col };
    }
    return test;
  };

  const parseBinary = (minPrec: number): Expr => {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      const prec = t.kind === 'op' ? BINARY_PRECEDENCE[t.value] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      next();
      const right = parseBinary(prec + 1);
      left = { type: 'binary', op: t.value, left, right, line: t.line, col: t.col };
    }
  };

  const parseUnary = (): Expr => {
    const t = peek();
    if (t.kind === 'op') {
      if (t.value === '-' || t.value === '+' || t.value === '!' || t.value === '~') {
        next();
        return { type: 'unary', op: t.value, arg: parseUnary(), line: t.line, col: t.col };
      }
      if (t.value === '++' || t.value === '--') {
        next();
        return { type: 'update', op: t.value, prefix: true, arg: parseUnary(), line: t.line, col: t.col };
      }
      if (t.value === '(' && isTypeName(1)) {
        next();
        const to = parseBaseType();
        expect(')');
        return { type: 'cast', to, arg: parseUnary(), line: t.line, col: t.col };
      }
      if (t.value === '&' || t.value === '*') fail('Pointers are not supported');
    }
    if (t.kind === 'ident' && t.value === 'sizeof') fail('sizeof is not supported yet');
    return parsePostfix(parsePrimary());
  };

  const parsePostfix = (e: Expr): Expr => {
    for (;;) {
      const t = peek();
      if (is('[')) {
        next();
        const index = parseExpr();
        expect(']');
        e = { type: 'index', obj: e, index, line: t.line, col: t.col };
      } else if (is('(')) {
        if (e.type !== 'ident') fail('Only named functions can be called');
        next();
        const args: Expr[] = [];
        if (!is(')')) {
          do args.push(parseAssign());
          while (accept(','));
        }
        expect(')', 'after function arguments');
        e = { type: 'call', callee: (e as { name: string }).name, args, line: e.line, col: e.col };
      } else if (is('++') || is('--')) {
        next();
        e = { type: 'update', op: t.value as '++' | '--', prefix: false, arg: e, line: t.line, col: t.col };
      } else if (is('.') || is('->')) {
        fail('struct members are not supported yet');
      } else return e;
    }
  };

  const parsePrimary = (): Expr => {
    const t = next();
    switch (t.kind) {
      case 'int':
        return { type: 'num', value: t.num!, isFloat: false, line: t.line, col: t.col };
      case 'float':
        return { type: 'num', value: t.num!, isFloat: true, line: t.line, col: t.col };
      case 'char':
        return { type: 'num', value: t.num!, isFloat: false, isChar: true, line: t.line, col: t.col };
      case 'string': {
        // Adjacent string literals are joined: "a" "b" == "ab"
        let value = t.value;
        while (peek().kind === 'string') value += next().value;
        return { type: 'str', value, line: t.line, col: t.col };
      }
      case 'ident':
        if (t.value === 'true' || t.value === 'false') {
          return { type: 'num', value: t.value === 'true' ? 1 : 0, isFloat: false, line: t.line, col: t.col, ty: T.bool() };
        }
        return { type: 'ident', name: t.value, line: t.line, col: t.col };
      case 'op':
        if (t.value === '(') {
          const e = parseExpr();
          expect(')');
          return e;
        }
        if (t.value === '{') {
          const items: Expr[] = [];
          if (!is('}')) {
            do {
              if (is('}')) break; // trailing comma
              items.push(is('{') ? parsePrimary() : parseAssign());
            } while (accept(','));
          }
          expect('}');
          return { type: 'init', items, line: t.line, col: t.col };
        }
    }
    return fail(`Unexpected '${t.value}'`, t);
  };

  // ---------- statements ----------

  const parseDeclarators = (base: Type, first: Token): VarDeclItem[] => {
    const items: VarDeclItem[] = [];
    let nameTok = first;
    for (;;) {
      if (is('&') || is('*')) fail('Pointers and references are only allowed in function parameters');
      const dims = parseDims();
      const item: VarDeclItem = { name: nameTok.value, vtype: { ...base, dims }, line: nameTok.line, col: nameTok.col };
      if (accept('=')) item.init = parseAssign();
      items.push(item);
      if (!accept(',')) break;
      nameTok = ident('a variable name');
    }
    return items;
  };

  const parseVarDecl = (): VarDecl => {
    const start = peek();
    const base = parseBaseType();
    if (is(';')) {
      // `enum Color { ... };` declares only the enum
      next();
      return { type: 'var', items: [], line: start.line, col: start.col };
    }
    const items = parseDeclarators(base, ident('a variable name'));
    expect(';', 'after variable declaration');
    return { type: 'var', items, line: start.line, col: start.col };
  };

  const parseBlock = (): Block => {
    const t = expect('{');
    const body: Stmt[] = [];
    while (!is('}')) {
      if (peek().kind === 'eof') fail("Missing '}'", t);
      body.push(parseStmt());
    }
    next();
    return { type: 'block', body, line: t.line, col: t.col };
  };

  const parseStmt = (): Stmt => {
    const t = peek();
    if (is('{')) return parseBlock();
    if (is(';')) {
      next();
      return { type: 'empty', line: t.line, col: t.col };
    }
    if (t.kind === 'ident') {
      switch (t.value) {
        case 'if': {
          next();
          expect('(');
          const test = parseExpr();
          expect(')');
          const then = parseStmt();
          const els = accept('else') ? parseStmt() : undefined;
          return { type: 'if', test, then, else: els, line: t.line, col: t.col };
        }
        case 'while': {
          next();
          expect('(');
          const test = parseExpr();
          expect(')');
          return { type: 'while', test, body: parseStmt(), line: t.line, col: t.col };
        }
        case 'do': {
          next();
          const body = parseStmt();
          expect('while');
          expect('(');
          const test = parseExpr();
          expect(')');
          expect(';');
          return { type: 'do', test, body, line: t.line, col: t.col };
        }
        case 'for': {
          next();
          expect('(');
          let init: Stmt | undefined;
          if (isTypeName()) init = parseVarDecl();
          else if (!accept(';')) {
            const e = parseExpr();
            expect(';');
            init = { type: 'expr', expr: e, line: e.line, col: e.col };
          }
          const test = is(';') ? undefined : parseExpr();
          expect(';');
          const update = is(')') ? undefined : parseExpr();
          expect(')');
          return { type: 'for', init, test, update, body: parseStmt(), line: t.line, col: t.col };
        }
        case 'switch': {
          next();
          expect('(');
          const disc = parseExpr();
          expect(')');
          expect('{');
          const cases: SwitchCase[] = [];
          while (!is('}')) {
            const ct = peek();
            let test: Expr | undefined;
            if (accept('case')) test = parseCond();
            else if (!accept('default')) fail("Expected 'case' or 'default'");
            expect(':');
            const body: Stmt[] = [];
            while (!is('case') && !is('default') && !is('}')) body.push(parseStmt());
            cases.push({ test, body, line: ct.line, col: ct.col });
          }
          next();
          return { type: 'switch', disc, cases, line: t.line, col: t.col };
        }
        case 'break':
        case 'continue':
          next();
          expect(';');
          return { type: t.value, line: t.line, col: t.col };
        case 'return': {
          next();
          const value = is(';') ? undefined : parseExpr();
          expect(';', 'after return');
          return { type: 'return', value, line: t.line, col: t.col };
        }
        case 'goto':
          fail('goto is not supported');
      }
      if (isTypeName()) return parseVarDecl();
    }
    const expr = parseExpr();
    expect(';', 'at end of statement');
    return { type: 'expr', expr, line: expr.line, col: expr.col };
  };

  // ---------- top level ----------

  const parseParams = (): Param[] => {
    const params: Param[] = [];
    expect('(');
    if (is('void') && is(')', 1)) next();
    if (!is(')')) {
      do {
        const base = parseBaseType();
        let byRef = false;
        if (accept('&')) byRef = true;
        if (is('*')) fail('Pointers are not supported; use a reference (int &x) instead');
        const nameTok = ident('a parameter name');
        const dims = parseDims();
        params.push({ name: nameTok.value, ptype: { ...base, dims }, byRef, line: nameTok.line, col: nameTok.col });
      } while (accept(','));
    }
    expect(')');
    return params;
  };

  const program: Program = { globals: [], functions: [], order: [] };
  while (peek().kind !== 'eof') {
    const t = peek();
    if (accept(';')) continue;
    if (t.kind === 'ident' && t.value === 'task') {
      next();
      const name = ident('a task name');
      const params = parseParams();
      if (params.length) fail('A task cannot have parameters', name);
      const fn: FuncDecl = { name: name.value, ret: T.void(), params, body: parseBlock(), isTask: true, line: name.line, col: name.col };
      program.functions.push(fn);
      program.order.push({ kind: 'func', decl: fn });
      continue;
    }
    if (t.kind === 'ident' && t.value === 'typedef') {
      next();
      const base = parseBaseType();
      const name = ident('a type name');
      expect(';');
      userTypes.set(name.value, { ...base, name: name.value });
      continue;
    }
    if (!isTypeName()) fail(`Expected a declaration but found '${t.value}'`);
    const base = parseBaseType();
    if (accept(';')) continue; // enum declaration
    const name = ident('a name');
    if (is('(')) {
      const params = parseParams();
      const fn: FuncDecl = { name: name.value, ret: base, params, isTask: false, line: name.line, col: name.col };
      if (!accept(';')) fn.body = parseBlock();
      program.functions.push(fn);
      program.order.push({ kind: 'func', decl: fn });
      continue;
    }
    const items = parseDeclarators(base, name);
    expect(';', 'after variable declaration');
    const decl: VarDecl = { type: 'var', items, line: t.line, col: t.col };
    program.globals.push(decl);
    program.order.push({ kind: 'var', decl });
  }
  return { program, enumConsts };
}

/** Replaces identifiers defined with `#define NAME value` by their tokens. */
function expandDefines(tokens: Token[], defines: Map<string, Token[]>): Token[] {
  if (defines.size === 0) return tokens;
  const out: Token[] = [];
  const expand = (t: Token, active: Set<string>) => {
    const body = t.kind === 'ident' ? defines.get(t.value) : undefined;
    if (!body || active.has(t.value)) {
      out.push(t);
      return;
    }
    active.add(t.value);
    for (const b of body) expand({ ...b, line: t.line, col: t.col }, active);
    active.delete(t.value);
  };
  for (const t of tokens) expand(t, new Set());
  return out;
}
