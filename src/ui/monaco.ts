import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { loader } from '@monaco-editor/react';
import { BUILTINS, CONSTANTS, SYS_ARRAYS, SYS_VARS } from '../lang/robotc-api';
import { ROBOTC_INT_TYPES } from '../lang/parser';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

// Use the bundled Monaco instead of loading it from a CDN, so the app works offline.
loader.config({ monaco });

const KEYWORDS = [
  'if', 'else', 'while', 'do', 'for', 'switch', 'case', 'default', 'break', 'continue', 'return',
  'task', 'const', 'static', 'unsigned', 'signed', 'enum', 'typedef', 'struct', 'true', 'false',
];
const TYPES = ['int', 'long', 'short', 'word', 'char', 'byte', 'sbyte', 'ubyte', 'float', 'double', 'bool', 'string', 'void', ...ROBOTC_INT_TYPES];

monaco.languages.register({ id: 'robotc' });

monaco.languages.setLanguageConfiguration('robotc', {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
  ],
  indentationRules: {
    increaseIndentPattern: /^.*\{[^}"']*$/,
    decreaseIndentPattern: /^\s*\}/,
  },
});

monaco.languages.setMonarchTokensProvider('robotc', {
  keywords: KEYWORDS,
  types: TYPES,
  builtins: [...Object.keys(BUILTINS), ...Object.keys(SYS_VARS), ...Object.keys(SYS_ARRAYS)],
  constants: Object.keys(CONSTANTS),
  tokenizer: {
    root: [
      [/^\s*#\s*\w+/, 'keyword.directive'],
      [/[A-Za-z_]\w*/, {
        cases: {
          '@keywords': 'keyword',
          '@types': 'type',
          '@builtins': 'predefined',
          '@constants': 'constant',
          '@default': 'identifier',
        },
      }],
      { include: '@whitespace' },
      [/[{}()[\]]/, '@brackets'],
      [/\d*\.\d+([eE][-+]?\d+)?[fF]?/, 'number.float'],
      [/0[xX][0-9a-fA-F]+/, 'number.hex'],
      [/\d+/, 'number'],
      [/"([^"\\]|\\.)*$/, 'string.invalid'],
      [/"/, 'string', '@string'],
      [/'[^\\']'/, 'string'],
      [/'\\.'/, 'string'],
      [/[;,.]/, 'delimiter'],
      [/[=><!~?:&|+\-*/^%]+/, 'operator'],
    ],
    whitespace: [
      [/[ \t\r\n]+/, ''],
      [/\/\*/, 'comment', '@comment'],
      [/\/\/.*$/, 'comment'],
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
    string: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
    ],
  },
} as monaco.languages.IMonarchLanguage);

monaco.languages.registerCompletionItemProvider('robotc', {
  provideCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    const K = monaco.languages.CompletionItemKind;
    const items: monaco.languages.CompletionItem[] = [];
    for (const [name, spec] of Object.entries(BUILTINS)) {
      const params = spec.doc.match(/\(([^)]*)\)/)?.[1] ?? '';
      const parts = params ? params.split(',').map((p) => p.trim()) : [];
      const snippet = parts.length
        ? `${name}(${parts.map((p, k) => `\${${k + 1}:${p.replace(/[$}\\]/g, '')}}`).join(', ')})`
        : `${name}()`;
      items.push({
        label: name,
        kind: K.Function,
        detail: spec.doc,
        insertText: snippet,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range,
      });
    }
    for (const name of Object.keys(CONSTANTS)) items.push({ label: name, kind: K.Constant, insertText: name, range });
    for (const [name, v] of Object.entries(SYS_VARS)) items.push({ label: name, kind: K.Variable, detail: v.doc, insertText: name, range });
    for (const [name, v] of Object.entries(SYS_ARRAYS)) items.push({ label: name, kind: K.Variable, detail: v.doc, insertText: name, range });
    for (const k of [...KEYWORDS, ...TYPES]) items.push({ label: k, kind: K.Keyword, insertText: k, range });
    items.push({
      label: 'task main',
      kind: K.Snippet,
      insertText: 'task main()\n{\n\t$0\n}',
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      range,
    });
    return { suggestions: items };
  },
});

monaco.languages.registerHoverProvider('robotc', {
  provideHover(model, position) {
    const w = model.getWordAtPosition(position);
    if (!w) return null;
    const doc = BUILTINS[w.word]?.doc ?? SYS_VARS[w.word]?.doc ?? SYS_ARRAYS[w.word]?.doc;
    if (!doc) return null;
    return { contents: [{ value: '```\n' + doc + '\n```' }] };
  },
});

export { monaco };
