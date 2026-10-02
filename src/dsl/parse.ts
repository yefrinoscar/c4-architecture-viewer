export type ElementType =
  | 'person'
  | 'softwareSystem'
  | 'container'
  | 'component'
  | 'deploymentNode'
  | 'infrastructureNode'
  | 'softwareSystemInstance'
  | 'containerInstance'
  | string

export interface Element {
  id: number
  varName: string
  type: ElementType
  name: string
  description: string
  technology: string
  tags: string[]
  properties: Record<string, string>
  parent?: Element
  children: Element[]
  group?: string
}

export interface Relationship {
  id: number
  source: Element
  destination: Element
  description: string
  technology: string
  tags: string[]
  properties: Record<string, string>
}

export interface DynamicStep {
  n: number
  source: Element
  destination: Element
  description: string
}

export interface View {
  type: string
  key: string
  description: string
  title?: string
  scope?: Element
  includes: string[]
  excludes: string[]
  steps: DynamicStep[]
}

export interface StyleRule {
  kind: 'element' | 'relationship'
  tag: string
  values: Record<string, string>
}

export interface Workspace {
  name: string
  description: string
  elements: Element[]
  relationships: Relationship[]
  views: View[]
  styles: StyleRule[]
}

const ELEMENT_TYPES = new Set([
  'person',
  'softwareSystem',
  'container',
  'component',
  'deploymentNode',
  'infrastructureNode',
  'softwareSystemInstance',
  'containerInstance',
  'group',
])

const VIEW_TYPES = new Set([
  'systemLandscape',
  'systemContext',
  'container',
  'component',
  'dynamic',
  'filtered',
  'deployment',
  'custom',
  'image',
])

export const TYPE_LABEL: Record<string, string> = {
  person: 'Person',
  softwareSystem: 'Software System',
  container: 'Container',
  component: 'Component',
  deploymentNode: 'Deployment Node',
  infrastructureNode: 'Infrastructure Node',
}

type Token =
  | { type: 'string'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'lbrace' }
  | { type: 'rbrace' }
  | { type: 'arrow' }
  | { type: 'equals' }
  | { type: 'newline' }
  | { type: 'directive'; value: string }

function lex(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = src.length

  while (i < n) {
    const c = src[i]
    if (c === '\n') {
      tokens.push({ type: 'newline' })
      i += 1
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i += 1
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (c === '!') {
      let s = ''
      while (i < n && src[i] !== '\n') {
        s += src[i]
        i += 1
      }
      tokens.push({ type: 'directive', value: s })
      continue
    }
    if (c === '"') {
      i += 1
      let s = ''
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          const next = src[i + 1]
          s += next === 'n' ? '\n' : next === 't' ? '\t' : next
          i += 2
          continue
        }
        s += src[i]
        i += 1
      }
      i += 1
      tokens.push({ type: 'string', value: s })
      continue
    }
    if (c === '{') {
      tokens.push({ type: 'lbrace' })
      i += 1
      continue
    }
    if (c === '}') {
      tokens.push({ type: 'rbrace' })
      i += 1
      continue
    }
    if (c === '=') {
      tokens.push({ type: 'equals' })
      i += 1
      continue
    }
    if (c === '-' && src[i + 1] === '>') {
      tokens.push({ type: 'arrow' })
      i += 2
      continue
    }

    let s = ''
    while (i < n) {
      const ch = src[i]
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') break
      if (ch === '"' || ch === '{' || ch === '}' || ch === '=') break
      if (ch === '-' && src[i + 1] === '>') break
      s += ch
      i += 1
    }
    if (s) tokens.push({ type: 'ident', value: s })
  }

  return tokens
}

class Parser {
  private i = 0
  private tokens: Token[]
  private workspace: { name: string; description: string }
  readonly elements: Element[] = []
  readonly relationships: Relationship[] = []
  readonly views: View[] = []
  readonly styles: StyleRule[] = []
  private byVar = new Map<string, Element>()
  private byName = new Map<string, Element>()
  private nextId = 1
  private relId = 1

  constructor(tokens: Token[], workspace: { name: string; description: string }) {
    this.tokens = tokens
    this.workspace = workspace
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset]
  }

  private next(): Token | undefined {
    return this.tokens[this.i++]
  }

  private skipLines() {
    for (;;) {
      const t = this.peek()
      if (!t) return
      if (t.type === 'newline' || t.type === 'directive') {
        this.i += 1
        continue
      }
      return
    }
  }

  private atEnd(): boolean {
    return this.i >= this.tokens.length
  }

  private atBlockEnd(): boolean {
    const t = this.peek()
    return !t || t.type === 'rbrace'
  }

  private skipRestOfLine() {
    for (;;) {
      const t = this.peek()
      if (!t || t.type === 'newline' || t.type === 'rbrace') return
      this.i += 1
    }
  }

  private skipBalanced() {
    let depth = 0
    while (!this.atEnd()) {
      const t = this.next()
      if (!t) return
      if (t.type === 'lbrace') depth += 1
      else if (t.type === 'rbrace') {
        depth -= 1
        if (depth <= 0) return
      }
    }
  }

  private skipStatement() {
    for (;;) {
      const t = this.peek()
      if (!t || t.type === 'newline' || t.type === 'rbrace') return
      if (t.type === 'lbrace') {
        this.skipBalanced()
        return
      }
      this.i += 1
    }
  }

  private consumeBlockEnd() {
    const t = this.peek()
    if (t && t.type === 'rbrace') this.i += 1
  }

  private readString(): string {
    const t = this.next()
    return t && t.type === 'string' ? t.value : ''
  }

  private readRef(): Element | undefined {
    const t = this.next()
    if (!t) return undefined
    if (t.type === 'ident') return this.byVar.get(t.value) ?? this.byName.get(t.value)
    if (t.type === 'string') return this.byName.get(t.value)
    return undefined
  }

  private register(element: Element) {
    this.elements.push(element)
    if (!this.byVar.has(element.varName)) this.byVar.set(element.varName, element)
    this.byName.set(element.name, element)
    if (element.parent) element.parent.children.push(element)
  }

  parse(): Workspace {
    this.skipLines()
    if (this.peek()?.type === 'ident') this.next()

    let name = ''
    let description = ''
    if (this.peek()?.type === 'string') name = this.readString()
    if (this.peek()?.type === 'string') description = this.readString()
    if (this.peek()?.type === 'lbrace') this.i += 1

    this.workspace = { name, description }

    while (!this.atEnd() && this.peek()?.type !== 'rbrace') {
      this.skipLines()
      const t = this.peek()
      if (!t) break
      if (t.type === 'rbrace') break
      if (t.type === 'ident' && t.value === 'model') {
        this.next()
        if (this.peek()?.type === 'lbrace') this.i += 1
        this.parseModelBody(undefined, undefined)
        this.consumeBlockEnd()
        continue
      }
      if (t.type === 'ident' && t.value === 'views') {
        this.next()
        if (this.peek()?.type === 'lbrace') this.i += 1
        this.parseViewsBody()
        this.consumeBlockEnd()
        continue
      }
      this.skipRestOfLine()
    }

    return {
      name: this.workspace.name,
      description: this.workspace.description,
      elements: this.elements,
      relationships: this.relationships,
      views: this.views,
      styles: this.styles,
    }
  }

  private looksLikeRelationship(): boolean {
    const t = this.peek()
    if (!t) return false
    const following = this.peek(1)
    if (t.type === 'string') return following?.type === 'arrow'
    if (t.type === 'ident') {
      if (following?.type === 'arrow') return true
      return this.byVar.has(t.value) || this.byName.has(t.value)
    }
    return false
  }

  private parseModelBody(parent?: Element, group?: string) {
    for (;;) {
      this.skipLines()
      if (this.atEnd() || this.atBlockEnd()) return
      const t = this.peek()
      if (!t) return

      if (t.type === 'ident' && t.value === 'group') {
        this.next()
        const gname = this.readString()
        if (this.peek()?.type === 'lbrace') this.i += 1
        this.parseModelBody(parent, gname)
        this.consumeBlockEnd()
        continue
      }

      // assignment: name = <element | relationship>
      if (t.type === 'ident' && this.peek(1)?.type === 'equals') {
        const varName = (this.next() as { value: string }).value
        this.next()
        const after = this.peek()
        if (after && after.type === 'ident' && ELEMENT_TYPES.has(after.value)) {
          this.parseElement(varName, parent, group)
        } else {
          this.parseRelationship(undefined)
        }
        continue
      }

      if (t.type === 'ident' && ELEMENT_TYPES.has(t.value)) {
        this.parseElement(undefined, parent, group)
        continue
      }

      if (this.looksLikeRelationship()) {
        this.parseRelationship(undefined)
        continue
      }

      this.skipStatement()
    }
  }

  private parseElement(varName: string | undefined, parent: Element | undefined, group: string | undefined) {
    const typeTok = this.next()
    if (!typeTok || typeTok.type !== 'ident') return
    const name = this.readString()
    let description = ''
    let technology = ''
    if (this.peek()?.type === 'string') description = this.readString()
    if (this.peek()?.type === 'string') technology = this.readString()

    const element: Element = {
      id: this.nextId++,
      varName: varName ?? name,
      type: typeTok.value,
      name,
      description,
      technology,
      tags: [],
      properties: {},
      parent,
      children: [],
      group,
    }
    this.register(element)

    if (this.peek()?.type === 'lbrace') {
      this.i += 1
      this.parseElementBody(element)
      this.consumeBlockEnd()
    }
  }

  private parseElementBody(element: Element) {
    for (;;) {
      this.skipLines()
      if (this.atEnd() || this.atBlockEnd()) return
      const t = this.peek()
      if (!t) return

      if (t.type === 'ident' && t.value === 'tags') {
        this.next()
        while (this.peek()?.type === 'string') {
          element.tags.push(...this.readString().split(',').map((s) => s.trim()).filter(Boolean))
        }
        continue
      }

      if (t.type === 'ident' && t.value === 'properties') {
        this.next()
        if (this.peek()?.type === 'lbrace') this.i += 1
        for (;;) {
          this.skipLines()
          if (this.atEnd() || this.atBlockEnd()) break
          if (this.peek()?.type === 'string') {
            const k = this.readString()
            const v = this.peek()?.type === 'string' ? this.readString() : ''
            if (k) element.properties[k] = v
            continue
          }
          this.skipRestOfLine()
        }
        this.consumeBlockEnd()
        continue
      }

      if (t.type === 'ident' && (t.value === 'technology' || t.value === 'url' || t.value === 'description')) {
        const key = t.value
        this.next()
        const value = this.readString()
        if (key === 'technology') element.technology = value
        else if (key === 'description') element.description = value
        else if (value) element.properties.url = value
        continue
      }

      if (t.type === 'ident' && t.value === 'group') {
        this.next()
        const gname = this.readString()
        if (this.peek()?.type === 'lbrace') {
          this.i += 1
          this.parseModelBody(element, gname)
          this.consumeBlockEnd()
        } else {
          element.group = gname
        }
        continue
      }

      if (t.type === 'ident' && this.peek(1)?.type === 'equals') {
        const varName = (this.next() as { value: string }).value
        this.next()
        const after = this.peek()
        if (after && after.type === 'ident' && ELEMENT_TYPES.has(after.value)) {
          this.parseElement(varName, element, undefined)
        } else {
          this.parseRelationship(undefined)
        }
        continue
      }

      if (t.type === 'ident' && ELEMENT_TYPES.has(t.value)) {
        this.parseElement(undefined, element, undefined)
        continue
      }

      if (this.looksLikeRelationship()) {
        this.parseRelationship(undefined)
        continue
      }

      this.skipStatement()
    }
  }

  private parseRelationship(tags: string[] | undefined) {
    const sources: Element[] = []
    const destinations: Element[] = []
    const first = this.readRef()
    if (!first) {
      this.skipRestOfLine()
      return
    }
    sources.push(first)

    while (this.peek()?.type === 'arrow') {
      this.next()
      const ref = this.readRef()
      if (ref) destinations.push(ref)
    }

    let description = ''
    let technology = ''
    if (this.peek()?.type === 'string') description = this.readString()
    if (this.peek()?.type === 'string') technology = this.readString()

    const relTags: string[] = tags ? [...tags] : []
    const properties: Record<string, string> = {}
    if (this.peek()?.type === 'lbrace') {
      this.i += 1
      for (;;) {
        this.skipLines()
        if (this.atEnd() || this.atBlockEnd()) break
        const t = this.peek()
        if (t?.type === 'ident' && t.value === 'tags') {
          this.next()
          while (this.peek()?.type === 'string') {
            relTags.push(...this.readString().split(',').map((s) => s.trim()).filter(Boolean))
          }
          continue
        }
        if (t?.type === 'ident' && t.value === 'properties') {
          this.next()
          if (this.peek()?.type === 'lbrace') this.i += 1
          for (;;) {
            this.skipLines()
            if (this.atEnd() || this.atBlockEnd()) break
            if (this.peek()?.type === 'string') {
              const k = this.readString()
              const v = this.peek()?.type === 'string' ? this.readString() : ''
              if (k) properties[k] = v
              continue
            }
            this.skipRestOfLine()
          }
          this.consumeBlockEnd()
          continue
        }
        this.skipRestOfLine()
      }
      this.consumeBlockEnd()
    }

    for (const source of sources) {
      for (const destination of destinations) {
        this.relationships.push({
          id: this.relId++,
          source,
          destination,
          description,
          technology,
          tags: relTags,
          properties,
        })
      }
    }
  }

  private parseViewsBody() {
    for (;;) {
      this.skipLines()
      if (this.atEnd() || this.atBlockEnd()) return
      const t = this.peek()
      if (!t) return

      if (t.type === 'ident' && t.value === 'styles') {
        this.next()
        if (this.peek()?.type === 'lbrace') this.i += 1
        this.parseStylesBody()
        this.consumeBlockEnd()
        continue
      }

      if (t.type === 'ident' && VIEW_TYPES.has(t.value)) {
        this.parseView(t.value)
        continue
      }

      this.skipStatement()
    }
  }

  private parseView(type: string) {
    this.next()
    const scopeTok = this.next()
    let scope: Element | undefined
    if (scopeTok?.type === 'ident' && scopeTok.value !== '*') {
      scope = this.byVar.get(scopeTok.value) ?? this.byName.get(scopeTok.value)
    } else if (scopeTok?.type === 'string') {
      scope = this.byName.get(scopeTok.value)
    }

    const key = this.readString()
    let description = ''
    if (this.peek()?.type === 'string') description = this.readString()

    const view: View = {
      type,
      key,
      description,
      title: undefined,
      scope,
      includes: [],
      excludes: [],
      steps: [],
    }

    if (this.peek()?.type === 'lbrace') {
      this.i += 1
      this.parseViewBody(view)
      this.consumeBlockEnd()
    }

    this.views.push(view)
  }

  private parseViewBody(view: View) {
    for (;;) {
      this.skipLines()
      if (this.atEnd() || this.atBlockEnd()) return
      const t = this.peek()
      if (!t) return

      if (t.type === 'ident' && (t.value === 'include' || t.value === 'exclude')) {
        const isInclude = t.value === 'include'
        this.next()
        const values: string[] = []
        while (this.peek()?.type === 'string' || this.peek()?.type === 'ident') {
          const tok = this.next()
          values.push(tok && tok.type === 'string' ? tok.value : tok && tok.type === 'ident' ? tok.value : '')
        }
        if (isInclude) view.includes.push(...values)
        else view.excludes.push(...values)
        continue
      }

      if (t.type === 'ident' && t.value === 'title') {
        this.next()
        view.title = this.readString()
        continue
      }

      if (t.type === 'ident' && /^\d+:?$/.test(t.value)) {
        const n = Number.parseInt(t.value.replace(':', ''), 10)
        this.next()
        const source = this.readRef()
        if (this.peek()?.type !== 'arrow') {
          this.skipRestOfLine()
          continue
        }
        this.next()
        const destination = this.readRef()
        const desc = this.peek()?.type === 'string' ? this.readString() : ''
        if (source && destination) {
          view.steps.push({ n, source, destination, description: desc })
        }
        continue
      }

      this.skipStatement()
    }
  }

  private parseStylesBody() {
    for (;;) {
      this.skipLines()
      if (this.atEnd() || this.atBlockEnd()) return
      const t = this.peek()
      if (!t) return
      if (t.type !== 'ident' || (t.value !== 'element' && t.value !== 'relationship')) {
        this.skipRestOfLine()
        continue
      }
      const kind = t.value as 'element' | 'relationship'
      this.next()
      const tag = this.readString()
      if (this.peek()?.type !== 'lbrace') {
        this.skipRestOfLine()
        continue
      }
      this.i += 1
      const values: Record<string, string> = {}
      for (;;) {
        this.skipLines()
        if (this.atEnd() || this.atBlockEnd()) break
        const tok = this.peek()
        if (tok?.type === 'ident') {
          const key = tok.value
          this.next()
          const parts: string[] = []
          while (this.peek()?.type === 'ident' || this.peek()?.type === 'string') {
            const v = this.next()
            if (v && 'value' in v) parts.push(v.value)
          }
          values[key] = parts.join(' ')
          continue
        }
        this.skipRestOfLine()
      }
      this.consumeBlockEnd()
      this.styles.push({ kind, tag, values })
    }
  }
}

export function parseWorkspace(source: string): Workspace {
  return new Parser(lex(source), { name: '', description: '' }).parse()
}
