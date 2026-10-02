import { useLayoutEffect, useRef, useState } from 'react'
import { basicSetup } from 'codemirror'
import { completeFromList, ifNotIn } from '@codemirror/autocomplete'
import { indentWithTab } from '@codemirror/commands'
import { defaultHighlightStyle, foldService, HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state'
import type { Text } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'

export interface DslEditorProps {
  text: string
  onChange: (text: string) => void
  dark: boolean
}

const KEYWORDS = [
  'workspace', 'extends', 'model', 'views', 'person', 'softwareSystem', 'container',
  'component', 'group', 'deploymentEnvironment', 'deploymentNode', 'infrastructureNode',
  'softwareSystemInstance', 'containerInstance', 'deploymentGroup', 'healthCheck',
  'systemLandscape', 'systemContext', 'dynamic', 'deployment', 'filtered', 'custom',
  'image', 'include', 'exclude', 'autoLayout', 'animation', 'title', 'description',
  'technology', 'tags', 'url', 'properties', 'perspectives', 'styles', 'element',
  'relationship', 'theme', 'themes', 'branding', 'logo', 'font', 'shape', 'icon',
  'width', 'height', 'background', 'color', 'stroke', 'strokeWidth', 'fontSize',
  'border', 'opacity', 'metadata', 'routing', 'thickness', 'dashed', 'position',
  'configuration', 'scope', 'visibility', 'terminology', 'users',
  '!include', '!identifiers', '!impliedRelationships', '!docs', '!adrs', '!constant',
  '!var', '!script', '!plugin', '!ref', '!extend', '!element', '!elements',
  '!relationship', '!relationships',
]
const keywords = new Set(KEYWORDS)

interface TokenState {
  comment: boolean
  quoted: boolean
  depth: number
}

const dslLanguage = StreamLanguage.define<TokenState>({
  name: 'Structurizr DSL',
  startState: () => ({ comment: false, quoted: false, depth: 0 }),
  token(stream, state) {
    if (state.comment || (!state.quoted && stream.match('/*'))) {
      state.comment = true
      while (!stream.eol()) {
        if (stream.match('*/')) {
          state.comment = false
          break
        }
        stream.next()
      }
      return 'comment'
    }
    if (state.quoted || stream.eat('"')) {
      state.quoted = true
      while (!stream.eol()) {
        const char = stream.next()
        if (char === '\\') stream.next()
        else if (char === '"') {
          state.quoted = false
          break
        }
      }
      return 'string'
    }
    if (stream.eatSpace()) return null
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.eat('{')) {
      state.depth += 1
      return 'brace'
    }
    if (stream.eat('}')) {
      state.depth = Math.max(0, state.depth - 1)
      return 'brace'
    }
    if (stream.match('->') || stream.match(/^[=*]/)) return 'operator'
    if (stream.match(/^\d+(?:\.\d+)?\b/)) return 'number'
    if (stream.match(/^!?[\w.-]+/)) {
      const word = stream.current()
      if (keywords.has(word)) return 'keyword'
      if (word === 'true' || word === 'false') return 'bool'
      return word.startsWith('!') ? 'meta' : 'variableName'
    }
    stream.next()
    return null
  },
  indent(state, textAfter, context) {
    if (state.comment || state.quoted) return null
    return Math.max(0, state.depth - (textAfter.trimStart().startsWith('}') ? 1 : 0)) * context.unit
  },
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['{', '"'] },
    indentOnInput: /^\s*\}/,
    autocomplete: ifNotIn(['string', 'comment'], completeFromList(
      KEYWORDS.map((label) => ({ label, type: 'keyword' })),
    )),
  },
})

interface Structure {
  error: string | null
  folds: { from: number; to: number }[]
}

function scanStructure(text: string): Structure {
  const stack: { position: number; line: number }[] = []
  const folds: Structure['folds'] = []
  let line = 1
  let i = 0
  let firstToken: string | undefined
  let firstLine = 1
  let hasBlock = false
  let error: string | null = null

  while (i < text.length) {
    const char = text[i]
    if (/\s/.test(char)) {
      if (char === '\n' || (char === '\r' && text[i + 1] !== '\n')) line += 1
      i += 1
      continue
    }
    if (text.startsWith('//', i)) {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1
      continue
    }
    if (text.startsWith('/*', i)) {
      const startLine = line
      i += 2
      while (i < text.length && !text.startsWith('*/', i)) {
        if (text[i] === '\n' || (text[i] === '\r' && text[i + 1] !== '\n')) line += 1
        i += 1
      }
      if (i === text.length) return { folds, error: `Line ${startLine}: unterminated block comment.` }
      i += 2
      continue
    }
    if (firstToken === undefined) {
      firstToken = text.slice(i).match(/^[\w.!-]+/)?.[0] ?? char
      firstLine = line
    }
    if (char === '"') {
      const startLine = line
      let closed = false
      let escaped = false
      i += 1
      while (i < text.length) {
        const next = text[i++]
        if (next === '\n' || (next === '\r' && text[i] !== '\n')) line += 1
        if (escaped) escaped = false
        else if (next === '\\') escaped = true
        else if (next === '"') {
          closed = true
          break
        }
      }
      if (!closed) return { folds, error: `Line ${startLine}: unterminated quoted string.` }
      continue
    }
    if (char === '{') {
      hasBlock = true
      stack.push({ position: i, line })
    } else if (char === '}') {
      const open = stack.pop()
      if (!open) error ??= `Line ${line}: unmatched closing brace '}'.`
      else if (open.line < line) folds.push({ from: open.position + 1, to: i })
    }
    i += 1
  }

  const open = stack.at(-1)
  if (open) error ??= `Line ${open.line}: unmatched opening brace '{'.`
  if (firstToken !== 'workspace') error ??= `Line ${firstLine}: a workspace declaration is required.`
  else if (!hasBlock) error ??= `Line ${firstLine}: a workspace block is required.`
  return { folds, error }
}

export function validateDsl(text: string): string | null {
  return scanStructure(text).error
}

const structureCache = new WeakMap<Text, Structure>()
const dslFolding = foldService.of((state, lineStart, lineEnd) => {
  let structure = structureCache.get(state.doc)
  if (!structure) {
    structure = scanStructure(state.doc.toString())
    structureCache.set(state.doc, structure)
  }
  return structure.folds.find((fold) => fold.from > lineStart && fold.from <= lineEnd && fold.to > lineEnd) ?? null
})

function editorTheme(dark: boolean) {
  return [
    EditorView.theme({
      '&': { height: '100%', color: 'var(--ink)', backgroundColor: 'var(--sheet)', colorScheme: dark ? 'dark' : 'light' },
      '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: '13px', lineHeight: '1.65' },
      '.cm-content': { padding: '12px 0', caretColor: 'var(--accent)' },
      '.cm-line': { padding: '0 12px' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
      '.cm-gutters': { backgroundColor: 'var(--paper)', color: 'var(--muted)', borderRight: '1px solid var(--line)' },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--accent-tint)' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--accent-line)' },
      '.cm-selectionMatch, .cm-searchMatch': { backgroundColor: 'var(--accent-tint)', outline: '1px solid var(--accent-line)' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-line)' },
      '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--accent-line)', color: 'var(--accent-deep)' },
      '.cm-foldPlaceholder': { backgroundColor: 'var(--paper)', color: 'var(--muted)', border: '1px solid var(--line-strong)' },
      '.cm-panels, .cm-tooltip': { backgroundColor: 'var(--sheet)', color: 'var(--ink)', border: '1px solid var(--line-strong)', fontFamily: 'var(--font-body)' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-tint)', color: 'var(--accent-deep)' },
      '.cm-textfield': { backgroundColor: 'var(--paper)', color: 'var(--ink)', border: '1px solid var(--line-strong)' },
      '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--paper)', color: 'var(--ink)', border: '1px solid var(--line-strong)' },
    }, { dark }),
    syntaxHighlighting(HighlightStyle.define(defaultHighlightStyle.specs.map((spec) => ({
      ...spec,
      color: spec.color ? `color-mix(in srgb, ${spec.color} ${dark ? '30%' : '85%'}, var(--ink))` : 'var(--ink)',
    })))),
  ]
}

const externalChange = Annotation.define<boolean>()

export function DslEditor({ text, onChange, dark }: DslEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const [initial] = useState(() => ({ text, dark, theme: new Compartment() }))

  useLayoutEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useLayoutEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initial.text,
        extensions: [
          basicSetup,
          dslLanguage,
          dslFolding,
          indentUnit.of('  '),
          keymap.of([indentWithTab]),
          initial.theme.of(editorTheme(initial.dark)),
          EditorView.contentAttributes.of({ 'aria-label': 'Editor Structurizr DSL', spellcheck: 'false' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && update.transactions.some((transaction) => transaction.docChanged && !transaction.annotation(externalChange))) {
              onChangeRef.current(update.state.doc.toString())
            }
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [initial])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    const next = view.state.toText(text).toString()
    const current = view.state.doc.toString()
    if (current === next) return
    let from = 0
    let to = current.length
    let nextTo = next.length
    while (from < to && from < nextTo && current[from] === next[from]) from += 1
    while (to > from && nextTo > from && current[to - 1] === next[nextTo - 1]) {
      to -= 1
      nextTo -= 1
    }
    view.dispatch({
      changes: { from, to, insert: next.slice(from, nextTo) },
      annotations: [externalChange.of(true), Transaction.addToHistory.of(false)],
    })
  }, [text])

  useLayoutEffect(() => {
    viewRef.current?.dispatch({ effects: initial.theme.reconfigure(editorTheme(dark)) })
  }, [dark, initial])

  return (
    <div
      ref={hostRef}
      className="dsl-editor"
      style={{ height: '100%', minHeight: 0, minWidth: 0, overflow: 'hidden' }}
      onKeyDown={(event) => event.stopPropagation()}
    />
  )
}
