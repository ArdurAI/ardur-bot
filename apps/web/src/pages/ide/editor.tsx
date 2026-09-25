import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { yaml } from "@codemirror/lang-yaml";
import {
  bracketMatching,
  defaultHighlightStyle,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import type { Ref } from "react";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";

export type EditorSelection = { text: string; startLine: number; endLine: number };
export type EditorHandle = { selection(): EditorSelection | null; find(): void };
export type EditorDocument = { id: string; path: string; content: string; readOnly: boolean };

export function languageFor(path: string) {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  const extension = name.split(".").at(-1);
  switch (extension) {
    case "ts":
    case "tsx":
      return javascript({ typescript: true, jsx: extension === "tsx" });
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: extension === "jsx" });
    case "json":
      return json();
    case "md":
    case "markdown":
      return markdown();
    case "py":
      return python();
    case "go":
      return go();
    case "rs":
      return rust();
    case "yaml":
    case "yml":
      return yaml();
    case "html":
    case "htm":
      return html();
    case "css":
      return css();
    case "sh":
    case "bash":
    case "zsh":
      return StreamLanguage.define(shell);
    default:
      return /^(\.?(bash|zsh)(rc|_profile)|profile)$/.test(name)
        ? StreamLanguage.define(shell)
        : [];
  }
}

const theme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    fontSize: "13px",
  },
  ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, monospace)" },
  ".cm-content": { caretColor: "var(--foreground)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "var(--background)",
    color: "var(--muted-foreground)",
    borderColor: "var(--border)",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--muted)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--accent)",
  },
  ".cm-panels": {
    backgroundColor: "var(--card)",
    color: "var(--foreground)",
    borderColor: "var(--border)",
  },
  ".cm-textfield, .cm-button": {
    background: "var(--background)",
    color: "var(--foreground)",
    borderColor: "var(--border)",
  },
  ".cm-searchMatch": { backgroundColor: "var(--muted)", outline: "1px solid var(--border)" },
  ".cm-searchMatch-selected": { outline: "1px solid var(--foreground)" },
});
const highlighting = HighlightStyle.define(
  defaultHighlightStyle.specs.map(({ tag, fontStyle, fontWeight }) => ({
    tag,
    fontStyle,
    fontWeight,
    color: "var(--foreground)",
  })),
);

/** This module and every CodeMirror import live behind the IDE's editor lazy boundary. */
export default function Editor({
  document,
  openIds,
  onChange,
  onSave,
  onAsk,
  ref,
}: {
  document: EditorDocument;
  openIds: string[];
  onChange(id: string, content: string): void;
  onSave(): void;
  onAsk(): void;
  ref?: Ref<EditorHandle>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const activeId = useRef(document.id);
  const callbacks = useRef({ onChange, onSave, onAsk });
  callbacks.current = { onChange, onSave, onAsk };
  useImperativeHandle(
    ref,
    () => ({
      selection: () => {
        const state = view.current?.state;
        const selected = state?.selection.main;
        if (!state || !selected || selected.empty) return null;
        return {
          text: state.sliceDoc(selected.from, selected.to),
          startLine: state.doc.lineAt(selected.from).number,
          endLine: state.doc.lineAt(Math.max(selected.from, selected.to - 1)).number,
        };
      },
      find: () => {
        if (view.current) openSearchPanel(view.current);
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    if (!container.current) return;
    const state =
      states.current.get(document.id) ??
      EditorState.create({
        doc: document.content,
        extensions: [
          theme,
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          indentOnInput(),
          syntaxHighlighting(highlighting),
          languageFor(document.path),
          search({ top: true }),
          EditorState.readOnly.of(document.readOnly),
          EditorView.editable.of(!document.readOnly),
          EditorView.contentAttributes.of({
            "aria-label": document.path,
            "data-ide-editor": "true",
            "aria-readonly": String(document.readOnly),
          }),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                callbacks.current.onSave();
                return true;
              },
            },
            {
              key: "Mod-Shift-a",
              run: () => {
                callbacks.current.onAsk();
                return true;
              },
            },
            ...searchKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              callbacks.current.onChange(activeId.current, update.state.doc.toString());
          }),
        ],
      });
    activeId.current = document.id;
    const editor = new EditorView({ state, parent: container.current });
    view.current = editor;
    editor.focus();
    return () => {
      states.current.set(document.id, editor.state);
      editor.destroy();
      view.current = null;
    };
    // A tab owns its editor state, undo history, and selection. Save never replaces that state.
  }, [document.id, document.path, document.readOnly]);
  useEffect(() => {
    for (const id of states.current.keys()) if (!openIds.includes(id)) states.current.delete(id);
  }, [openIds]);
  return (
    <div ref={container} className="h-full min-h-0 overflow-hidden" data-testid="ide-editor" />
  );
}
