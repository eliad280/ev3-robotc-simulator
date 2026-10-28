import { Type } from './ast';

export interface FormatArg {
  value: unknown;
  ty: Type;
}

/** Converts a char array (codes, 0-terminated) to a JS string. */
export function charArrayToString(a: number[]): string {
  let s = '';
  for (const c of a) {
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** How ROBOTC prints a float without an explicit format: up to 4 decimals. */
export function floatToString(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  return String(Number(v.toFixed(4)));
}

export function valueToString(value: unknown, ty: Type): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return charArrayToString(value as number[]);
  if (ty.kind === 'float') return floatToString(value as number);
  if (ty.kind === 'bool') return value ? '1' : '0';
  return String(value);
}

/** printf-style formatting: %d %i %u %f %e %g %s %c %x %X %o %%, with flags, width and precision. */
export function format(fmt: string, args: FormatArg[]): string {
  let k = 0;
  return fmt.replace(/%([-+ 0#]*)(\d+|\*)?(?:\.(\d+|\*))?(hh|h|ll|l|L)?([diufFeEgGsScxXo%])/g, (_m, flags: string, w, prec, _len, conv: string) => {
    if (conv === '%') return '%';
    const width = w === '*' ? Number(args[k++]?.value ?? 0) : w ? Number(w) : 0;
    const precision = prec === '*' ? Number(args[k++]?.value ?? 0) : prec !== undefined ? Number(prec) : undefined;
    const arg = args[k++];
    if (!arg) return '';
    const num = typeof arg.value === 'number' ? arg.value : Number(arg.value);
    let s: string;
    switch (conv) {
      case 'd':
      case 'i':
        s = String(Math.trunc(num));
        break;
      case 'u':
        s = String(Math.trunc(num) >>> 0);
        break;
      case 'f':
      case 'F':
        s = num.toFixed(precision ?? 6);
        break;
      case 'e':
      case 'E':
        s = num.toExponential(precision ?? 6);
        if (conv === 'E') s = s.toUpperCase();
        break;
      case 'g':
      case 'G':
        s = String(Number(num.toPrecision(precision || 6)));
        break;
      case 'c':
        s = String.fromCharCode(num);
        break;
      case 'x':
        s = (Math.trunc(num) >>> 0).toString(16);
        break;
      case 'X':
        s = (Math.trunc(num) >>> 0).toString(16).toUpperCase();
        break;
      case 'o':
        s = (Math.trunc(num) >>> 0).toString(8);
        break;
      default: // s, S
        s = valueToString(arg.value, arg.ty);
        if (precision !== undefined) s = s.slice(0, precision);
    }
    if (flags.includes('+') && /[dif]/i.test(conv) && num >= 0) s = '+' + s;
    else if (flags.includes(' ') && /[dif]/i.test(conv) && num >= 0) s = ' ' + s;
    if (s.length < width) {
      if (flags.includes('-')) s = s.padEnd(width);
      else if (flags.includes('0') && /[diufFeEgGxXo]/.test(conv)) {
        const sign = /^[+\- ]/.test(s) ? s[0] : '';
        s = sign + s.slice(sign.length).padStart(width - sign.length, '0');
      } else s = s.padStart(width);
    }
    return s;
  });
}
