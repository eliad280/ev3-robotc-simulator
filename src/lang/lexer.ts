import { CompileError, Diagnostic } from './errors';

export type TokenKind = 'int' | 'float' | 'string' | 'char' | 'ident' | 'op' | 'eof';

export interface Token {
  kind: TokenKind;
  value: string;
  /** Numeric value for int, float and char tokens. */
  num?: number;
  line: number;
  col: number;
}

/** One `#pragma config(...)` line, split into its comma-separated arguments. */
export interface PragmaConfig {
  args: string[];
  line: number;
}

export interface LexResult {
  tokens: Token[];
  pragmas: PragmaConfig[];
  defines: Map<string, Token[]>;
  warnings: Diagnostic[];
}

const OPERATORS = [
  '<<=', '>>=', '...',
  '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|', '^', '~', '?', ':', ';', ',', '.',
  '(', ')', '[', ']', '{', '}',
];

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', "'": "'", '"': '"' };

export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const pragmas: PragmaConfig[] = [];
  const defines = new Map<string, Token[]>();
  const warnings: Diagnostic[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let atLineStart = true;

  const err = (msg: string): never => {
    throw new CompileError(msg, line, i - lineStart + 1);
  };

  const readEscape = (): string => {
    const c = source[i++];
    if (c in ESCAPES) return ESCAPES[c];
    if (c === 'x') {
      const m = /^[0-9a-fA-F]{1,2}/.exec(source.slice(i));
      if (!m) err('Bad \\x escape');
      i += m![0].length;
      return String.fromCharCode(parseInt(m![0], 16));
    }
    return c;
  };

  const directive = (text: string, dirLine: number) => {
    const m = /^#\s*(\w+)\s*(.*)$/s.exec(text.trim());
    if (!m) return;
    const [, name, rest] = m;
    if (name === 'pragma') {
      const pm = /^config\s*\((.*)\)\s*$/s.exec(rest.trim());
      if (pm) {
        pragmas.push({ args: pm[1].split(',').map((s) => s.trim()), line: dirLine });
      }
      // Other pragmas (DebuggerWindows, etc.) have no effect in the simulator.
    } else if (name === 'define') {
      const dm = /^([A-Za-z_]\w*)(\()?\s*(.*)$/s.exec(rest);
      if (!dm) throw new CompileError('Bad #define', dirLine, 1);
      if (dm[2]) throw new CompileError('Macros with parameters are not supported yet', dirLine, 1);
      const body = lex(dm[3]).tokens.filter((t) => t.kind !== 'eof');
      for (const t of body) {
        t.line = dirLine;
        t.col = 1;
      }
      defines.set(dm[1], body);
    } else if (name === 'include') {
      warnings.push({
        line: dirLine,
        col: 1,
        severity: 'warning',
        message: '#include is not supported yet and was ignored',
      });
    } else if (name === 'ifdef' || name === 'ifndef' || name === 'endif' || name === 'else' || name === 'undef') {
      warnings.push({ line: dirLine, col: 1, severity: 'warning', message: `#${name} is not supported and was ignored` });
    } else {
      throw new CompileError(`Unknown directive #${name}`, dirLine, 1);
    }
  };

  while (i < source.length) {
    const c = source[i];
    if (c === '\n') {
      line++;
      i++;
      lineStart = i;
      atLineStart = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) err('Unterminated comment');
      for (let k = i; k < end; k++) {
        if (source[k] === '\n') {
          line++;
          lineStart = k + 1;
        }
      }
      i = end + 2;
      continue;
    }
    if (c === '#' && atLineStart) {
      const dirLine = line;
      let text = '';
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\' && source[i + 1] === '\n') {
          i += 2;
          line++;
          lineStart = i;
          continue;
        }
        if (source[i] === '/' && source[i + 1] === '/') {
          while (i < source.length && source[i] !== '\n') i++;
          break;
        }
        text += source[i++];
      }
      directive(text, dirLine);
      continue;
    }
    atLineStart = false;
    const col = i - lineStart + 1;
    const start = i;

    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const hex = /^0[xX][0-9a-fA-F]+/.exec(source.slice(i));
      if (hex) {
        i += hex[0].length;
        while (/[uUlL]/.test(source[i] ?? '')) i++;
        tokens.push({ kind: 'int', value: hex[0], num: parseInt(hex[0], 16), line, col });
        continue;
      }
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(source.slice(i))!;
      i += m[0].length;
      const isFloat = m[0].includes('.') || !!m[2] || /[fF]/.test(source[i] ?? '');
      while (/[uUlLfF]/.test(source[i] ?? '')) i++;
      tokens.push({ kind: isFloat ? 'float' : 'int', value: m[0], num: Number(m[0]), line, col });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      while (i < source.length && /\w/.test(source[i])) i++;
      tokens.push({ kind: 'ident', value: source.slice(start, i), line, col });
      continue;
    }
    if (c === '"') {
      i++;
      let s = '';
      while (source[i] !== '"') {
        if (i >= source.length || source[i] === '\n') err('Unterminated string');
        if (source[i] === '\\') {
          i++;
          s += readEscape();
        } else s += source[i++];
      }
      i++;
      tokens.push({ kind: 'string', value: s, line, col });
      continue;
    }
    if (c === "'") {
      i++;
      let ch = source[i] === '\\' ? (i++, readEscape()) : source[i++];
      if (source[i] !== "'") err('Bad character literal');
      i++;
      tokens.push({ kind: 'char', value: ch, num: ch.charCodeAt(0), line, col });
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (!op) err(`Unexpected character '${c}'`);
    i += op!.length;
    tokens.push({ kind: 'op', value: op!, line, col });
  }
  tokens.push({ kind: 'eof', value: '<end of file>', line, col: i - lineStart + 1 });
  return { tokens, pragmas, defines, warnings };
}
