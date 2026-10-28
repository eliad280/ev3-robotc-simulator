export interface Diagnostic {
  line: number;
  col: number;
  message: string;
  severity: 'error' | 'warning';
}

/** Thrown by the lexer, parser and checker for a problem in the user's code. */
export class CompileError extends Error {
  constructor(
    message: string,
    public line: number,
    public col: number,
  ) {
    super(message);
  }
}

/** Thrown while the program runs (division by zero, bad array index...). */
export class RuntimeError extends Error {
  constructor(
    message: string,
    public line: number,
  ) {
    super(message);
  }
}
