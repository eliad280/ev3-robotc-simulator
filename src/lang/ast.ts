/**
 * Scalar kinds the interpreter works with. All integer types of ROBOTC (int, long, short,
 * word, char, ubyte, byte and the enum types such as tMotor) share the 'int' kind and differ
 * only in `bits` / `unsigned`, which decide how values wrap on assignment.
 */
export type Kind = 'int' | 'float' | 'bool' | 'string' | 'void';

export interface Type {
  kind: Kind;
  bits?: 8 | 16 | 32;
  unsigned?: boolean;
  /** Printed name, used in error messages (e.g. "tMotor"). */
  name: string;
  /** Array dimensions, outermost first. Empty for scalars; -1 for an unsized parameter. */
  dims: number[];
  isChar?: boolean;
}

export interface Node {
  line: number;
  col: number;
}

// ---------- expressions ----------

export type Expr =
  | NumLit
  | StrLit
  | Ident
  | Unary
  | Update
  | Binary
  | Assign
  | Cond
  | Call
  | Index
  | Cast
  | InitList;

interface ExprBase extends Node {
  /** Filled in by the checker. */
  ty?: Type;
  /** True when evaluating this expression can suspend the task (calls sleep, a user function...). */
  y?: boolean;
}

export interface NumLit extends ExprBase {
  type: 'num';
  value: number;
  isFloat: boolean;
  isChar?: boolean;
}

export interface StrLit extends ExprBase {
  type: 'str';
  value: string;
}

export type Binding =
  | { kind: 'local'; slot: number; byRef: boolean }
  | { kind: 'global'; slot: number }
  | { kind: 'const'; value: number | string }
  | { kind: 'sysvar'; name: string }
  | { kind: 'sysarray'; name: string }
  | { kind: 'task'; name: string };

export interface Ident extends ExprBase {
  type: 'ident';
  name: string;
  bind?: Binding;
}

export interface Unary extends ExprBase {
  type: 'unary';
  op: '-' | '+' | '!' | '~';
  arg: Expr;
}

export interface Update extends ExprBase {
  type: 'update';
  op: '++' | '--';
  prefix: boolean;
  arg: Expr;
}

export interface Binary extends ExprBase {
  type: 'binary';
  op: string;
  left: Expr;
  right: Expr;
}

export interface Assign extends ExprBase {
  type: 'assign';
  /** '=' or a compound operator such as '+='. */
  op: string;
  target: Expr;
  value: Expr;
}

export interface Cond extends ExprBase {
  type: 'cond';
  test: Expr;
  then: Expr;
  else: Expr;
}

export interface Call extends ExprBase {
  type: 'call';
  callee: string;
  args: Expr[];
  /** Set by the checker: a user function or a builtin. */
  target?: { kind: 'user'; fn: FuncDecl } | { kind: 'builtin'; name: string };
}

export interface Index extends ExprBase {
  type: 'index';
  obj: Expr;
  index: Expr;
}

export interface Cast extends ExprBase {
  type: 'cast';
  to: Type;
  arg: Expr;
}

/** `{1, 2, 3}` — only valid as an array initializer. */
export interface InitList extends ExprBase {
  type: 'init';
  items: Expr[];
}

// ---------- statements ----------

export type Stmt =
  | VarDecl
  | ExprStmt
  | If
  | While
  | DoWhile
  | For
  | Switch
  | Jump
  | Return
  | Block
  | Empty;

export interface VarDeclItem extends Node {
  name: string;
  vtype: Type;
  init?: Expr;
  /** Set by the checker. */
  slot?: number;
  isGlobal?: boolean;
}

export interface VarDecl extends Node {
  type: 'var';
  items: VarDeclItem[];
}

export interface ExprStmt extends Node {
  type: 'expr';
  expr: Expr;
}

export interface If extends Node {
  type: 'if';
  test: Expr;
  then: Stmt;
  else?: Stmt;
}

export interface While extends Node {
  type: 'while';
  test: Expr;
  body: Stmt;
}

export interface DoWhile extends Node {
  type: 'do';
  test: Expr;
  body: Stmt;
}

export interface For extends Node {
  type: 'for';
  init?: Stmt;
  test?: Expr;
  update?: Expr;
  body: Stmt;
}

export interface SwitchCase extends Node {
  /** undefined = `default:` */
  test?: Expr;
  /** Value of `test`, computed by the checker. */
  value?: number;
  body: Stmt[];
}

export interface Switch extends Node {
  type: 'switch';
  disc: Expr;
  cases: SwitchCase[];
}

export interface Jump extends Node {
  type: 'break' | 'continue';
}

export interface Return extends Node {
  type: 'return';
  value?: Expr;
}

export interface Block extends Node {
  type: 'block';
  body: Stmt[];
}

export interface Empty extends Node {
  type: 'empty';
}

// ---------- top level ----------

export interface Param extends Node {
  name: string;
  ptype: Type;
  byRef: boolean;
}

export interface FuncDecl extends Node {
  name: string;
  ret: Type;
  params: Param[];
  body?: Block;
  isTask: boolean;
  /** Number of local slots, set by the checker. */
  frameSize?: number;
}

export interface Program {
  globals: VarDecl[];
  functions: FuncDecl[];
  /** Top-level declarations in source order, so globals initialize in order. */
  order: Array<{ kind: 'var'; decl: VarDecl } | { kind: 'func'; decl: FuncDecl }>;
}

// ---------- type helpers ----------

export const T = {
  int: (): Type => ({ kind: 'int', bits: 32, name: 'int', dims: [] }),
  float: (): Type => ({ kind: 'float', name: 'float', dims: [] }),
  bool: (): Type => ({ kind: 'bool', name: 'bool', dims: [] }),
  string: (): Type => ({ kind: 'string', name: 'string', dims: [] }),
  void: (): Type => ({ kind: 'void', name: 'void', dims: [] }),
  char: (): Type => ({ kind: 'int', bits: 8, name: 'char', dims: [], isChar: true }),
};

export const isNumeric = (t: Type) => t.dims.length === 0 && (t.kind === 'int' || t.kind === 'float' || t.kind === 'bool');
export const isArray = (t: Type) => t.dims.length > 0;
export const elementType = (t: Type): Type => ({ ...t, dims: t.dims.slice(1) });
export const typeName = (t: Type) => t.name + t.dims.map((d) => (d < 0 ? '[]' : `[${d}]`)).join('');
