import Editor, { OnMount } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';
import { Diagnostic } from '../lang/errors';
import { monaco } from './monaco';

export interface EditorApi {
  revealLine(line: number): void;
}

interface Props {
  value: string;
  onChange(value: string): void;
  diagnostics: Diagnostic[];
  /** Lines the running tasks are on, highlighted in the editor. */
  execLines: number[];
  onReady?(api: EditorApi): void;
}

export function CodeEditor({ value, onChange, diagnostics, execLines, onReady }: Props) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    decorations.current = editor.createDecorationsCollection();
    onReady?.({
      revealLine(line) {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
      },
    });
  };

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      'robotc',
      diagnostics.map((d) => {
        const line = Math.min(Math.max(1, d.line), model.getLineCount());
        const lineText = model.getLineContent(line);
        const col = Math.min(Math.max(1, d.col), lineText.length + 1);
        const word = model.getWordAtPosition({ lineNumber: line, column: col });
        return {
          startLineNumber: line,
          startColumn: word ? word.startColumn : col,
          endLineNumber: line,
          endColumn: word ? word.endColumn : Math.max(col + 1, lineText.length + 1),
          message: d.message,
          severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        };
      }),
    );
  }, [diagnostics]);

  useEffect(() => {
    decorations.current?.set(
      execLines.map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: 'exec-line', glyphMarginClassName: 'exec-glyph' },
      })),
    );
  }, [execLines]);

  return (
    <div className="editor" dir="ltr">
      <Editor
        language="robotc"
        value={value}
        onChange={(v) => onChange(v ?? '')}
        onMount={onMount}
        options={{
          fontSize: 14,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          glyphMargin: true,
          renderLineHighlight: 'line',
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  );
}
