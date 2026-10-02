import type { Element, Relationship, StyleRule, View, Workspace } from './parse.ts'
import { TYPE_LABEL } from './parse.ts'

interface ResolvedStyle {
  fill: string
  color: string
  stroke: string
  shape: string
}

export interface DiagramPalette {
  sheet: string
  sheetStroke: string
  labelFill: string
  labelColor: string
  boundaryFill: string
  boundaryStroke: string
  boundaryColor: string
  groupFill: string
  groupStroke: string
  groupColor: string
  fallbackFill: string
}

export const LIGHT_PALETTE: DiagramPalette = {
  sheet: 'transparent',
  sheetStroke: 'transparent',
  labelFill: '#ffffff',
  labelColor: '#24342e',
  boundaryFill: '#f8fbf9',
  boundaryStroke: '#91a99f',
  boundaryColor: '#365047',
  groupFill: '#f1f6f3',
  groupStroke: '#9db5ab',
  groupColor: '#3f5b51',
  fallbackFill: '#dce7e2',
}

export const DARK_PALETTE: DiagramPalette = {
  sheet: 'transparent',
  sheetStroke: 'transparent',
  labelFill: '#2b3338',
  labelColor: '#edf1f2',
  boundaryFill: 'transparent',
  boundaryStroke: '#526169',
  boundaryColor: '#a9b5bb',
  groupFill: 'transparent',
  groupStroke: '#526169',
  groupColor: '#9aa7ad',
  fallbackFill: '#39424a',
}

export function paletteFor(theme: string): DiagramPalette {
  return theme === 'dark' ? DARK_PALETTE : LIGHT_PALETTE
}

/**
 * Estilos que mermaid no sabe derivar de la paleta: el fondo del chip de las
 * etiquetas de relación y el fill de los paths (que debe ser siempre none).
 */
export function diagramOverrides(id: string, palette: DiagramPalette): string {
  return [
    '<style>',
    `#${id} .labelBkg, #${id} span.edgeLabel { background-color: ${palette.labelFill} !important; }`,
    `#${id} .edgeLabel, #${id} span.edgeLabel, #${id} .edgeLabel p { color: ${palette.labelColor} !important; font-size: 14px !important; }`,
    `#${id} .edgeLabel p { margin: 0 !important; line-height: 1.35 !important; }`,
    `#${id} g.edgeLabel text { fill: ${palette.labelColor} !important; }`,
    `#${id} span.edgeLabel { border: 1px solid ${palette.boundaryStroke}; border-radius: 4px; padding: 3px 7px; }`,
    `#${id} path.flowchart-link { fill: none !important; stroke-width: 1.5px !important; }`,
    `#${id} g.cluster[id$="-diagram"] > .cluster-label { display: none !important; }`,
    '</style>',
  ].join('')
}

export type CurveMode = 'curve' | 'straight' | 'orthogonal'

/** Trazado de las líneas del diagrama (config `curve` de mermaid). */
export const CURVE_OPTIONS: { id: CurveMode; label: string; mermaid: string; hint: string }[] = [
  { id: 'curve', label: 'Curvas', mermaid: 'basis', hint: 'Trazado curvo, el original' },
  { id: 'straight', label: 'Rectas', mermaid: 'linear', hint: 'Línea recta entre los nodos' },
  { id: 'orthogonal', label: 'Ortogonales', mermaid: 'step', hint: 'Tramos en ángulo recto' },
]

export function isCurveMode(value: unknown): value is CurveMode {
  return value === 'curve' || value === 'straight' || value === 'orthogonal'
}

export type MermaidCurve = 'basis' | 'linear' | 'step'

export function mermaidCurve(mode: CurveMode): MermaidCurve {
  return (CURVE_OPTIONS.find((option) => option.id === mode)?.mermaid as MermaidCurve) ?? 'basis'
}

/** Tipos de elemento que definen cada vista global de nivel C4. */
const LEVEL_TYPES: Record<string, Set<string>> = {
  globalL1: new Set(['person', 'softwareSystem']),
  globalL2: new Set(['container']),
  globalL3: new Set(['component']),
}
const LEVEL_ORDER = ['globalL1', 'globalL2', 'globalL3']

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function normalizeHex(hex: string): string {
  const value = hex.replace('#', '').trim()
  if (value.length === 3) return `#${value[0]}${value[0]}${value[1]}${value[1]}${value[2]}${value[2]}`.toLowerCase()
  return `#${value.slice(0, 6)}`.toLowerCase()
}

function darken(hex: string, factor = 0.7): string {
  const value = normalizeHex(hex)
  const r = clamp(Math.floor(Number.parseInt(value.slice(1, 3), 16) * factor))
  const g = clamp(Math.floor(Number.parseInt(value.slice(3, 5), 16) * factor))
  const b = clamp(Math.floor(Number.parseInt(value.slice(5, 7), 16) * factor))
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

function contrast(hex: string): string {
  const value = normalizeHex(hex)
  const r = Number.parseInt(value.slice(1, 3), 16)
  const g = Number.parseInt(value.slice(3, 5), 16)
  const b = Number.parseInt(value.slice(5, 7), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.6 ? '#000000' : '#ffffff'
}

function tagsFor(element: Element): string[] {
  const typeTag = TYPE_LABEL[element.type]
  return [...(typeTag ? [typeTag] : []), ...element.tags]
}

function mergeStyles(rules: StyleRule[], tags: string[]): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const tag of tags) {
    for (const rule of rules) {
      if (rule.tag === tag) Object.assign(merged, rule.values)
    }
  }
  return merged
}

export function resolveElementStyle(styleRules: StyleRule[], element: Element, palette: DiagramPalette = LIGHT_PALETTE): ResolvedStyle {
  if (isTopicElement(element)) {
    const deadLetter = /dead[-. ]?letter|\bdlq\b/i.test(`${element.name} ${element.technology} ${element.description}`)
    const dark = palette.labelFill !== '#ffffff'
    return deadLetter
      ? dark
        ? { fill: '#5b2d2d', stroke: '#e58b8b', color: '#ffe3e3', shape: 'Cylinder' }
        : { fill: '#f8d4d4', stroke: '#c45b5b', color: '#6b2020', shape: 'Cylinder' }
      : dark
        ? { fill: '#59431d', stroke: '#e0ad52', color: '#fff0c7', shape: 'Cylinder' }
        : { fill: '#ffe4a8', stroke: '#c58a27', color: '#5f430b', shape: 'Cylinder' }
  }
  const merged = mergeStyles(
    styleRules.filter((rule) => rule.kind === 'element'),
    tagsFor(element),
  )
  const fill = merged.background && merged.background.startsWith('#') ? normalizeHex(merged.background) : palette.fallbackFill
  const stroke = merged.stroke && merged.stroke.startsWith('#') ? normalizeHex(merged.stroke) : darken(fill)
  const color = merged.color && merged.color.startsWith('#') ? normalizeHex(merged.color) : contrast(fill)
  return { fill, color, stroke, shape: merged.shape ?? 'Box' }
}

function resolveBoundaryStyle(styleRules: StyleRule[], element: Element, palette: DiagramPalette = LIGHT_PALETTE): ResolvedStyle {
  const style = resolveElementStyle(styleRules, element, palette)
  const merged = mergeStyles(
    styleRules.filter((rule) => rule.kind === 'element'),
    tagsFor(element),
  )
  const border = merged.stroke ? style.stroke : palette.boundaryStroke
  return { fill: palette.boundaryFill, color: palette.boundaryColor, stroke: border, shape: 'Box' }
}

function escapeLabel(text: string): string {
  return text.replace(/"/g, '#quot;').replace(/\n/g, ' ')
}

function escapeHtmlText(text: string): string {
  return escapeLabel(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function wrap(text: string, width = 29): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!current) {
      current = word
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

function elementTypeLabel(element: Element): string {
  const base = TYPE_LABEL[element.type] ?? element.type
  return element.technology ? `${base}: ${element.technology}` : base
}

export function isTopicElement(element: Element): boolean {
  const tags = new Set(element.tags.map((tag) => tag.toLowerCase().trim()))
  const identity = `${element.varName} ${element.name}`
  const technology = element.technology
  const properties = Object.entries(element.properties)
    .map(([name, value]) => `${name} ${value}`)
    .join(' ')
  return ['topic', 'queue', 'store', 'event', 'dlq'].some((tag) => tags.has(tag))
    || /topic|queue|event hubs|service bus|kafka|dead[-. ]?letter|\bdlq\b/i.test(`${identity} ${technology} ${properties}`)
}

export function transactApiEndpoint(element: Element): string {
  if (element.type !== 'component') return ''
  const ancestry: Element[] = []
  let current: Element | undefined = element
  while (current) {
    ancestry.push(current)
    current = current.parent
  }
  const belongsToTransactApi = ancestry.some((ancestor) =>
    /transact|temenos/i.test(`${ancestor.varName} ${ancestor.name}`),
  ) && ancestry.some((ancestor) =>
    ancestor.type === 'container' && /(^|[^a-z])api([^a-z]|$)/i.test(`${ancestor.varName} ${ancestor.name}`),
  )
  if (!belongsToTransactApi) return ''
  return element.properties.endpoint?.trim() || element.properties.endpoints?.trim() || ''
}

export function missingTransactApiEndpoint(element: Element): string {
  const endpoint = transactApiEndpoint(element)
  if (!endpoint) return ''
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase()
  return normalize(element.description).includes(normalize(endpoint)) ? '' : endpoint
}

export function elementOperations(element: Element): string[] {
  if (element.type !== 'component') return []
  return ['operation', 'operations']
    .flatMap((key) => (element.properties[key] ?? '').split('|'))
    .map((value) => value.trim())
    .filter(Boolean)
}

export function missingElementOperations(element: Element): string[] {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase()
  const description = normalize(element.description)
  return elementOperations(element).filter((operation) => !description.includes(normalize(operation)))
}

function endpointLabel(element: Element): string {
  const endpoint = missingTransactApiEndpoint(element)
  if (!endpoint) return ''
  return `<div style='width:340px; overflow-wrap:anywhere; font-size:78%; line-height:1.4; margin-top:10px'><b>Endpoint:</b> ${escapeHtmlText(endpoint)}</div>`
}

function operationLabel(element: Element): string {
  const operations = missingElementOperations(element)
  if (!operations.length) return ''
  return `<div style='width:340px; overflow-wrap:anywhere; font-size:78%; line-height:1.4; margin-top:8px'><b>Operation:</b> ${operations.map(escapeHtmlText).join(' · ')}</div>`
}

function nodeLabel(element: Element): string {
  const parts = [
    `<div style='font-size: 108%; line-height: 1.3; font-weight: 700'>${escapeLabel(element.name)}</div>`,
    `<div style='font-size: 76%; line-height: 1.35; margin-top: 3px'>[${escapeLabel(elementTypeLabel(element))}]</div>`,
  ]
  if (element.description) {
    const description = wrap(element.description)
      .map((line) => escapeLabel(line))
      .join('<br />')
    parts.push(`<div style='font-size: 88%; line-height: 1.45; margin-top:12px'>${description}</div>`)
  }
  const endpoint = endpointLabel(element)
  if (endpoint) parts.push(endpoint)
  const operation = operationLabel(element)
  if (operation) parts.push(operation)
  return parts.join('')
}

function globalNodeLabel(element: Element, level: string): string {
  const width = isTopicElement(element) ? 230 : level === 'globalL3' ? 300 : level === 'globalL2' ? 290 : 310
  const description = element.description
    ? wrap(element.description, level === 'globalL3' ? 34 : 38).map(escapeLabel).join('<br />')
    : ''
  const parts = [
    `<div style='width:${width}px; overflow-wrap:anywhere; font-size:118%; line-height:1.25; font-weight:700'>${escapeLabel(element.name)}</div>`,
    `<div style='width:${width}px; overflow-wrap:anywhere; font-size:80%; line-height:1.4; margin-top:4px'>[${escapeLabel(elementTypeLabel(element))}]</div>`,
  ]
  if (description) parts.push(`<div style='width:${width}px; font-size:94%; line-height:1.5; margin-top:14px'>${description}</div>`)
  return parts.join('')
}

function shapeDelimiters(shape: string): [string, string] {
  switch (shape) {
    case 'Cylinder':
      return ['[("', '")]']
    case 'RoundedBox':
      return ['("', '")']
    case 'Hexagon':
      return ['{{"', '"}}']
    default:
      return ['["', '"]']
  }
}

function isDescendant(element: Element, ancestor: Element): boolean {
  let current = element.parent
  while (current) {
    if (current === ancestor) return true
    current = current.parent
  }
  return false
}

function buildNodeSet(workspace: Workspace, view: View): Set<Element> {
  const nodes = new Set<Element>()
  const scope = view.scope

  if (view.type === 'dynamic') {
    for (const step of view.steps) {
      nodes.add(step.source)
      nodes.add(step.destination)
    }
    return nodes
  }

  if (view.type === 'global') {
    for (const element of workspace.elements) {
      if (element.type === 'deploymentNode' || element.type === 'infrastructureNode') continue
      if (element.type === 'softwareSystemInstance' || element.type === 'containerInstance') continue
      if (element.type === 'group') continue
      nodes.add(element)
    }
    return nodes
  }

  if (view.type === 'systemLandscape') {
    for (const element of workspace.elements) {
      if (element.parent) continue
      if (element.type === 'person' || element.type === 'softwareSystem') nodes.add(element)
    }
    return nodes
  }

  if (!scope) return nodes

  if (view.type === 'systemContext') {
    nodes.add(scope)
    for (const rel of workspace.relationships) {
      if (rel.source === scope && (rel.destination.type === 'person' || rel.destination.type === 'softwareSystem')) nodes.add(rel.destination)
      else if (rel.destination === scope && (rel.source.type === 'person' || rel.source.type === 'softwareSystem')) nodes.add(rel.source)
    }
    return nodes
  }

  if (view.type === 'container') {
    const children = new Set(scope.children)
    for (const child of children) nodes.add(child)
    for (const rel of workspace.relationships) {
      if (children.has(rel.source) && !isDescendant(rel.destination, scope) && rel.destination !== scope) nodes.add(rel.destination)
      else if (children.has(rel.destination) && !isDescendant(rel.source, scope) && rel.source !== scope) nodes.add(rel.source)
    }
    // C4 L2 es una vista de contenedores: aunque el DSL incluya componentes
    // explícitos en el alcance, nunca deben dibujarse aquí. Conservamos su
    // contenedor padre para que sus relaciones se proyecten al nivel correcto.
    const components = [...nodes].filter((element) => element.type === 'component')
    for (const component of components) {
      let parent = component.parent
      while (parent && parent.type !== 'container') parent = parent.parent
      if (parent && isDescendant(parent, scope)) nodes.add(parent)
      nodes.delete(component)
    }
    return nodes
  }

  if (view.type === 'component') {
    const children = new Set(scope.children)
    for (const child of children) nodes.add(child)
    for (const rel of workspace.relationships) {
      if (children.has(rel.source) && !isDescendant(rel.destination, scope)) nodes.add(rel.destination)
      else if (children.has(rel.destination) && !isDescendant(rel.source, scope)) nodes.add(rel.source)
    }
    return nodes
  }

  return nodes
}

function excludedRelationship(relationship: Relationship, view: View): boolean {
  for (const rule of view.excludes) {
    const match = rule.match(/^relationship\.tag\s*==\s*(.+)$/)
    if (match && relationship.tags.includes(match[1].trim())) return true
  }
  return false
}

interface AggregatedRelationship {
  source: Element
  destination: Element
  labels: string[]
  bidirectional: boolean
  members: Relationship[]
}

function topAncestor(element: Element): Element {
  let current = element
  while (current.parent) current = current.parent
  return current
}

/**
 * Structurizr proyecta cada relación al ancestro visible más cercano: una relación
 * componente -> contenedor externo se dibuja como su contenedor -> ese contenedor.
 * Si ningún ancestro está en la vista, la relación no se muestra.
 */
function projectToView(element: Element, nodes: Set<Element>): Element | undefined {
  let current: Element | undefined = element
  while (current) {
    if (nodes.has(current)) return current
    current = current.parent
  }
  return undefined
}

/** Sube al ancestro más cercano del nivel pedido; si no hay, devuelve el propio elemento (externo). */
function projectToLevel(element: Element, levelTypes: Set<string>): Element {
  let current: Element | undefined = element
  while (current) {
    if (levelTypes.has(current.type)) return current
    current = current.parent
  }
  return element
}

function mergeRelationships(merged: Map<string, AggregatedRelationship>): AggregatedRelationship[] {
  const result: AggregatedRelationship[] = []
  const consumed = new Set<string>()
  for (const [key, entry] of merged) {
    if (consumed.has(key)) continue
    const reverseKey = `${entry.destination.id}->${entry.source.id}`
    const reverse = merged.get(reverseKey)
    // Cualquier par en sentidos opuestos se dibuja como UNA sola flecha: dos aristas
    // entre los mismos nodos van por el mismo recorrido y se pisarían.
    if (reverse && !consumed.has(reverseKey)) {
      consumed.add(reverseKey)
      const labels = [...entry.labels]
      for (const label of reverse.labels) if (!labels.includes(label)) labels.push(label)
      result.push({
        source: entry.source,
        destination: entry.destination,
        labels,
        bidirectional: true,
        members: [...entry.members, ...reverse.members],
      })
      continue
    }
    result.push({ ...entry, bidirectional: false })
  }
  return result.sort((left, right) => left.source.id - right.source.id || left.destination.id - right.destination.id)
}

/**
 * Grafo de una vista global de nivel: cada extremo se proyecta al elemento del
 * nivel más cercano (los externos se mantienen) y se conservan las relaciones que
 * tocan el nivel al menos por un extremo. Nodos y aristas salen del mismo cálculo,
 * así nunca queda un nodo sin conexión.
 */
function buildLevelGraph(
  workspace: Workspace,
  levelTypes: Set<string>,
  view: View,
): { nodes: Set<Element>; relationships: AggregatedRelationship[] } {
  const nodes = new Set<Element>()
  const merged = new Map<string, AggregatedRelationship>()

  for (const element of workspace.elements) {
    if (levelTypes.has(element.type)) nodes.add(element)
  }

  for (const relationship of workspace.relationships) {
    if (relationship.source === relationship.destination) continue
    if (excludedRelationship(relationship, view)) continue
    const source = projectToLevel(relationship.source, levelTypes)
    const destination = projectToLevel(relationship.destination, levelTypes)
    if (source === destination) continue
    if (!levelTypes.has(source.type) && !levelTypes.has(destination.type)) continue
    nodes.add(source)
    nodes.add(destination)
    const key = `${source.id}->${destination.id}`
    const entry = merged.get(key) ?? { source, destination, labels: [], bidirectional: false, members: [] }
    entry.members.push(relationship)
    const label = relationshipLabel(declaredRelationshipAction(relationship), '')
    if (label && !entry.labels.includes(label)) entry.labels.push(label)
    merged.set(key, entry)
  }

  // las cajas: los ancestros (sistema, contenedor) que agrupan a los elementos del nivel
  for (const element of [...nodes]) {
    let parent = element.parent
    while (parent) {
      nodes.add(parent)
      parent = parent.parent
    }
  }

  return { nodes, relationships: mergeRelationships(merged) }
}

function aggregateRelationships(
  workspace: Workspace,
  nodes: Set<Element>,
  collapse: boolean,
  view: View,
): AggregatedRelationship[] {
  const merged = new Map<string, AggregatedRelationship>()
  for (const relationship of workspace.relationships) {
    if (relationship.source === relationship.destination) continue
    if (excludedRelationship(relationship, view)) continue
    const source = collapse ? topAncestor(relationship.source) : projectToView(relationship.source, nodes)
    const destination = collapse ? topAncestor(relationship.destination) : projectToView(relationship.destination, nodes)
    if (!source || !destination || source === destination) continue
    if (!nodes.has(source) || !nodes.has(destination)) continue
    const key = `${source.id}->${destination.id}`
    const entry = merged.get(key) ?? { source, destination, labels: [], bidirectional: false, members: [] }
    entry.members.push(relationship)
    const label = relationshipLabel(declaredRelationshipAction(relationship), relationship.technology)
    if (label && !entry.labels.includes(label)) entry.labels.push(label)
    merged.set(key, entry)
  }

  // Structurizr dibuja una sola relación entre dos elementos cuando los dos sentidos
  // tienen las mismas descripciones: se une en una arista bidireccional.
  return mergeRelationships(merged)
}

function aggregatedLabel(entry: AggregatedRelationship): string {
  const shown = entry.labels.slice(0, 3)
  const hidden = entry.labels.length - shown.length
  const parts = shown.length ? shown : ['<div>relación</div>']
  if (hidden > 0) parts.push(`<div style='font-size: 70%'>+${hidden} ${hidden === 1 ? 'relación más' : 'relaciones más'}</div>`)
  return parts.join('')
}

function sortedBySet(nodes: Set<Element>): Element[] {
  return [...nodes].sort((a, b) => a.id - b.id)
}

function viewTitle(view: View): string {
  if (view.title) return view.title
  const scope = view.scope
  if (view.type === 'global') return 'Vista global · todo el modelo'
  if (view.type === 'globalL1') return 'Global L1 · sistemas y actores'
  if (view.type === 'globalL2') return 'Global L2 · contenedores'
  if (view.type === 'globalL3') return 'Global L3 · componentes'
  if (view.type === 'architectureLayers') return 'Arquitectura por capas'
  if (view.type === 'architectureBands') return 'Arquitectura por bandas'
  if (view.type === 'systemLandscape') return 'Panorama · sistemas y actores'
  if (!scope) return view.key
  switch (view.type) {
    case 'systemContext':
      return `System Context View: ${scope.name}`
    case 'container':
      return `Container View: ${scope.name}`
    case 'component': {
      const container = scope.parent ? `${scope.parent.name} - ` : ''
      return `Component View: ${container}${scope.name}`
    }
    default:
      return view.key
  }
}

function boundaryLine(indent: string, id: number | string, name: string, style: ResolvedStyle): string[] {
  return [
    `${indent}subgraph ${id} ["${escapeLabel(name)}"]`,
    `${indent}  style ${id} fill:${style.fill},stroke:${style.stroke},color:${style.color},stroke-width:1px`,
  ]
}

function groupLine(indent: string, id: string, name: string, palette: DiagramPalette = LIGHT_PALETTE): string[] {
  return [
    `${indent}subgraph ${id} ["${escapeLabel(name)}"]`,
    `${indent}  style ${id} fill:${palette.groupFill},stroke:${palette.groupStroke},color:${palette.groupColor},stroke-width:1px,stroke-dasharray:5`,
  ]
}

function terminalGroupName(group: string): string {
  return group.split('/').map((part) => part.trim()).filter(Boolean).at(-1) || group
}

function aggregatedIsAsync(entry: AggregatedRelationship): boolean {
  return entry.members.some((member) => member.tags.includes('Async')
    || /event|amqp|topic/i.test(`${member.technology} ${member.description}`))
}

function aggregatedEdge(entry: AggregatedRelationship): string {
  const label = aggregatedLabel(entry)
  if (aggregatedIsAsync(entry)) {
    return entry.bidirectional
      ? `${entry.source.id}<-. "${label}" .->${entry.destination.id}`
      : `${entry.source.id}-. "${label}" .->${entry.destination.id}`
  }
  return entry.bidirectional
    ? `${entry.source.id}<-->|"${label}"|${entry.destination.id}`
    : `${entry.source.id}-->|"${label}"|${entry.destination.id}`
}

function relationshipLabel(description: string, technology: string): string {
  const parts: string[] = []
  if (description) parts.push(`<div>${escapeLabel(description)}</div>`)
  if (technology) parts.push(`<div style='font-size: 70%'>[${escapeLabel(technology)}]</div>`)
  return parts.join('')
}

function declaredRelationshipAction(relationship: Relationship): string {
  return relationship.properties.action?.trim()
    || relationship.properties['relationship.action']?.trim()
    || relationship.description.trim()
    || ''
}

export type ArchitectureLayerId = 'channels' | 'contract' | 'domain' | 'integration' | 'core' | 'platform'

export interface ArchitectureLayer {
  id: ArchitectureLayerId
  order: number
  title: string
  subtitle: string
}

export const ARCHITECTURE_LAYERS: ArchitectureLayer[] = [
  { id: 'channels', order: 1, title: 'Canales y consumidores', subtitle: 'Actores y sistemas que inician el flujo' },
  { id: 'contract', order: 2, title: 'Contrato de negocio', subtitle: 'APIs públicas y contratos del Service Domain' },
  { id: 'domain', order: 3, title: 'Orquestación de dominio', subtitle: 'Servicios, eventos y estado del dominio' },
  { id: 'integration', order: 4, title: 'Integración de sistemas', subtitle: 'Adaptadores SYS y capacidades transversales' },
  { id: 'core', order: 5, title: 'Core y sistemas de registro', subtitle: 'Capacidades propietarias del core bancario' },
  { id: 'platform', order: 6, title: 'Plataforma y dependencias', subtitle: 'Servicios externos no clasificados' },
]

const LAYER_ALIASES: Record<string, ArchitectureLayerId> = {
  channel: 'channels', channels: 'channels', consumer: 'channels', consumers: 'channels', canales: 'channels',
  contract: 'contract', experience: 'contract', api: 'contract', contrato: 'contract',
  domain: 'domain', business: 'domain', orchestration: 'domain', dominio: 'domain',
  integration: 'integration', system: 'integration', sys: 'integration', integracion: 'integration',
  core: 'core', record: 'core', 'system-of-record': 'core',
  platform: 'platform', external: 'platform', plataforma: 'platform',
}

function explicitArchitectureLayer(element: Element): ArchitectureLayerId | undefined {
  const property = element.properties['architecture.layer'] ?? element.properties['architectureLayer']
  const tagged = element.tags.find((tag) => /^layer\s*:/i.test(tag))?.replace(/^layer\s*:/i, '')
  const value = (property ?? tagged ?? '').trim().toLowerCase().replace(/\s+/g, '-')
  return LAYER_ALIASES[value]
}

function rootSystem(element: Element): Element {
  let current = element
  while (current.parent) current = current.parent
  return current
}

export function architectureBandName(element: Element): string {
  const explicit = element.properties['architecture.band']?.trim()
  if (explicit) return explicit
  const group = element.group?.split('/').map((part) => part.trim()).filter(Boolean).at(-1)
  return group || rootSystem(element).name
}

export function architectureBandOrder(title: string, members: Element[]): number {
  const normalized = title.toLowerCase()
  if (/channel|canal|consumer/.test(normalized)) return 10
  if (/process|\bproc\b/.test(normalized)) return 20
  if (/business|\bsd\b/.test(normalized)) return 30
  if (/system|\bsys\b/.test(normalized)) return 40
  if (/transact|core/.test(normalized)) return 50
  const inferred = Math.min(...members.map((element) =>
    ARCHITECTURE_LAYERS.find((layer) => layer.id === architectureLayerFor(element))?.order ?? 99))
  return 60 + inferred
}

/** Clasificación predecible con override explícito mediante `architecture.layer`. */
export function architectureLayerFor(element: Element): ArchitectureLayerId {
  const explicit = explicitArchitectureLayer(element)
  if (explicit) return explicit

  const root = rootSystem(element)
  const rootTags = new Set(root.tags.map((tag) => tag.toLowerCase()))
  const tags = new Set(element.tags.map((tag) => tag.toLowerCase()))
  const group = (element.group ?? '').toLowerCase()
  const searchable = `${element.varName} ${element.name}`.toLowerCase()

  if ((element.type === 'person' || element.type === 'softwareSystem')
    && (rootTags.has('legacy') || rootTags.has('external') || /channel|canal|consumer/.test(searchable))) return 'channels'
  if (rootTags.has('core') || /transact|core banking/.test(`${root.varName} ${root.name}`.toLowerCase())) return 'core'
  if (/business \(sd\)|service domain/.test(group)) return tags.has('api') ? 'contract' : 'domain'
  if (/system \(sys\)/.test(group) || tags.has('custom banking')) return 'integration'
  if (tags.has('api') && !rootTags.has('external')) return 'contract'
  if (tags.has('core')) return 'core'
  if (tags.has('integration')) return 'integration'
  return 'platform'
}

function architectureNodeLabel(element: Element): string {
  const name = wrap(element.name, 30).map(escapeLabel).join('<br/>')
  const parts = [`<div style='font-weight: bold'>${name}</div>`]
  if (element.description) {
    const description = wrap(element.description, 36).map(escapeLabel).join('<br/>')
    parts.push(`<div style='font-size: 76%; margin-top: 8px'>${description}</div>`)
  }
  const endpoint = endpointLabel(element)
  if (endpoint) parts.push(endpoint)
  const operation = operationLabel(element)
  if (operation) parts.push(operation)
  return parts.join('')
}

function hasContainerChildren(element: Element): boolean {
  return element.children.some((child) => child.type === 'container')
}

type ArchitectureTone = 'sd' | 'sys' | 'transact' | 'neutral'

function architectureTone(element: Element): ArchitectureTone {
  const root = rootSystem(element)
  const searchable = `${element.group ?? ''} ${element.name} ${root.name}`.toLowerCase()
  if (/\(sd\)/.test(searchable)) return 'sd'
  if (/\(sys\)/.test(searchable)) return 'sys'
  if (/transact|temenos|core/.test(searchable)) return 'transact'
  if (/service\s*domain/.test(searchable)) return 'sd'
  return 'neutral'
}

function architectureVisualStyle(element: Element, palette: DiagramPalette, styleRules: StyleRule[]): ResolvedStyle {
  if (isTopicElement(element)) {
    const deadLetter = /dead[-. ]?letter|\bdlq\b/i.test(`${element.name} ${element.technology} ${element.description}`)
    const dark = palette.labelFill !== '#ffffff'
    return deadLetter
      ? dark
        ? { fill: '#5b2d2d', stroke: '#e58b8b', color: '#ffe3e3', shape: 'Cylinder' }
        : { fill: '#f8d4d4', stroke: '#c45b5b', color: '#6b2020', shape: 'Cylinder' }
      : dark
        ? { fill: '#59431d', stroke: '#e0ad52', color: '#fff0c7', shape: 'Cylinder' }
        : { fill: '#ffe4a8', stroke: '#c58a27', color: '#5f430b', shape: 'Cylinder' }
  }
  const tone = architectureTone(element)
  const isApi = element.tags.some((tag) => tag.toLowerCase() === 'api') || /^api[-.]/i.test(element.name)
  const isMicroservice = element.tags.some((tag) => tag.toLowerCase() === 'microservice') || /^mic[-.]/i.test(element.name)
  const dark = palette.labelFill !== '#ffffff'
  const colors: Record<ArchitectureTone, { api: string; microservice: string; other: string; stroke: string; text: string }> = dark
    ? {
        sd: { api: '#263f5d', microservice: '#304d70', other: '#20354d', stroke: '#79a4dc', text: '#e3efff' },
        sys: { api: '#254936', microservice: '#2f5c43', other: '#203d2e', stroke: '#79c497', text: '#e2f7e9' },
        transact: { api: '#5a421f', microservice: '#6d5126', other: '#4b371a', stroke: '#e0ad52', text: '#fff0c7' },
        neutral: { api: '#39424a', microservice: '#46525a', other: '#303a40', stroke: '#8d9ca5', text: '#edf1f2' },
      }
    : {
        sd: { api: '#a9c7ee', microservice: '#c5dcf5', other: '#e5effc', stroke: '#5689cf', text: '#193f6b' },
        sys: { api: '#acd9bc', microservice: '#c8e8d2', other: '#e5f5ea', stroke: '#55a572', text: '#1d5632' },
        transact: { api: '#f4c36e', microservice: '#ffdda0', other: '#fff0d0', stroke: '#c18420', text: '#654400' },
        neutral: { api: '#dce7e2', microservice: '#e6efeb', other: '#f0f5f2', stroke: '#9aa19e', text: '#24342e' },
      }
  const colorsForTone = colors[tone]
  if (tone === 'neutral') return resolveElementStyle(styleRules, element, palette)
  return {
    fill: isApi ? colorsForTone.api : isMicroservice ? colorsForTone.microservice : colorsForTone.other,
    stroke: colorsForTone.stroke,
    color: colorsForTone.text,
    shape: 'Box',
  }
}

function semanticTokens(...values: string[]): Set<string> {
  const ignored = new Set(['para', 'desde', 'hacia', 'mediante', 'the', 'with', 'from', 'into', 'api', 'mic', 'sys', 'int', 'core'])
  return new Set(values.join(' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 3 && !ignored.has(token)))
}

function contractValues(properties: Record<string, string>): string[] {
  return ['endpoint', 'endpoints', 'operation', 'operations']
    .flatMap((key) => (properties[key] ?? '').split('|'))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
}

function expandedApiMatch(container: Element, counterpart: Element, relationship: Relationship): Element | undefined {
  const candidates = container.children.filter((child) => child.type === 'component')
  const relationshipContracts = contractValues(relationship.properties)
  const context = semanticTokens(
    counterpart.varName, counterpart.name, counterpart.description,
    ...Object.values(counterpart.properties), ...relationshipContracts,
  )
  const scored = candidates.map((candidate) => {
    const candidateContracts = contractValues(candidate.properties)
    const contractMatch = relationshipContracts.some((left) => candidateContracts.some((right) =>
      left === right || left.includes(right) || right.includes(left)))
    const candidateTokens = semanticTokens(
      candidate.varName, candidate.name, candidate.description,
      ...Object.values(candidate.properties),
    )
    const shared = [...candidateTokens].filter((token) => context.has(token)).length
    return { candidate, score: (contractMatch ? 1000 : 0) + shared }
  }).sort((left, right) => right.score - left.score || left.candidate.id - right.candidate.id)
  const [best, second] = scored
  if (!best || best.score < 2 || best.score === second?.score) return undefined
  return best.candidate
}

function hasDetailedReplacement(workspace: Workspace, container: Element, counterpart: Element, sourceSide: boolean): boolean {
  return workspace.relationships.some((relationship) => sourceSide
    ? relationship.source.parent === container && relationship.destination === counterpart
    : relationship.destination.parent === container && relationship.source === counterpart)
}

function layeredGraph(workspace: Workspace, view: View) {
  // Arquitectura por capas representa el nivel L2: conserva los contenedores
  // API y MIC como nodos propios. Expandir una API a sus componentes aquí
  // convertía el diagrama en un L3 parcial y hacía parecer que el MIC saltaba
  // directamente al core.
  const expanded = new Set<Element>()
  const nodes = new Set<Element>()
  const isOpaqueExternal = (element: Element) => {
    const root = rootSystem(element)
    const tags = new Set(root.tags.map((tag) => tag.toLowerCase()))
    return root.type === 'softwareSystem' && (tags.has('external') || tags.has('core'))
  }
  const layeredElement = (element: Element): Element | undefined => {
    if (isOpaqueExternal(element)) return rootSystem(element)
    return projectToView(element, nodes)
  }
  for (const element of workspace.elements) {
    if (element.type === 'container' && !expanded.has(element) && !isOpaqueExternal(element)) nodes.add(element)
    // L2 no expone componentes. Solo se admiten topics modelados explícitamente
    // como componentes, porque representan un canal de mensajería visible.
    if (element.type === 'component' && isTopicElement(element)) nodes.add(element)
  }
  // Los canales/consumidores suelen modelarse como sistemas externos sin
  // contenedores. Deben conservarse cuando llaman a un elemento visible; si no
  // se agregan antes de proyectar relaciones, el flujo pierde su origen real.
  const isTopLevelActor = (element: Element) => !element.parent
    && (element.type === 'person' || element.type === 'softwareSystem')
    && !hasContainerChildren(element)
  for (const relationship of workspace.relationships) {
    if (excludedRelationship(relationship, view)) continue
    if (isTopLevelActor(relationship.source) && projectToView(relationship.destination, nodes)) nodes.add(relationship.source)
    if (isTopLevelActor(relationship.destination) && projectToView(relationship.source, nodes)) nodes.add(relationship.destination)
  }
  const merged = new Map<string, AggregatedRelationship>()
  for (const relationship of workspace.relationships) {
    if (relationship.source === relationship.destination || excludedRelationship(relationship, view)) continue
    if (expanded.has(relationship.source)
      && hasDetailedReplacement(workspace, relationship.source, relationship.destination, true)) continue
    if (expanded.has(relationship.destination)
      && hasDetailedReplacement(workspace, relationship.destination, relationship.source, false)) continue

    const resolve = (element: Element, counterpart: Element) => {
      if (!expanded.has(element)) return layeredElement(element)
      const matched = expandedApiMatch(element, counterpart, relationship)
      if (matched) return matched
      nodes.add(element)
      return element
    }
    const source = resolve(relationship.source, relationship.destination)
    const destination = resolve(relationship.destination, relationship.source)
    if (!source || !destination || source === destination) continue
    const key = `${source.id}->${destination.id}`
    const entry = merged.get(key) ?? { source, destination, labels: [], bidirectional: false, members: [] }
    entry.members.push(relationship)
    const label = relationshipLabel(declaredRelationshipAction(relationship), relationship.technology)
    if (label && !entry.labels.includes(label)) entry.labels.push(label)
    merged.set(key, entry)
  }
  const relationships = mergeRelationships(merged).filter((entry) =>
    !(entry.source.type === 'softwareSystem' && hasContainerChildren(entry.source))
    && !(entry.destination.type === 'softwareSystem' && hasContainerChildren(entry.destination)),
  )
  for (const relationship of relationships) {
    nodes.add(relationship.source)
    nodes.add(relationship.destination)
  }
  return { nodes, relationships }
}

function toLayeredMermaid(workspace: Workspace, view: View, palette: DiagramPalette): string {
  const { nodes, relationships } = layeredGraph(workspace, view)
  const styleRules = workspace.styles
  const dark = palette.labelFill !== '#ffffff'
  const layerFill = dark ? '#1c2427' : '#f2f6f4'
  const layerStroke = dark ? '#405159' : '#c8d7d0'
  const layerColor = dark ? '#d6e1dd' : '#29443a'
  const lines = [
    'flowchart LR',
    `  linkStyle default fill:none,stroke:#75837e,color:${palette.labelColor}`,
    '',
    `  subgraph diagram ["${escapeLabel(viewTitle(view))}"]`,
    '    direction LR',
    `    style diagram fill:${palette.sheet},stroke:${palette.sheetStroke}`,
    '',
  ]

  const grouped = new Map<string, Element[]>()
  for (const element of sortedBySet(nodes)) {
    const name = architectureBandName(element)
    const members = grouped.get(name) ?? []
    members.push(element)
    grouped.set(name, members)
  }
  const orderedGroups = [...grouped].sort(([, left], [, right]) => {
    const leftOrder = architectureBandOrder(architectureBandName(left[0]), left)
    const rightOrder = architectureBandOrder(architectureBandName(right[0]), right)
    return leftOrder - rightOrder || left[0].id - right[0].id
  })

  orderedGroups.forEach(([title, members], groupIndex) => {
    const layerId = `architecture-group-${groupIndex}`
    lines.push(`    subgraph ${layerId} ["${escapeLabel(title)}"]`)
    lines.push('      direction TB')
    for (const element of members) {
      const style = architectureVisualStyle(element, palette, styleRules)
      const [open, close] = shapeDelimiters(style.shape)
      lines.push(`      ${element.id}${open}${architectureNodeLabel(element)}${close}`)
      lines.push(`      style ${element.id} fill:${style.fill},stroke:${style.stroke},color:${style.color}`)
    }
    lines.push('    end')
    lines.push(`    style ${layerId} fill:${layerFill},stroke:${layerStroke},color:${layerColor},stroke-width:1px`)
    lines.push('')
  })

  for (const entry of relationships) {
    const async = entry.members.some((member) => member.tags.includes('Async')
      || /event|amqp|topic/i.test(`${member.technology} ${member.description}`))
    const labels = unique(entry.members.map(declaredRelationshipAction).filter(Boolean))
    const label = labels.length
      ? labels.map((action) => `<div>${escapeLabel(action)}</div>`).join('')
      : entry.members.length ? aggregatedLabel(entry) : ''
    if (!label) {
      lines.push(`    ${entry.source.id}-->${entry.destination.id}`)
    } else if (async) {
      const arrow = entry.bidirectional ? `<-. "${label}" .->` : `-. "${label}" .->`
      lines.push(`    ${entry.source.id}${arrow}${entry.destination.id}`)
    } else {
      const arrow = entry.bidirectional ? `<-->|"${label}"|` : `-->|"${label}"|`
      lines.push(`    ${entry.source.id}${arrow}${entry.destination.id}`)
    }
  }

  lines.push('  end', '')
  return lines.join('\n')
}

export function toMermaid(workspace: Workspace, view: View, palette: DiagramPalette = LIGHT_PALETTE): string {
  if (view.type === 'architectureLayers' || view.type === 'architectureBands') return toLayeredMermaid(workspace, view, palette)
  const levelTypes = LEVEL_TYPES[view.type]
  const levelGraph = levelTypes ? buildLevelGraph(workspace, levelTypes, view) : null
  const nodes = levelGraph ? levelGraph.nodes : buildNodeSet(workspace, view)
  const styleRules = workspace.styles
  const lines: string[] = []

  const direction = 'LR'
  const lineColor = palette.labelFill === '#ffffff' ? '#5f746d' : '#9aaba5'
  lines.push(`graph ${direction}`)
  // fill:none es obligatorio: mermaid aplica este fill al PATH de la arista, y
  // cualquier color rellenaría el área encerrada por cada curva.
  lines.push(`  linkStyle default fill:none,stroke:${lineColor},stroke-width:1.5px,color:${palette.labelColor}`)
  lines.push('')
  lines.push(`  subgraph diagram ["${escapeLabel(viewTitle(view))}"]`)
  lines.push(`    style diagram fill:${palette.sheet},stroke:${palette.sheetStroke}`)
  lines.push('')

  const emitted = new Set<number>()
  const isGlobalLevel = LEVEL_ORDER.includes(view.type)
  const globalInnerDirection = view.type === 'globalL1' ? 'TB' : 'LR'

  const emitNode = (element: Element, indent: string) => {
    if (emitted.has(element.id)) return
    emitted.add(element.id)
    const style = resolveElementStyle(styleRules, element, palette)
    const [open, close] = shapeDelimiters(style.shape)
    const label = isGlobalLevel ? globalNodeLabel(element, view.type) : nodeLabel(element)
    lines.push(`${indent}${element.id}${open}${label}${close}`)
    lines.push(`${indent}style ${element.id} fill:${style.fill},stroke:${style.stroke},color:${style.color},stroke-width:1px`)
  }

  const scope = view.scope
  const isLandscape = !scope || view.type === 'systemContext'
  const useSystemBoundary = !!scope && (view.type === 'container' || (view.type === 'dynamic' && !!scope))
  const useContainerBoundary = view.type === 'component'

  if (view.type === 'dynamic') {
    // Los límites anidados fuerzan columnas verticales en Mermaid incluso con
    // graph LR. Los flujos muestran participantes y pasos, no contención C4.
    for (const element of sortedBySet(nodes)) emitNode(element, '    ')
  } else if (view.type === 'global' || LEVEL_ORDER.includes(view.type)) {
    const emitSubtree = (element: Element, indent: string) => {
      if (emitted.has(element.id)) return
      const children = sortedBySet(nodes).filter((child) => child.parent === element)
      if (!children.length) {
        emitNode(element, indent)
        return
      }
      emitted.add(element.id)
      lines.push(...boundaryLine(indent, element.id, element.name, resolveBoundaryStyle(styleRules, element, palette)))
      lines.push(`${indent}  direction ${globalInnerDirection}`)
      const grouped = new Map<string, Element[]>()
      const plain: Element[] = []
      for (const child of children) {
        if (child.group) {
          const list = grouped.get(child.group) ?? []
          list.push(child)
          grouped.set(child.group, list)
        } else {
          plain.push(child)
        }
      }
      let groupIndex = 1
      for (const [name, list] of grouped) {
        lines.push(...groupLine(`${indent}  `, `g${element.id}-${groupIndex++}`, terminalGroupName(name), palette))
        lines.push(`${indent}    direction ${globalInnerDirection}`)
        for (const child of list) emitSubtree(child, `${indent}    `)
        lines.push(`${indent}  end`)
        lines.push('')
      }
      for (const child of plain) emitSubtree(child, `${indent}  `)
      lines.push(`${indent}end`)
      lines.push('')
    }

    const roots = sortedBySet(nodes).filter((element) => !element.parent || !nodes.has(element.parent))
    const groupedRoots = new Map<string, Element[]>()
    const plainRoots: Element[] = []
    for (const root of roots) {
      if (root.group) {
        const list = groupedRoots.get(root.group) ?? []
        list.push(root)
        groupedRoots.set(root.group, list)
      } else {
        plainRoots.push(root)
      }
    }
    let rootGroupIndex = 1
    for (const [name, list] of groupedRoots) {
      lines.push(...groupLine('    ', `rg${rootGroupIndex++}`, terminalGroupName(name), palette))
      lines.push(`      direction ${globalInnerDirection}`)
      for (const root of list) emitSubtree(root, '      ')
      lines.push('    end')
      lines.push('')
    }
    for (const root of plainRoots) emitSubtree(root, '    ')
  } else if (isLandscape) {
    const grouped = new Map<string, Element[]>()
    const ungrouped: Element[] = []
    for (const element of sortedBySet(nodes)) {
      if (element.group && !element.parent) {
        const list = grouped.get(element.group) ?? []
        list.push(element)
        grouped.set(element.group, list)
      } else {
        ungrouped.push(element)
      }
    }
    let groupIndex = 1
    for (const [name, list] of grouped) {
      const id = `group${groupIndex++}`
      lines.push(...groupLine('    ', id, name, palette))
      for (const element of list) emitNode(element, '      ')
      lines.push('    end')
      lines.push('')
    }
    for (const element of ungrouped) emitNode(element, '    ')
  } else if (useSystemBoundary && scope) {
    const children = sortedBySet(nodes).filter((element) => element.parent === scope)
    const externals = sortedBySet(nodes).filter((element) => element.parent !== scope)

    for (const element of externals) emitNode(element, '    ')
    lines.push('')

    const systemStyle = resolveBoundaryStyle(styleRules, scope, palette)
    lines.push(...boundaryLine('    ', scope.id, scope.name, systemStyle))
    lines.push('')

    const grouped = new Map<string, Element[]>()
    const ungroupedChildren: Element[] = []
    for (const child of children) {
      if (child.group) {
        const list = grouped.get(child.group) ?? []
        list.push(child)
        grouped.set(child.group, list)
      } else {
        ungroupedChildren.push(child)
      }
    }

    let groupIndex = 1
    for (const [name, list] of grouped) {
      lines.push(...groupLine('      ', `group${groupIndex++}`, name, palette))
      for (const element of list) emitNode(element, '        ')
      lines.push('      end')
      lines.push('')
    }
    for (const element of ungroupedChildren) emitNode(element, '      ')
    lines.push('    end')
    lines.push('')
  } else if (useContainerBoundary && scope) {
    const system = scope.parent
    const externals = sortedBySet(nodes).filter((element) => element.parent !== scope && element.parent !== system)
    for (const element of externals) emitNode(element, '    ')
    lines.push('')
    if (system) {
      const systemStyle = resolveBoundaryStyle(styleRules, system, palette)
      lines.push(...boundaryLine('    ', system.id, system.name, systemStyle))
      lines.push('')
    }
    const containerStyle = resolveBoundaryStyle(styleRules, scope, palette)
    lines.push(...boundaryLine('      ', scope.id, scope.name, containerStyle))
    lines.push('')

    const children = sortedBySet(nodes).filter((element) => element.parent === scope)
    const grouped = new Map<string, Element[]>()
    const ungroupedChildren: Element[] = []
    for (const child of children) {
      if (child.group) {
        const list = grouped.get(child.group) ?? []
        list.push(child)
        grouped.set(child.group, list)
      } else {
        ungroupedChildren.push(child)
      }
    }
    let groupIndex = 1
    for (const [name, list] of grouped) {
      lines.push(...groupLine('        ', `group${groupIndex++}`, name, palette))
      for (const element of list) emitNode(element, '          ')
      lines.push('        end')
      lines.push('')
    }
    for (const element of ungroupedChildren) emitNode(element, '        ')
    lines.push('      end')
    lines.push('')

    const siblings = sortedBySet(nodes).filter((element) => element.parent === system)
    for (const element of siblings) emitNode(element, '      ')

    lines.push('    end')
    lines.push('')
  }

  lines.push('')

  if (view.type === 'dynamic') {
    for (const interaction of dynamicInteractions(workspace, view)) {
      const arrow = interaction.bidirectional ? '<-.' : '-.'
      lines.push(`    ${interaction.source.id}${arrow} "${interaction.label}" .->${interaction.destination.id}`)
    }
  } else if (levelGraph) {
    for (const entry of levelGraph.relationships) {
      lines.push(`    ${aggregatedEdge(entry)}`)
    }
  } else if (view.type === 'global' || view.type === 'systemLandscape') {
    const aggregated = aggregateRelationships(workspace, nodes, view.type === 'systemLandscape', view)
    for (const entry of aggregated) {
      lines.push(`    ${aggregatedEdge(entry)}`)
    }
  } else {
    for (const entry of aggregateRelationships(workspace, nodes, false, view)) {
      lines.push(`    ${aggregatedEdge(entry)}`)
    }
  }

  lines.push('')
  lines.push('  end')
  lines.push('')
  return lines.join('\n')
}

interface DynamicInteraction {
  source: Element
  destination: Element
  label: string
  descriptions: string[]
  bidirectional: boolean
}

/**
 * Secuencia de un flujo dinámico. Si un paso y el siguiente son el mismo par en
 * sentido contrario (petición/respuesta) se dibujan como una sola flecha con las
 * dos etiquetas: evita dos etiquetas superpuestas y se lee como una interacción.
 */
function dynamicInteractions(workspace: Workspace, view: View): DynamicInteraction[] {
  const technologyFor = (source: Element, destination: Element) =>
    workspace.relationships.find((relationship) => relationship.source === source && relationship.destination === destination)?.technology ?? ''

  // Todos los pasos del mismo par se dibujan como UNA sola flecha: si el flujo
  // vuelve varias veces entre los mismos elementos, dos aristas se pisarían.
  const groups = new Map<string, { source: Element; destination: Element; steps: View['steps'] }>()
  for (const step of view.steps) {
    const key = step.source.id <= step.destination.id
      ? `${step.source.id}->${step.destination.id}`
      : `${step.destination.id}->${step.source.id}`
    const group = groups.get(key) ?? { source: step.source, destination: step.destination, steps: [] }
    group.steps.push(step)
    groups.set(key, group)
  }

  return [...groups.values()]
    .sort((left, right) => Math.min(...left.steps.map((step) => step.n)) - Math.min(...right.steps.map((step) => step.n)))
    .map((group) => {
      const ordered = [...group.steps].sort((left, right) => left.n - right.n)
      const technology = technologyFor(ordered[0].source, ordered[0].destination)
        || technologyFor(ordered[0].destination, ordered[0].source)
      const descriptions = ordered.map((step) => `${step.n}. ${step.description}`)
      const shown = descriptions.slice(0, 3)
      const hidden = descriptions.length - shown.length
      const lines = shown.map((text) => `<div>${escapeLabel(text)}</div>`)
      if (hidden > 0) lines.push(`<div style='font-size: 70%'>+${hidden} ${hidden === 1 ? 'paso más' : 'pasos más'}</div>`)
      if (technology) lines.push(`<div style='font-size: 70%'>[${escapeLabel(technology)}]</div>`)
      const forward = group.steps.some((step) => step.source === group.source)
      const backward = group.steps.some((step) => step.source === group.destination)
      return {
        source: group.source,
        destination: group.destination,
        label: lines.join(''),
        descriptions,
        bidirectional: forward && backward,
      }
    })
}

export interface DiagramRelationship {
  source: Element
  destination: Element
  descriptions: string[]
  technologies: string[]
  endpoints: string[]
  properties: { name: string; values: string[] }[]
  bidirectional: boolean
  count: number
}

export interface ViewDiagram {
  nodes: Element[]
  relationships: DiagramRelationship[]
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function toDiagramRelationship(entry: AggregatedRelationship): DiagramRelationship {
  const properties = new Map<string, string[]>()
  for (const member of entry.members) {
    for (const [name, value] of Object.entries(member.properties)) {
      const values = properties.get(name) ?? []
      for (const part of value.split('|').map((piece) => piece.trim()).filter(Boolean)) {
        if (!values.includes(part)) values.push(part)
      }
      properties.set(name, values)
    }
  }
  return {
    source: entry.source,
    destination: entry.destination,
    descriptions: unique(entry.members.map((member) => member.description)),
    technologies: unique(entry.members.map((member) => member.technology)),
    endpoints: properties.get('endpoints') ?? [],
    properties: [...properties].map(([name, values]) => ({ name, values })),
    bidirectional: entry.bidirectional,
    count: entry.members.length,
  }
}

/**
 * Relaciones tal como se dibujan en la vista (con la proyección de Structurizr)
 * y sus properties del modelo, para poder mostrarlas en el panel de detalles.
 */
export function viewDiagram(workspace: Workspace, view: View): ViewDiagram {
  if (view.type === 'architectureLayers' || view.type === 'architectureBands') {
    const graph = layeredGraph(workspace, view)
    return { nodes: sortedBySet(graph.nodes), relationships: graph.relationships.map(toDiagramRelationship) }
  }
  const levelTypes = LEVEL_TYPES[view.type]
  const levelGraph = levelTypes ? buildLevelGraph(workspace, levelTypes, view) : null
  const nodes = levelGraph ? levelGraph.nodes : buildNodeSet(workspace, view)

  if (view.type === 'dynamic') {
    const relationships: DiagramRelationship[] = dynamicInteractions(workspace, view).map((interaction) => {
      const model = workspace.relationships.find(
        (relationship) => relationship.source === interaction.source && relationship.destination === interaction.destination,
      )
      const diagram = toDiagramRelationship({
        source: interaction.source,
        destination: interaction.destination,
        labels: [],
        bidirectional: interaction.bidirectional,
        members: model ? [model] : [],
      })
      diagram.descriptions = interaction.descriptions
      return diagram
    })
    return { nodes: sortedBySet(nodes), relationships }
  }

  const aggregated = levelGraph
    ? levelGraph.relationships
    : aggregateRelationships(workspace, nodes, view.type === 'systemLandscape', view)
  return { nodes: sortedBySet(nodes), relationships: aggregated.map(toDiagramRelationship) }
}
